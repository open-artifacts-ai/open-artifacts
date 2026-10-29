/**
 * The billing outage alert (self-serve step 1). Installs keep their last good
 * tier for 7 days when billing is unreachable, so the operator must hear
 * about an outage long before that. Each 2-minute tick calls oa-<p>-billing's
 * /health over the BILLING binding and keeps the last success in platform D1
 * (platform_state, 0006). When the last success is over an hour old, it logs
 * `billing unreachable since <iso>` at most once per hour.
 *
 * The scheduler's only alert path today is its logs (the email-quota alert is
 * a log line too), so this alert is a log line and nothing is sent.
 */
import { BILLING_ORIGIN } from "@oa/broker-core/billing-gate";

export interface BillingHealthEnv {
  BILLING: Fetcher;
  PLATFORM_DB: D1Database;
}

export const BILLING_OK_KEY = "billing_health_ok_at";
export const BILLING_ALERT_KEY = "billing_alert_at";
export const BILLING_ALERT_AFTER_MS = 60 * 60_000;
export const BILLING_ALERT_EVERY_MS = 60 * 60_000;

const UPSERT_SQL =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
// The first failure with no success on record starts the clock now, so a
// billing Worker that never answered still alerts an hour later.
const SEED_SQL =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
const GET_SQL = "SELECT value FROM platform_state WHERE key = ?1";
// Claims this hour's alert: one row back only when no alert was claimed in
// the last hour, so overlapping ticks alert once.
const CLAIM_SQL =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE platform_state.value <= ?3 RETURNING value";

export type BillingHealth = "ok" | "down" | "alerted";

/** True when billing answered 200 with {ok:true} within timeoutMs. */
async function healthy(env: BillingHealthEnv, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      env.BILLING.fetch(`${BILLING_ORIGIN}/health`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    if (r.status !== 200) {
      await r.body?.cancel();
      return false;
    }
    const body = (await r.json()) as { ok?: unknown };
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One check. Never throws and never logs an error's text: a D1 failure is the
 * fixed line `billing-health db_error`.
 */
export async function billingHealth(
  env: BillingHealthEnv,
  now: number,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
): Promise<BillingHealth> {
  const ok = await healthy(env, timeoutMs);
  try {
    const db = env.PLATFORM_DB;
    if (ok) {
      await db.prepare(UPSERT_SQL).bind(BILLING_OK_KEY, now).run();
      return "ok";
    }
    await db.prepare(SEED_SQL).bind(BILLING_OK_KEY, now).run();
    const last = await db
      .prepare(GET_SQL)
      .bind(BILLING_OK_KEY)
      .first<{ value: number }>();
    const since = typeof last?.value === "number" ? last.value : now;
    if (now - since <= BILLING_ALERT_AFTER_MS) return "down";
    const claimed = await db
      .prepare(CLAIM_SQL)
      .bind(BILLING_ALERT_KEY, now, now - BILLING_ALERT_EVERY_MS)
      .first();
    if (!claimed) return "down";
    console.error(`billing unreachable since ${new Date(since).toISOString()}`);
    return "alerted";
  } catch {
    console.error("billing-health db_error");
    return ok ? "ok" : "down";
  }
}
