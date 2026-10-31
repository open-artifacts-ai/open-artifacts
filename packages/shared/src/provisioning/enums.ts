import { z } from "zod";

export { type Tier, TierSchema } from "../hosted/core.js";

export const InstallStateSchema = z.enum([
  "provisioning",
  "active",
  "suspended",
  "deleting",
  "deleted",
  "failed",
]);
export type InstallState = z.infer<typeof InstallStateSchema>;
export const ServingModeSchema = z.enum([
  "serving",
  "paused",
  "closed",
  "unmapped",
]);
export type ServingMode = z.infer<typeof ServingModeSchema>;
export const HealthSchema = z.enum(["ok", "failing", "unknown"]);
export type Health = z.infer<typeof HealthSchema>;
export const AuthProviderSchema = z.enum(["google", "email"]);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;
export const JobKindSchema = z.enum([
  "create",
  "retry",
  "upgrade",
  "rollback",
  "suspend",
  "resume",
  "delete",
  "restore",
  "purge",
  "discard",
  "release_lease",
  "cleanup",
  // Staging only.
  "redline_creds",
  // Reserved for M1.1: "update".
]);
export type JobKind = z.infer<typeof JobKindSchema>;
export const JobStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export const TokenScopeSchema = z.enum([
  "installs:read",
  "installs:write",
  "installs:delete",
  "installs:pii",
  "audit:read",
]);
export type TokenScope = z.infer<typeof TokenScopeSchema>;
export const PrincipalKindSchema = z.enum([
  "admin",
  "token",
  "user",
  "oidc",
  "system",
]);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;
/** "oat": an `oat_` bearer minted in the panel; "oauth": an MCP consent grant. */
export const TokenKindSchema = z.enum(["oat", "oauth"]);
export type TokenKind = z.infer<typeof TokenKindSchema>;
export const EnvSchema = z.enum(["staging", "prod"]);
export type ProvisioningEnv = z.infer<typeof EnvSchema>;

const CREATE_STEPS = [
  "admit",
  "recheck",
  "reserve",
  "release_gate",
  "upload",
  "verify_clean",
  "health",
  "route",
  "enable_signin",
  "active",
  "reachable",
  "notify",
  "done",
] as const;

/** The Workflow steps per job kind, in order (Job.steps). */
export const JOB_STEPS = {
  create: CREATE_STEPS,
  retry: CREATE_STEPS,
  upgrade: [
    "recheck",
    "release_gate",
    "upload",
    "verify_clean",
    "health",
    "done",
  ],
  rollback: ["recheck", "upload", "verify_clean", "health", "done"],
  suspend: ["recheck", "pause", "record", "done"],
  resume: ["recheck", "record", "unpause", "done"],
  delete: ["recheck", "close", "record", "done"],
  restore: ["recheck", "record", "reopen", "done"],
  purge: ["recheck", "unroute", "revoke_directory", "teardown", "done"],
  discard: ["recheck", "free", "done"],
  release_lease: ["recheck", "release", "done"],
  cleanup: ["release_lease", "sweep_tokens", "settle", "done"],
  redline_creds: ["recheck", "rotate_hook_key", "mint", "seal", "done"],
} as const satisfies Record<JobKind, readonly string[]>;

/**
 * The scheduler's alert keys (5.8). C2 ships the condition SQL per key; the
 * scheduler and R27 run the same queries.
 */
export const ALERT_KEYS = [
  "signin_refused_burst",
  "admin_unknown_sub",
  "job_failed",
  "job_retrying",
  "job_stuck",
  "prod_dirty",
  "prodclean_failed",
  "upgrade_incomplete",
  "unreachable_after_route",
  "purge_stuck",
  "welcome_unsent",
  "signup_cap",
  "oauth_register_flood",
  "token_expiring",
  "token_invalid",
] as const;
export type AlertKey = (typeof ALERT_KEYS)[number];
