import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusReply } from "@oa/bus-ipc";
import { type Ctx, tilde } from "../context.ts";
import { claudeConfigFile } from "./claude-proof.ts";
import { safeText } from "./claude-proof-check.ts";

/**
 * #2688: which live Claude sessions are not linked, and why. A session is
 * linked when its `oa-bus mcp-proof` helper bound a proof to it; the helper
 * fails open (Claude must still connect) and Claude never runs it again, so
 * nothing else says when it did not. Causes and counts only: no proof, hash
 * or header is read, kept or printed here.
 */

/** The event the helper logs when it linked nothing (cause only). */
export const UNBOUND_EVENT = "mcp_proof_unbound";

const DAY_MS = 86_400_000;

export type Line = {
  level: "pass" | "fail" | "warn" | "info";
  head: string;
  notes: string[];
};

/** A hub address as its origin (ws as http); undefined when it is not a URL. */
export function hubOrigin(hub: string): string | undefined {
  try {
    return new URL(hub.replace(/^ws(s?):/, "http$1:")).origin;
  } catch {
    return undefined;
  }
}

/** Causes a session can be unlinked for. A code this CLI does not know is printed as it is. */
const CAUSE: Record<string, string> = {
  no_helper_call:
    "its helper never reported to the daemon (the entry has no helper, the entry is an sse one, Claude runs with another CLAUDE_CONFIG_DIR, or the helper could not tell it was under Claude)",
  proof_timed_out:
    "its helper's proof arrived before the session was recorded and expired",
  proof_refused: "the process its helper named did not match this session",
};

/** Calls that linked nothing: the daemon's own ring, then the helper's own log. */
const UNBOUND: Record<string, string> = {
  no_live_record: "no live session record appeared for the process in a minute",
  process_mismatch: "the process behind the call did not match the session",
  no_process_start: "the process's start time could not be read",
  no_claude_ancestor:
    "no Claude process above the helper (a wrapper, an IDE, the SDK, or more than 12 levels)",
  process_table_error: "the helper could not read the process table",
  process_not_matched:
    "the daemon could not match the process to a live session (a reused pid, or an unreadable start time)",
  daemon_unreachable: "the daemon did not answer in time, or is not running",
};

/** The helper's logged failures in the last day: reason to count and latest time. */
export function helperFailures(
  ctx: Ctx,
): Map<string, { n: number; at: string }> {
  const out = new Map<string, { n: number; at: string }>();
  let text: string;
  try {
    text = readFileSync(join(ctx.home, "logs", "events.log"), "utf8");
  } catch {
    return out;
  }
  for (const l of text.split("\n")) {
    if (!l.includes(` ${UNBOUND_EVENT} `)) continue;
    const at = l.split(" ")[0] ?? "";
    if (!(ctx.now() - Date.parse(at) < DAY_MS)) continue;
    const reason = / reason=(\S+)/.exec(l)?.[1];
    if (!reason) continue;
    const cur = out.get(reason);
    out.set(reason, { n: (cur?.n ?? 0) + 1, at });
  }
  return out;
}

const when = (at: string) => at.slice(0, 16).replace("T", " ");

const read = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `servers` has an entry at the instance's /mcp (any type); `sse` limits it to those. */
function matching(servers: unknown, origin: string, sse = false): string[] {
  if (!isObj(servers)) return [];
  const names: string[] = [];
  for (const [name, e] of Object.entries(servers)) {
    if (!isObj(e) || typeof e.url !== "string") continue;
    if (sse && e.type !== "sse") continue;
    try {
      const u = new URL(e.url);
      if (u.origin === origin && u.pathname.replace(/\/+$/, "") === "/mcp")
        names.push(name);
    } catch {}
  }
  return names;
}

/**
 * Whether an entry for the instance applies to a session in `cwd`: one at user
 * scope, a local-scope one for that folder, or a project-scope `.mcp.json`
 * there. A session reaching the instance another way (a claude.ai connector,
 * another project's entry) is not one this check can judge.
 */
function entryApplies(ctx: Ctx, origin: string, cwd: string): boolean {
  const doc = read(claudeConfigFile(ctx.userHome, ctx.env));
  if (isObj(doc)) {
    if (matching(doc.mcpServers, origin).length > 0) return true;
    const p = isObj(doc.projects) ? doc.projects[cwd] : undefined;
    if (isObj(p) && matching(p.mcpServers, origin).length > 0) return true;
  }
  const proj = read(join(cwd, ".mcp.json"));
  return isObj(proj) && matching(proj.mcpServers, origin).length > 0;
}

/**
 * The checks for the live Claude sessions. `st` is the daemon's status reply
 * (undefined when it is not running: doctor already says so). Fails per
 * unlinked live session that has an instance entry, passes when every such
 * session is linked, and lists recent unbound helper calls. A session with no
 * entry for the instance is not judged; one info line says how many.
 */
export function sessionChecks(
  ctx: Ctx,
  st: StatusReply | undefined,
  hub: string | undefined,
): Line[] {
  const out: Line[] = [];
  const origin = hub === undefined ? undefined : hubOrigin(hub);
  if (st?.claude_sessions === undefined && st !== undefined) {
    out.push({
      level: "warn",
      head: "Claude Code: this daemon is too old to say which sessions are linked.",
      notes: [`Fix: run ${ctx.busCmd} install to update it`],
    });
  } else if (st && origin !== undefined) {
    const live = st.claude_sessions ?? [];
    const judged = live.filter((s) => entryApplies(ctx, origin, s.cwd));
    const skipped = live.length - judged.length;
    const bad = judged.filter((s) => s.state === "unlinked");
    for (const s of bad)
      out.push({
        level: "fail",
        head: `Claude Code: the session ${safeText(s.name, 200)} in ${safeText(tilde(ctx, s.cwd), 200)} is not linked.`,
        notes: [
          `What it posts can't be tied to it. Likely cause: ${s.cause === undefined ? CAUSE.no_helper_call : (CAUSE[s.cause] ?? `the daemon reports ${safeText(s.cause, 60)}`)}.`,
          `Fix: restart the session; if it stays unlinked, start the bus in that folder, or update the daemon (${ctx.busCmd} install)`,
        ],
      });
    if (bad.length > 0)
      out.push({
        level: "info",
        head: "Other causes the daemon can't see: the entry is signed in as a different member than this machine's owner, or CLAUDE_CONFIG_DIR differs between this shell and the chat.",
        notes: [],
      });
    const linked = judged.filter((s) => s.state === "linked").length;
    if (bad.length === 0 && linked > 0)
      out.push({
        level: "pass",
        head: `Claude Code: ${linked === 1 ? "the live session is" : `all ${linked} live sessions are`} linked.`,
        notes: [],
      });
    if (skipped > 0)
      out.push({
        level: "info",
        head: `${skipped === 1 ? "1 live Claude session has" : `${skipped} live Claude sessions have`} no entry for this instance, so ${skipped === 1 ? "it isn't" : "they aren't"} checked.`,
        notes: [],
      });
  }
  const recent: string[] = [];
  for (const u of st?.unbound_proofs ?? [])
    if (ctx.now() - u.at < DAY_MS)
      recent.push(
        `${when(new Date(u.at).toISOString())}: ${UNBOUND[u.cause] ?? `the daemon reports ${safeText(u.cause, 60)}`}`,
      );
  for (const [reason, v] of helperFailures(ctx))
    recent.push(
      `${when(v.at)}: ${UNBOUND[reason] ?? `the helper reports ${safeText(reason, 60)}`}${v.n > 1 ? ` (${v.n} times)` : ""}`,
    );
  if (recent.length > 0)
    out.push({
      level: "info",
      head: "Claude Code: recent helper runs that linked nothing:",
      notes: recent,
    });
  return out;
}

/** The names of the instance's entries that are `sse`: Claude's helper cannot link those. Read-only. */
export function sseEntries(ctx: Ctx, origin: string): string[] {
  const doc = read(claudeConfigFile(ctx.userHome, ctx.env));
  if (!isObj(doc)) return [];
  const names = matching(doc.mcpServers, origin, true);
  if (isObj(doc.projects))
    for (const p of Object.values(doc.projects))
      if (isObj(p)) names.push(...matching(p.mcpServers, origin, true));
  return names;
}

export const sseCheck = (ctx: Ctx, name: string): Line => ({
  level: "warn",
  head: `Claude Code: the ${safeText(name, 80)} entry is an sse entry, which can't be linked.`,
  notes: [`Fix: re-add it with the http type, then run ${ctx.busCmd} install`],
});
