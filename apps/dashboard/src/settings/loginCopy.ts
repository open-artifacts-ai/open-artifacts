// #2520: Design's copy for Settings > Login, the domain dialogs, the invite
// dialog's rows and the first-invite step, in one place. No server text.
import type { LoginWay } from "../api/loginSettings";

type Methods = { google: boolean; email: boolean };

export const LOGIN = {
  methodsTitle: "How people log in",
  /** Names only the methods that are on (Design). */
  methodsSub: (instance: string, m: Methods) =>
    `${
      m.google && m.email
        ? "Everyone who can get in may use either."
        : m.google
          ? "Everyone who can get in uses Google."
          : "Everyone who can get in uses an email code."
    } These were set when ${instance} was created.`,
  google: "Google",
  googleLine: '"Continue with Google", with a work or personal Google account.',
  email: "Email code",
  emailLine:
    "A six-digit code sent to their address. For people without a Google account.",
  methodsNote:
    "Shown so you know what your people will see. They can't be changed here yet.",

  whoTitle: "Who can get in",
  whoSub: "Two ways in. They work together.",
  invited: "People you invite",
  invitedLine: (m: Methods) =>
    m.google && m.email
      ? "Any address, at any company. Only that exact address gets in, with its own Google account or an email code. Remove them in Members and both stop working."
      : m.google
        ? "Any address, at any company. Only that exact address gets in, with its own Google account. Remove them in Members and it stops working."
        : "Any address, at any company. Only that exact address gets in, with an email code sent to it. Remove them in Members and it stops working.",
  domain: "Anyone at your domain",
  domainLine:
    "Anyone who logs in with Google from your domain joins as a member, with no invite.",
  domainFrom: "Your own Google Workspace domain, taken from your login.",
  domainOff: "Off. Only people you invite can get in.",
  unavailable:
    "Not available: you log in with a Gmail address, so there is no company domain. Invite people by address instead.",
  selfHosted: "Set by whoever runs this server.",
  selfHostedChange: "Change it with",
  selfHostedFlag: "--auth-domains",
  selfHostedAt: "at setup.",
  selfHostedHow: "How",

  rolesTitle: "Members and guests",
  member: "Member",
  memberLine:
    "Part of the team. Sees its spaces and can publish. Joins by your domain, or by an invite.",
  guest: "Guest",
  guestLine:
    "Sees only the pages shared with them, and can comment there. Free. Becomes a guest when you share a page with their address.",

  pillOn: "on",
  pillOff: "off",
  pillAlways: "always on",
  pillSetup: "set at setup",
} as const;

/** Where `--auth-domains` is explained. */
export const AUTH_DOMAINS_DOC =
  "https://open-artifacts.com/docs/setup/#setup-flags";

export const DOMAIN_ON = {
  title: (d: string) => `Let anyone at ${d} join?`,
  body: (d: string) =>
    `Anyone with an ${d} Google account can log in and becomes a member, without an invite. You are told each time someone joins. You can turn this off at any time.`,
  warn: "Anyone in this Google Workspace can join. At a university or a shared mail provider, that can be many people.",
  again: "You will log in again to confirm it is you.",
  confirm: "Log in again and turn on",
} as const;

export const DOMAIN_OFF = {
  title: (d: string) => `Stop letting ${d} join by itself?`,
  /** `joined`: 0 leaves the sentence out; 1 is singular. */
  body: (d: string, joined: number) =>
    [
      `New people at ${d} will need an invite.`,
      joined === 1
        ? "The 1 member who already joined keeps their access."
        : joined
          ? `The ${joined} members who already joined keep their access.`
          : null,
      "Remove anyone in Members.",
    ]
      .filter(Boolean)
      .join(" "),
  confirm: "Turn off",
} as const;

/** apply_pending: a hosted instance applies the change in about a minute. */
export const SAVE = {
  pending: "Saving. This takes about a minute.",
  saved: "Saved.",
  failed: "Couldn't save. Try again.",
  /** 409 apply_pending: refused, an earlier change is still applying (Product, #2537). */
  busy: "An earlier change is still being saved. Try again in a minute.",
  /** domain_unproven, with the domain the server named (or the owner's). */
  unproven: (d: string) =>
    `We couldn't confirm that ${d} is your Google Workspace domain. Log in with your ${d} work account and try again.`,
  /** domain_unproven for a personal account (provable null). */
  personal:
    "This works with a Google Workspace account. You can still invite people one by one.",
} as const;

/** The line under the switch (or the step) for a save's state; null for none. */
export const saveLine = (
  state: string,
  unproven: string | null,
  provable: string | null,
): { text: string; error: boolean } | null => {
  if (state === "pending") return { text: SAVE.pending, error: false };
  if (state === "saved") return { text: SAVE.saved, error: false };
  if (state === "failed") return { text: SAVE.failed, error: true };
  if (state === "busy_elsewhere") return { text: SAVE.busy, error: true };
  if (state !== "unproven") return null;
  const d = provable === null ? null : (unproven ?? provable);
  return { text: d ? SAVE.unproven(d) : SAVE.personal, error: true };
};

export const INVITE = {
  title: "Invite people",
  button: "Invite people",
  header:
    "They get an email with a link. Only the addresses you list can use it. An invite lasts 30 days.",
  noEmail:
    "Open Artifacts doesn't send invitations. Add their email here, then send them the login link yourself.",
  lasts: "An invite lasts 30 days.",
  joinAs: "Join as",
  joinAsLine:
    "Members see team pages and can publish. Choose Guest to share single pages only.",
  adminLater: "You can make a member an admin after they join.",
  send: (n: number) => (n === 1 ? "Send 1 invite" : `Send ${n} invites`),
  sent: (n: number) => (n === 1 ? "1 invite sent" : `${n} invites sent`),
  cantPill: "can't log in",
  removedPill: "removed",
  remove: (email: string) => `Remove ${email}`,
} as const;

export const CANT_LINE =
  "Can't log in here yet. Their Google account must be Gmail or Google Workspace.";
export const WORKSPACE_ONLY_LINE =
  "Logs in with Google, if their address is a Google Workspace account. Otherwise they can't log in while email codes are off.";

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/**
 * The line under an address, from the server's ways (OA Backend's mapping):
 * null for a mix the draft doesn't produce.
 */
/** "Nov 12": the day a member was removed. */
const removedDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const removedLine = (at: string) =>
  `Removed on ${removedDay(at)}. Inviting them again lets them back in.`;

export const reachLine = (email: string, ways: readonly LoginWay[]) => {
  if (ways.length === 0) return CANT_LINE;
  const code = ways.includes("email_code");
  if (ways.includes("google")) {
    const gmail = GMAIL.has(email.slice(email.lastIndexOf("@") + 1));
    const how = code ? "Google or an email code" : "Google";
    return gmail
      ? `Logs in with ${how}.`
      : `At your domain. Logs in with ${how}.`;
  }
  if (ways.includes("google_workspace"))
    return ways.includes("google_after_code")
      ? "Outside your domain. Logs in with their own Google account or an email code."
      : WORKSPACE_ONLY_LINE;
  return null;
};

export const FIRST_INVITE = {
  title: (instance: string) => `Who should be able to join ${instance}?`,
  sub: "You can change this any time in Settings, Login.",
  only: "Only people I invite",
  onlyLine: "You add addresses, from any company. Nobody else gets in.",
  domain: (d: string) => `Anyone at ${d}, and people I invite`,
  domainLine:
    "Colleagues join as members by logging in with Google. You log in again to confirm, and you are told each time someone joins.",
  skip: "Skip for now",
  next: "Continue",
} as const;
