import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { type Hello, SPAWNED_SOURCES, systemTool } from "@oa/bus-ipc";
import { lstartEpoch } from "./presence/opencode.ts";

/**
 * Refusal reasons for a codex hello (Design-approved copy). The adapter shows
 * each as "Open Artifacts bus did not accept this thread: <reason>".
 */
export const CODEX_REFUSALS = {
  notCodex: "it is not running under Codex.",
  restarted: "Codex restarted. Call the tool again.",
  notLoaded: "Codex does not have this thread loaded.",
  callNotFound:
    "this call is not an open Open Artifacts bus call in the thread. Call the tool again.",
  subagent:
    "only the main Codex thread can use Open Artifacts bus, not a subagent.",
  /** DRAFT (C27), pending Design. */
  oneExec:
    "this exec already made an Open Artifacts bus call. Make each Open Artifacts bus call in its own exec.",
} as const;

/**
 * The tool namespace Codex gives our MCP entry: `mcp__<entry name>`, so the
 * installer must write exactly `[mcp_servers.oa_bus]`.
 */
export const OA_BUS_NAMESPACE = "mcp__oa_bus";

/** A thread's first scan starts this far from the end: the open call is near it. */
const TAIL_CAP = 8 * 1024 * 1024;
/**
 * A longer line is skipped, never buffered: an oa_bus call or its output is
 * small, and session_meta (with base_instructions) is tens of KB.
 */
const LINE_CAP = 1024 * 1024;
/**
 * session_meta holds base_instructions and the user's instructions: tens of
 * KB seen, so a far larger cap. It is read once per thread.
 */
const META_CAP = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;

export type Hold = { pid: number; file: string };

/** One `ps` row: the parent, the start time (as ps prints it) and the executable. */
export type Proc = { ppid: number; start: string; comm: string };

export type CodexAttestDeps = {
  /** Codex's home; default `${CODEX_HOME:-~/.codex}` as the daemon sees it. */
  home?: string;
  /** One `ps -o pid=,ppid=,lstart=,comm=` for all of `pids`; a gone pid is absent. */
  procs?: (pids: number[]) => Map<number, Proc>;
  /**
   * For each (pid, file), whether the pid holds the file: one `lsof` (macOS)
   * or one /proc/locks read (Linux) for all of them.
   */
  holding?: (pairs: Hold[]) => boolean[];
  /** Wait before reading an absent call once more; default 50 ms. */
  retryMs?: number;
  /** The wait itself; default a timer, so the daemon keeps serving. */
  sleep?: (ms: number) => Promise<void>;
};

export type CodexAttest =
  | { ok: true; cwd: string; pid: number }
  | { ok: false; reason: string };

export type CodexAttestor = {
  /** A promise only while an absent call gets its one asynchronous retry. */
  attest: (hello: Hello) => CodexAttest | Promise<CodexAttest>;
  /** `attest` without the retry: an absent call is refused at once. */
  attestNow: (hello: Hello) => CodexAttest;
  /**
   * The threads, of those given, whose process is still the one pinned and,
   * with `relock`, still holds the thread's lock. A thread that fails loses
   * its proof; a process that is gone or restarted is forgotten.
   */
  sweep: (
    live: { thread: string; pid: number }[],
    relock: boolean,
  ) => Set<string>;
};

/** What a thread proved under one (P, start). */
type Proof = { cwd: string; rollout: string };

type OpenCall = { at: number; turn: string | undefined };

/** A code-mode `exec` custom_tool_call with no output yet (C27). */
type OpenExec = OpenCall & { call: string };

/** The call id Codex mints for each call an `exec` makes (codex-rs delegate.rs). */
const EXEC_CALL = /^exec-[0-9a-f-]{36}$/;

/** What `visitLine` keeps from a rollout. */
type Seen = {
  /**
   * mcp__oa_bus calls with no output yet: each line's timestamp (ms) and its
   * turn. The end of that turn closes it.
   */
  open: Map<string, OpenCall>;
  /**
   * Code mode: open `exec` calls that name an Open Artifacts bus tool, by item id
   * (`_meta.itemId`), closed the same ways.
   */
  execs: Map<string, OpenExec>;
  /**
   * The last `task_started` turn: the thread's latest. Codex 0.165 rollouts
   * show no nested turns, so an earlier one never becomes latest again.
   */
  latest: string | undefined;
  /** `exec-<uuid>` call ids Codex reported done: never admitted. */
  done: Set<string>;
};

const seen = (): Seen => ({
  open: new Map(),
  execs: new Map(),
  latest: undefined,
  done: new Set(),
});

/** Admitted call ids kept per thread, oldest dropped first. */
const USED_CAP = 4096;

/** A thread's rollout, read forward from `offset`: only appended bytes are new. */
type Scan = Seen & {
  rollout: string;
  /** -1 until the first read, which starts TAIL_CAP from the end. */
  offset: number;
  /** The process that built the scan, for pruning when it goes. */
  pid: number;
};

export const codexHome = (): string =>
  process.env.CODEX_HOME || join(homedir(), ".codex");

const lockOf = (home: string, thread: string) =>
  join(home, "thread-writer-locks", `${thread}.lock`);

/** A regular file, not a symlink: a link could point the check at another thread. */
const plainFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The codex check (D1): the adapter's parent P is a `codex` process whose
 * start is pinned at its first hello, P holds the thread's writer lock, the
 * thread's rollout has this call id as an unanswered `mcp__oa_bus`
 * function_call, and the thread is not a subagent. Stateful: one per daemon.
 *
 * Code mode (C27, docs/probes/codex.md §2): the call id is a fresh
 * `exec-<uuid>` the rollout never has, so the hello's item id must instead be
 * an open `exec` custom_tool_call that names an Open Artifacts bus tool, in the thread's
 * latest turn, which is the request's; one hello per exec.
 *
 * The bar assumes nothing but Codex writes to CODEX_HOME (docs/probes/codex.md
 * §2): a same-user writer there can forge the rollout and the lock.
 */
export function codexAttestor(deps: CodexAttestDeps = {}): CodexAttestor {
  const procs = deps.procs ?? psRows;
  const holding = deps.holding ?? holdingFiles;
  const retryMs = deps.retryMs ?? 50;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** P's start time, pinned at its first proven hello. */
  const pinned = new Map<number, string>();
  /** Keyed by `${P}\0${start}\0${thread}`. */
  const proofs = new Map<string, Proof>();
  /** Rebuilt on demand from a proof, so pruning one P's scan never strands another's proof. */
  const scans = new Map<string, Scan>();
  /**
   * Call ids already admitted, per thread, for the daemon's lifetime: never
   * pruned with a process, so a resumed thread cannot replay one.
   */
  const used = new Map<string, Set<string>>();
  /** Code-mode exec item ids already admitted, kept the same way. */
  const usedItems = new Map<string, Set<string>>();
  const spendIn =
    (m: Map<string, Set<string>>) => (thread: string, id: string) => {
      const set = m.get(thread) ?? new Set<string>();
      set.add(id);
      if (set.size > USED_CAP) set.delete(set.values().next().value as string);
      m.set(thread, set);
    };
  const spend = spendIn(used);
  const spendItem = spendIn(usedItems);
  /** Each thread's session_meta, read once per rollout. */
  const metas = new Map<
    string,
    { rollout: string; meta: Record<string, unknown> }
  >();
  const metaOf = (rollout: string, thread: string) => {
    const had = metas.get(thread);
    if (had?.rollout === rollout) return had.meta;
    const meta = sessionMeta(rollout, thread);
    if (meta) metas.set(thread, { rollout, meta });
    return meta;
  };
  const no = (reason: string): CodexAttest => ({ ok: false, reason });

  /** P is gone or is another process now: nothing it proved stands. */
  const forget = (p: number) => {
    pinned.delete(p);
    for (const k of proofs.keys()) if (k.startsWith(`${p}\0`)) proofs.delete(k);
    for (const [t, s] of scans) if (s.pid === p) scans.delete(t);
  };

  const check = (
    hello: Hello,
    retry: boolean,
  ): CodexAttest | Promise<CodexAttest> => {
    const cx = hello.codex;
    if (!cx || cx.thread_id !== hello.agent_ref)
      return no("codex hello does not name its thread");
    const home = deps.home ?? codexHome();
    const thread = cx.thread_id;
    const p = cx.ppid;
    // 1. Parent: the claimed ppid is the adapter's real parent, and it is codex.
    const rows = procs([hello.pid, p]);
    const proc = rows.get(p);
    if (!proc || rows.get(hello.pid)?.ppid !== p)
      return no(CODEX_REFUSALS.notCodex);
    if (basename(proc.comm) !== "codex") return no(CODEX_REFUSALS.notCodex);
    const was = pinned.get(p);
    if (was !== undefined && was !== proc.start) {
      // A reused pid: the next call proves itself afresh.
      forget(p);
      return no(CODEX_REFUSALS.restarted);
    }
    const key = `${p}\0${proc.start}\0${thread}`;
    let proof = proofs.get(key);
    if (!proof) {
      // 2. Lock: P has the thread loaded.
      const lock = lockOf(home, thread);
      if (!plainFile(lock) || !holding([{ pid: p, file: lock }])[0])
        return no(CODEX_REFUSALS.notLoaded);
      // 4. Not a subagent: the db decides; the rollout's session_meta when it can't.
      const row = threadRow(home, thread);
      const rollout = row?.rollout_path ?? globRollout(home, thread);
      if (!rollout || !plainFile(rollout))
        return no(CODEX_REFUSALS.callNotFound);
      const meta = metaOf(rollout, thread);
      if (!meta) return no(CODEX_REFUSALS.callNotFound);
      if (
        isSubagent(row ? row.source : meta.source) ||
        isSubagent(meta.source) ||
        SPAWNED_SOURCES.has(String(meta.thread_source))
      )
        return no(CODEX_REFUSALS.subagent);
      // The rollout's cwd is the thread's; the adapter's is a workspace guess.
      if (typeof meta.cwd !== "string" || !isAbsolute(meta.cwd))
        return no(CODEX_REFUSALS.callNotFound);
      proof = { cwd: meta.cwd, rollout };
      pinned.set(p, proc.start);
      proofs.set(key, proof);
    }
    // The hint is never enough, but an honest one saying subagent is believed.
    if (cx.thread_source && SPAWNED_SOURCES.has(cx.thread_source))
      return no(CODEX_REFUSALS.subagent);
    // 3. Call: this call id is in flight in this thread's current turn,
    // written by P (not before P started), and new to us.
    if (used.get(thread)?.has(cx.call_id))
      return no(CODEX_REFUSALS.callNotFound);
    let scan = scans.get(thread);
    if (scan?.rollout !== proof.rollout) {
      scan = { rollout: proof.rollout, offset: -1, pid: p, ...seen() };
      scans.set(thread, scan);
    }
    // lstart has one-second resolution: a line stamped within P's first
    // second may predate P, so only the next second on counts (a model turn
    // takes longer than that).
    const since =
      ((lstartEpoch(proc.start) ?? Number.POSITIVE_INFINITY) + 1) * 1000;
    const isOpen = (sc: Scan) => (sc.open.get(cx.call_id)?.at ?? -1) >= since;
    // Code mode: the exec is open in this turn, the thread's latest, and was
    // written by P; the call id is Codex-shaped and not reported done.
    const item = cx.item_id;
    const execOpen = (sc: Scan) => {
      if (!item || !cx.turn_id || !EXEC_CALL.test(cx.call_id)) return false;
      const e = sc.execs.get(item);
      return (
        e !== undefined &&
        e.at >= since &&
        e.turn === cx.turn_id &&
        sc.latest === e.turn &&
        !sc.done.has(cx.call_id)
      );
    };
    const itemUsed = () =>
      item !== undefined && (usedItems.get(thread)?.has(item) ?? false);
    const ok: CodexAttest = { ok: true, cwd: proof.cwd, pid: p };
    const admitExec = (): CodexAttest => {
      spend(thread, cx.call_id);
      spendItem(thread, item as string);
      return ok;
    };
    advance(scan);
    if (isOpen(scan)) {
      spend(thread, cx.call_id);
      return ok;
    }
    // One hello per exec: a second Open Artifacts bus call in it is told to use its own.
    if (itemUsed()) return no(CODEX_REFUSALS.oneExec);
    if (execOpen(scan)) return admitExec();
    if (!retry || retryMs <= 0) return no(CODEX_REFUSALS.callNotFound);
    // The live capture saw the call flushed before the MCP request; one short
    // wait covers a slower disk. Spent now: each call id gets one wait.
    spend(thread, cx.call_id);
    const sc = scan;
    return sleep(retryMs).then(() => {
      advance(sc);
      if (isOpen(sc)) return ok;
      if (itemUsed()) return no(CODEX_REFUSALS.oneExec);
      return execOpen(sc) ? admitExec() : no(CODEX_REFUSALS.callNotFound);
    });
  };

  const sweep: CodexAttestor["sweep"] = (live, relock) => {
    const home = deps.home ?? codexHome();
    const rows = live.length
      ? procs([...new Set(live.map((l) => l.pid))])
      : new Map<number, Proc>();
    const still = new Set<string>();
    const recheck: { thread: string; key: string; hold: Hold }[] = [];
    for (const { thread, pid } of live) {
      const row = rows.get(pid);
      const start = pinned.get(pid);
      if (!row || start === undefined || row.start !== start) {
        forget(pid);
        continue;
      }
      const key = `${pid}\0${start}\0${thread}`;
      if (!proofs.has(key)) continue;
      const file = lockOf(home, thread);
      if (!relock) still.add(thread);
      else if (plainFile(file))
        recheck.push({ thread, key, hold: { pid, file } });
      else proofs.delete(key);
    }
    // One lsof (or /proc read) for every live thread's lock.
    const held = recheck.length ? holding(recheck.map((r) => r.hold)) : [];
    recheck.forEach(({ thread, key }, i) => {
      if (held[i]) still.add(thread);
      else proofs.delete(key);
    });
    return still;
  };

  return {
    attest: (hello) => check(hello, true),
    attestNow: (hello) => check(hello, false) as CodexAttest,
    sweep,
  };
}

/** Reads the rollout's new complete lines into `scan.open`. */
function advance(scan: Scan): void {
  let fd: number;
  try {
    fd = openSync(scan.rollout, "r");
  } catch {
    return;
  }
  try {
    const size = fstatSync(fd).size;
    // Replaced or truncated: start over.
    if (scan.offset > size) {
      scan.offset = -1;
      Object.assign(scan, seen());
    }
    let skipFirst = false;
    if (scan.offset < 0) {
      // First read: only the tail; the line it cuts into is skipped.
      scan.offset = Math.max(0, size - TAIL_CAP);
      skipFirst = scan.offset > 0;
    }
    scan.offset = readLines(fd, scan.offset, size, skipFirst, (l) => {
      visitLine(scan, l);
      return false;
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Calls `visit` for each complete line in [from, size) until it returns true,
 * and returns the offset after the last complete line read. A line's parts
 * are joined once; a line past `cap` is skipped without buffering.
 */
export function readLines(
  fd: number,
  from: number,
  size: number,
  skipFirst: boolean,
  visit: (line: string) => boolean,
  cap = LINE_CAP,
): number {
  let pos = from;
  let done = from;
  let parts: Buffer[] = [];
  let partLen = 0;
  let skipping = skipFirst;
  while (pos < size) {
    const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
    const got = readSync(fd, buf, 0, buf.length, pos);
    if (got <= 0) break;
    let s = 0;
    let nl = buf.indexOf(10, 0);
    while (nl >= 0 && nl < got) {
      let stop = false;
      if (!skipping) {
        parts.push(buf.subarray(s, nl));
        stop = visit(Buffer.concat(parts, partLen + nl - s).toString("utf8"));
      }
      parts = [];
      partLen = 0;
      skipping = false;
      s = nl + 1;
      done = pos + s;
      if (stop) return done;
      nl = buf.indexOf(10, s);
    }
    if (!skipping && s < got) {
      partLen += got - s;
      if (partLen > cap) {
        parts = [];
        partLen = 0;
        skipping = true;
      } else parts.push(buf.subarray(s, got));
    }
    pos += got;
  }
  return done;
}

/**
 * Events that end a turn: a call of that turn still open is dangling. A
 * turn's start closes nothing, since a nested turn may start inside another.
 */
const TURN_ENDS: ReadonlySet<string> = new Set([
  "task_complete",
  "turn_aborted",
]);

/**
 * One rollout line. An `mcp__oa_bus` function_call opens its call id; its
 * `function_call_output`, an `*_end` event, or the `item_completed` event
 * Codex writes for it (docs/probes/codex.md §2, live capture) closes it. The
 * end of its turn (`turn_id`, as the capture ties a call to its turn) closes
 * it too, so one left open by a crash or never dispatched is never a token;
 * an end naming no turn closes every call. A code-mode `exec`
 * custom_tool_call whose script names an Open Artifacts bus tool opens and closes the
 * same way, keyed by its item id (C27); `task_started` marks the latest turn.
 */
function visitLine(st: Seen, text: string): void {
  if (!/call|task_complete|turn_aborted|task_started|item_completed/.test(text))
    return;
  const { open, execs } = st;
  let line: Record<string, unknown> | undefined;
  try {
    line = record(JSON.parse(text));
  } catch {
    return;
  }
  const p = record(line?.payload);
  if (!p || typeof p.type !== "string") return;
  if (line?.type === "event_msg" && p.type === "task_started") {
    if (typeof p.turn_id === "string") st.latest = p.turn_id;
    return;
  }
  if (line?.type === "event_msg" && TURN_ENDS.has(p.type)) {
    const turn = typeof p.turn_id === "string" ? p.turn_id : undefined;
    for (const [id, c] of open)
      if (turn === undefined || c.turn === undefined || c.turn === turn)
        open.delete(id);
    for (const [id, c] of execs)
      if (turn === undefined || c.turn === undefined || c.turn === turn)
        execs.delete(id);
    return;
  }
  if (p.type === "item_completed") {
    const id = record(p.item)?.id;
    if (typeof id === "string") {
      open.delete(id);
      if (EXEC_CALL.test(id)) {
        st.done.add(id);
        if (st.done.size > USED_CAP)
          st.done.delete(st.done.values().next().value as string);
      }
    }
    return;
  }
  if (typeof p.call_id !== "string") return;
  if (line?.type === "response_item" && p.type === "custom_tool_call") {
    const turn = record(p.internal_chat_message_metadata_passthrough)?.turn_id;
    // Only an exec whose script names an Open Artifacts bus tool: in code mode every
    // tool runs in an exec, and a dynamic lookup (`tools[name]`) is refused.
    if (
      p.name === "exec" &&
      p.namespace === undefined &&
      typeof p.id === "string" &&
      typeof p.input === "string" &&
      p.input.includes(`${OA_BUS_NAMESPACE}__`)
    )
      execs.set(p.id, {
        call: p.call_id,
        at: Date.parse(String(line.timestamp)),
        turn: typeof turn === "string" ? turn : undefined,
      });
    return;
  }
  if (line?.type === "response_item" && p.type === "function_call") {
    const ours =
      p.namespace === OA_BUS_NAMESPACE ||
      (p.namespace === undefined &&
        typeof p.name === "string" &&
        p.name.startsWith(`${OA_BUS_NAMESPACE}__`));
    // An unparseable timestamp reads as NaN: never at or after a start.
    const turn = record(p.internal_chat_message_metadata_passthrough)?.turn_id;
    if (ours)
      open.set(p.call_id, {
        at: Date.parse(String(line.timestamp)),
        turn: typeof turn === "string" ? turn : undefined,
      });
    return;
  }
  if (p.type.endsWith("_output") || p.type.endsWith("_end")) {
    open.delete(p.call_id);
    for (const [id, e] of execs) if (e.call === p.call_id) execs.delete(id);
  }
}

/** Whether `callId` is an unanswered oa_bus call in the rollout's tail. */
export function callOpen(path: string, callId: string): boolean {
  const scan: Scan = { rollout: path, offset: -1, pid: 0, ...seen() };
  advance(scan);
  return scan.open.has(callId);
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** `source` as Codex stores it: a string (`exec`, `cli`), or `{"subagent":…}`, raw or as JSON text. */
export function isSubagent(source: unknown): boolean {
  let s = source;
  if (typeof s === "string" && s.trimStart().startsWith("{"))
    try {
      s = JSON.parse(s);
    } catch {
      return true;
    }
  if (typeof s === "string") return s === "subagent";
  return record(s)?.subagent !== undefined;
}

type ThreadRow = { rollout_path: string | undefined; source: unknown };

/**
 * The thread's row in `state_5.sqlite`, read-only. Not `immutable=1`: the db
 * is in WAL mode and a new thread's row may be only in the WAL. Undefined when
 * the db or the row can't be read; node:sqlite is built in, so no new dependency.
 */
export function threadRow(home: string, thread: string): ThreadRow | undefined {
  try {
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) return undefined;
    const db = new sqlite.DatabaseSync(join(home, "state_5.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare("SELECT rollout_path, source FROM threads WHERE id = ?")
        .get(thread) as
        | { rollout_path?: unknown; source?: unknown }
        | undefined;
      if (!row) return undefined;
      const path = row.rollout_path;
      return {
        rollout_path:
          typeof path === "string" && isAbsolute(path) ? path : undefined,
        source: row.source,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`, the newest when several. */
export function globRollout(home: string, thread: string): string | undefined {
  const suffix = `-${thread}.jsonl`;
  const dirs = (d: string) => {
    try {
      return readdirSync(d).sort().reverse();
    } catch {
      return [];
    }
  };
  const root = join(home, "sessions");
  for (const y of dirs(root))
    for (const m of dirs(join(root, y)))
      for (const d of dirs(join(root, y, m)))
        for (const f of dirs(join(root, y, m, d)))
          if (f.startsWith("rollout-") && f.endsWith(suffix))
            return join(root, y, m, d, f);
  return undefined;
}

/** The rollout's first line, when it is complete, within META_CAP, and this thread's session_meta. */
export function sessionMeta(
  path: string,
  thread: string,
): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    let first: string | undefined;
    const size = Math.min(fstatSync(fd).size, META_CAP + 1);
    readLines(
      fd,
      0,
      size,
      false,
      (l) => {
        first = l;
        return true;
      },
      META_CAP,
    );
    if (first === undefined) return undefined;
    const line = record(JSON.parse(first));
    const payload = record(line?.payload);
    if (line?.type !== "session_meta" || payload?.id !== thread)
      return undefined;
    return payload;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * `ps` once for every pid: `pid ppid lstart comm`, in UTC and the C locale.
 * lstart is five fields; comm is the rest (it may hold spaces).
 */
export function psRows(pids: number[]): Map<number, Proc> {
  const out = new Map<number, Proc>();
  if (!pids.length) return out;
  let text: string;
  try {
    text = execFileSync(
      systemTool("ps"),
      ["-o", "pid=,ppid=,lstart=,comm=", "-p", pids.join(",")],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        timeout: 2000,
      },
    );
  } catch (e) {
    // ps exits 1 when some pid is gone, and still prints the others.
    text = String((e as { stdout?: unknown }).stdout ?? "");
  }
  for (const row of text.split("\n")) {
    const f = row.trim().split(/\s+/);
    if (f.length < 8) continue;
    const pid = Number(f[0]);
    const ppid = Number(f[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    out.set(pid, {
      ppid,
      start: f.slice(2, 7).join(" "),
      comm: f.slice(7).join(" "),
    });
  }
  return out;
}

/**
 * Which (pid, file) pairs hold: one `lsof -F pn` over every file (macOS), or
 * one /proc/locks read (Linux). lsof names files by their real path.
 */
export function holdingFiles(pairs: Hold[]): boolean[] {
  if (!pairs.length) return [];
  if (process.platform === "linux") return holdingLinux(pairs);
  const real = (f: string) => {
    try {
      return realpathSync(f);
    } catch {
      return undefined;
    }
  };
  const files = [...new Set(pairs.map((p) => p.file))];
  let out: string;
  try {
    out = execFileSync(systemTool("lsof"), ["-F", "pn", ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // It blocks the daemon, and the adapter waits 5 s for its hello.
      timeout: 2000,
    });
  } catch (e) {
    // lsof exits 1 when some file has no holder, and still lists the others.
    out = String((e as { stdout?: unknown }).stdout ?? "");
  }
  const holders = new Map<string, Set<number>>();
  let pid = 0;
  for (const l of out.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid > 0) {
      const set = holders.get(l.slice(1)) ?? new Set<number>();
      set.add(pid);
      holders.set(l.slice(1), set);
    }
  }
  return pairs.map(({ pid, file }) => {
    const r = real(file);
    return r !== undefined && (holders.get(r)?.has(pid) ?? false);
  });
}

/** A Linux st_dev split as /proc/locks prints it (glibc's major/minor). */
export function devParts(dev: bigint): { major: bigint; minor: bigint } {
  return {
    major: ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn),
    minor: (dev & 0xffn) | ((dev >> 12n) & ~0xffn),
  };
}

/**
 * Linux: /proc/locks has a lock on the file (`MAJ:MIN:INODE`, major and minor
 * in hex) and one of P's fds is that file. /proc/locks' pid is the locker,
 * which may be a forked child, so the fd decides who holds it. One read of
 * /proc/locks, and of each pid's fds, for all pairs.
 */
export function holdingLinux(pairs: Hold[], procRoot = "/proc"): boolean[] {
  let locks: Set<string>;
  try {
    locks = new Set(
      readFileSync(join(procRoot, "locks"), "utf8")
        .split("\n")
        .flatMap((l) => {
          // `1: FLOCK  ADVISORY  WRITE 1234 08:01:131074 0 EOF`
          const [maj, min, ino] = (l.trim().split(/\s+/)[5] ?? "").split(":");
          if (!maj || !min || !ino) return [];
          if (!/^[0-9a-f]+$/i.test(maj + min) || !/^\d+$/.test(ino)) return [];
          return [`${BigInt(`0x${maj}`)}:${BigInt(`0x${min}`)}:${ino}`];
        }),
    );
  } catch {
    return pairs.map(() => false);
  }
  const fdsOf = new Map<number, Set<string>>();
  const openBy = (pid: number) => {
    let set = fdsOf.get(pid);
    if (set) return set;
    set = new Set();
    const dir = join(procRoot, String(pid), "fd");
    try {
      for (const fd of readdirSync(dir))
        try {
          const f = statSync(join(dir, fd), { bigint: true });
          set.add(`${f.dev}:${f.ino}`);
        } catch {}
    } catch {}
    fdsOf.set(pid, set);
    return set;
  };
  return pairs.map(({ pid, file }) => {
    try {
      const st = statSync(file, { bigint: true });
      const { major, minor } = devParts(st.dev);
      return (
        locks.has(`${major}:${minor}:${st.ino}`) &&
        openBy(pid).has(`${st.dev}:${st.ino}`)
      );
    } catch {
      return false;
    }
  });
}

/** `holdingLinux` for one pair. */
export const holdsFileLinux = (
  pid: number,
  file: string,
  procRoot = "/proc",
): boolean => holdingLinux([{ pid, file }], procRoot)[0] ?? false;
