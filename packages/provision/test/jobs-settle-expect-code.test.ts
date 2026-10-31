// settleFailed's expectCode (C6, W7 review): a compare-and-set on the code
// the caller read. With it, the settle UPDATE also requires
// `error_code IS ?` (null matches null); a changed code writes nothing,
// settled is false, and extras guarded on the settle do not run. Run on
// the real 0008 schema with the stand-in UPDATE (W3 builds the real one).
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type SettleOptions, settledWith } from "../src/jobs.js";
import { job, platformDb } from "./platform-db.js";

const SETTLE =
  "UPDATE jobs SET status = 'failed', error_code = COALESCE(error_code, ?2), updated_at = ?3 WHERE id = ?1 AND status IN ('queued', 'running')";
const SETTLE_CAS = `${SETTLE} AND error_code IS ?4`;
const cleanupInsert = (guard: string) =>
  `INSERT OR IGNORE INTO jobs (id, kind, workflow, install_id, parent_job_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
SELECT ?2, 'cleanup', 'manage_install', ?3, ?1, 'system', 'system:scheduler', 'scheduler', 'cleanup-' || ?1, 'h', '{}', 'queued', 9, 9
WHERE ${guard}`;

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

/** A settle with run_dead and opts.expectCode, then a cleanup under `guard` (a code, or SQL). */
function settle(
  db: DatabaseSync,
  parent: string,
  opts: Pick<SettleOptions, "expectCode">,
  guard: "run_dead" | "canceled" | string,
) {
  let settled = 0;
  let inserted = 0;
  batch(db, () => {
    settled = Number(
      (opts.expectCode === undefined
        ? db.prepare(SETTLE).run(parent, "run_dead", 9)
        : db.prepare(SETTLE_CAS).run(parent, "run_dead", 9, opts.expectCode)
      ).changes,
    );
    inserted = Number(
      db
        .prepare(
          cleanupInsert(
            guard === "run_dead" || guard === "canceled"
              ? settledWith("?1", guard)
              : guard,
          ),
        )
        .run(parent, `c-${parent}`, "i1").changes,
    );
  });
  const row = db
    .prepare("SELECT status, error_code FROM jobs WHERE id = ?")
    .get(parent);
  return { settled: settled === 1, inserted, row };
}

describe("SettleOptions.expectCode: compare-and-set on error_code", () => {
  it("expected null, still null: settles (and the run_dead guard adds one cleanup)", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running" });
    expect(settle(db, parent, { expectCode: null }, "run_dead")).toEqual({
      settled: true,
      inserted: 1,
      row: { status: "failed", error_code: "run_dead" },
    });
  });

  it("expected null, now 'canceled': no settle, settled=false, no cleanup", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running", error_code: "canceled" });
    expect(settle(db, parent, { expectCode: null }, "run_dead")).toEqual({
      settled: false,
      inserted: 0,
      row: { status: "running", error_code: "canceled" },
    });
  });

  // Exactly one cleanup in total, whoever queues it: the extra also
  // guards on no cleanup for this parent yet, plus INSERT OR IGNORE.
  const ONE_CLEANUP = `${settledWith("?1", "canceled")} AND NOT EXISTS (SELECT 1 FROM jobs c WHERE c.parent_job_id = ?1 AND c.kind = 'cleanup')`;
  const cleanupCount = (db: DatabaseSync, parent: string) =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'cleanup' AND parent_job_id = ?",
      )
      .get(parent);

  it("expected 'canceled', is 'canceled', no cleanup yet: settles and adds exactly one", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running", error_code: "canceled" });
    // COALESCE keeps the stored code: this call ends up writing 'canceled'.
    expect(settle(db, parent, { expectCode: "canceled" }, ONE_CLEANUP)).toEqual(
      {
        settled: true,
        inserted: 1,
        row: { status: "failed", error_code: "canceled" },
      },
    );
    expect(cleanupCount(db, parent)).toEqual({ n: 1 });
  });

  it("expected 'canceled', is 'canceled', the cancel's cleanup present: settles and adds none", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running", error_code: "canceled" });
    // The cancel path's own cleanup (done, so jobs_one_active admits the
    // still-open parent in this fixture).
    job(db, "i1", {
      kind: "cleanup",
      workflow: "manage_install",
      parent_job_id: parent,
      status: "done",
      request_id: "admin-cancel-req-0001",
    });
    expect(settle(db, parent, { expectCode: "canceled" }, ONE_CLEANUP)).toEqual(
      {
        settled: true,
        inserted: 0,
        row: { status: "failed", error_code: "canceled" },
      },
    );
    expect(cleanupCount(db, parent)).toEqual({ n: 1 });
  });

  it("absent: unchanged (settles over any stored code, never overwriting it)", () => {
    const db = platformDb();
    const parent = job(db, "i1", { status: "running", error_code: "canceled" });
    expect(settle(db, parent, {}, "canceled")).toEqual({
      settled: true,
      inserted: 1,
      row: { status: "failed", error_code: "canceled" },
    });
  });
});
