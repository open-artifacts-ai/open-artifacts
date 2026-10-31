import { type SettleFailed, settledWith } from "@oa/provision/jobs";
import { REQUEST_ID_RE, ULID_RE } from "@oa/shared/provisioning";
import { FakeWorkflow } from "@oa/shared/provisioning/fakes";
import {
  JOB_START_GRACE_MS,
  JOB_TERMINATED_GRACE_MS,
  sweepTerminatedKey,
} from "@oa/shared/provisioning/state";
import { cleanupRequestId, SYSTEM_ACTOR } from "@oa/shared/provisioning/system";
import {
  type WorkflowInstanceStatus,
  type WorkflowLike,
  WorkflowNotFoundError,
} from "@oa/shared/provisioning/workflow";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DutyFailure, type ProvapiEnv } from "../src/provapi/env.js";
import { SWEEP_LIMIT, sweep } from "../src/provapi/sweep.js";
import {
  captureLogs,
  db,
  installId,
  job,
  migrate,
  reset,
  rows,
  signup,
} from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const TICK = 2 * 60_000;
const OLD = NOW - JOB_START_GRACE_MS;
/** The code a dead run settles with (Manager C5). */
const RUN_DEAD = "run_dead";

/**
 * W3's settleFailed, as far as the sweep relies on it (C5's contract): the
 * job to failed, then `opts.extra`, in one D1 batch on the db it is given;
 * `settled` from the jobs UPDATE's changes, `extra` the extra results.
 */
const settled: { jobId: string; code: string }[] = [];
const fakeSettle: SettleFailed = async (d, jobId, code, opts) => {
  const res = (await d.batch([
    d
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = COALESCE(error_code, ?2), finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('queued', 'running')",
      )
      .bind(jobId, code, NOW),
    ...((opts?.extra ?? []) as D1PreparedStatement[]),
  ])) as D1Result[];
  const ok = (res[0]?.meta.changes ?? 0) > 0;
  if (ok) settled.push({ jobId, code });
  return { settled: ok, extra: res.slice(1) };
};

const BAD = Symbol("bad");
/** The platform D1, but the first job insert fails (alone or in a batch). */
function failFirstJobInsert(real: D1Database): D1Database {
  let armed = true;
  return new Proxy(real, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          const s = t.prepare(sql);
          if (!armed || !/^INSERT (OR IGNORE )?INTO jobs\b/.test(sql)) return s;
          armed = false;
          const boom = () => Promise.reject(new Error("D1_ERROR"));
          return {
            bind: () => ({ first: boom, run: boom, all: boom, [BAD]: true }),
          };
        };
      if (k === "batch")
        return async (st: unknown[]) => {
          if (st.some((x) => (x as Record<symbol, unknown>)[BAD]))
            throw new Error("D1_ERROR");
          return t.batch(st as D1PreparedStatement[]);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** The platform D1, recording the SQL of each batch it runs. */
function recording(real: D1Database) {
  const sqlOf = new WeakMap<object, string>();
  const batches: string[][] = [];
  const wrapped = new Proxy(real, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          const s = t.prepare(sql);
          return new Proxy(s, {
            get(ps, pk) {
              if (pk === "bind")
                return (...v: unknown[]) => {
                  const b = ps.bind(...v);
                  sqlOf.set(b, sql);
                  return b;
                };
              const pv = Reflect.get(ps, pk);
              return typeof pv === "function" ? pv.bind(ps) : pv;
            },
          });
        };
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          batches.push(st.map((x) => sqlOf.get(x) ?? ""));
          return t.batch(st);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db: wrapped, batches };
}

function fakes() {
  const provision = new FakeWorkflow();
  const manage = new FakeWorkflow();
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    PROVISION_INSTALL: provision,
    MANAGE_INSTALL: manage,
  } as unknown as ProvapiEnv;
  return { env, provision, manage };
}

const run = (env: ProvapiEnv, now = NOW) =>
  sweep(env, now, { settleFailed: fakeSettle });

const jobRow = async (id: string) =>
  (await rows("SELECT * FROM jobs WHERE id = ?1", id))[0];
const cleanups = () =>
  rows("SELECT * FROM jobs WHERE kind = 'cleanup' ORDER BY created_at");

beforeEach(() => {
  settled.length = 0;
});

describe("sweep: unstarted jobs", () => {
  it("the API's create failed: the next tick starts it, params exactly { jobId }", async () => {
    const f = fakes();
    const id = await job(installId(), { created_at: OLD });
    f.provision.failNextCreate(new Error("network"));
    await expect(
      f.provision.create({ id, params: { jobId: id } }),
    ).rejects.toThrow();
    const lines = captureLogs(vi.spyOn);
    await run(f.env);
    expect(f.provision.created).toEqual([{ id, params: { jobId: id } }]);
    expect(f.manage.created).toEqual([]);
    expect(lines).toEqual([`provapi sweep started ${id}`]);
    // Started: the next tick leaves it alone.
    await run(f.env, NOW + TICK);
    expect(f.provision.created).toHaveLength(1);
  });

  it("a sweep create that fails is retried on the next tick", async () => {
    const f = fakes();
    const id = await job(installId(), { created_at: OLD });
    f.provision.failNextCreate(new Error("D1_ERROR owner@customer.test"));
    const lines = captureLogs(vi.spyOn);
    await run(f.env);
    expect(lines).toEqual([`provapi sweep start_failed rpc_error ${id}`]);
    await run(f.env, NOW + TICK);
    expect(f.provision.created.map((c) => c.id)).toEqual([id]);
  });

  it("inside the start grace, the API's own create is not raced", async () => {
    const f = fakes();
    await job(installId(), { created_at: OLD + 1 });
    await run(f.env);
    expect(f.provision.created).toEqual([]);
  });

  it("'already exists' counts as started", async () => {
    const id = await job(installId(), { created_at: OLD });
    const racy: WorkflowLike = {
      get: async (i) => {
        throw new WorkflowNotFoundError(i);
      },
      create: async (o) => {
        throw new Error(`instance ${o.id} already exists`);
      },
    };
    const env = { ...fakes().env, PROVISION_INSTALL: racy } as ProvapiEnv;
    const lines = captureLogs(vi.spyOn);
    await run(env);
    expect(lines).toEqual([`provapi sweep started ${id}`]);
  });

  it("a manage_install job starts on MANAGE_INSTALL", async () => {
    const f = fakes();
    const id = await job(installId(), {
      kind: "suspend",
      workflow: "manage_install",
      created_at: OLD,
    });
    await run(f.env);
    expect(f.manage.created.map((c) => c.id)).toEqual([id]);
    expect(f.provision.created).toEqual([]);
  });

  it("workflow 'none' and finished jobs are never looked at", async () => {
    const f = fakes();
    await job(installId(), { workflow: "none", created_at: OLD });
    await job(installId(), { status: "done", created_at: OLD });
    await job(installId(), { status: "failed", created_at: OLD });
    await run(f.env);
    expect(f.provision.created).toEqual([]);
    expect(settled).toEqual([]);
  });
});

describe("sweep: dead runs", () => {
  async function started(
    f: ReturnType<typeof fakes>,
    status: WorkflowInstanceStatus["status"],
    over: Record<string, string | number | null> = {},
  ) {
    const inst = installId();
    const id = await job(inst, { status: "running", signup_id: "SG", ...over });
    const wf = over.workflow === "manage_install" ? f.manage : f.provision;
    await wf.create({ id, params: { jobId: id } });
    wf.setStatus(id, status);
    return { id, inst };
  }

  for (const status of ["errored", "terminated", "complete"] as const)
    it(`${status}: settled with run_dead, then one cleanup job, started`, async () => {
      const f = fakes();
      const { id, inst } = await started(f, status);
      // errored and terminated wait JOB_TERMINATED_GRACE_MS from first sight.
      const waits = status !== "complete";
      const at = waits ? NOW + JOB_TERMINATED_GRACE_MS : NOW;
      if (waits) {
        captureLogs(vi.spyOn);
        await run(f.env);
        expect(settled).toEqual([]);
        vi.restoreAllMocks();
      }
      const lines = captureLogs(vi.spyOn);
      await run(f.env, at);
      expect(settled).toEqual([{ jobId: id, code: RUN_DEAD }]);
      const [c, ...rest] = await cleanups();
      expect(rest).toEqual([]);
      expect(c).toMatchObject({
        kind: "cleanup",
        workflow: "manage_install",
        install_id: inst,
        signup_id: "SG",
        parent_job_id: id,
        actor_kind: SYSTEM_ACTOR.kind,
        actor_key: SYSTEM_ACTOR.key,
        request_id: cleanupRequestId(id),
        status: "queued",
        created_at: at,
      });
      expect(JSON.parse(String(c?.args))).toEqual({ parentJobId: id });
      expect(c?.id).toMatch(ULID_RE);
      expect(c?.request_id).toMatch(REQUEST_ID_RE);
      expect(f.manage.created).toEqual([
        { id: c?.id, params: { jobId: c?.id } },
      ]);
      expect(lines).toEqual([
        `provapi sweep settled ${id} ${RUN_DEAD}`,
        `provapi sweep cleanup ${c?.id} ${id}`,
      ]);
    });

  it("an open job already holding a code (a cancel that died before its settle and cleanup): settled, the code kept, one cleanup, started once", async () => {
    const f = fakes();
    const { id } = await started(f, "complete", { error_code: "canceled" });
    await run(f.env);
    expect(settled).toEqual([{ jobId: id, code: RUN_DEAD }]);
    expect(await jobRow(id)).toMatchObject({
      status: "failed",
      error_code: "canceled",
    });
    const [c, ...rest] = await cleanups();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      parent_job_id: id,
      request_id: cleanupRequestId(id),
      status: "queued",
    });
    expect(f.manage.created).toEqual([{ id: c?.id, params: { jobId: c?.id } }]);
    // The next tick finds it settled: no second cleanup, no second start.
    await run(f.env, NOW + TICK);
    expect(await cleanups()).toHaveLength(1);
    expect(f.manage.created).toHaveLength(1);
  });

  it("an open job holding canceled whose cancel settles and queues its cleanup before the sweep's settle (R25): no second cleanup, the batch does not fail", async () => {
    const f = fakes();
    const { id, inst } = await started(f, "complete", {
      error_code: "canceled",
    });
    // Mutation: a plain INSERT (no OR IGNORE, no ON CONFLICT) fails this
    // batch on jobs_one_active.
    let result: Awaited<ReturnType<SettleFailed>> | undefined;
    // The sweep read the stored canceled, so its guard is
    // settledWith(?5, canceled), true once the cancel settles: only
    // INSERT OR IGNORE (jobs_one_active) keeps the batch from failing.
    const afterCancel: SettleFailed = async (d, jobId, code, opts) => {
      await db
        .prepare("UPDATE jobs SET status = 'failed' WHERE id = ?1")
        .bind(jobId)
        .run();
      await job(inst, {
        kind: "cleanup",
        workflow: "manage_install",
        parent_job_id: jobId,
        request_id: `admin-cancel-${jobId}`,
      });
      result = await fakeSettle(d, jobId, code, opts);
      return result;
    };
    const lines = captureLogs(vi.spyOn);
    await sweep(f.env, NOW, { settleFailed: afterCancel });
    expect(result?.settled).toBe(false);
    expect(result?.extra).toHaveLength(1);
    expect(lines).toEqual([]);
    expect((await jobRow(id))?.error_code).toBe("canceled");
    expect((await cleanups()).map((c) => [c.request_id, c.status])).toEqual([
      [`admin-cancel-${id}`, "queued"],
    ]);
    expect(f.manage.created).toEqual([]);
  });

  it("the cleanup rides in the settle's batch as INSERT OR IGNORE, guarded by the parent settled with its stored code (run_dead when none) and no cleanup child", async () => {
    const f = fakes();
    const { id } = await started(f, "complete");
    const rec = recording(db);
    const lines = captureLogs(vi.spyOn);
    await run({ ...f.env, PLATFORM_DB: rec.db } as ProvapiEnv);
    const settleBatch = rec.batches.find((b) =>
      b.some((q) => q.startsWith("UPDATE jobs SET status = 'failed'")),
    );
    const inserts = (settleBatch ?? []).filter((q) =>
      /^INSERT\b.*\bINTO jobs\b/.test(q),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/^INSERT OR IGNORE INTO jobs /);
    expect(inserts[0]).toContain(settledWith("?5", RUN_DEAD));
    expect(inserts[0]).toContain(
      "AND NOT EXISTS (SELECT 1 FROM jobs c WHERE c.parent_job_id = ?5 AND c.kind = 'cleanup')",
    );
    const [c, ...rest] = await cleanups();
    expect(rest).toEqual([]);
    expect(f.manage.created).toEqual([{ id: c?.id, params: { jobId: c?.id } }]);
    expect(lines).toEqual([
      `provapi sweep settled ${id} ${RUN_DEAD}`,
      `provapi sweep cleanup ${c?.id} ${id}`,
    ]);
  });

  it("an open job holding canceled whose cancel settles and finishes its cleanup before the sweep's batch: no second cleanup, the batch does not fail", async () => {
    const f = fakes();
    const { id, inst } = await started(f, "complete", {
      error_code: "canceled",
    });
    // The sweep read the stored canceled, so settledWith(?5, canceled) is
    // true once the cancel settles, and a finished cleanup never trips
    // jobs_one_active: only the no-cleanup-child guard keeps a second one out.
    let result: Awaited<ReturnType<SettleFailed>> | undefined;
    const afterCancel: SettleFailed = async (d, jobId, code, opts) => {
      await db
        .prepare("UPDATE jobs SET status = 'failed' WHERE id = ?1")
        .bind(jobId)
        .run();
      await job(inst, {
        kind: "cleanup",
        workflow: "manage_install",
        parent_job_id: jobId,
        request_id: `admin-cancel-${jobId}`,
        status: "done",
      });
      result = await fakeSettle(d, jobId, code, opts);
      return result;
    };
    const lines = captureLogs(vi.spyOn);
    await sweep(f.env, NOW, { settleFailed: afterCancel });
    expect(result?.settled).toBe(false);
    expect(result?.extra).toHaveLength(1);
    expect(lines).toEqual([]);
    expect((await jobRow(id))?.error_code).toBe("canceled");
    expect((await cleanups()).map((c) => [c.request_id, c.status])).toEqual([
      [`admin-cancel-${id}`, "done"],
    ]);
    expect(f.manage.created).toEqual([]);
  });

  it("a canceled-but-unsettled open job (stored canceled, no cleanup): exactly one cleanup across two ticks, started once", async () => {
    const f = fakes();
    const { id } = await started(f, "complete", { error_code: "canceled" });
    await run(f.env);
    await run(f.env, NOW + TICK);
    expect(await jobRow(id)).toMatchObject({
      status: "failed",
      error_code: "canceled",
    });
    const [c, ...rest] = await cleanups();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      parent_job_id: id,
      request_id: cleanupRequestId(id),
    });
    expect(f.manage.created).toEqual([{ id: c?.id, params: { jobId: c?.id } }]);
  });

  it("a stored error_code outside PROVISION_ERROR_CODES: the job is left untouched with one fixed line; other jobs in the tick are still processed", async () => {
    const f = fakes();
    const bad = await started(f, "complete", { error_code: "bogus_code" });
    const good = await started(f, "complete");
    const lines = captureLogs(vi.spyOn);
    await run(f.env);
    expect(await jobRow(bad.id)).toMatchObject({
      status: "running",
      error_code: "bogus_code",
    });
    expect(settled).toEqual([{ jobId: good.id, code: RUN_DEAD }]);
    const [c, ...rest] = await cleanups();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ parent_job_id: good.id });
    expect(f.manage.created).toEqual([{ id: c?.id, params: { jobId: c?.id } }]);
    expect(lines.filter((l) => l.includes(bad.id))).toEqual([]);
    expect(lines.filter((l) => l.includes("bogus"))).toEqual([]);
    expect(
      lines.filter((l) => l === "provapi sweep skipped bad_code"),
    ).toHaveLength(1);
  });

  it("a sweep landing after an R25 cancel (parent canceled, its cleanup open): no second cleanup, the batch does not fail", async () => {
    const f = fakes();
    const { id, inst } = await started(f, "complete");
    // Mutation: the guard dropped AND a plain INSERT fails this batch on
    // jobs_one_active. Either alone passes here (the guard is false, so no
    // insert is tried); a plain INSERT alone is caught by the stored-canceled
    // R25 test above.
    let result: Awaited<ReturnType<SettleFailed>> | undefined;
    const afterCancel: SettleFailed = async (d, jobId, code, opts) => {
      // R25: one batch marks it canceled and queues the admin's cleanup.
      await db.batch([
        db
          .prepare(
            "UPDATE jobs SET status = 'failed', error_code = 'canceled' WHERE id = ?1",
          )
          .bind(jobId),
      ]);
      await job(inst, {
        kind: "cleanup",
        workflow: "manage_install",
        parent_job_id: jobId,
        request_id: `admin-cancel-${jobId}`,
      });
      result = await fakeSettle(d, jobId, code, opts);
      return result;
    };
    const lines = captureLogs(vi.spyOn);
    await sweep(f.env, NOW, { settleFailed: afterCancel });
    expect(result?.settled).toBe(false);
    expect(result?.extra).toHaveLength(1);
    expect(lines).toEqual([]);
    expect((await jobRow(id))?.error_code).toBe("canceled");
    expect((await cleanups()).map((c) => [c.request_id, c.status])).toEqual([
      [`admin-cancel-${id}`, "queued"],
    ]);
    expect(f.manage.created).toEqual([]);
  });

  for (const other of ["canceled", "cf_error", "internal"] as const)
    it(`the parent settled elsewhere with ${other} (no cleanup of its own): the sweep adds none`, async () => {
      const f = fakes();
      const { id } = await started(f, "complete");
      const elsewhere: SettleFailed = async (d, jobId, code, opts) => {
        await db
          .prepare(
            "UPDATE jobs SET status = 'failed', error_code = ?2 WHERE id = ?1",
          )
          .bind(jobId, other)
          .run();
        return fakeSettle(d, jobId, code, opts);
      };
      const lines = captureLogs(vi.spyOn);
      await sweep(f.env, NOW, { settleFailed: elsewhere });
      expect(settled).toEqual([]);
      expect(lines).toEqual([]);
      expect((await jobRow(id))?.error_code).toBe(other);
      expect(await cleanups()).toEqual([]);
      expect(f.manage.created).toEqual([]);
    });

  it("two ticks both reaching the settle: one cleanup, started once, neither batch fails", async () => {
    const f = fakes();
    const { id } = await started(f, "complete");
    // Mutation: a plain INSERT fails the second tick's batch (the first
    // tick's cleanup-<jobId> is already in). The guard dropped passes here (both ticks' guards are
    // true either way); that mutation is caught by the settled-elsewhere and
    // finished-cleanup tests.
    // Both ticks pass the still-open check before either settles.
    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const results: Awaited<ReturnType<SettleFailed>>[] = [];
    const both: SettleFailed = async (d, jobId, code, opts) => {
      if (++arrived === 2) release();
      await gate;
      const r = await fakeSettle(d, jobId, code, opts);
      results.push(r);
      return r;
    };
    const lines = captureLogs(vi.spyOn);
    await Promise.all([
      sweep(f.env, NOW, { settleFailed: both }),
      sweep(f.env, NOW, { settleFailed: both }),
    ]);
    expect(results.map((r) => r.settled).sort()).toEqual([false, true]);
    const [c, ...rest] = await cleanups();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ parent_job_id: id, request_id: `cleanup-${id}` });
    expect(f.manage.created).toEqual([{ id: c?.id, params: { jobId: c?.id } }]);
    expect(lines.filter((l) => l.includes("_failed"))).toEqual([]);
  });

  it("a cancel between terminate and its own settle wins: the sweep neither settles nor adds a cleanup", async () => {
    const f = fakes();
    const { id, inst } = await started(f, "terminated");
    captureLogs(vi.spyOn);
    // R25 cancel terminated the instance; the sweep lands before its settle.
    await run(f.env);
    expect(settled).toEqual([]);
    expect(await cleanups()).toEqual([]);
    // The cancel settles with canceled and inserts its own cleanup.
    await db
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'canceled', finished_at = ?2, updated_at = ?2 WHERE id = ?1",
      )
      .bind(id, NOW + 1)
      .run();
    const own = await job(inst, {
      kind: "cleanup",
      workflow: "manage_install",
      parent_job_id: id,
      request_id: `cancel-${id}`,
      created_at: NOW + 1,
      updated_at: NOW + 1,
    });
    await run(f.env, NOW + JOB_TERMINATED_GRACE_MS);
    expect(settled.map((x) => x.jobId)).not.toContain(id);
    expect((await jobRow(id))?.error_code).toBe("canceled");
    expect((await cleanups()).map((c) => c.id)).toEqual([own]);
    // Its first-sight marker is gone once the job is closed.
    expect(
      await rows(
        "SELECT key FROM platform_state WHERE key = ?1",
        sweepTerminatedKey(id),
      ),
    ).toEqual([]);
  });

  for (const status of ["errored", "terminated"] as const)
    it(`${status}: a run nobody settles is settled once JOB_TERMINATED_GRACE_MS has passed since first sight`, async () => {
      const f = fakes();
      const { id } = await started(f, status);
      captureLogs(vi.spyOn);
      await run(f.env);
      await run(f.env, NOW + JOB_TERMINATED_GRACE_MS - 1);
      expect(settled).toEqual([]);
      await run(f.env, NOW + JOB_TERMINATED_GRACE_MS);
      expect(settled).toEqual([{ jobId: id, code: RUN_DEAD }]);
      expect(await cleanups()).toHaveLength(1);
      expect(
        await rows(
          "SELECT key FROM platform_state WHERE key = ?1",
          sweepTerminatedKey(id),
        ),
      ).toEqual([]);
    });

  it("the two graces are separate: a queued job with no instance starts at JOB_START_GRACE_MS, an errored run settles only at JOB_TERMINATED_GRACE_MS", async () => {
    expect(JOB_START_GRACE_MS).toBeLessThan(JOB_TERMINATED_GRACE_MS);
    const f = fakes();
    const queued = await job(installId(), { created_at: NOW });
    const { id: dead } = await started(f, "errored");
    captureLogs(vi.spyOn);
    await run(f.env, NOW + JOB_START_GRACE_MS - 1);
    expect(f.provision.created.map((c) => c.id)).toEqual([dead]);
    await run(f.env, NOW + JOB_START_GRACE_MS);
    expect(f.provision.created.map((c) => c.id)).toEqual([dead, queued]);
    expect(settled).toEqual([]);
    // First sight of the errored run was at NOW + JOB_START_GRACE_MS - 1.
    await run(
      f.env,
      NOW + JOB_START_GRACE_MS - 1 + JOB_TERMINATED_GRACE_MS - 1,
    );
    expect(settled).toEqual([]);
    await run(f.env, NOW + JOB_START_GRACE_MS - 1 + JOB_TERMINATED_GRACE_MS);
    expect(settled).toEqual([{ jobId: dead, code: RUN_DEAD }]);
  });

  it("settleFailed saying it did not settle (another settle got there first): no settled line, no cleanup", async () => {
    const f = fakes();
    const { id, inst } = await started(f, "complete");
    const lost: SettleFailed = async (d, jobId, code, opts) => {
      // A cancel settles the job and inserts its own cleanup in between.
      await db
        .prepare(
          "UPDATE jobs SET status = 'failed', error_code = 'canceled' WHERE id = ?1",
        )
        .bind(jobId)
        .run();
      await job(inst, {
        kind: "cleanup",
        workflow: "manage_install",
        parent_job_id: jobId,
        request_id: `cancel-${jobId}`,
      });
      return fakeSettle(d, jobId, code, opts);
    };
    const lines = captureLogs(vi.spyOn);
    await sweep(f.env, NOW, { settleFailed: lost });
    expect(settled).toEqual([]);
    expect(lines).toEqual([]);
    expect((await cleanups()).map((c) => c.request_id)).toEqual([
      `cancel-${id}`,
    ]);
    expect(f.manage.created).toEqual([]);
  });

  it("a cancel settling first whose cleanup already finished: the sweep inserts and starts no cleanup", async () => {
    const f = fakes();
    const { id, inst } = await started(f, "complete");
    const lost: SettleFailed = async (d, jobId, code, opts) => {
      await db
        .prepare(
          "UPDATE jobs SET status = 'failed', error_code = 'canceled' WHERE id = ?1",
        )
        .bind(jobId)
        .run();
      await job(inst, {
        kind: "cleanup",
        workflow: "manage_install",
        parent_job_id: jobId,
        request_id: `cancel-${jobId}`,
        status: "done",
      });
      return fakeSettle(d, jobId, code, opts);
    };
    const lines = captureLogs(vi.spyOn);
    await sweep(f.env, NOW, { settleFailed: lost });
    expect(settled).toEqual([]);
    expect(lines).toEqual([]);
    expect((await cleanups()).map((c) => c.request_id)).toEqual([
      `cancel-${id}`,
    ]);
    expect(f.manage.created).toEqual([]);
  });

  it("a running job whose instance is missing is dead", async () => {
    const f = fakes();
    const id = await job(installId(), { status: "running" });
    await run(f.env);
    expect(settled.map((s) => s.jobId)).toEqual([id]);
    expect(await cleanups()).toHaveLength(1);
  });

  for (const status of [
    "queued",
    "running",
    "waiting",
    "paused",
    "waitingForPause",
    "unknown",
  ] as const)
    it(`${status}: left alone`, async () => {
      const f = fakes();
      const { id } = await started(f, status);
      await run(f.env);
      expect(settled).toEqual([]);
      expect(await cleanups()).toEqual([]);
      expect((await jobRow(id))?.status).toBe("running");
    });

  it("two overlapping ticks make one cleanup", async () => {
    const f = fakes();
    const { id } = await started(f, "complete");
    await Promise.all([run(f.env), run(f.env)]);
    expect(await cleanups()).toHaveLength(1);
    expect(f.manage.created).toHaveLength(1);
    // A later tick: the parent is failed, the cleanup is running.
    await run(f.env, NOW + TICK);
    expect(await cleanups()).toHaveLength(1);
    expect((await jobRow(id))?.status).toBe("failed");
  });

  it("a run that finished its job after the select is left alone (no settle, no cleanup)", async () => {
    const f = fakes();
    const { id } = await started(f, "complete");
    const real = f.provision.get.bind(f.provision);
    f.provision.get = async (i) => {
      // The run's last step marks the job done meanwhile.
      await db
        .prepare("UPDATE jobs SET status = 'done' WHERE id = ?1")
        .bind(id)
        .run();
      return real(i);
    };
    await run(f.env);
    expect(settled).toEqual([]);
    expect(await cleanups()).toEqual([]);
    expect((await jobRow(id))?.status).toBe("done");
  });

  it("settle and cleanup are one batch: a failed cleanup insert leaves the job open, and the next sweep settles it with its cleanup", async () => {
    const f = fakes();
    const { id } = await started(f, "complete");
    const flaky = {
      ...f.env,
      PLATFORM_DB: failFirstJobInsert(db),
    } as ProvapiEnv;
    await run(flaky);
    expect(await cleanups()).toEqual([]);
    expect((await jobRow(id))?.status).toBe("running");
    await run(f.env, NOW + TICK);
    expect((await jobRow(id))?.status).toBe("failed");
    const [c, ...rest] = await cleanups();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ parent_job_id: id, request_id: `cleanup-${id}` });
    expect(f.manage.created.map((x) => x.id)).toEqual([c?.id]);
  });

  it("a dead cleanup job is settled only, never given another cleanup", async () => {
    const f = fakes();
    const { id } = await started(f, "complete", {
      kind: "cleanup",
      workflow: "manage_install",
    });
    await run(f.env);
    expect(settled.map((s) => s.jobId)).toEqual([id]);
    expect((await cleanups()).map((c) => c.id)).toEqual([id]);
    expect(f.manage.created).toHaveLength(1);
  });

  it("a failed cleanup start leaves it queued; a later sweep starts it", async () => {
    const f = fakes();
    await started(f, "complete");
    f.manage.failNextCreate(new Error("boom"));
    const lines = captureLogs(vi.spyOn);
    await run(f.env);
    const [c] = await cleanups();
    expect(lines.at(-1)).toBe(
      `provapi sweep cleanup_failed rpc_error ${f.provision.created[0]?.id}`,
    );
    expect(f.manage.created).toEqual([]);
    await run(f.env, NOW + JOB_START_GRACE_MS);
    expect(f.manage.created.map((x) => x.id)).toEqual([c?.id]);
  });
});

describe("sweep: failures", () => {
  it("a get() that fails (not 'not found') is an rpc_error: nothing settled or started", async () => {
    const id = await job(installId(), { status: "running", created_at: OLD });
    const down: WorkflowLike = {
      get: async () => {
        throw new Error("internal error owner@customer.test");
      },
      create: async () => {
        throw new Error("unreachable");
      },
    };
    const env = { ...fakes().env, PROVISION_INSTALL: down } as ProvapiEnv;
    const lines = captureLogs(vi.spyOn);
    await run(env);
    expect(lines).toEqual([`provapi sweep status_failed rpc_error ${id}`]);
    expect(settled).toEqual([]);
  });

  it("settleFailed failing settles nothing and inserts no cleanup", async () => {
    const f = fakes();
    const id = await job(installId(), { status: "running" });
    const lines = captureLogs(vi.spyOn);
    const throws: SettleFailed = async () => {
      throw new Error("settle failed");
    };
    await sweep(f.env, NOW, { settleFailed: throws });
    expect(lines).toEqual([`provapi sweep settle_failed exception ${id}`]);
    expect(await cleanups()).toEqual([]);
    expect((await jobRow(id))?.status).toBe("running");
  });

  it("the real settleFailed (W3) settles a dead run and inserts its one cleanup", async () => {
    const f = fakes();
    const id = await job(installId(), { status: "running" });
    const lines = captureLogs(vi.spyOn);
    await sweep(f.env, NOW);
    expect(lines[0]).toBe(`provapi sweep settled ${id} run_dead`);
    expect(lines[1]).toMatch(new RegExp(`^provapi sweep cleanup \\S+ ${id}$`));
    expect(await cleanups()).toHaveLength(1);
    expect(await jobRow(id)).toMatchObject({
      status: "failed",
      error_code: "run_dead",
    });
    // The next tick: already settled, no second cleanup.
    await sweep(f.env, NOW);
    expect(await cleanups()).toHaveLength(1);
  });

  it("an unbound Workflow binding fails the duty as unbound", async () => {
    const env = { ...fakes().env, MANAGE_INSTALL: undefined } as ProvapiEnv;
    await expect(run(env)).rejects.toEqual(new DutyFailure("unbound"));
  });

  it(`an unstarted job is started behind ${SWEEP_LIMIT} older live runs`, async () => {
    const f = fakes();
    for (let n = 0; n < SWEEP_LIMIT; n++) {
      const id = await job(installId(), {
        status: "running",
        created_at: OLD - 1,
        updated_at: n,
      });
      await f.provision.create({ id, params: { jobId: id } });
      f.provision.setStatus(id, "running");
    }
    const fresh = await job(installId(), { created_at: OLD, updated_at: NOW });
    await run(f.env);
    expect(f.provision.created.map((c) => c.id)).toContain(fresh);
  });

  it(`a dead run behind ${SWEEP_LIMIT} idle live runs is settled within a few ticks`, async () => {
    const f = fakes();
    for (let n = 0; n < SWEEP_LIMIT; n++) {
      const id = await job(installId(), {
        status: "running",
        created_at: OLD - 1,
        updated_at: n,
      });
      await f.provision.create({ id, params: { jobId: id } });
      f.provision.setStatus(id, "running");
    }
    const dead = await job(installId(), {
      status: "running",
      created_at: OLD - 1,
      updated_at: NOW,
    });
    await f.provision.create({ id: dead, params: { jobId: dead } });
    f.provision.setStatus(dead, "complete");
    captureLogs(vi.spyOn);
    for (let t = 0; t < 3 && !settled.length; t++)
      await run(f.env, NOW + t * TICK);
    expect(settled.map((x) => x.jobId)).toEqual([dead]);
  });

  it("a Workflow binding error that is not a missing instance (workflow.not_found) leaves the job alone", async () => {
    const id = await job(installId(), { status: "running", created_at: OLD });
    const undeployed: WorkflowLike = {
      get: async () => {
        throw new Error("workflow.not_found");
      },
      create: async () => {
        throw new Error("workflow.not_found");
      },
    };
    const env = { ...fakes().env, PROVISION_INSTALL: undeployed } as ProvapiEnv;
    const lines = captureLogs(vi.spyOn);
    await run(env);
    expect(lines).toEqual([`provapi sweep status_failed rpc_error ${id}`]);
    expect(settled).toEqual([]);
    expect(await cleanups()).toEqual([]);
    expect((await jobRow(id))?.status).toBe("running");
  });

  it("only a WorkflowNotFoundError is a missing instance: a not-found message alone fails closed", async () => {
    const f = fakes();
    const id = await job(installId(), { status: "running", created_at: OLD });
    const untyped: WorkflowLike = {
      get: async (i) => {
        throw new Error(`instance.not_found instance ${i} not found`);
      },
      create: (o) => f.provision.create(o),
    };
    const env = { ...f.env, PROVISION_INSTALL: untyped } as ProvapiEnv;
    const lines = captureLogs(vi.spyOn);
    await run(env);
    expect(lines).toEqual([`provapi sweep status_failed rpc_error ${id}`]);
    expect(settled).toEqual([]);
    expect(f.provision.created).toEqual([]);
  });

  for (const status of ["pending", "waiting_cap"] as const)
    it(`a self-serve create whose signup is ${status} is never started by the sweep (the queue consumer admits it)`, async () => {
      const f = fakes();
      const id = installId();
      const sg = await signup({
        source: "self-serve",
        owner_sub: "sub",
        status,
      });
      await job(id, { id: sg, signup_id: sg, created_at: OLD });
      captureLogs(vi.spyOn);
      for (let t = 0; t < 3; t++) await run(f.env, NOW + t * TICK);
      expect(f.provision.created).toEqual([]);
    });

  it("a self-serve create whose signup was admitted (queued) is started", async () => {
    const f = fakes();
    const sg = await signup({
      source: "self-serve",
      owner_sub: "sub",
      status: "queued",
    });
    await job(installId(), { id: sg, signup_id: sg, created_at: OLD });
    captureLogs(vi.spyOn);
    await run(f.env);
    expect(f.provision.created.map((c) => c.id)).toEqual([sg]);
  });

  it("looks at SWEEP_LIMIT jobs per tick", async () => {
    const f = fakes();
    for (let n = 0; n <= SWEEP_LIMIT; n++)
      await job(installId(), { created_at: OLD, updated_at: n });
    await run(f.env);
    expect(f.provision.created).toHaveLength(SWEEP_LIMIT);
  });
});
