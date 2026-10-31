// settleFailed extras (design v7 3.6, C5 review): the sweep's cleanup insert
// runs after the settle UPDATE in one batch, so it must guard on this call's
// own code and be INSERT OR IGNORE. Run on the real 0008 schema.
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { settledWith } from "../src/jobs.js";
import { job, platformDb } from "./platform-db.js";

// The settle UPDATE as 3.6 states it (W3 builds the real one): open only,
// never over a stored code.
const SETTLE =
  "UPDATE jobs SET status = 'failed', error_code = COALESCE(error_code, ?2), updated_at = ?3 WHERE id = ?1 AND status IN ('queued', 'running')";
const cleanupInsert = (guard: string) =>
  `INSERT OR IGNORE INTO jobs (id, kind, workflow, install_id, parent_job_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
SELECT ?4, 'cleanup', 'manage_install', ?5, ?1, 'system', 'system:scheduler', 'scheduler', 'cleanup-' || ?1, 'h', '{}', 'queued', ?3, ?3
WHERE ${guard}`;

/** One D1-like batch: all or nothing. */
function batch(db: DatabaseSync, run: () => void) {
  db.exec("BEGIN");
  try {
    run();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function sweepSettle(db: DatabaseSync, parent: string, cleanupId: string) {
  let settled = 0;
  let inserted = 0;
  batch(db, () => {
    settled = Number(db.prepare(SETTLE).run(parent, "run_dead", 9).changes);
    inserted = Number(
      db
        .prepare(cleanupInsert(settledWith("?1", "run_dead")))
        .run(parent, "run_dead", 9, cleanupId, "i1").changes,
    );
  });
  return { settled, inserted };
}

const cleanups = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT id, actor_key, status FROM jobs WHERE kind = 'cleanup' ORDER BY id",
    )
    .all();

describe("settleFailed extras: guard on this call's code, INSERT OR IGNORE", () => {
  it("a sweep settle after an R25 cancel adds no second cleanup and does not fail", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running" });
    // R25: one batch marks it canceled and queues the admin's cleanup.
    batch(db, () => {
      db.prepare(SETTLE).run(parent, "canceled", 5);
      job(db, "i1", {
        kind: "cleanup",
        workflow: "manage_install",
        parent_job_id: parent,
        request_id: "admin-cancel-req-0001",
      });
    });
    const r = sweepSettle(db, parent, "01JBQ4ZKXW5V9R3M2N8P6T7Y0A");
    expect(r).toEqual({ settled: 0, inserted: 0 });
    expect(cleanups(db)).toEqual([
      expect.objectContaining({ actor_key: "admin:a", status: "queued" }),
    ]);
    const p = db
      .prepare("SELECT error_code FROM jobs WHERE id = ?")
      .get(parent);
    expect(p).toEqual({ error_code: "canceled" });
  });

  it("a status-only guard would fail the batch on jobs_one_active (why the rule)", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running" });
    db.prepare(SETTLE).run(parent, "canceled", 5);
    job(db, "i1", { kind: "cleanup", workflow: "manage_install" });
    const plain = cleanupInsert(
      "EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND status = 'failed')",
    ).replace("INSERT OR IGNORE", "INSERT");
    expect(() =>
      batch(db, () => {
        db.prepare(SETTLE).run(parent, "run_dead", 9);
        db.prepare(plain).run(parent, "run_dead", 9, "c1", "i1");
      }),
    ).toThrow(/UNIQUE/);
  });

  it("a dead run gets exactly one cleanup, also across repeated ticks", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running" });
    expect(sweepSettle(db, parent, "c1")).toEqual({ settled: 1, inserted: 1 });
    // The next tick: already settled (by this sweep), cleanup still open.
    expect(sweepSettle(db, parent, "c2")).toEqual({ settled: 0, inserted: 0 });
    // Even once that cleanup is done, cleanup-<jobId> is taken.
    db.prepare("UPDATE jobs SET status = 'done' WHERE id = 'c1'").run();
    expect(sweepSettle(db, parent, "c3")).toEqual({ settled: 0, inserted: 0 });
    expect(cleanups(db)).toHaveLength(1);
  });

  it("settledWith takes a placeholder or column and a known code only", () => {
    expect(settledWith("?5", "run_dead")).toBe(
      "EXISTS (SELECT 1 FROM jobs WHERE id = ?5 AND status = 'failed' AND error_code = 'run_dead')",
    );
    expect(settledWith("j.id", "canceled")).toContain("id = j.id");
    expect(() => settledWith("?1", "nope" as never)).toThrow(/unknown/);
    for (const bad of ["1); DROP TABLE jobs; --", "'x'", ""])
      expect(() => settledWith(bad, "run_dead")).toThrow(/placeholder/);
  });
});
