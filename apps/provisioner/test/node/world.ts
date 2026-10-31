// The Workflow suites' world: fake-cf (packages/provision/test/fake-cf.ts)
// with the real platform schema in its platform D1, which the Workflows
// read and write through a D1 binding over the same database; the releases
// bucket in memory, seeded with signed releases; a pinned clock; and a step
// runner that runs each step.do body like the engine (retries per config,
// NonRetryableError final), recording every result.

import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  HOSTED_DOMAINS,
  hostsKvTitle,
  NAMESPACES,
  newInstallId,
  platformNames,
  registryKey,
} from "@oa/provision";
import { FakeWorkflow } from "@oa/shared/provisioning/fakes";
import { nodeD1 } from "../../../../packages/provision/test/d1-node.js";
import { FakeCf } from "../../../../packages/provision/test/fake-cf.js";
import {
  enc,
  releaseFixtures,
} from "../../../../packages/provision/test/fixtures/release.js";
import {
  MemoryR2,
  seedRelease,
} from "../../../../packages/provision/test/r2-memory.js";
import { delayMs } from "../../src/steps.js";
import type { Welcome } from "../../src/welcome.js";
import type { CreateCtx, WorkflowEnv } from "../../src/workflow.js";

export const ENV = "staging" as const;
export const NOW = Date.parse("2026-10-31T12:00:00Z");
export const V1 = "0.23.0";
export const V2 = "0.24.0";
export const EMAIL = "Owner+Tag@Finqore.TEST";
export const TS = {
  sitekey: "0x4AAAAAAAstagingSITEKEY",
  secret: "0x4AAAAAAAts-secret-staging-widget-value",
};

const ROOT = new URL("../../../../", import.meta.url);
const sqlFiles = (dir: string) =>
  readdirSync(new URL(dir, ROOT))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(new URL(`${dir}${name}`, ROOT))),
    }));
const PLATFORM_SQL = sqlFiles("apps/platform-db/migrations/")
  .map((f) => new TextDecoder().decode(f.bytes))
  .join("\n");
export const FIX = releaseFixtures({
  template: new Uint8Array(
    readFileSync(new URL("apps/server/wrangler.template.jsonc", ROOT)),
  ),
  migrations: sqlFiles("apps/server/migrations/"),
});

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let seq = 0;
/** A fresh ULID per call (job and signup ids). */
export const ulid = () => {
  const n = seq++;
  return `01JBQ4ZKXW5V9R3M2N8P6T${B32[(n >> 15) & 31]}${B32[(n >> 10) & 31]}${B32[(n >> 5) & 31]}${B32[n & 31]}`;
};

export type StepLog = {
  name: string;
  output?: unknown;
  error?: { name: string; message: string };
};

/**
 * A WorkflowStep: each body runs until it returns, throws a
 * NonRetryableError, or runs out of its retries (the clock moves by each
 * delay); `twice` runs every body a second time after it succeeds (a
 * replay after a lost result) and returns the second output.
 */
export function stepRunner(
  clock: { t: number },
  o: { twice?: boolean; onStep?: (name: string) => void } = {},
) {
  const log: StepLog[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown) {
      const fn = (b ?? a) as () => Promise<unknown>;
      const config = (b === undefined ? {} : a) as {
        retries?: { limit?: number; delay?: string | number };
      };
      const limit = config.retries?.limit ?? 5;
      const delay = delayMs(config.retries?.delay ?? 10_000);
      for (let attempt = 0; ; attempt++) {
        o.onStep?.(name);
        try {
          let out = await fn();
          if (o.twice) out = await fn();
          log.push({ name, output: out });
          return out === undefined ? undefined : structuredClone(out);
        } catch (e) {
          const err = e as Error;
          log.push({ name, error: { name: err.name, message: err.message } });
          if (err instanceof NonRetryableError || attempt >= limit) throw err;
          clock.t += delay * 2 ** attempt;
        }
      }
    },
    async sleep(_name: string, d: number | string) {
      clock.t += typeof d === "number" ? d : delayMs(d);
    },
    async sleepUntil(_name: string, at: Date | number) {
      clock.t = Math.max(clock.t, typeof at === "number" ? at : at.getTime());
    },
  };
  return { step: step as unknown as WorkflowStep, log };
}

export type World = Awaited<ReturnType<typeof world>>;

/** One fresh world per test. */
export async function world(
  o: { releases?: [string, "release" | "redline"][] } = {},
) {
  const clock = { t: NOW };
  const fake = new FakeCf({ now: NOW });
  const pdb = fake.seedD1(platformNames(ENV).db, PLATFORM_SQL);
  const hostsId = fake.seedKv(hostsKvTitle(ENV));
  const regId = fake.seedKv(platformNames(ENV).registry);
  const dirId = fake.seedKv(platformNames(ENV).directoryRegistry);
  fake.turnstile.set(TS.sitekey, {
    sitekey: TS.sitekey,
    name: platformNames(ENV).turnstile,
    domains: [HOSTED_DOMAINS[ENV].app],
    mode: "managed",
    secret: TS.secret,
  });
  fake.dispatch = { hostsKvId: hostsId, ns: NAMESPACES[ENV] };
  const db = (fake.d1.get(pdb) as { db: DatabaseSync }).db;
  const r2 = new MemoryR2();
  for (const [v, variant] of o.releases ?? [
    [V1, "release"],
    [V1, "redline"],
    [V2, "release"],
    [V2, "redline"],
  ])
    await seedRelease(r2, FIX.makeRelease(), v, variant);
  const mail: Welcome[] = [];
  const manage = new FakeWorkflow();
  const dispatcher = fake.dispatcher(NAMESPACES[ENV]);
  const env = {
    PLATFORM_DB: nodeD1(db) as unknown as D1Database,
    RELEASES: r2 as unknown as R2Bucket,
    PROVISION_TOKEN: { get: async () => fake.token } as SecretsStoreSecret,
    ACCOUNT_ID: fake.accountId,
    OA_ENV: ENV,
    WELCOME_EMAIL: {
      send: async (m: unknown) => {
        mail.push(m as Welcome);
        return { messageId: `m${mail.length}` };
      },
    } as unknown as SendEmail,
    WELCOME_FROM: "welcome@staging.open-artifacts.test",
    SELF_SERVE_TIER: "trial",
    DISPATCHER: dispatcher as unknown as DispatchNamespace,
    MANAGE_INSTALL: manage as unknown as Workflow<{ jobId: string }>,
  } satisfies WorkflowEnv;
  const ctx: CreateCtx = {
    env,
    io: {
      fetch: fake.fetch as typeof fetch,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
    },
  };
  const get = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
    db.prepare(sql).get(...(p as never[])) as T | undefined;
  const all = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
    db.prepare(sql).all(...(p as never[])) as T[];
  return {
    clock,
    fake,
    db,
    r2,
    env,
    ctx,
    mail,
    manage,
    hostsId,
    regId,
    dirId,
    get,
    all,
    job: (id: string) => get("SELECT * FROM jobs WHERE id = ?", id),
    signup: (id: string) =>
      get("SELECT * FROM signups WHERE signup_id = ?", id),
    install: (id: string) => get("SELECT * FROM installs WHERE id = ?", id),
    lifecycle: (id: string) =>
      get("SELECT * FROM install_lifecycle WHERE install_id = ?", id),
    status: (id: string) =>
      get("SELECT * FROM install_status WHERE install_id = ?", id),
    hosts: (slug: string) => [
      fake.kvValues(hostsId).get(`${slug}.${HOSTED_DOMAINS[ENV].app}`),
      fake.kvValues(hostsId).get(`${slug}.${HOSTED_DOMAINS[ENV].content}`),
    ],
    signin: (id: string) => {
      const raw = fake.kvValues(regId).get(registryKey(id));
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}

export type CreateSeed = {
  slug: string;
  source?: "admin" | "self-serve";
  actor?: "admin" | "token" | "user" | "oidc";
  vars?: Record<string, string>;
  testHooks?: boolean;
  sendWelcome?: boolean;
  version?: string;
  email?: string;
  tier?: string;
};

/** What R4 writes (W4 create.ts): job, signup, secret, lifecycle. */
export function seedCreate(w: World, o: CreateSeed) {
  const jobId = ulid();
  const installId = newInstallId();
  const source = o.source ?? "admin";
  const actor = o.actor ?? (source === "self-serve" ? "user" : "admin");
  const sub = source === "self-serve" ? `sub-${jobId}` : null;
  const vars = o.vars ?? {
    AUTH_PROVIDERS: "google",
    AUTH_DOMAINS: "finqore.test",
    TIER: o.tier ?? "business",
    ...(o.testHooks ? { TEST_DOMAIN: "oa-redline-a.fyi" } : {}),
  };
  const now = w.clock.t;
  const run = (sql: string, ...p: unknown[]) =>
    w.db.prepare(sql).run(...(p as never[]));
  run(
    `INSERT INTO jobs (id, kind, workflow, install_id, signup_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
VALUES (?, 'create', 'provision_install', ?, ?, ?, ?, ?, ?, 'h', ?, 'queued', ?, ?)`,
    jobId,
    installId,
    jobId,
    actor,
    `${actor}:${jobId}`,
    actor,
    `req-${jobId}`,
    JSON.stringify(o.version ? { version: o.version } : {}),
    now,
    now,
  );
  run(
    `INSERT INTO signups (signup_id, source, owner_sub, slug, job_id, vars, version, test_hooks, send_welcome, status, admitted_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    jobId,
    source,
    sub,
    o.slug,
    jobId,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    ),
    o.version ?? null,
    o.testHooks ? 1 : 0,
    o.sendWelcome ? 1 : 0,
    now,
    now,
    now,
  );
  run(
    "INSERT INTO signup_secret (signup_id, owner_email) VALUES (?, ?)",
    jobId,
    o.email ?? EMAIL,
  );
  run(
    "INSERT INTO install_lifecycle (install_id, source, owner_sub, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    installId,
    source,
    sub,
    vars.TIER ?? null,
    now,
    now,
  );
  if (sub)
    run(
      "INSERT INTO signup_accounts (owner_sub, signup_id, created_at) VALUES (?, ?, ?)",
      sub,
      jobId,
      now,
    );
  return { jobId, installId, signupId: jobId, sub };
}

/** A ManageInstall job row, as W4's accept writes it. */
export function seedJob(
  w: World,
  o: {
    kind: string;
    installId: string;
    args?: Record<string, unknown>;
    actor?: "admin" | "token" | "user" | "oidc" | "system";
    signupId?: string | null;
    parentJobId?: string | null;
    status?: string;
  },
) {
  const id = ulid();
  const now = w.clock.t;
  const actor = o.actor ?? "admin";
  w.db
    .prepare(
      `INSERT INTO jobs (id, kind, workflow, install_id, signup_id, parent_job_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
VALUES (?, ?, 'manage_install', ?, ?, ?, ?, ?, ?, ?, 'h', ?, ?, ?, ?)`,
    )
    .run(
      id,
      o.kind,
      o.installId,
      o.signupId ?? null,
      o.parentJobId ?? null,
      actor,
      `${actor}:x`,
      actor,
      `req-${id}`,
      JSON.stringify(o.args ?? {}),
      o.status ?? "queued",
      now,
      now,
    );
  return id;
}

export const event = (jobId: string) =>
  ({
    payload: { jobId },
    instanceId: jobId,
    timestamp: new Date(0),
  }) as never;

export { enc };
