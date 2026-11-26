import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ADAPTER_CAPS,
  BUS_CMD,
  CLIENT_VERSION,
  type DaemonClient,
  Hello,
  HelloRefused,
  systemTool,
} from "@oa/bus-ipc";
import { procStartOf } from "./session.ts";
import { callTool, TOOLS, type ToolResult } from "./tools.ts";

/** The wire's agent_ref rule. */
const AgentRefSchema = Hello.shape.agent_ref;

/**
 * Antigravity (agy, agy S2). agy runs nothing before a session's first
 * message: then its SessionStart hook (our plugin's) runs `oa-bus agy-hello`,
 * which joins the conversation to the bus for the agy process above it, and
 * agy starts its MCP servers, ours among them. One MCP server serves every
 * conversation of its agy process and gets no conversation env, so it speaks
 * for the conversation the hook last reported for that process.
 */

/** A process's parent and executable name; null when it cannot be read. */
export type Proc = (pid: number) => { ppid: number; name: string } | null;

/** agy is one native binary named `agy` (`~/.local/bin/agy`). */
export const isAgy = (name: string): boolean => basename(name) === "agy";

/** `/proc` on Linux; `ps -o ppid=,comm=` elsewhere. */
export const readProc: Proc = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).split(/\s+/)[2]);
    const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return { ppid, name };
  } catch {}
  try {
    const out = execFileSync(
      systemTool("ps"),
      ["-o", "ppid=,comm=", "-p", String(pid)],
      {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const m = /^(\d+)\s+(.+)$/.exec(out);
    return m ? { ppid: Number(m[1]), name: m[2] as string } : null;
  } catch {
    return null;
  }
};

/**
 * The agy process above `from` (itself included): the nearest whose binary is
 * agy, walking parent links only. Callers pass their own parent, never their
 * own pid, so a hello names the agy that started them (Axe W's requirement).
 */
export function findAgy(from: number, proc: Proc): number | undefined {
  let pid = from;
  for (let i = 0; i < 12 && pid > 1; i += 1) {
    const p = proc(pid);
    if (!p) return undefined;
    if (isAgy(p.name)) return pid;
    if (!p.ppid || p.ppid === pid) return undefined;
    pid = p.ppid;
  }
  return undefined;
}

/** What the SessionStart hook reads from agy's payload on stdin. */
export type SessionStart = {
  conversationId: string;
  cwd: string;
  workspacePaths: string[];
};

/**
 * agy's SessionStart payload: `conversationId`, `cwd` (the agent's working
 * folder) and `workspacePaths`. The cwd falls back to the first workspace.
 * Undefined when the payload is not one.
 */
export function parseSessionStart(text: string): SessionStart | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const d = doc as Record<string, unknown>;
  const ref = AgentRefSchema.safeParse(d.conversationId);
  if (!ref.success) return undefined;
  const workspacePaths = Array.isArray(d.workspacePaths)
    ? d.workspacePaths.filter(
        (p): p is string => typeof p === "string" && isAbsolute(p),
      )
    : [];
  const cwd =
    typeof d.cwd === "string" && isAbsolute(d.cwd) ? d.cwd : workspacePaths[0];
  if (cwd === undefined) return undefined;
  return { conversationId: ref.data, cwd, workspacePaths };
}

/** The conversation an agy process showed last, as its hook reported it. */
export type AgyConversation = {
  pid: number;
  procStart: string;
  conversationId: string;
  cwd: string;
  name?: string;
};

/** `<bus home>/antigravity/<agy pid>.json`: written by the hook, read by the MCP server. */
export const agyStateDir = (busHome: string) => join(busHome, "antigravity");

/** Whether a process exists: EPERM means it does. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Records the conversation an agy process shows now (0600, atomic), and drops
 * the records of agy processes that are gone.
 */
export function writeAgyConversation(
  busHome: string,
  c: AgyConversation,
  alive: (pid: number) => boolean = pidAlive,
): void {
  const dir = agyStateDir(busHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${c.pid}.json`);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  for (const name of readdirSync(dir)) {
    // agy S3: the watcher's files of a gone agy process go with its record.
    const m = /^(\d+)(?:\.watch|\.sent)?\.json$/.exec(name);
    if (m && Number(m[1]) !== c.pid && !alive(Number(m[1])))
      rmSync(join(dir, name), { force: true });
  }
}

/**
 * The conversation recorded for `pid`, if its file is a regular file of ours
 * (never through a symlink) and well formed. The caller checks its start time.
 */
export function readAgyConversation(
  busHome: string,
  pid: number,
): AgyConversation | undefined {
  let fd: number;
  try {
    fd = openSync(
      join(agyStateDir(busHome), `${pid}.json`),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return undefined;
    if (st.size > 16_384) return undefined;
    const doc = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
    const ref = AgentRefSchema.safeParse(doc.conversationId);
    if (
      doc.pid !== pid ||
      typeof doc.procStart !== "string" ||
      !ref.success ||
      typeof doc.cwd !== "string" ||
      !isAbsolute(doc.cwd)
    )
      return undefined;
    return {
      pid,
      procStart: doc.procStart,
      conversationId: ref.data,
      cwd: doc.cwd,
      ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * agy S3: `<bus home>/antigravity/<agy pid>.watch.json`, the watcher running
 * for that agy process: its own pid and start time, and the agy process's.
 * The hook reads it to tell whether the session still has to start one.
 */
export type AgyWatch = { pid: number; procStart: string; agyStart: string };

const watchFile = (busHome: string, agyPid: number) =>
  join(agyStateDir(busHome), `${agyPid}.watch.json`);

/** A small JSON file of ours: regular, our uid, never through a symlink. */
function readOwnJson(file: string, max = 65_536): unknown {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return undefined;
    if (st.size > max) return undefined;
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Atomic and 0600, in the bus home's antigravity folder. */
function writeOwnJson(busHome: string, file: string, doc: unknown): void {
  mkdirSync(agyStateDir(busHome), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readAgyWatch(
  busHome: string,
  agyPid: number,
): AgyWatch | undefined {
  const doc = readOwnJson(watchFile(busHome, agyPid)) as
    | Record<string, unknown>
    | undefined;
  if (
    !doc ||
    typeof doc.pid !== "number" ||
    !Number.isInteger(doc.pid) ||
    doc.pid <= 0 ||
    typeof doc.procStart !== "string" ||
    typeof doc.agyStart !== "string"
  )
    return undefined;
  return { pid: doc.pid, procStart: doc.procStart, agyStart: doc.agyStart };
}

export function writeAgyWatch(
  busHome: string,
  agyPid: number,
  w: AgyWatch,
): void {
  writeOwnJson(busHome, watchFile(busHome, agyPid), w);
}

/** Removes the watch file, only when it still names `self`. */
export function clearAgyWatch(
  busHome: string,
  agyPid: number,
  self: number,
): void {
  if (readAgyWatch(busHome, agyPid)?.pid === self)
    rmSync(watchFile(busHome, agyPid), { force: true });
}

/**
 * Whether a watcher runs for this agy process now: the file names a process
 * that runs, started when the file says, for an agy started at `agyStart`.
 */
export function agyWatchLive(
  busHome: string,
  agyPid: number,
  agyStart: string,
  procStart: (pid: number) => string | null = procStartOf,
): boolean {
  const w = readAgyWatch(busHome, agyPid);
  if (!w || w.agyStart !== agyStart) return false;
  return procStart(w.pid) === w.procStart;
}

/** A begun hand-off: when, and the `agy agentapi` process it started. */
type AgyTry = { at: number; child?: { pid: number; start: string } };

/** The most msg ids a watcher remembers handing to agy. */
export const AGY_SENT_MAX = 1000;

/**
 * agy S3: `<bus home>/antigravity/<agy pid>.sent.json`, what a watcher knows
 * of each msg id it handed to agy for that agy process. `ids`: agy's agentapi
 * said it took them (written after agy said so). `trying`: a hand-off began
 * then (written before the call), and agy's answer was never recorded; only
 * agy's mailbox can say whether it got one of those, and only once the
 * `agy agentapi` process that call started (its pid and start time, written
 * right after it starts) is gone. A watcher started again
 * for the same agy process reads the file; a file for an earlier agy process
 * with that pid counts for nothing.
 */
export class AgySentIds {
  readonly #file: string;
  #ids: string[];
  #trying: Record<string, AgyTry>;
  constructor(
    private readonly busHome: string,
    agyPid: number,
    private readonly agyStart: string,
  ) {
    this.#file = join(agyStateDir(busHome), `${agyPid}.sent.json`);
    const doc = readOwnJson(this.#file, 1_048_576) as
      | { agyStart?: unknown; ids?: unknown; trying?: unknown }
      | undefined;
    const ours = doc?.agyStart === agyStart;
    this.#ids =
      ours && Array.isArray(doc.ids)
        ? doc.ids.filter((x): x is string => typeof x === "string")
        : [];
    this.#trying = {};
    if (ours && doc.trying && typeof doc.trying === "object")
      for (const [k, v] of Object.entries(doc.trying)) {
        const t = (v ?? {}) as { at?: unknown; child?: unknown };
        if (typeof t.at !== "number" || !Number.isFinite(t.at)) continue;
        const c = (t.child ?? {}) as { pid?: unknown; start?: unknown };
        this.#trying[k] =
          Number.isInteger(c.pid) && typeof c.start === "string"
            ? { at: t.at, child: { pid: c.pid as number, start: c.start } }
            : { at: t.at };
      }
  }
  /** agy said it took this id. */
  has(id: string): boolean {
    return this.#ids.includes(id);
  }
  /** When a hand-off of this id began whose answer was never recorded. */
  tryingSince(id: string): number | undefined {
    return this.#trying[id]?.at;
  }
  /** The `agy agentapi` process that hand-off started, if it got that far. */
  tryingChild(id: string): { pid: number; start: string } | undefined {
    return this.#trying[id]?.child;
  }
  /** The hand-off's `agy agentapi` process started: written at once ("" when its start time could not be read). */
  child(id: string, pid: number, start: string): void {
    const t = this.#trying[id];
    if (!t) return;
    t.child = { pid, start };
    this.#save();
  }
  /** A hand-off begins: written before agy is called. */
  begin(id: string, at: number): void {
    delete this.#trying[id];
    this.#trying[id] = { at };
    const keys = Object.keys(this.#trying);
    for (const k of keys.slice(0, Math.max(0, keys.length - AGY_SENT_MAX)))
      delete this.#trying[k];
    this.#save();
  }
  /** agy took it: written only after agy said so. */
  add(id: string): void {
    const was = id in this.#trying;
    delete this.#trying[id];
    if (this.has(id)) {
      if (was) this.#save();
      return;
    }
    this.#ids.push(id);
    if (this.#ids.length > AGY_SENT_MAX)
      this.#ids = this.#ids.slice(-AGY_SENT_MAX);
    this.#save();
  }
  /** agy refused it: nothing of it reached the session. */
  delete(id: string): void {
    const n = this.#ids.length;
    const was = id in this.#trying;
    delete this.#trying[id];
    this.#ids = this.#ids.filter((x) => x !== id);
    if (this.#ids.length !== n || was) this.#save();
  }
  #save(): void {
    writeOwnJson(this.busHome, this.#file, {
      agyStart: this.agyStart,
      ids: this.#ids,
      trying: this.#trying,
    });
  }
}

/** What agy's mailbox says of one message. */
export type AgyMailboxState = "present" | "absent" | "unreadable";

/**
 * agy's own data folder, as agy tells the commands it runs
 * (`ANTIGRAVITY_APP_DATA_DIR`; `agy --app_data_dir` moves it), else the
 * CLI's default.
 */
export function agyAppDataDir(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): string {
  const d = env.ANTIGRAVITY_APP_DATA_DIR;
  return d && isAbsolute(d) ? d : join(home, ".gemini", "antigravity-cli");
}

/** A message file is at most this big; ours are far smaller. */
const AGY_MAILBOX_FILE_MAX = 1_048_576;
/** The most files read from one mailbox. */
const AGY_MAILBOX_MAX = 20_000;

/**
 * Whether agy holds the bus message `msgId` for `conversationId`, read from
 * agy's own mailbox: `<app data>/brain/<conversation>/.system_generated/
 * messages/<uuid>.json`, one JSON file per message agentapi took (recipient,
 * renderDetails.messageTitle, content). agy writes the file before
 * `agentapi send-message` returns, and keeps it after the message lands in
 * the transcript, so it is agy's own receipt (seen live, agy CLI 1.5.17 and
 * 1.5.18, idle and mid-turn). `present`: a file for this conversation with
 * our title whose first line is the bus's header for this msg id
 * (`[oa-bus] … (msg_id <id>)`). Only that line is matched: the rest of the
 * header (the session's bus name, its namespace) can change between two
 * pushes of one message, and the body comes after it, so a peer body that
 * quotes the header is never taken for it. `absent`: the mailbox reads and
 * has none. `unreadable`: the conversation's folder is missing, a message
 * file cannot be read, or one that names this msg id cannot be parsed, so
 * nothing can be said.
 */
export function agyMailboxHas(
  appDataDir: string,
  conversationId: string,
  title: string,
  msgId: string,
): AgyMailboxState {
  if (!AgentRefSchema.safeParse(conversationId).success) return "unreadable";
  const gen = join(appDataDir, "brain", conversationId, ".system_generated");
  let names: string[];
  try {
    names = readdirSync(join(gen, "messages"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable";
    // No mailbox yet: agy has taken no message for this conversation, as
    // long as the conversation itself is there.
    try {
      readdirSync(gen);
      return "absent";
    } catch {
      return "unreadable";
    }
  }
  const tail = ` (msg_id ${msgId})`;
  let seen = 0;
  for (const name of names) {
    if (!/^[0-9a-f-]{8,64}\.json$/i.test(name)) continue;
    seen += 1;
    if (seen > AGY_MAILBOX_MAX) return "unreadable";
    let raw: string;
    try {
      const fd = openSync(
        join(gen, "messages", name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) continue;
        if (st.size > AGY_MAILBOX_FILE_MAX) continue;
        raw = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return "unreadable";
    }
    if (!raw.includes(msgId)) continue;
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      // Ours, half written, or not agy's: no answer either way.
      return "unreadable";
    }
    const d = (m ?? {}) as {
      recipient?: unknown;
      content?: unknown;
      renderDetails?: { messageTitle?: unknown };
    };
    if (
      d.recipient !== conversationId ||
      d.renderDetails?.messageTitle !== title ||
      typeof d.content !== "string"
    )
      continue;
    const first = d.content.split("\n", 1)[0] as string;
    if (first.startsWith(AGY_HEADER_START) && first.endsWith(tail))
      return "present";
  }
  return "absent";
}

/** How the bus's header on every message it hands agy begins. */
export const AGY_HEADER_START = "[oa-bus] ";

/** The name an agy session proposes when its conversation has no title yet. */
export const AGY_DEFAULT_NAME = "agy";

/** A title as a bus name: lower case words joined by `-`, at most 40 chars. */
export function nameFromTitle(title: string | undefined): string | undefined {
  const slug = (title ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : undefined;
}

/** agy's own store of conversation titles (CLI 1.5). */
export const agySummariesDb = (home: string = homedir()) =>
  join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");

/**
 * The title agy gave a conversation, read-only from its summaries store, or
 * undefined: a new conversation has none at its first message, and a Node
 * without `node:sqlite` or a store it cannot open is no title, never an error.
 */
export async function agyTitle(
  conversationId: string,
  db: string = agySummariesDb(),
): Promise<string | undefined> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const row = conn
        .prepare(
          "SELECT title FROM conversation_summaries WHERE conversation_id = ?",
        )
        .get(conversationId) as { title?: unknown } | undefined;
      return typeof row?.title === "string" && row.title.trim()
        ? row.title.trim()
        : undefined;
    } finally {
      conn.close();
    }
  } catch {
    return undefined;
  }
}

/** The hello for an agy conversation: the daemon checks the pid runs agy, started then. */
export function agyHello(
  c: AgyConversation,
  caps: string[] = [
    ADAPTER_CAPS.mailbox,
    ADAPTER_CAPS.pending,
    ADAPTER_CAPS.follow,
    ADAPTER_CAPS.reach,
  ],
): Hello | undefined {
  const hello = Hello.safeParse({
    v: 1,
    id: "hello",
    type: "hello",
    kind: "antigravity",
    client_version: CLIENT_VERSION,
    agent_ref: c.conversationId,
    pid: c.pid,
    cwd: c.cwd,
    proposed_name: c.name ?? AGY_DEFAULT_NAME,
    caps,
    attest: { proc_start: c.procStart },
  });
  return hello.success ? hello.data : undefined;
}

/** A tool call from a process no agy started: no install would help. */
export const NOT_UNDER_AGY =
  "This MCP server is for Antigravity (agy); use this harness's own bus tools.";

/** agy started this server, but no conversation of it has joined yet. */
export const AGY_NOT_JOINED = `oa-bus: this Antigravity session hasn't joined the bus yet. It joins at its first message, through the oa-bus plugin; run \`${BUS_CMD} doctor\` if it doesn't.`;

const refused = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export type AntigravityDeps = {
  connect: (hello: Hello) => Promise<DaemonClient>;
  busHome: () => string;
  procStart: (pid: number) => string | null;
  proc?: Proc;
  /** This server's parent: agy, when agy started it. */
  ppid?: number;
};

/**
 * The bus tools for agy. Each call finds the agy process above this server,
 * reads the conversation its hook last reported, and says hello for it on a
 * connection of its own, closed after the call. A recorded start time that is
 * not the process's own (a reused pid) is not that process's conversation.
 */
export function antigravityServer(deps: AntigravityDeps): Server {
  const ppid = deps.ppid ?? process.ppid;
  const proc = deps.proc ?? readProc;
  const server = new Server(
    { name: "oa_bus", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      const agy = findAgy(ppid, proc);
      if (agy === undefined) return refused(NOT_UNDER_AGY);
      const start = deps.procStart(agy);
      const conv = readAgyConversation(deps.busHome(), agy);
      if (!conv || start === null || conv.procStart !== start)
        return refused(AGY_NOT_JOINED);
      const hello = agyHello(conv);
      if (!hello) return refused(AGY_NOT_JOINED);
      let client: DaemonClient;
      try {
        client = await deps.connect(hello);
      } catch (e) {
        const reason =
          e instanceof HelloRefused && e.reason
            ? e.reason
            : e instanceof Error
              ? e.message
              : String(e);
        return refused(
          `Open Artifacts bus did not accept this session: ${reason}`,
        );
      }
      try {
        return await callTool(
          req.params.name,
          (req.params.arguments ?? {}) as Record<string, unknown>,
          client,
          extra.signal,
        );
      } finally {
        client.close();
      }
    } catch (e) {
      return refused(`oa-bus: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return server;
}
