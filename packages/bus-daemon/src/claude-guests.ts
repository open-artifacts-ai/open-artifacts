import { randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { readOwnFile } from "./own-file.ts";

/**
 * #2793 S3b: the guests a daemon holds. A guest is a Claude Code session homed
 * on one instance that used another instance's tools; it is registered on that
 * other instance as a name and a kind only. The set is kept across a restart
 * as (pid, procStart, instance): a restart restores exactly that set and never
 * derives a guest from the proofs it holds.
 */
export const CLAUDE_GUESTS_MAX = 64;

const EntrySchema = z.strictObject({
  pid: z.number().int().positive(),
  procStart: z.string().min(1).max(100),
  instance: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** The opaque ref this guest has on that instance only; random, never derived from the session. */
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/)
    .optional(),
});
export type ClaudeGuest = z.infer<typeof EntrySchema>;

const FileSchema = z.strictObject({
  v: z.literal(1),
  guests: z.array(z.unknown()),
});

/** The entries in `file`; none when missing, unsafe, unparseable or off schema. Never throws. */
export function readClaudeGuests(
  file: string,
  uid: number | undefined = process.getuid?.(),
  log: (m: string) => void = () => {},
): ClaudeGuest[] {
  try {
    const f = readOwnFile(file, uid);
    if (f.state === "unsafe") log(`ignoring ${file}: ${f.why}`);
    if (f.state !== "ok") return [];
    const top = FileSchema.safeParse(JSON.parse(f.text));
    if (!top.success) {
      log(`ignoring ${file}: not the expected shape`);
      return [];
    }
    const out: ClaudeGuest[] = [];
    for (const raw of top.data.guests) {
      if (out.length >= CLAUDE_GUESTS_MAX) break;
      const one = EntrySchema.safeParse(raw);
      if (one.success) out.push(one.data);
    }
    return out;
  } catch (e) {
    log(`ignoring ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Replaces the file atomically, mode 0600; the tmp is created fresh, never followed. */
export function writeClaudeGuests(file: string, guests: ClaudeGuest[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(
      tmp,
      JSON.stringify({ v: 1, guests: guests.slice(0, CLAUDE_GUESTS_MAX) }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A fresh opaque ref for one guest on one instance: unrelated to the session and to its refs elsewhere. */
export const newGuestRef = (): string =>
  `g-${randomBytes(16).toString("base64url")}`;

/** At most `max` admissions per rolling `windowMs` per key; the rest are counted, never queued. */
export class GuestRate {
  readonly #hits = new Map<string, number[]>();
  readonly #dropped = new Map<string, number>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  admit(key: string): boolean {
    const t = this.now();
    const live = (this.#hits.get(key) ?? []).filter(
      (x) => t - x < this.windowMs,
    );
    if (live.length >= this.max) {
      this.#hits.set(key, live);
      this.#dropped.set(key, (this.#dropped.get(key) ?? 0) + 1);
      return false;
    }
    live.push(t);
    this.#hits.set(key, live);
    return true;
  }
  dropped(key: string): number {
    return this.#dropped.get(key) ?? 0;
  }
}

type Doc = Record<string, unknown>;
const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Where Claude keeps its settings file: under CLAUDE_CONFIG_DIR, else the home folder. */
export const claudeConfigFile = (
  env: Record<string, string | undefined> = process.env,
): string =>
  env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");

/** Claude's own transcripts: `<config dir>/projects/<project>/<session id>.jsonl`. */
export const claudeProjectsDir = (
  env: Record<string, string | undefined> = process.env,
): string =>
  join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

/** An address as origin + path, `ws` read as `http`; undefined when it is not one. */
function mcpAddress(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url.replace(/^ws(s?):/i, "http$1:"));
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * The names of the MCP entries of Claude's config (user scope, and the local
 * scope of `cwd`) that are an HTTP server at `hub`'s /mcp. The names are the
 * user's, so they are found by address. Never throws.
 */
export function mcpEntryNames(
  configFile: string,
  hub: string,
  cwd: string,
): string[] {
  const want = mcpAddress(`${hub.replace(/\/+$/, "")}/mcp`);
  if (want === undefined) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(doc)) return [];
  const names = new Set<string>();
  const scan = (servers: unknown) => {
    if (!isRecord(servers)) return;
    for (const [name, entry] of Object.entries(servers))
      if (
        isRecord(entry) &&
        (entry.type === undefined || entry.type === "http") &&
        mcpAddress(entry.url) === want
      )
        names.add(name);
  };
  scan(doc.mcpServers);
  if (isRecord(doc.projects)) {
    const p = doc.projects[cwd];
    if (isRecord(p)) scan(p.mcpServers);
  }
  return [...names];
}

/** The tool-name prefix Claude gives an MCP entry: `mcp__<name>__`, odd characters as `_`. */
export const toolPrefixOf = (entry: string): string =>
  `mcp__${entry.replace(/[^A-Za-z0-9_-]/g, "_")}__`;

/** A session id as a path part: ids only, never a separator or dots. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The session's transcript under `projectsDir`, or undefined. The id is checked as a path part first. */
export function findTranscript(
  projectsDir: string,
  sessionId: string,
  cwd?: string,
): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const file = `${sessionId}.jsonl`;
  try {
    if (cwd !== undefined) {
      const own = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, "-"), file);
      if (existsSync(own)) return own;
    }
    for (const d of readdirSync(projectsDir)) {
      const p = join(projectsDir, d, file);
      if (existsSync(p)) return p;
    }
  } catch {}
  return undefined;
}

/** A tool of the entry itself: the rest after the prefix holds no `__`, so an entry `<name>__x` is not `<name>`. */
export const isToolOf = (tool: string, prefix: string): boolean =>
  tool.startsWith(prefix) && !tool.slice(prefix.length).includes("__");

/** A line longer than this is skipped, never parsed. */
const LINE_MAX = 4 * 1024 * 1024;

/**
 * Whether the transcript holds an assistant `tool_use` whose tool name starts
 * with one of `prefixes`: the session itself called a tool of that server.
 * Structural: a user's text or a tool result that merely names the prefix does
 * not count. Resolves false on any read error.
 */
export async function usedToolOf(
  transcript: string,
  prefixes: string[],
): Promise<boolean> {
  if (prefixes.length === 0) return false;
  try {
    const rl = createInterface({
      input: createReadStream(transcript, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of rl) {
        if (
          line.length > LINE_MAX ||
          !line.includes('"tool_use"') ||
          !prefixes.some((p) => line.includes(p))
        )
          continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = isRecord(rec) && isRecord(rec.message) ? rec.message : null;
        if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const part of msg.content)
          if (
            isRecord(part) &&
            part.type === "tool_use" &&
            typeof part.name === "string" &&
            prefixes.some((p) => isToolOf(part.name as string, p))
          )
            return true;
      }
    } finally {
      rl.close();
    }
  } catch {}
  return false;
}
