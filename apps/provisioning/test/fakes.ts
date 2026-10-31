import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  type FakeProvisionerRpc,
  FakeWorkflow,
  fakeProvisionerRpc,
} from "@oa/shared/provisioning/fakes";
import type { Env } from "../src/env.js";
import { RATE_LIMIT_BINDINGS, type RateBucket } from "../src/limits.js";
import type { Principal } from "../src/principal.js";

export const APP = "hosted.test";
export const ADMIN = `https://admin.${APP}`;
export const API = `https://api.${APP}`;

export type FakeLimiter = RateLimit & { keys: string[]; allow: boolean };
export const limiter = (allow = true): FakeLimiter => {
  const keys: string[] = [];
  const l = {
    keys,
    allow,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: l.allow };
    },
  };
  return l;
};

/** The miniflare D1 with the platform-db migrations (applied once per file). */
export const db = (testEnv as unknown as { PLATFORM_DB: D1Database })
  .PLATFORM_DB;
let migrated: Promise<void> | null = null;
export const migrate = () => {
  migrated ??= applyD1Migrations(
    db,
    (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  return migrated;
};

// Every table a test may seed; admin_audit and hosted_audit are append-only
// (triggers), so tests tell their rows apart by install, job or request id.
const TABLES = [
  "install_versions",
  "hosts",
  "installs",
  "jobs",
  "signups",
  "signup_secret",
  "install_lifecycle",
  "signup_accounts",
  "prodclean_reports",
  "platform_state",
  "audit_refusals",
  "rate_counters",
];
export async function resetDb() {
  await migrate();
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

/** An Env with fake bindings and the real platform schema. */
export function fakeEnv(over: Partial<Env> = {}) {
  const limits = Object.fromEntries(
    (Object.values(RATE_LIMIT_BINDINGS) as string[]).map((b) => [b, limiter()]),
  ) as Record<(typeof RATE_LIMIT_BINDINGS)[RateBucket], FakeLimiter>;
  const assets: Request[] = [];
  const provisionInstall = new FakeWorkflow();
  const manageInstall = new FakeWorkflow();
  const provisioner: FakeProvisionerRpc = fakeProvisionerRpc();
  const queued: unknown[] = [];
  const env = {
    OA_ENV: "staging",
    APP_DOMAIN: APP,
    ADMIN_IDENTITIES: "me@example.com:123",
    SIGNUPS_ENABLED: "false",
    SELF_SERVE_TIER: "trial",
    MCP_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback",
    ADMIN_SESSION_KEY: "k".repeat(32),
    ADMIN_BROKER_KEY: "unused",
    PLATFORM_DB: db,
    PROVISION_INSTALL: provisionInstall,
    MANAGE_INSTALL: manageInstall,
    PROVISIONER: provisioner,
    AUTH_BROKER: {} as Fetcher,
    SIGNUPS: {
      send: async (m: unknown) => {
        queued.push(m);
      },
    } as unknown as Queue,
    OAUTH_KV: {} as KVNamespace,
    ASSETS: {
      fetch: async (r: Request) => {
        assets.push(r);
        return new Response("spa", { status: 200 });
      },
    } as unknown as Fetcher,
    ...limits,
    ...over,
  } as Env;
  return {
    env,
    limits,
    assets,
    provisionInstall,
    manageInstall,
    provisioner,
    queued,
  };
}

export const ctx = () =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext;

export const ADMIN_P: Principal = {
  kind: "admin",
  actorKey: "admin:me@example.com",
  rateKey: "admin:me@example.com",
  label: "me@example.com",
  scopes: [],
  email: "me@example.com",
  sub: "123",
  authAt: 0,
};
export const tokenP = (
  scopes: Principal["scopes"],
  tokenId = "01JD7Z9W5Q8X3N4M2K1H0G9F8G",
): Principal => ({
  kind: "token",
  actorKey: `token:${tokenId}`,
  rateKey: "admin:me@example.com",
  label: "ci-bot",
  scopes,
  email: "me@example.com",
  tokenId,
  authAt: null,
});
export const OIDC_P: Principal = {
  kind: "oidc",
  actorKey: "oidc:42",
  rateKey: "oidc:42",
  label: "open-artifacts-ai/open-artifacts",
  scopes: [],
};
export const userP = (sub = "u1", email = "u1@acme.test"): Principal => ({
  kind: "user",
  actorKey: `user:${sub}`,
  rateKey: `user:${sub}`,
  label: email,
  scopes: [],
  email,
  sub,
});

// Seed rows (tests only; src never writes installs or hosts).
let seq = 0;
export const next = () => ++seq;
const ALPHA = "abcdefghijklmnopqrstuvwxyz234567";
/** A unique, valid install id. */
export const installId = () => {
  let n = next();
  let s = "";
  for (let i = 0; i < 11; i++) {
    s = ALPHA[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return `i${s}`;
};
export const requestId = () => `req-${String(next()).padStart(12, "0")}`;
/** A unique, valid job id. */
export const jobId = () => `01JE${String(next()).padStart(22, "0")}`;

export async function insert(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db
    .prepare(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .bind(...cols.map((c) => row[c] ?? null))
    .run();
}

export type Seed = {
  id?: string;
  slug?: string;
  state?: "active" | "deleting" | "deleted" | "creating" | "upgrading";
  version?: string | null;
  previousVersion?: string | null;
  testHooks?: boolean;
  ownerEmail?: string;
  ownerSub?: string | null;
  source?: "admin" | "self-serve";
  lifecycle?: Record<string, unknown>;
  vars?: Record<string, string>;
  leaseUntil?: number | null;
  createdAt?: number;
};

/** An installs row plus its lifecycle row: an install past reserve. */
export async function seedInstall(o: Seed = {}) {
  const id = o.id ?? installId();
  const slug = o.slug ?? `s${next()}`;
  await insert("installs", {
    id,
    slug,
    app_host: `${slug}.${APP}`,
    content_host: `${slug}.content.test`,
    owner_email: o.ownerEmail ?? "owner@acme.test",
    rl_ns: 8 * next(),
    inputs_hash: "h",
    version: o.version === undefined ? "1.41.2" : o.version,
    previous_version:
      o.previousVersion === undefined ? "1.40.0" : o.previousVersion,
    test_hooks: o.testHooks ? 1 : 0,
    state: o.state ?? "active",
    vars: JSON.stringify(
      o.vars ?? {
        AUTH_PROVIDERS: "google",
        AUTH_DOMAINS: "acme.test",
        TIER: "team",
      },
    ),
    lease_until: o.leaseUntil ?? null,
    created_at: o.createdAt ?? 1,
    updated_at: 1,
  });
  await insert("install_lifecycle", {
    install_id: id,
    source: o.source ?? "admin",
    owner_sub: o.ownerSub ?? null,
    tier: "team",
    serving_mode: o.state === "deleting" ? "closed" : "serving",
    health: "ok",
    created_at: o.createdAt ?? 1,
    updated_at: 1,
    ...o.lifecycle,
  });
  return { id, slug };
}

/** A create that failed before reserve: lifecycle and signup, no installs row. */
export async function seedFailedCreate(
  o: { slug?: string; ownerSub?: string } = {},
) {
  const id = installId();
  const slug = o.slug ?? `f${next()}`;
  const jid = jobId();
  const source = o.ownerSub ? "self-serve" : "admin";
  await insert("install_lifecycle", {
    install_id: id,
    source,
    owner_sub: o.ownerSub ?? null,
    tier: "team",
    created_at: 1,
    updated_at: 1,
  });
  await insert("signups", {
    signup_id: jid,
    source,
    owner_sub: o.ownerSub ?? null,
    slug,
    job_id: jid,
    vars: JSON.stringify({ AUTH_PROVIDERS: "email", AUTH_DOMAINS: "" }),
    status: "failed",
    created_at: 1,
    updated_at: 1,
  });
  await seedJob(id, {
    id: jid,
    signup_id: jid,
    status: "failed",
    error_code: "cf_error",
  });
  return { id, slug, jobId: jid };
}

export async function seedJob(
  install: string,
  over: Record<string, unknown> = {},
) {
  const id = (over.id as string) ?? jobId();
  await insert("jobs", {
    kind: "create",
    workflow: "provision_install",
    install_id: install,
    actor_kind: "admin",
    actor_key: "admin:seed",
    actor_label: "seed",
    request_id: `seed-${id}`,
    body_hash: "h",
    args: "{}",
    status: "queued",
    created_at: 1,
    updated_at: 1,
    ...over,
    id,
  });
  return id;
}
