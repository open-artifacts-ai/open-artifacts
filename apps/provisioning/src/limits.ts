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
