// /__test/* hooks (P2 Task 14): types only, no handler lives in shared.
// Mounted only when TEST_HOOKS_ALLOWED (build time) AND TEST_HOOKS=1 with a
// 32+ char TEST_HOOK_KEY (runtime). Everything else, a wrong key included, is
// the standard 404. Hosted prod builds must leave TEST_HOOKS_ALLOWED false.
import { z } from "zod";
import { RoleSchema } from "../schemas.js";

declare const __OA_TEST_HOOKS_ALLOWED__: boolean | undefined;
/**
 * Build-time guard. False unless the bundler defines
 * `__OA_TEST_HOOKS_ALLOWED__` as true (wrangler `define`, test and staging
 * configs only). The release template defines it as false explicitly, so the
 * hooks can't be enabled by an env var alone. The release check is
 * behavioural: the release bundle with TEST_HOOKS=1 and a valid key answers
 * 404 on every hook path.
 */
export const TEST_HOOKS_ALLOWED: boolean =
  typeof __OA_TEST_HOOKS_ALLOWED__ !== "undefined" &&
  __OA_TEST_HOOKS_ALLOWED__ === true;

export const TEST_HOOKS = {
  session: "/__test/session",
  otpLatest: "/__test/otp/latest",
  oauthClient: "/__test/oauth-client",
  audit: "/__test/audit",
} as const;

/**
 * Why a hook refused, AFTER the key verified: the 404 body's
 * error.details.reason. Refusals before the key (hooks off, rate limit,
 * wrong key) stay the uniform 404 with no reason.
 */
export const TEST_HOOK_REFUSALS = [
  /** Not a POST, or not a known hook path. */
  "bad_route",
  /** The body failed its schema, or a bad email or spaces list. */
  "bad_input",
  /** A granted space is unprefixed, personal, deleted, or has a member outside TEST_DOMAIN. */
  "spaces_blocked",
  /** The user can't be acted on (owner, outside TEST_DOMAIN, another role, suspended). */
  "user_refused",
  /** A grant row didn't write (the space changed after the check). */
  "grant_refused",
  /** otp/latest: no code to read for that address (details.outcome says why). */
  "no_code",
] as const;
export type TestHookRefusal = (typeof TEST_HOOK_REFUSALS)[number];

/**
 * otp/latest's no_code 404 (after the key) carries error.details.outcome: the
 * last code-send outcome recorded for that TEST_DOMAIN address. Only "pending"
 * means "not yet, ask again"; every other value is final for that request.
 */
export const TEST_OTP_OUTCOMES = [
  /** Requested; the send hasn't finished. */
  "pending",
  /** Sent (the 200 carries the code; never in a no_code 404). */
  "sent",
  /** The sent code was redeemed. */
  "used",
  /** The sent code is past its TTL. */
  "expired",
  /** Nothing recorded for that address. */
  "none",
  // deliverCode's own outcomes (its code_send log), plus "error" (it threw).
  "email_off",
  "ineligible",
  "pool_full",
  "capped",
  "resend_wait",
  "send_failed",
  "error",
] as const;
export type TestOtpOutcome = (typeof TEST_OTP_OUTCOMES)[number];

/** POST TEST_HOOKS.session -> TestSessionResult (a real __Host-oa_session value, p: "test"). */
export const TestSessionInputSchema = z.strictObject({
  email: z.email(),
  role: RoleSchema,
  /** Space roles to grant (manual rows), keyed by space id. */
  spaces: z
    .array(
      z.strictObject({
        spaceId: z.string(),
        role: z.enum(["viewer", "editor", "manager"]),
      }),
    )
    .optional(),
});
export type TestSessionInput = z.infer<typeof TestSessionInputSchema>;
export const TestSessionResultSchema = z.object({ cookie: z.string() });
export type TestSessionResult = z.infer<typeof TestSessionResultSchema>;

/** POST TEST_HOOKS.otpLatest -> OtpLatestResult, or 404 when none. */
export const OtpLatestInputSchema = z.strictObject({ email: z.string() });
export type OtpLatestInput = z.infer<typeof OtpLatestInputSchema>;
export const OtpLatestResultSchema = z.object({ code: z.string() });
export type OtpLatestResult = z.infer<typeof OtpLatestResultSchema>;

/** POST TEST_HOOKS.oauthClient (no body) -> a real MCP OAuth grant for a member. */
export const OAuthClientHookResultSchema = z.object({
  clientId: z.string(),
  accessToken: z.string(),
});
export type OAuthClientHookResult = z.infer<typeof OAuthClientHookResultSchema>;

/** Most rows POST TEST_HOOKS.audit returns. */
export const TEST_AUDIT_LIMIT = 200;

/** POST TEST_HOOKS.audit: `since` is ms since the epoch (rows with at >= since). */
export const TestAuditInputSchema = z.strictObject({
  since: z.number().int().nonnegative(),
});
export type TestAuditInput = z.infer<typeof TestAuditInputSchema>;
/** One `test_hook.*` audit row. Never any other event. */
export const TestAuditEventSchema = z.object({
  action: z.string().startsWith("test_hook."),
  at: z.number(),
  actorId: z.string().nullable(),
  targetId: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type TestAuditEvent = z.infer<typeof TestAuditEventSchema>;
/** Newest first, at most TEST_AUDIT_LIMIT. */
export const TestAuditResultSchema = z.object({
  events: z.array(TestAuditEventSchema),
});
export type TestAuditResult = z.infer<typeof TestAuditResultSchema>;

/**
 * GET /healthz. testHooks: true only on staging installs (hooks mounted);
 * false in tests and on every release install. Prod is built separately (the
 * staging bundle is never promoted) and the release asserts testHooks: false.
 */
export const HealthzSchema = z.object({
  ok: z.literal(true),
  plan: z.enum(["free", "paid"]),
  version: z.string(),
  /** Hosted M1; optional so older servers parse. */
  testHooks: z.boolean().optional(),
  /**
   * Hosted installs only: the trimmed INSTALL_ID. Opaque, non-secret, and
   * proof of routing only - never an authorization signal.
   */
  installId: z.string().optional(),
});
export type Healthz = z.infer<typeof HealthzSchema>;
