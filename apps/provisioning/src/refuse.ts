import { ipKey } from "@oa/auth-core";
import {
  type ApiErrorCode,
  AUDIT_REFUSAL_WINDOW_MS,
  type AuditRefusalBucket,
} from "@oa/shared/provisioning";
import { hmac16 } from "./auth/crypto.js";
import type { Env } from "./env.js";
import { errorResponse } from "./errors.js";

/** The C4 name, kept for streams that import it; the buckets are 4.9's. */
export type RefusalBucket = AuditRefusalBucket;

// Bucket `pre` refusals are requests already over RL_PV_PRE_IP, the flood
// itself: each isolate writes only the first per (code, IP key, window), so
// the flood costs PLATFORM_DB at most one write per IP key per window per
// isolate, and the row's count is a floor. Other buckets sit under the
// pre-IP cap, which bounds their writes.
const PRE_SEEN_MAX = 10_000;
const preSeen = new Set<string>();
let preWindow = 0;

/** True the first time this isolate sees a `pre` refusal for the key in this window. */
export function firstPreRefusal(
  code: string,
  ip: string,
  now: number = Date.now(),
): boolean {
  const w = now - (now % AUDIT_REFUSAL_WINDOW_MS);
  if (w !== preWindow || preSeen.size >= PRE_SEEN_MAX) {
    preSeen.clear();
    preWindow = w;
  }
  const k = `${code}\n${ip}`;
  if (preSeen.has(k)) return false;
  preSeen.add(k);
  return true;
}

/**
 * Answers a pre-authn or unauthenticated refusal, after counting it in
 * audit_refusals (4.9): one row per bucket, code, IP HMAC and 10-minute
 * window, so an anonymous flood adds at most one row per IP key per bucket
 * per window. A failed count never changes the answer.
 */
export async function refuse(
  env: Env,
  bucket: AuditRefusalBucket,
  code: ApiErrorCode,
  req: Request,
): Promise<Response> {
  const ip = ipKey(req);
  try {
    if (bucket !== "pre" || firstPreRefusal(code, ip))
      await countRefusal(env, bucket, code, ip);
  } catch {
    // The refusal stands without its count (D1 down or unbound).
  }
  return errorResponse(code);
}

/** The audit_refusals upsert; exported for callers that answer their own response (OAuth). */
export async function countRefusal(
  env: Pick<Env, "PLATFORM_DB" | "ADMIN_SESSION_KEY">,
  bucket: AuditRefusalBucket,
  code: string,
  ip: string,
  now: number = Date.now(),
): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `INSERT INTO audit_refusals (bucket, code, ip_hmac, window_start, count, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5)
     ON CONFLICT (bucket, code, ip_hmac, window_start)
     DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
  )
    .bind(
      bucket,
      code,
      await hmac16(env.ADMIN_SESSION_KEY, ip),
      now - (now % AUDIT_REFUSAL_WINDOW_MS),
      now,
    )
    .run();
}

/**
 * Counts an authenticated caller's 429 (4.9: audit_refusals holds any 429)
 * in bucket `auth` (C1 has no post-authn bucket), keyed by the HMAC of its
 * rate key (no IP on /mcp): for these rows the ip_hmac column holds a
 * rate-key HMAC, not an IP's. So a
 * flood adds one row per caller per window. Never throws: the refusal
 * stands without its count. invokeRoute (both surfaces) and the mint
 * counter call it.
 */
export async function countRateLimited(
  env: Pick<Env, "PLATFORM_DB" | "ADMIN_SESSION_KEY">,
  rateKey: string,
): Promise<void> {
  try {
    await countRefusal(env, "auth", "rate_limited", rateKey);
  } catch {
    // D1 down or unbound.
  }
}
