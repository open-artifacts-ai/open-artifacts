import { canTransition, REQUEST_ID_RE } from "@oa/provisioning-contract";
import {
  FakeWorkflow,
  fakeProvisionerRpc,
} from "@oa/provisioning-contract/fakes";
import { SYSTEM_ACTOR } from "@oa/provisioning-contract/system";
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
  FLEET_RETRY_PREFIX,
  FLEET_SKEW_MS,
  FLEET_SOAK_GAP_MS,
  FLEET_SOAK_MIN_MAX,
  FLEET_SOAK_MS,
  FLEET_SOAKED_PREFIX,
  fleetBlockedMs,
  fleetConditions,
  fleetDue,
  fleetRequestId,
  fleetSecond,
  fleetSoakMs,
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
    second?: string;
    soakMin?: string;
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
    ...(o.second === undefined ? {} : { FLEET_SECOND: o.second }),
    ...(o.soakMin === undefined ? {} : { FLEET_SOAK_MIN: o.soakMin }),
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
    await soaked(canary);
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
    await soaked(canary);
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
    await soaked(canary);
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
    await soaked(canary);
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
    await soaked(canary);
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    // prod_dirty: active, but paused over the quarantined script.
    await on("0.92.0", { serving: "paused" });
    await on("0.92.0", { serving: "closed" });
    const busy = await on("0.92.0");
    await job(busy, { kind: "suspend", workflow: "manage_install" });
    await on("0.94.0");
    await on(TARGET);
    // The control: it does move, so the rest are out for their own reasons.
    const fine = await on("0.92.0", { created: 90 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([fine]);
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
    // Past that, only the new release's own canary clock remains.
    const late = await fleetConditions(
      g.env,
      NOW + 2 * MIN + FLEET_HALT_ALERT_MS,
    );
    expect(late.fleet_halted.rows.map((r) => r.code)).toEqual([
      "canary_blocked",
    ]);
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

  it("a soaked install is left alone: no more probes, and it holds nothing back", async () => {
    const { canary, id } = await upgraded();
    await soaked(id);
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).not.toContain(id);
    expect(await queued()).toEqual([rest]);
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

  it("a held migration halts the rollout at the canary, and no fleet job can cross it (MIG-2)", async () => {
    const canary = await on("0.92.0");
    const member = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    // Exactly these: nothing here could ask to cross a held migration.
    expect(Object.keys(JSON.parse(String(j?.args))).sort()).toEqual([
      "from",
      "to",
    ]);
    await finish(j?.id, "failed", NOW + MIN, "migration_held");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${canary}`]);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows[0]).toMatchObject({
      install_id: canary,
      code: "migration_held",
    });
    expect(member).not.toBe(canary);
  });

  describe("a held member (MIG-2)", () => {
    /** A soaked canary, member `held` failed migration_held, then a tick. */
    const heldMember = async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const held = await on("0.92.0", { created: 5 });
      const next = await on("0.92.0", { created: 6 });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const jobs = await fleetJobs();
      const j = jobs.find((x) => x.install_id === held);
      expect(j).toBeDefined();
      await finish(j?.id, "failed", NOW + MIN, "migration_held");
      for (const x of jobs)
        if (x.install_id !== held) await finish(x.id, "done", NOW + MIN);
      return { canary, held, next, f, j };
    };

    it("doesn't halt the version, and the rollout carries on past it", async () => {
      const { held, f } = await heldMember();
      // Past this batch: it starts only if the held member doesn't block it.
      const last = [
        await on("0.92.0", { created: 7 }),
        await on("0.92.0", { created: 8 }),
        await on("0.92.0", { created: 9 }),
      ];
      const bump = await fleetJobs();
      for (const x of bump)
        if (x.status === "done") await setVersion(String(x.install_id), TARGET);
      for (let t = 2; t < 60; t += 2) {
        await fleetDue(f.env, NOW + t * MIN, f.opts);
        for (const x of await fleetJobs())
          if (x.status === "queued") {
            await finish(x.id, "done", NOW + t * MIN);
            await setVersion(String(x.install_id), TARGET);
          }
      }
      expect(await marks()).toEqual([]);
      const c = await fleetConditions(f.env, NOW + 60 * MIN);
      expect(c.fleet_halted.rows).toEqual([]);
      const reached = (await fleetJobs()).map((x) => x.install_id);
      expect(reached).toEqual(expect.arrayContaining(last));
      expect(reached.filter((x) => x === held)).toHaveLength(1);
    });

    it("isn't tried again for this target", async () => {
      const { held, f } = await heldMember();
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      await fleetDue(f.env, NOW + 4 * MIN, f.opts);
      expect(
        (await fleetJobs()).filter((x) => x.install_id === held),
      ).toHaveLength(1);
    });

    it("can't be mistaken for upgraded: no soak, and version_skew shows it", async () => {
      const { held, f, j } = await heldMember();
      for (let t = 2; t < 40; t += 2)
        await fleetDue(f.env, NOW + t * MIN, f.opts);
      expect(await stateKeys(`fleet_soaked:${TARGET}:${held}`)).toEqual([]);
      expect(await stateKeys(`fleet_pass:${TARGET}:${held}`)).toEqual([]);
      const c = await fleetConditions(f.env, NOW + FLEET_SKEW_MS + MIN);
      expect(c.version_skew.rows).toContainEqual(
        expect.objectContaining({
          install_id: held,
          version: TARGET,
          job_id: j?.id,
        }),
      );
    });

    it("any other failure on a member still halts", async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const m = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const [j] = await fleetJobs();
      await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      expect(await marks()).toEqual([`fleet_halt:${TARGET}:${m}`]);
    });
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
        releases: async () => {
          await then();
          return [release(TARGET)];
        },
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

describe("#1110 review: the batch gate", () => {
  /** The canary soaked on TARGET, one member done and unsoaked, one to go. */
  async function batch() {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on(TARGET, { created: 5 });
    await fleetJob(member, {});
    const rest = await on("0.92.0", { created: 9 });
    return { canary, member, rest, f: fakes({ canary }) };
  }

  it("a batch member suspended, paused, busy or rolled back still holds the next batch", async () => {
    const acts: ((id: string) => Promise<unknown>)[] = [
      lifecycleSuspend,
      (id) =>
        db
          .prepare(
            "UPDATE install_lifecycle SET serving_mode = 'paused' WHERE install_id = ?1",
          )
          .bind(id)
          .run(),
      (id) => job(id, { kind: "suspend", workflow: "manage_install" }),
      (id) => setVersion(id, "0.92.0"),
    ];
    for (const act of acts) {
      await reset();
      const { member, f } = await batch();
      await act(member);
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([]);
    }
  });

  it("a paused member isn't probed: it can't answer, and that's no failure", async () => {
    const { member, f } = await batch();
    await db
      .prepare(
        "UPDATE install_lifecycle SET serving_mode = 'paused' WHERE install_id = ?1",
      )
      .bind(member)
      .run();
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).not.toContain(member);
  });

  it("only soaking takes a member out", async () => {
    const { member, rest, f } = await batch();
    await soaked(member);
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("or the install going away", async () => {
    const { member, rest, f } = await batch();
    await db
      .prepare(
        "UPDATE install_lifecycle SET deleted_at = ?2, purge_at = ?2 WHERE install_id = ?1",
      )
      .bind(member, NOW)
      .run();
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("the insert holds the gate: a job finishing after the tick's read can't let a batch start", async () => {
    const canary = await on("0.92.0");
    const other = await on(TARGET, { created: 5 });
    const j = await fleetJob(other, { status: "running", finished_at: null });
    const f = fakes({ canary });
    f.env.PROVISIONER = {
      releases: async () => {
        await finish(j, "done", NOW);
        return [release(TARGET)];
      },
    } as unknown as ProvapiEnv["PROVISIONER"];
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([]);
  });

  it("a member's gate is per version: V's unsoaked batch doesn't stop V+1", async () => {
    const { canary, member } = await batch();
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW, g.opts);
    expect(await queued()).toEqual([canary]);
    expect(member).toBeTruthy();
  });

  it("R25 on a job after it landed: the install soaks all the same, and holds", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on(TARGET, { created: 5 });
    await fleetJob(member, {
      status: "failed",
      error_code: "canceled",
    });
    await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).toContain(member);
    expect(await queued()).toEqual([]);
  });

  it("the gate counts a landed, canceled job on its own, with the member out of the watch", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on(TARGET, { created: 5 });
    await fleetJob(member, { status: "failed", error_code: "canceled" });
    await lifecycleSuspend(member);
    await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([]);
  });

  it("R25 before the job landed holds nothing", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on("0.92.0", { created: 5 });
    await fleetJob(member, { status: "failed", error_code: "canceled" });
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([rest]);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
  });
});

describe("#1110 review: a halt never blocks V+1", () => {
  const NEXT = "v0.93.1";
  const halted = (id: string) =>
    db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:${TARGET}:${id}`, NOW - MIN)
      .run();

  for (const [what, over] of [
    ["unhealthy", { health: "failing" }],
    ["paused", { serving: "paused" }],
  ] as const) {
    it(`a canary the release broke, now ${what}, takes the next release`, async () => {
      const canary = await on(TARGET, over);
      await halted(canary);
      const f = fakes({ canary, tag: NEXT });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([canary]);
    });

    it(`a canary ${what} for another reason doesn't`, async () => {
      const canary = await on("0.92.0", over);
      const f = fakes({ canary, tag: NEXT });
      const lines = captureLogs(vi.spyOn);
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
      expect(lines).toContain(
        `provapi fleet canary_blocked ${"health" in over ? "unhealthy" : "unavailable"}`,
      );
    });

    it(`any install the release broke, now ${what}, takes it in its batch`, async () => {
      const canary = await on("0.93.1", { created: 0 });
      await soaked(canary, "0.93.1");
      const victim = await on(TARGET, { ...over, created: 5 });
      await halted(victim);
      const other = await on("0.92.0", { ...over, created: 6 });
      const f = fakes({ canary, tag: NEXT });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([victim]);
      expect(other).toBeTruthy();
    });
  }
});

describe("#1110 review: canary_blocked is a catch-all", () => {
  const key = `${FLEET_BLOCKED_PREFIX}${TARGET}`;
  const codes = async (f: ReturnType<typeof fakes>, at: number) =>
    (await fleetConditions(f.env, at)).fleet_halted.rows.map((r) => r.code);
  const opens = async (f: ReturnType<typeof fakes>, t0 = NOW) => {
    expect(await codes(f, t0 + FLEET_BLOCKED_MS - MIN)).toEqual([]);
    expect(await codes(f, t0 + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  };

  it("R25 cancels the canary's job, spending its request id", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "canceled");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    await opens(f);
  });

  it("an operator rolls the canary back", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "done", NOW + MIN);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    await opens(f);
  });

  it("R25 lands after the canary's upgrade did", async () => {
    const canary = await on(TARGET);
    await fleetJob(canary, { status: "failed", error_code: "canceled" });
    const f = fakes({ canary, answers: new Map() });
    await ticks(f, NOW, NOW + 2 * MIN);
    await opens(f);
  });

  it("the target isn't published", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary, releases: [] });
    await fleetDue(f.env, NOW, f.opts);
    await opens(f);
  });

  it("clears once the canary has soaked", async () => {
    const canary = await on(TARGET);
    const f = fakes({ canary });
    await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
    expect(await stateKeys(key)).toEqual([]);
    expect(await codes(f, NOW + FLEET_BLOCKED_MS)).toEqual([]);
  });

  it("no false all-clear: the next release doesn't restart the clock", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW + 20 * MIN, g.opts);
    expect(await codes(g, NOW + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  });

  it("a halted target ends the clock: fleet_halted says so itself", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(key)).toEqual([]);
  });

  it("a non-semver canary version blocks, and never throws", async () => {
    const canary = await on("not-a-version");
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(lines).toContain("provapi fleet canary_blocked bad_version");
    await opens(f);
  });

  it("a test-hook canary on the target is never probed, and halts nothing", async () => {
    const canary = await on(TARGET, { test_hooks: 1 });
    const f = fakes({ canary });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect(f.probed).not.toContain(canary);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
    await opens(f);
  });
});

describe("#1110 review: halts count per version, and say so", () => {
  async function two() {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const a = await on(TARGET, { created: 5 });
    await fleetJob(a, {});
    const b = await on(TARGET, { created: 6 });
    await fleetJob(b, {});
    return { canary, a, b };
  }

  it("one failed probe on each of two installs, on separate ticks, halts the version", async () => {
    const { canary, a, b } = await two();
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    f.answers.clear();
    f.answers.set(b, "down");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys("fleet_halt:")).toEqual([
      `fleet_halt:${TARGET}:${b}`,
    ]);
  });

  it("two installs failing in one tick are one failure", async () => {
    const { canary, a, b } = await two();
    const f = fakes({
      canary,
      answers: new Map([
        [a, "down"],
        [b, "down"],
      ]),
    });
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
  });

  it("the alert names the version, the install and the job", async () => {
    const { canary, a } = await two();
    const [j] = await rows(
      "SELECT id FROM jobs WHERE install_id = ?1 AND kind = 'upgrade'",
      a,
    );
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows).toContainEqual(
      expect.objectContaining({
        install_id: a,
        job_id: j?.id,
        job_kind: "upgrade",
        version: TARGET,
      }),
    );
  });

  it("a canary on the target by hand has no job to name, and says so with null", async () => {
    const canary = await on(TARGET);
    const f = fakes({ canary, answers: new Map([[canary, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows).toContainEqual(
      expect.objectContaining({
        install_id: canary,
        job_id: null,
        version: TARGET,
      }),
    );
  });

  it("a new halt owes an email, even with the alert already open", async () => {
    const { canary, a } = await two();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES ('fleet_halted_notified_at', ?1, ?1)",
      )
      .bind(NOW - MIN)
      .run();
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    const [n] = await rows(
      "SELECT value FROM platform_state WHERE key = 'fleet_halted_notified_at'",
    );
    expect(n?.value).toBe(0);
  });

  it("a halt writes one audit row, as the scheduler", async () => {
    const { canary, a } = await two();
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await ticks(f, NOW, NOW + 4 * MIN);
    const r = await rows(
      "SELECT actor, install_id, detail FROM hosted_audit WHERE action = 'fleet.halted' AND install_id = ?1",
      a,
    );
    expect(r).toEqual([
      {
        actor: SYSTEM_ACTOR.key,
        install_id: a,
        detail: JSON.stringify({ version: TARGET }),
      },
    ]);
  });

  it("a failed batch loses nothing: the next failing tick halts", async () => {
    const { canary, a } = await two();
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    const flaky = new Proxy(db, {
      get(t, p) {
        if (p === "batch")
          return async () => {
            throw new Error("D1 down");
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: flaky } as ProvapiEnv,
      NOW + 2 * MIN,
      f.opts,
    ).catch(() => {});
    expect(await stateKeys("fleet_halt:")).toEqual([]);
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await stateKeys("fleet_halt:")).toEqual([
      `fleet_halt:${TARGET}:${a}`,
    ]);
  });
});

describe("#1110 last round", () => {
  const seedHalt = (v: string, id: string) =>
    db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:${v}:${id}`, NOW - MIN)
      .run();

  describe("F1: an exempted install gets one try", () => {
    it("a broken install takes one release, and isn't exempt for the next", async () => {
      const canary = await on("0.93.1", { created: 0 });
      await soaked(canary, "0.93.1");
      const broken = await on(TARGET, { created: 5, health: "failing" });
      await seedHalt(TARGET, broken);
      const f = fakes({ canary, tag: "v0.93.1" });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([broken]);
      expect(await stateKeys(FLEET_RETRY_PREFIX)).toEqual([
        `${FLEET_RETRY_PREFIX}${broken}`,
      ]);
      // It fails. The release halts, once.
      const [j] = await fleetJobs();
      await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      expect(await stateKeys("fleet_halt:0.93.1:")).toHaveLength(1);
      // The next release doesn't touch it, so it can't halt that one too.
      const next = await on("0.93.2", { created: 0 });
      await soaked(next, "0.93.2");
      const g = fakes({ canary: next, tag: "v0.93.2" });
      await fleetDue(g.env, NOW + 4 * MIN, g.opts);
      expect(await queued()).toEqual([canary]);
      expect(await stateKeys("fleet_halt:0.93.2:")).toEqual([]);
    });

    it("soaking gives the try back", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const id = await on(TARGET, { created: 5 });
      await fleetJob(id, {});
      await db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(`${FLEET_RETRY_PREFIX}${id}`, NOW)
        .run();
      const f = fakes({ canary });
      await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
      expect(await stateKeys(FLEET_RETRY_PREFIX)).toEqual([]);
    });

    it("a healthy install on a halted version spends no try", async () => {
      const canary = await on("0.93.1", { created: 0 });
      await soaked(canary, "0.93.1");
      const fine = await on(TARGET, { created: 5 });
      await seedHalt(TARGET, canary);
      const f = fakes({ canary, tag: "v0.93.1" });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([fine]);
      expect(await stateKeys(FLEET_RETRY_PREFIX)).toEqual([]);
    });
  });

  it("F3: every install on the halted version is exempt, not only the one that tripped it", async () => {
    const canary = await on("0.93.1", { created: 0 });
    await soaked(canary, "0.93.1");
    const tripped = await on(TARGET, { created: 5, health: "failing" });
    const other = await on(TARGET, { created: 6, health: "failing" });
    const unrelated = await on("0.92.0", { created: 7, health: "failing" });
    await seedHalt(TARGET, tripped);
    const f = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([tripped, other]);
    expect(unrelated).toBeTruthy();
  });

  it("F1: a broken canary gets one try too", async () => {
    const canary = await on(TARGET, { health: "failing" });
    await seedHalt(TARGET, canary);
    const f = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([canary]);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    const g = fakes({ canary, tag: "v0.93.2" });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(g.env, NOW + 2 * MIN, g.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(lines).toContain("provapi fleet canary_blocked unhealthy");
  });

  it("F3: an install reverted to an older version, having halted one, gets its try too", async () => {
    const canary = await on("0.93.1", { created: 0 });
    await soaked(canary, "0.93.1");
    const reverted = await on("0.92.0", { created: 5, health: "failing" });
    await seedHalt(TARGET, reverted);
    const f = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([reverted]);
  });

  describe("F2: no silent stall after the canary soaks", () => {
    it("a canceled job on a canary that landed still releases the rest", async () => {
      const canary = await on(TARGET, { created: 0 });
      await fleetJob(canary, { status: "failed", error_code: "canceled" });
      const rest = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
      expect(await queued()).toEqual([rest]);
      expect(await stateKeys(FLEET_BLOCKED_PREFIX)).toEqual([]);
    });

    it("the stamp clears only when the canary is ready, and comes back if it stops", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await stateKeys(FLEET_BLOCKED_PREFIX)).toEqual([]);
      // Soaked, but it can no longer lead: paused by a person.
      await db
        .prepare(
          "UPDATE install_lifecycle SET serving_mode = 'paused' WHERE install_id = ?1",
        )
        .bind(canary)
        .run();
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      const c = await fleetConditions(f.env, NOW + 2 * MIN + FLEET_BLOCKED_MS);
      expect(c.fleet_halted.rows.map((r) => r.code)).toEqual([
        "canary_blocked",
      ]);
    });
  });

  describe("F4: a held rollout", () => {
    async function held() {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const member = await on(TARGET, { created: 5 });
      await fleetJob(member, {});
      await lifecycleSuspend(member);
      await on("0.92.0", { created: 9 });
      return { canary, member, f: fakes({ canary }) };
    }

    it("logs who holds it", async () => {
      const { member, f } = await held();
      const lines = captureLogs(vi.spyOn);
      await fleetDue(f.env, NOW, f.opts);
      expect(lines).toContain(`provapi fleet held by ${member}`);
    });

    it("sends no fleet_halted all-clear while held", async () => {
      const { f } = await held();
      const c = await fleetConditions(f.env, NOW);
      expect(c.fleet_halted).toEqual({ open: null, rows: [] });
    });

    it("clears as usual when nothing holds it", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const f = fakes({ canary });
      const c = await fleetConditions(f.env, NOW);
      expect(c.fleet_halted).toEqual({ open: false, rows: [] });
    });

    it("a real row still opens the alert while held", async () => {
      const { member, f } = await held();
      await seedHalt("0.92.9", member);
      const c = await fleetConditions(f.env, NOW);
      expect(c.fleet_halted.open).toBe(true);
    });
  });

  describe("F5: the rows name version and job", () => {
    it("canary_blocked", async () => {
      const canary = await on("0.92.0");
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const [j] = await fleetJobs();
      await finish(j?.id, "failed", NOW + MIN, "canceled");
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      const c = await fleetConditions(f.env, NOW + FLEET_BLOCKED_MS);
      expect(c.fleet_halted.rows[0]).toMatchObject({
        code: "canary_blocked",
        version: TARGET,
        job_id: j?.id,
      });
    });

    it("version_skew", async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const behind = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const [j] = await fleetJobs();
      const c = await fleetConditions(f.env, NOW + FLEET_SKEW_MS);
      expect(c.version_skew.rows[0]).toMatchObject({
        install_id: behind,
        version: TARGET,
        job_id: j?.id,
      });
    });

    it("version_skew with no job says null", async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const behind = await on("0.92.0", { created: 5, health: "failing" });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const c = await fleetConditions(f.env, NOW + FLEET_SKEW_MS);
      expect(c.version_skew.rows[0]).toMatchObject({
        install_id: behind,
        version: TARGET,
        job_id: null,
      });
    });
  });

  it("F8: a repeat of a halt writes no second audit row and owes no second email", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    // The tick's state was read before an overlapping tick wrote the mark.
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES ('fleet_halted_notified_at', ?1, ?1)",
      )
      .bind(NOW)
      .run();
    const stale = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") {
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        }
        return (sql: string) =>
          sql.startsWith("SELECT key, value, updated_at FROM platform_state")
            ? t.prepare(
                "SELECT key, value, updated_at FROM platform_state WHERE 0",
              )
            : t.prepare(sql);
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: stale } as ProvapiEnv,
      NOW + 4 * MIN,
      f.opts,
    );
    expect(
      await rows(
        "SELECT id FROM hosted_audit WHERE action = 'fleet.halted' AND install_id = ?1",
        canary,
      ),
    ).toHaveLength(1);
    const [n] = await rows(
      "SELECT value FROM platform_state WHERE key = 'fleet_halted_notified_at'",
    );
    expect(n?.value).toBe(NOW);
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

describe("#1343: FLEET_SECOND and FLEET_SOAK_MIN", () => {
  /** The canary upgraded to TARGET, done; the watch soaks it from NOW. */
  async function canaryUp() {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    return canary;
  }
  /** Ticks until `id`'s upgrade lands: done, on the target. */
  async function land(id: string, at: number) {
    const j = (await fleetJobs()).find((r) => r.install_id === id);
    await finish(j?.id, "done", at);
    await setVersion(id, TARGET);
  }

  describe("parsing", () => {
    it("FLEET_SOAK_MIN: unset is the default, whole minutes 1 to the max, else null", () => {
      expect(fleetSoakMs(undefined)).toBe(FLEET_SOAK_MS);
      expect(fleetSoakMs("")).toBe(FLEET_SOAK_MS);
      expect(fleetSoakMs("60")).toBe(60 * MIN);
      expect(fleetSoakMs(" 15 ")).toBe(15 * MIN);
      expect(fleetSoakMs("1")).toBe(MIN);
      expect(fleetSoakMs(String(FLEET_SOAK_MIN_MAX))).toBe(
        FLEET_SOAK_MIN_MAX * MIN,
      );
      for (const v of [
        "0",
        "-5",
        "6O",
        "60.5",
        "1e2",
        "060",
        String(FLEET_SOAK_MIN_MAX + 1),
        "99999",
      ])
        expect(fleetSoakMs(v), v).toBeNull();
    });

    it("the blocked window is the soak plus 30 minutes", () => {
      expect(fleetBlockedMs(FLEET_SOAK_MS)).toBe(FLEET_BLOCKED_MS);
      expect(FLEET_BLOCKED_MS).toBe(45 * MIN);
      expect(fleetBlockedMs(60 * MIN)).toBe(90 * MIN);
    });

    it("FLEET_SECOND is an install id other than the canary", () => {
      const a = installId();
      const b = installId();
      expect(fleetSecond(b, a)).toBe(b);
      expect(fleetSecond(b, null)).toBe(b);
      expect(fleetSecond(a, a)).toBeNull();
      expect(fleetSecond("", a)).toBeNull();
      expect(fleetSecond("leo", a)).toBeNull();
      expect(fleetSecond(undefined, a)).toBeNull();
    });
  });

  it("leo goes alone right after the canary soaks, then batches of 3, oldest first", async () => {
    const canary = await canaryUp();
    // Older installs than leo: without FLEET_SECOND they would go first.
    const old = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 1; i++)
      old.push(await on("0.92.0", { created: 1 + i }));
    const leo = await on("0.92.0", { created: 50 });
    const f = fakes({ canary, second: leo });
    // The canary soaks FLEET_SOAK_MS; nothing else moves before.
    await ticks(f, NOW, NOW + FLEET_SOAK_MS - 2 * MIN);
    expect(await fleetJobs()).toHaveLength(1);
    const t1 = NOW + FLEET_SOAK_MS;
    await fleetDue(f.env, t1, f.opts);
    expect(await queued()).toEqual([leo]);
    // While leo runs, and then soaks, no batch starts.
    await fleetDue(f.env, t1 + 2 * MIN, f.opts);
    await land(leo, t1 + 3 * MIN);
    const t2 = t1 + 4 * MIN;
    await ticks(f, t2, t2 + FLEET_SOAK_MS - 2 * MIN);
    expect(await queued()).toEqual([]);
    expect((await fleetJobs()).map((j) => j.install_id)).toEqual([canary, leo]);
    // Leo soaked: the first batch, oldest first.
    await fleetDue(f.env, t2 + FLEET_SOAK_MS, f.opts);
    expect(await stateKeys(`${FLEET_SOAKED_PREFIX}${TARGET}:${leo}`)).toEqual([
      `${FLEET_SOAKED_PREFIX}${TARGET}:${leo}`,
    ]);
    expect(await queued()).toEqual(old.slice(0, FLEET_CONCURRENCY));
  });

  it("leo already on the target, or not eligible: the batches go as before", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const leo = await on("0.92.0", { created: 0, suspended: true });
    const rest = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 1; i++)
      rest.push(await on("0.92.0", { created: 1 + i }));
    const f = fakes({ canary, second: leo });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual(rest.slice(0, FLEET_CONCURRENCY));
  });

  it("FLEET_SECOND equal to the canary changes nothing", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const rest = [];
    for (let i = 0; i < FLEET_CONCURRENCY; i++)
      rest.push(await on("0.92.0", { created: 1 + i }));
    const f = fakes({ canary, second: canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual(rest);
  });

  it("leo's failed upgrade halts the version: no batch starts", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const leo = await on("0.92.0", { created: 50 });
    const rest = await on("0.92.0", { created: 1 });
    const f = fakes({ canary, second: leo });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_incomplete");
    await ticks(f, NOW + 2 * MIN, NOW + 20 * MIN);
    expect(await stateKeys(`fleet_halt:${TARGET}:`)).toEqual([
      `fleet_halt:${TARGET}:${leo}`,
    ]);
    expect((await fleetJobs()).map((r) => r.install_id)).not.toContain(rest);
  });

  it("FLEET_SOAK_MIN sets the soak: 60 minutes on the canary, not 15", async () => {
    const canary = await canaryUp();
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary, soakMin: "60" });
    await ticks(f, NOW, NOW + 60 * MIN - 2 * MIN);
    expect(await queued()).toEqual([]);
    await fleetDue(f.env, NOW + 60 * MIN, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("FLEET_SOAK_MIN applies to leo too", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const leo = await on(TARGET, { created: 5 });
    await fleetJob(leo, { finished_at: NOW - MIN });
    const rest = await on("0.92.0", { created: 1 });
    const f = fakes({ canary, second: leo, soakMin: "60" });
    await ticks(f, NOW, NOW + 60 * MIN - 2 * MIN);
    expect(await queued()).toEqual([]);
    await fleetDue(f.env, NOW + 60 * MIN, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("a gap over 5 minutes restarts a 60 minute soak", async () => {
    const canary = await canaryUp();
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary, soakMin: "60" });
    await ticks(f, NOW, NOW + 30 * MIN);
    const back = NOW + 30 * MIN + FLEET_SOAK_GAP_MS + MIN;
    await ticks(f, back, back + 60 * MIN - 2 * MIN);
    expect(await queued()).toEqual([]);
    await fleetDue(f.env, back + 60 * MIN, f.opts);
    expect(await queued()).toHaveLength(1);
  });

  it("the blocked window scales with the soak: no canary_blocked mid-soak", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary, soakMin: "60" });
    await fleetDue(f.env, NOW, f.opts);
    const code = async (at: number) =>
      (await fleetConditions(f.env, at)).fleet_halted.rows.map((r) => r.code);
    // The default's window (45 min) is inside a 60 minute soak: still quiet.
    expect(await code(NOW + FLEET_BLOCKED_MS)).toEqual([]);
    expect(await code(NOW + 90 * MIN - 1)).toEqual([]);
    expect(await code(NOW + 90 * MIN)).toEqual(["canary_blocked"]);
  });

  it("an invalid FLEET_SOAK_MIN moves nothing and opens fleet_halted (bad_soak)", async () => {
    const canary = await on("0.92.0", { created: 0 });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary, soakMin: "6O" });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual(["provapi fleet bad_soak"]);
    const c = await fleetConditions(f.env, NOW);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ code: "bad_soak" }],
    });
  });

  it("with no canary, FLEET_SECOND and FLEET_SOAK_MIN are inert (prod as shipped)", async () => {
    const leo = await on("0.92.0", { created: 0 });
    await on("0.92.0", { created: 1 });
    const f = fakes({ canary: "", second: leo, soakMin: "60" });
    const lines = captureLogs(vi.spyOn);
    await ticks(f, NOW, NOW + 120 * MIN);
    expect(await fleetJobs()).toEqual([]);
    expect(new Set(lines)).toEqual(new Set(["provapi fleet no_canary"]));
    const c = await fleetConditions(f.env, NOW + 120 * MIN);
    expect(c.fleet_halted.open).toBe(false);
    expect(c.version_skew.open).toBeNull();
  });
});
