import type { DirectorySync } from "./directory/sync-do.js";
import type { ArtifactRuntime } from "./runtime/do.js";
import type { UserPresence } from "./runtime/presence.js";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  /**
   * The OAuth provider's KV namespace. Required while OAUTH_STORE is kv
   * (the default) or dual; unbound is fine with d1 (mcp/oauth-store.ts).
   * Reach it only through oauthEnv(env).OAUTH_KV.
   */
  OAUTH_KV?: KVNamespace;
  /**
   * Where the OAuth provider's records live (mcp/oauth-store.ts): "kv"
   * (unset: today's behaviour), "dual" (D1 and KV, reads D1 first) or "d1"
   * (the install's D1 only). Anything else fails clearly (503).
   */
  OAUTH_STORE?: string;
  /**
   * "1": kv or dual may serve after this install served in d1 mode
   * (otherwise 503 oauth_store_misconfigured). Only after the OAuth keys
   * were emptied from KV (every agent reconnects); see mcp/oauth-store.ts.
   */
  OAUTH_STORE_ROLLBACK?: string;
  ARTIFACT_RUNTIME: DurableObjectNamespace<ArtifactRuntime>;
  /**
   * One UserPresence DO per user (runtime/presence.ts): closes a revoked
   * user's live sockets at once. Unbound, sockets keep only the 10 minute
   * TTL ceiling (logged as presence_unbound).
   */
  USER_PRESENCE?: DurableObjectNamespace<UserPresence>;
  /**
   * One DirectorySync DO per install (directory/sync-do.ts): Google polling,
   * reconcile and queued access jobs. Unbound, directory sync never runs.
   */
  DIRECTORY_SYNC?: DurableObjectNamespace<DirectorySync>;
  ASSETS: Fetcher;
  /**
   * Anonymous limiter, 30 per key per minute (wrangler `ratelimits`): anonymous
   * data writes per IP, subscriptions, anonId mints and the OAuth endpoints.
   * Bound in deployed Workers and in the test pool; unbound outside
   * ENVIRONMENT=dev, anonymous access fails closed (503).
   */
  RL_ANON?: RateLimit;
  /**
   * Optional limiter for anonymous data writes only, keyed per IP. Bound, it
   * replaces RL_ANON for those writes (except with HOSTED=1, where both
   * apply), so ANON_WRITES_PER_MIN above RL_ANON's 30 can take effect.
   * Unbound (the default), RL_ANON applies as before. Setup's wrangler
   * template doesn't carry it yet, and setup regenerates wrangler.jsonc, so a
   * hand-added binding is dropped on the next deploy (the safe direction).
   */
  RL_ANON_WRITES?: RateLimit;
  /** Sign-in code limiter, keyed `${installKey}:${ip}`; unbound in the test pool. */
  RL_AUTH?: RateLimit;
  /** GET R.directoryGroups limiter, keyed per caller (P3 T13); unbound: unlimited. */
  RL_DIRECTORY?: RateLimit;
  /**
   * Optional service binding to the auth broker (self-host on the broker's
   * account). Else the invocation's ctx.props.AUTH_BROKER (hosted), else
   * AUTH_BROKER_URL over HTTPS (never on HOSTED=1); auth/broker-transport.ts.
   */
  BROKER?: Fetcher;
  /**
   * Optional service binding to the directory broker; the same precedence as
   * BROKER, with ctx.props.DIRECTORY_BROKER and DIRECTORY_BROKER_URL.
   */
  DIRECTORY_BROKER?: Fetcher;
  /** Browser Run, for server-side thumbnails (services/thumbs.ts); optional. */
  BROWSER?: Fetcher;
  /** Optional Email Service send binding; invite/share emails are off without it. */
  EMAIL?: SendEmail;
  /**
   * "on" enables server thumbnails (with BROWSER bound); anything else, unset
   * included, is off. Setup sets it from the plan (Paid): a Free account's
   * alarm CPU (10 ms) can't afford a capture.
   */
  SERVER_THUMBNAILS?: string;
  /**
   * The Workers plan: "paid", else free (unset or anything else; planOf).
   * Sets the data-doc limit and the /mcp body cap. Setup sets it from the
   * detected plan.
   */
  PLAN?: string;
  /** "off" (any case) makes /skill.md 404 and drops the skill resource; public otherwise. */
  SKILL_MD?: string;
  /**
   * An artifact id. Signed-out visitors at "/" get a 302 to its chromeless
   * viewer when it is live and public; unset, empty, invalid, private,
   * missing or deleted leaves "/" unchanged.
   */
  PUBLIC_HOME?: string;
  /**
   * Anonymous writes per IP per artifact per minute, enforced in the DO
   * (anonWritesPerMin: 1..600, default LIMITS.anonWritesPerMinPerIp). The
   * RL_ANON binding's own per-IP limit (wrangler `ratelimits`, 30) applies
   * first, so a higher value has no effect until setup supports the
   * RL_ANON_WRITES binding.
   */
  ANON_WRITES_PER_MIN?: string;
  /**
   * Per-doc data limit in bytes (dataLimits; empty or unset: the plan's
   * default). Clamped to 256 KB on Free, 1920 KB on Paid.
   */
  DATA_DOC_BYTES?: string;
  /**
   * Data/storage writes per artifact per UTC day (dataLimits; empty or unset:
   * 10,000). Clamped to 10,000 on Free, 1,000,000 on Paid.
   */
  DATA_DAILY_WRITES?: string;
  // vars
  APP_HOST: string;
  CONTENT_HOST: string;
  OWNER_EMAIL: string;
  ENVIRONMENT: "dev" | "production";
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_CLIENT_ID: string;
  /**
   * Space-separated https origins allowed to frame /a/:id/full (and the
   * content host beneath it); unset/empty = none. Validated in http/embed.ts.
   */
  EMBED_ORIGINS?: string;
  /**
   * "1" keeps EMBED_ORIGINS entries that are same-site with APP_HOST (they
   * get Lax cookies in the frame); anything else drops them. Set it only once
   * the client embed mode is deployed.
   */
  EMBED_ALLOW_SAME_SITE?: string;
  /** Sender for invite/share emails (an onboarded Email Service domain). */
  EMAIL_FROM?: string;
  /**
   * Direct sign-in (auth/config.ts). Comma list of "access", "google",
   * "email"; unset means "access" (Cloudflare Access, today's behaviour).
   */
  AUTH_PROVIDERS?: string;
  /** Comma list of verified domains: the Google `hd` allow-list and code domains. */
  AUTH_DOMAINS?: string;
  /** "member": anyone in AUTH_DOMAINS joins as a member; anything else: invite only. */
  AUTH_DOMAIN_JOIN?: string;
  /** "on": domain members may sign in with emailed codes (trial; only while Google is off). */
  EMAIL_CODE_DOMAIN?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Hosted broker origin (https); set, it selects the broker transport. */
  AUTH_BROKER_URL?: string;
  /**
   * Hosted install id (broker registry key, rate-limit keys). Opaque, not a
   * secret; /healthz echoes the trimmed value as `installId`, absent when
   * unset or empty. It proves routing, not authenticity: never an auth signal.
   */
  INSTALL_ID?: string;
  TURNSTILE_SITE_KEY?: string;
  /** Code emails per UTC day (1..10000, default 200). */
  CODE_EMAILS_PER_DAY?: string;
  /** "1" turns the /__test/* hooks on (staging only; also needs the build flag and the key). */
  TEST_HOOKS?: string;
  /** The only email domain /__test/* acts on, compared exactly (lowercase). Unset: hooks off. */
  TEST_DOMAIN?: string;
  /** Invite and share emails per UTC day, instance-wide (1..100000, default 100); set per install by Platform. */
  EMAIL_DAILY_CAP?: string;
  /** "1" on hosted installs (Me.instance.hosted). */
  HOSTED?: string;
  /**
   * Comma list of FeatureFlag (@oa/shared parseFeatures). Unset (self-host
   * default): today's behaviour. usage_off: R.usage is 404 (hosted, P3 T19).
   */
  FEATURES?: string;
  /**
   * Hosted billing tier (trial | team | business; @oa/shared parseTier), set
   * by provisioning, which derives FEATURES from it. Reported only
   * (Me.instance.tier, hosted installs): behaviour always follows FEATURES.
   */
  TIER?: string;
  // secrets
  ACCESS_CLIENT_SECRET: string;
  /** Google client secret (direct transport only). */
  GOOGLE_CLIENT_SECRET?: string;
  /** Ed25519 private key, PKCS#8 DER base64url (broker transport). */
  BROKER_SIGNING_KEY?: string;
  /**
   * P3 directory sync (directory/transport.ts). The AES-GCM key sealing the
   * Google refresh token at rest (32+ chars; HKDF "oa:directory-token").
   * Hosted: P1 provisioning; self-host: setup generates it when the
   * directory client is set. Unset: directory sync is off.
   */
  DIRECTORY_TOKEN_KEY?: string;
  /**
   * Hosted directory broker origin (https://directory.<app domain>); set, it
   * selects the broker transport for directory sync. Never AUTH_BROKER_URL:
   * the sign-in and directory brokers are separate Workers.
   */
  DIRECTORY_BROKER_URL?: string;
  /** The sealing key's version, in the AD (install:version); default "1". */
  DIRECTORY_TOKEN_KEY_VERSION?: string;
  /**
   * Self-host direct transport only: the install's own Google app for
   * directory consent. HOSTED=1 with either set resolves to no directory.
   */
  GOOGLE_DIRECTORY_CLIENT_ID?: string;
  GOOGLE_DIRECTORY_CLIENT_SECRET?: string;
  TURNSTILE_SECRET?: string;
  /** Bearer key for /__test/* (32+ chars). */
  TEST_HOOK_KEY?: string;
  SESSION_SECRET: string;
  CONTENT_SIGNING_KEY: string;
  ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID: string;
  /** This Worker's script name (filters CPU analytics); unset -> no CPU metrics. */
  WORKER_NAME?: string;
  /** OAUTH_KV's namespace id (filters KV analytics); unset -> no kv_writes. */
  OAUTH_KV_ID?: string;
}
