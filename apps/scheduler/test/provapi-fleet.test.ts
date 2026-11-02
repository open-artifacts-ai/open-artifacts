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
  FLEET_BEHIND_PREFIX,
  FLEET_BLIP_MS,
  FLEET_CONCURRENCY,
  FLEET_FAILING_PREFIX,
  FLEET_HALT_ALERT_MS,
  FLEET_HALT_KEEP_MS,
  FLEET_HOLD_ALERT_MS,
  FLEET_PROBES_PER_TICK,
  FLEET_ROLLBACK_WINDOW_MS,
  FLEET_SKEW_MS,
  fleetConditions,
  fleetDue,
  fleetRequestId,
  fleetRollbackRequestId,
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
  // An install answers on its own version unless `answers` says otherwise.
  const probe: HealthProbe = async (id) => {
    probed.push(id);
    const own = await db
      .prepare("SELECT version FROM installs WHERE id = ?1")
      .bind(id)
      .first<{ version: string | null }>();
    const v = answers.get(id) ?? own?.version ?? TARGET;
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
    health?: string;
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
    ...(over.health ? { health: over.health } : {}),
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

  it("review 12: a stale cap read can't open more: the insert's guard holds the cap", async () => {
    const canary = await on(TARGET);
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 2 + i });
      await fleetJob(id, { status: "running", finished_at: null });
    }
    await on("0.92.0", { created: 50 });
    const f = fakes({ canary });
    // An overlapping tick read the count before the 3 opened.
    const stale = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") return Reflect.get(t, p);
        return (sql: string) =>
          sql.startsWith("SELECT COUNT(*) AS n FROM jobs j")
            ? { first: async () => ({ n: 0 }) }
            : t.prepare(sql);
      },
    });
    await fleetDue({ ...f.env, PLATFORM_DB: stale } as ProvapiEnv, NOW, f.opts);
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

describe("the watch", () => {
  /**
   * A done fleet upgrade 0.92.0 -> `to`, the canary on the target, and a
   * control: health ok, on 0.92.0, below the upgraded version.
   */
  async function upgraded(
    doneAt = NOW - MIN,
    to = TARGET,
    o: { control?: boolean } = {},
  ) {
    const canary = await on(TARGET, { created: 0 });
    const control =
      o.control === false
        ? null
        : await on("0.92.0", { created: 1, health: "ok" });
    const id = await on(to, { created: 5 });
    await fleetJob(id, { to, finished_at: doneAt });
    return { canary, control, id };
  }
  const rollbacks = (id: string) =>
    rows("SELECT * FROM jobs WHERE install_id = ?1 AND kind = 'rollback'", id);
  const strike = (id: string) =>
    rows(
      "SELECT value FROM platform_state WHERE key = ?1",
      `${FLEET_FAILING_PREFIX}${id}`,
    );
  const marks = () =>
    rows(
      "SELECT key FROM platform_state WHERE key GLOB 'fleet_halt:*' ORDER BY key",
    );
  /** Ticks every 2 minutes from `from` through `to`. */
  async function ticks(f: ReturnType<typeof fakes>, from: number, to: number) {
    for (let t = from; t <= to; t += 2 * MIN) await fleetDue(f.env, t, f.opts);
  }

  it("a failure lasting FLEET_BLIP_MS with a healthy older control: halted for good and rolled back", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
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
    expect(await strike(id)).toEqual([]);
    expect(
      (await fleetConditions(f.env, NOW + FLEET_BLIP_MS)).fleet_halted.open,
    ).toBe(true);
  });

  it("third review: the control failing too halts anyway (no reset, no 'shared'), with no rollback", async () => {
    const { canary, control, id } = await upgraded();
    const f = fakes({
      canary,
      answers: new Map([
        [id, "down"],
        [control as string, "down"],
      ]),
    });
    const lines = captureLogs(vi.spyOn);
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toEqual([]);
    expect(await marks()).toEqual([{ key: `fleet_halt:${TARGET}:${id}` }]);
    expect(lines).toContain(`provapi fleet no_rollback ${id} no_control`);
  });

  it("third review: no control, or a control on the failing version, only halts (canary plus leo on an outage)", async () => {
    // leo-like: the only other install is on the failing version itself.
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, {});
    const leo = await on(TARGET, { created: 1, health: "ok" });
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, {});
    const f = fakes({
      canary,
      answers: new Map([
        [id, "down"],
        [canary, "down"],
      ]),
    });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toEqual([]);
    expect(await rollbacks(canary)).toEqual([]);
    expect(await rollbacks(leo)).toEqual([]);
    expect((await marks()).length).toBe(2);
  });

  it("third review: a control with health not ok is no control", async () => {
    const canary = await on(TARGET, { created: 0 });
    await on("0.92.0", { created: 1, health: "failing" });
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, {});
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toEqual([]);
    expect((await marks()).length).toBe(1);
  });

  it("third review: past the 30-min deadline it halts but never rolls back (D1 is forward-only)", async () => {
    // Fails from 25 min after the upgrade: halted at 35, past the window.
    const { canary, id } = await upgraded(NOW - 25 * MIN);
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    const lines = captureLogs(vi.spyOn);
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await rollbacks(id)).toEqual([]);
    expect(await marks()).toEqual([{ key: `fleet_halt:${TARGET}:${id}` }]);
    expect(lines).toContain(`provapi fleet no_rollback ${id} past_window`);
  });

  it("third review: at most FLEET_CONCURRENCY rollbacks a tick; every lasting failure is halted", async () => {
    const canary = await on(TARGET, { created: 0 });
    await on("0.92.0", { created: 1, health: "ok" });
    const bad = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 2; i++) {
      const id = await on(TARGET, { created: 5 + i });
      await fleetJob(id, {});
      bad.push(id);
    }
    const f = fakes({
      canary,
      answers: new Map(bad.map((b) => [b, "down"] as const)),
    });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    const rbs = await rows(
      "SELECT install_id FROM jobs WHERE kind = 'rollback'",
    );
    expect(rbs).toHaveLength(FLEET_CONCURRENCY);
    expect((await marks()).length).toBe(bad.length);
  });

  it("third review: a halt ends the install's hold, so a fix release starts while it still fails", async () => {
    const { canary, id } = await upgraded(NOW - 25 * MIN);
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect((await marks()).length).toBe(1);
    // 0.93.1: the canary goes first, though the halted install still fails.
    const g = fakes({
      canary,
      tag: "v0.93.1",
      answers: new Map([[id, "down"]]),
    });
    await fleetDue(g.env, NOW + FLEET_BLIP_MS + 2 * MIN, g.opts);
    const queued = (await fleetJobs()).filter((j) => j.status === "queued");
    expect(queued.map((j) => j.install_id)).toEqual([canary]);
  });

  it("re-review N2, third review 4: suspended, paused or busy installs drop out of the watch, and never hold", async () => {
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
        [busy, "down"],
      ]),
    });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).not.toContain(id);
    expect(f.probed).not.toContain(paused);
    expect(f.probed).not.toContain(busy);
    expect(lines).not.toContain("provapi fleet holding");
    expect(await marks()).toEqual([]);
  });

  it("a blip under FLEET_BLIP_MS only holds, and a pass clears it", async () => {
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
    expect(await strike(id)).toEqual([]);
  });

  it("a failure that starts late in the window is still watched past it until a verdict", async () => {
    const { canary, id } = await upgraded(
      NOW - FLEET_ROLLBACK_WINDOW_MS + 2 * MIN,
    );
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    expect(await marks()).toEqual([{ key: `fleet_halt:${TARGET}:${id}` }]);
  });

  it("re-review N6, review 8: the watch runs with no canary and across a new release", async () => {
    const { canary, id } = await upgraded(NOW - MIN, TARGET);
    await setVersion(canary, "0.93.1");
    const f = fakes({
      canary: "",
      tag: "v0.93.1",
      answers: new Map([[id, "down"]]),
    });
    await ticks(f, NOW, NOW + FLEET_BLIP_MS);
    const [rb] = await rollbacks(id);
    expect(JSON.parse(String(rb?.args))).toEqual({
      from: TARGET,
      to: "0.92.0",
    });
  });

  it("an unhealthy upgrade with no version to go back to: halted, no rollback", async () => {
    const canary = await on(TARGET, { created: 0 });
    await on("0.92.0", { created: 1, health: "ok" });
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
    expect(lines).toContain(`provapi fleet no_rollback ${id} no_prev`);
    expect(await marks()).toEqual([{ key: `fleet_halt:${TARGET}:${id}` }]);
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
    expect(await marks()).toEqual([]);
    expect(await strike(id)).toEqual([{ value: NOW }]);
  });

  it("a strike of an install that left the watch is cleared", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await strike(id)).toHaveLength(1);
    await lifecycleSuspend(id);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await strike(id)).toEqual([]);
  });

  it("at most FLEET_PROBES_PER_TICK watched installs are probed a tick; the rest hold", async () => {
    const canary = await on(TARGET, { created: 0 });
    for (let i = 0; i < FLEET_PROBES_PER_TICK + 1; i++) {
      const id = await on(TARGET, { created: 5 + i });
      await fleetJob(id, {});
    }
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed.length).toBeLessThanOrEqual(FLEET_PROBES_PER_TICK + 1);
    expect(lines).toContain("provapi fleet holding");
  });

  it("third review 1, real timing: a hanging install can't starve the control; every probe ends within its timeout", async () => {
    const { canary, id } = await upgraded();
    const control = (
      await rows(
        "SELECT install_id FROM install_lifecycle WHERE health = 'ok' LIMIT 1",
      )
    )[0]?.install_id as string;
    const seen: string[] = [];
    // The watched install never answers; the control answers in 20 ms.
    const probe: HealthProbe = (pid) => {
      seen.push(pid);
      if (pid === id) return new Promise<Response>(() => {});
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              Response.json({
                ok: true,
                version: pid === control ? "0.92.0" : TARGET,
                installId: pid,
              }),
            ),
          20,
        ),
      );
    };
    const f = fakes({ canary });
    const opts = { probe, timeoutMs: 100 };
    // First failure, then FLEET_BLIP_MS later the verdict, both for real.
    const t0 = Date.now();
    await fleetDue(f.env, NOW, opts);
    await fleetDue(f.env, NOW + FLEET_BLIP_MS, opts);
    const took = Date.now() - t0;
    expect(seen).toContain(control);
    expect(await rollbacks(id)).toHaveLength(1);
    // Two ticks, each one round of parallel probes bounded by 100 ms.
    expect(took).toBeLessThan(1_000);
  });
});

describe("the alerts", () => {
  const H = 60 * MIN;
  const env = (o: { tag?: string; canary?: string } = {}) =>
    ({
      PLATFORM_DB: db,
      FLEET_CANARY: o.canary ?? "ifhx5rpmrhwh",
      CF_VERSION_METADATA: {
        id: "x",
        tag: o.tag ?? `v${TARGET}`,
        timestamp: new Date(NOW).toISOString(),
      },
    }) as unknown as ProvapiEnv;

  it("version_skew: an install first seen behind FLEET_SKEW_MS ago, counted by the duty; red-line, suspended and paused left out", async () => {
    const canary = await on(TARGET, { created: 0 });
    const behind = await on("0.92.0");
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    await on("0.92.0", { serving: "paused" });
    // Halted by a failed canary upgrade, so nothing moves: only the clock.
    await fleetJob(canary, { status: "failed", from: "0.92.0" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const e = env({ canary });
    expect(
      (await fleetConditions(e, NOW + FLEET_SKEW_MS - MIN)).version_skew,
    ).toEqual({
      open: false,
      rows: [],
    });
    const late = await fleetConditions(e, NOW + FLEET_SKEW_MS);
    expect(late.version_skew.rows.map((r) => r.install_id)).toEqual([behind]);
    // Caught up: the duty clears its mark.
    await setVersion(behind, TARGET);
    await fleetDue(f.env, NOW + FLEET_SKEW_MS, f.opts);
    expect(
      (await fleetConditions(e, NOW + FLEET_SKEW_MS)).version_skew.open,
    ).toBe(false);
  });

  it("re-review N8: frequent releases don't restart a stuck install's clock", async () => {
    const canary = await on(TARGET, { created: 0 });
    const stuck = await on("0.91.0");
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_BEHIND_PREFIX}${stuck}`, NOW - 9 * H)
      .run();
    // A new release deployed an hour ago: the mark stays.
    const f = fakes({ canary, tag: "v0.93.1", releases: [] });
    await fleetDue(f.env, NOW, f.opts);
    expect(
      (
        await fleetConditions(env({ canary, tag: "v0.93.1" }), NOW)
      ).version_skew.rows.map((r) => r.install_id),
    ).toEqual([stuck]);
  });

  it("review 9: version_skew is unknown with no canary or no target, never an all-clear", async () => {
    await on("0.92.0");
    expect(
      (await fleetConditions(env({ canary: "" }), NOW)).version_skew.open,
    ).toBeNull();
    expect(
      (await fleetConditions(env({ tag: "dev" }), NOW)).version_skew.open,
    ).toBeNull();
  });

  it("review 3: no canary and nothing ever halted: fleet_halted clear", async () => {
    expect(
      (await fleetConditions(env({ canary: "" }), NOW)).fleet_halted,
    ).toEqual({
      open: false,
      rows: [],
    });
  });

  it("review 13: a canary set but no target opens fleet_halted (no_target)", async () => {
    const c = await fleetConditions(env({ tag: "dev" }), NOW);
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
    expect((await fleetConditions(env(), NOW)).fleet_halted).toMatchObject({
      open: true,
      rows: [{ install_id: id, code: "fleet_halt" }],
    });
    expect(
      (await fleetConditions(env(), NOW + FLEET_HALT_ALERT_MS)).fleet_halted
        .open,
    ).toBe(false);
  });

  it("third review 4: a failure held without a verdict past FLEET_HOLD_ALERT_MS opens fleet_halted (holding)", async () => {
    const id = await on(TARGET);
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_FAILING_PREFIX}${id}`, NOW - FLEET_HOLD_ALERT_MS)
      .run();
    expect((await fleetConditions(env(), NOW)).fleet_halted).toMatchObject({
      open: true,
      rows: [{ install_id: id, code: "holding" }],
    });
  });

  it("third review 8: old strikes and other versions' old halt marks are pruned", async () => {
    const id = await on(TARGET);
    const put = (k: string, v: number) =>
      db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(k, v)
        .run();
    await put(`${FLEET_FAILING_PREFIX}${id}`, NOW - 25 * H);
    await put(`fleet_halt:0.90.0:${id}`, NOW - FLEET_HALT_KEEP_MS - MIN);
    await put(`fleet_halt:${TARGET}:${id}`, NOW - FLEET_HALT_KEEP_MS - MIN);
    await fleetDue(fakes({ canary: "" }).env, NOW, {});
    const left = await rows(
      "SELECT key FROM platform_state WHERE key GLOB 'fleet_*' ORDER BY key",
    );
    expect(left).toEqual([{ key: `fleet_halt:${TARGET}:${id}` }]);
  });
});
