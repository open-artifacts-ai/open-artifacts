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
  FLEET_BLIP_MS,
  FLEET_BUDGET_MS,
  FLEET_CONCURRENCY,
  FLEET_FAILING_PREFIX,
  FLEET_HALT_ALERT_MS,
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

  it("re-review N4: at the cap, no insert is even tried", async () => {
    const canary = await on(TARGET);
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 2 + i });
      await fleetJob(id, { status: "running", finished_at: null });
    }
    for (let i = 0; i < 5; i++) await on("0.92.0", { created: 50 + i });
    const f = fakes({ canary });
    const inserts: string[] = [];
    const counting = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") return Reflect.get(t, p);
        return (sql: string) => {
          if (sql.startsWith("INSERT INTO jobs")) inserts.push(sql);
          return t.prepare(sql);
        };
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: counting } as ProvapiEnv,
      NOW,
      f.opts,
    );
    expect(inserts).toEqual([]);
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
    // The old version's halt stays on the alert for FLEET_HALT_ALERT_MS.
    expect(
      (await fleetConditions(g.env, NOW + 4 * MIN)).fleet_halted.open,
    ).toBe(true);
    expect(
      (await fleetConditions(g.env, NOW + 2 * MIN + FLEET_HALT_ALERT_MS))
        .fleet_halted.open,
    ).toBe(false);
  });
});

describe("the watch and auto-rollback", () => {
  /** A done fleet upgrade 0.92.0 -> `to`; the canary stays out of the watch (the control). */
  async function upgraded(doneAt = NOW - MIN, to = TARGET) {
    const canary = await on(TARGET, { created: 0 });
    const id = await on(to, { created: 5 });
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
  const marks = () =>
    rows("SELECT key FROM platform_state WHERE key GLOB 'fleet_halt:*'");
  /** Ticks every 2 minutes from `from` through `to`. */
  async function ticks(f: ReturnType<typeof fakes>, from: number, to: number) {
    for (let t = from; t <= to; t += 2 * MIN) await fleetDue(f.env, t, f.opts);
  }

  it("unhealthy past FLEET_BLIP_MS while the control answers: halted for good and rolled back to the version it left", async () => {
    const { id } = await upgraded();
    const behind = await on("0.92.0", { created: 9 });
    const f = fakes({
      canary: (
        await rows(
          "SELECT install_id FROM install_lifecycle ORDER BY created_at LIMIT 1",
        )
      )[0]?.install_id as string,
      answers: new Map([[id, "down"]]),
    });
    const lines = captureLogs(vi.spyOn);
    await ticks(f, NOW, NOW + FLEET_BLIP_MS - 2 * MIN);
    expect(await rollbacks(id)).toEqual([]);
    expect(await marks()).toEqual([]);
    expect(lines).toContain("provapi fleet holding");
    await fleetDue(f.env, NOW + FLEET_BLIP_MS, f.opts);
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
    expect(await marks()).toEqual([{ key: `fleet_halt:${TARGET}:${id}` }]);
    expect(await failing(id)).toEqual([]);
    expect((await fleetJobs()).filter((j) => j.install_id === behind)).toEqual(
      [],
    );
    expect(
      (await fleetConditions(f.env, NOW + FLEET_BLIP_MS)).fleet_halted,
    ).toMatchObject({
      open: true,
    });
  });

  it("re-review N1: several failing past the blip with the control answering: every one halted and rolled back, durably", async () => {
    const { canary, id } = await upgraded();
    const other = await on(TARGET, { created: 6 });
    await fleetJob(other, {});
    const f = fakes({
      canary,
      answers: new Map([
        [id, "down"],
        [other, "down"],
      ]),
    });
    // The canary is in the watch too here? No: it has no fleet job, so it is
    // the control, and it answers.
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toHaveLength(1);
    expect(await rollbacks(other)).toHaveLength(1);
    expect((await marks()).length).toBe(2);
    // Past the window nothing lapses: the halt stays.
    await ticks(
      f,
      NOW + FLEET_ROLLBACK_WINDOW_MS,
      NOW + FLEET_ROLLBACK_WINDOW_MS + 4 * MIN,
    );
    expect(
      (await fleetConditions(f.env, NOW + FLEET_ROLLBACK_WINDOW_MS + 4 * MIN))
        .fleet_halted.open,
    ).toBe(true);
  });

  it("re-review N1: a watched install passing this tick proves the platform path: no control needed", async () => {
    const { canary, id } = await upgraded();
    const fine = await on(TARGET, { created: 6 });
    await fleetJob(fine, {});
    // The control would fail, but it is never asked.
    const f = fakes({
      canary,
      answers: new Map([
        [id, "down"],
        [canary, "down"],
      ]),
    });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toHaveLength(1);
    expect(await rollbacks(fine)).toEqual([]);
  });

  it("re-review N1, N3: when the control fails too it is the platform's failure: no halt, and the clock restarts after it", async () => {
    const { canary, id } = await upgraded();
    const answers: Answers = new Map([
      [id, "down"],
      [canary, "down"],
    ]);
    const f = fakes({ canary, answers });
    const lines = captureLogs(vi.spyOn);
    await ticks(f, NOW, NOW + 2 * FLEET_BLIP_MS);
    expect(await rollbacks(id)).toEqual([]);
    expect(await marks()).toEqual([]);
    expect(lines).toContain("provapi fleet shared_failure n=1");
    // The platform recovers; the install is still down: timed from now.
    answers.delete(canary);
    const back = NOW + 2 * FLEET_BLIP_MS + 2 * MIN;
    await ticks(f, back, back + FLEET_BLIP_MS - 4 * MIN);
    expect(await rollbacks(id)).toEqual([]);
    await ticks(
      f,
      back + FLEET_BLIP_MS - 2 * MIN,
      back + FLEET_BLIP_MS + 2 * MIN,
    );
    expect(await rollbacks(id)).toHaveLength(1);
  });

  it("re-review N3: a blip under FLEET_BLIP_MS on a lone install only holds", async () => {
    const { canary, id } = await upgraded();
    const answers: Answers = new Map([[id, "down"]]);
    const f = fakes({ canary, answers });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS - 4 * MIN);
    answers.delete(id);
    await ticks(
      f,
      NOW + FLEET_BLIP_MS - 2 * MIN,
      NOW + FLEET_BLIP_MS + 4 * MIN,
    );
    expect(await rollbacks(id)).toEqual([]);
    expect(await marks()).toEqual([]);
    expect(await failing(id)).toEqual([]);
  });

  it("re-review N1: a failure that starts late in the window is still watched past it until it ends", async () => {
    const { canary, id } = await upgraded(
      NOW - FLEET_ROLLBACK_WINDOW_MS + 2 * MIN,
    );
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toHaveLength(1);
  });

  it("re-review N2: a watched install that is suspended or paused drops out: no probe, no halt; busy only holds", async () => {
    const { canary, id } = await upgraded();
    const paused = await on(TARGET, { created: 6, serving: "paused" });
    await fleetJob(paused, {});
    const busy = await on(TARGET, { created: 7 });
    await fleetJob(busy, {});
    await job(busy, { kind: "suspend", workflow: "manage_install" });
    await lifecycleSuspend(id);
    await on("0.92.0", { created: 9 });
    const f = fakes({
      canary,
      answers: new Map([
        [id, "down"],
        [paused, "down"],
      ]),
    });
    const lines = captureLogs(vi.spyOn);
    await ticks(f, NOW, NOW + 2 * FLEET_BLIP_MS);
    expect(f.probed.filter((p) => p !== canary)).toEqual([]);
    expect(await marks()).toEqual([]);
    expect(await rollbacks(id)).toEqual([]);
    expect(lines).toContain("provapi fleet holding");
  });

  it("an unhealthy fleet upgrade with no version to go back to: halted, no rollback", async () => {
    const canary = await on(TARGET, { created: 0 });
    const id = await on(TARGET, { created: 5 });
    await job(id, {
      kind: "upgrade",
      workflow: "manage_install",
      actor_kind: SYSTEM_ACTOR.kind,
      actor_key: SYSTEM_ACTOR.key,
      request_id: fleetRequestId(id, TARGET),
      args: JSON.stringify({ to: TARGET }),
      status: "done",
      finished_at: NOW - MIN,
    });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    const lines = captureLogs(vi.spyOn);
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toEqual([]);
    expect(lines).toContain(`provapi fleet rollback_no_prev ${id}`);
    expect(await marks()).toEqual([{ key: `fleet_halt:${TARGET}:${id}` }]);
  });

  it("re-review N6, review 8: the watch runs with no canary and across a new release", async () => {
    // Upgraded to 0.93.0; the platform is now on 0.93.1 and the canary var
    // was emptied.
    const { canary, id } = await upgraded(NOW - MIN, TARGET);
    await setVersion(canary, "0.93.1");
    const f = fakes({
      canary: "",
      tag: "v0.93.1",
      answers: new Map([
        [id, "down"],
        [canary, "0.93.1"],
      ]),
    });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    const [rb] = await rollbacks(id);
    expect(JSON.parse(String(rb?.args))).toEqual({
      from: TARGET,
      to: "0.92.0",
    });
  });

  it("a passing probe forgets the failure", async () => {
    const { canary, id } = await upgraded();
    const answers: Answers = new Map([[id, "down"]]);
    const f = fakes({ canary, answers });
    await fleetDue(f.env, NOW, f.opts);
    answers.delete(id);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await failing(id)).toEqual([]);
  });

  it("review 10: a failure stamped before the upgrade finished starts over", async () => {
    const { canary, id } = await upgraded(NOW - MIN);
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_FAILING_PREFIX}${id}`, NOW - FLEET_BLIP_MS - MIN)
      .run();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await rollbacks(id)).toEqual([]);
    expect(await failing(id)).toEqual([{ value: NOW }]);
  });

  it("review 11: a probe that could outrun the budget is not run: no strike, the rollout holds", async () => {
    const { canary, id } = await upgraded();
    await on("0.92.0", { created: 9 });
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

  it("past the window with no open failure, no probe", async () => {
    const { canary, id } = await upgraded(NOW - FLEET_ROLLBACK_WINDOW_MS - MIN);
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toEqual([]);
    expect(f.probed).not.toContain(id);
  });
});

describe("the alerts", () => {
  const H = 60 * MIN;
  const env = (
    deployedAt: number,
    o: {
      tag?: string;
      canary?: string;
      releases?: { version: string; publishedAt: number | null }[];
    } = {},
  ) =>
    ({
      PLATFORM_DB: db,
      FLEET_CANARY: o.canary ?? "ifhx5rpmrhwh",
      PROVISIONER: fakeProvisionerRpc({
        releases: (
          o.releases ?? [{ version: TARGET, publishedAt: deployedAt }]
        ).map((r) => ({
          ...release(r.version),
          publishedAt: r.publishedAt,
        })),
      }),
      CF_VERSION_METADATA: {
        id: "x",
        tag: o.tag ?? `v${TARGET}`,
        timestamp: new Date(deployedAt).toISOString(),
      },
    }) as unknown as ProvapiEnv;

  it("version_skew opens for an install behind FLEET_SKEW_MS; red-line, suspended and paused left out", async () => {
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
    ).toEqual({
      open: false,
      rows: [],
    });
  });

  it("re-review N8: behind since the first release past its version, so frequent releases don't hide a stuck install", async () => {
    const stuck = await on("0.91.0");
    // 0.92.0 published 9 h ago, the target 0.93.0 published and deployed 1 h ago.
    const c = await fleetConditions(
      env(NOW - H, {
        releases: [
          { version: "0.92.0", publishedAt: NOW - 9 * H },
          { version: TARGET, publishedAt: NOW - H },
        ],
      }),
      NOW,
    );
    expect(c.version_skew.rows.map((r) => r.install_id)).toEqual([stuck]);
    // One release behind, deployed 1 h ago: not yet.
    await setVersion(stuck, "0.92.0");
    expect(
      (
        await fleetConditions(
          env(NOW - H, {
            releases: [
              { version: "0.92.0", publishedAt: NOW - 9 * H },
              { version: TARGET, publishedAt: NOW - 2 * H },
            ],
          }),
          NOW,
        )
      ).version_skew.open,
    ).toBe(false);
  });

  it("review 9: version_skew never sends an early all-clear: unknown without a canary, a target, a deploy time or the catalog", async () => {
    await on("0.92.0");
    expect(
      (await fleetConditions(env(NOW, { canary: "" }), NOW)).version_skew.open,
    ).toBeNull();
    expect(
      (await fleetConditions(env(NOW, { tag: "dev" }), NOW)).version_skew.open,
    ).toBeNull();
    const noTime = {
      PLATFORM_DB: db,
      FLEET_CANARY: "ifhx5rpmrhwh",
      PROVISIONER: fakeProvisionerRpc(),
      CF_VERSION_METADATA: { id: "x", tag: `v${TARGET}`, timestamp: "" },
    } as unknown as ProvapiEnv;
    expect((await fleetConditions(noTime, NOW)).version_skew.open).toBeNull();
  });

  it("review 3: no canary and nothing ever halted: fleet_halted clear", async () => {
    await on("0.92.0");
    expect(
      (await fleetConditions(env(NOW - 2 * FLEET_SKEW_MS, { canary: "" }), NOW))
        .fleet_halted,
    ).toEqual({
      open: false,
      rows: [],
    });
  });

  it("review 13: a canary set but no target opens fleet_halted (no_target)", async () => {
    const c = await fleetConditions(env(NOW, { tag: "dev" }), NOW);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ code: "no_target" }],
    });
  });

  it("re-review N7: a halt on an earlier version stays on fleet_halted for FLEET_HALT_ALERT_MS", async () => {
    const id = await on("0.92.0");
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:0.92.5:${id}`, NOW - H)
      .run();
    expect((await fleetConditions(env(NOW), NOW)).fleet_halted).toMatchObject({
      open: true,
      rows: [{ install_id: id, code: "fleet_halt" }],
    });
    expect(
      (await fleetConditions(env(NOW), NOW + FLEET_HALT_ALERT_MS)).fleet_halted
        .open,
    ).toBe(false);
  });
});
