// Provisioning enum values and job steps (design v7 3.2, 5.8) as plain
// constants: no zod, so the scheduler imports them through
// `@oa/shared/provisioning/enum-values` without bundling zod. enums.ts builds the
// schemas from these arrays and re-exports them.

export const INSTALL_STATES = [
  "provisioning",
  "active",
  "suspended",
  "deleting",
  "deleted",
  "failed",
] as const;
export type InstallState = (typeof INSTALL_STATES)[number];
export const SERVING_MODES = [
  "serving",
  "paused",
  "closed",
  "unmapped",
] as const;
export type ServingMode = (typeof SERVING_MODES)[number];
export const HEALTH_VALUES = ["ok", "failing", "unknown"] as const;
export type Health = (typeof HEALTH_VALUES)[number];
export const AUTH_PROVIDERS = ["google", "email"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export const JOB_KINDS = [
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
  // A live install's own change (#1008): R29's mode, R30's copy.
  "update",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TOKEN_SCOPES = [
  "installs:read",
  "installs:write",
  "installs:delete",
  "installs:pii",
  "audit:read",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const PRINCIPAL_KINDS = [
  "admin",
  "token",
  "user",
  "oidc",
  "system",
  // Staging's agent admin (#1053): its own kind, so every admin check fails
  // closed for it.
  "test-admin",
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
/** "oat": an `oat_` bearer minted in the panel; "oauth": an MCP consent grant. */
export const TOKEN_KINDS = ["oat", "oauth"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export const PROVISIONING_ENVS = ["staging", "prod"] as const;
export type ProvisioningEnv = (typeof PROVISIONING_ENVS)[number];

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
  update: ["recheck", "precheck", "update_vars", "mode_live", "done"],
  /**
   * R26 with `revoke: true` (10.1): the same job kind (0008's CHECK is
   * unchanged), not a JobKind. Revokes the install's live redline-* PATs
   * only (redlinePatsToRevoke); with none left it is a no-op `done`.
   */
  redline_creds_revoke: ["recheck", "revoke", "done"],
  /**
   * R30 (#1008): the update kind with `args.oauthCopy === true`, not a
   * JobKind, for the same reason: 0008's CHECK is unchanged.
   */
  oauth_copy: [
    "recheck",
    "precheck",
    "put_key",
    "key_live",
    "copy",
    "drop_key",
    "verify",
    "done",
  ],
} as const satisfies Record<
  JobKind | "redline_creds_revoke" | "oauth_copy",
  readonly string[]
>;

/**
 * A job's steps from its kind and `jobs.args`: `redline_creds` with
 * `args.revoke === true` runs JOB_STEPS.redline_creds_revoke, `update` with `args.oauthCopy === true` runs JOB_STEPS.oauth_copy; every
 * other case is JOB_STEPS[kind].
 */
export function jobStepsFor(
  kind: JobKind,
  args?: { readonly revoke?: unknown; readonly oauthCopy?: unknown } | null,
): readonly string[] {
  if (kind === "redline_creds" && args?.revoke === true)
    return JOB_STEPS.redline_creds_revoke;
  if (kind === "update" && args?.oauthCopy === true)
    return JOB_STEPS.oauth_copy;
  return JOB_STEPS[kind];
}

/**
 * Where a job's last failed attempt stopped (#995, jobs.fail_at): a fixed
 * point, with the HTTP status of the failing call in jobs.fail_status. Never
 * error text. redline_creds names each of its calls.
 */
export const JOB_FAIL_POINTS = [
  "token_check",
  "hook_key_put",
  "hook_key_live",
  "test_session",
  "list_tokens",
  "mint_token",
  "new_token_check",
  "revoke_token",
  "seal",
  // #1008's calls to the install.
  "oauth_healthz",
  "copy_key_live",
  "copy_page",
] as const;
export type JobFailPoint = (typeof JOB_FAIL_POINTS)[number];

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
  "fleet_halted",
  "version_skew",
] as const;
export type AlertKey = (typeof ALERT_KEYS)[number];
