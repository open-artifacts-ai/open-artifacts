// Prune (design v7 5.8): expired or revoked sessions and agent tokens, D1
// rate counters past their longest window, audit_refusals over 90 days, and
// a failed signup's owner email 30 days on. Bounded deletes, so a backlog drains over ticks. Never admin_audit
// (append-only; its triggers refuse a delete).
import { d1, type ProvapiEnv } from "./env.js";

/** Rows deleted per table per tick. */
export const PRUNE_BATCH = 500;
/** TODO(contract): C2 exports no audit_refusals retention constant (4.9). */
export const AUDIT_REFUSAL_RETENTION_MS = 90 * 24 * 60 * 60_000;
/**
 * The longest D1 counter window (MCP registrations, a UTC day). A counter
 * that started this long ago has ended. TODO(contract): not exported.
 */
export const RATE_COUNTER_RETENTION_MS = 24 * 60 * 60_000;
/**
 * A failed signup's owner email (signup_secret) outlives the redrive window
 * by no more (#859's purgeFailedSecrets). TODO(contract): not exported.
 */
export const FAILED_SECRET_RETENTION_MS = 30 * 24 * 60 * 60_000;

const bounded = (table: string, where: string) =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${PRUNE_BATCH})`;

export const PRUNES = {
  sessions: bounded("sessions", "expires_at <= ?1 OR revoked_at IS NOT NULL"),
  agent_tokens: bounded(
    "agent_tokens",
    "expires_at <= ?1 OR revoked_at IS NOT NULL",
  ),
  rate_counters: bounded(
    "rate_counters",
    `window_start <= ?1 - ${RATE_COUNTER_RETENTION_MS}`,
  ),
  audit_refusals: bounded(
    "audit_refusals",
    `window_start <= ?1 - ${AUDIT_REFUSAL_RETENTION_MS}`,
  ),
  signup_secret: bounded(
    "signup_secret",
    `signup_id IN (SELECT signup_id FROM signups WHERE status = 'failed' AND updated_at <= ?1 - ${FAILED_SECRET_RETENTION_MS})`,
  ),
} as const;

export async function prune(env: ProvapiEnv, now: number): Promise<void> {
  const db = env.PLATFORM_DB;
  const res = await d1(
    db.batch(Object.values(PRUNES).map((sql) => db.prepare(sql).bind(now))),
  );
  const counts = Object.keys(PRUNES).map(
    (t, i) => `${t}=${res[i]?.meta.changes ?? 0}`,
  );
  console.log("provapi prune", ...counts);
}
