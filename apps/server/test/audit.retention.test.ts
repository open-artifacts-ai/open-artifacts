// Audit retention: the daily cron deletes audit_events rows older than
// AUDIT_RETENTION_MS (400 days), oldest first, in bounded batches.
import { env } from "cloudflare:workers";
import { AUDIT_RETENTION_MS, newId } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_SWEEP_BATCH,
  AUDIT_SWEEP_STATEMENTS,
  sweepAuditEvents,
} from "../src/services/audit.js";

const DAY = 86_400_000;

/** `n` rows tagged `tag` (target_id), `at` 1 ms apart from `at`. */
async function seed(tag: string, n: number, at: number) {
  await env.DB.prepare(
    `with recursive s(i) as (select 0 union all select i + 1 from s where i + 1 < ?)
     insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id)
     select lower(hex(randomblob(10))), ? + i, 'system', null, 'test.retention', 'artifact', ? from s`,
  )
    .bind(n, at, tag)
    .run();
}
const count = async (tag: string) =>
  (
    await env.DB.prepare(
      "select count(*) n from audit_events where target_id = ?",
    )
      .bind(tag)
      .first<{ n: number }>()
  )?.n;
/** Clears every expired row so each test starts from its own seed. */
const drain = async (now: number) => {
  while ((await sweepAuditEvents(env, now)) > 0);
};
/** Runs `f` with console.log captured; returns its result and the lines. */
async function logged<T>(f: () => Promise<T>): Promise<[T, string[]]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const r = await f();
    return [r, log.mock.calls.map((c) => String(c[0]))];
  } finally {
    log.mockRestore();
  }
}

describe("sweepAuditEvents", () => {
  it("is 400 days", () => {
    expect(AUDIT_RETENTION_MS).toBe(400 * DAY);
  });

  it("deletes rows older than 400 days and keeps newer ones", async () => {
    const now = Date.now();
    await drain(now);
    const old = `old-${newId()}`;
    const edge = `edge-${newId()}`;
    const kept = `kept-${newId()}`;
    await seed(old, 3, now - 401 * DAY);
    // Exactly at the cutoff is kept (strictly older goes).
    await seed(edge, 1, now - AUDIT_RETENTION_MS);
    await seed(kept, 3, now - 399 * DAY);
    const [n, lines] = await logged(() => sweepAuditEvents(env, now));
    expect(n).toBe(3);
    expect(await count(old)).toBe(0);
    expect(await count(edge)).toBe(1);
    expect(await count(kept)).toBe(3);
    // The count only: no ids, actors or detail in the log line.
    expect(lines).toContainEqual(
      JSON.stringify({ evt: "audit_swept", deleted: 3, more: false }),
    );
    expect(await sweepAuditEvents(env, now)).toBe(0);
  });

  it("respects the batch limit, oldest first, and continues on the next run", async () => {
    const now = Date.now();
    await drain(now);
    const tag = `batch-${newId()}`;
    const older = `older-${newId()}`;
    await seed(older, 4, now - 900 * DAY);
    await seed(tag, 21, now - 500 * DAY);
    // 2 statements of 5: 10 rows, the 4 oldest first.
    expect(await sweepAuditEvents(env, now, 5, 2)).toBe(10);
    expect(await count(older)).toBe(0);
    expect(await count(tag)).toBe(15);
    expect(await sweepAuditEvents(env, now, 5, 2)).toBe(10);
    expect(await count(tag)).toBe(5);
    // A short batch ends the run early.
    expect(await sweepAuditEvents(env, now, 5, 2)).toBe(5);
    expect(await count(tag)).toBe(0);
    expect(await sweepAuditEvents(env, now, 5, 2)).toBe(0);
  });

  it("a default run deletes at most AUDIT_SWEEP_STATEMENTS × AUDIT_SWEEP_BATCH", async () => {
    const now = Date.now();
    await drain(now);
    const cap = AUDIT_SWEEP_STATEMENTS * AUDIT_SWEEP_BATCH;
    const tag = `cap-${newId()}`;
    await seed(tag, cap + 7, now - 450 * DAY);
    const [n, lines] = await logged(() => sweepAuditEvents(env, now));
    expect(n).toBe(cap);
    expect(lines).toContainEqual(
      JSON.stringify({ evt: "audit_swept", deleted: cap, more: true }),
    );
    expect(await count(tag)).toBe(7);
    expect(await sweepAuditEvents(env, now)).toBe(7);
  });

  it("plans as an index range on audit_events_at_idx, never a table scan", async () => {
    const { results } = await env.DB.prepare(
      `explain query plan delete from audit_events where id in
        (select id from audit_events where at < ? order by at limit ?)`,
    )
      .bind(0, 1)
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/USING COVERING INDEX audit_events_at_idx \(at<\?\)/);
    expect(plan).not.toMatch(/SCAN audit_events/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});
