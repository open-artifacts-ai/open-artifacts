/**
 * Operator alerts by email (design v7 5.8; the open, remind and clear
 * machine is a tree port of #859's apps/scheduler/src/alerts.ts). The
 * scheduler is the only alert opener. Each key in ALERT_KEYS opens, may
 * remind while open, and clears; each change is one log line, and each email
 * is plain text to ALERT_TO through the send_email binding ALERT_EMAIL.
 *
 * State lives in platform D1 `platform_state` (0006), per key:
 * - `<key>_opened_at`: set while open.
 * - `<key>_notified_at`: the last open or reminder email claimed. It
 *   survives a clear, so a per-key minimum interval holds across reopens
 *   (signin_refused_burst: one email per hour at most).
 * - `<key>_cleared_at`: a clear email is owed.
 * - `<key>_sending_at`: an open or reminder email in flight. notified_at
 *   moves only once the send succeeded, so a tick that ends mid-send (the
 *   duty's budget, an eviction) never marks an email it did not send; a
 *   marker older than the send timeout is taken over (C5's
 *   ALERT_STATE_SUFFIXES; not in 0006's key list).
 * Keys are alertStateKey(key, suffix).
 * Every claim is one conditional write, so overlapping ticks send once. A
 * failed send gives its claim back, so the next tick retries it.
 *
 * Emails carry a fixed subject per key and state, and text built from
 * counts, windows, install ids, job ids, job kinds and enum codes, plus
 * the latest prod-clean report's detail cut to plain characters (design
 * v7 6): never AlertRow.message, an email address or a URL. Logs carry the key and
 * fixed categories only. stepAlert never throws.
 */
import { isInstallId } from "@oa/provision/names";
import {
  ALERT_LOOKBACK_MS,
  type AlertRow,
  JOB_RETRYING_ATTEMPT,
  JOB_STUCK_MS,
  OAUTH_REGISTER_FLOOD,
  PURGE_STUCK_FAILURES,
  SIGNIN_BURST_MIN,
  SIGNIN_BURST_WINDOW_MS,
  WELCOME_CLAIM_MS,
} from "@oa/shared/provisioning/alerts";
import {
  ALERT_KEYS,
  type AlertKey,
  JOB_KINDS,
} from "@oa/shared/provisioning/enums";
import { alertStateKey } from "@oa/shared/provisioning/state";
import { TOKEN_EXPIRING_DAYS, ULID_RE } from "./contract.js";
import type { ProvapiEnv } from "./env.js";
import { claimState, getState, raiseState, unclaimState } from "./state.js";

export type AlertState = "open" | "remind" | "clear";

export interface AlertPolicy {
  /** No open email within this long of the last email, across reopens. */
  minIntervalMs: number;
  /** A reminder this long after the last email while open; null: none. */
  remindMs: number | null;
  /** A clear email when it closes (only if its open email went out). */
  clearEmail: boolean;
}

export const ALERT_REMIND_MS = 24 * 60 * 60_000;
/** signin_refused_burst: at most one email per hour (design v7 4.8). */
export const BURST_EMAIL_INTERVAL_MS = 60 * 60_000;
/** A send that hasn't settled by then counts as failed (and is retried). */
export const ALERT_SEND_TIMEOUT_MS = 5_000;

/**
 * TODO(contract): the design sets only the burst's policy. The other keys
 * take #859's default (open email, a reminder a day, clear email) until the
 * Manager decides.
 */
const DEFAULT_POLICY: AlertPolicy = {
  minIntervalMs: 0,
  remindMs: ALERT_REMIND_MS,
  clearEmail: true,
};
const BURST_POLICY: AlertPolicy = {
  minIntervalMs: BURST_EMAIL_INTERVAL_MS,
  remindMs: null,
  clearEmail: false,
};
export const ALERT_POLICY: Readonly<Record<AlertKey, AlertPolicy>> =
  Object.freeze(
    Object.fromEntries(
      ALERT_KEYS.map((k) => [
        k,
        k === "signin_refused_burst" ? BURST_POLICY : DEFAULT_POLICY,
      ]),
    ) as Record<AlertKey, AlertPolicy>,
  );

export interface Alert {
  key: AlertKey;
  subject: Record<AlertState, string>;
  /** The email's text; `at` is when it opened, or for "clear", cleared. */
  text: (state: AlertState, at: number) => string;
}

// One plain addr-spec, as apps/server's sender checks: never a list or a
// display name.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const SEND_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const OPEN =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING RETURNING value";
// The clear email is owed only if this episode's open email went out
// (notified at or after opened).
const OWE_CLEAR =
  "INSERT INTO platform_state (key, value, updated_at) SELECT ?1, ?2, ?2 WHERE EXISTS (SELECT 1 FROM platform_state o JOIN platform_state n ON n.key = ?4 WHERE o.key = ?3 AND n.value >= o.value) ON CONFLICT (key) DO NOTHING";
const DELETE = "DELETE FROM platform_state WHERE key = ?1 RETURNING value";
const OWE =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";

class SendTimeout extends Error {}

/** A short category for logs; never the message. */
function sendCategory(e: unknown): string {
  if (e instanceof SendTimeout) return "timeout";
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && SEND_CODE.test(code) ? code : "send_error";
}

/**
 * True when the email went out. False on a failed send or with no
 * destination (logged), so the caller gives its claim back and the email
 * goes out once the destination is configured.
 */
async function send(
  env: ProvapiEnv,
  alert: Alert,
  state: AlertState,
  at: number,
  timeoutMs: number,
): Promise<boolean> {
  const to = env.ALERT_TO ?? "";
  const from = env.ALERT_FROM ?? "";
  if (!env.ALERT_EMAIL || !ADDRESS.test(to) || !ADDRESS.test(from)) {
    console.log("provapi alert", alert.key, "skipped no_destination");
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.ALERT_EMAIL.send({
        from,
        to,
        subject: alert.subject[state],
        text: alert.text(state, at),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SendTimeout()), timeoutMs);
      }),
    ]);
    console.log("provapi alert", alert.key, "sent", state);
    return true;
  } catch (e) {
    console.error("provapi alert", alert.key, "send_failed", sendCategory(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface StepOptions {
  /** Tests only: the send timeout (default ALERT_SEND_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * One step of an alert. `condition` true opens it (if closed), false clears
 * it (if open), null leaves it as it is. Then any owed email goes out: a
 * clear, the open email, or a reminder, as ALERT_POLICY allows. Never
 * throws: a D1 error is the fixed line `provapi alert <key> db_error`.
 */
export async function stepAlert(
  env: ProvapiEnv,
  alert: Alert,
  condition: boolean | null,
  now: number,
  { timeoutMs = ALERT_SEND_TIMEOUT_MS }: StepOptions = {},
): Promise<void> {
  const policy = ALERT_POLICY[alert.key];
  const opened = alertStateKey(alert.key, "opened_at");
  const notified = alertStateKey(alert.key, "notified_at");
  const cleared = alertStateKey(alert.key, "cleared_at");
  const sending = alertStateKey(alert.key, "sending_at");
  const db = env.PLATFORM_DB;
  try {
    if (condition === true) {
      if (await db.prepare(OPEN).bind(opened, now).first())
        console.log("provapi alert", alert.key, "opened");
    } else if (condition === false) {
      // One transaction: the clear email is owed (if it was heard open),
      // then the alert closes. Only one overlapping tick sees the row go.
      const owe = db.prepare(OWE_CLEAR).bind(cleared, now, opened, notified);
      const close = db.prepare(DELETE).bind(opened);
      const res = await db.batch(policy.clearEmail ? [owe, close] : [close]);
      if (res.at(-1)?.results.length)
        console.log("provapi alert", alert.key, "cleared");
    }

    // An owed clear goes first, so a reopen's email follows it.
    const owed = await db.prepare(DELETE).bind(cleared).first<{
      value: number;
    }>();
    if (owed && !(await send(env, alert, "clear", owed.value, timeoutMs)))
      await db.prepare(OWE).bind(cleared, owed.value).run();

    const open = await getState(db, opened);
    if (open === null) return;
    const prev = await getState(db, notified);
    // Notified at or after this episode opened: the open email went out.
    const state: AlertState = prev !== null && prev >= open ? "remind" : "open";
    if (state === "remind" && policy.remindMs === null) return;
    const cutoff =
      now - (state === "open" ? policy.minIntervalMs : (policy.remindMs ?? 0));
    if (prev !== null && prev > cutoff) return;
    // Phase 1: the in-flight marker. Of overlapping ticks only one holds
    // it; one left by a tick that ended mid-send is stale after the timeout.
    if (!(await claimState(db, sending, now, now - timeoutMs))) return;
    try {
      // Another tick may have sent between the read and the claim.
      if ((await getState(db, notified)) !== prev) return;
      // Phase 2: notified moves only once the email went out.
      if (await send(env, alert, state, open, timeoutMs))
        await raiseState(db, notified, now);
    } finally {
      await unclaimState(db, sending, now, null);
    }
  } catch {
    console.error("provapi alert", alert.key, "db_error");
  }
}

// ---------- Email text ----------

/** What an email may say about an alert: counts and ids, never free text. */
export interface AlertFacts {
  count: number;
  installIds: string[];
  jobs: { id: string; kind: string | null; code: string | null }[];
  codes: string[];
  /** token_expiring: whole days left. */
  daysLeft?: number;
  /** prodclean_failed: the latest report's install id and detail, sanitized. */
  report?: ProdcleanReport;
}

export interface ProdcleanReport {
  installId: string | null;
  detail: string | null;
}

/** At most this many characters of a prod-clean report's detail. */
export const REPORT_DETAIL_MAX = 200;
// First, whole tokens that are an email address, a URL, or an IPv4 or IPv6
// address become REDACTED. Then only letters, digits and plain punctuation
// are kept; everything else (control characters, '@', '/', quotes,
// non-ASCII) becomes a space, so no line break reaches the email.
const REDACTED = "(redacted)";
const DETAIL_REDACT = [
  /\S*@\S*/g,
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g,
  /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g,
  /(?<![\w:])(?=[0-9A-Fa-f:]*::|(?:[0-9A-Fa-f]{1,4}:){2,})[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])/g,
];
const DETAIL_DROP = /[^A-Za-z0-9 _.,:;=()+-]+/g;

/** A report detail for an email: addresses redacted, allowed characters only, capped. */
export function cleanDetail(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const r = DETAIL_REDACT.reduce((s, re) => s.replace(re, REDACTED), d);
  const s = r.replace(DETAIL_DROP, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > REPORT_DETAIL_MAX
    ? `${s.slice(0, REPORT_DETAIL_MAX).trimEnd()} (cut)`
    : s;
}

const LATEST_REPORT =
  "SELECT install_id, detail FROM prodclean_reports WHERE id = (SELECT MAX(id) FROM prodclean_reports)";

/**
 * The latest prod-clean report's details (design v7 6: the monitor's output
 * says pass or fail only; details go to inventory, then this email). A D1
 * error is one fixed line and no details.
 */
export async function prodcleanReport(
  db: D1Database,
): Promise<ProdcleanReport | undefined> {
  try {
    const r = await db
      .prepare(LATEST_REPORT)
      .first<{ install_id: unknown; detail: unknown }>();
    if (!r) return undefined;
    return {
      installId:
        typeof r.install_id === "string" && isInstallId(r.install_id)
          ? r.install_id
          : null,
      detail: cleanDetail(r.detail),
    };
  } catch {
    console.error("provapi alert prodclean_failed report_error");
    return undefined;
  }
}

/** At most this many ids per email. */
export const IDS_SHOWN = 20;
const CODE = /^[a-z][a-z0-9_.]{0,63}$/;

const code = (c: unknown) =>
  typeof c === "string" && CODE.test(c) ? c : c == null ? null : "other";

/** Facts from condition rows: ids and codes only, each checked. */
export function factsOf(rows: readonly AlertRow[]): AlertFacts {
  const installIds = new Set<string>();
  const codes = new Set<string>();
  const jobs: AlertFacts["jobs"] = [];
  for (const r of rows) {
    if (typeof r.install_id === "string" && isInstallId(r.install_id))
      installIds.add(r.install_id);
    const c = code(r.code);
    if (c) codes.add(c);
    if (typeof r.job_id === "string" && ULID_RE.test(r.job_id))
      jobs.push({
        id: r.job_id,
        kind: (JOB_KINDS as readonly unknown[]).includes(r.job_kind)
          ? (r.job_kind as string)
          : null,
        code: c,
      });
  }
  return {
    count: rows.length,
    installIds: [...installIds],
    jobs,
    codes: [...codes],
  };
}

const iso = (t: number) => new Date(t).toISOString();
const mins = (ms: number) => Math.round(ms / 60_000);
const hours = (ms: number) => Math.round(ms / 3_600_000);
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function more(total: number, shown: number): string {
  return total > shown ? `and ${total - shown} more\n` : "";
}

function idLines(f: AlertFacts): string {
  const out: string[] = [];
  if (f.jobs.length) {
    const shown = f.jobs.slice(0, IDS_SHOWN);
    out.push(
      `\nJobs (id, kind, code):\n${shown
        .map((j) => `${j.id} ${j.kind ?? "-"} ${j.code ?? "-"}`)
        .join("\n")}\n${more(f.jobs.length, shown.length)}`,
    );
  }
  if (f.installIds.length) {
    const shown = f.installIds.slice(0, IDS_SHOWN);
    out.push(
      `\nInstalls:\n${shown.join("\n")}\n${more(f.installIds.length, shown.length)}`,
    );
  }
  if (!f.jobs.length && f.codes.length)
    out.push(`\nCodes: ${f.codes.slice(0, IDS_SHOWN).join(", ")}\n`);
  return out.join("");
}

type Copy = { title: string; open: (f: AlertFacts) => string; clear: string };

const COPY: Record<AlertKey, Copy> = {
  signin_refused_burst: {
    title: "refused sign-in burst",
    open: () =>
      `${SIGNIN_BURST_MIN} or more admin sign-ins were refused within ${mins(SIGNIN_BURST_WINDOW_MS)} minutes. This email goes out at most once every ${mins(BURST_EMAIL_INTERVAL_MS)} minutes.`,
    clear: `Fewer than ${SIGNIN_BURST_MIN} sign-ins were refused in the last ${mins(SIGNIN_BURST_WINDOW_MS)} minutes.`,
  },
  admin_unknown_sub: {
    title: "sign-in by an unknown account",
    open: () =>
      `An admin sign-in was refused with unknown_sub in the last ${hours(ALERT_LOOKBACK_MS)} hours: a Google account that is not on the admin list. The panel's No access screen shows its account id.`,
    clear: `No unknown_sub refusal in the last ${hours(ALERT_LOOKBACK_MS)} hours.`,
  },
  job_failed: {
    title: "jobs failed",
    open: (f) =>
      `${plural(f.count, "job")} failed in the last ${hours(ALERT_LOOKBACK_MS)} hours, and no later job on the install finished it.`,
    clear: "No failed job is waiting on an operator.",
  },
  job_retrying: {
    title: "jobs retrying",
    open: (f) =>
      `${plural(f.count, "open job")} reached attempt ${JOB_RETRYING_ATTEMPT + 1} or later.`,
    clear: "No open job is past its second attempt.",
  },
  job_stuck: {
    title: "jobs stuck",
    open: (f) =>
      `${plural(f.count, "open job")} did not change for ${hours(JOB_STUCK_MS)} hours and no retry is due.`,
    clear: "No open job is stuck.",
  },
  prod_dirty: {
    title: "prod_dirty install",
    open: (f) =>
      `${plural(f.count, "job")} failed prod_dirty: the install's render did not pass verify_clean. Purge or discard the install.`,
    clear: "Every prod_dirty install was purged or discarded.",
  },
  prodclean_failed: {
    title: "prod-clean check failed",
    open: (f) => {
      const on = f.report?.installId ? ` on install ${f.report.installId}` : "";
      const why = f.report?.detail ? ` Detail: ${f.report.detail}.` : "";
      return `The latest hourly prod-clean report failed${on}.${why} The full report is in inventory.`;
    },
    clear: "The latest hourly prod-clean report passed.",
  },
  upgrade_incomplete: {
    title: "upgrade incomplete",
    open: (f) =>
      `${plural(f.count, "upgrade")} ended upgrade_incomplete, with no later upgrade, rollback, purge or discard.`,
    clear: "No install is left upgrade_incomplete.",
  },
  unreachable_after_route: {
    title: "install unreachable after create",
    open: (f) =>
      `${plural(f.count, "install")} failed the health check right after create or retry routed it.`,
    clear: "Every newly routed install passes its health check.",
  },
  purge_stuck: {
    title: "purge stuck",
    open: (f) =>
      `${plural(f.count, "install")} failed purge ${PURGE_STUCK_FAILURES} times; the scheduler stopped retrying. Finish each through the API (retry, then skipDirectoryRevoke with a reason).`,
    clear: "No purge is stuck.",
  },
  welcome_unsent: {
    title: "welcome email unsent",
    open: (f) =>
      `${plural(f.count, "welcome email")} owed or claimed over ${mins(WELCOME_CLAIM_MS)} minutes ago, never marked sent. Check the send log first; send by hand only if it never went out.`,
    clear: "Every owed welcome email is marked sent.",
  },
  signup_cap: {
    title: "signup cap reached",
    open: () =>
      "Today's self-serve signup cap (SIGNUP_DAILY_CAP) was reached. New signups wait for 00:00 UTC.",
    clear: "Today's self-serve signups are under the cap.",
  },
  oauth_register_flood: {
    title: "MCP registration flood",
    open: () =>
      `More than ${OAUTH_REGISTER_FLOOD} MCP clients registered today (UTC).`,
    clear: `MCP client registrations today are at or under ${OAUTH_REGISTER_FLOOD}.`,
  },
  token_expiring: {
    title: "provisioner token expiring",
    open: (f) =>
      `The provisioner's Cloudflare token expires within ${TOKEN_EXPIRING_DAYS} days${f.daysLeft === undefined ? "" : ` (${plural(f.daysLeft, "day")} left)`}. Rotate it before then.`,
    clear: "The provisioner's Cloudflare token is no longer near its end date.",
  },
  token_invalid: {
    title: "provisioner token invalid",
    open: () =>
      "The provisioner's Cloudflare token is invalid. Jobs that need it retry and then fail until it is replaced.",
    clear: "The provisioner's Cloudflare token is valid again.",
  },
};

const NO_FACTS: AlertFacts = { count: 0, installIds: [], jobs: [], codes: [] };

/** The email for one key, from facts only. */
export function alertFor(
  key: AlertKey,
  env: string,
  facts: AlertFacts = NO_FACTS,
): Alert {
  const c = COPY[key];
  const p = ALERT_POLICY[key];
  const remind =
    p.remindMs === null
      ? ""
      : ` You will get a reminder every ${hours(p.remindMs)} hours while it stays open.`;
  return {
    key,
    subject: {
      open: `Open Artifacts ${env}: ${c.title}`,
      remind: `Open Artifacts ${env}: still open, ${c.title}`,
      clear: `Open Artifacts ${env}: cleared, ${c.title}`,
    },
    text: (state, at) =>
      state === "clear"
        ? `${c.clear} (cleared at ${iso(at)}, alert ${key}).\n`
        : `${c.open(facts)} (alert ${key}, opened at ${iso(at)}).${remind}\n${idLines(facts)}`,
  };
}
