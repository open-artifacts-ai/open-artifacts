import type { BusHub } from "./bus/hub.js";
import type { DirectorySync } from "./directory/sync-do.js";
import type { DocRoom } from "./docs/room.js";
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
   * The name of the Queue Cloudflare Email Service publishes sending events
   * to (message.bounced, message.failed, message.complained), when the
   * platform has bound this Worker as its consumer (#2650). Unset: the queue
   * handler ignores any batch and nothing changes (self-host).
   */
  EMAIL_EVENTS_QUEUE?: string;
  /**
   * "on": this hosted install pulls bounce and complaint events from the
   * platform over the LoginGate on its frequent system tick (#2650), instead of
   * a Queue consumer. Off by default; self-host never reads it.
   */
  EMAIL_EVENTS_PULL?: string;
  /**
   * "on": this hosted install asks the platform's opt-out list before it
   * emails an outside address, and reports opt-outs to it (#2652). The
   * platform sets it once its routes are live; unset, hosted behaves as before.
   * Self-host never reads it.
   */
  OPTOUT_PLATFORM?: string;
  /** Secret, held by hosted installs only: the key of h1 = HMAC(key, address), what the install sends the platform instead of an address (#2652). */
  OPTOUT_HASH_KEY?: string;
  /**
   * Secret, minted once per install (the provisioner on hosted, setup on
   * self-host) and never rotated (#2820): 48 random bytes, base64url without
   * padding, used as the raw HMAC-SHA256 key that hashes opted-out addresses.
   * Distinct from OPTOUT_HASH_KEY (the hosted-wide platform list). Unset: the
   * opt-out table keeps the plain SHA-256, as before. Never logged or sent.
   */
  INSTALL_OPTOUT_KEY?: string;
  /**
   * The instance's Web Push key pair (#2512 S5), base64url: the 65-byte
   * uncompressed P-256 public point and the 32-byte private scalar. Secrets
   * the platform sets on hosted and setup sets on self-host; the code never
   * makes one. Either missing: push is off and every push route answers 404.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** The platform's public unsubscribe page (on the sign-up host), the base of every outside share email's opt-out link (#2652). Unset with the switch on: no email goes out. */
  OPTOUT_UNSUBSCRIBE_URL?: string;
  /**
   * One DirectorySync DO per install (directory/sync-do.ts): Google polling,
   * reconcile and queued access jobs. Unbound, directory sync never runs.
   */
  DIRECTORY_SYNC?: DurableObjectNamespace<DirectorySync>;
  /**
   * One BusHub DO per member (bus/hub.ts, #1291), named "bus:" + user id.
   * Bound in every config since #1315 (the class shipped unbound in 0.109.0,
   * tag v4). Unbound, every /bus route answers 404; HOSTED=1 answers 404
   * too, until #1299.
   */
  BUS_HUB?: DurableObjectNamespace<BusHub>;
  /**
   * One DocRoom DO per collaborative doc (docs/room.ts, #1100), named by the
   * artifact id. The class ships unbound (tag v5) one release before the
   * route binds and uses it; bound only in the test pool for now.
   */
  DOC_ROOM?: DurableObjectNamespace<DocRoom>;
  ASSETS: Fetcher;
  /**
   * Anonymous limiter, 30 per key per minute (wrangler `ratelimits`): anonymous
   * data writes per IP, subscriptions, anonId mints and the OAuth endpoints.
   * Bound in deployed Workers and in the test pool; unbound outside
   * ENVIRONMENT=dev, anonymous access fails closed (503).
   */
  RL_ANON?: RateLimit;
  /**
   * Install-wide ceiling on anonymous data writes per IP (IPv4, or the IPv6
   * /64), keyed `ip:{key}` with no artifact id: 4x the default
   * ANON_WRITES_PER_MIN (120 per minute, wrangler `ratelimits`). The normal
   * budget is per (artifact, IP), counted in the artifact's DO; a write must
   * pass both (#687). Unbound (a wrangler config from before it), RL_ANON's
   * 30 stands in. The 120 is this binding's fixed limit, set in wrangler
   * `ratelimits`; ANON_WRITES_PER_MIN does not change it.
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
  /**
   * Workers Images, to downscale a large comment picture for an agent
   * (services/comment-pictures.ts). Optional: a picture already small enough
   * needs no binding; a large one answers a clear tool error without it.
   */
  IMAGES?: ImagesBinding;
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
   * install-wide per-IP ceiling (RL_ANON_WRITES, 120) also applies, so a value
   * above 120 has no effect until that binding's limit is raised.
   */
  ANON_WRITES_PER_MIN?: string;
  /**
   * An unsupported preview: "1" opens doc creation as if DOC_SWITCH.creation
   * were true (docCreationOpen), so docs can be tried before the switch ships.
   * A plain runtime var: the release bundle honours it, so a prod install must
   * never carry it (this repo's public configs and the setup steps do not;
   * the cloud deploy and provisioner refuse it). docsAvailable's paid-plan
   * rule still applies.
   */
  DOCS_PREVIEW?: string;
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
  /**
   * Hosted billing's free-tier caps (billing/caps.ts): positive integers,
   * each OFF until set (unset, empty or invalid never refuses). Free tier
   * only: stored version bytes per instance, live-data docs per artifact,
   * live-data writes per artifact per UTC day. 403 plan_limit past one.
   */
  FREE_STORAGE_BYTES?: string;
  FREE_DATA_DOCS?: string;
  FREE_DATA_DAILY_WRITES?: string;
  FREE_DATA_DAILY_WRITES_TOTAL?: string;
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
  /**
   * Hosted only: "owner" lifts the invite-only force on AUTH_DOMAIN_JOIN
   * "member". The platform sets it after the owner's proven login-settings
   * change (#2520); any other value, or none, keeps hosted invite-only.
   */
  AUTH_DOMAIN_JOIN_SOURCE?: string;
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
  /** Comment notice emails per UTC day, instance-wide (1..100000, default EMAIL_DAILY_CAP's value); a bucket apart from it (#1467). */
  COMMENT_EMAIL_DAILY_CAP?: string;
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
  /**
   * Bearer key for POST /__oa/oauth-store/copy (the OAuth KV -> D1 copy,
   * mcp/oauth-copy.ts); 32+ chars. Unset: no route.
   */
  OAUTH_COPY_KEY?: string;
  SESSION_SECRET: string;
  CONTENT_SIGNING_KEY: string;
  ANALYTICS_TOKEN?: string;
  /**
   * PostHog project key (a secret binding, hosted only; #2479). Unset: no
   * activation event is ever sent. Never a wrangler var with a value.
   */
  POSTHOG_KEY?: string;
  /** PostHog capture host (default https://us.i.posthog.com); a plain var, not secret. */
  POSTHOG_HOST?: string;
  CF_ACCOUNT_ID: string;
  /** This Worker's script name (filters CPU analytics); unset -> no CPU metrics. */
  WORKER_NAME?: string;
  /** OAUTH_KV's namespace id (filters KV analytics); unset -> no kv_writes. */
  OAUTH_KV_ID?: string;
}
