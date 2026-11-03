// O1: self-host's one cron trigger (RECOVERY_CRON, every 2 min) runs the
// lost index and thumbnail sweep each tick and the daily work on the first
// tick in the daily slot (03:17 up to 03:30 UTC) that claims the UTC day; an
// install still on DAILY_CRON (alone or with the tick) claims the same day,
// so the daily work runs once a day. Each run logs cron_daily_ran
// { day, via }. Workers Free allows 10 ms of CPU per invocation: the idle
// tick's D1 statements are counted here, and its wall time is reported by
// cron.recovery.cpu.test.ts.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_CRON,
  DAILY_RAN_KEY,
  DAILY_SLOT_END_MS,
  DAILY_SLOT_START_MS,
  inDailySlot,
  RECOVERY_CRON,
  scheduled,
} from "../src/cron.js";
import type { Env } from "../src/env.js";

const MIN = 60_000;
/** 2026-01-<day> at hh:mm:ss.ms UTC. */
const at = (day: number, h: number, m: number, s = 0, ms = 0) =>
  Date.UTC(2026, 0, day, h, m, s, ms);
const ctxOf = () => {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
    drain: () => Promise.all(pending),
  };
};
const ranDay = async () =>
  (
    await env.DB.prepare("select value from settings where key = ?")
      .bind(DAILY_RAN_KEY)
      .first<{ value: string }>()
  )?.value ?? null;

/** One scheduled() call of `cron` at `t`; the waitUntil count once drained. */
const fire = async (cron: string, t: number, e: Env = env as Env) => {
  const c = ctxOf();
  await scheduled({ cron, scheduledTime: t }, e, c.ctx);
  await c.drain();
  return c.pending.length;
};
const tick = (t: number) => fire(RECOVERY_CRON, t);
const daily = (t: number, e?: Env) => fire(DAILY_CRON, t, e);

/** The cron_daily_ran lines logged while `f` runs. */
async function dailyLogs(f: () => Promise<unknown>) {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    if (!String(s).includes('"cron_daily_ran"')) return;
    lines.push(JSON.parse(String(s)) as Record<string, unknown>);
  });
  try {
    await f();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

/**
 * env whose DB counts executed statements (first/all/run/raw, and each
 * statement of a batch). A fresh object, so stmt()'s per-binding cache
 * prepares through it.
 */
function counting(base: Env) {
  const n = { q: 0 };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (typeof v !== "function") return v;
        if (p === "bind")
          return (...a: unknown[]) =>
            wrap(v.apply(t, a) as D1PreparedStatement);
        if (p === "first" || p === "all" || p === "run" || p === "raw")
          return (...a: unknown[]) => {
            n.q++;
            return v.apply(t, a);
          };
        return v.bind(t);
      },
    });
  const db = base.DB;
  const DB = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (ss: D1PreparedStatement[]) => {
      n.q += ss.length;
      return db.batch(ss);
    },
    exec: (sql: string) => {
      n.q++;
      return db.exec(sql);
    },
  } as unknown as D1Database;
  return { env: { ...base, DB } as Env, n };
}

beforeEach(async () => {
  await env.DB.prepare("delete from settings where key = ?")
    .bind(DAILY_RAN_KEY)
    .run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the daily slot", () => {
  it("runs from DAILY_CRON's time, 03:17 UTC, up to 03:30 UTC", () => {
    expect(DAILY_CRON).toBe("17 3 * * *");
    expect(DAILY_SLOT_START_MS).toBe((3 * 60 + 17) * MIN);
    expect(DAILY_SLOT_END_MS).toBe((3 * 60 + 30) * MIN);
  });

  it("boundaries (pinned clock)", () => {
    expect(inDailySlot(at(5, 3, 16))).toBe(false);
    expect(inDailySlot(at(5, 3, 16, 59, 999))).toBe(false);
    expect(inDailySlot(at(5, 3, 17))).toBe(true);
    expect(inDailySlot(at(5, 3, 18))).toBe(true);
    expect(inDailySlot(at(5, 3, 28))).toBe(true);
    expect(inDailySlot(at(5, 3, 29, 59, 999))).toBe(true);
    expect(inDailySlot(at(5, 3, 30))).toBe(false);
    expect(inDailySlot(at(5, 3, 32))).toBe(false);
    expect(inDailySlot(at(5, 12, 0))).toBe(false);
    // Only the time of day decides, before the epoch too.
    expect(inDailySlot(Date.UTC(1969, 11, 31, 3, 20))).toBe(true);
    expect(inDailySlot(Date.UTC(1969, 11, 31, 3, 30))).toBe(false);
  });
});

describe("RECOVERY_CRON", () => {
  it("an idle tick off the slot: the sweep only, two D1 statements, no daily work", async () => {
    const { env: e, n } = counting({
      ...(env as Env),
      BROWSER: {} as Fetcher,
      SERVER_THUMBNAILS: "on",
    });
    const c = ctxOf();
    await scheduled(
      { cron: RECOVERY_CRON, scheduledTime: at(6, 12, 0) },
      e,
      c.ctx,
    );
    // Far past every row this suite publishes: nothing to recover.
    expect(c.pending).toHaveLength(1);
    await c.drain();
    // The text and pdf-thumbnail windows: one indexed read each.
    expect(n.q).toBe(2);
    expect(await ranDay()).toBeNull();
  });

  it("an idle tick without server thumbnails reads once", async () => {
    const { env: e, n } = counting(env as Env);
    const c = ctxOf();
    await scheduled(
      { cron: RECOVERY_CRON, scheduledTime: at(6, 12, 2) },
      e,
      c.ctx,
    );
    await c.drain();
    expect(n.q).toBe(1);
  });

  it("the 03:16 tick runs no daily work; the 03:18 tick runs it once and logs it; 03:20 doesn't", async () => {
    const logs = await dailyLogs(async () => {
      expect(await tick(at(7, 3, 16))).toBe(1);
      expect(await ranDay()).toBeNull();
      // Sweep + daily.
      expect(await tick(at(7, 3, 18))).toBe(2);
      expect(await ranDay()).toBe("2026-01-07");
      // A repeated delivery of the same tick: the day is claimed.
      expect(await tick(at(7, 3, 18))).toBe(1);
      expect(await tick(at(7, 3, 20))).toBe(1);
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.via).toBe("slot");
    expect(logs[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The next day's slot runs it again.
    expect(await tick(at(8, 3, 18))).toBe(2);
    expect(await ranDay()).toBe("2026-01-08");
  });

  it("a missed 03:18 tick: 03:20 runs it; the slot's last tick, 03:28, would too", async () => {
    expect(await tick(at(12, 3, 20))).toBe(2);
    expect(await ranDay()).toBe("2026-01-12");
    expect(await tick(at(12, 3, 22))).toBe(1);
    expect(await tick(at(13, 3, 28))).toBe(2);
    expect(await ranDay()).toBe("2026-01-13");
  });

  it("only ticks in the slot claim: 03:16, 03:30 and 03:32 never run it", async () => {
    expect(await tick(at(14, 3, 16))).toBe(1);
    expect(await tick(at(14, 3, 30))).toBe(1);
    expect(await tick(at(14, 3, 32))).toBe(1);
    expect(await ranDay()).toBeNull();
  });

  it("without scheduledTime the tick falls back to the clock (pinned at midday: no daily)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(9, 12, 0) });
    const c = ctxOf();
    await scheduled({ cron: RECOVERY_CRON }, env as Env, c.ctx);
    await c.drain();
    expect(c.pending).toHaveLength(1);
    expect(await ranDay()).toBeNull();
  });
});

describe("DAILY_CRON (installs before O1, and with both triggers)", () => {
  it("alone: runs the daily work once a day, marks it and logs it", async () => {
    const logs = await dailyLogs(async () => {
      expect(await daily(at(10, 3, 17))).toBe(1);
      expect(await ranDay()).toBe("2026-01-10");
      // A repeated delivery the same day: claimed, nothing runs.
      expect(await daily(at(10, 3, 17))).toBe(0);
      expect(await daily(at(11, 3, 17))).toBe(1);
    });
    expect(logs.map((l) => l.via)).toEqual(["daily", "daily"]);
    expect(await ranDay()).toBe("2026-01-11");
  });

  it("without scheduledTime it claims the clock's day", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(15, 3, 17) });
    for (const n of [1, 0]) {
      const c = ctxOf();
      await scheduled({ cron: DAILY_CRON }, env as Env, c.ctx);
      await c.drain();
      expect(c.pending).toHaveLength(n);
    }
    expect(await ranDay()).toBe("2026-01-15");
  });

  it("both triggers: 03:17 runs it, the 03:18 tick skips it", async () => {
    const logs = await dailyLogs(async () => {
      expect(await daily(at(16, 3, 17))).toBe(1);
      expect(await tick(at(16, 3, 18))).toBe(1);
    });
    expect(logs.map((l) => l.via)).toEqual(["daily"]);
  });

  it("both triggers, 03:17 delivered late after the 03:18 tick: one run", async () => {
    const logs = await dailyLogs(async () => {
      expect(await tick(at(17, 3, 18))).toBe(2);
      expect(await daily(at(17, 3, 17))).toBe(0);
    });
    expect(logs.map((l) => l.via)).toEqual(["slot"]);
    expect(await ranDay()).toBe("2026-01-17");
  });

  it("both triggers at once: exactly one claim wins", async () => {
    const logs = await dailyLogs(async () => {
      const [d, t] = await Promise.all([
        daily(at(18, 3, 17)),
        tick(at(18, 3, 18)),
      ]);
      // The tick always registers its sweep; the daily work runs once.
      expect(d + t).toBe(2);
    });
    expect(logs).toHaveLength(1);
    expect(await ranDay()).toBe("2026-01-18");
  });

  it("hosted (the scheduler's nightly call): runs every call, marks nothing", async () => {
    const e = { ...(env as Env), HOSTED: "1" };
    const logs = await dailyLogs(async () => {
      expect(await daily(at(19, 3, 17), e)).toBe(1);
      expect(await daily(at(19, 3, 17), e)).toBe(1);
    });
    expect(logs.map((l) => l.via)).toEqual(["daily", "daily"]);
    expect(await ranDay()).toBeNull();
  });

  it("another non-oa: cron runs every call and marks the day, as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(20, 9, 0) });
    const logs = await dailyLogs(async () => {
      expect(await fire("0 9 * * *", at(20, 9, 0))).toBe(1);
      expect(await fire("0 9 * * *", at(20, 9, 0))).toBe(1);
    });
    expect(logs).toHaveLength(2);
    expect(await ranDay()).toBe("2026-01-20");
  });
});
