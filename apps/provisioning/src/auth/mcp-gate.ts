import { ipKey } from "@oa/auth-core";
import type { ApiErrorCode } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { limit } from "../limits.js";
import type { Principal } from "../principal.js";
import { countRateLimited, countRefusal } from "../refuse.js";

// The /mcp adapter's own charge, refusal count and refusal reading (design
// v7 9A.6, 9A.7, 4.9), kept here so src/mcp imports only invokeRoute, auth/
// and the tool table (9A.4) and routes/invoke.ts stays as C4 and W4 wrote it.

/**
 * One `RL_PV_READ` hit on the principal's rate key for what invokeRoute does
 * not charge (`initialize`, `tools/list`, `resources/*`, `prompts/*`, a
 * refused `tools/call`; 9A.7), its 429 counted (4.9).
 */
export async function chargeTransport(
  env: Env,
  principal: Principal,
): Promise<void> {
  const r = await limit(env, "read", principal.rateKey);
  if (!r) return;
  if (r.code === "rate_limited") await countRateLimited(env, principal.rateKey);
  throw new ApiError(r.code);
}

/**
 * The adapter's unauthenticated refusal, counted in audit_refusals (bucket
 * auth, 4.9) as /v1's refuse() counts it. The adapter answers its own 401
 * (the challenge header); a failed count never changes it.
 */
export async function countUnauthenticated(
  env: Env,
  req: Request,
): Promise<void> {
  try {
    await countRefusal(env, "auth", "unauthenticated", ipKey(req));
  } catch {
    // The refusal stands without its count (D1 down or unbound).
  }
}

/** A refusal invokeRoute threw, as the 3.1 envelope's fields; null for any other error. */
export const refusalOf = (
  e: unknown,
): { code: ApiErrorCode; message: string; details?: unknown } | null =>
  e instanceof ApiError
    ? {
        code: e.code,
        message: e.message,
        ...(e.details === undefined ? {} : { details: e.details }),
      }
    : null;
