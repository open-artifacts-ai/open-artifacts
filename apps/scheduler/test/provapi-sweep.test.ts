import type { SettleFailed } from "@oa/provision/jobs";
import {
  REQUEST_ID_RE,
  ULID_RE,
  type WorkflowInstanceStatus,
  type WorkflowLike,
} from "@oa/shared/provisioning";
import { FakeWorkflow } from "@oa/shared/provisioning/fakes";
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
import { SYSTEM_ACTOR } from "../src/provapi/jobs.js";
import {
  DEAD_RUN_CODE,
  START_GRACE_MS,
  SWEEP_LIMIT,
  sweep,
} from "../src/provapi/sweep.js";
import {
  captureLogs,
  db,
  installId,
  job,
  migrate,
  reset,
  rows,
} from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const TICK = 2 * 60_000;
const OLD = NOW - START_GRACE_MS;

/** W3's settleFailed, as far as the sweep relies on it: the job to failed. */
const settled: { jobId: string; code: string }[] = [];
const fakeSettle: SettleFailed = async (d, jobId, code) => {
  settled.push({ jobId, code });
  await (d as D1Database)
    .prepare(
      "UPDATE jobs SET status = 'failed', error_code = COALESCE(error_code, ?2), finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('queued', 'running')",
    )
    .bind(jobId, code, NOW)
    .run();
};

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
        throw new Error(`instance ${i} not found`);
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
    it(`${status}: settled, then one cleanup job, started`, async () => {
      const f = fakes();
      const { id, inst } = await started(f, status);
      const lines = captureLogs(vi.spyOn);
      await run(f.env);
      expect(settled).toEqual([{ jobId: id, code: DEAD_RUN_CODE }]);
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
        request_id: `cleanup-${id}`,
        status: "queued",
        created_at: NOW,
      });
      expect(c?.id).toMatch(ULID_RE);
      expect(c?.request_id).toMatch(REQUEST_ID_RE);
      expect(f.manage.created).toEqual([
        { id: c?.id, params: { jobId: c?.id } },
      ]);
      expect(lines).toEqual([
        `provapi sweep settled ${id} ${DEAD_RUN_CODE}`,
        `provapi sweep cleanup ${c?.id} ${id}`,
      ]);
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
    const { id } = await started(f, "errored");
    await Promise.all([run(f.env), run(f.env)]);
    expect(await cleanups()).toHaveLength(1);
    expect(f.manage.created).toHaveLength(1);
    // A later tick: the parent is failed, the cleanup is running.
    await run(f.env, NOW + TICK);
    expect(await cleanups()).toHaveLength(1);
    expect((await jobRow(id))?.status).toBe("failed");
  });

  it("a dead cleanup job is settled only, never given another cleanup", async () => {
    const f = fakes();
    const { id } = await started(f, "errored", {
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
    await started(f, "terminated");
    f.manage.failNextCreate(new Error("boom"));
    const lines = captureLogs(vi.spyOn);
    await run(f.env);
    const [c] = await cleanups();
    expect(lines.at(-1)).toBe(
      `provapi sweep cleanup_failed rpc_error ${f.provision.created[0]?.id}`,
    );
    expect(f.manage.created).toEqual([]);
    await run(f.env, NOW + START_GRACE_MS);
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

  it("settleFailed failing (today's W3 stub throws) settles nothing and inserts no cleanup", async () => {
    const f = fakes();
    const id = await job(installId(), { status: "running" });
    const lines = captureLogs(vi.spyOn);
    await sweep(f.env, NOW);
    expect(lines).toEqual([`provapi sweep settle_failed exception ${id}`]);
    expect(await cleanups()).toEqual([]);
    expect((await jobRow(id))?.status).toBe("running");
  });

  it("an unbound Workflow binding fails the duty as unbound", async () => {
    const env = { ...fakes().env, MANAGE_INSTALL: undefined } as ProvapiEnv;
    await expect(run(env)).rejects.toEqual(new DutyFailure("unbound"));
  });

  it("looks at SWEEP_LIMIT jobs per tick", async () => {
    const f = fakes();
    for (let n = 0; n <= SWEEP_LIMIT; n++)
      await job(installId(), { created_at: OLD, updated_at: n });
    await run(f.env);
    expect(f.provision.created).toHaveLength(SWEEP_LIMIT);
  });
});
