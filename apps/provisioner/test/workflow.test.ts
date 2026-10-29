import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CfError, cfClient } from "../../../packages/provision/src/cf.js";
import { platformNames } from "../../../packages/provision/src/names.js";
import { r2BindingReleaseReader } from "../../../packages/provision/src/publish.js";
import {
  HOSTED_DOMAINS,
  hostsKvTitle,
  NAMESPACES,
  ProvisionRefused,
  WfpProvisioner,
} from "../../../packages/provision/src/wfp.js";
import { FakeCf, splitSql } from "../../../packages/provision/test/fake-cf.js";
import {
  enc,
  releaseFixtures,
  TEST_PUBKEY,
} from "../../../packages/provision/test/fixtures/release.js";
import { categoryOf, classify, redactEmail, stepError } from "../src/errors.js";
import type { ProvisionParams } from "../src/message.js";
import { d1Engine } from "./d1-engine.js";
import { H } from "./harness.js";
import { seedRelease } from "./seed-release.js";

// ProvisionInstall end to end in workerd: the Workflows test engine runs the
// real class (test/workflow-worker.ts swaps in fake-cf's fetch and clock and
// a mailbox), against the real platform schema in a Miniflare D1.

vi.mock("../../../packages/provision/src/internal/gates.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../packages/provision/src/internal/gates.js")
  >()),
  get RELEASE_PUBKEY() {
    return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
  },
}));

const E = testEnv as unknown as Record<string, D1Database> & {
  WF_PLATFORM_DB: D1Database;
  RELEASES: R2Bucket;
  PROVISION_INSTALL: Workflow<ProvisionParams>;
  WELCOME_FROM: string;
  FIXTURE_TEMPLATE: string;
  FIXTURE_SERVER_MIGRATIONS: { name: string; text: string }[];
  FIXTURE_PLATFORM_SQL: string;
};
const db = E.WF_PLATFORM_DB;
const ENV = "staging";
const VERSION = "0.23.0";
const NOW = Date.parse("2026-10-29T12:00:00Z");
// Uppercase and "+": redaction must not depend on the address's case.
const EMAIL = "Owner+Tag@Example.COM";
const LEASE_MS = 30 * 60_000;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const id = (n: number) =>
  `01JBQ4ZKXW5V9R3M2N8P6T7Y${B32[n >> 5]}${B32[n & 31]}`;

// Each install the suite creates takes a fresh Miniflare D1.
let nextInstallDb = 1;
let installDbs: D1Database[] = [];
const engines = () => {
  let platform = true;
  return () => {
    if (platform) {
      platform = false;
      return d1Engine(db);
    }
    const d = E[`WF_INSTALL_DB_${nextInstallDb++}`];
    if (!d) throw new Error("out of WF_INSTALL_DB bindings");
    installDbs.push(d);
    return d1Engine(d);
  };
};

type WorkflowInstanceModifier = Parameters<
  Parameters<
    Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]
  >[0]
>[0];

let fake: FakeCf;
let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
const opened: { dispose(): Promise<void> }[] = [];

beforeAll(async () => {
  for (const s of splitSql(E.FIXTURE_PLATFORM_SQL)) await db.prepare(s).run();
  const { makeRelease } = releaseFixtures({
    template: enc(E.FIXTURE_TEMPLATE),
    migrations: E.FIXTURE_SERVER_MIGRATIONS.map((f) => ({
      name: f.name,
      bytes: enc(f.text),
    })),
  });
  await seedRelease(E.RELEASES, makeRelease({ env: ENV }), VERSION, "release");
});

// Rows stay between tests (hosted_audit is append-only): each test has its
// own signup ids and slugs.
beforeEach(async () => {
  installDbs = [];
  fake = new FakeCf({ now: NOW, sql: engines() });
  fake.seedD1(platformNames(ENV).db);
  const hostsId = fake.seedKv(hostsKvTitle(ENV));
  fake.seedKv(platformNames(ENV).registry);
  fake.seedKv(platformNames(ENV).directoryRegistry);
  fake.dispatch = { hostsKvId: hostsId, ns: NAMESPACES[ENV] };
  H.fake = fake;
  H.clock.t = NOW;
  H.mail = [];
  H.failSends = 0;
  H.failTokenGets = 0;
  H.vars = {};
  H.steps = [];
  logs = [];
  for (const k of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    if (k === "log") logSpy = spy;
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const i of opened.splice(0)) await i.dispose();
});

/** What SS4 and the consumer leave: an admitted row and its secret. */
async function seedSignup(
  n: number,
  slug: string,
  o: { status?: string; installId?: string; email?: string } = {},
) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO signups (signup_id, owner_sub, slug, install_id, status, admitted_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)",
      )
      .bind(
        id(n),
        `1000000000000000000${n}`,
        slug,
        o.installId ?? null,
        o.status ?? "queued",
        NOW,
      ),
    db
      .prepare(
        "INSERT INTO signup_secret (signup_id, owner_email) VALUES (?, ?)",
      )
      .bind(id(n), o.email ?? EMAIL),
  ]);
  return { signupId: id(n), slug, ownerSub: `1000000000000000000${n}` };
}

/** Runs one instance to its end; the introspector, for step results. */
async function run(
  params: ProvisionParams,
  status: "complete" | "errored" = "complete",
  instanceId = params.signupId,
  mods: (m: WorkflowInstanceModifier) => Promise<void> = async () => {},
) {
  const inst = await introspectWorkflowInstance(
    E.PROVISION_INSTALL,
    instanceId,
  );
  opened.push(inst);
  await inst.modify(async (m) => {
    await m.disableRetryDelays();
    await mods(m);
  });
  await E.PROVISION_INSTALL.create({ id: instanceId, params });
  await inst.waitForStatus(status);
  return inst;
}

const signup = async (n: number) =>
  db
    .prepare("SELECT * FROM signups WHERE signup_id = ?")
    .bind(id(n))
    .first<Record<string, unknown>>();
const secretOf = async (n: number) =>
  db
    .prepare("SELECT * FROM signup_secret WHERE signup_id = ?")
    .bind(id(n))
    .first();
/** The installs of `slug` (rows of other tests stay in the platform D1). */
const installs = async (slug: string) =>
  (
    await db
      .prepare(
        "SELECT id, slug, state, app_host FROM installs WHERE slug = ? ORDER BY id",
      )
      .bind(slug)
      .all<{ id: string; slug: string; state: string; app_host: string }>()
  ).results;
const tokensOf = async (d: D1Database) =>
  (
    await d
      .prepare(
        "SELECT label, created_at, revoked_at FROM tokens ORDER BY created_at",
      )
      .all<{ label: string; created_at: number; revoked_at: number | null }>()
  ).results;

/** The step errors of one instance (NonRetryableError: retryable false). */
const errorsOf = (instanceId: string) =>
  H.steps
    .filter((s) => s.id === instanceId && s.error)
    .map((s) => ({
      name: s.name,
      message: s.error?.message,
      retryable: s.error?.name !== "NonRetryableError",
    }));
const outputsOf = (instanceId: string) =>
  H.steps
    .filter((s) => s.id === instanceId && !s.error)
    .map((s) => ({ name: s.name, output: s.output }));

/**
 * A signup whose create attempt died holding the lease: the row is
 * reserved (creating, `installId`), and an outside create with the
 * Workflow's label minted its ss- token and hangs in the MCP selftest.
 */
async function crashed(n: number, slug: string, installId: string) {
  const p = await seedSignup(n, slug, { status: "creating", installId });
  const label = `ss-${id(n)}`;
  let hung!: () => void;
  const reached = new Promise<void>((r) => {
    hung = r;
  });
  const dying: typeof fetch = (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.pathname === "/mcp") {
      hung();
      return new Promise(() => {});
    }
    return fake.fetch(input, init);
  };
  void provisioner({ fetch: dying, label })
    .create({
      slug,
      ownerEmail: EMAIL,
      plan: "paid",
      vars: {},
      bundle: "release",
      version: VERSION,
      installId,
    })
    .catch(() => {});
  await reached;
  const d = installDbs[0] as D1Database;
  expect(await tokensOf(d)).toEqual([
    { label, created_at: expect.any(Number), revoked_at: null },
  ]);
  return { p, label, d };
}

const seedFloorRelease = async () => {
  // A signed release at 0.0.9, under the fixtures' floor (minVersion 0.1.0).
  const { makeRelease } = releaseFixtures({
    template: enc(E.FIXTURE_TEMPLATE),
    migrations: E.FIXTURE_SERVER_MIGRATIONS.map((f) => ({
      name: f.name,
      bytes: enc(f.text),
    })),
  });
  await seedRelease(E.RELEASES, makeRelease({ env: ENV }), "0.0.9", "release");
};

/** An install made outside the Workflow, as another run or owner would. */
function provisioner(o: { fetch?: typeof fetch; label?: string } = {}) {
  const f = o.fetch ?? fake.fetch;
  return new WfpProvisioner({
    cf: cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: f,
      sleep: async () => {},
    }),
    env: ENV,
    target: { kind: "namespace", ns: NAMESPACES[ENV] },
    domains: HOSTED_DOMAINS[ENV],
    release: r2BindingReleaseReader(E.RELEASES, ENV),
    ciOwnerToken: { label: o.label ?? "ci-1" },
    requireInstallId: true,
    fetch: f,
    now: () => H.clock.t,
    sleep: async (ms) => {
      H.clock.t += ms;
    },
  });
}

describe("ProvisionInstall", () => {
  it("one signup, one install, one email", async () => {
    const p = await seedSignup(1, "finqore");
    await run(p);
    const row = await signup(1);
    expect(row).toMatchObject({ status: "ready", error: null });
    expect(row?.welcome_claimed_at).toEqual(expect.any(Number));
    expect(row?.welcome_sent_at).toEqual(expect.any(Number));
    const all = await installs("finqore");
    expect(all).toEqual([
      {
        id: row?.install_id,
        slug: "finqore",
        state: "active",
        app_host: `finqore.${HOSTED_DOMAINS[ENV].app}`,
      },
    ]);
    expect(H.mail).toHaveLength(1);
    const [m] = H.mail;
    expect(m?.to).toBe(EMAIL);
    expect(m?.from).toBe(E.WELCOME_FROM);
    expect(m?.text).toContain(`https://finqore.${HOSTED_DOMAINS[ENV].app}`);
    expect(JSON.stringify(m)).not.toMatch(/oa_pat_|token|secret|[?&]/i);
    // The selftest's ss- token, revoked; no other token.
    expect(await tokensOf(installDbs[0] as D1Database)).toEqual([
      {
        label: `ss-${id(1)}`,
        created_at: expect.any(Number),
        revoked_at: expect.any(Number),
      },
    ]);
  });

  it("a retry of each step changes nothing", async () => {
    // A second instance with the same params reruns every step after its
    // effect landed: what a retry after a lost step result does.
    const p = await seedSignup(2, "retryco");
    await run(p);
    const out1 = outputsOf(p.signupId);
    const snap = async () => ({
      signup: { ...(await signup(2)), updated_at: 0 },
      installs: await installs("retryco"),
      tokens: await tokensOf(installDbs[0] as D1Database),
      writes: fake.writes().length,
    });
    const before = await snap();
    await run(p, "complete", `${p.signupId}-again`);
    const out2 = outputsOf(`${p.signupId}-again`);
    expect(await snap()).toEqual(before);
    expect(H.mail).toHaveLength(1);
    expect(out1.map((o) => o.name)).toEqual([
      "reserve",
      "create",
      "notify",
      "done",
    ]);
    // The same install and host; only the welcome is not sent again.
    expect(out2).toEqual(
      out1.map((o) =>
        o.name === "notify" ? { ...o, output: { sent: false } } : o,
      ),
    );
  });

  it("crash mid-create with the lease held: retried, then one install, no active ss- token", async () => {
    // An attempt took the lease, minted its ss- token and died in the MCP
    // selftest.
    const installId = "icrashedrun2";
    const { p, label, d } = await crashed(3, "crashco", installId);
    // Each lease-held refusal is followed by time passing past the lease.
    let leaseHeld = 0;
    logSpy.mockImplementation((...a: unknown[]) => {
      const line = a.join(" ");
      logs.push(line);
      if (line.includes('"outcome":"lease_held"')) {
        leaseHeld++;
        H.clock.t += LEASE_MS + 1;
      }
    });
    await run(p);
    expect(leaseHeld).toBeGreaterThanOrEqual(1);
    expect(await installs("crashco")).toMatchObject([
      { id: installId, slug: "crashco", state: "active" },
    ]);
    const [died, resumed] = await tokensOf(d);
    expect(died?.label).toBe(label);
    expect(resumed?.label).toBe(label);
    // The next create attempt swept the crashed run's token before resuming.
    expect(died?.revoked_at).toEqual(expect.any(Number));
    expect(died?.revoked_at as number).toBeLessThan(
      resumed?.created_at as number,
    );
    expect(resumed?.revoked_at).toEqual(expect.any(Number));
    expect(H.mail).toHaveLength(1);
    expect(await signup(3)).toMatchObject({ status: "ready" });
  });

  it("claim without send: the retry sends nothing", async () => {
    const p = await seedSignup(4, "claimco");
    H.failSends = 1;
    await run(p);
    expect(H.mail).toHaveLength(0);
    const row = await signup(4);
    expect(row?.welcome_claimed_at).toEqual(expect.any(Number));
    expect(row?.welcome_sent_at).toBeNull();
    expect(row?.status).toBe("ready");
  });

  it("slug taken: failed slug_taken, nothing created", async () => {
    await provisioner().create({
      slug: "takenco",
      ownerEmail: "first@owner.test",
      plan: "paid",
      vars: {},
      bundle: "release",
      version: VERSION,
    });
    const before = {
      installs: await installs("takenco"),
      writes: fake.writes(),
    };
    const p = await seedSignup(5, "takenco");
    await run(p, "errored");
    expect(errorsOf(p.signupId)).toEqual([
      { name: "create", message: "slug_taken", retryable: false },
    ]);
    expect(await signup(5)).toMatchObject({
      status: "failed",
      error: "slug_taken",
    });
    expect(await installs("takenco")).toEqual(before.installs);
    expect(fake.writes()).toEqual(before.writes);
    expect(H.mail).toHaveLength(0);
  });

  it("email never leaks", async () => {
    // One signup that succeeds and one whose create fails on a Cloudflare
    // error that quotes the email.
    const ok = await seedSignup(6, "leakco");
    await run(ok);
    const bad = await seedSignup(7, "leakbad");
    fake.inject((m, path) => m === "POST" && path.endsWith("/d1/database"), {
      status: 400,
      message: EMAIL,
      times: 1000,
    });
    const badRun = await run(bad, "errored");
    const error = await badRun.getError();
    expect(error.message).toBe("cf_error");
    expect(outputsOf(ok.signupId)).toHaveLength(4);
    expect(errorsOf(bad.signupId)).toHaveLength(7);
    expect(await signup(7)).toMatchObject({
      status: "failed",
      error: "cf_error",
    });
    // Every platform row but signup_secret and installs.owner_email.
    const tables = (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'signup_secret'",
        )
        .all<{ name: string }>()
    ).results;
    const rows: unknown[] = [];
    for (const t of tables)
      for (const r of (
        await db
          .prepare(`SELECT * FROM "${t.name}"`)
          .all<Record<string, unknown>>()
      ).results) {
        if (t.name === "installs") delete r.owner_email;
        rows.push(r);
      }
    expect(rows.length).toBeGreaterThan(0);
    const seen = JSON.stringify({
      logs,
      steps: H.steps,
      error,
      rows,
      params: [ok, bad],
    }).toLowerCase();
    for (const s of ["owner+tag", "owner%2btag", "example.com", "owner tag"])
      expect(seen).not.toContain(s);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("done deletes signup_secret", async () => {
    const p = await seedSignup(8, "doneco");
    expect(await secretOf(8)).not.toBeNull();
    await run(p);
    expect(await secretOf(8)).toBeNull();
    expect(await signup(8)).toMatchObject({ status: "ready" });
  });

  it("a pinned version below the release floor fails refused, nothing created", async () => {
    await seedFloorRelease();
    H.vars = { RELEASE_VERSION: "0.0.9" };
    const p = await seedSignup(10, "floorco");
    await run(p, "errored");
    const errs = errorsOf(p.signupId);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ name: "create", retryable: false });
    expect(errs[0]?.message).toMatch(
      /^refused: .*0\.0\.9.*floor|^refused: .*floor.*0\.0\.9/,
    );
    expect(await signup(10)).toMatchObject({
      status: "failed",
      error: "refused",
    });
    expect(await installs("floorco")).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it("a non-stable RELEASE_VERSION fails internal, nothing created", async () => {
    for (const [n, v] of [
      [11, "0.23.0-rc.1"],
      [12, "0.23.0+build"],
      [13, "v0.23.0"],
    ] as const) {
      H.vars = { RELEASE_VERSION: v };
      const p = await seedSignup(n, `stable${n}`);
      await run(p, "errored");
      expect(errorsOf(p.signupId), v).toEqual([
        { name: "reserve", message: "internal", retryable: false },
      ]);
      expect(await signup(n)).toMatchObject({
        status: "failed",
        error: "internal",
      });
    }
    expect(fake.writes()).toEqual([]);
  });

  it("a replay whose failing step's body doesn't re-run still ends failed with the stored category", async () => {
    // A run before this one reserved the row and its create attempt stored
    // slug_taken; on this replay reserve is cached and create's body never
    // runs (the engine replays its error).
    const p = await seedSignup(14, "replayco", {
      status: "creating",
      installId: "ireplayrun14",
    });
    await db
      .prepare("UPDATE signups SET error = 'slug_taken' WHERE signup_id = ?")
      .bind(p.signupId)
      .run();
    await run(p, "errored", p.signupId, async (m) => {
      await m.mockStepResult(
        { name: "reserve" },
        { installId: "ireplayrun14", slug: "replayco" },
      );
      await m.mockStepError({ name: "create" }, new Error("replayed"));
    });
    expect(
      H.steps.filter((s) => s.id === p.signupId).map((s) => s.name),
    ).toEqual(["fail"]);
    expect(await signup(14)).toMatchObject({
      status: "failed",
      error: "slug_taken",
    });
  });

  it("a crash with a token minted, then a terminal failure, leaves no active ss- token", async () => {
    const { p, label, d } = await crashed(15, "crashfail", "icrashfail15");
    await seedFloorRelease();
    H.vars = { RELEASE_VERSION: "0.0.9" };
    await run(p, "errored");
    expect(errorsOf(p.signupId)).toMatchObject([
      { name: "create", retryable: false },
    ]);
    expect(await signup(15)).toMatchObject({
      status: "failed",
      error: "refused",
    });
    const toks = await tokensOf(d);
    expect(toks.map((t) => t.label)).toEqual([label]);
    expect(toks.every((t) => t.revoked_at !== null)).toBe(true);
  });

  it("a Secrets Store or D1 binding error inside create is retried as internal", async () => {
    H.failTokenGets = 1;
    const p = await seedSignup(16, "transientco");
    await run(p);
    expect(errorsOf(p.signupId)).toEqual([
      { name: "create", message: "internal", retryable: true },
    ]);
    expect(await signup(16)).toMatchObject({ status: "ready", error: null });
    expect(H.mail).toHaveLength(1);
  });

  it("a /healthz timeout on the first create attempt is retried: one install, ready", async () => {
    // /healthz answers 503 until the first attempt has failed on it.
    let unhealthy = true;
    fake.health = () =>
      unhealthy ? new Response(null, { status: 503 }) : undefined;
    // A lease left by the failed attempt is waited out.
    logSpy.mockImplementation((...a: unknown[]) => {
      const line = a.join(" ");
      logs.push(line);
      if (line.includes('"step":"create","outcome":"internal"'))
        unhealthy = false;
      if (line.includes('"outcome":"lease_held"')) H.clock.t += LEASE_MS + 1;
    });
    const p = await seedSignup(17, "healthco");
    await run(p);
    expect(errorsOf(p.signupId)[0]).toEqual({
      name: "create",
      message: "internal",
      retryable: true,
    });
    expect(unhealthy).toBe(false);
    expect(await installs("healthco")).toMatchObject([
      { slug: "healthco", state: "active" },
    ]);
    expect(await signup(17)).toMatchObject({ status: "ready", error: null });
    expect(H.mail).toHaveLength(1);
  });

  it("create uses the row's stored slug, not the event's", async () => {
    const p = await seedSignup(18, "storedco");
    await run({ ...p, slug: "eventco" });
    expect(outputsOf(p.signupId)[0]).toMatchObject({
      name: "reserve",
      output: { slug: "storedco" },
    });
    expect(await installs("storedco")).toMatchObject([{ state: "active" }]);
    expect(await installs("eventco")).toEqual([]);
    expect(await signup(18)).toMatchObject({ status: "ready" });
  });

  it("an OA_ENV other than staging or prod fails internal, nothing created", async () => {
    H.vars = { OA_ENV: "dev" };
    const p = await seedSignup(9, "envco");
    await run(p, "errored");
    expect(errorsOf(p.signupId)).toEqual([
      { name: "reserve", message: "internal", retryable: false },
    ]);
    expect(await signup(9)).toMatchObject({
      status: "failed",
      error: "internal",
    });
    expect(fake.writes()).toEqual([]);
  });
});

describe("errors", () => {
  it("classify maps provision's failures to fixed categories", () => {
    const r = (m: string) => classify(new ProvisionRefused(m));
    expect(
      r("install iabc: install iabc is busy: another operation holds it"),
    ).toEqual({
      retryable: true,
      category: "lease_held",
    });
    for (const m of [
      "slug x already exists as active install iabc",
      "slug x is already taken by install iabc",
      "host x.app.test is already taken by iabc",
      "host or broker origin already taken by install iabc (slug x)",
    ])
      expect(r(m)).toEqual({ retryable: false, category: "slug_taken" });
    expect(r("the release floor is missing")).toEqual({
      retryable: false,
      category: "refused",
    });
    expect(classify(new CfError("GET", "/x", 500, ""))).toEqual({
      retryable: true,
      category: "cf_error",
    });
    // Any other error retries: create is check-first and leased.
    expect(classify(new Error("boom"))).toEqual({
      retryable: true,
      category: "internal",
    });
  });

  it("a step error is its category, and only refused keeps the message, without the email", () => {
    const e = stepError(
      new ProvisionRefused(
        `owner ${EMAIL.toLowerCase()} / ${encodeURIComponent(EMAIL)} / ${EMAIL} refused`,
      ),
      EMAIL,
    );
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(e.message).toBe(
      "refused: owner [email] / [email] / [email] refused",
    );
    expect(categoryOf(e)).toBe("refused");
    const cf = stepError(new CfError("GET", `/x/${EMAIL}`, 500, EMAIL), EMAIL);
    expect(cf).not.toBeInstanceOf(NonRetryableError);
    expect(cf.message).toBe("cf_error");
    expect(stepError(new Error(EMAIL), EMAIL).message).toBe("internal");
    expect(categoryOf(new Error("whatever: x"))).toBe("internal");
    expect(redactEmail("no address here", EMAIL)).toBe("no address here");
  });
});
