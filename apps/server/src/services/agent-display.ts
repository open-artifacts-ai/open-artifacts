// How a publisher and their agent appear to a viewer. A token (PAT) label is
// the owner's private note ("Only you see it"): everyone but the token's
// owner (the version's createdBy) sees "<owner name>'s agent". A grant's
// client name (for example "Claude Code") is a product and shows as is; a
// grant's owner-set label lives only in agent_grants and never reaches a
// version payload.
import { type AgentRef, stripNameControls } from "@oa/shared";

/** Longest name shown, in code points. */
const NAME_MAX = 80;

/** Strip controls, collapse whitespace, trim. */
const tidyName = (s: string): string =>
  stripNameControls(s).replace(/\s+/g, " ").trim();

/** tidyName, cut to NAME_MAX code points; empty is null. */
export const cleanName = (s: string | null): string | null => {
  if (s === null) return null;
  const cut = [...tidyName(s)].slice(0, NAME_MAX).join("").trim();
  return cut === "" ? null : cut;
};

/**
 * A member's name for other viewers: cleaned, or null when it is an email.
 * Member.name falls back to the email when the user has no real name
 * (effectiveName), and an email never goes out as a name. Checked before the
 * cut, or an email past NAME_MAX would no longer equal itself.
 */
export const publicName = (u: { name: string | null }): string | null => {
  if (u.name === null) return null;
  const whole = tidyName(u.name);
  return whole.includes("@") ? null : cleanName(whole);
};

/** publicName, or "Member" when there is none. */
export const shownName = (u: { name: string | null; email: string }): string =>
  publicName(u) ?? "Member";

/**
 * Whether a version's agent name may be the publisher's private token label,
 * from `versions.agent_via`. Only a grant (`g:`, the client's own name) is
 * public. A token (`t:`) and a NULL via (rows before migration 0012, when a
 * name could be either) are private.
 */
export const isPrivateAgent = (via: string | null): boolean =>
  !via?.startsWith("g:");

/** The stand-in when the publisher has no public name. */
export const MEMBERS_AGENT = "A member's agent";

/**
 * `versions.agent_via` of a row whose private label was overwritten with
 * MEMBERS_AGENT because its publisher's user row was deleted, before removal
 * became soft (#829). created_by there names the instance owner, not the
 * publisher, so nothing may be derived from it. Nothing writes this marker any
 * more, but those rows keep it forever, so this read path stays.
 */
export const SCRUBBED_VIA = "r:";

/** The stand-in for a private label: "<publisher>'s agent", or MEMBERS_AGENT. */
export const ownersAgent = (publisher: {
  name: string | null;
  email: string;
}): string => {
  const name = publicName(publisher);
  return name === null ? MEMBERS_AGENT : `${name}'s agent`;
};

/**
 * The agent as `viewerId` sees it (null: anonymous), from the version's
 * `agent_via`. The publisher (the version's createdBy, who owns the token)
 * sees the label; everyone else sees ownersAgent for a private name. A
 * scrubbed row reads the same for everyone, and createdBy isn't its publisher.
 */
export function agentFor(
  agent: AgentRef,
  via: string | null,
  publisher: { id: string; name: string | null; email: string },
  viewerId: string | null,
): AgentRef {
  if (via === SCRUBBED_VIA) return { ...agent, masked: true };
  if (!isPrivateAgent(via) || viewerId === publisher.id) return agent;
  return { name: ownersAgent(publisher), version: agent.version, masked: true };
}
