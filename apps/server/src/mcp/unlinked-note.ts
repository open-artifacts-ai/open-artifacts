// #2688: a plain line on a write's result when the calling agent isn't linked
// to its bus session, so the agent can tell its person (their answers to its
// asks won't reach it, and the page shows it "not linked"). The wording and the
// fix steps are the skill's (skill-template.ts) plus /mcp Reconnect. An agent
// may run `oa-bus doctor` to check, but never runs install or restarts itself:
// those are for its person to do. Fixed words only: no id, hash or name.
import type { UnlinkedWhy } from "../services/agent-usage.js";

const CHECK = "You can run `oa-bus doctor` to check.";
const RECONNECT =
  "reconnect the Open Artifacts connection (in Claude Code: /mcp, then Reconnect)";
/** What an agent asks its person to do: it may check with doctor, but never runs install or restarts itself. */
const FULL_FIX = `${CHECK} Tell your person: ${RECONNECT}. If it stays unlinked, run \`oa-bus install\` again and restart this session.`;
const RETRY = `It may clear on the next write. ${CHECK}`;

/** reason, fix. `no_machine` is silent: that member has never connected a bus machine, so there is nothing to link. */
const TABLE: Record<Exclude<UnlinkedWhy, "no_machine">, [string, string]> = {
  refused: ["the bus declined the Codex link check", CHECK],
  rate_limited: ["the Codex link check reached a bus limit", CHECK],
  no_proof: ["this connection sent no link proof", FULL_FIX],
  unbound: ["no bus session holds this connection's proof", FULL_FIX],
  malformed: ["its link proof was malformed", FULL_FIX],
  other: ["its session isn't ready", FULL_FIX],
  closed: [
    "its bus session is closed",
    `${CHECK} Tell your person: restart this session.`,
  ],
  unlinked: [
    "its bus session has no identity",
    `${CHECK} Tell your person: run \`oa-bus install\` again and restart this session.`,
  ],
  revoked: [
    "this computer's approval was revoked",
    "Tell your person: run `oa-bus install` to approve this computer again, then restart this session.",
  ],
  no_hub: ["the bus couldn't be reached", RETRY],
  timeout: ["the link check timed out", RETRY],
  error: ["the link check failed", RETRY],
};

/** The note for an agent with this `why`, or null (linked, or nothing to link). */
export function unlinkedNote(why: UnlinkedWhy | undefined): string | null {
  if (!why || why === "no_machine") return null;
  const row = TABLE[why];
  if (!row) return null;
  return `This agent isn't linked to its bus session (${row[0]}), so answers to its asks won't reach it. ${row[1]} To see what it missed, call list_comments with answeredSince and compact: true.`;
}
