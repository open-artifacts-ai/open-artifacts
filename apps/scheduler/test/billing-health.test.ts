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
import { ALERT_REMIND_MS } from "../src/alerts.js";
import { BILLING_OK_KEY, billingHealth } from "../src/billing-health.js";
import scheduler, { type Env, REVOKE_CRON } from "../src/index.js";

// The billing outage alert: each 2-minute tick checks BILLING /health, keeps
// the last success in platform D1, and once the last success is over an hour
// old the billing_unreachable alert opens: one email, one a day while it
// lasts, and one when the next success clears it.

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
const DAY = ALERT_REMIND_MS;

const OPEN = "Open Artifacts staging: billing unreachable";
const REMIND = "Open Artifacts staging: billing still unreachable";
const CLEAR = "Open Artifacts staging: billing reachable again";

type Mode = "ok" | "500" | "throw" | "hang" | "notok";

function billing() {
  let mode: Mode = "ok";
  const urls: string[] = [];
  const subjects: string[] = [];
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
  const mail = {
    send: async (m: { subject: string }) => {
      subjects.push(m.subject);
      return { messageId: "m" };
    },
  } as unknown as SendEmail;
  return {
    env: {
      BILLING: f,
      PLATFORM_DB: db,
      OA_ENV: "staging",
      ALERT_EMAIL: mail,
      ALERT_TO: "ops@example.test",
      ALERT_FROM: "alerts@example.test",
    },
    set: (m: Mode) => {
      mode = m;
    },
    urls,
    subjects,
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
  it("a success records its time; nothing is logged or sent", async () => {
    const b = billing();
    const lines = logs();
    expect(await billingHealth(b.env, T0)).toBe("ok");
    expect(await state(BILLING_OK_KEY)).toBe(T0);
    expect(b.urls).toEqual(["https://billing.oa.internal/health"]);
    expect(lines).toEqual([]);
    expect(b.subjects).toEqual([]);
  });

  it("down for up to an hour: nothing; past an hour: the alert opens, then stays quiet for 24 h", async () => {
    const b = billing();
    const lines = logs();
    await billingHealth(b.env, T0);
    b.set("throw");
    for (let t = T0 + 2 * MIN; t <= T0 + 60 * MIN; t += 2 * MIN)
      expect(await billingHealth(b.env, t)).toBe("down");
    expect(lines).toEqual([]);
    expect(b.subjects).toEqual([]);
    expect(await billingHealth(b.env, T0 + 62 * MIN)).toBe("unreachable");
    expect(b.subjects).toEqual([OPEN]);
    expect(lines).toEqual([
      "alert billing_unreachable opened",
      "alert billing_unreachable sent open",
    ]);
    // Every tick of the next 24 h is quiet.
    for (let t = T0 + 64 * MIN; t < T0 + 62 * MIN + DAY; t += 60 * MIN)
      expect(await billingHealth(b.env, t)).toBe("unreachable");
    expect(b.subjects).toEqual([OPEN]);
    expect(lines).toHaveLength(2);
    // The daily reminder.
    await billingHealth(b.env, T0 + 62 * MIN + DAY);
    expect(b.subjects).toEqual([OPEN, REMIND]);
    // The last success never moves while billing is down.
    expect(await state(BILLING_OK_KEY)).toBe(T0);
  });

  it("every failure kind counts as down: a 500, ok:false, a throw, a hang past the timeout", async () => {
    for (const m of ["500", "notok", "throw", "hang"] as Mode[]) {
      await db.prepare("DELETE FROM platform_state").run();
      const b = billing();
      await billingHealth(b.env, T0);
      b.set(m);
      expect(await billingHealth(b.env, T0 + 61 * MIN, { timeoutMs: 20 })).toBe(
        "unreachable",
      );
      expect(b.subjects).toEqual([OPEN]);
    }
  });

  it("the next success clears it (one email, one line); a later outage opens from that success", async () => {
    const b = billing();
    const lines = logs();
    await billingHealth(b.env, T0);
    b.set("throw");
    await billingHealth(b.env, T0 + 61 * MIN);
    b.set("ok");
    expect(await billingHealth(b.env, T0 + 70 * MIN)).toBe("ok");
    expect(await billingHealth(b.env, T0 + 72 * MIN)).toBe("ok");
    expect(b.subjects).toEqual([OPEN, CLEAR]);
    b.set("throw");
    // The clock runs from the last success (T0 + 72 min).
    expect(await billingHealth(b.env, T0 + 132 * MIN)).toBe("down");
    expect(await billingHealth(b.env, T0 + 133 * MIN)).toBe("unreachable");
    expect(b.subjects).toEqual([OPEN, CLEAR, OPEN]);
    expect(lines).toEqual([
      "alert billing_unreachable opened",
      "alert billing_unreachable sent open",
      "alert billing_unreachable cleared",
      "alert billing_unreachable sent clear",
      "alert billing_unreachable opened",
      "alert billing_unreachable sent open",
    ]);
  });

  it("no success on record: the clock starts at the first failure", async () => {
    const b = billing();
    b.set("throw");
    expect(await billingHealth(b.env, T0)).toBe("down");
    expect(await billingHealth(b.env, T0 + 60 * MIN)).toBe("down");
    expect(await billingHealth(b.env, T0 + 61 * MIN)).toBe("unreachable");
    expect(b.subjects).toEqual([OPEN]);
  });

  it("overlapping ticks email once", async () => {
    const b = billing();
    await billingHealth(b.env, T0);
    b.set("throw");
    await Promise.all(
      Array.from({ length: 4 }, () => billingHealth(b.env, T0 + 61 * MIN)),
    );
    expect(b.subjects).toEqual([OPEN]);
  });

  it("no destination: logs `alert skipped no_destination` and still tracks the outage", async () => {
    const b = billing();
    const lines = logs();
    const env = { ...b.env, ALERT_TO: "" };
    await billingHealth(env, T0);
    b.set("throw");
    expect(await billingHealth(env, T0 + 61 * MIN)).toBe("unreachable");
    expect(lines).toEqual([
      "alert billing_unreachable opened",
      "alert skipped no_destination",
    ]);
    expect(await state("billing_unreachable_opened_at")).toBe(T0 + 61 * MIN);
  });

  it("a platform D1 error is one fixed line and never throws", async () => {
    const b = billing();
    const broken = {
      ...b.env,
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
    expect(b.subjects).toEqual([]);
  });
});

describe("the 2-minute tick", () => {
  const env = (b: ReturnType<typeof billing>) =>
    ({
      ...b.env,
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
    expect(b.subjects).toEqual([OPEN]);
    expect(lines).toContain("alert billing_unreachable opened");
    // The directory sync still ran after it (its summary line).
    expect(
      lines.filter((l) => l.startsWith("directory-sync summary")),
    ).toHaveLength(2);
  });
});
