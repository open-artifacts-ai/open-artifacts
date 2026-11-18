// An instance's own login-domain change (open-artifacts#2520 slice 3): what an
// install sends the platform through the LoginGate binding (ctx.props.LOGIN),
// and what comes back. One definition both repos use; it mirrors the cloud's
// apps/provisioning routes/login-change.ts (the body is exactly six fields, the
// answer 202 { ok, applying } or a fixed code).
//
// The body names no install: the gate stamps it. It is signed with one of the
// install's registry keys (x-oa-kid, x-oa-sig over the path, the kid and the
// exact body text), with `ts` inside the skew window and a nonce never reused.
import { z } from "zod";

export const LOGIN_DOMAINS_PATH = "/login-domains";
/** The most domains a change may name. */
export const LOGIN_DOMAINS_MAX = 5;
/** A request nonce: 16 to 64 URL-safe characters, never reused by an install. */
export const LOGIN_DOMAINS_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** The owner's user id as the platform accepts it. */
export const LOGIN_OWNER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A lowercase hostname with a registrable suffix (the platform's DOMAIN). */
export const LOGIN_DOMAIN_RE =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** The request: exactly these six fields. */
export const LoginDomainsBodySchema = z.strictObject({
  /** ms since the epoch; the platform refuses a skew past ASSERTION_SKEW_MS. */
  ts: z.number().finite(),
  nonce: z.string().regex(LOGIN_DOMAINS_NONCE_RE),
  /** The owner who asked; the instance checked them. */
  ownerUserId: z.string().regex(LOGIN_OWNER_ID_RE),
  /** The verified Workspace domain of the owner's fresh Google login, or "" (a Gmail owner proves none). */
  hd: z.union([z.literal(""), z.string().regex(LOGIN_DOMAIN_RE)]),
  /** The new list; it replaces the install's AUTH_DOMAINS. Each must equal `hd`. */
  domains: z.array(z.string()),
  /** Anyone at the one domain joins as a member. Needs exactly one domain. */
  autoJoin: z.boolean(),
});
export type LoginDomainsBody = z.infer<typeof LoginDomainsBodySchema>;

/** 202: accepted; the platform redeploys the install in about a minute. */
export const LoginDomainsAcceptedSchema = z.strictObject({
  ok: z.literal(true),
  applying: z.literal(true),
});
export type LoginDomainsAccepted = z.infer<typeof LoginDomainsAcceptedSchema>;

/** A refusal's `error` code: fixed, nothing else. */
export const LoginDomainsErrorSchema = z.enum([
  "bad_body",
  "bad_signature",
  "install_not_serving",
  "plan_required",
  "google_required",
  "email_codes_on",
  "domain_unproven",
  "unknown_install",
  "replay",
  "no_vars",
  "apply_pending",
  "too_many_domains",
  "bad_domain",
  "auto_join_needs_one_domain",
  "vars_refused",
  "rate_limited",
  "unavailable",
]);
export type LoginDomainsError = z.infer<typeof LoginDomainsErrorSchema>;
