// Purge after grace (design v7 5.8): a deleting install whose purge_at has
// passed, with no open job and not suspended, gets a purge job on
// ManageInstall (the scheduler's own transition, deleting -> purge by S,
// 5.1: the test pins it to canTransition). Tries are numbered n = 0, 1, 2
// per grace end (purgeRequestId) and stop once the install has
// PURGE_MAX_TRIES failed purges, counted as C2's purge_stuck counts them
// (any actor, any grace end), so the scheduler stops exactly when that
// alert opens.
import {
  PURGE_MAX_TRIES,
  purgeRequestId,
  SYSTEM_ACTOR,
} from "@oa/shared/provisioning/system";
import { bound, d1, lanes, type ProvapiEnv } from "./env.js";
import { insertSystemJob, startJob } from "./jobs.js";
import { dutyCategory } from "./run.js";

/** Installs looked at per tick, earliest purge_at first. */
export const PURGE_LIMIT = 20;
export const PURGE_CONCURRENCY = 3;

// Never while suspended (5.4): an operator suspended it for a reason. A
// stuck install (purge_stuck) is left out here, not only in the loop, so
// PURGE_LIMIT stuck installs with the oldest purge_at never crowd out one
// that comes due later.
const DUE = `SELECT install_id, signup_id, purge_at FROM install_status WHERE state = 'deleting' AND purge_at IS NOT NULL AND purge_at <= ?1 AND suspended_at IS NULL AND active_job_id IS NULL AND (SELECT COUNT(*) FROM jobs p WHERE p.install_id = install_status.install_id AND p.kind = 'purge' AND p.status = 'failed') < ${PURGE_MAX_TRIES} ORDER BY purge_at, install_id LIMIT ?2`;
// failed: every failed purge on the install (purge_stuck's count). mine: the
// scheduler's tries for this grace end, any status; they number the next.
const TRIES = `SELECT
  (SELECT COUNT(*) FROM jobs WHERE install_id = ?1 AND kind = 'purge' AND status = 'failed') AS failed,
  (SELECT COUNT(*) FROM jobs WHERE install_id = ?1 AND kind = 'purge' AND actor_key = '${SYSTEM_ACTOR.key}' AND request_id LIKE ?2) AS mine`;
// The insert's own check, in the same statement: still due for this grace
// end (not restored, suspended, purged or deleted again since the due
// read). ?3 install id, ?8 now, ?9 purge_at.
const STILL_DUE =
  "EXISTS (SELECT 1 FROM install_status WHERE install_id = ?3 AND state = 'deleting' AND suspended_at IS NULL AND purge_at = ?9 AND purge_at <= ?8)";

interface Due {
  install_id: string;
  signup_id: string | null;
  purge_at: number;
}

export async function purgeDue(env: ProvapiEnv, now: number): Promise<void> {
  const db = env.PLATFORM_DB;
  const manage = bound(env.MANAGE_INSTALL);
  const { results } = await d1(
    db.prepare(DUE).bind(now, PURGE_LIMIT).all<Due>(),
  );
  await lanes(results, PURGE_CONCURRENCY, async (r) => {
    try {
      const prefix = `${purgeRequestId(r.install_id, r.purge_at, 0).slice(0, -1)}%`;
      const t = await d1(
        db
          .prepare(TRIES)
          .bind(r.install_id, prefix)
          .first<{ failed: number; mine: number }>(),
      );
      // The purge_stuck alert has it from here (a guard: DUE leaves these
      // out, but a try may have failed since).
      if ((t?.failed ?? 0) >= PURGE_MAX_TRIES) return;
      // n counts from 0: the scheduler's tries for this grace end so far.
      const n = t?.mine ?? 0;
      if (n >= PURGE_MAX_TRIES) return;
      const id = await insertSystemJob(
        db,
        {
          kind: "purge",
          installId: r.install_id,
          signupId: r.signup_id,
          parentJobId: null,
          requestId: purgeRequestId(r.install_id, r.purge_at, n),
          args: { purgeAt: r.purge_at, n },
        },
        now,
        { sql: STILL_DUE, params: [r.purge_at] },
      );
      // null: an overlapping tick inserted it, a job opened meanwhile, or
      // the install is no longer due.
      if (id === null) return;
      console.log("provapi purge queued", r.install_id, id, `try=${n}`);
      // A failed start leaves it queued; the sweep starts it.
      await startJob(manage, id);
    } catch (e) {
      console.error(
        "provapi purge install_failed",
        dutyCategory(e),
        r.install_id,
      );
    }
  });
}
