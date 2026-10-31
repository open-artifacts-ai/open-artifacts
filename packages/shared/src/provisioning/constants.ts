// Plain constants and checks for Backend (design v7 2.6, 4.2, 4.7, 9A.3,
// 9A.7), no zod: the scheduler and the provisioner import
// `@oa/shared/provisioning/constants`.
import { ULID_RE } from "./id-patterns.js";

export { ULID_RE };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 2.6: `expiring` iff `daysLeft <= 30`; also the `token_expiring` alert (5.8). */
export const TOKEN_EXPIRING_DAYS = 30;
/** ProvisionerRpc.tokenStatus() statuses (2.6). */
export const TOKEN_STATUSES = ["active", "expiring", "invalid"] as const;
export type TokenStatusValue = (typeof TOKEN_STATUSES)[number];

/**
 * The zod-free check of a tokenStatus() result, equal to TokenStatusSchema:
 * daysLeft and expiresAt are numbers unless invalid (then anything nullable),
 * and `expiring` iff daysLeft <= TOKEN_EXPIRING_DAYS.
 */
export function isTokenStatus(v: unknown): v is {
  status: TokenStatusValue;
  expiresAt: number | null;
  daysLeft: number | null;
} {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const numOrNull = (x: unknown) =>
    x === null || (typeof x === "number" && !Number.isNaN(x));
  if (!(TOKEN_STATUSES as readonly unknown[]).includes(o.status)) return false;
  if (!numOrNull(o.expiresAt) || !numOrNull(o.daysLeft)) return false;
  if (o.status === "invalid") return true;
  if (o.daysLeft === null || o.expiresAt === null) return false;
  return (
    (o.status === "expiring") === (o.daysLeft as number) <= TOKEN_EXPIRING_DAYS
  );
}

/**
 * The `rate_counters` key prefix of the DCR registration counters (4.7, 9A.7:
 * per ipKey per UTC day), for the writer and the nightly pruner (5.8, kept
 * DCR_COUNTER_RETENTION_MS). The design names no prefix: Manager's value (C6).
 */
export const DCR_COUNTER_PREFIX = "dcr:";

/**
 * How long a failed signup's `signup_secret` row (the owner email) is kept
 * before the nightly prune deletes it: 30 days, the same as the deleted
 * install's owner-email purge (#648). The design states no value; the
 * Manager's decision (C6).
 */
export const FAILED_SECRET_RETENTION_MS = 30 * DAY;

/** 3.5 `token_limit`, 4.1: 5 live tokens per admin across both kinds (`oat` and `oauth`). */
export const LIVE_TOKENS_PER_ADMIN = 5;

/** 8.3, 9A.7: an `oauth_clients` row with no grant this long is swept. */
export const OAUTH_CLIENT_UNCLAIMED_MS = 24 * HOUR;
/** 9A.3.1, 9A.7: every MCP client expires after 30 days (`clientRegistrationTTL: 2592000` s). */
export const OAUTH_CLIENT_TTL_MS = 30 * DAY;

/** `SIGNUPS_ENABLED` (2.4): `false`, `true`; staging also `test-users`. */
export const SIGNUPS_ENABLED_VALUES = ["false", "true", "test-users"] as const;
export type SignupsEnabled = (typeof SIGNUPS_ENABLED_VALUES)[number];

/**
 * `SIGNUPS_ENABLED` exactly as set: `true` admits all, `test-users` only the
 * OIDC test users (4.2). Anything else, unset included, is `false` (closed,
 * as #859's consumer acks anything but "true"). Whether `test-users` is
 * allowed in prod is the deploy read-back's check (10.2), not this parser's.
 */
export function parseSignupsEnabled(value: unknown): SignupsEnabled {
  return (SIGNUPS_ENABLED_VALUES as readonly unknown[]).includes(value)
    ? (value as SignupsEnabled)
    : "false";
}
