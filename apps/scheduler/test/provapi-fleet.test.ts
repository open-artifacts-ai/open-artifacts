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
  FLEET_BLOCKED_MS,
  FLEET_BLOCKED_PREFIX,
  FLEET_CONCURRENCY,
  FLEET_FAIL_PREFIX,
  FLEET_HALT_ALERT_MS,
  FLEET_KEEP_MS,
  FLEET_SKEW_MS,
  FLEET_SOAK_GAP_MS,
  FLEET_SOAK_MS,
  FLEET_SOAKED_PREFIX,
  fleetConditions,
  fleetDue,
  fleetRequestId,
  fleetTarget,
  onTarget,
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
// tag: the canary, then batches, each soaking first. Failures halt it and a
// person decides. "review N" names the #1083 review finding a test pins;
// "item N", the fourth review's.

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
    health: over.health ?? "ok",
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

/** The install has soaked on `v`, as the watch records it. */
const soaked = (id: string, v = TARGET) =>
  db
    .prepare(
      "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
    )
    .bind(`${FLEET_SOAKED_PREFIX}${v}:${id}`, NOW - MIN)
    .run();
const stateKeys = async (prefix: string) =>
  (
    await rows(
      "SELECT key FROM platform_state WHERE substr(key, 1, ?2) = ?1 ORDER BY key",
      prefix,
      prefix.length,
    )
  ).map((r) => r.key as string);
const queued = async () =>
  (await fleetJobs())
    .filter((j) => j.status === "queued")
    .map((j) => j.install_id);
/** Ticks every 2 minutes from `from` through `to`. */
async function ticks(f: ReturnType<typeof fakes>, from: number, to: number) {
  for (let t = from; t <= to; t += 2 * MIN) await fleetDue(f.env, t, f.opts);
}

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
    expect(fleetRequestId(id, "999.999.999")).toMatch(REQUEST_ID_RE);
    expect(() => fleetRequestId("nope", "0.93.0")).toThrow();
    expect(() => fleetRequestId(id, "0.93.0-rc.1")).toThrow();
  });

  it("the scheduler may upgrade an active install, never a suspended one, and never rolls back", () => {
    expect(canTransition("active", "upgrade", "S")).toBe(true);
    expect(canTransition("suspended", "upgrade", "S")).toBe(false);
    expect(canTransition("active", "rollback", "S")).toBe(false);
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
    await soaked(canary);
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

  it("review 2: a start that fails after the insert still counts toward the cap", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
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
      expect(lines).toEqual(["provapi fleet canary_blocked unavailable"]);
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
    expect(lines).toEqual(["provapi fleet canary_blocked off_target"]);
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
    expect(lines).toContain(`provapi fleet halted ${TARGET}`);
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

  it("the rest wait while the canary hasn't soaked on the target", async () => {
    const canary = await on(TARGET);
    await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
  });

  it("canary soaked: the rest, oldest first, one batch of FLEET_CONCURRENCY", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const behind = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 2; i++)
      behind.push(await on("0.92.0", { created: 10 + i }));
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect((await fleetJobs()).map((j) => j.install_id)).toEqual(
      behind.slice(0, FLEET_CONCURRENCY),
    );
  });
});

describe("soak", () => {
  /** A done fleet upgrade 0.92.0 -> TARGET, the canary soaked there. */
  async function upgraded(doneAt = NOW - MIN) {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, { finished_at: doneAt });
    return { canary, id };
  }

  it("the canary upgrade soaks FLEET_SOAK_MS of passes, then the rest start", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "done", NOW + MIN);
    await setVersion(canary, TARGET);
    await ticks(f, NOW + 2 * MIN, NOW + 2 * MIN + FLEET_SOAK_MS - 2 * MIN);
    expect(await queued()).toEqual([]);
    await fleetDue(f.env, NOW + 2 * MIN + FLEET_SOAK_MS, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("no soak: one passing probe never releases a batch", async () => {
    const canary = await on(TARGET, { created: 0 });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await queued()).toEqual([]);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toEqual([]);
  });

  it("a canary on the target with no fleet upgrade soaks all the same", async () => {
    const canary = await on(TARGET, { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
    expect(await queued()).toEqual([rest]);
  });

  it("a failed probe restarts the soak", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    f.answers.set(id, "down");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    f.answers.delete(id);
    await ticks(f, NOW + 4 * MIN, NOW + 4 * MIN + FLEET_SOAK_MS - 2 * MIN);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toEqual([
      `${FLEET_SOAKED_PREFIX}${TARGET}:${canary}`,
    ]);
    await fleetDue(f.env, NOW + 4 * MIN + FLEET_SOAK_MS, f.opts);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
  });

  it("a gap in the ticks doesn't count: over FLEET_SOAK_GAP_MS restarts the clock", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const back = NOW + FLEET_SOAK_GAP_MS + MIN;
    await ticks(f, back, back + FLEET_SOAK_MS - 2 * MIN);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).not.toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
    await fleetDue(f.env, back + FLEET_SOAK_MS, f.opts);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
  });

  it("a gap of exactly FLEET_SOAK_GAP_MS is unbroken", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary });
    for (let t = NOW; t <= NOW + FLEET_SOAK_MS; t += FLEET_SOAK_GAP_MS)
      await fleetDue(f.env, t, f.opts);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
  });

  it("a batch must finish and soak whole before the next starts", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const ids = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 1; i++)
      ids.push(await on("0.92.0", { created: 10 + i }));
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const jobs = await fleetJobs();
    // Two finish and soak; one is still running.
    await finish(jobs[0]?.id, "done", NOW + MIN);
    await finish(jobs[1]?.id, "done", NOW + MIN);
    await setVersion(ids[0] as string, TARGET);
    await setVersion(ids[1] as string, TARGET);
    await soaked(ids[0] as string);
    await soaked(ids[1] as string);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(FLEET_CONCURRENCY);
    // The last finishes, and holds until it soaks.
    await finish(jobs[2]?.id, "done", NOW + 3 * MIN);
    await setVersion(ids[2] as string, TARGET);
    await ticks(f, NOW + 4 * MIN, NOW + 4 * MIN + FLEET_SOAK_MS - 2 * MIN);
    expect(await fleetJobs()).toHaveLength(FLEET_CONCURRENCY);
    await fleetDue(f.env, NOW + 4 * MIN + FLEET_SOAK_MS, f.opts);
    expect(await queued()).toEqual([ids[3]]);
  });

  it("suspended, paused or busy installs drop out of the watch and hold nothing", async () => {
    const { canary, id } = await upgraded();
    const paused = await on(TARGET, { created: 6, serving: "paused" });
    await fleetJob(paused, {});
    const busy = await on(TARGET, { created: 7 });
    await fleetJob(busy, {});
    await job(busy, { kind: "suspend", workflow: "manage_install" });
    await lifecycleSuspend(id);
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).not.toContain(paused);
    expect(f.probed).not.toContain(busy);
    expect(f.probed).not.toContain(id);
    expect(await queued()).toEqual([rest]);
  });

  it("the watch runs with no canary set", async () => {
    const { id } = await upgraded();
    const f = fakes({ answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(`fleet_halt:${TARGET}:`)).toHaveLength(1);
  });

  it("item 7: every install in the batch is probed each tick, however late", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const ids = [];
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 5 + i });
      await fleetJob(id, {});
      ids.push(id);
    }
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect([...f.probed].sort()).toEqual([...ids].sort());
  });

  it("only the target is watched: an unsoaked install on an older version holds nothing", async () => {
    const { canary, id } = await upgraded();
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW, g.opts);
    expect(g.probed).not.toContain(id);
    expect(await queued()).toEqual([canary]);
  });
});

describe("halts", () => {
  async function upgraded(doneAt = NOW - MIN) {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, { finished_at: doneAt });
    return { canary, id };
  }
  const marks = () => stateKeys("fleet_halt:");

  it("two failed probes on separate ticks halt the version, and alert", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await marks()).toEqual([]);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ install_id: id, code: "fleet_halt" }],
    });
  });

  it("two failures in one tick are one: the same tick re-run doesn't halt", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW, f.opts);
    expect(await marks()).toEqual([]);
  });

  it("one failed probe holds the rollout, and no more", async () => {
    const { canary, id } = await upgraded();
    await on("0.92.0", { created: 9 });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await marks()).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("no automatic rollback: a halt queues no rollback job", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 4 * MIN);
    expect(await rows("SELECT id FROM jobs WHERE kind = 'rollback'")).toEqual(
      [],
    );
  });

  it("item 2: a pass doesn't reset a failure, so flapping halts", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    f.answers.delete(id);
    await ticks(f, NOW + 2 * MIN, NOW + 8 * MIN);
    f.answers.set(id, "down");
    await fleetDue(f.env, NOW + 10 * MIN, f.opts);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
  });

  it("item 2: leaving the watch doesn't forget a failure", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    const busy = await job(id, { kind: "suspend", workflow: "manage_install" });
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await marks()).toEqual([]);
    expect(await stateKeys(FLEET_FAIL_PREFIX)).toHaveLength(1);
    await finish(busy, "done", NOW + 3 * MIN);
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
  });

  it("a failed fleet upgrade halts its version, with a durable mark", async () => {
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
    expect(lines).toContain(`provapi fleet halted ${TARGET}`);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${canary}`]);
    // The job's row shows, once: not its mark as well.
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows).toHaveLength(1);
    expect(c.fleet_halted.rows[0]).toMatchObject({
      install_id: canary,
      job_id: j?.id,
      code: "upgrade_rolled_back",
    });
  });

  it("an operator's cancel isn't a failure of the release: no halt", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const id = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "canceled");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await marks()).toEqual([]);
    expect(
      (await fleetConditions(f.env, NOW + 2 * MIN)).fleet_halted.open,
    ).toBe(false);
    expect(id).toBeTruthy();
  });

  it("item 1: a halt cancels what's queued for that version; a running job finishes", async () => {
    const { canary, id } = await upgraded();
    const a = await on("0.92.0", { created: 10 });
    const b = await on("0.92.0", { created: 11 });
    const queuedJob = await fleetJob(a, {
      status: "queued",
      finished_at: null,
    });
    const running = await fleetJob(b, {
      status: "running",
      finished_at: null,
    });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    const byId = new Map((await fleetJobs()).map((j) => [j.id, j]));
    expect(byId.get(queuedJob)).toMatchObject({
      status: "failed",
      error_code: "canceled",
      finished_at: NOW + 2 * MIN,
    });
    expect(byId.get(running)).toMatchObject({ status: "running" });
    // The cancel itself isn't a second halt.
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
  });

  it("a halt cancels only its own version's queued jobs", async () => {
    const { canary, id } = await upgraded();
    const other = await on("0.92.0", { created: 10 });
    const j = await fleetJob(other, {
      status: "queued",
      finished_at: null,
      to: "0.94.0",
    });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect((await fleetJobs()).find((x) => x.id === j)).toMatchObject({
      status: "queued",
    });
  });

  it("the tick that halts queues nothing onto the version", async () => {
    const { canary, id } = await upgraded();
    await on("0.92.0", { created: 9 });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect(await queued()).toEqual([]);
  });

  describe("item 1: the insert's own guard, for a stale read", () => {
    const mark = (id: string) =>
      db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(`fleet_halt:${TARGET}:${id}`, NOW)
        .run();
    // Runs between the tick's reads and its insert.
    const between = (
      f: ReturnType<typeof fakes>,
      then: () => Promise<unknown>,
    ) => {
      f.env.PROVISIONER = {
        releases: async () => (await then(), [release(TARGET)]),
      } as unknown as ProvapiEnv["PROVISIONER"];
    };

    it("a halt written after the tick's read stops the insert", async () => {
      const canary = await on("0.92.0");
      const other = await on(TARGET, { created: 5 });
      const f = fakes({ canary });
      between(f, () => mark(other));
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
    });

    it("a fleet job failing mid-tick stops the insert, before any mark exists", async () => {
      const canary = await on("0.92.0");
      const other = await on(TARGET, { created: 5 });
      const j = await fleetJob(other, { status: "running", finished_at: null });
      const f = fakes({ canary });
      between(f, () => finish(j, "failed", NOW, "upgrade_rolled_back"));
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([]);
      expect(await fleetJobs()).toHaveLength(1);
    });

    it("an operator-canceled job doesn't stop the insert", async () => {
      const canary = await on("0.92.0");
      const other = await on(TARGET, { created: 5 });
      const j = await fleetJob(other, { status: "running", finished_at: null });
      const f = fakes({ canary });
      between(f, () => finish(j, "failed", NOW, "canceled"));
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([canary]);
    });

    it("a halt landing mid-batch stops the rest of the batch", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const ids = [];
      for (let i = 0; i < FLEET_CONCURRENCY; i++)
        ids.push(await on("0.92.0", { created: 10 + i }));
      const manage = {
        create: async () => {
          await mark(canary).catch(() => {});
          return {};
        },
      };
      const f = fakes({ canary, manage });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([ids[0]]);
    });

    it("a halt on another version doesn't stop it", async () => {
      const canary = await on("0.92.0");
      const f = fakes({ canary });
      between(f, () =>
        db
          .prepare(
            "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
          )
          .bind(`fleet_halt:0.93.0-x:${canary}`, NOW)
          .run(),
      );
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([canary]);
    });
  });

  it("a halt never blocks the next release, even while the install still fails", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect(await marks()).toHaveLength(1);
    const g = fakes({
      canary,
      tag: "v0.93.1",
      answers: new Map([[id, "down"]]),
    });
    await fleetDue(g.env, NOW + 4 * MIN, g.opts);
    expect(await queued()).toEqual([canary]);
  });

  it("a halted version is never watched again: no more probes, no hold", async () => {
    const { canary, id } = await upgraded();
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    f.probed.length = 0;
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(f.probed).toEqual([]);
    expect(await queued()).not.toContain(rest);
  });

  describe("item 3: pruning", () => {
    const seed = (key: string, at: number) =>
      db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(key, at)
        .run();
    const OLD = NOW - FLEET_KEEP_MS - MIN;

    it("with no target, nothing is pruned, so a rollout can't resume onto a halted version", async () => {
      const canary = await on("0.92.0");
      await seed(`fleet_halt:${TARGET}:${canary}`, OLD);
      const none = fakes({ canary, tag: "broken" });
      await fleetDue(none.env, NOW, none.opts);
      expect(await marks()).toHaveLength(1);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      expect(await fleetJobs()).toEqual([]);
    });

    it("the target's own marks are never pruned", async () => {
      const canary = await on("0.92.0");
      await seed(`fleet_halt:${TARGET}:${canary}`, OLD);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await marks()).toHaveLength(1);
    });

    it("a version above the target keeps its marks: a redeploy back can't resume it", async () => {
      const canary = await on("0.92.0");
      await seed(`fleet_halt:0.94.0:${canary}`, OLD);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await marks()).toHaveLength(1);
    });

    it("marks of older versions go after FLEET_KEEP_MS, not before", async () => {
      const id = installId();
      for (const p of ["halt", "fail", "pass", "soaked"])
        await seed(`fleet_${p}:0.91.0:${id}`, OLD);
      await seed("fleet_blocked:0.91.0", OLD);
      await seed(`fleet_halt:0.92.0:${id}`, NOW - FLEET_KEEP_MS + MIN);
      const f = fakes({});
      await fleetDue(f.env, NOW, f.opts);
      expect(await stateKeys("fleet_")).toEqual([`fleet_halt:0.92.0:${id}`]);
    });

    it("an unparsable key is left alone", async () => {
      await seed("fleet_halt:nonsense", OLD);
      const f = fakes({});
      await fleetDue(f.env, NOW, f.opts);
      expect(await marks()).toEqual(["fleet_halt:nonsense"]);
    });
  });
});

describe("item 5: health-gated eligibility", () => {
  it("a broken install is skipped: it doesn't move, halt, or hold the rest", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const broken = await on("0.92.0", { created: 5, health: "failing" });
    const fine = await on("0.92.0", { created: 6 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([fine]);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
    // version_skew reports it.
    expect(await stateKeys(FLEET_BEHIND_PREFIX)).toContain(
      `${FLEET_BEHIND_PREFIX}${broken}`,
    );
  });

  it("the insert re-reads health: one going bad after the read isn't upgraded", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    f.env.PROVISIONER = {
      releases: async () => {
        await db
          .prepare(
            "UPDATE install_lifecycle SET health = 'failing' WHERE install_id = ?1",
          )
          .bind(canary)
          .run();
        return [release(TARGET)];
      },
    } as unknown as ProvapiEnv["PROVISIONER"];
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
  });
});

describe("item 6: a canary that can't take the release", () => {
  const blocked = `${FLEET_BLOCKED_PREFIX}${TARGET}`;
  const code = async (f: ReturnType<typeof fakes>, at: number) =>
    (await fleetConditions(f.env, at)).fleet_halted.rows.map((r) => r.code);

  it("paused (prod_dirty): the alert opens after FLEET_BLOCKED_MS, not with the 6 h skew", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys(blocked)).toEqual([blocked]);
    expect(await code(f, NOW + FLEET_BLOCKED_MS - MIN)).toEqual([]);
    expect(await code(f, NOW + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  });

  it("the first sighting stays: a later tick doesn't restart the clock", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 20 * MIN, f.opts);
    expect(await code(f, NOW + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  });

  it("every cause counts: unhealthy, suspended, red-line, above the target, missing", async () => {
    const cases = [
      await on("0.92.0", { health: "failing" }),
      await on("0.92.0", { suspended: true }),
      await on("0.92.0", { test_hooks: 1 }),
      await on("0.94.0"),
      installId(),
    ];
    for (const canary of cases) {
      await db.prepare("DELETE FROM platform_state").run();
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await stateKeys(blocked), canary).toEqual([blocked]);
    }
  });

  it("another job on the canary counts; its own upgrade doesn't", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await db
      .prepare("UPDATE jobs SET status = 'running' WHERE id = ?1")
      .bind(j?.id)
      .run();
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(blocked)).toEqual([]);
    await finish(j?.id, "failed", NOW + 3 * MIN, "canceled");
    await job(canary, { kind: "suspend", workflow: "manage_install" });
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await stateKeys(blocked)).toEqual([blocked]);
  });

  it("clears once the canary can move, and the rollout carries on", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    await db
      .prepare(
        "UPDATE install_lifecycle SET serving_mode = 'serving' WHERE install_id = ?1",
      )
      .bind(canary)
      .run();
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(blocked)).toEqual([]);
    expect(await queued()).toEqual([canary]);
    expect(await code(f, NOW + FLEET_BLOCKED_MS)).toEqual([]);
  });

  it("no alert with no canary set", async () => {
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(blocked, NOW)
      .run();
    const f = fakes({});
    expect(await code(f, NOW + FLEET_BLOCKED_MS)).toEqual([]);
  });
});

describe("onTarget", () => {
  const id = "i00000000abc";
  const good = { ok: true, version: TARGET, installId: id };
  const go = (r: () => Response | Promise<Response>, ms = 1_000) =>
    onTarget(async () => r(), id, "x.test", TARGET, ms);

  it("passes only on 200, ok, its own id and the version, no test hooks", async () => {
    expect(await go(() => Response.json(good))).toBe(true);
  });

  it("fails on anything else", async () => {
    const bad: Record<string, unknown>[] = [
      { ...good, ok: false },
      { ...good, ok: "true" },
      { ...good, installId: "i00000000xyz" },
      { ...good, version: "0.92.0" },
      { ...good, testHooks: false },
    ];
    for (const b of bad)
      expect(await go(() => Response.json(b)), JSON.stringify(b)).toBe(false);
    expect(await go(() => Response.json(good, { status: 503 }))).toBe(false);
    expect(await go(() => new Response("not json"))).toBe(false);
    expect(await go(() => new Response("null"))).toBe(false);
  });

  it("a throw or a hang fails, never throws", async () => {
    expect(
      await go(() => {
        throw new Error("x");
      }),
    ).toBe(false);
    expect(await go(() => new Promise<Response>(() => {}), 5)).toBe(false);
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

  it("version_skew: an install first seen off FLEET_SKEW_MS ago; red-line, suspended and paused are out", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const behind = await on("0.92.0");
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(
      (await fleetConditions(f.env, NOW + FLEET_SKEW_MS - MIN)).version_skew
        .open,
    ).toBe(false);
    const late = await fleetConditions(f.env, NOW + FLEET_SKEW_MS);
    expect(late.version_skew.rows.map((r) => r.install_id)).toEqual([behind]);
    await setVersion(behind, TARGET);
    await fleetDue(f.env, NOW + FLEET_SKEW_MS, f.opts);
    expect(
      (await fleetConditions(f.env, NOW + FLEET_SKEW_MS)).version_skew.open,
    ).toBe(false);
  });

  it("frequent releases don't restart a stuck install's clock", async () => {
    const canary = await on("0.92.0", { suspended: false, health: "failing" });
    const stuck = await on("0.92.0", { health: "failing" });
    const a = fakes({ canary });
    await fleetDue(a.env, NOW, a.opts);
    const b = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(b.env, NOW + 3 * H, b.opts);
    const c = await fleetConditions(b.env, NOW + FLEET_SKEW_MS);
    expect(c.version_skew.rows.map((r) => r.install_id)).toContain(stuck);
  });

  it("version_skew is unknown with no canary or no target, never an all-clear", async () => {
    for (const e of [env({ canary: "" }), env({ tag: "x" })])
      expect((await fleetConditions(e, NOW)).version_skew).toEqual({
        open: null,
        rows: [],
      });
  });

  it("no canary and nothing halted: fleet_halted clear", async () => {
    expect(
      (await fleetConditions(env({ canary: "" }), NOW)).fleet_halted,
    ).toEqual({ open: false, rows: [] });
  });

  it("a canary set but no target opens fleet_halted (no_target)", async () => {
    const c = await fleetConditions(env({ tag: "x" }), NOW);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ code: "no_target" }],
    });
  });

  it("a halt on an earlier version stays on fleet_halted for FLEET_HALT_ALERT_MS", async () => {
    const id = installId();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:0.92.0:${id}`, NOW)
      .run();
    expect(
      (await fleetConditions(env(), NOW + FLEET_HALT_ALERT_MS)).fleet_halted
        .open,
    ).toBe(true);
    expect(
      (await fleetConditions(env(), NOW + FLEET_HALT_ALERT_MS + 1)).fleet_halted
        .open,
    ).toBe(false);
  });

  it("a halt on the target stays until the next release", async () => {
    const id = installId();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:${TARGET}:${id}`, NOW)
      .run();
    expect(
      (await fleetConditions(env(), NOW + 100 * H)).fleet_halted.open,
    ).toBe(true);
  });
});
