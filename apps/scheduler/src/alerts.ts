/**
 * Operator alerts by email (billing unreachable, email quota, and the signup
 * alerts: cap reached, stuck, failed, welcome unsent). An alert has a key; it
 * opens, reminds once a day while open, and clears. Each change of
 * state is one log line, and each is one plain-text email to ALERT_TO through
 * the send_email binding ALERT_EMAIL:
 * - one when it opens,
 * - one per 24 h while it stays open,
 * - one when it clears (only if the operator heard it open).
 *
 * State lives in platform D1 `platform_state` (0006), one row per key:
 * - `<key>_opened_at`: set while open.
 * - `<key>_notified_at`: the last open or reminder email claimed; 0 means one
 *   is owed (its send failed).
 * - `<key>_cleared_at`: a clear email is owed.
 * Every claim is one conditional write, so overlapping ticks send once. A
 * failed send gives its claim back, so the next tick retries it.
 *
 * Emails carry a fixed subject per key and state and fixed text: no customer
 * data and no URLs; the signup alerts' text adds counts and signup ids only.
 * Logs carry the key and fixed categories only. Never throws out of a tick.
 */

export interface AlertEnv {
  PLATFORM_DB: D1Database;
  /** Cloudflare Email Service; unbound means no destination. */
  ALERT_EMAIL?: SendEmail;
  /** The operator's address; empty or malformed means no destination. */
  ALERT_TO?: string;
  /** The sender address on a domain the account sends from. */
  ALERT_FROM?: string;
}

export type AlertState = "open" | "remind" | "clear";

export interface Alert {
  /** platform_state key prefix: lowercase, digits and underscores. */
  key: string;
  subject: Record<AlertState, string>;
  /**
   * The email's text. `at` (epoch ms) is when the alert opened, or for
   * "clear", when it cleared.
   */
  text: (state: AlertState, at: number) => string;
}

export const ALERT_REMIND_MS = 24 * 60 * 60_000;
/** A send that hasn't settled by then counts as failed (and is retried). */
export const ALERT_SEND_TIMEOUT_MS = 5_000;

// One plain addr-spec, as apps/server's sender checks: never a list or a
// display name.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const GET = "SELECT value FROM platform_state WHERE key = ?1";
const OPEN =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING RETURNING value";
// The clear email is owed only if the operator heard the alert open.
const OWE_CLEAR =
  "INSERT INTO platform_state (key, value, updated_at) SELECT ?1, ?2, ?2 WHERE EXISTS (SELECT 1 FROM platform_state WHERE key = ?3) AND EXISTS (SELECT 1 FROM platform_state WHERE key = ?4) ON CONFLICT (key) DO NOTHING";
const DELETE = "DELETE FROM platform_state WHERE key = ?1 RETURNING value";
const OWE =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
// Claims the open or reminder email: inserted when none was sent yet, else
// moved to now only when one is owed (0) or the last is at or before
// ?3 (now - 24 h, or 0 when reminders are off for this call).
const CLAIM =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE platform_state.value <= ?3 RETURNING value";
// Gives a claim back after a failed send: only our own claim (value = now).
const UNCLAIM_OPEN = "DELETE FROM platform_state WHERE key = ?1 AND value = ?2";
const UNCLAIM_REMIND =
  "UPDATE platform_state SET value = 0, updated_at = ?2 WHERE key = ?1 AND value = ?2";

class SendTimeout extends Error {}

/** A short category for logs; never the message. */
function category(e: unknown): string {
  if (e instanceof SendTimeout) return "timeout";
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE.test(code)
    ? code
    : "send_error";
}

/**
 * True when the email went out, or when there is no destination (logged,
 * and the state machine carries on as if sent, so it isn't retried every
 * tick). False on a failed send, so the caller gives its claim back.
 */
async function send(
  env: AlertEnv,
  alert: Alert,
  state: AlertState,
  at: number,
  timeoutMs: number,
): Promise<boolean> {
  const to = env.ALERT_TO ?? "";
  const from = env.ALERT_FROM ?? "";
  if (!env.ALERT_EMAIL || !ADDRESS.test(to) || !ADDRESS.test(from)) {
    console.log("alert skipped no_destination");
    return true;
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
    console.log("alert", alert.key, "sent", state);
    return true;
  } catch (e) {
    console.error("alert", alert.key, "send_failed", category(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface AlertOptions {
  /**
   * Send the daily reminder when it is due (default true). A caller that
   * only retries owed emails between checks passes false, so a reminder
   * never goes out just before the check that would clear the alert.
   */
  remind?: boolean;
  /** Tests only: the send timeout (default ALERT_SEND_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * One step of an alert. `condition` true opens it (if closed), false clears
 * it (if open), null leaves it as it is. Then any owed email goes out: a
 * clear, the open email, or the daily reminder. Never throws: a D1 error is
 * the fixed line `alert <key> db_error`.
 */
export async function stepAlert(
  env: AlertEnv,
  alert: Alert,
  condition: boolean | null,
  now: number,
  { remind = true, timeoutMs = ALERT_SEND_TIMEOUT_MS }: AlertOptions = {},
): Promise<void> {
  const opened = `${alert.key}_opened_at`;
  const notified = `${alert.key}_notified_at`;
  const cleared = `${alert.key}_cleared_at`;
  const db = env.PLATFORM_DB;
  try {
    if (condition === true) {
      if (await db.prepare(OPEN).bind(opened, now).first())
        console.log("alert", alert.key, "opened");
    } else if (condition === false) {
      // One transaction: the clear email is owed (if it was heard open),
      // then the alert closes. Only one overlapping tick sees the row go.
      const [, gone] = await db.batch([
        db.prepare(OWE_CLEAR).bind(cleared, now, opened, notified),
        db.prepare(DELETE).bind(opened),
        db.prepare(DELETE).bind(notified),
      ]);
      if (gone?.results.length) console.log("alert", alert.key, "cleared");
    }

    // An owed clear goes first, so a reopen's email follows it.
    const owed = await db.prepare(DELETE).bind(cleared).first<{
      value: number;
    }>();
    if (owed && !(await send(env, alert, "clear", owed.value, timeoutMs)))
      await db.prepare(OWE).bind(cleared, owed.value).run();

    const open = await db.prepare(GET).bind(opened).first<{ value: number }>();
    if (!open) return;
    const prev = await db.prepare(GET).bind(notified).first<{
      value: number;
    }>();
    const cutoff = remind ? now - ALERT_REMIND_MS : 0;
    if (prev && prev.value !== 0 && prev.value > cutoff) return;
    if (!(await db.prepare(CLAIM).bind(notified, now, cutoff).first())) return;
    const state = prev ? "remind" : "open";
    if (!(await send(env, alert, state, open.value, timeoutMs)))
      await db
        .prepare(state === "open" ? UNCLAIM_OPEN : UNCLAIM_REMIND)
        .bind(notified, now)
        .run();
  } catch {
    console.error("alert", alert.key, "db_error");
  }
}

const iso = (t: number) => new Date(t).toISOString();

/** oa-<p>-billing has not answered /health for over an hour. */
export const billingAlert = (env: string): Alert => ({
  key: "billing_unreachable",
  subject: {
    open: `Open Artifacts ${env}: billing unreachable`,
    remind: `Open Artifacts ${env}: billing still unreachable`,
    clear: `Open Artifacts ${env}: billing reachable again`,
  },
  text: (state, at) =>
    state === "clear"
      ? `The ${env} billing Worker answers its health check again (cleared at ${iso(at)}).\n`
      : `The ${env} billing Worker has not answered its health check for over an hour (alert opened at ${iso(at)}). Installs keep their last good tier for 7 days. You will get one reminder a day until it answers again.\n`,
});

/** Yesterday's sends reached 80% of the account's daily sending limit. */
export const emailQuotaAlert = (env: string): Alert => ({
  key: "email_quota",
  subject: {
    open: `Open Artifacts ${env}: email quota warning`,
    remind: `Open Artifacts ${env}: email quota still high`,
    clear: `Open Artifacts ${env}: email quota back under`,
  },
  text: (state, at) =>
    state === "clear"
      ? `The ${env} daily email sends are back under 80% of the account's sending limit (cleared at ${iso(at)}).\n`
      : `The ${env} daily email sends reached 80% or more of the account's Email Sending daily limit (alert opened at ${iso(at)}). Raise the limit or reduce sending. You will get one reminder a day while it stays high.\n`,
});

/** Signup facts for an alert's text: a count and some ids, never an email. */
export interface SignupFacts {
  count: number;
  /** Signup ids (ULIDs), at most SIGNUP_IDS_SHOWN of them. */
  ids: string[];
}

export const SIGNUP_IDS_SHOWN = 20;

const signups = (n: number) => `${n} signup${n === 1 ? "" : "s"}`;
const idLines = ({ count, ids }: SignupFacts) =>
  ids.length === 0
    ? ""
    : `\n${ids.join("\n")}\n${count > ids.length ? `and ${count - ids.length} more\n` : ""}`;

/** The day's SIGNUP_DAILY_CAP was reached: new signups wait for 00:00 UTC. */
export const signupCapAlert = (
  env: string,
  facts: SignupFacts = { count: 0, ids: [] },
): Alert => ({
  key: "signup_cap",
  subject: {
    open: `Open Artifacts ${env}: signup cap reached`,
    remind: `Open Artifacts ${env}: signup cap still reached`,
    clear: `Open Artifacts ${env}: signup cap no longer reached`,
  },
  text: (state, at) =>
    state === "clear"
      ? `No ${env} signups are waiting for today's cap (cleared at ${iso(at)}).\n`
      : `The ${env} daily signup cap was reached (alert opened at ${iso(at)}): ${signups(facts.count)} waiting. They are re-enqueued after 00:00 UTC, oldest first. A sudden rise can mean abuse or demand; raise SIGNUP_DAILY_CAP to admit more. This alert opens at most once a UTC day.\n${idLines(facts)}`,
});

/** A signup ended failed in the last 24 h. */
export const signupFailedAlert = (
  env: string,
  facts: SignupFacts = { count: 0, ids: [] },
): Alert => ({
  key: "signup_failed",
  subject: {
    open: `Open Artifacts ${env}: signups failed`,
    remind: `Open Artifacts ${env}: signups still failing`,
    clear: `Open Artifacts ${env}: no failed signups`,
  },
  text: (state, at) =>
    state === "clear"
      ? `No ${env} signup has failed in the last 24 hours (cleared at ${iso(at)}).\n`
      : `${signups(facts.count)} in ${env} failed in the last 24 hours (alert opened at ${iso(at)}). Each row's error column in platform D1 signups has its category.\n${idLines(facts)}`,
});

/** A welcome email was claimed over 10 minutes ago and never marked sent. */
export const welcomeUnsentAlert = (
  env: string,
  facts: SignupFacts = { count: 0, ids: [] },
): Alert => ({
  key: "welcome_unsent",
  subject: {
    open: `Open Artifacts ${env}: welcome email unsent`,
    remind: `Open Artifacts ${env}: welcome email still unsent`,
    clear: `Open Artifacts ${env}: welcome emails sent`,
  },
  text: (state, at) =>
    state === "clear"
      ? `Every claimed ${env} welcome email is marked sent (cleared at ${iso(at)}).\n`
      : `${signups(facts.count)} in ${env} claimed a welcome email over 10 minutes ago and never marked it sent (alert opened at ${iso(at)}). The welcome is sent at most once, so it is not retried. Check the send log first (a send can succeed while its welcome_sent_at write fails); send it by hand only if it never went out, then set welcome_sent_at.\n${idLines(facts)}`,
});

/** A queued signup's ProvisionInstall instance is dead and won't finish it. */
export const signupStuckAlert = (
  env: string,
  facts: SignupFacts = { count: 0, ids: [] },
): Alert => ({
  key: "signup_stuck",
  subject: {
    open: `Open Artifacts ${env}: signups stuck`,
    remind: `Open Artifacts ${env}: signups still stuck`,
    clear: `Open Artifacts ${env}: no stuck signups`,
  },
  text: (state, at) =>
    state === "clear"
      ? `No ${env} signup is stuck queued behind a dead Workflow instance (cleared at ${iso(at)}).\n`
      : `${signups(facts.count)} in ${env} stayed queued over 15 minutes while its ProvisionInstall instance errored, terminated or completed (alert opened at ${iso(at)}). They are not re-sent: redrive each with signup-redrive.\n${idLines(facts)}`,
});
