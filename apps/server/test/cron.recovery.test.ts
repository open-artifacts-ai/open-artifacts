// O1: self-host's one cron trigger (RECOVERY_CRON, every 2 min) runs the
// lost index and thumbnail sweep each tick and the daily work on the tick in
// the daily slot; an install still on DAILY_CRON (alone or with the tick)
// runs the daily work once a day. Workers Free allows 10 ms of CPU per
// invocation, which a test can't measure, so the idle tick's D1 statements
// are counted instead.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_CRON,
  DAILY_RAN_KEY,
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
afterEach(() => vi.restoreAllMocks());

describe("the daily slot", () => {
  it("is the first 2-min tick at or after 03:17 UTC: 03:18", () => {
    expect(DAILY_CRON).toBe("17 3 * * *");
    expect(DAILY_SLOT_START_MS).toBe((3 * 60 + 18) * MIN);
  });

  it("boundaries (pinned clock)", () => {
    expect(inDailySlot(at(5, 3, 16))).toBe(false);
    expect(inDailySlot(at(5, 3, 17, 59, 999))).toBe(false);
    expect(inDailySlot(at(5, 3, 18))).toBe(true);
    expect(inDailySlot(at(5, 3, 19, 59, 999))).toBe(true);
    expect(inDailySlot(at(5, 3, 20))).toBe(false);
    expect(inDailySlot(at(5, 12, 0))).toBe(false);
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

  it("the 03:16 tick runs no daily work; the 03:18 tick runs it once; 03:20 doesn't", async () => {
    const run = async (t: number) => {
      const c = ctxOf();
      await scheduled(
        { cron: RECOVERY_CRON, scheduledTime: t },
        env as Env,
        c.ctx,
      );
      await c.drain();
      return c.pending.length;
    };
    expect(await run(at(7, 3, 16))).toBe(1);
    expect(await ranDay()).toBeNull();
    // Sweep + daily.
    expect(await run(at(7, 3, 18))).toBe(2);
    expect(await ranDay()).toBe("2026-01-07");
    // A repeated delivery of the same tick: the day is claimed.
    expect(await run(at(7, 3, 18))).toBe(1);
    expect(await run(at(7, 3, 20))).toBe(1);
    // The next day's slot runs it again.
    expect(await run(at(8, 3, 18))).toBe(2);
    expect(await ranDay()).toBe("2026-01-08");
  });

  it("without scheduledTime the tick falls back to the clock (pinned at midday: no daily)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(9, 12, 0) });
    try {
      const c = ctxOf();
      await scheduled({ cron: RECOVERY_CRON }, env as Env, c.ctx);
      await c.drain();
      expect(c.pending).toHaveLength(1);
      expect(await ranDay()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DAILY_CRON (installs before O1, and with both triggers)", () => {
  it("runs the daily work every call and marks the day", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(10, 3, 17) });
    try {
      for (let i = 0; i < 2; i++) {
        const c = ctxOf();
        await scheduled({ cron: DAILY_CRON }, env as Env, c.ctx);
        expect(c.pending).toHaveLength(1);
        await c.drain();
      }
      expect(await ranDay()).toBe("2026-01-10");
    } finally {
      vi.useRealTimers();
    }
  });

  it("both triggers: 03:17 runs it, the 03:18 tick skips it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(11, 3, 17) });
    try {
      const d = ctxOf();
      await scheduled({ cron: DAILY_CRON }, env as Env, d.ctx);
      await d.drain();
      const c = ctxOf();
      await scheduled(
        { cron: RECOVERY_CRON, scheduledTime: at(11, 3, 18) },
        env as Env,
        c.ctx,
      );
      await c.drain();
      expect(c.pending).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hosted (the scheduler's nightly call) marks nothing", async () => {
    const c = ctxOf();
    await scheduled(
      { cron: DAILY_CRON },
      { ...(env as Env), HOSTED: "1" },
      c.ctx,
    );
    await c.drain();
    expect(await ranDay()).toBeNull();
  });
});
