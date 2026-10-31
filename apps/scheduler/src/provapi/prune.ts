// Prune (design v7 5.8): sessions and agent tokens expired over
// EXPIRED_AUTH_RETENTION_MS (7 days; a revoked one stays until then, so its
// revoked state is never lost while a grant or a session check could still
// read it), unclaimed OAuth clients (0008), D1
// rate counters (2 h; the DCR UTC-day counters 48 h), audit_refusals over 90 days, and
// a failed signup's owner email 30 days on. Bounded deletes, so a backlog drains over ticks. Never admin_audit
// (append-only; its triggers refuse a delete).
import {
  AUDIT_REFUSAL_RETENTION_MS,
  DCR_COUNTER_RETENTION_MS,
  EXPIRED_AUTH_RETENTION_MS,
  RATE_COUNTER_RETENTION_MS,
} from "@oa/shared/provisioning/state";
import { d1, type ProvapiEnv } from "./env.js";

/** Rows deleted per table per tick. */
export const PRUNE_BATCH = 500;
/**
 * The `rate_counters.key` prefix of the DCR UTC-day counters, which keep
 * DCR_COUNTER_RETENTION_MS; every other counter keeps
 * RATE_COUNTER_RETENTION_MS. TODO(contract): C5 exports the 48 h retention
 * but no key (or prefix) for the DCR day counters; this one is W7's.
 */
export const DCR_COUNTER_KEY_PREFIX = "dcr:";
const IS_DCR = `substr(key, 1, ${DCR_COUNTER_KEY_PREFIX.length}) = '${DCR_COUNTER_KEY_PREFIX}'`;
/**
 * A failed signup's owner email (signup_secret) outlives the redrive window
 * by no more (#859's purgeFailedSecrets). TODO(contract): not exported.
 */
export const FAILED_SECRET_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * An OAuth client with no grant this long after registering goes (0008:
 * "Unclaimed clients are swept after 24 h"; the library's KV copy expires
 * on its own TTL). TODO(contract): not exported.
 */
export const OAUTH_CLIENT_UNCLAIMED_MS = 24 * 60 * 60_000;

const bounded = (table: string, where: string) =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${PRUNE_BATCH})`;

export const PRUNES = {
  sessions: bounded(
    "sessions",
    `expires_at <= ?1 - ${EXPIRED_AUTH_RETENTION_MS}`,
  ),
  agent_tokens: bounded(
    "agent_tokens",
    `expires_at <= ?1 - ${EXPIRED_AUTH_RETENTION_MS}`,
  ),
  rate_counters: bounded(
    "rate_counters",
    `(NOT ${IS_DCR} AND window_start <= ?1 - ${RATE_COUNTER_RETENTION_MS}) OR (${IS_DCR} AND window_start <= ?1 - ${DCR_COUNTER_RETENTION_MS})`,
  ),
  audit_refusals: bounded(
    "audit_refusals",
    `window_start <= ?1 - ${AUDIT_REFUSAL_RETENTION_MS}`,
  ),
  signup_secret: bounded(
    "signup_secret",
    `signup_id IN (SELECT signup_id FROM signups WHERE status = 'failed' AND updated_at <= ?1 - ${FAILED_SECRET_RETENTION_MS})`,
  ),
  oauth_clients: bounded(
    "oauth_clients",
    `first_grant_at IS NULL AND registered_at <= ?1 - ${OAUTH_CLIENT_UNCLAIMED_MS}`,
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
