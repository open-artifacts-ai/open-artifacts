import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sqlConditions } from "../src/provapi/conditions.js";
import type { ProvapiEnv } from "../src/provapi/env.js";
import {
  HEALTH_CONCURRENCY,
  HEALTH_INTERVAL_MS,
  type HealthProbe,
  healthDue,
  publicRouteProbe,
} from "../src/provapi/health.js";
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

beforeAll(migrate);
beforeEach(reset);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const TICK = 2 * 60_000;
const env = { PLATFORM_DB: db, OA_ENV: "staging" } as unknown as ProvapiEnv;

type Behave = "ok" | "wrongId" | "notOk" | "500" | "throw" | "hang" | "html";

function fakes(behave: (id: string) => Behave = () => "ok") {
  const calls: { id: string; host: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const probe: HealthProbe = async (id, host) => {
    calls.push({ id, host });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // One microtask so lanes overlap.
      await Promise.resolve();
      const b = behave(id);
      if (b === "throw") throw new Error("boom owner@customer.test");
      if (b === "hang") return await new Promise<Response>(() => {});
      if (b === "500") return new Response("no", { status: 500 });
      if (b === "html") return new Response("<html>", { status: 200 });
      return Response.json({
        ok: b !== "notOk",
        installId: b === "wrongId" ? "iaaaaaaaaaaa" : id,
      });
    } finally {
      inFlight--;
    }
  };
  return { probe, calls, max: () => maxInFlight };
}

async function mapped(mode: string | null = "serving") {
  const id = installId();
  const r = await install(id);
  await lifecycle(id, { serving_mode: mode });
  return { id, host: r.app_host as string };
}

const health = async (id: string) =>
  (
    await rows(
      "SELECT health, health_at, updated_at FROM install_lifecycle WHERE install_id = ?1",
      id,
    )
  )[0];

describe("health", () => {
  it("runs once per HEALTH_INTERVAL_MS across */2 ticks", async () => {
    const f = fakes();
    await mapped();
    captureLogs(vi.spyOn);
    const ran: number[] = [];
    for (let t = NOW; t <= NOW + 2 * HEALTH_INTERVAL_MS; t += TICK)
      if (await healthDue(env, t, { probe: f.probe })) ran.push(t);
    expect(ran).toEqual([
      NOW,
      NOW + HEALTH_INTERVAL_MS,
      NOW + 2 * HEALTH_INTERVAL_MS,
    ]);
    expect(f.calls).toHaveLength(3);
  });

  it("overlapping ticks run it once", async () => {
    const f = fakes();
    await mapped();
    captureLogs(vi.spyOn);
    const r = await Promise.all([
      healthDue(env, NOW, { probe: f.probe }),
      healthDue(env, NOW, { probe: f.probe }),
    ]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  });

  it("serving rows are checked at their app host; paused, closed, unmapped and null are skipped", async () => {
    const f = fakes();
    const s = await mapped("serving");
    const others = [
      await mapped("paused"),
      await mapped("closed"),
      await mapped("unmapped"),
      await mapped(null),
    ];
    captureLogs(vi.spyOn);
    await healthDue(env, NOW, { probe: f.probe });
    expect(f.calls).toEqual([{ id: s.id, host: s.host }]);
    // Only health and health_at are written.
    expect(await health(s.id)).toEqual({
      health: "ok",
      health_at: NOW,
      updated_at: 1,
    });
    for (const x of others)
      expect(await health(x.id)).toEqual({
        health: "unknown",
        health_at: null,
        updated_at: 1,
      });
  });

  it("an installId mismatch, ok not true, a non-200, a non-JSON body, a throw or a timeout is failing", async () => {
    const kinds: Behave[] = [
      "wrongId",
      "notOk",
      "500",
      "html",
      "throw",
      "hang",
    ];
    const ids: Record<string, Behave> = {};
    for (const k of kinds) ids[(await mapped()).id] = k;
    const f = fakes((id) => ids[id] ?? "ok");
    const lines = captureLogs(vi.spyOn);
    await healthDue(env, NOW, { probe: f.probe, timeoutMs: 20 });
    for (const id of Object.keys(ids))
      expect((await health(id))?.health, ids[id]).toBe("failing");
    expect(lines).toEqual([
      `provapi health checked mapped=${kinds.length} failing=${kinds.length}`,
    ]);
  });

  it(`at most ${HEALTH_CONCURRENCY} at a time`, async () => {
    const f = fakes();
    for (let i = 0; i < 3 * HEALTH_CONCURRENCY; i++) await mapped();
    captureLogs(vi.spyOn);
    await healthDue(env, NOW, { probe: f.probe });
    expect(f.calls).toHaveLength(3 * HEALTH_CONCURRENCY);
    expect(f.max()).toBe(HEALTH_CONCURRENCY);
  });

  it("a failing install whose latest job is a done create opens unreachable_after_route; healthy, it clears", async () => {
    const { id } = await mapped();
    await job(id, { status: "done", finished_at: NOW - TICK });
    captureLogs(vi.spyOn);
    await healthDue(env, NOW, { probe: fakes(() => "throw").probe });
    const c = await sqlConditions(db, { now: NOW, signupDailyCap: 0 });
    expect(c.unreachable_after_route.rows.map((r) => r.install_id)).toEqual([
      id,
    ]);
    await healthDue(env, NOW + HEALTH_INTERVAL_MS, { probe: fakes().probe });
    const later = await sqlConditions(db, { now: NOW, signupDailyCap: 0 });
    expect(later.unreachable_after_route.open).toBe(false);
  });

  it("the least recently checked rows go first, so a tick cut short never skips the same tail", async () => {
    const recent = await mapped();
    const older = await mapped();
    const never = await mapped();
    const set = (id: string, at: number) =>
      db
        .prepare("UPDATE install_lifecycle SET health_at = ?2 WHERE install_id = ?1")
        .bind(id, at)
        .run();
    await set(recent.id, NOW - HEALTH_INTERVAL_MS);
    await set(older.id, NOW - 2 * HEALTH_INTERVAL_MS);
    const f = fakes();
    captureLogs(vi.spyOn);
    await healthDue(env, NOW, { probe: f.probe });
    expect(f.calls.map((c) => c.id)).toEqual([never.id, older.id, recent.id]);
  });

  it("a failed read of the mapped rows gives the hourly gate back", async () => {
    await mapped();
    const broken = new Proxy(db, {
      get(t, k) {
        if (k === "prepare")
          return (q: string) =>
            q.startsWith("SELECT l.install_id")
              ? {
                  all: () => Promise.reject(new Error("D1_ERROR")),
                  bind: () => ({
                    all: () => Promise.reject(new Error("D1_ERROR")),
                  }),
                }
              : t.prepare(q);
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const f = fakes();
    captureLogs(vi.spyOn);
    await expect(
      healthDue({ ...env, PLATFORM_DB: broken } as ProvapiEnv, NOW, {
        probe: f.probe,
      }),
    ).rejects.toThrow();
    expect(await healthDue(env, NOW + TICK, { probe: f.probe })).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("the default probe is a plain public-route GET of /healthz", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(u);
        return new Response("x");
      }),
    );
    await publicRouteProbe("i00000000001", "s1.app.test");
    expect(seen).toEqual(["https://s1.app.test/healthz"]);
  });
});
