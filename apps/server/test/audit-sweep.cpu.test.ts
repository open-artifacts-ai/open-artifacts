// The cron's audit retention sweep. What it must not regress: a run issues at
// most AUDIT_SWEEP_STATEMENTS bounded deletes of AUDIT_SWEEP_BATCH rows (no
// unbounded delete, no per-row work, no extra queries), and adds no
// meaningful Worker-side cost on top of D1 doing those deletes.
//
// Both are load-independent: statements and rows are counted through a
// test-local D1 proxy, and time is a ratio to a same-run baseline of plain
// bounded deletes on an equally seeded table (shared-runner load slows both
// sides; an absolute wall bar flaked at 14-59 ms vs 10 in CI). Runs serially
// via vitest.cpu.config.ts.
import { env } from "cloudflare:workers";
import { AUDIT_RETENTION_MS } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  AUDIT_SWEEP_BATCH,
  AUDIT_SWEEP_STATEMENTS,
  sweepAuditEvents,
} from "../src/services/audit.js";

const CAP = AUDIT_SWEEP_STATEMENTS * AUDIT_SWEEP_BATCH;

const seed = (n: number, at: number) =>
  env.DB.prepare(
    `with recursive s(i) as (select 0 union all select i + 1 from s where i + 1 < ?)
     insert into audit_events (id, at, actor_kind, action, target_type)
     select lower(hex(randomblob(10))), ? + i, 'system', 'test.cpu', 'artifact' from s`,
  )
    .bind(n, at)
    .run();

const clear = () => env.DB.prepare("delete from audit_events").run();

/** Expired-row timestamps for a sweep at `now` (oldest `n` rows). */
const expiredAt = (now: number, n: number) =>
  now - AUDIT_RETENTION_MS - 86_400_000 - n;

type Exec = { sql: string; changes: number };

/** env.DB, recording every statement executed and the rows each changed. */
function countingDb(db: D1Database): { db: D1Database; execs: Exec[] } {
  const execs: Exec[] = [];
  const record = (sql: string, r: unknown) => {
    const meta = (r as { meta?: { changes?: number } } | null)?.meta;
    execs.push({ sql, changes: meta?.changes ?? 0 });
  };
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop) {
        if (prop === "__inner") return target;
        if (prop === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (prop === "run" || prop === "all")
          return async () => {
            const r = await target[prop]();
            record(sql, r);
            return r;
          };
        if (prop === "first" || prop === "raw")
          return async (...args: unknown[]) => {
            const r = await (
              target[prop] as (...a: unknown[]) => Promise<unknown>
            )(...args);
            record(sql, null);
            return r;
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch")
        return async (ss: D1PreparedStatement[]) => {
          const inner = ss.map(
            (s) =>
              (s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s,
          );
          const rs = await target.batch(inner);
          for (const r of rs) record("<batch>", r);
          return rs;
        };
      if (prop === "exec")
        return async (sql: string) => {
          const r = await target.exec(sql);
          record(sql, null);
          return r;
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy, execs };
}

// The baseline: the same bounded delete issued directly. audit_events is
// WITHOUT ROWID, so it keys on id; same ordered subquery as the sweep, so the
// ratio isolates what sweepAuditEvents adds on the Worker side.
const BASELINE_SQL = `delete from audit_events where id in
  (select id from audit_events where at < ? order by at limit ?)`;

async function baseline(now: number): Promise<number> {
  const cutoff = now - AUDIT_RETENTION_MS;
  let n = 0;
  for (let i = 0; i < AUDIT_SWEEP_STATEMENTS; i++) {
    const r = await env.DB.prepare(BASELINE_SQL)
      .bind(cutoff, AUDIT_SWEEP_BATCH)
      .run();
    n += r.meta.changes;
  }
  return n;
}

const wall = async (f: () => Promise<number>) => {
  const t = performance.now();
  const n = await f();
  return { ms: performance.now() - t, n };
};

const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ??
  Number.POSITIVE_INFINITY;

/**
 * Sweep / baseline. Both sides are AUDIT_SWEEP_STATEMENTS bounded deletes of
 * AUDIT_SWEEP_BATCH rows, so the Worker-side difference is binds and a
 * counter; on an idle laptop and under 2x-cores busy-loop load the median
 * ratio stays near 1. 2.0 leaves room for run-to-run noise (per-repeat
 * ratios seen 0.8-1.3) while failing a sweep that doubles its statements or
 * does per-row work.
 */
const MAX_RATIO = 2.0;

describe("audit sweep CPU", () => {
  it("a full backlog: exactly AUDIT_SWEEP_STATEMENTS bounded deletes, CAP rows", async () => {
    await clear();
    const now = Date.now();
    await seed(
      CAP + AUDIT_SWEEP_BATCH,
      expiredAt(now, CAP + AUDIT_SWEEP_BATCH),
    );
    const { db, execs } = countingDb(env.DB);
    expect(await sweepAuditEvents({ ...env, DB: db }, now)).toBe(CAP);
    expect(execs).toHaveLength(AUDIT_SWEEP_STATEMENTS);
    for (const e of execs)
      expect(e.changes).toBeLessThanOrEqual(AUDIT_SWEEP_BATCH);
    expect(execs.reduce((s, e) => s + e.changes, 0)).toBe(CAP);
    await clear();
  });

  it("a partial backlog (1.5 batches) stops early", async () => {
    await clear();
    const now = Date.now();
    const n = AUDIT_SWEEP_BATCH * 1.5;
    await seed(n, expiredAt(now, n));
    const { db, execs } = countingDb(env.DB);
    expect(await sweepAuditEvents({ ...env, DB: db }, now)).toBe(n);
    expect(execs.length).toBe(2);
    expect(execs.length).toBeLessThan(AUDIT_SWEEP_STATEMENTS);
    for (const e of execs)
      expect(e.changes).toBeLessThanOrEqual(AUDIT_SWEEP_BATCH);
    expect(execs.reduce((s, e) => s + e.changes, 0)).toBe(n);
  });

  it("a full run costs at most MAX_RATIO x a same-run baseline of plain bounded deletes", async () => {
    await clear();
    const now = Date.now();
    const old = expiredAt(now, CAP);
    const sweep = () => sweepAuditEvents(env, now);
    const base = () => baseline(now);
    // Warm both statements once.
    await seed(CAP, old);
    await sweep();
    await seed(CAP, old);
    await base();
    const sweepMs: number[] = [];
    const baseMs: number[] = [];
    const ratios: number[] = [];
    for (let i = 0; i < 3; i++) {
      const order = i % 2 === 0 ? [sweep, base] : [base, sweep];
      const out: { ms: number; n: number }[] = [];
      for (const f of order) {
        await seed(CAP, old);
        out.push(await wall(f));
      }
      const [s, b] = i % 2 === 0 ? out : [out[1], out[0]];
      if (!s || !b) throw new Error("missing sample");
      expect(s.n).toBe(CAP);
      expect(b.n).toBe(CAP);
      sweepMs.push(s.ms);
      baseMs.push(b.ms);
      // workerd clocks advance in whole ms on I/O; never divide by 0.
      ratios.push(s.ms / Math.max(b.ms, 1));
    }
    const ratio = median(ratios);
    console.log(
      `audit sweep (${CAP} rows): ${median(sweepMs).toFixed(2)} ms, baseline ${median(baseMs).toFixed(2)} ms, ratio ${ratio.toFixed(2)} [${ratios.map((r) => r.toFixed(2)).join(", ")}]`,
    );
    expect(ratio).toBeLessThanOrEqual(MAX_RATIO);
  }, 60_000);
});
