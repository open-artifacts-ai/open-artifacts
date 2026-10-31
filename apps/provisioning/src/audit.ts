import type { RouteId } from "@oa/shared/provisioning";
import type { Env } from "./env.js";
import { NotImplemented } from "./errors.js";
import type { Principal } from "./principal.js";
import type { Surface } from "./routes/invoke.js";

/** One admin_audit row (4.9, 9A.8). */
export type AuditEntry = {
  action: string;
  actor: Principal | `system:${string}`;
  route?: RouteId;
  installId?: string;
  jobId?: string;
  code?: string;
  surface?: Surface;
  detail?: Record<string, unknown>;
};

/** Appends one admin_audit row. W4 builds the body. */
export async function audit(_env: Env, _entry: AuditEntry): Promise<void> {
  throw new NotImplemented("audit");
}
