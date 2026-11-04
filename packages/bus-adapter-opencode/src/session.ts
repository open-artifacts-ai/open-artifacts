import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Api = (
  op: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown> | undefined>;

/** `opencode api` finds the service and carries its password; nothing here reads OpenCode's config. */
export const opencodeApi: Api = async (op, params) => {
  const args = ["api", op];
  for (const [k, v] of Object.entries(params))
    args.push("--param", `${k}=${v}`);
  const { stdout } = await run("opencode", args, { timeout: 15_000 });
  const data = (JSON.parse(stdout) as { data?: unknown }).data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : undefined;
};

/** The agent a session id belongs to, the directory its namespace comes from, and its title. */
export type OpenCodeSession = {
  root: string;
  directory: string | null;
  title: string | null;
};

const MAX_DEPTH = 32;
const ROOTS = new Map<string, OpenCodeSession>();

export type RootDeps = {
  api: Api;
  /** A parent never changes once a session exists, so entries never go stale. */
  cache?: Map<string, OpenCodeSession>;
  maxDepth?: number;
};

function directoryOf(s: Record<string, unknown>): string | null {
  const loc = s.location as { directory?: unknown } | undefined;
  const dir = s.directory ?? loc?.directory;
  return typeof dir === "string" && isAbsolute(dir) ? dir : null;
}

/**
 * A sub-agent's calls carry the child id; the agent is the root conversation.
 * Null when the server cannot answer, the chain cycles or runs past the cap:
 * "cannot tell" is never cached.
 */
export async function rootSession(
  sessionId: string,
  deps: RootDeps,
): Promise<OpenCodeSession | null> {
  const cache = deps.cache ?? ROOTS;
  const cached = cache.get(sessionId);
  if (cached) return cached;
  const seen = [sessionId];
  let cur = sessionId;
  for (let depth = 0; ; depth += 1) {
    if (depth >= (deps.maxDepth ?? MAX_DEPTH)) return null;
    let s: Record<string, unknown> | undefined;
    try {
      s = await deps.api("session.get", { sessionID: cur });
    } catch {
      return null;
    }
    if (!s) return null;
    const parent = s.parentID;
    if (typeof parent !== "string" || !parent) {
      const out = {
        root: cur,
        directory: directoryOf(s),
        title: typeof s.title === "string" ? s.title : null,
      };
      for (const id of seen) cache.set(id, out);
      return out;
    }
    if (seen.includes(parent)) return null;
    seen.push(parent);
    cur = parent;
  }
}

/** The root session's id, or `sessionId` unchanged when it cannot be told. */
export async function rootOf(
  sessionId: string,
  deps: RootDeps,
): Promise<string> {
  return (await rootSession(sessionId, deps))?.root ?? sessionId;
}
