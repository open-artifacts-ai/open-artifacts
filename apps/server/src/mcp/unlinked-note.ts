// #2688: a plain line on a write's result when the calling agent isn't linked
// to its bus session, so the agent can tell its person (their answers to its
// asks won't reach it, and the page shows it "not linked"). The wording and the
// fix steps are the skill's (skill-template.ts) plus /mcp Reconnect. An agent
// may run `oa-bus doctor` to check, but never runs install or restarts itself:
// those are for its person to do. Fixed words only: no id, hash or name.
import type { UnlinkedWhy } from "../services/agent-usage.js";

const CHECK = "You can run `oa-bus doctor` to check.";
/** The fix an agent can only ask its person to do: it never runs install or restarts itself. */
const FULL_FIX = `${CHECK} Tell your person: run /mcp Reconnect; if it stays unlinked, run the bus's install again and restart the session.`;
const RETRY = "Try again shortly. If it stays unlinked, run `oa-bus doctor`.";

/** reason, fix. `no_machine` is silent: that member has never connected a bus machine, so there is nothing to link. */
const TABLE: Record<Exclude<UnlinkedWhy, "no_machine">, [string, string]> = {
  no_proof: ["this connection sent no link proof", FULL_FIX],
  unbound: ["no bus session holds this connection's proof", FULL_FIX],
  malformed: ["its link proof was malformed", FULL_FIX],
  other: ["its session isn't ready", FULL_FIX],
  closed: [
    "its bus session is closed",
    "Tell your person: restart the session.",
  ],
  unlinked: [
    "its bus session has no identity",
    `${CHECK} Tell your person: run the bus's install again and restart the session.`,
  ],
  revoked: [
    "its machine was revoked",
    "Tell your person: approve this machine again in the bus, then restart the session.",
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
  return `This agent isn't linked to your account (${row[0]}). ${row[1]}`;
}
