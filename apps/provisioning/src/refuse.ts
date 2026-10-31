import type { ApiErrorCode, AuditRefusalBucket } from "@oa/shared/provisioning";
import type { Env } from "./env.js";
import { errorResponse } from "./errors.js";

/** The C4 name, kept for streams that import it; the buckets are 4.9's. */
export type RefusalBucket = AuditRefusalBucket;

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
