import { JOB_STEPS } from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, type HTTP } from "./call.js";
import {
  ADMIN_P,
  db,
  fakeEnv,
  insert,
  jobId,
  OIDC_P,
  requestId,
  resetDb,
  seedFailedCreate,
  seedInstall,
  seedJob,
  tokenP,
  userP,
} from "./fakes.js";

// Every write route (3.4, 3.6): validation, idempotency (3.1), the 4.2
// check order, TRANSITIONS, Workflow starts and audit.

const NOW = Date.UTC(2026, 9, 31, 12);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WRITE = tokenP(["installs:read", "installs:write", "installs:delete"]);

beforeEach(async () => {
  await resetDb();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

const leo = (o: Record<string, unknown> = {}) => ({
  requestId: requestId(),
  slug: "leo",
  ownerEmail: "me@leourbina.com",
  tier: "business",
  auth: { providers: ["google"], domains: ["leourbina.com"] },
  sendWelcome: false,
  ...o,
});
const row = <T>(sql: string, ...b: unknown[]) =>
  db
    .prepare(sql)
    .bind(...b)
    .first<T>();
const auditRows = (requestId: string) =>
  db
    .prepare(
      "SELECT action, outcome, code, actor_kind, actor_label, token_id, install_id, job_id, detail FROM admin_audit WHERE request_id = ? ORDER BY id",
    )
    .bind(requestId)
    .all<Record<string, string | null>>()
    .then((r) => r.results);

describe("R4 create by an admin session", () => {
  it("accepts leo's body: one batch, then the Workflow with { jobId }", async () => {
    const e = fakeEnv();
    const body = leo();
    const r = await call(e, ADMIN_P, "R4", { body });
    expect(r.status).toBe(202);
    const { job, install } = r.body;
    expect(job).toMatchObject({
      kind: "create",
      status: "queued",
      steps: [...JOB_STEPS.create],
      stepIndex: 0,
      attempt: 0,
      sealed: null,
      actor: { kind: "admin", label: "me@example.com", tokenId: null },
      createdAt: NOW,
    });
    expect(install).toMatchObject({
      id: job.installId,
      slug: "leo",
      state: "provisioning",
      source: "admin",
      tier: "business",
      auth: { providers: ["google"], domainCount: 1 },
      activeJobId: job.id,
    });
    expect(e.provisionInstall.created).toEqual([
      { id: job.id, params: { jobId: job.id } },
    ]);
    expect(e.manageInstall.created).toEqual([]);
    const s = await row<Record<string, unknown>>(
      "SELECT * FROM signups WHERE signup_id = ?",
      job.id,
    );
    expect(s).toMatchObject({
      source: "admin",
      slug: "leo",
      job_id: job.id,
      install_id: null,
      status: "queued",
      admitted_at: NOW,
      send_welcome: 0,
      test_hooks: 0,
    });
    expect(JSON.parse(s?.vars as string)).toEqual({
      AUTH_PROVIDERS: "google",
      AUTH_DOMAINS: "leourbina.com",
      TIER: "business",
    });
    expect(
      await row(
        "SELECT owner_email FROM signup_secret WHERE signup_id = ?",
        job.id,
      ),
    ).toEqual({ owner_email: "me@leourbina.com" });
    const j = await row<Record<string, string>>(
      "SELECT * FROM jobs WHERE id = ?",
      job.id,
    );
    expect(j?.args).not.toContain("@");
    expect(j?.workflow).toBe("provision_install");
    expect(j?.signup_id).toBe(job.id);
    expect(await auditRows(body.requestId)).toEqual([
      expect.objectContaining({
        action: "job.accepted",
        outcome: "ok",
        actor_kind: "admin",
        install_id: job.installId,
        job_id: job.id,
      }),
    ]);
  });

  it("replays the same requestId and body: same job, one Workflow, oa-idempotent-replay", async () => {
    const e = fakeEnv();
    const body = leo();
    const a = await call(e, ADMIN_P, "R4", { body });
    const b = await call(e, ADMIN_P, "R4", { body: { ...body } });
    expect(b.status).toBe(202);
    expect(b.body.job.id).toBe(a.body.job.id);
    expect(b.headers["oa-idempotent-replay"]).toBe("1");
    expect(a.headers["oa-idempotent-replay"]).toBeUndefined();
    expect(e.provisionInstall.created).toHaveLength(1);
    expect((await auditRows(body.requestId)).map((x) => x.action)).toEqual([
      "job.accepted",
      "job.replayed",
    ]);
  });

  it("a requestId reused with another body, route or install is 409 idempotency_conflict", async () => {
    const e = fakeEnv();
    const body = leo();
    await call(e, ADMIN_P, "R4", { body });
    expect(
      (await call(e, ADMIN_P, "R4", { body: { ...body, tier: "team" } })).code,
    ).toBe("idempotency_conflict");
    const { id } = await seedInstall();
    expect(
      (
        await call(e, ADMIN_P, "R7", {
          params: { id },
          body: { requestId: body.requestId, reason: "x" },
        })
      ).code,
    ).toBe("idempotency_conflict");
  });

  it("the same requestId is scoped to the actorKey", async () => {
    const e = fakeEnv();
    const body = leo();
    await call(e, ADMIN_P, "R4", { body });
    const other = { ...ADMIN_P, actorKey: "admin:other@example.com" };
    expect(
      (await call(e, other, "R4", { body: { ...body, slug: "leo2" } })).status,
    ).toBe(202);
  });

  it("two concurrent sends of one request make one job (race: re-read by request id)", async () => {
    const e = fakeEnv();
    const body = leo();
    const [a, b] = await Promise.all([
      call(e, ADMIN_P, "R4", { body }),
      call(e, ADMIN_P, "R4", { body }),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.job.id).toBe(b.body.job.id);
    const n = await row<{ n: number }>("SELECT COUNT(*) AS n FROM jobs");
    expect(n?.n).toBe(1);
  });

  it("two concurrent creates of one slug: one 202, one slug_taken", async () => {
    const e = fakeEnv();
    const got = await Promise.all([
      call(e, ADMIN_P, "R4", { body: leo() }),
      call(e, ADMIN_P, "R4", { body: leo() }),
    ]);
    expect(got.map((g) => g.code ?? g.status).sort()).toEqual([
      202,
      "slug_taken",
    ]);
  });

  it("slug_taken by an installs row or a live signup; a failed signup frees it", async () => {
    const e = fakeEnv();
    await seedInstall({ slug: "held" });
    expect(
      (await call(e, ADMIN_P, "R4", { body: leo({ slug: "held" }) })).code,
    ).toBe("slug_taken");
    await call(e, ADMIN_P, "R4", { body: leo({ slug: "live" }) });
    expect(
      (await call(e, ADMIN_P, "R4", { body: leo({ slug: "live" }) })).code,
    ).toBe("slug_taken");
    await seedFailedCreate({ slug: "freed" });
    expect(
      (await call(e, ADMIN_P, "R4", { body: leo({ slug: "freed" }) })).status,
    ).toBe(202);
  });

  it("slug rule: slug_invalid and slug_reserved (400), not invalid_input", async () => {
    const e = fakeEnv();
    for (const [slug, code] of [
      ["Bad", "slug_invalid"],
      ["ab--c", "slug_invalid"],
      ["-x", "slug_invalid"],
      ["admin", "slug_reserved"],
    ])
      expect((await call(e, ADMIN_P, "R4", { body: leo({ slug }) })).code).toBe(
        code,
      );
  });

  it("field rules (3.3): missing ownerEmail is 400; testHooks in prod is 403", async () => {
    const e = fakeEnv();
    const { ownerEmail: _o, ...noOwner } = leo();
    expect((await call(e, ADMIN_P, "R4", { body: noOwner })).code).toBe(
      "invalid_input",
    );
    const p = fakeEnv({ OA_ENV: "prod" });
    expect(
      (await call(p, ADMIN_P, "R4", { body: leo({ testHooks: true }) })).code,
    ).toBe("forbidden");
  });

  it("schema failures are invalid_input", async () => {
    const e = fakeEnv();
    for (const body of [
      undefined,
      {},
      leo({ requestId: "short" }),
      leo({ tier: "free" }),
      leo({ auth: { providers: ["google"], domains: [] } }),
      leo({ version: "1.42" }),
    ])
      expect((await call(e, ADMIN_P, "R4", { body })).code).toBe(
        "invalid_input",
      );
  });

  it("a version absent from GET /releases is 422 release_not_published", async () => {
    const e = fakeEnv();
    expect(
      (await call(e, ADMIN_P, "R4", { body: leo({ version: "9.9.9" }) })).code,
    ).toBe("release_not_published");
    const ok = await call(e, ADMIN_P, "R4", {
      body: leo({ version: "1.41.2" }),
    });
    expect(ok.body.job.args).toEqual({ version: "1.41.2" });
  });

  it("a failed Workflow start leaves the job queued for the sweep (still 202)", async () => {
    const e = fakeEnv();
    e.provisionInstall.failNextCreate(new Error("binding down"));
    const r = await call(e, ADMIN_P, "R4", { body: leo() });
    expect(r.status).toBe(202);
    expect(
      await row("SELECT status FROM jobs WHERE id = ?", r.body.job.id),
    ).toEqual({ status: "queued" });
  });
});

describe("R4 create by a token and by OIDC", () => {
  it("a token: owner domain must be in auth.domains; sendWelcome and testHooks forbidden", async () => {
    const e = fakeEnv();
    expect(
      (await call(e, WRITE, "R4", { body: leo({ ownerEmail: "x@evil.test" }) }))
        .code,
    ).toBe("forbidden");
    expect(
      (await call(e, WRITE, "R4", { body: leo({ sendWelcome: true }) })).code,
    ).toBe("forbidden");
    const { sendWelcome: _s, ...body } = leo();
    const r = await call(e, WRITE, "R4", { body });
    expect(r.status).toBe(202);
    expect(r.body.job.actor).toEqual({
      kind: "token",
      label: "ci-bot",
      tokenId: WRITE.tokenId,
    });
    const [a] = await auditRows(body.requestId);
    expect(a?.token_id).toBe(WRITE.tokenId);
    expect(JSON.parse(a?.detail as string)).toMatchObject({
      admin: "me@example.com",
    });
  });

  it("an MCP call records surface, tool and clientVersion in audit detail", async () => {
    const e = fakeEnv();
    const { sendWelcome: _s, ...body } = leo();
    await call(
      e,
      WRITE,
      "R4",
      { body },
      {
        kind: "mcp",
        tool: "create_install",
        clientVersion: "1.2.3",
      },
    );
    const [a] = await auditRows(body.requestId);
    expect(JSON.parse(a?.detail as string)).toMatchObject({
      surface: "mcp",
      tool: "create_install",
      clientVersion: "1.2.3",
    });
  });

  it("OIDC: rl- slug, testHooks true, @STAGING_TEST_DOMAIN owner; TEST_DOMAIN in vars", async () => {
    const e = fakeEnv();
    const body = {
      requestId: requestId(),
      slug: "rl-x1",
      ownerEmail: "a@oa-redline-a.fyi",
      tier: "team",
      auth: { providers: ["email"], domains: [] },
      testHooks: true,
    };
    expect(
      (await call(e, OIDC_P, "R4", { body: { ...body, slug: "x1" } })).code,
    ).toBe("forbidden");
    expect(
      (
        await call(e, OIDC_P, "R4", {
          body: { ...body, ownerEmail: "a@acme.test" },
        })
      ).code,
    ).toBe("forbidden");
    const r = await call(e, OIDC_P, "R4", { body });
    expect(r.status).toBe(202);
    const s = await row<{ vars: string; test_hooks: number }>(
      "SELECT vars, test_hooks FROM signups WHERE signup_id = ?",
      r.body.job.id,
    );
    expect(s?.test_hooks).toBe(1);
    expect(JSON.parse(s?.vars as string).TEST_DOMAIN).toBe("oa-redline-a.fyi");
  });
});

describe("R4 self-serve policy (4.2 order)", () => {
  const ss = (o: Record<string, unknown> = {}) => ({
    requestId: requestId(),
    slug: "acme",
    turnstile: "tok",
    ...o,
  });
  const u = (sub = "u1") => ({ ...userP(sub), hd: "acme.test" });

  it("forbidden fields first (403), before signups_closed", async () => {
    const e = fakeEnv();
    expect(
      (await call(e, u(), "R4", { body: ss({ tier: "team" }) })).code,
    ).toBe("forbidden");
    expect((await call(e, u(), "R4", { body: ss() })).code).toBe(
      "signups_closed",
    );
  });

  it("test-users admits only the staging OIDC test users", async () => {
    const e = fakeEnv({ SIGNUPS_ENABLED: "test-users" });
    expect((await call(e, u(), "R4", { body: ss() })).code).toBe(
      "signups_closed",
    );
    const tester = { ...u(), testUser: true };
    expect((await call(e, tester, "R4", { body: ss() })).status).toBe(202);
  });

  it("Turnstile next: missing or refused is 403 turnstile_failed", async () => {
    const e = fakeEnv({ SIGNUPS_ENABLED: "true" });
    const { turnstile: _t, ...none } = ss();
    expect((await call(e, u(), "R4", { body: none })).code).toBe(
      "turnstile_failed",
    );
    expect(
      (await call(e, u(), "R4", { body: ss({ turnstile: "" }) })).code,
    ).toBe("turnstile_failed");
    expect(e.provisioner.calls.at(-1)).toEqual({
      method: "verifyTurnstile",
      arg: {
        token: "",
        remoteIp: "192.0.2.1",
        action: "signup",
        hostname: "api.hosted.test",
        testUser: false,
      },
    });
  });

  it("no hd is 403; a second live install for the account is 409 signup_limit", async () => {
    const e = fakeEnv({ SIGNUPS_ENABLED: "true" });
    expect((await call(e, userP("u9"), "R4", { body: ss() })).code).toBe(
      "forbidden",
    );
    expect((await call(e, u("u2"), "R4", { body: ss() })).status).toBe(202);
    expect(
      (await call(e, u("u2"), "R4", { body: ss({ slug: "acme2" }) })).code,
    ).toBe("signup_limit");
  });

  it("server-set fields; the queue starts it, not the Workflow", async () => {
    const e = fakeEnv({ SIGNUPS_ENABLED: "true" });
    const r = await call(e, u("u3"), "R4", { body: ss({ slug: "acme3" }) });
    expect(r.status).toBe(202);
    const id = r.body.job.id;
    expect(e.provisionInstall.created).toEqual([]);
    expect(e.queued).toEqual([{ jobId: id }]);
    const s = await row<Record<string, unknown>>(
      "SELECT * FROM signups WHERE signup_id = ?",
      id,
    );
    expect(s).toMatchObject({
      source: "self-serve",
      owner_sub: "u3",
      status: "pending",
      admitted_at: null,
      send_welcome: 1,
    });
    expect(JSON.parse(s?.vars as string)).toEqual({
      AUTH_PROVIDERS: "google",
      AUTH_DOMAINS: "acme.test",
      TIER: "trial",
    });
    expect(
      await row(
        "SELECT owner_email FROM signup_secret WHERE signup_id = ?",
        id,
      ),
    ).toEqual({ owner_email: "u1@acme.test" });
    expect(
      await row("SELECT signup_id FROM signup_accounts WHERE owner_sub = 'u3'"),
    ).toEqual({ signup_id: id });
    expect(r.body.install).toMatchObject({
      source: "self-serve",
      tier: "trial",
    });
  });

  it("per-/64 create counter: the 4th in an hour is 429", async () => {
    const e = fakeEnv({ SIGNUPS_ENABLED: "true" });
    const v6: typeof HTTP = {
      kind: "http",
      client: { ip: "2001:db8:1:2::5", host: "api.hosted.test" },
    };
    const got: (number | string)[] = [];
    for (let i = 0; i < 4; i++) {
      const sib = { ...v6, client: { ...v6.client, ip: `2001:db8:1:2::${i}` } };
      const r = await call(
        e,
        u(`c${i}`),
        "R4",
        { body: ss({ slug: `c${i}x` }) },
        sib,
      );
      got.push(r.code ?? r.status);
    }
    expect(got).toEqual([202, 202, 202, "rate_limited"]);
  });
});

describe("lifecycle writes (R5-R13)", () => {
  it("R7 suspend: ManageInstall with { jobId }, args.reason, job.accepted", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    const body = { requestId: requestId(), reason: "unpaid" };
    const r = await call(e, ADMIN_P, "R7", { params: { id }, body });
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({
      kind: "suspend",
      installId: id,
      args: { reason: "unpaid" },
      steps: [...JOB_STEPS.suspend],
    });
    expect(r.body.install.activeJobId).toBe(r.body.job.id);
    expect(e.manageInstall.created).toEqual([
      { id: r.body.job.id, params: { jobId: r.body.job.id } },
    ]);
  });

  it("an unknown install is 404", async () => {
    const e = fakeEnv();
    const r = await call(e, ADMIN_P, "R7", {
      params: { id: "izzzzzzzzzzz" },
      body: { requestId: requestId(), reason: "x" },
    });
    expect(r.code).toBe("not_found");
  });

  it("job_in_progress (with details.jobId) is checked before invalid_state", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ state: "deleting" });
    await db
      .prepare(
        "UPDATE install_lifecycle SET deleted_at = ?, purge_at = ? WHERE install_id = ?",
      )
      .bind(NOW, NOW + DAY, id)
      .run();
    const running = await seedJob(id, { kind: "delete", status: "running" });
    const r = await call(e, ADMIN_P, "R7", {
      params: { id },
      body: { requestId: requestId(), reason: "x" },
    });
    expect(r.code).toBe("job_in_progress");
    expect(r.details).toEqual({ jobId: running });
    await db
      .prepare("UPDATE jobs SET status = 'done' WHERE id = ?")
      .bind(running)
      .run();
    expect(
      (
        await call(e, ADMIN_P, "R7", {
          params: { id },
          body: { requestId: requestId(), reason: "x" },
        })
      ).code,
    ).toBe("invalid_state");
  });

  it("a refusal writes job.refused with the code", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    const body = { requestId: requestId() };
    expect((await call(e, ADMIN_P, "R8", { params: { id }, body })).code).toBe(
      "invalid_state",
    );
    expect(await auditRows(body.requestId)).toEqual([
      expect.objectContaining({
        action: "job.refused",
        outcome: "refused",
        code: "invalid_state",
        install_id: id,
      }),
    ]);
  });

  it("R9 delete: confirmSlug must match (400 confirm_mismatch, no job)", async () => {
    const e = fakeEnv();
    const { id, slug } = await seedInstall();
    const bad = await call(e, ADMIN_P, "R9", {
      params: { id },
      body: { requestId: requestId(), confirmSlug: `${slug}x` },
    });
    expect(bad.code).toBe("confirm_mismatch");
    expect(e.manageInstall.created).toEqual([]);
    const ok = await call(e, ADMIN_P, "R9", {
      params: { id },
      body: { requestId: requestId(), confirmSlug: slug },
    });
    expect(ok.body.job.kind).toBe("delete");
  });

  it("R9 by a user: own only (else 404), refused while suspended", async () => {
    const e = fakeEnv();
    const mine = await seedInstall({ source: "self-serve", ownerSub: "u1" });
    const theirs = await seedInstall({ source: "self-serve", ownerSub: "u2" });
    const del = (i: { id: string; slug: string }) =>
      call(e, userP("u1"), "R9", {
        params: { id: i.id },
        body: { requestId: requestId(), confirmSlug: i.slug },
      });
    expect((await del(theirs)).code).toBe("not_found");
    await db
      .prepare(
        "UPDATE install_lifecycle SET suspended_at = 1, suspend_reason = 'x' WHERE install_id = ?",
      )
      .bind(mine.id)
      .run();
    expect((await del(mine)).code).toBe("invalid_state");
  });

  it("OIDC reaches only rl- test installs (else 404)", async () => {
    const e = fakeEnv();
    const plain = await seedInstall({ slug: "rl-plain" });
    const test = await seedInstall({ slug: "rl-a", testHooks: true });
    const sus = (id: string) =>
      call(e, OIDC_P, "R7", {
        params: { id },
        body: { requestId: requestId(), reason: "x" },
      });
    expect((await sus(plain.id)).code).toBe("not_found");
    expect((await sus(test.id)).status).toBe(202);
  });

  it("R10 restore within grace; after purge_at or once a purge started: grace_expired", async () => {
    const e = fakeEnv();
    const restore = (id: string) =>
      call(e, ADMIN_P, "R10", {
        params: { id },
        body: { requestId: requestId() },
      });
    const grace = { deleted_at: NOW - DAY, purge_at: NOW + DAY };
    const a = await seedInstall({ state: "deleting", lifecycle: grace });
    expect((await restore(a.id)).body.job.kind).toBe("restore");
    const b = await seedInstall({
      state: "deleting",
      lifecycle: { deleted_at: NOW - 8 * DAY, purge_at: NOW - DAY },
    });
    expect((await restore(b.id)).code).toBe("grace_expired");
    const c = await seedInstall({ state: "deleting", lifecycle: grace });
    await seedJob(c.id, { kind: "purge", status: "failed", created_at: NOW });
    expect((await restore(c.id)).code).toBe("grace_expired");
  });

  it("R11 by a token on deleting: 403 forbidden with details.needs admin_session", async () => {
    const e = fakeEnv();
    const { id, slug } = await seedInstall({
      state: "deleting",
      lifecycle: { deleted_at: NOW, purge_at: NOW + DAY },
    });
    const r = await call(e, WRITE, "R11", {
      params: { id },
      body: { requestId: requestId(), confirmSlug: slug },
    });
    expect(r.code).toBe("forbidden");
    expect(r.details).toEqual({
      needs: "admin_session",
      url: `https://admin.hosted.test/installs/${id}`,
    });
  });

  it("R11 by a token: skipDirectoryRevoke forbidden; a failed create with no installs row is a discard", async () => {
    const e = fakeEnv();
    const f = await seedFailedCreate();
    expect(
      (
        await call(e, WRITE, "R11", {
          params: { id: f.id },
          body: {
            requestId: requestId(),
            confirmSlug: f.slug,
            skipDirectoryRevoke: { reason: "never_routed" },
          },
        })
      ).code,
    ).toBe("forbidden");
    const r = await call(e, WRITE, "R11", {
      params: { id: f.id },
      body: { requestId: requestId(), confirmSlug: f.slug },
    });
    expect(r.body.job.kind).toBe("discard");
    expect(r.body.job.steps).toEqual([...JOB_STEPS.discard]);
  });

  it("R11 by an admin on deleting needs authAt within 10 min (reauth_required)", async () => {
    const e = fakeEnv();
    const { id, slug } = await seedInstall({
      state: "deleting",
      lifecycle: { deleted_at: NOW, purge_at: NOW + DAY },
    });
    const purge = (authAt: number) =>
      call(e, { ...ADMIN_P, authAt }, "R11", {
        params: { id },
        body: { requestId: requestId(), confirmSlug: slug },
      });
    const old = await purge(NOW - 11 * MIN);
    expect(old.code).toBe("reauth_required");
    expect(old.details).toMatchObject({
      reauthUrl: expect.stringContaining("reauth=1"),
    });
    const fresh = await purge(NOW - 9 * MIN);
    expect(fresh.body.job.kind).toBe("purge");
  });

  it("R11 admin on a failed install with an installs row is a purge, skipDirectoryRevoke in args", async () => {
    const e = fakeEnv();
    const { id, slug } = await seedInstall({ state: "creating" });
    await seedJob(id, { status: "failed", error_code: "cf_error" });
    const r = await call(e, ADMIN_P, "R11", {
      params: { id },
      body: {
        requestId: requestId(),
        confirmSlug: slug,
        skipDirectoryRevoke: { reason: "never_routed" },
      },
    });
    expect(r.body.job).toMatchObject({
      kind: "purge",
      args: { skipDirectoryRevoke: "never_routed" },
    });
  });

  it("R5 upgrade: default latest installable; at or below current is downgrade_refused", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ version: "1.41.2" });
    const up = await call(e, ADMIN_P, "R5", {
      params: { id },
      body: { requestId: requestId() },
    });
    expect(up.body.job.args).toEqual({ from: "1.41.2", to: "1.42.0" });
    const b = await seedInstall({ version: "1.42.0" });
    expect(
      (
        await call(e, ADMIN_P, "R5", {
          params: { id: b.id },
          body: { requestId: requestId(), version: "1.41.2" },
        })
      ).code,
    ).toBe("downgrade_refused");
    expect(
      (
        await call(e, ADMIN_P, "R5", {
          params: { id: b.id },
          body: { requestId: requestId(), version: "2.0.0" },
        })
      ).code,
    ).toBe("release_not_published");
  });

  it("R6 rollback goes to previous_version; none is invalid_state", async () => {
    const e = fakeEnv();
    const a = await seedInstall({
      version: "1.41.2",
      previousVersion: "1.40.0",
    });
    const r = await call(e, ADMIN_P, "R6", {
      params: { id: a.id },
      body: { requestId: requestId() },
    });
    expect(r.body.job.args).toEqual({ from: "1.41.2", to: "1.40.0" });
    const b = await seedInstall({ previousVersion: null });
    expect(
      (
        await call(e, ADMIN_P, "R6", {
          params: { id: b.id },
          body: { requestId: requestId() },
        })
      ).code,
    ).toBe("invalid_state");
  });

  it("R12 retry: failed creates only, on ProvisionInstall", async () => {
    const e = fakeEnv();
    const f = await seedFailedCreate();
    const r = await call(e, WRITE, "R12", {
      params: { id: f.id },
      body: { requestId: requestId() },
    });
    expect(r.body.job.kind).toBe("retry");
    expect(e.provisionInstall.created.map((c) => c.id)).toEqual([
      r.body.job.id,
    ]);
    expect(
      await row("SELECT signup_id FROM jobs WHERE id = ?", r.body.job.id),
    ).toEqual({ signup_id: f.jobId });
    const a = await seedInstall();
    expect(
      (
        await call(e, WRITE, "R12", {
          params: { id: a.id },
          body: { requestId: requestId() },
        })
      ).code,
    ).toBe("invalid_state");
  });

  it("R13 release-lease: force needs a live lease", async () => {
    const e = fakeEnv();
    const a = await seedInstall({ leaseUntil: NOW - 1 });
    const rl = (force?: boolean) =>
      call(e, ADMIN_P, "R13", {
        params: { id: a.id },
        body: { requestId: requestId(), confirmSlug: a.slug, force },
      });
    expect((await rl(true)).code).toBe("invalid_state");
    const ok = await rl();
    expect(ok.body.job).toMatchObject({ kind: "release_lease", args: {} });
  });
});

describe("R25 cancel and R26 redline-creds", () => {
  it("R25: one batch fails the job canceled and inserts cleanup; then terminate", async () => {
    const e = fakeEnv();
    const { id, slug } = await seedInstall();
    const r1 = await call(e, ADMIN_P, "R7", {
      params: { id },
      body: { requestId: requestId(), reason: "x" },
    });
    const target = r1.body.job.id;
    expect(
      (
        await call(e, ADMIN_P, "R25", {
          params: { jobId: target },
          body: { requestId: requestId(), confirmSlug: "nope" },
        })
      ).code,
    ).toBe("confirm_mismatch");
    const body = { requestId: requestId(), confirmSlug: slug };
    const r = await call(e, ADMIN_P, "R25", {
      params: { jobId: target },
      body,
    });
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({
      kind: "cleanup",
      status: "queued",
      installId: id,
    });
    expect(
      await row(
        "SELECT status, error_code, finished_at FROM jobs WHERE id = ?",
        target,
      ),
    ).toEqual({ status: "failed", error_code: "canceled", finished_at: NOW });
    expect(
      await row("SELECT parent_job_id FROM jobs WHERE id = ?", r.body.job.id),
    ).toEqual({ parent_job_id: target });
    expect((await (await e.manageInstall.get(target)).status()).status).toBe(
      "terminated",
    );
    expect(e.manageInstall.created.map((c) => c.id)).toContain(r.body.job.id);
    expect((await auditRows(body.requestId)).map((a) => a.action)).toEqual([
      "job.canceled",
    ]);
    // Replay answers the same cleanup job.
    const again = await call(e, ADMIN_P, "R25", {
      params: { jobId: target },
      body,
    });
    expect(again.body.job.id).toBe(r.body.job.id);
  });

  it("R25 on a finished job is invalid_state; an unknown job is 404", async () => {
    const e = fakeEnv();
    const { id, slug } = await seedInstall();
    const done = await seedJob(id, { status: "done" });
    expect(
      (
        await call(e, ADMIN_P, "R25", {
          params: { jobId: done },
          body: { requestId: requestId(), confirmSlug: slug },
        })
      ).code,
    ).toBe("invalid_state");
    expect(
      (
        await call(e, ADMIN_P, "R25", {
          params: { jobId: jobId() },
          body: { requestId: requestId(), confirmSlug: slug },
        })
      ).code,
    ).toBe("not_found");
  });

  it("R26: OIDC on its own active rl- test install; args carry recipientKey", async () => {
    const e = fakeEnv();
    const t = await seedInstall({ slug: "rl-b", testHooks: true });
    const key = `${"A".repeat(42)}A`;
    const r = await call(e, OIDC_P, "R26", {
      params: { id: t.id },
      body: { requestId: requestId(), recipientKey: key },
    });
    expect(r.body.job).toMatchObject({
      kind: "redline_creds",
      args: { recipientKey: key },
    });
    expect(e.manageInstall.created).toHaveLength(1);
  });
});

describe("audit of authz refusals", () => {
  it("an authenticated authz refusal writes authz.refused with the route", async () => {
    const e = fakeEnv();
    const p = tokenP(["installs:read"], "01JD7Z9W5Q8X3N4M2K1H0G9F9Z");
    expect((await call(e, p, "R13", { params: {}, body: {} })).code).toBe(
      "forbidden",
    );
    const a = await row<Record<string, string>>(
      "SELECT action, code, detail FROM admin_audit WHERE token_id = ? ORDER BY id DESC",
      p.tokenId,
    );
    expect(a?.action).toBe("authz.refused");
    expect(a?.code).toBe("forbidden");
    expect(JSON.parse(a?.detail ?? "{}")).toMatchObject({ route: "R13" });
  });
});

void insert;
