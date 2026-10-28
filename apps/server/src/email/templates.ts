// Invite/share emails rendered from Design's templates (design/emails/, bundled
// by scripts/emit-email-templates.ts). Every value is untrusted: stripped of
// control characters (CR/LF included) and length-capped everywhere, then
// HTML-escaped for the .html part, so nothing can inject headers or markup.
import type { Format, ShareRole } from "@oa/shared";
import type { SignInProvider } from "../auth/config.js";
import { escapeHtml } from "../mcp/template.js";
import { effectiveName } from "../services/users.js";
import {
  INVITE_HTML,
  INVITE_TXT,
  SHARE_HTML,
  SHARE_TXT,
} from "./email-templates.js";

export type EmailContent = { subject: string; text: string; html: string };

// C0/C1 controls (incl. CR/LF/TAB), line/paragraph separators, bidi controls,
// zero-width characters and BOM.
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]+/g;

/** One plain line: unsafe characters become a space, at most `max` code points. */
export function oneLine(s: string, max: number): string {
  const t = s.replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim();
  const cps = Array.from(t);
  return cps.length <= max ? t : `${cps.slice(0, max - 1).join("")}…`;
}

/**
 * Who sent the invite/share: the member's effective name (see effectiveName),
 * never the bare email local part; else the full email address.
 */
export function senderName(m: { name: string | null; email: string }): string {
  return effectiveName({
    displayName: null,
    name: m.name ?? "",
    email: m.email,
  });
}

const PRODUCT = "Open Artifacts";
const PITCH =
  "a place where any AI agent publishes pages, docs, code and PDFs for your team.";

/** The intro sentence; never "Open Artifacts runs Open Artifacts". */
export function introLine(instanceName: string): string {
  const name = oneLine(instanceName, NAME_MAX);
  return name.toLowerCase() === PRODUCT.toLowerCase()
    ? `${PRODUCT} is ${PITCH}`
    : `${name} runs ${PRODUCT}, ${PITCH}`;
}

const SUBJECT_MAX = 150;
const NAME_MAX = 80;
const TITLE_MAX = 200;
const URL_MAX = 2000;
const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

/**
 * Fills every `{{name}}` with `encode(value)`. Throws on a placeholder without
 * a value or any malformed `{{`, so a template change can't ship unfilled.
 */
export function fill(
  template: string,
  values: Record<string, string>,
  encode: (s: string) => string = (s) => s,
): string {
  const all = template.split("{{").length - 1;
  if ((template.match(PLACEHOLDER) ?? []).length !== all)
    throw new Error("malformed template placeholder");
  return template.replace(PLACEHOLDER, (_, k: string) => {
    const v = values[k];
    if (v === undefined)
      throw new Error(`template placeholder {{${k}}} has no value`);
    return encode(v);
  });
}

/** An absolute https URL on `origin` only. */
const linkOn = (origin: string, path: string): string => {
  const url = new URL(origin + path);
  if (
    !path.startsWith("/") ||
    url.origin !== origin ||
    url.href.length > URL_MAX
  )
    throw new Error("email links must be https on the app host");
  return url.href;
};

const FORMAT_LABEL: Record<Format, string> = {
  html: "HTML page",
  markdown: "Markdown doc",
  code: "Code",
  pdf: "PDF",
};
const ROLE_LABEL: Record<ShareRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
};

const METHOD_PHRASE: Record<SignInProvider, (to: string) => string> = {
  google: () => "your Google account",
  access: () => "your organization's single sign-on",
  email: (to) => `a one-time code sent to ${to}`,
};
const METHOD_ORDER: readonly SignInProvider[] = ["google", "access", "email"];

/**
 * How `to` signs in, from the sign-in methods that can admit that address
 * (services/reach.ts), never a method this install doesn't offer it. Empty:
 * they can't sign in yet and need an invite.
 */
export function signInSentence(
  methods: readonly SignInProvider[],
  to: string,
  p: { instance: string; inviter: string },
): string {
  const parts = METHOD_ORDER.filter((m) => methods.includes(m)).map((m) =>
    METHOD_PHRASE[m](to),
  );
  if (parts.length === 0)
    return `You can't sign in to ${oneLine(p.instance, NAME_MAX)} yet. Ask ${oneLine(p.inviter, NAME_MAX)} to invite you as a member first.`;
  return `You'll sign in with ${parts.join(" or ")}.`;
}

type Common = {
  inviter: string;
  instance: string;
  /** The validated recipient address. */
  recipient: string;
  /** The app host (no scheme); links and the logo point only here. */
  appHost: string;
};

function common(p: Common) {
  const url = new URL(`https://${p.appHost}/`);
  if (url.host !== p.appHost.toLowerCase()) throw new Error("invalid app host");
  const origin = url.origin;
  return {
    origin,
    values: {
      inviterName: oneLine(p.inviter, NAME_MAX),
      instanceName: oneLine(p.instance, NAME_MAX),
      introLine: introLine(p.instance),
      recipientEmail: oneLine(p.recipient, 320),
      appHost: url.host,
      logoUrl: linkOn(origin, "/email/logo@2x.png"),
    },
  };
}

function render(
  html: string,
  txt: string,
  subject: string,
  values: Record<string, string>,
): EmailContent {
  return {
    subject: oneLine(fill(subject, values), SUBJECT_MAX),
    text: fill(txt, values),
    html: fill(html, values, escapeHtml),
  };
}

/** How the recipient can sign in: the methods that admit their address. */
type SignIn = { signIn: readonly SignInProvider[] };

/** A member invite, linking to the instance's sign-in page. */
export function inviteEmail(p: Common & SignIn): EmailContent {
  const { origin, values } = common(p);
  return render(
    INVITE_HTML,
    INVITE_TXT,
    "{{inviterName}} added you to {{instanceName}}",
    {
      ...values,
      signInUrl: linkOn(origin, "/sign-in"),
      signInLine: `There's no password to set up. ${signInSentence(p.signIn, values.recipientEmail, p)}`,
      signInPreheader: signInSentence(p.signIn, "this address", p),
    },
  );
}

/** An artifact shared with a non-member, linking to its viewer URL. */
export function shareEmail(
  p: Common &
    SignIn & {
      title: string;
      /** Viewer path on the app host, e.g. `/a/<id>`. */
      path: string;
      format: Format;
      role: ShareRole;
    },
): EmailContent {
  const { origin, values } = common(p);
  return render(
    SHARE_HTML,
    SHARE_TXT,
    "{{inviterName}} shared “{{artifactTitle}}” with you",
    {
      ...values,
      artifactTitle: oneLine(p.title, TITLE_MAX),
      artifactUrl: linkOn(origin, p.path),
      artifactFormat: FORMAT_LABEL[p.format],
      role: ROLE_LABEL[p.role],
      signInLine: signInSentence(p.signIn, values.recipientEmail, p),
    },
  );
}

const CODE_TXT = `Your {{instanceName}} sign-in code is {{code}}

Enter it on the sign-in page. It expires in {{minutes}} minutes and works once.

If you didn't ask for this, ignore this email: nobody can sign in without the code.

{{appHost}}
`;

const CODE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Sign-in code</title></head>
<body style="margin:0;padding:24px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p>Your {{instanceName}} sign-in code is</p>
<p style="font:600 28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:2px">{{code}}</p>
<p>Enter it on the sign-in page. It expires in {{minutes}} minutes and works once.</p>
<p style="color:#5d636e">If you didn't ask for this, ignore this email: nobody can sign in without the code.</p>
<p style="color:#5d636e">{{appHost}}</p>
</body></html>
`;

/**
 * A sign-in code, shown as "1234 5678" (Design). No link carries the code,
 * and the subject never contains it (subjects show up in notifications).
 */
export function loginCodeEmail(p: {
  code: string;
  instance: string;
  appHost: string;
  minutes: number;
}): EmailContent {
  if (!/^\d{8}$/.test(p.code)) throw new Error("invalid code");
  const url = new URL(`https://${p.appHost}/`);
  if (url.host !== p.appHost.toLowerCase()) throw new Error("invalid app host");
  const values = {
    instanceName: oneLine(p.instance, NAME_MAX),
    code: `${p.code.slice(0, 4)} ${p.code.slice(4)}`,
    minutes: String(p.minutes),
    appHost: url.host,
  };
  return render(
    CODE_HTML,
    CODE_TXT,
    "Your {{instanceName}} sign-in code",
    values,
  );
}

const SPACE_ROLE_LABEL: Record<"viewer" | "editor" | "manager", string> = {
  viewer: "Viewer",
  editor: "Editor",
  manager: "Manager",
};

const SELF_ADD_TXT = `{{adminName}} added themselves to {{spaceName}} on {{instanceName}} as {{role}}.

You get this email because you manage this space. Org admins can join any shared space, and when they do, its managers hear about it.

Review the space's members: {{membersUrl}}

{{appHost}}
`;

const SELF_ADD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Admin joined a space</title></head>
<body style="margin:0;padding:24px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p><strong>{{adminName}}</strong> added themselves to <strong>{{spaceName}}</strong> on {{instanceName}} as {{role}}.</p>
<p>You get this email because you manage this space. Org admins can join any shared space, and when they do, its managers hear about it.</p>
<p><a href="{{membersUrl}}">Review the space's members</a></p>
<p style="color:#5d636e">{{appHost}}</p>
</body></html>
`;

/**
 * To a space's managers when an org admin adds themselves to it (P3 T9,
 * space.admin_self_add). Names only; the link points to the app host.
 */
export function spaceSelfAddEmail(p: {
  admin: string;
  instance: string;
  recipient: string;
  appHost: string;
  space: string;
  role: "viewer" | "editor" | "manager";
}): EmailContent {
  const { origin, values } = common({ ...p, inviter: p.admin });
  return render(
    SELF_ADD_HTML,
    SELF_ADD_TXT,
    "{{adminName}} joined {{spaceName}}",
    {
      ...values,
      adminName: oneLine(p.admin, NAME_MAX),
      spaceName: oneLine(p.space, NAME_MAX),
      role: SPACE_ROLE_LABEL[p.role],
      membersUrl: linkOn(origin, "/settings/spaces"),
    },
  );
}

/** Why the directory alert went out (P3 T13). */
export type DirectoryAlert =
  | "unhealthy"
  | "customer_mismatch"
  | "scope_missing"
  | "break_glass"
  | "disconnected";

const DIRECTORY_ALERT_LINE: Record<DirectoryAlert, string> = {
  unhealthy:
    "Google directory sync has been failing for 24 hours. People keep the access they had at the last successful sync until it recovers.",
  customer_mismatch:
    "Directory sync is paused and people synced from Google can't sign in: the connected Google account belongs to a different Google Workspace than the one this instance was connected to. Sign in with Google and reconnect the directory to restore their access.",
  scope_missing:
    "Google directory sync stopped: a permission it needs was removed. Reconnect the directory and grant every permission.",
  break_glass:
    "Your owner account just opened the directory settings while sync is blocked by a Google Workspace mismatch. Only the directory status, connect and sync pages are open to it until the directory is reconnected. If this wasn't you, secure your Google account and check the audit log.",
  disconnected:
    "Google Workspace was disconnected from this instance, and directory sync has stopped. People synced from Google keep the access they have now. If sync was blocked by a Google Workspace mismatch, they stay blocked until an owner reconnects the directory. If this wasn't expected, check the audit log.",
};

const DIRECTORY_TXT = `{{alertLine}}

You get this email because you own {{instanceName}}.

Open directory settings: {{settingsUrl}}

{{appHost}}
`;

const DIRECTORY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Directory sync needs attention</title></head>
<body style="margin:0;padding:24px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p>{{alertLine}}</p>
<p>You get this email because you own {{instanceName}}.</p>
<p><a href="{{settingsUrl}}">Open directory settings</a></p>
<p style="color:#5d636e">{{appHost}}</p>
</body></html>
`;

/** To the org owners when directory sync needs them (P3 T13). */
export function directoryAlertEmail(p: {
  instance: string;
  recipient: string;
  appHost: string;
  why: DirectoryAlert;
}): EmailContent {
  const { origin, values } = common({ ...p, inviter: p.instance });
  return render(
    DIRECTORY_HTML,
    DIRECTORY_TXT,
    "Directory sync needs attention on {{instanceName}}",
    {
      ...values,
      alertLine: DIRECTORY_ALERT_LINE[p.why],
      settingsUrl: linkOn(origin, "/settings/directory"),
    },
  );
}
