/**
 * The scheduler's half of self-serve step 3, run on the 2-minute tick:
 * - requeueWaiting: re-sends `waiting_cap` signups, oldest first, up to the
 *   UTC day's remaining SIGNUP_DAILY_CAP, so they are admitted after 00:00.
 * - sweepStale: re-sends a `pending` row older than 15 minutes (its message
 *   was lost) and a `queued` row older than 15 minutes whose ProvisionInstall
 *   instance doesn't exist (the consumer admitted it and died before start).
 * - the signup alerts (src/alerts.ts): cap reached (at most once a UTC day),
 *   failed in the last 24 h, and a welcome claimed but never sent.
 *
 * Messages are `{ signupId }` only. The provisioner's consumer does every
 * admission, so nothing here writes a signups row, and nothing reads
 * signup_secret. Logs carry fixed categories and counts only. Never throws
 * out of a tick.
 */
import {
  type AlertEnv,
  SIGNUP_IDS_SHOWN,
  type SignupFacts,
  signupCapAlert,
  signupFailedAlert,
  stepAlert,
  welcomeUnsentAlert,
} from "./alerts.js";

export interface SignupsEnv extends AlertEnv {
  OA_ENV: string;
  /** The producer of oa-<p>-signups (the provisioner consumes it). */
  SIGNUPS: Queue<{ signupId: string }>;
  /** The provisioner's ProvisionInstall Workflow (script oa-<p>-provisioner). */
  PROVISION_INSTALL: Workflow;
  /** The same var as the provisioner's: 1 to 9999. */
  SIGNUP_DAILY_CAP?: string;
}

const DAY_MS = 86_400_000;
/** A pending or queued row this old has lost its message or its start. */
export const SIGNUP_STALE_MS = 15 * 60_000;
/** A claimed welcome this old without welcome_sent_at failed to send. */
export const WELCOME_UNSENT_MS = 10 * 60_000;
/** Rows looked at per sweep, so a tick's Workflows calls stay bounded. */
export const SWEEP_LIMIT = 50;
// Queues' sendBatch takes at most 100 messages.
const BATCH = 100;

/** Crockford base32, 26 characters: the ids SS4 mints. */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const dayStart = (now: number) => Math.floor(now / DAY_MS) * DAY_MS;

/** The cap var: 1 to 9999, or null (the provisioner's rule). */
export function dailyCap(v: string | undefined): number | null {
  return v !== undefined && /^[1-9][0-9]{0,3}$/.test(v) ? Number(v) : null;
}

async function send(env: SignupsEnv, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH)
    await env.SIGNUPS.sendBatch(
      ids.slice(i, i + BATCH).map((signupId) => ({ body: { signupId } })),
    );
}

/**
 * Re-sends waiting_cap rows, oldest first, at most the day's remaining cap
 * (the cap less the rows admitted since 00:00 UTC). Returns the count sent.
 */
export async function requeueWaiting(
  env: SignupsEnv,
  now: number,
): Promise<number> {
  const cap = dailyCap(env.SIGNUP_DAILY_CAP);
  if (cap === null) {
    console.error("signups requeue skipped cap_config");
    return 0;
  }
  try {
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT signup_id FROM signups WHERE status = 'waiting_cap'
       ORDER BY created_at, signup_id
       LIMIT max(0, ?1 - (SELECT count(*) FROM signups WHERE admitted_at >= ?2))`,
    )
      .bind(cap, dayStart(now))
      .all<{ signup_id: string }>();
    const ids = results.map((r) => r.signup_id).filter((s) => ULID_RE.test(s));
    await send(env, ids);
    if (ids.length) console.log("signups requeue", `sent=${ids.length}`);
    return ids.length;
  } catch {
    console.error("signups requeue failed");
    return 0;
  }
}

/** True when the Workflows error says the instance doesn't exist. */
const notFound = (e: unknown) =>
  /not[_ ]?found/i.test(e instanceof Error ? e.message : String(e));

/**
 * Re-sends stale pending rows, and stale queued rows whose Workflow instance
 * doesn't exist. Any other Workflows error skips the row (the next tick
 * retries). Returns the count sent.
 */
export async function sweepStale(
  env: SignupsEnv,
  now: number,
): Promise<number> {
  try {
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT signup_id, status FROM signups
       WHERE status IN ('pending', 'queued') AND updated_at < ?1
       ORDER BY updated_at, signup_id LIMIT ?2`,
    )
      .bind(now - SIGNUP_STALE_MS, SWEEP_LIMIT)
      .all<{ signup_id: string; status: string }>();
    const ids: string[] = [];
    let errors = 0;
    for (const r of results) {
      if (!ULID_RE.test(r.signup_id)) continue;
      if (r.status === "queued") {
        try {
          await env.PROVISION_INSTALL.get(r.signup_id);
          continue;
        } catch (e) {
          if (!notFound(e)) {
            errors++;
            continue;
          }
        }
      }
      ids.push(r.signup_id);
    }
    await send(env, ids);
    if (ids.length || errors)
      console.log("signups sweep", `sent=${ids.length}`, `errors=${errors}`);
    return ids.length;
  } catch {
    console.error("signups sweep failed");
    return 0;
  }
}

/** A count and the first ids of a query, or null on a D1 error. */
async function facts(
  db: D1Database,
  where: string,
  params: unknown[],
): Promise<SignupFacts | null> {
  try {
    const [count, rows] = await db.batch<{ n?: number; signup_id?: string }>([
      db
        .prepare(`SELECT count(*) AS n FROM signups WHERE ${where}`)
        .bind(...params),
      db
        .prepare(
          `SELECT signup_id FROM signups WHERE ${where}
           ORDER BY updated_at, signup_id LIMIT ${SIGNUP_IDS_SHOWN}`,
        )
        .bind(...params),
    ]);
    return {
      count: count?.results[0]?.n ?? 0,
      ids: (rows?.results ?? [])
        .map((r) => r.signup_id ?? "")
        .filter((s) => ULID_RE.test(s)),
    };
  } catch {
    return null;
  }
}

const condition = (f: SignupFacts | null) => (f ? f.count > 0 : null);

const CAP_DAY = "signup_cap_day";
// The UTC day the cap alert last opened: recorded only once it is open.
const MARK_CAP_DAY =
  "INSERT INTO platform_state (key, value, updated_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM platform_state WHERE key = 'signup_cap_opened_at') ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";

/**
 * The cap alert holds while a row went waiting_cap today. It opens at most
 * once a UTC day: once today's alert has opened and cleared, a later hit
 * the same day leaves it closed.
 */
async function capStep(env: SignupsEnv, now: number): Promise<void> {
  const db = env.PLATFORM_DB;
  const today = dayStart(now);
  const f = await facts(db, "status = 'waiting_cap' AND updated_at >= ?1", [
    today,
  ]);
  let cond = condition(f);
  try {
    if (cond === true) {
      const [open, day] = await db.batch<{ value: number }>([
        db
          .prepare("SELECT value FROM platform_state WHERE key = ?1")
          .bind("signup_cap_opened_at"),
        db
          .prepare("SELECT value FROM platform_state WHERE key = ?1")
          .bind(CAP_DAY),
      ]);
      if (!open?.results.length && day?.results[0]?.value === today)
        cond = null;
    }
  } catch {
    cond = null;
  }
  await stepAlert(env, signupCapAlert(env.OA_ENV, f ?? undefined), cond, now);
  if (cond !== true) return;
  try {
    await db.prepare(MARK_CAP_DAY).bind(CAP_DAY, today, now).run();
  } catch {
    console.error("alert signup_cap db_error");
  }
}

/**
 * One 2-minute tick: requeue, sweep, then the three alerts. Each part is
 * bounded and never throws, so one failing never skips the others.
 */
export async function signupTick(env: SignupsEnv, now: number): Promise<void> {
  await requeueWaiting(env, now);
  await sweepStale(env, now);
  await capStep(env, now);
  const failed = await facts(
    env.PLATFORM_DB,
    "status = 'failed' AND updated_at > ?1",
    [now - DAY_MS],
  );
  await stepAlert(
    env,
    signupFailedAlert(env.OA_ENV, failed ?? undefined),
    condition(failed),
    now,
  );
  const unsent = await facts(
    env.PLATFORM_DB,
    "welcome_claimed_at IS NOT NULL AND welcome_sent_at IS NULL AND welcome_claimed_at < ?1",
    [now - WELCOME_UNSENT_MS],
  );
  await stepAlert(
    env,
    welcomeUnsentAlert(env.OA_ENV, unsent ?? undefined),
    condition(unsent),
    now,
  );
}
