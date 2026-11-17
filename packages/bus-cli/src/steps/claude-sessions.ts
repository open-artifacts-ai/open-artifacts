import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusReply } from "@oa/bus-ipc";
import { type Ctx, tilde } from "../context.ts";
import { claudeConfigFile } from "./claude-proof.ts";

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

const CAUSE: Record<string, string> = {
  no_helper_call:
    "its helper never reported to the daemon (the entry has no helper, the entry is an sse one, Claude runs with another CLAUDE_CONFIG_DIR, or the helper could not tell it was under Claude)",
  proof_timed_out:
    "its helper's proof arrived before the session was recorded and expired",
  proof_refused: "the process its helper named did not match this session",
};

const UNBOUND: Record<string, string> = {
  // The daemon's own ring.
  no_live_record: "no live session record appeared for the process in a minute",
  process_mismatch: "the process behind the call did not match the session",
  no_process_start: "the process's start time could not be read",
  // The helper's own log.
  no_claude_ancestor:
    "no Claude process above the helper (a wrapper, an IDE, the SDK, or more than 12 levels)",
  daemon_unreachable: "the daemon did not answer in time, or is not running",
  no_live_record_now: "the daemon knew no live session for the process",
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

/**
 * The checks for the live Claude sessions. `st` is the daemon's status reply
 * (undefined when it is not running). Fails per unlinked session, passes when
 * every live one is linked, and lists recent unbound helper calls.
 */
export function sessionChecks(ctx: Ctx, st: StatusReply | undefined): Line[] {
  const out: Line[] = [];
  if (st === undefined) {
    out.push({
      level: "fail",
      head: "Claude Code: the daemon is down, so no session can link.",
      notes: [`Fix: run ${ctx.busCmd} to start it, then restart the session`],
    });
  } else if (st.claude_sessions === undefined) {
    out.push({
      level: "warn",
      head: "Claude Code: this daemon is too old to say which sessions are linked.",
      notes: [`Fix: run ${ctx.busCmd} install to update it`],
    });
  } else {
    const live = st.claude_sessions;
    const bad = live.filter((s) => s.state === "unlinked");
    for (const s of bad)
      out.push({
        level: "fail",
        head: `Claude Code: the session ${s.name} in ${tilde(ctx, s.cwd)} is not linked.`,
        notes: [
          `What it posts can't be tied to it. Likely cause: ${CAUSE[s.cause ?? "no_helper_call"]}.`,
          `Fix: restart the session; if it stays unlinked, start the bus in that folder, or update the daemon (${ctx.busCmd} install)`,
        ],
      });
    if (bad.length > 0)
      out.push({
        level: "info",
        head: "Other causes the daemon can't see: the entry is signed in as a different member than this machine's owner, or CLAUDE_CONFIG_DIR differs between this shell and the chat.",
        notes: [],
      });
    const linked = live.filter((s) => s.state === "linked").length;
    if (bad.length === 0 && linked > 0)
      out.push({
        level: "pass",
        head: `Claude Code: ${linked === 1 ? "the live session is" : `all ${linked} live sessions are`} linked.`,
        notes: [],
      });
  }
  const recent: string[] = [];
  for (const u of st?.unbound_proofs ?? [])
    recent.push(
      `${when(new Date(u.at).toISOString())}: ${UNBOUND[u.cause] ?? u.cause}`,
    );
  for (const [reason, v] of helperFailures(ctx)) {
    const key = reason === "no_live_record" ? "no_live_record_now" : reason;
    recent.push(
      `${when(v.at)}: ${UNBOUND[key] ?? reason}${v.n > 1 ? ` (${v.n} times)` : ""}`,
    );
  }
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
  let doc: unknown;
  try {
    doc = JSON.parse(
      readFileSync(claudeConfigFile(ctx.userHome, ctx.env), "utf8"),
    );
  } catch {
    return [];
  }
  const names: string[] = [];
  const scan = (servers: unknown) => {
    if (typeof servers !== "object" || servers === null) return;
    for (const [name, e] of Object.entries(servers)) {
      const entry = e as { type?: unknown; url?: unknown };
      if (entry?.type !== "sse" || typeof entry.url !== "string") continue;
      try {
        const u = new URL(entry.url);
        if (u.origin === origin && u.pathname.replace(/\/+$/, "") === "/mcp")
          names.push(name);
      } catch {}
    }
  };
  const d = doc as { mcpServers?: unknown; projects?: Record<string, unknown> };
  scan(d?.mcpServers);
  for (const p of Object.values(d?.projects ?? {}))
    scan((p as { mcpServers?: unknown } | null)?.mcpServers);
  return names;
}

export const sseCheck = (ctx: Ctx, name: string): Line => ({
  level: "warn",
  head: `Claude Code: the ${name} entry is an sse entry, which can't be linked.`,
  notes: [`Fix: re-add it with the http type, then run ${ctx.busCmd} install`],
});
