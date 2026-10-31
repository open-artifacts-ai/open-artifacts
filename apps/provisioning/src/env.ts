import type {
  ProvisionerRpc,
  ProvisioningEnv,
  WorkflowLike,
} from "@oa/shared/provisioning";

/** The bindings of oa-<p>-provisioning (design v7 2.4, wrangler.jsonc). */
export interface Env {
  PLATFORM_DB: D1Database;
  /** Workflows on oa-<p>-provisioner (script_name). */
  PROVISION_INSTALL: WorkflowLike;
  MANAGE_INSTALL: WorkflowLike;
  /** Entrypoint ProvisionerRpc: exactly three read-only methods (2.6). */
  PROVISIONER: ProvisionerRpc;
  /** Broker redeem only (4.3). */
  AUTH_BROKER: Fetcher;
  /** Self-serve producer (post-M1). */
  SIGNUPS: Queue;
  /** The admin SPA (single-page-application, Worker first). */
  ASSETS: Fetcher;
  /** Rate limits (4.7, 9A.7); unbound fails closed with 503 unavailable. */
  RL_PV_PRE_IP?: RateLimit;
  RL_PV_SIGNIN_IP?: RateLimit;
  RL_PV_WRITE?: RateLimit;
  RL_PV_READ?: RateLimit;
  RL_PV_SLUG_IP?: RateLimit;
  RL_PV_OAUTH_IP?: RateLimit;
  /** MCP OAuth clients, grants and tokens; the library's store (9A.3.1). */
  OAUTH_KV: KVNamespace;
  /** Secrets (4.6). */
  ADMIN_SESSION_KEY: string;
  ADMIN_BROKER_KEY: string;
  OA_ENV: ProvisioningEnv;
  /** Committed `email:sub` comma list (4.1), read on every request. */
  ADMIN_IDENTITIES: string;
  APP_DOMAIN: string;
  SIGNUPS_ENABLED: "false" | "true" | "test-users";
  SELF_SERVE_TIER: string;
  /** Exact redirect URIs besides loopback (9A.3.1), comma list. */
  MCP_REDIRECT_URIS: string;
  /** Staging only (4.4). */
  OIDC_AUDIENCE?: string;
  OIDC_ENVIRONMENT?: string;
  OIDC_JOB_WORKFLOW_REFS?: string;
  OIDC_REPOSITORY?: string;
  OIDC_REPOSITORY_ID?: string;
}
