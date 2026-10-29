// Hosted M1 sign-in (P2): providers, emailed codes, Google redirect errors.
// The SPA (/sign-in) owns the chooser and code forms; the server is JSON-only
// and redirect refusals land on SIGN_IN_PAGE?error=<SignInError>.
import { z } from "zod";
import { MemberSchema } from "../schemas.js";
import { SignInModeSchema } from "./core.js";

/** GET AUTH.providers (public, no-store). Only enabled, fully configured providers; empty = sign-in not set up. */
export const AuthProviderSchema = z.discriminatedUnion("id", [
  z.object({ id: z.literal("access"), start: z.string() }),
  z.object({
    id: z.literal("google"),
    /** AUTH.loginGoogle; navigate (full page) to `${start}?next=…`. */
    start: z.string(),
    /**
     * Verified Workspace domains, for "Use your @acme.com account" copy. May
     * be empty: Google then admits only invited personal accounts (no hd).
     */
    domains: z.array(z.string()),
  }),
  z.object({
    id: z.literal("email"),
    /** Domain members may sign in with codes (trial, or no Google). */
    domainCodes: z.boolean(),
    /** Invited guests outside the domains may sign in with codes. */
    guests: z.boolean(),
    /** Present whenever Turnstile is configured: code requests then need CodeRequest.turnstileToken. */
    turnstileSiteKey: z.string().optional(),
  }),
]);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const AuthProvidersSchema = z.object({
  mode: SignInModeSchema,
  providers: z.array(AuthProviderSchema),
  /**
   * True only on an install Open Artifacts hosts (HOSTED=1), for "Hosted by
   * Open Artifacts" copy; false on every self-hosted install, direct sign-in
   * included. The server always sends it; absent (an older server) reads as
   * false.
   */
  hosted: z.boolean().optional(),
});
export type AuthProviders = z.infer<typeof AuthProvidersSchema>;

/**
 * `?error=` on SIGN_IN_PAGE after a refused redirect sign-in.
 * tenant: Google account outside the verified domains, or a personal Google
 * account (no hd) for an address inside them or outside gmail.com and
 * googlemail.com; identity_conflict: the
 * account was replaced (admin resets the link); expired: attempt too old or in
 * another tab; failed: anything else; removed: the person was removed or
 * suspended; no_access: a valid identity that isn't admitted. Direct mode
 * always sends refusals to SIGN_IN_PAGE?error=..., never PAGES.noAccess.
 */
export const SignInErrorSchema = z.enum([
  "tenant",
  "identity_conflict",
  "removed",
  "no_access",
  "expired",
  "failed",
]);
export type SignInError = z.infer<typeof SignInErrorSchema>;

/**
 * `?via=` next to `?error=no_access` on SIGN_IN_PAGE: the provider whose
 * valid identity wasn't admitted (access: the Access callback; google: the
 * Google callback). Present on every no_access redirect, absent otherwise.
 * Params: `error` (SignInError), `next` (a safe same-origin path), `via`.
 */
export const SignInViaSchema = z.enum(["access", "google"]);
export type SignInVia = z.infer<typeof SignInViaSchema>;

/** Code policy, as the server applies it and the UI shows it. */
export const CODE_POLICY = {
  length: 8,
  ttlSec: 600,
  resendAfterSec: 60,
  maxAttempts: 5,
} as const;

/**
 * POST AUTH.codeRequest (X-OA-Request: 1). 202 CodeRequested for every
 * well-formed address, eligible or not, and also when the code email pool is
 * full (the pool never causes a 429). Errors: 400 bad_request
 * (details { field: "email" }); 400 turnstile_required (TurnstileRequiredDetails)
 * when Turnstile is configured and no token was sent; 403 turnstile_failed
 * (token rejected); 403 csrf; 404 not_found (codes off); 429 rate_limited
 * (per address or IP; CodeRateLimitedDetails, Retry-After).
 * Sets __Host-oa_code. Resend = the same call again.
 */
export const CodeRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email()),
  next: z.string().optional(),
  /** Required when AuthProviders' email entry has turnstileSiteKey. */
  turnstileToken: z.string().min(1).optional(),
});
export type CodeRequest = z.infer<typeof CodeRequestSchema>;

export const CodeRequestedSchema = z.object({
  /** "b***@acme.com" */
  maskedEmail: z.string(),
  expiresIn: z.number().int(),
  resendAfter: z.number().int(),
  codeLength: z.number().int(),
});
export type CodeRequested = z.infer<typeof CodeRequestedSchema>;

/** ApiError.details on 400 turnstile_required. */
export const TurnstileRequiredDetailsSchema = z.object({
  field: z.literal("turnstile"),
  required: z.literal(true),
});
export type TurnstileRequiredDetails = z.infer<
  typeof TurnstileRequiredDetailsSchema
>;

/**
 * ApiError.details on 401 break_glass_required from GET R.me: the session is
 * the org owner's, refused by a directory customer_mismatch (P3 T18).
 * `fresh`: the session already meets break-glass (a forced Google sign-in
 * within 10 min), so the directory settings open; false: sign in again with
 * `AUTH.loginGoogle?reauth=1` first.
 */
export const BreakGlassRequiredDetailsSchema = z.object({
  fresh: z.boolean(),
});
export type BreakGlassRequiredDetails = z.infer<
  typeof BreakGlassRequiredDetailsSchema
>;

/** ApiError.details on 429 rate_limited from the code routes. */
export const CodeRateLimitedDetailsSchema = z.object({
  retryAfter: z.number().int(),
  scope: z.enum(["email", "ip"]),
});
export type CodeRateLimitedDetails = z.infer<
  typeof CodeRateLimitedDetailsSchema
>;

/** Strip whitespace and hyphens ("1234 5678"); then exactly 8 digits or it's invalid_code. */
export const normalizeCode = (code: string): string =>
  code.replace(/[\s-]/g, "");

/**
 * POST AUTH.codeVerify (X-OA-Request: 1, __Host-oa_code). 200 CodeVerified
 * (sets __Host-oa_session). 401 unauthorized (CodeVerifyFailureDetails);
 * 429 rate_limited when locked ({ retryAfter, scope: "ip" }: a per-address
 * lock would let anyone lock a victim out).
 */
export const CodeVerifySchema = z.strictObject({ code: z.string().max(64) });
export type CodeVerify = z.infer<typeof CodeVerifySchema>;

export const CodeVerifiedSchema = z.object({
  /** safeNext; the UI does a full page load there. */
  next: z.string(),
  user: MemberSchema,
  /** Capped: a guest while guests_read_only, or a restricted member. */
  readOnly: z.boolean(),
});
export type CodeVerified = z.infer<typeof CodeVerifiedSchema>;

/** ApiError.details on 401 from AUTH.codeVerify. */
export const CodeVerifyFailureDetailsSchema = z.discriminatedUnion("reason", [
  z.object({
    reason: z.literal("invalid_code"),
    attemptsLeft: z.number().int(),
  }),
  /** Expired or killed after maxAttempts: request a new code. */
  z.object({ reason: z.literal("expired") }),
  /** No or bad __Host-oa_code cookie: start over. */
  z.object({ reason: z.literal("no_pending") }),
]);
export type CodeVerifyFailureDetails = z.infer<
  typeof CodeVerifyFailureDetailsSchema
>;

/**
 * Reference only (server-internal): the __Host-oa_session payload. p is the
 * sign-in method; t the tenant (the verified Google hd, or the email domain
 * of a domain-code session); pd a personal Google account's email domain; e
 * the per-user session epoch.
 */
export type SessionPayload = {
  uid: string;
  exp: number;
  iat: number;
  p: "access" | "google" | "code" | "dev" | "test";
  t?: string;
  /**
   * A personal Google account's (no hd) email domain: the session ends once
   * that domain is one of AUTH_DOMAINS (they sign in through Workspace).
   */
  pd?: string;
  e: number;
  /**
   * Google auth_time (ms) of a forced re-authentication (max_age=0), set
   * only when it was within 10 minutes at sign-in: P3 T18's break-glass.
   */
  a?: number;
};
