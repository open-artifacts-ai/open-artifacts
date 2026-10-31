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
