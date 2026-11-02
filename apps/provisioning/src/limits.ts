import { bump } from "./auth/counters.js";
import type { Env } from "./env.js";
import { type Principal, type Refusal, refusal } from "./principal.js";

/** Rate-limit buckets (4.7, 9A.7) and their bindings. */
export const RATE_LIMIT_BINDINGS = {
  pre_ip: "RL_PV_PRE_IP",
  signin_ip: "RL_PV_SIGNIN_IP",
  write: "RL_PV_WRITE",
  read: "RL_PV_READ",
  slug_ip: "RL_PV_SLUG_IP",
  oauth_ip: "RL_PV_OAUTH_IP",
  admin_escape: "RL_PV_ADMIN_ESCAPE",
  token_write: "RL_PV_TOKEN_WRITE",
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

/**
 * Per-60 s limits of the two buckets that keep a leaked token from locking
 * its admin out (wrangler.jsonc binds these; config.test checks them).
 * - admin_escape: an admin session's R21 (revoke) and R24 (logout), keyed
 *   `admin-escape:<email>`, never the shared `admin:<email>` write bucket.
 *   2x RL_PV_WRITE: a human always gets through, a script still stops.
 * - token_write: each token's own `token:<tokenId>` write sub-bucket,
 *   charged before the admin's shared one. 1/3 of RL_PV_WRITE (30), so one
 *   token can never spend the whole admin budget.
 */
export const ESCAPE_LIMITS = {
  admin_escape: 60,
  token_write: 10,
} as const;

/** The admin-session routes that skip the shared write bucket. */
const ESCAPE_ROUTES = new Set(["R21", "R24"]);

/**
 * The route charge for `p` (4.7): an admin session's R21/R24 go to its
 * escape bucket only; a token's write spends its own sub-bucket first, then
 * the admin's shared one; everyone else spends `bucket` by rate key.
 */
export async function limitRoute(
  env: Env,
  bucket: "read" | "write",
  p: Principal,
  route: string,
): Promise<Refusal | null> {
  if (p.kind === "admin" && p.session && ESCAPE_ROUTES.has(route))
    return limit(env, "admin_escape", `admin-escape:${p.email}`);
  if (p.kind === "token" && bucket === "write") {
    const t = await limit(env, "token_write", `token:${p.tokenId}`);
    if (t) return t;
  }
  return limit(env, bucket, p.rateKey);
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
