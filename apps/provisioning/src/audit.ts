import type { RouteId } from "@oa/shared/provisioning";
import type { Env } from "./env.js";
import { NotImplemented } from "./errors.js";
import type { Principal } from "./principal.js";
import type { Surface } from "./routes/invoke.js";

/**
 * A sign-in outcome before any principal exists (4.9 `signin.ok`,
 * `signin.refused`: `unknown_sub`, `not_listed`, `token_invalid`). Written as
 * `actor_kind = 'admin'`, `actor_label` the email when known.
 */
export type SigninActor = {
  kind: "signin";
  email?: string;
  sub?: string;
};

/** One admin_audit row (0008, 4.9, 9A.8). */
export type AuditEntry = {
  action: string;
  actor: Principal | SigninActor | `system:${string}`;
  /** The NOT NULL `outcome` column; not derivable from `code`. */
  outcome: "ok" | "refused" | "error";
  route?: RouteId;
  installId?: string;
  jobId?: string;
  /** job.accepted, job.replayed, job.refused: the request's idempotency id. */
  requestId?: string;
  code?: string;
  /** Raw ipKey; audit() stores only `ip_hmac` (4.9: no raw IPs). */
  ip?: string;
  /** Raw email for `email_hmac` (sign-in refusals); never stored raw. */
  email?: string;
  surface?: Surface;
  detail?: Record<string, unknown>;
};

/**
 * Appends one admin_audit row. W4 builds the body: `ip_hmac` and
 * `email_hmac` are HMAC-SHA256(ADMIN_SESSION_KEY, value) truncated to 16
 * bytes, computed here so no caller keeps its own copy.
 */
export async function audit(_env: Env, _entry: AuditEntry): Promise<void> {
  throw new NotImplemented("audit");
}
