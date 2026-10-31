import { bump } from "./auth/counters.js";
import type { Env } from "./env.js";
import { type Refusal, refusal } from "./principal.js";

/** Rate-limit buckets (4.7, 9A.7) and their bindings. */
export const RATE_LIMIT_BINDINGS = {
  pre_ip: "RL_PV_PRE_IP",
  signin_ip: "RL_PV_SIGNIN_IP",
  write: "RL_PV_WRITE",
  read: "RL_PV_READ",
  slug_ip: "RL_PV_SLUG_IP",
  oauth_ip: "RL_PV_OAUTH_IP",
} as const satisfies Record<string, keyof Env>;
export type RateBucket = keyof typeof RATE_LIMIT_BINDINGS;

/**
 * Charges `key` against the bucket's binding. Null when allowed;
 * `rate_limited` over the limit; `unavailable` when unbound (fail closed, as
 * broker-core's ipLimited).
 */
export async function limit(
  env: Env,
  bucket: RateBucket,
  key: string,
): Promise<Refusal | null> {
  const rl = env[RATE_LIMIT_BINDINGS[bucket]];
  if (!rl) return refusal("unavailable");
  return (await rl.limit({ key })).success ? null : refusal("rate_limited");
}

/** The D1 counters (4.7, `rate_counters`): fixed windows, per key. */
export const D1_LIMITS = {
  /** Token mints per admin, `oat_` and OAuth consents together. */
  mint: { limit: 20, windowMs: 3_600_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>;

/**
 * Charges one hit on a fixed-window D1 counter (auth/counters.ts bump, the
 * one upsert). Null while the count is within `max`; `rate_limited` past it.
 * `key` must not hold a raw email or IP (hash it with hmac16).
 */
export async function countD1(
  env: Pick<Env, "PLATFORM_DB">,
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<Refusal | null> {
  return (await bump(env.PLATFORM_DB, key, windowMs, now)) > max
    ? refusal("rate_limited")
    : null;
}
