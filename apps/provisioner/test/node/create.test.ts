// ProvisionInstall (design v7 5.2, 5.3, 2.5, 3.6) on fake-cf: the create
// and retry steps against the real platform schema, the rechecks, the
// release gate, the 5.3 inputs, the step bookkeeping, the fail step.
import { HOSTED_DOMAINS, NAMESPACES } from "@oa/provision";
import { JOB_STEPS } from "@oa/shared/provisioning";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { runCreate } from "../../src/workflow.js";
import {
  EMAIL,
  ENV,
  event,
  NOW,
  seedCreate,
  stepRunner,
  TS,
  V1,
  V2,
  type World,
  world,
} from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

const app = (slug: string) => `${slug}.${HOSTED_DOMAINS[ENV].app}`;
const plain = (w: World, id: string, name: string) =>
  w.fake
    .script(NAMESPACES[ENV], `oa-s-${id}`)
    ?.metadata.bindings.find(
      (b: { name: string; type: string }) => b.name === name,
    ) as { text?: string } | undefined;

async function run(w: World, jobId: string, o: { twice?: boolean } = {}) {
  const r = stepRunner(w.clock, o);
  const e = await runCreate(w.ctx, event(jobId), r.step).then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { ...r, error: e };
}

let w: World;
beforeEach(async () => {
  w = await world();
});

describe("ProvisionInstall: create", () => {
  it("an admin google create: active, routed, sign-in on, job done, nothing left behind", async () => {
    const s = seedCreate(w, { slug: "finqore" });
    const { error, log } = await run(w, s.jobId);
    expect(error).toBeNull();
    expect(log.map((l) => l.name)).toEqual([
      "admit",
      "recheck",
      "reserve",
      "release_gate",
      "create",
      "reachable",
      "notify",
      "done",
    ]);
    expect(w.job(s.jobId)).toMatchObject({
      status: "done",
      step: "done",
      finished_at: expect.any(Number),
      error_code: null,
    });
    expect(w.signup(s.signupId)).toMatchObject({
      status: "ready",
      install_id: s.installId,
    });
    expect(
      w.get("SELECT * FROM signup_secret WHERE signup_id = ?", s.signupId),
    ).toBeUndefined();
    expect(w.install(s.installId)).toMatchObject({
      state: "active",
      version: V2,
      slug: "finqore",
      lease: null,
    });
    expect(w.hosts("finqore")).toEqual([s.installId, s.installId]);
    expect(w.signin(s.installId)?.disabled).toBeUndefined();
    expect(w.lifecycle(s.installId)).toMatchObject({
      serving_mode: "serving",
      health: "ok",
    });
    expect(w.status(s.installId)?.state).toBe("active");
    // 5.3: brokerEnabled from the vars (google), AUTH_DOMAIN_JOIN forced.
    expect(plain(w, s.installId, "AUTH_BROKER_URL")?.text).toBe(
      `https://auth.${HOSTED_DOMAINS[ENV].app}`,
    );
    expect(plain(w, s.installId, "AUTH_DOMAIN_JOIN")?.text).toBe("invite");
    expect(plain(w, s.installId, "TIER")?.text).toBe("business");
    expect(w.mail).toEqual([]);
    expect(
      w.all(
        "SELECT action FROM hosted_audit WHERE install_id = ? AND action LIKE 'job.%'",
        s.installId,
      ),
    ).toEqual([{ action: "job.create.done" }]);
    // No step output carries the owner's email.
    expect(JSON.stringify(log).toLowerCase()).not.toContain(
      EMAIL.toLowerCase(),
    );
  });

  it("the latest installable release unless the job names one; redline iff testHooks", async () => {
    const a = seedCreate(w, { slug: "pinned", version: V1 });
    expect((await run(w, a.jobId)).error).toBeNull();
    expect(w.install(a.installId)?.version).toBe(V1);
    const b = seedCreate(w, {
      slug: "rl-a",
      actor: "oidc",
      testHooks: true,
    });
    const r = await run(w, b.jobId);
    expect(r.error).toBeNull();
    expect(r.log.find((l) => l.name === "release_gate")?.output).toEqual({
      version: V2,
      bundle: "redline",
    });
    expect(w.install(b.installId)).toMatchObject({
      test_hooks: 1,
      version: V2,
    });
    // 5.2 step 4: the version a create with none actually installed.
    expect(JSON.parse(w.job(b.jobId)?.args as string)).toEqual({
      resolvedVersion: V2,
    });
  });

  it("jobs.step only ever holds JOB_STEPS.create values (pre-flight is upload)", async () => {
    const s = seedCreate(w, { slug: "stepco" });
    const during: unknown[] = [];
    w.fake.inject(
      (_m, p) => {
        if (p.endsWith("/user/tokens/verify"))
          during.push(w.job(s.jobId)?.step);
        return false;
      },
      { times: 1 },
    );
    expect((await run(w, s.jobId)).error).toBeNull();
    expect(during).not.toHaveLength(0);
    for (const step of during)
      expect(JOB_STEPS.create as readonly unknown[]).toContain(step);
  });

  it("sendWelcome: one email, and a replay of every step changes nothing", async () => {
    const s = seedCreate(w, { slug: "welcomeco", sendWelcome: true });
    const r = await run(w, s.jobId, { twice: true });
    expect(r.log.filter((l) => l.error)).toEqual([]);
    expect(r.error).toBeNull();
    expect(w.mail).toHaveLength(1);
    expect(w.mail[0]).toMatchObject({ to: EMAIL });
    expect(w.mail[0]?.text).toContain(`https://${app("welcomeco")}`);
    expect(w.signup(s.signupId)).toMatchObject({
      status: "ready",
      welcome_claimed_at: expect.any(Number),
      welcome_sent_at: expect.any(Number),
    });
    expect(w.job(s.jobId)?.status).toBe("done");
    expect(
      w.all("SELECT id FROM installs WHERE slug = 'welcomeco'"),
    ).toHaveLength(1);
    // The second notify found the claim taken.
    expect(r.log.find((l) => l.name === "notify")?.output).toEqual({
      sent: false,
    });
  });

  it("codes on: the env widget's pair is passed (cf.turnstileList, cf.turnstileWidget)", async () => {
    const s = seedCreate(w, {
      slug: "codesco",
      vars: { AUTH_PROVIDERS: "email", AUTH_DOMAINS: "", TIER: "team" },
    });
    expect((await run(w, s.jobId)).error).toBeNull();
    expect(plain(w, s.installId, "TURNSTILE_SITE_KEY")?.text).toBe(TS.sitekey);
    expect(plain(w, s.installId, "AUTH_BROKER_URL")).toBeUndefined();
  });
});

describe("ProvisionInstall: rechecks (2.5)", () => {
  const refusedWith = async (s: {
    jobId: string;
    signupId: string;
    installId: string;
  }) => {
    const before = w.fake.writes().length;
    const r = await run(w, s.jobId);
    expect(r.error).not.toBeNull();
    expect(w.job(s.jobId)).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(w.signup(s.signupId)?.status).toBe("failed");
    expect(w.install(s.installId)).toBeUndefined();
    expect(w.fake.writes().length).toBe(before);
    return r;
  };

  it("an extra var key is invalid_state, before any Cloudflare write", async () => {
    for (const extra of [
      "FEATURES",
      "EMAIL_DAILY_CAP",
      "AUTH_DOMAIN_JOIN",
      "TEST_DOMAIN",
    ]) {
      const s = seedCreate(w, {
        slug: `extra-${extra.toLowerCase().replace(/_/g, "")}`,
        vars: {
          AUTH_PROVIDERS: "google",
          AUTH_DOMAINS: "finqore.test",
          TIER: "team",
          [extra]: "x",
        },
      });
      const r = await refusedWith(s);
      expect(r.log.find((l) => l.name === "recheck")?.error?.name).toBe(
        "NonRetryableError",
      );
    }
  });

  it("self-serve: TIER must be SELF_SERVE_TIER, google only, one domain", async () => {
    for (const [i, vars] of [
      {
        AUTH_PROVIDERS: "google",
        AUTH_DOMAINS: "finqore.test",
        TIER: "business",
      },
      {
        AUTH_PROVIDERS: "google,email",
        AUTH_DOMAINS: "finqore.test",
        TIER: "trial",
      },
      {
        AUTH_PROVIDERS: "google",
        AUTH_DOMAINS: "a.test,b.test",
        TIER: "trial",
      },
    ].entries())
      await refusedWith(
        seedCreate(w, { slug: `ss-bad-${i}`, source: "self-serve", vars }),
      );
  });

  it("the 3.3 testHooks matrix: never a token or self-serve; OIDC needs it and an rl- slug", async () => {
    await refusedWith(
      seedCreate(w, { slug: "rl-tok", actor: "token", testHooks: true }),
    );
    await refusedWith(
      seedCreate(w, {
        slug: "rl-ss",
        source: "self-serve",
        tier: "trial",
        testHooks: true,
      }),
    );
    await refusedWith(seedCreate(w, { slug: "rl-nohooks", actor: "oidc" }));
    await refusedWith(
      seedCreate(w, { slug: "plainrl", actor: "oidc", testHooks: true }),
    );
  });

  it("a self-serve create from a non-user actor, or a job already settled, is refused", async () => {
    await refusedWith(
      seedCreate(w, {
        slug: "ss-admin",
        source: "self-serve",
        actor: "admin",
        tier: "trial",
      }),
    );
    const s = seedCreate(w, { slug: "settled" });
    w.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(s.jobId);
    const r = await run(w, s.jobId);
    expect(r.error).not.toBeNull();
    expect(w.install(s.installId)).toBeUndefined();
    expect(w.job(s.jobId)?.status).toBe("done");
  });

  it("a self-serve create the consumer admitted runs; one it did not is refused", async () => {
    const ok = seedCreate(w, {
      slug: "ssok",
      source: "self-serve",
      tier: "trial",
    });
    expect((await run(w, ok.jobId)).error).toBeNull();
    expect(w.job(ok.jobId)?.status).toBe("done");
    const no = seedCreate(w, {
      slug: "ssno",
      source: "self-serve",
      tier: "trial",
    });
    w.db
      .prepare(
        "UPDATE signups SET status = 'pending', admitted_at = NULL WHERE signup_id = ?",
      )
      .run(no.signupId);
    const r = await run(w, no.jobId);
    expect(r.log.find((l) => l.name === "admit")?.error?.message).toMatch(
      /^invalid_state/,
    );
  });
});

describe("ProvisionInstall: release gate and failures", () => {
  it("an unpublished version: release_not_published, terminal, nothing created; the claim is freed", async () => {
    const s = seedCreate(w, {
      slug: "nover",
      source: "self-serve",
      tier: "trial",
      version: "0.30.0",
    });
    const before = w.fake.writes().length;
    const r = await run(w, s.jobId);
    expect(r.error).not.toBeNull();
    expect(r.log.filter((l) => l.name === "release_gate")).toHaveLength(1);
    expect(w.job(s.jobId)).toMatchObject({
      status: "failed",
      error_code: "release_not_published",
      last_error_code: "release_not_published",
      error_message: expect.stringMatching(/^release_not_published: /),
      retry_at: null,
    });
    expect(w.signup(s.signupId)?.status).toBe("failed");
    expect(
      w.get("SELECT freed_at FROM signup_accounts WHERE owner_sub = ?", s.sub),
    ).toEqual({ freed_at: expect.any(Number) });
    expect(w.fake.writes().length).toBe(before);
  });

  it("a retryable failure records attempt, last_error_code and retry_at on the job", async () => {
    const s = seedCreate(w, { slug: "flaky" });
    // Every script upload fails: create retries, then fails for good.
    w.fake.inject((m, p) => m === "PUT" && /\/scripts\/[^/]+$/.test(p), {
      status: 500,
      times: 100,
    });
    const seen: unknown[] = [];
    const r = stepRunner(w.clock, {
      onStep: (n) => {
        if (n === "create") seen.push({ ...w.job(s.jobId) });
      },
    });
    await runCreate(w.ctx, event(s.jobId), r.step).catch(() => {});
    // Attempts 2 and later start after the previous one's failure was noted.
    expect(seen[1]).toMatchObject({
      attempt: 1,
      last_error_code: "cf_error",
      retry_at: expect.any(Number),
    });
    expect(r.log.filter((l) => l.name === "create")).toHaveLength(5);
    expect(w.job(s.jobId)).toMatchObject({
      status: "failed",
      error_code: "cf_error",
      attempt: 5,
      retry_at: null,
    });
    expect(w.hosts("flaky")).toEqual([undefined, undefined]);
  });

  it("prod_dirty: never routed; snapshot, settle, then a purge job (system:provisioner) started", async () => {
    const s = seedCreate(w, { slug: "dirtyco" });
    w.fake.settingsEdit = (_s, b) => [...b, { name: "EXTRA", type: "service" }];
    const r = await run(w, s.jobId);
    expect(r.error).not.toBeNull();
    expect(w.job(s.jobId)).toMatchObject({
      status: "failed",
      error_code: "prod_dirty",
    });
    expect(w.hosts("dirtyco")).toEqual([undefined, undefined]);
    expect(w.install(s.installId)?.state).toBe("creating");
    const snap = w.get<{ detail: string; actor: string }>(
      "SELECT detail, actor FROM hosted_audit WHERE install_id = ? AND action = 'prod_dirty.snapshot'",
      s.installId,
    );
    expect(snap?.actor).toBe("system:provisioner");
    const d = JSON.parse(snap?.detail ?? "{}");
    expect(d.bindings).toContain("EXTRA:service");
    expect(d.secrets).toContain("SESSION_SECRET");
    expect(d.metadata).toMatch(/^[0-9a-f]{64}$/);
    expect(d.record).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(d)).not.toMatch(/@/);
    const purge = w.get<{
      id: string;
      status: string;
      actor_key: string;
      parent_job_id: string;
    }>(
      "SELECT id, status, actor_key, parent_job_id FROM jobs WHERE install_id = ? AND kind = 'purge'",
      s.installId,
    );
    expect(purge).toMatchObject({
      status: "queued",
      actor_key: "system:provisioner",
      parent_job_id: s.jobId,
    });
    expect(w.manage.created).toEqual([
      { id: purge?.id, params: { jobId: purge?.id } },
    ]);
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("unmapped");
  });

  it("prod_dirty: a fail step replayed after its batch committed adds no second snapshot", async () => {
    const s = seedCreate(w, { slug: "dirtytwice" });
    w.fake.settingsEdit = (_s, b) => [...b, { name: "EXTRA", type: "service" }];
    await run(w, s.jobId, { twice: true });
    expect(w.job(s.jobId)?.error_code).toBe("prod_dirty");
    expect(
      w.all(
        "SELECT 1 FROM hosted_audit WHERE install_id = ? AND action = 'prod_dirty.snapshot'",
        s.installId,
      ),
    ).toHaveLength(1);
    expect(
      w.all(
        "SELECT 1 FROM jobs WHERE install_id = ? AND kind = 'purge'",
        s.installId,
      ),
    ).toHaveLength(1);
  });

  it("a job canceled mid-run (R25) stops at its next step and keeps its code", async () => {
    const s = seedCreate(w, { slug: "cancelco" });
    const r = stepRunner(w.clock, {
      onStep: (n) => {
        if (n === "release_gate")
          w.db
            .prepare(
              "UPDATE jobs SET status = 'failed', error_code = 'canceled', error_message = 'canceled by an admin', finished_at = 1 WHERE id = ?",
            )
            .run(s.jobId);
      },
    });
    const e = await runCreate(w.ctx, event(s.jobId), r.step).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(r.log.find((l) => l.name === "release_gate")?.error?.message).toBe(
      "canceled",
    );
    expect(w.job(s.jobId)).toMatchObject({
      status: "failed",
      error_code: "canceled",
      error_message: "canceled by an admin",
      finished_at: 1,
    });
    expect(w.signup(s.signupId)?.status).toBe("failed");
    expect(w.install(s.installId)).toBeUndefined();
  });
});

void NOW;
