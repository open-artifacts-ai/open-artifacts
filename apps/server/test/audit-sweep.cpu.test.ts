// The cron's audit retention sweep: a full run is AUDIT_SWEEP_STATEMENTS
// deletes that return no rows, so the Worker's own CPU is binds and a
// counter. Wall clock in local workerd includes D1 doing the deletes (not
// Worker CPU) and still stays well under the 10 ms Free budget per
// statement. Runs serially via vitest.cpu.config.ts.
import { env } from "cloudflare:workers";
import { AUDIT_RETENTION_MS } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  AUDIT_SWEEP_BATCH,
  AUDIT_SWEEP_STATEMENTS,
  sweepAuditEvents,
} from "../src/services/audit.js";

const seed = (n: number, at: number) =>
  env.DB.prepare(
    `with recursive s(i) as (select 0 union all select i + 1 from s where i + 1 < ?)
     insert into audit_events (id, at, actor_kind, action, target_type)
     select lower(hex(randomblob(10))), ? + i, 'system', 'test.cpu', 'artifact' from s`,
  )
    .bind(n, at)
    .run();

describe("audit sweep CPU", () => {
  it("a full run (5 × 1000 expired rows) is under 10 ms wall per statement", async () => {
    const now = Date.now();
    const cap = AUDIT_SWEEP_STATEMENTS * AUDIT_SWEEP_BATCH;
    const old = now - AUDIT_RETENTION_MS - 86_400_000 - cap;
    const ms: number[] = [];
    for (let i = 0; i < 3; i++) {
      await seed(cap, old);
      const t = performance.now();
      expect(await sweepAuditEvents(env, now)).toBe(cap);
      ms.push(performance.now() - t);
    }
    const median = [...ms].sort((a, b) => a - b)[1] ?? Infinity;
    console.log(`audit sweep (${cap} rows): ${median.toFixed(2)} ms`);
    expect(median / AUDIT_SWEEP_STATEMENTS).toBeLessThan(10);
  }, 60_000);
});
