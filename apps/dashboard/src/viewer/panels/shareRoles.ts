import type { ShareResult, ShareRole } from "@oa/shared";

/** Why a saved share sent no email (ShareResult.notEmailed, with #2649's "skipped"). */
export type NotEmailed = NonNullable<ShareResult["notEmailed"]>;

/** OA Product (#2620): over today's limits for new outside addresses; the link to copy stays. */
/** The member limit when the server doesn't say (#2620's figure). */
export const MEMBER_LIMIT_FALLBACK = 20;
export const memberLimitLine = (org: string, limit = MEMBER_LIMIT_FALLBACK) =>
  `We didn't email them: you've reached today's limit of ${limit} new people outside ${org}. Copy the link and send it yourself.`;
export const instanceLimitLine = (org: string) =>
  `We didn't email them: ${org} has reached today's limit for new people outside. Copy the link and send it yourself.`;
/**
 * OA Product: the generic `limit` (a recipient, share or sending cap we can't
 * tell apart), and #2649's `skipped`, whose reason is private: never say why.
 */
export const LIMIT_LINE =
  "We didn't email them this time. Copy the link and send it yourself.";
/**
 * OA Product (#2741): the sharer's own pause, from #2662's sender_paused and
 * pausedUntil. Never names the recipient: the pause is about their emails.
 */
const SENDER_PAUSED_WHY =
  "because some earlier ones bounced or were reported. Copy the link and send it yourself.";

/**
 * The pause's last day as OA Product writes it ("18 Nov"); null when unknown.
 * UTC, so the day is the one the server's pause ends on and the same line
 * everywhere: it is a day, not an hour, and the pause itself ends when it ends.
 */
export function pausedOn(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d);
}

export function senderPausedLine(org: string, pausedUntil?: string): string {
  const until = pausedOn(pausedUntil);
  return `We didn't email them. Your share emails to people outside ${org} are paused ${until ? `until ${until}` : "for now"}, ${SENDER_PAUSED_WHY}`;
}

/** The line for a share that sent no email, by the server's reason. */
export function notEmailedLine(
  reason: NotEmailed,
  org: string,
  limit?: number,
  pausedUntil?: string,
): string {
  if (reason === "member_limit") return memberLimitLine(org, limit);
  if (reason === "instance_limit") return instanceLimitLine(org);
  if (reason === "sender_paused") return senderPausedLine(org, pausedUntil);
  // "limit" and "skipped": the neutral line.
  return LIMIT_LINE;
}

/** OA Product (#2590): the note for a workspace_only share. */
export const workspaceOnlyNote = (email: string) =>
  `${email} can open this only if that address is a Google account. If it isn't, share with their Gmail or Google Workspace address.`;
/** OA Product (#2590): what owners and admins also see; "Settings, Login" links there. */
export const WORKSPACE_ONLY_ADMIN = {
  before: "Or turn on login codes in ",
  link: "Settings, Login",
  after: ".",
};

export const shareRoles: readonly ShareRole[] = [
  "viewer",
  "commenter",
  "editor",
];

/** Whether to show the outside-address sign-in note; null until known. */
export function outsideAddress(
  email: string,
  domains: readonly string[],
  members: ReadonlySet<string> | null,
): boolean | null {
  const e = email.trim().toLowerCase();
  const at = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(e)?.[1];
  if (!at) return null;
  if (domains.length) return !domains.some((d) => d.toLowerCase() === at);
  if (!members) return null;
  return !members.has(e);
}

/**
 * OA Product (#2590, the issue's Strings): the line under an outside
 * address, by how they can log in here. Null when nothing admits them (the
 * warning after saving says why).
 */
export function outsideLine(
  name: string,
  methods: { google: boolean; codes: boolean },
): string | null {
  if (methods.google && methods.codes)
    return `Outside your team. ${name} opens this page with their Google account or a code we email them. They see only what you share. Free.`;
  if (methods.google)
    return `Outside your team. ${name} opens this page with their Google account. They see only what you share. Free.`;
  if (methods.codes)
    return `Outside your team. ${name} opens this page with a code we email them. They see only what you share. Free.`;
  return null;
}
