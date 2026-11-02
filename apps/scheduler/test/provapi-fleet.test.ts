import { canTransition, REQUEST_ID_RE } from "@oa/shared/provisioning";
import { FakeWorkflow } from "@oa/shared/provisioning/fakes";
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

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const MIN = 60_000;
const TARGET = "0.93.0";

/** Which installs answer /healthz on which version. */
type Answers = Map<string, string | "down">;

function fakes(o: { canary?: string; tag?: string; answers?: Answers } = {}) {
  const manage = new FakeWorkflow();
  const answers: Answers = o.answers ?? new Map();
  const probed: string[] = [];
  const probe: HealthProbe = async (id) => {
    probed.push(id);
    const v = answers.get(id) ?? TARGET;
    if (v === "down") return new Response("no", { status: 502 });
    return Response.json({ ok: true, plan: "free", version: v, installId: id });
  };
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    MANAGE_INSTALL: manage,
    FLEET_CANARY: o.canary ?? "",
    CF_VERSION_METADATA: {
      id: "x",
      tag: o.tag ?? `v${TARGET}`,
      timestamp: new Date(NOW - MIN).toISOString(),
    },
  } as unknown as ProvapiEnv;
  return { env, manage, answers, probed, opts: { probe, timeoutMs: 1_000 } };
}

/** An active, idle install on `version`, created at `created`. */
async function on(
  version: string,
  over: { test_hooks?: number; suspended?: boolean; created?: number } = {},
) {
  const id = installId();
  await install(id, {
    version,
    previous_version: "0.91.0",
    ...(over.test_hooks === undefined ? {} : { test_hooks: over.test_hooks }),
  });
  await lifecycle(id, {
    serving_mode: "serving",
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
  it("no target or no canary: nothing moves", async () => {
    const canary = await on("0.92.0");
    const lines = captureLogs(vi.spyOn);
    const a = fakes({ canary, tag: "v0.93.0-rc.1" });
    await fleetDue(a.env, NOW, a.opts);
    const b = fakes({ canary: "" });
    await fleetDue(b.env, NOW, b.opts);
    const c = fakes({ canary: "canary" });
    await fleetDue(c.env, NOW, c.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual([
      "provapi fleet no_target",
      "provapi fleet no_canary",
      "provapi fleet no_canary",
    ]);
  });

  it("the canary goes first: one system upgrade, started; no other install yet", async () => {
    const canary = await on("0.92.0", { created: 5 });
    const other = await on("0.92.0", { created: 1 });
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
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(other).not.toBe(canary);
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
    // Two finish: two more start, the cap counts open fleet jobs only.
    await finish(first[0]?.id, "done");
    await finish(first[1]?.id, "done");
    await setVersion(behind[0] as string, TARGET);
    await setVersion(behind[1] as string, TARGET);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    const open = (await fleetJobs()).filter((j) => j.status === "queued");
    expect(open.map((j) => j.install_id)).toEqual(behind.slice(2));
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

  it("leaves out red-line, suspended, busy, above-target and on-target installs", async () => {
    const canary = await on(TARGET);
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    const busy = await on("0.92.0");
    await job(busy, { kind: "suspend", workflow: "manage_install" });
    await on("0.94.0");
    await on(TARGET);
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
  });

  it("a red-line, suspended or missing canary stops the rollout", async () => {
    for (const canary of [
      await on("0.92.0", { test_hooks: 1 }),
      await on("0.92.0", { suspended: true }),
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

  it("a failed fleet upgrade halts the rollout to that target; the next release starts again", async () => {
    const canary = await on("0.92.0");
    const other = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    // Healthy and on the target by hand: still halted.
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
    expect(other).not.toBe(canary);
  });
});

describe("auto-rollback", () => {
  /** A done fleet upgrade 0.92.0 -> TARGET on a non-canary install. */
  async function upgraded(doneAt = NOW - MIN) {
    const canary = await on(TARGET);
    const id = await on(TARGET);
    await job(id, {
      kind: "upgrade",
      workflow: "manage_install",
      actor_kind: SYSTEM_ACTOR.kind,
      actor_key: SYSTEM_ACTOR.key,
      actor_label: SYSTEM_ACTOR.label,
      request_id: fleetRequestId(id, TARGET),
      args: JSON.stringify({ from: "0.92.0", to: TARGET }),
      status: "done",
      finished_at: doneAt,
    });
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
    await fleetDue(f.env, NOW, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(await failing(id)).toEqual([{ value: NOW }]);
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
    // Halted: the install behind is not upgraded.
    expect((await fleetJobs()).filter((j) => j.install_id === behind)).toEqual(
      [],
    );
    expect(
      (await fleetConditions(f.env, NOW + 2 * MIN)).fleet_halted.open,
    ).toBe(true);
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

  it("a failure from before the window counts as a first", async () => {
    const { canary, id } = await upgraded();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(
        `${FLEET_FAILING_PREFIX}${id}`,
        NOW - FLEET_ROLLBACK_WINDOW_MS - MIN,
      )
      .run();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(await failing(id)).toEqual([{ value: NOW }]);
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

describe("version_skew", () => {
  const meta = (deployedAt: number, tag = `v${TARGET}`) =>
    ({
      PLATFORM_DB: db,
      CF_VERSION_METADATA: {
        id: "x",
        tag,
        timestamp: new Date(deployedAt).toISOString(),
      },
    }) as unknown as ProvapiEnv;

  it("opens for an install off the target FLEET_SKEW_MS after the deploy, red-line and suspended installs left out", async () => {
    const behind = await on("0.92.0");
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    await on(TARGET);
    const early = await fleetConditions(meta(NOW - FLEET_SKEW_MS + MIN), NOW);
    expect(early.version_skew).toEqual({ open: false, rows: [] });
    const late = await fleetConditions(meta(NOW - FLEET_SKEW_MS), NOW);
    expect(late.version_skew.open).toBe(true);
    expect(late.version_skew.rows.map((r) => r.install_id)).toEqual([behind]);
    await setVersion(behind, TARGET);
    expect(
      (await fleetConditions(meta(NOW - FLEET_SKEW_MS), NOW)).version_skew,
    ).toEqual({ open: false, rows: [] });
  });

  it("no target or no deploy time: unknown", async () => {
    await on("0.92.0");
    const none = await fleetConditions(meta(NOW, "dev"), NOW);
    expect(none).toEqual({
      fleet_halted: { open: null, rows: [] },
      version_skew: { open: null, rows: [] },
    });
    const noTime = {
      PLATFORM_DB: db,
      CF_VERSION_METADATA: { id: "x", tag: `v${TARGET}`, timestamp: "" },
    } as unknown as ProvapiEnv;
    expect((await fleetConditions(noTime, NOW)).version_skew.open).toBeNull();
  });
});
