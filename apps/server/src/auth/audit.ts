import { type LogExtra, logInfo, logWarn, redact } from "../log.js";
import type { SessionProvider } from "./session.js";

/**
 * OIDC failure stages as logged on an auth event: fixed values only. Raw
 * provider stages with a variable part (`token_http_<status>`) collapse to
 * their prefix; anything unknown is "failed".
 */
export const OIDC_STAGES = [
  "no_state_cookie",
  "state_bad_sig",
  "state_expired",
  "state_mismatch",
  "idp_error",
  "no_code",
  "token_http",
  "token_fetch",
  "token_bad_json",
  "no_id_token",
  "jwt_verify",
  "aud",
  "azp",
  "nonce",
  "email",
  "email_unverified",
  "tenant",
  "claims",
] as const;
export type OidcStage = (typeof OIDC_STAGES)[number];

const STAGES: ReadonlySet<string> = new Set(OIDC_STAGES);

/** A raw failure stage as an OidcStage enum value, else "failed". */
export function oidcStage(s: string | null | undefined): OidcStage | "failed" {
  if (!s) return "failed";
  if (s.startsWith("token_http_")) return "token_http";
  return STAGES.has(s) ? (s as OidcStage) : "failed";
}

/** One sign-in outcome (Workers Logs). */
export type SignInEvent = {
  provider: SessionProvider;
  outcome: "ok" | "refused" | "error";
  /** Why, for refusals and errors: a fixed stage or SignInError. */
  stage?: string;
  uid?: string;
  tenant?: string;
};

/**
 * Every sign-in log line. Never an email, code, token, state, nonce or key:
 * only enums, the user id and the verified tenant. The audit log (P3/M4)
 * adds a D1 sink behind logAuth.
 */
export type AuthEvent =
  | ({ evt: "auth" } & SignInEvent)
  | {
      evt: "oidc_fail";
      stage: string;
      [k: string]: string | undefined;
    }
  | { evt: "code_abuse"; scope: "email" | "send" }
  | { evt: "directory_sync_failed" }
  /** revokeUserLive could not close a user's live sockets (P3 T7): alert. */
  | { evt: "presence_revoke_failed"; uid: string }
  | { evt: "email_drift"; outcome: "kept" };

/** Letters and underscores only: an enum or error code, never an address, URL or token. */
const ENUM = /^[A-Za-z_]+$/;

/**
 * Logs a sign-in event via log.ts: outcomes at info, the rest at warn. String
 * values other than enum-shaped ones pass through redact() as a backstop.
 */
export function logAuth(e: SignInEvent | AuthEvent): void {
  const { evt, ...rest } = "evt" in e ? e : { evt: "auth" as const, ...e };
  const extra: LogExtra = {};
  for (const [k, v] of Object.entries(rest))
    extra[k] = typeof v === "string" && !ENUM.test(v) ? redact(v) : v;
  if (evt === "auth") logInfo(evt, extra);
  else logWarn(evt, undefined, extra);
}
