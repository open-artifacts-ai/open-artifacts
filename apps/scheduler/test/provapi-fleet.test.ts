import { canTransition, REQUEST_ID_RE } from "@oa/shared/provisioning";
import {
  FakeWorkflow,
  fakeProvisionerRpc,
} from "@oa/shared/provisioning/fakes";
import { SYSTEM_ACTOR } from "@oa/shared/provisioning/system";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ProvapiEnv } from "../src/provapi/env.js";
import {
  FLEET_BUDGET_MS,
  FLEET_CONCURRENCY,
  FLEET_FAILING_PREFIX,
  FLEET_ROLLBACK_WINDOW_MS,
  FLEET_SKEW_MS,
  fleetConditions,
  fleetDue,
  fleetRequestId,
  fleetRollbackRequestId,
  fleetSince,
  fleetTarget,
} from "../src/provapi/fleet.js";
import type { HealthProbe } from "../src/provapi/health.js";
import {
  captureLogs,
  db,
  install,
  installId,
  job,
  lifecycle,
  migrate,
  reset,
  rows,
} from "./provapi/db.js";

// #955: the fleet rollout. Every install follows the scheduler's own version
// tag, canary first; failures halt it and an unhealthy upgrade rolls back.
// "review N" names the #1083 review finding a test pins.

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const MIN = 60_000;
const TARGET = "0.93.0";

/** Which installs answer /healthz on which version. */
type Answers = Map<string, string | "down">;

const release = (version: string, installable = true) => ({
  version,
  publishedAt: 1,
  variants: ["release" as const],
  installable,
  latest: true,
});

function fakes(
  o: {
    canary?: string;
    tag?: string;
    answers?: Answers;
    releases?: ReturnType<typeof release>[];
    manage?: unknown;
  } = {},
) {
  const manage = new FakeWorkflow();
  const answers: Answers = o.answers ?? new Map();
  const probed: string[] = [];
  const probe: HealthProbe = async (id) => {
    probed.push(id);
    const v = answers.get(id) ?? TARGET;
    if (v === "down") return new Response("no", { status: 502 });
    return Response.json({ ok: true, plan: "free", version: v, installId: id });
  };
  const tag = o.tag ?? `v${TARGET}`;
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    MANAGE_INSTALL: o.manage ?? manage,
    PROVISIONER: fakeProvisionerRpc({
      releases: o.releases ?? [release(tag.slice(1))],
    }),
    FLEET_CANARY: o.canary ?? "",
    CF_VERSION_METADATA: {
      id: "x",
      tag,
      timestamp: new Date(NOW - MIN).toISOString(),
    },
  } as unknown as ProvapiEnv;
  return { env, manage, answers, probed, opts: { probe, timeoutMs: 1_000 } };
}

/** A serving, active, idle install on `version`, created at `created`. */
async function on(
  version: string,
  over: {
    test_hooks?: number;
    suspended?: boolean;
    created?: number;
    serving?: string;
  } = {},
) {
  const id = installId();
  await install(id, {
    version,
    previous_version: "0.91.0",
    ...(over.test_hooks === undefined ? {} : { test_hooks: over.test_hooks }),
  });
  await lifecycle(id, {
    serving_mode: over.serving ?? "serving",
    created_at: over.created ?? 1,
    ...(over.suspended ? { suspended_at: NOW - MIN } : {}),
  });
  return id;
}

const fleetJobs = () =>
  rows(
    "SELECT * FROM jobs WHERE actor_key = ?1 ORDER BY created_at, request_id",
    SYSTEM_ACTOR.key,
  );
const finish = (jobId: unknown, status: string, at = NOW, code?: string) =>
  db
    .prepare(
      "UPDATE jobs SET status = ?2, finished_at = ?3, updated_at = ?3, error_code = ?4 WHERE id = ?1",
    )
    .bind(jobId, status, at, code ?? null)
    .run();
const lifecycleSuspend = (id: string) =>
  db
    .prepare(
      "UPDATE install_lifecycle SET suspended_at = ?2 WHERE install_id = ?1",
    )
    .bind(id, NOW)
    .run();
const setVersion = (id: string, v: string) =>
  db
    .prepare("UPDATE installs SET version = ?2 WHERE id = ?1")
    .bind(id, v)
    .run();
/** A fleet upgrade row, done by default. */
const fleetJob = (
  id: string,
  over: Record<string, string | number | null> & { from?: string; to?: string },
) => {
  const { from = "0.92.0", to = TARGET, ...rest } = over;
  return job(id, {
    kind: "upgrade",
    workflow: "manage_install",
    actor_kind: SYSTEM_ACTOR.kind,
    actor_key: SYSTEM_ACTOR.key,
    actor_label: SYSTEM_ACTOR.label,
    request_id: fleetRequestId(id, to),
    args: JSON.stringify({ from, to }),
    status: "done",
    finished_at: NOW - MIN,
    ...rest,
  });
};

describe("the target and request ids", () => {
  it("the target is the stable version tag, without its v", () => {
    expect(fleetTarget({ tag: "v0.93.0" })).toBe("0.93.0");
    for (const tag of ["0.93.0", "v0.93", "v0.93.0-rc.1", "", "vx.y.z"])
      expect(fleetTarget({ tag }), tag).toBeNull();
    expect(fleetTarget(undefined)).toBeNull();
    expect(fleetSince({ timestamp: "2026-11-02T12:00:00.000Z" })).toBe(NOW);
    expect(fleetSince({ timestamp: "" })).toBeNull();
  });

  it("request ids are one per install and version, and valid", () => {
    const id = installId();
    expect(fleetRequestId(id, "0.93.0")).toBe(`fleet-${id}-0_93_0`);
    expect(fleetRollbackRequestId(id, "0.93.0")).toBe(`fleetrb-${id}-0_93_0`);
    expect(fleetRequestId(id, "999.999.999")).toMatch(REQUEST_ID_RE);
    expect(() => fleetRequestId("nope", "0.93.0")).toThrow();
    expect(() => fleetRequestId(id, "0.93.0-rc.1")).toThrow();
  });

  it("the scheduler may upgrade and roll back an active install, never a suspended one", () => {
    expect(canTransition("active", "upgrade", "S")).toBe(true);
    expect(canTransition("active", "rollback", "S")).toBe(true);
    expect(canTransition("suspended", "upgrade", "S")).toBe(false);
    expect(canTransition("suspended", "rollback", "S")).toBe(false);
  });
});

describe("the rollout", () => {
  it("no canary or no target: nothing moves", async () => {
    const canary = await on("0.92.0");
    const lines = captureLogs(vi.spyOn);
    for (const f of [
      fakes({ canary: "" }),
      fakes({ canary: "canary" }),
      fakes({ canary, tag: "v0.93.0-rc.1" }),
    ])
      await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual([
      "provapi fleet no_canary",
      "provapi fleet no_canary",
      "provapi fleet no_target",
    ]);
  });

  it("the canary goes first: one system upgrade, started; no other install yet", async () => {
    const canary = await on("0.92.0", { created: 5 });
    await on("0.92.0", { created: 1 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j, ...rest] = await fleetJobs();
    expect(rest).toEqual([]);
    expect(j).toMatchObject({
      kind: "upgrade",
      workflow: "manage_install",
      install_id: canary,
      actor_kind: SYSTEM_ACTOR.kind,
      actor_key: SYSTEM_ACTOR.key,
      request_id: fleetRequestId(canary, TARGET),
      status: "queued",
    });
    expect(JSON.parse(String(j?.args))).toEqual({ from: "0.92.0", to: TARGET });
    expect(f.manage.created).toEqual([{ id: j?.id, params: { jobId: j?.id } }]);
    // A second tick while it runs adds nothing.
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(lines).toEqual(["provapi fleet canary_busy"]);
  });

  it("review 1: the canary on the target mid-job (version written, job running) holds the rest", async () => {
    const canary = await on(TARGET);
    await on("0.92.0");
    // ManageInstall wrote installs.version before verify_clean, health and
    // selftest; the job is still running and the row is upgrading.
    await fleetJob(canary, { status: "running", finished_at: null });
    await db
      .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?1")
      .bind(canary)
      .run();
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect((await fleetJobs()).filter((j) => j.install_id !== canary)).toEqual(
      [],
    );
    expect(lines).toEqual(["provapi fleet canary_busy"]);
    expect(f.probed).toEqual([]);
  });

  it("review 1: a canary whose latest upgrade to the target did not end done holds the rest", async () => {
    const canary = await on(TARGET);
    await on("0.92.0");
    // An admin's upgrade, failed after the version was written.
    await job(canary, {
      kind: "upgrade",
      workflow: "manage_install",
      args: JSON.stringify({ from: "0.92.0", to: TARGET }),
      status: "failed",
      finished_at: NOW - MIN,
    });
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual(["provapi fleet canary_not_done"]);
  });

  it("the rest wait while the canary is on the target but not healthy on it", async () => {
    const canary = await on(TARGET);
    await on("0.92.0");
    for (const answer of ["down", "0.92.0"] as const) {
      const f = fakes({ canary, answers: new Map([[canary, answer]]) });
      const lines = captureLogs(vi.spyOn);
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
      expect(lines).toEqual(["provapi fleet canary_unhealthy"]);
      vi.restoreAllMocks();
    }
  });

  it("canary healthy: the rest, oldest first, FLEET_CONCURRENCY at a time", async () => {
    const canary = await on(TARGET);
    const behind = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 2; i++)
      behind.push(await on("0.92.0", { created: 10 + i }));
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const first = await fleetJobs();
    expect(first.map((j) => j.install_id)).toEqual(
      behind.slice(0, FLEET_CONCURRENCY),
    );
    // Two finish and pass their probes: two more start.
    await finish(first[0]?.id, "done", NOW + MIN);
    await finish(first[1]?.id, "done", NOW + MIN);
    await setVersion(behind[0] as string, TARGET);
    await setVersion(behind[1] as string, TARGET);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    const open = (await fleetJobs()).filter((j) => j.status === "queued");
    expect(open.map((j) => j.install_id)).toEqual(behind.slice(2));
  });

  it("review 2: a start that fails after the insert still counts toward the cap", async () => {
    const canary = await on(TARGET);
    for (let i = 0; i < FLEET_CONCURRENCY + 2; i++)
      await on("0.92.0", { created: 10 + i });
    const broken = {
      create: async () => {
        throw new Error("binding down");
      },
      get: async () => {
        throw new Error("binding down");
      },
    };
    const f = fakes({ canary, manage: broken });
    await fleetDue(f.env, NOW, f.opts);
    const queued = (await fleetJobs()).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(FLEET_CONCURRENCY);
  });

  it("review 12: the cap is the insert's own guard: overlapping ticks never open more", async () => {
    const canary = await on(TARGET);
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 2 + i });
      await fleetJob(id, { status: "running", finished_at: null });
    }
    await on("0.92.0", { created: 50 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect((await fleetJobs()).filter((j) => j.status === "queued")).toEqual(
      [],
    );
  });

  it("an install that moves between the read and the insert is not upgraded (the insert's own guard)", async () => {
    const canary = await on(TARGET);
    const moved = await on("0.92.0");
    const f = fakes({ canary });
    // After the read of the installs behind, before the insert: an operator
    // suspends it.
    const racing = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") return Reflect.get(t, p);
        return (sql: string) => {
          const st = t.prepare(sql);
          if (!sql.includes("install_id <> ?2")) return st;
          return {
            bind: (...b: unknown[]) => ({
              all: async () => {
                const r = await st.bind(...b).all();
                await lifecycleSuspend(moved);
                return r;
              },
            }),
          };
        };
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: racing } as ProvapiEnv,
      NOW,
      f.opts,
    );
    expect(await fleetJobs()).toEqual([]);
  });

  it("leaves out red-line, suspended, paused (review 4), busy, above-target and on-target installs", async () => {
    const canary = await on(TARGET);
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    // prod_dirty: active, but paused over the quarantined script.
    await on("0.92.0", { serving: "paused" });
    await on("0.92.0", { serving: "closed" });
    const busy = await on("0.92.0");
    await job(busy, { kind: "suspend", workflow: "manage_install" });
    await on("0.94.0");
    await on(TARGET);
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
  });

  it("a red-line, suspended, paused or missing canary stops the rollout", async () => {
    for (const canary of [
      await on("0.92.0", { test_hooks: 1 }),
      await on("0.92.0", { suspended: true }),
      await on("0.92.0", { serving: "paused" }),
      installId(),
    ]) {
      await on("0.92.0");
      const lines = captureLogs(vi.spyOn);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
      expect(lines).toEqual(["provapi fleet canary_unavailable"]);
      vi.restoreAllMocks();
    }
  });

  it("a canary above the target is never downgraded and holds the rollout", async () => {
    const canary = await on("0.94.0");
    await on("0.92.0");
    const lines = captureLogs(vi.spyOn);
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual(["provapi fleet canary_off_target"]);
  });

  it("review 13: a target not in the catalog (or not installable) queues nothing, so it never halts", async () => {
    const canary = await on("0.92.0");
    for (const releases of [[], [release(TARGET, false)]]) {
      const f = fakes({ canary, releases });
      const lines = captureLogs(vi.spyOn);
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
      expect(lines).toEqual([`provapi fleet release_unpublished ${TARGET}`]);
      vi.restoreAllMocks();
    }
  });

  it("a failed fleet upgrade halts the rollout to that target; the next release starts again", async () => {
    const canary = await on("0.92.0");
    await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    // On the target by hand: still halted.
    await setVersion(canary, TARGET);
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(lines).toEqual([`provapi fleet halted ${TARGET}`]);
    expect(
      (await fleetConditions(f.env, NOW + 2 * MIN)).fleet_halted,
    ).toMatchObject({ open: true, rows: [{ install_id: canary }] });
    // 0.93.1: a new rollout, the canary first again.
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW + 4 * MIN, g.opts);
    const next = (await fleetJobs()).filter((x) => x.status === "queued");
    expect(next.map((x) => x.install_id)).toEqual([canary]);
    expect(
      (await fleetConditions(g.env, NOW + 4 * MIN)).fleet_halted.open,
    ).toBe(false);
  });
});

describe("auto-rollback", () => {
  /** A done fleet upgrade 0.92.0 -> `to` on a non-canary install. */
  async function upgraded(doneAt = NOW - MIN, to = TARGET) {
    const canary = await on(TARGET);
    const id = await on(to);
    await fleetJob(id, { to, finished_at: doneAt });
    return { canary, id };
  }
  const rollbacks = (id: string) =>
    rows("SELECT * FROM jobs WHERE install_id = ?1 AND kind = 'rollback'", id);
  const failing = (id: string) =>
    rows(
      "SELECT value FROM platform_state WHERE key = ?1",
      `${FLEET_FAILING_PREFIX}${id}`,
    );

  it("unhealthy on two ticks within the window: a rollback to the version it left, and the rollout halts", async () => {
    const { canary, id } = await upgraded();
    const behind = await on("0.92.0");
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(await failing(id)).toEqual([{ value: NOW }]);
    expect(lines).toContain("provapi fleet holding");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    const [rb, ...rest] = await rollbacks(id);
    expect(rest).toEqual([]);
    expect(rb).toMatchObject({
      actor_key: SYSTEM_ACTOR.key,
      request_id: fleetRollbackRequestId(id, TARGET),
      status: "queued",
    });
    expect(JSON.parse(String(rb?.args))).toEqual({
      from: TARGET,
      to: "0.92.0",
    });
    expect(await failing(id)).toEqual([]);
    expect((await fleetJobs()).filter((j) => j.install_id === behind)).toEqual(
      [],
    );
    expect(
      (await fleetConditions(f.env, NOW + 2 * MIN)).fleet_halted.open,
    ).toBe(true);
  });

  it("review 6: more than one failing in a tick is a shared cause: strikes kept, nothing rolled back", async () => {
    const { canary, id } = await upgraded();
    const other = await on(TARGET);
    await fleetJob(other, {});
    const answers: Answers = new Map([
      [id, "down"],
      [other, "down"],
    ]);
    const f = fakes({ canary, answers });
    const lines = captureLogs(vi.spyOn);
    for (let t = 0; t < 4; t++)
      await fleetDue(f.env, NOW + t * 2 * MIN, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(await rollbacks(other)).toEqual([]);
    expect(lines).toContain("provapi fleet shared_failure n=2");
    // The blip ends for one: the other, still failing, is rolled back.
    answers.delete(other);
    await fleetDue(f.env, NOW + 8 * MIN, f.opts);
    expect(await rollbacks(id)).toHaveLength(1);
    expect(await rollbacks(other)).toEqual([]);
  });

  it("review 7: a rollback the duty can't queue halts the target, with the alert, and the halt outlives the window", async () => {
    const { canary, id } = await upgraded();
    await on("0.92.0");
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    // An operator's job on it: the rollback insert's guard refuses.
    await job(id, { kind: "suspend", workflow: "manage_install" });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(lines).toContain(`provapi fleet rollback_not_queued ${id}`);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ install_id: id, code: "fleet_halt" }],
    });
    // Past the window the hold lapses, but the halt does not.
    await db
      .prepare("DELETE FROM jobs WHERE install_id = ?1 AND kind = 'suspend'")
      .bind(id)
      .run();
    await fleetDue(f.env, NOW + FLEET_ROLLBACK_WINDOW_MS + MIN, f.opts);
    expect((await fleetJobs()).filter((j) => j.status === "queued")).toEqual(
      [],
    );
  });

  it("review 8: a new release mid-window keeps watching the last one's upgrades", async () => {
    // Upgraded to 0.93.0; the platform is now on 0.93.1.
    const { canary, id } = await upgraded(NOW - MIN, TARGET);
    await setVersion(canary, "0.93.1");
    const f = fakes({
      canary,
      tag: "v0.93.1",
      answers: new Map([[id, "down"]]),
    });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    const [rb] = await rollbacks(id);
    expect(JSON.parse(String(rb?.args))).toEqual({
      from: TARGET,
      to: "0.92.0",
    });
  });

  it("a passing probe forgets the first failure", async () => {
    const { canary, id } = await upgraded();
    const answers: Answers = new Map([[id, "down"]]);
    const f = fakes({ canary, answers });
    await fleetDue(f.env, NOW, f.opts);
    answers.delete(id);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await failing(id)).toEqual([]);
    answers.set(id, "down");
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await rollbacks(id)).toEqual([]);
  });

  it("review 10: a failure from before the upgrade finished counts as a first", async () => {
    const { canary, id } = await upgraded(NOW - MIN);
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_FAILING_PREFIX}${id}`, NOW - 2 * MIN)
      .run();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(await failing(id)).toEqual([{ value: NOW }]);
  });

  it("review 11: a probe that could outrun the budget is not run: no strike, the rollout holds", async () => {
    const { canary, id } = await upgraded();
    await on("0.92.0");
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    let t = 0;
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, {
      ...f.opts,
      budgetMs: FLEET_BUDGET_MS,
      clock: () => {
        t += FLEET_BUDGET_MS;
        return t;
      },
    });
    expect(f.probed).toEqual([]);
    expect(await failing(id)).toEqual([]);
    expect(lines).toEqual(["provapi fleet holding"]);
  });

  it("past the window, no probe and no rollback", async () => {
    const { canary, id } = await upgraded(NOW - FLEET_ROLLBACK_WINDOW_MS - MIN);
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(f.probed).not.toContain(id);
  });
});

describe("the alerts", () => {
  const env = (deployedAt: number, o: { tag?: string; canary?: string } = {}) =>
    ({
      PLATFORM_DB: db,
      FLEET_CANARY: o.canary ?? "ifhx5rpmrhwh",
      CF_VERSION_METADATA: {
        id: "x",
        tag: o.tag ?? `v${TARGET}`,
        timestamp: new Date(deployedAt).toISOString(),
      },
    }) as unknown as ProvapiEnv;

  it("version_skew opens for an install off the target FLEET_SKEW_MS after the deploy; red-line, suspended and paused left out", async () => {
    const behind = await on("0.92.0");
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    await on("0.92.0", { serving: "paused" });
    await on(TARGET);
    const late = await fleetConditions(env(NOW - FLEET_SKEW_MS), NOW);
    expect(late.version_skew.open).toBe(true);
    expect(late.version_skew.rows.map((r) => r.install_id)).toEqual([behind]);
    await setVersion(behind, TARGET);
    expect(
      (await fleetConditions(env(NOW - FLEET_SKEW_MS), NOW)).version_skew,
    ).toEqual({ open: false, rows: [] });
  });

  it("review 9: inside the window after a deploy, version_skew is unknown, never an all-clear", async () => {
    await on("0.92.0");
    const early = await fleetConditions(env(NOW - FLEET_SKEW_MS + MIN), NOW);
    expect(early.version_skew).toEqual({ open: null, rows: [] });
  });

  it("review 3: no canary is a true no-op: both alerts clear, whatever lags", async () => {
    await on("0.92.0");
    for (const canary of ["", "canary"])
      expect(
        await fleetConditions(env(NOW - 2 * FLEET_SKEW_MS, { canary }), NOW),
      ).toEqual({
        fleet_halted: { open: false, rows: [] },
        version_skew: { open: false, rows: [] },
      });
  });

  it("review 13: a canary set but no target opens fleet_halted (no_target); version_skew is unknown", async () => {
    const c = await fleetConditions(env(NOW, { tag: "dev" }), NOW);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ code: "no_target" }],
    });
    expect(c.version_skew).toEqual({ open: null, rows: [] });
    const noTime = {
      PLATFORM_DB: db,
      FLEET_CANARY: "ifhx5rpmrhwh",
      CF_VERSION_METADATA: { id: "x", tag: `v${TARGET}`, timestamp: "" },
    } as unknown as ProvapiEnv;
    expect((await fleetConditions(noTime, NOW)).version_skew.open).toBeNull();
  });
});
