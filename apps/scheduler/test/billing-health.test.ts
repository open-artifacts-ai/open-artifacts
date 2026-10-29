import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  BILLING_ALERT_KEY,
  BILLING_OK_KEY,
  billingHealth,
} from "../src/billing-health.js";
import scheduler, { type Env, REVOKE_CRON } from "../src/index.js";

// The billing outage alert: each 2-minute tick checks BILLING /health, keeps
// the last success in platform D1, and once the last success is over an hour
// old logs one `billing unreachable since <iso>` line per hour.

const db = (testEnv as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.prepare("DELETE FROM platform_state").run();
  await db.prepare("DELETE FROM installs").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const T0 = Date.UTC(2026, 9, 29, 12, 0);
const MIN = 60_000;

type Mode = "ok" | "500" | "throw" | "hang" | "notok";

function billing() {
  let mode: Mode = "ok";
  const urls: string[] = [];
  const f = {
    fetch: async (input: string | Request) => {
      urls.push(typeof input === "string" ? input : input.url);
      if (mode === "throw") throw new Error("binding down: secret detail");
      if (mode === "hang") return new Promise<Response>(() => {});
      if (mode === "500") return new Response("x", { status: 500 });
      if (mode === "notok") return Response.json({ ok: false });
      return Response.json({ ok: true });
    },
  } as unknown as Fetcher;
  return {
    env: { BILLING: f, PLATFORM_DB: db },
    set: (m: Mode) => {
      mode = m;
    },
    urls,
  };
}

const state = async (key: string) =>
  (
    await db
      .prepare("SELECT value FROM platform_state WHERE key = ?1")
      .bind(key)
      .first<{ value: number }>()
  )?.value ?? null;

function logs() {
  const lines: string[] = [];
  for (const k of ["log", "warn", "error"] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
  return lines;
}

describe("billingHealth", () => {
  it("a success records its time; nothing is logged", async () => {
    const b = billing();
    const lines = logs();
    expect(await billingHealth(b.env, T0)).toBe("ok");
    expect(await state(BILLING_OK_KEY)).toBe(T0);
    expect(b.urls).toEqual(["https://billing.oa.internal/health"]);
    expect(lines).toEqual([]);
  });

  it("down for up to an hour: no alert; past an hour: one line, then once per hour", async () => {
    const b = billing();
    const lines = logs();
    await billingHealth(b.env, T0);
    b.set("throw");
    for (let t = T0 + 2 * MIN; t <= T0 + 60 * MIN; t += 2 * MIN)
      expect(await billingHealth(b.env, t)).toBe("down");
    expect(lines).toEqual([]);
    expect(await billingHealth(b.env, T0 + 62 * MIN)).toBe("alerted");
    const since = new Date(T0).toISOString();
    expect(lines).toEqual([`billing unreachable since ${since}`]);
    // Every tick of the next hour is quiet.
    for (let t = T0 + 64 * MIN; t < T0 + 122 * MIN; t += 2 * MIN)
      expect(await billingHealth(b.env, t)).toBe("down");
    expect(lines).toHaveLength(1);
    expect(await billingHealth(b.env, T0 + 122 * MIN)).toBe("alerted");
    expect(lines).toEqual([
      `billing unreachable since ${since}`,
      `billing unreachable since ${since}`,
    ]);
    // The last success never moves while billing is down.
    expect(await state(BILLING_OK_KEY)).toBe(T0);
    expect(await state(BILLING_ALERT_KEY)).toBe(T0 + 122 * MIN);
  });

  it("every failure kind counts as down: a 500, ok:false, a throw, a hang past the timeout", async () => {
    for (const m of ["500", "notok", "throw", "hang"] as Mode[]) {
      await db.prepare("DELETE FROM platform_state").run();
      const b = billing();
      await billingHealth(b.env, T0);
      b.set(m);
      const lines = logs();
      expect(await billingHealth(b.env, T0 + 61 * MIN, { timeoutMs: 20 })).toBe(
        "alerted",
      );
      expect(lines).toEqual([
        `billing unreachable since ${new Date(T0).toISOString()}`,
      ]);
      vi.restoreAllMocks();
    }
  });

  it("recovery records the new success; a later outage alerts from it", async () => {
    const b = billing();
    const lines = logs();
    await billingHealth(b.env, T0);
    b.set("throw");
    await billingHealth(b.env, T0 + 61 * MIN);
    b.set("ok");
    await billingHealth(b.env, T0 + 70 * MIN);
    b.set("throw");
    expect(await billingHealth(b.env, T0 + 120 * MIN)).toBe("down");
    expect(await billingHealth(b.env, T0 + 131 * MIN)).toBe("alerted");
    expect(lines).toEqual([
      `billing unreachable since ${new Date(T0).toISOString()}`,
      `billing unreachable since ${new Date(T0 + 70 * MIN).toISOString()}`,
    ]);
  });

  it("no success on record: the clock starts at the first failure", async () => {
    const b = billing();
    b.set("throw");
    const lines = logs();
    expect(await billingHealth(b.env, T0)).toBe("down");
    expect(await billingHealth(b.env, T0 + 60 * MIN)).toBe("down");
    expect(await billingHealth(b.env, T0 + 61 * MIN)).toBe("alerted");
    expect(lines).toEqual([
      `billing unreachable since ${new Date(T0).toISOString()}`,
    ]);
  });

  it("overlapping ticks alert once", async () => {
    const b = billing();
    await billingHealth(b.env, T0);
    b.set("throw");
    const lines = logs();
    const r = await Promise.all(
      Array.from({ length: 4 }, () => billingHealth(b.env, T0 + 61 * MIN)),
    );
    expect(r.filter((x) => x === "alerted")).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it("a platform D1 error is one fixed line and never throws", async () => {
    const b = billing();
    const broken = {
      BILLING: b.env.BILLING,
      PLATFORM_DB: {
        prepare: () => {
          throw new Error("D1_ERROR: secret detail");
        },
      } as unknown as D1Database,
    };
    const lines = logs();
    expect(await billingHealth(broken, T0)).toBe("ok");
    b.set("throw");
    expect(await billingHealth(broken, T0)).toBe("down");
    expect(lines).toEqual([
      "billing-health db_error",
      "billing-health db_error",
    ]);
  });
});

describe("the 2-minute tick", () => {
  const env = (b: ReturnType<typeof billing>) =>
    ({
      ...b.env,
      OA_ENV: "staging",
      DISPATCHER: {
        get: () => {
          throw new Error("no install expected");
        },
      },
    }) as unknown as Env;

  it("checks billing health on the 2-minute tick", async () => {
    const b = billing();
    const ctx = createExecutionContext();
    await scheduler.scheduled(
      {
        cron: REVOKE_CRON,
        scheduledTime: T0,
      } as unknown as ScheduledController,
      env(b),
      ctx,
    );
    expect(b.urls).toEqual(["https://billing.oa.internal/health"]);
    expect(await state(BILLING_OK_KEY)).toBe(T0);
  });

  it("an outage alerts from the tick and the tick still runs the rest", async () => {
    const b = billing();
    b.set("throw");
    const lines = logs();
    const ctx = createExecutionContext();
    for (const t of [T0, T0 + 61 * MIN])
      await scheduler.scheduled(
        {
          cron: REVOKE_CRON,
          scheduledTime: t,
        } as unknown as ScheduledController,
        env(b),
        ctx,
      );
    expect(lines).toContain(
      `billing unreachable since ${new Date(T0).toISOString()}`,
    );
    // The directory sync still ran after it (its summary line).
    expect(
      lines.filter((l) => l.startsWith("directory-sync summary")),
    ).toHaveLength(2);
  });
});
