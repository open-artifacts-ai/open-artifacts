// #2520: Design's copy for Settings > Login, the domain dialogs, the invite
// dialog's rows and the first-invite step, in one place. No server text.
import type { ReachRow } from "../api/loginSettings";

export const LOGIN = {
  methodsTitle: "How people log in",
  methodsSub: (instance: string) =>
    `Everyone who can get in may use either. These were set when ${instance} was created.`,
  google: "Google",
  googleLine: '"Continue with Google", with a work or personal Google account.',
  email: "Email code",
  emailLine:
    "A six-digit code sent to their address. For people without a Google account.",
  methodsNote:
    "Shown so you know what your people will see. Changing them is not part of this first version.",

  whoTitle: "Who can get in",
  whoSub: "Two ways in. They work together.",
  invited: "People you invite",
  invitedLine:
    "Any address, at any company. Only that exact address gets in, with its own Google account or an email code. Remove them in Members and both stop working.",
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
  body: (d: string, joined: number) =>
    [
      `New people at ${d} will need an invite.`,
      joined === 1
        ? "The 1 member who already joined keeps their access."
        : joined > 1
          ? `The ${joined} members who already joined keep their access.`
          : null,
      "Remove anyone in Members.",
    ]
      .filter(Boolean)
      .join(" "),
  confirm: "Turn off",
} as const;

export const INVITE = {
  header:
    "They get an email with a link. Only the addresses you list can use it. An invite lasts 30 days.",
  joinAs: "Join as",
  joinAsLine:
    "Members see team pages and can publish. Choose Guest to share single pages only.",
  send: (n: number) => (n === 1 ? "Send 1 invite" : `Send ${n} invites`),
  sent: (n: number) => (n === 1 ? "1 invite sent" : `${n} invites sent`),
  cantPill: "can't log in",
  removedPill: "removed",
  remove: (email: string) => `Remove ${email}`,
} as const;

const KIND_LINE: Record<ReachRow["kind"], string> = {
  domain: "At your domain. Logs in with Google or an email code.",
  outside:
    "Outside your domain. Logs in with their own Google account or an email code.",
  gmail: "Logs in with Google or an email code.",
  code_first:
    "Logs in with an email code the first time. After that, Google works too if they have an account for this address.",
};

export const CODES_OFF_LINE =
  "Can't get in yet: this address needs an email code the first time, and email codes are off. Turn on email codes in Login, or use another address.";

/** "Nov 12": the day a member was removed. */
const removedDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The line under an address in the invite dialog. */
export const reachLine = (r: ReachRow) =>
  r.blocked === "codes_off"
    ? CODES_OFF_LINE
    : r.removed
      ? `Removed on ${removedDay(r.removed.at)}. Inviting them again lets them back in.`
      : KIND_LINE[r.kind];

export const FIRST_INVITE = {
  title: (instance: string) => `Who should be able to join ${instance}?`,
  sub: "You can change this any time in Settings, Login.",
  only: "Only people I invite",
  onlyLine: "You add addresses, from any company. Nobody else gets in.",
  domain: (d: string) => `Anyone at ${d}, and people I invite`,
  domainLine:
    "Colleagues join as members by logging in with Google. You log in again to confirm, and you are told each time someone joins.",
  noDomain: "Anyone at my company's domain",
  noDomainLine: "Needs a company address. You log in with Gmail.",
  skip: "Skip for now",
  next: "Continue",
} as const;
