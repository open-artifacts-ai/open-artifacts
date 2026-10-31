import type { RouteId } from "@oa/shared/provisioning";
import type { Env } from "./env.js";
import { factsOf } from "./facts.js";
import type { Principal } from "./principal.js";
import type { Surface } from "./routes/invoke.js";

/**
 * A sign-in outcome before any principal exists (4.9 `signin.ok`,
 * `signin.refused`: `unknown_sub`, `not_listed`, `token_invalid`). Written as
 * `actor_kind = 'admin'`; `actor_label` is the email on `signin.ok` only, a
 * refusal keeps the email HMAC only (4.3) and the label `signin`.
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

/** HMAC-SHA256(ADMIN_SESSION_KEY, value), first 16 bytes, hex (4.9: no raw IPs). */
export async function hmac16(env: Env, value: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.ADMIN_SESSION_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(value)),
  );
  return Array.from(mac.subarray(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export const SIGNIN_LABEL = "signin";

const actorOf = (e: AuditEntry) => {
  const a = e.actor;
  if (typeof a === "string")
    return { kind: "system", label: a.slice("system:".length), tokenId: null };
  if (a.kind === "signin")
    return {
      kind: "admin",
      label: e.outcome === "ok" && a.email ? a.email : SIGNIN_LABEL,
      tokenId: null,
    };
  return { kind: a.kind, label: a.label, tokenId: a.tokenId ?? null };
};

/** The raw email behind `email_hmac`: the entry's, else a sign-in actor's. */
const emailOf = (e: AuditEntry) =>
  e.email ??
  (typeof e.actor !== "string" && e.actor.kind === "signin"
    ? e.actor.email
    : undefined);

/**
 * The detail column: the caller's detail, the route, and for a token the
 * minting admin; an MCP call adds surface, tool, via, client and
 * clientVersion (9A.8; via and client once W5b sets them on the principal).
 */
function detailOf(e: AuditEntry): Record<string, unknown> | null {
  const d: Record<string, unknown> = { ...e.detail };
  if (e.route) d.route = e.route;
  const token =
    typeof e.actor !== "string" && e.actor.kind === "token"
      ? factsOf(e.actor)
      : null;
  if (token) d.admin = token.email ?? null;
  if (e.surface?.kind === "mcp") {
    d.surface = "mcp";
    d.tool = e.surface.tool;
    if (token?.tokenKind) {
      d.via = token.tokenKind;
      d.client = token.client ?? null;
    }
    d.clientVersion = e.surface.clientVersion;
  }
  return Object.keys(d).length ? d : null;
}

/**
 * The INSERT for one admin_audit row, for a caller that writes it in the
 * same D1 batch as the change it records (job.accepted with its job).
 * `ip_hmac` and `email_hmac` are HMAC-SHA256(ADMIN_SESSION_KEY, value)
 * truncated to 16 bytes, computed here so no caller keeps its own copy.
 */
export async function auditStatement(
  env: Env,
  e: AuditEntry,
): Promise<D1PreparedStatement> {
  const a = actorOf(e);
  const detail = detailOf(e);
  const email = emailOf(e);
  return env.PLATFORM_DB.prepare(
    `INSERT INTO admin_audit (at, actor_kind, actor_label, token_id, action, install_id, job_id, request_id, outcome, code, ip_hmac, email_hmac, detail)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).bind(
    Date.now(),
    a.kind,
    a.label,
    a.tokenId,
    e.action,
    e.installId ?? null,
    e.jobId ?? null,
    e.requestId ?? null,
    e.outcome,
    e.code ?? null,
    e.ip ? await hmac16(env, e.ip) : null,
    email ? await hmac16(env, email) : null,
    detail ? JSON.stringify(detail) : null,
  );
}

/** Appends one admin_audit row (4.9). */
export async function audit(env: Env, entry: AuditEntry): Promise<void> {
  await (await auditStatement(env, entry)).run();
}
