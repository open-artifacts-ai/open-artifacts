import type { ApiErrorCode } from "@oa/shared/provisioning";
import type { Env } from "./env.js";
import { errorResponse } from "./errors.js";
import type { RateBucket } from "./limits.js";

/** audit_refusals buckets (4.9): the rate buckets plus the pre-authn checks. */
export type RefusalBucket =
  | RateBucket
  | "auth"
  | "csrf"
  | "signin_flow"
  | "oauth_register";

/**
 * Answers a pre-authn or unauthenticated refusal. W5b adds the
 * audit_refusals count (one row per bucket, code, ip_hmac and 10-min window,
 * 4.9) before the response; nothing here writes one row per request.
 */
export async function refuse(
  _env: Env,
  _bucket: RefusalBucket,
  code: ApiErrorCode,
  _req: Request,
): Promise<Response> {
  return errorResponse(code);
}

/**
 * Counts an authenticated caller's 429 (4.9: audit_refusals holds any 429),
 * from invokeRoute's limit and every handler limit (R18 RL_PV_SLUG_IP, the
 * R4 /64 and /48 counters). W5b writes the count (its `countRateLimited`,
 * same signature); never throws.
 */
export async function countRateLimited(
  _env: Env,
  _rateKey: string,
): Promise<void> {}
