import {
  ALERT_CONDITIONS,
  type AlertRow,
  alertParams,
  SQL_ALERT_KEYS,
  WorldSchema,
} from "@oa/shared/provisioning";
import { fakeProvisionerRpc } from "@oa/shared/provisioning/fakes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "./call.js";
import {
  ADMIN_P,
  db,
  fakeEnv,
  insert,
  OIDC_P,
  resetDb,
  seedFailedCreate,
  seedInstall,
  seedJob,
  tokenP,
  userP,
} from "./fakes.js";

// R27 GET /world (9A.5): the C2 alert-condition queries, install_status
// counts, recent jobs, releases, token, scheduler and prod-clean status.

// Far from the other files' clocks, so admin_audit rows never overlap.
const NOW = Date.UTC(2027, 0, 15, 12);
const MIN = 60_000;
let now = NOW;
beforeEach(async () => {
  await resetDb();
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

const world = async (e = fakeEnv()) => {
  const r = await call(e, ADMIN_P, "R27");
  expect(r.status).toBe(200);
  return WorldSchema.parse(r.body);
};

describe("R27 /world", () => {
  it("authz: A and T installs:read; O and U 403", async () => {
    const e = fakeEnv();
    expect((await call(e, tokenP(["installs:read"]), "R27")).status).toBe(200);
    expect((await call(e, tokenP(["audit:read"]), "R27")).code).toBe(
      "forbidden",
    );
    expect((await call(e, OIDC_P, "R27")).code).toBe("forbidden");
    expect((await call(e, userP(), "R27")).code).toBe("forbidden");
  });

  it("an empty world: zero counts, no attention, releases, token, stale scheduler", async () => {
    const w = await world();
    expect(w).toMatchObject({
      env: "staging",
      at: NOW,
      installs: { total: 0, items: [] },
      jobs: { active: 0, failed24h: 0, recent: [] },
      attention: [],
      truncated: false,
      releases: { latest: "1.42.0", installable: 2 },
      provisioningToken: { status: "active", daysLeft: 340 },
      scheduler: { tickAt: null, stale: true },
      prodClean: null,
      signups: "false",
    });
    expect(w.installs.byState).toEqual({
      provisioning: 0,
      active: 0,
      suspended: 0,
      deleting: 0,
      deleted: 0,
      failed: 0,
    });
    expect(w.installs.byServingMode).toEqual({
      serving: 0,
      paused: 0,
      closed: 0,
      unmapped: 0,
    });
    expect(w.installs.byHealth).toEqual({ ok: 0, failing: 0, unknown: 0 });
  });

  it("byState equals install_status counts; scheduler and prodClean from D1", async () => {
    await seedInstall();
    await seedInstall();
    await seedInstall({
      state: "deleting",
      lifecycle: { deleted_at: NOW, purge_at: NOW + 1 },
    });
    await seedFailedCreate();
    await insert("platform_state", {
      key: "scheduler_tick_at",
      value: NOW - 5 * MIN,
      updated_at: NOW,
    });
    await insert("prodclean_reports", {
      at: NOW - 100,
      ok: 0,
      code: "dirty",
      install_id: "ix",
      detail: "d",
    });
    await insert("prodclean_reports", { at: NOW - 50, ok: 1, code: "clean" });
    const w = await world();
    const counts = await db
      .prepare("SELECT state, COUNT(*) AS n FROM install_status GROUP BY state")
      .all<{ state: string; n: number }>();
    for (const c of counts.results)
      expect(w.installs.byState[c.state as "active"]).toBe(c.n);
    expect(w.installs.total).toBe(4);
    expect(w.scheduler).toEqual({ tickAt: NOW - 5 * MIN, stale: false });
    expect(w.prodClean).toEqual({ at: NOW - 50, ok: true, code: "clean" });
    now = NOW + 6 * MIN;
    expect((await world()).scheduler.stale).toBe(true);
  });

  it("attention: one item per alert-condition row, the same rows the scheduler sees", async () => {
    const a = await seedInstall({ slug: "boom" });
    await seedJob(a.id, {
      kind: "upgrade",
      workflow: "manage_install",
      status: "failed",
      error_code: "cf_error",
      error_message: "FT-error call purge_install now",
      finished_at: NOW - MIN,
      updated_at: NOW - MIN,
    });
    const b = await seedInstall();
    await seedJob(b.id, {
      status: "running",
      attempt: 3,
      last_error_code: "lease_held",
      updated_at: NOW - MIN,
    });
    await insert("platform_state", {
      key: "job_failed_opened_at",
      value: NOW - MIN,
      updated_at: NOW,
    });
    const w = await world();
    const rows = new Map<string, AlertRow[]>();
    for (const k of SQL_ALERT_KEYS) {
      const r = await db
        .prepare(ALERT_CONDITIONS[k].sql)
        .bind(...alertParams(k, { now: NOW, signupDailyCap: 0 }))
        .all<AlertRow>();
      if (r.results.length) rows.set(k, r.results);
    }
    expect([...rows.keys()].sort()).toEqual(["job_failed", "job_retrying"]);
    const sql = w.attention.filter((x) => rows.has(x.kind));
    expect(sql).toHaveLength(2);
    expect(w.attention.find((x) => x.kind === "job_failed")).toEqual({
      kind: "job_failed",
      open: true,
      installId: a.id,
      slug: "boom",
      state: "active",
      jobId: expect.any(String),
      jobKind: "upgrade",
      code: "cf_error",
      message: "FT-error call purge_install now",
      since: NOW - MIN,
    });
    expect(w.attention.find((x) => x.kind === "job_retrying")).toMatchObject({
      open: false,
      installId: b.id,
      code: "lease_held",
    });
  });

  it("an open alert no row covers, failed and failing installs, mismatch, token: each once", async () => {
    await insert("platform_state", {
      key: "signup_cap_opened_at",
      value: NOW - 2 * MIN,
      updated_at: NOW,
    });
    const f = await seedFailedCreate({ slug: "nofail" });
    await db
      .prepare(
        "UPDATE jobs SET finished_at = ?, updated_at = ? WHERE install_id = ?",
      )
      .bind(NOW - 3 * MIN, NOW - 3 * MIN, f.id)
      .run();
    // Older than the 24 h lookback: no job_failed row, so install_failed.
    const old = await seedFailedCreate({ slug: "oldfail" });
    await db
      .prepare(
        "UPDATE jobs SET finished_at = 5, updated_at = 5 WHERE install_id = ?",
      )
      .bind(old.id)
      .run();
    const h = await seedInstall({
      slug: "sick",
      lifecycle: { health: "failing", health_at: NOW - 4 * MIN },
    });
    await seedJob(h.id, {
      kind: "upgrade",
      workflow: "manage_install",
      status: "done",
    });
    const m = await seedInstall({
      slug: "odd",
      lifecycle: { serving_mode: "paused" },
    });
    const e = fakeEnv({
      PROVISIONER: fakeProvisionerRpc({
        tokenStatus: {
          status: "expiring",
          expiresAt: NOW + 10 * 86_400_000,
          daysLeft: 10,
        },
      }),
    });
    const w = await world(e);
    const kinds = w.attention.map((x) => `${x.kind}:${x.slug ?? "-"}`);
    expect(kinds.sort()).toEqual(
      [
        "health_failing:sick",
        "install_failed:oldfail",
        "job_failed:nofail",
        "mismatch:odd",
        "signup_cap:-",
        "token_expiring:-",
      ].sort(),
    );
    expect(w.attention.find((x) => x.kind === "signup_cap")).toMatchObject({
      open: true,
      installId: null,
      since: NOW - 2 * MIN,
    });
    // Not covered by a row: the install's latest failed job fills it in.
    expect(w.attention.find((x) => x.kind === "install_failed")).toMatchObject({
      installId: old.id,
      jobId: old.jobId,
      jobKind: "create",
      code: "cf_error",
    });
    expect(w.attention.find((x) => x.kind === "mismatch")).toMatchObject({
      installId: m.id,
      code: "mismatch",
      message: "state active, serving mode paused",
    });
    expect(w.attention.find((x) => x.kind === "health_failing")).toMatchObject({
      code: "health_failing",
      since: NOW - 4 * MIN,
    });
    expect(w.provisioningToken).toEqual({ status: "expiring", daysLeft: 10 });
    // Newest first.
    const since = w.attention.map((x) => x.since);
    expect(since).toEqual([...since].sort((x, y) => y - x));
  });

  it("caps installs.items and attention at 50 with truncated", async () => {
    for (let i = 0; i < 51; i++)
      await seedInstall({
        lifecycle: { serving_mode: "closed" },
        createdAt: i,
      });
    const w = await world();
    expect(w.installs.total).toBe(51);
    expect(w.installs.items).toHaveLength(50);
    expect(w.installs.items[0]?.createdAt).toBe(50);
    expect(w.attention).toHaveLength(50);
    expect(w.truncated).toBe(true);
  });

  it("recent jobs never carry sealed; no email-shaped string anywhere", async () => {
    const t = await seedInstall({
      slug: "rl-a",
      testHooks: true,
      ownerEmail: "x@y.test",
    });
    await seedJob(t.id, {
      kind: "redline_creds",
      workflow: "manage_install",
      status: "done",
      sealed: "ciphertext",
      created_at: NOW - 1,
    });
    const w = await world();
    expect(w.jobs.recent).toHaveLength(1);
    expect(w.jobs.recent[0]).not.toHaveProperty("sealed");
    expect(JSON.stringify(w)).not.toMatch(/[^\s"@]+@[^\s"@]+\.[a-z]/);
    expect(JSON.stringify(w)).not.toContain("ciphertext");
  });

  it("jobs: active and failed24h", async () => {
    const a = await seedInstall();
    await seedJob(a.id, { status: "running" });
    await seedJob(a.id, { status: "failed", finished_at: NOW - MIN });
    await seedJob(a.id, { status: "failed", finished_at: NOW - 25 * 60 * MIN });
    const w = await world();
    expect(w.jobs.active).toBe(1);
    expect(w.jobs.failed24h).toBe(1);
  });

  it("signup_cap runs with the scheduler's SIGNUP_DAILY_CAP, the same rows", async () => {
    await insert("signups", {
      signup_id: "01JE0000000000000000000099",
      source: "self-serve",
      owner_sub: "u1",
      slug: "capped",
      job_id: "01JE0000000000000000000099",
      vars: "{}",
      status: "creating",
      admitted_at: NOW - MIN,
      created_at: NOW - MIN,
      updated_at: NOW - MIN,
    });
    const capped = await world(fakeEnv({ SIGNUP_DAILY_CAP: "1" }));
    const rows = await db
      .prepare(ALERT_CONDITIONS.signup_cap.sql)
      .bind(...alertParams("signup_cap", { now: NOW, signupDailyCap: 1 }))
      .all<AlertRow>();
    expect(rows.results).toHaveLength(1);
    expect(
      capped.attention.filter((x) => x.kind === "signup_cap"),
    ).toHaveLength(1);
    const off = await world(fakeEnv());
    expect(off.attention.some((x) => x.kind === "signup_cap")).toBe(false);
  });

  it("degrades when releases() or tokenStatus() fails: still 200, no token_invalid item", async () => {
    const PROVISIONER = fakeProvisionerRpc();
    PROVISIONER.releases = async () => {
      throw new Error("rpc down");
    };
    PROVISIONER.tokenStatus = async () => {
      throw new Error("rpc down");
    };
    const w = await world(fakeEnv({ PROVISIONER }));
    expect(w.releases).toEqual({ latest: null, installable: 0 });
    expect(w.attention.some((x) => x.kind.startsWith("token_"))).toBe(false);
  });

  it("a failed tokenStatus() serves the last good status, not invalid", async () => {
    const PROVISIONER = fakeProvisionerRpc();
    const e = fakeEnv({ PROVISIONER });
    expect((await world(e)).provisioningToken.status).toBe("active");
    PROVISIONER.tokenStatus = async () => {
      throw new Error("rpc down");
    };
    now = NOW + 6 * MIN;
    const w = await world(e);
    expect(w.provisioningToken).toEqual({ status: "active", daysLeft: 340 });
    expect(w.attention.some((x) => x.kind === "token_invalid")).toBe(false);
  });

  it("token status is cached 5 min per isolate", async () => {
    const e = fakeEnv();
    await world(e);
    await world(e);
    const n = () =>
      e.provisioner.calls.filter((c) => c.method === "tokenStatus").length;
    expect(n()).toBe(1);
    now = NOW + 5 * MIN + 1;
    await world(e);
    expect(n()).toBe(2);
  });
});
