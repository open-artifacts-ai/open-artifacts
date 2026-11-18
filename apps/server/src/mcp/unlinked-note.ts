// #2688: a plain line on a write's result when the calling agent isn't linked
// to its bus session, so the agent can tell its person (their answers to its
// asks won't reach it, and the page shows it "not linked"). The wording and the
// fix steps are the skill's (skill-template.ts: run the bus's `doctor`, run
// `install` again, restart the session) plus /mcp Reconnect for a connection
// the bus never saw. Fixed words only: no id, hash or name, whatever the cause.
import type { UnlinkedWhy } from "../services/agent-usage.js";

const RECONNECT = "Run /mcp Reconnect.";
const DOCTOR = "run the bus's `doctor` (`oa-bus doctor`)";
const INSTALL = "run the bus's `install` again, then restart your session";

/** reason, fix. `no_machine` is silent: that member has never connected a bus machine, so there is nothing to link. */
const TABLE: Record<Exclude<UnlinkedWhy, "no_machine">, [string, string]> = {
  no_proof: [
    "this connection sent no link proof",
    `${RECONNECT} If it stays unlinked, ${DOCTOR}, then ${INSTALL}.`,
  ],
  unbound: [
    "no bus session holds this connection's proof",
    `${RECONNECT} If it stays unlinked, ${DOCTOR}, then ${INSTALL}.`,
  ],
  closed: [
    "its bus session is closed",
    `Restart your session, then ${DOCTOR}.`,
  ],
  unlinked: [
    "its bus session has no identity",
    `${DOCTOR.charAt(0).toUpperCase()}${DOCTOR.slice(1)}, then ${INSTALL}.`,
  ],
  revoked: [
    "its machine was revoked",
    "Approve the machine again in the bus, then restart your session.",
  ],
  malformed: [
    "its link proof was malformed",
    `${RECONNECT} If it stays unlinked, ${DOCTOR}.`,
  ],
  no_hub: [
    "the bus couldn't be reached",
    `Try again shortly. If it stays unlinked, ${DOCTOR}.`,
  ],
  timeout: [
    "the link check timed out",
    `Try again shortly. If it stays unlinked, ${DOCTOR}.`,
  ],
  error: [
    "the link check failed",
    `Try again shortly. If it stays unlinked, ${DOCTOR}.`,
  ],
  other: [
    "its session isn't ready",
    `${RECONNECT} If it stays unlinked, ${DOCTOR}.`,
  ],
};

/** The note for an agent with this `why`, or null (linked, or nothing to link). */
export function unlinkedNote(why: UnlinkedWhy | undefined): string | null {
  if (!why || why === "no_machine") return null;
  const row = TABLE[why];
  if (!row) return null;
  return `This agent isn't linked to your account (${row[0]}). ${row[1]}`;
}
