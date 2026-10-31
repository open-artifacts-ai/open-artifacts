// Purge after grace (design v7 5.8): a deleting install whose purge_at has
// passed, with no open job and not suspended, gets a purge job on
// ManageInstall. Each grace end gets PURGE_STUCK_FAILURES tries; then the
// purge_stuck alert (C2's query) asks an operator.
import {
  canTransition,
  PURGE_STUCK_FAILURES,
} from "@oa/shared/provisioning";
import { bound, d1, lanes, type ProvapiEnv } from "./env.js";
import { insertSystemJob, startJob, SYSTEM_ACTOR } from "./jobs.js";
import { dutyCategory } from "./run.js";

/** Installs looked at per tick, earliest purge_at first. */
export const PURGE_LIMIT = 20;
export const PURGE_CONCURRENCY = 3;

// Never while suspended (5.4): an operator suspended it for a reason.
const DUE =
  "SELECT install_id, signup_id, purge_at FROM install_status WHERE state = 'deleting' AND purge_at IS NOT NULL AND purge_at <= ?1 AND suspended_at IS NULL AND active_job_id IS NULL ORDER BY purge_at, install_id LIMIT ?2";
// Tries for this grace end only: a restore and a later delete start over.
const TRIES = `SELECT COUNT(*) AS n FROM jobs WHERE install_id = ?1 AND kind = 'purge' AND status = 'failed' AND actor_key = '${SYSTEM_ACTOR.key}' AND request_id LIKE ?2`;

/**
 * The idempotency key of the n-th try for one grace end. TODO(contract): no
 * purgeRequestId() is exported.
 */
export const purgeRequestId = (installId: string, purgeAt: number, n: number) =>
  `purge-${installId}-${purgeAt}-${n}`;

interface Due {
  install_id: string;
  signup_id: string | null;
  purge_at: number;
}

export async function purgeDue(env: ProvapiEnv, now: number): Promise<void> {
  // The scheduler's own transition (5.1): deleting -> purge by S.
  if (!canTransition("deleting", "purge", "S")) return;
  const db = env.PLATFORM_DB;
  const manage = bound(env.MANAGE_INSTALL);
  const { results } = await d1(
    db.prepare(DUE).bind(now, PURGE_LIMIT).all<Due>(),
  );
  await lanes(results, PURGE_CONCURRENCY, async (r) => {
    try {
      const prefix = `${purgeRequestId(r.install_id, r.purge_at, 0).slice(0, -1)}%`;
      const done = await d1(
        db.prepare(TRIES).bind(r.install_id, prefix).first<{ n: number }>(),
      );
      const n = (done?.n ?? 0) + 1;
      // The purge_stuck alert has it from here.
      if (n > PURGE_STUCK_FAILURES) return;
      const id = await insertSystemJob(
        db,
        {
          kind: "purge",
          installId: r.install_id,
          signupId: r.signup_id,
          parentJobId: null,
          requestId: purgeRequestId(r.install_id, r.purge_at, n),
        },
        now,
      );
      // null: an overlapping tick inserted it, or a job opened meanwhile.
      if (id === null) return;
      console.log("provapi purge queued", r.install_id, id, `try=${n}`);
      // A failed start leaves it queued; the sweep starts it.
      await startJob(manage, id);
    } catch (e) {
      console.error("provapi purge install_failed", dutyCategory(e), r.install_id);
    }
  });
}
