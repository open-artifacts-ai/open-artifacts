// How a publisher and their agent appear to a viewer. A token (PAT) label is
// the owner's private note ("Only you see it"): everyone but the token's
// owner (the version's createdBy) sees "<owner name>'s agent". A grant's
// client name (for example "Claude Code") is a product and shows as is; a
// grant's owner-set label lives only in agent_grants and never reaches a
// version payload.
import { type AgentRef, stripNameControls } from "@oa/shared";

/** Longest name shown, in code points. */
const NAME_MAX = 80;

/** Strip controls, trim, collapse whitespace, cut to NAME_MAX code points; empty is null. */
export const cleanName = (s: string | null): string | null => {
  if (s === null) return null;
  const t = stripNameControls(s).replace(/\s+/g, " ").trim();
  const cut = [...t].slice(0, NAME_MAX).join("").trim();
  return cut === "" ? null : cut;
};

/**
 * A member's name for other viewers: cleaned, then null when it is the email
 * (any case). Member.name falls back to the email when the user has no real
 * name (effectiveName), and an email never goes out as a name.
 */
export const publicName = (u: {
  name: string | null;
  email: string;
}): string | null => {
  const n = cleanName(u.name);
  return n !== null && n.toLowerCase() === u.email.toLowerCase() ? null : n;
};

/** publicName, or "Member" when there is none. */
export const shownName = (u: { name: string | null; email: string }): string =>
  publicName(u) ?? "Member";

/**
 * Whether a version's agent name is the publisher's private token label, from
 * `versions.agent_via` and `agent_version`. `t:` (token): yes. `g:` (grant):
 * no, it is the client's name. NULL (rows before migration 0012): a PAT never
 * had a version and an OAuth client usually reports one, so a name with a
 * version is a client's and one without may be a label (private).
 */
export function isPrivateAgent(
  via: string | null,
  version: string | null,
): boolean {
  if (via?.startsWith("g:")) return false;
  if (via?.startsWith("t:")) return true;
  return version === null;
}

/** The stand-in for a private label: "<publisher>'s agent". */
export const ownersAgent = (publisher: {
  name: string | null;
  email: string;
}): string => `${shownName(publisher)}'s agent`;

/**
 * The agent as `viewerId` sees it (null: anonymous). The publisher (the
 * version's createdBy, who owns the token) sees the label; everyone else
 * sees ownersAgent for a private name.
 */
export function agentFor(
  agent: AgentRef,
  isPrivate: boolean,
  publisher: { id: string; name: string | null; email: string },
  viewerId: string | null,
): AgentRef {
  if (!isPrivate || viewerId === publisher.id) return agent;
  return { name: ownersAgent(publisher), version: agent.version };
}
