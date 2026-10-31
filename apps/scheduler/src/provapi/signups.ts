// Signups (design v7 7 step 1, the daily cap: #859's queue path). A tree
// port of #859's apps/scheduler/src/signups.ts requeueWaiting and
// sweepStale, on the */2 tick:
// - requeue: re-sends self-serve waiting_cap rows, oldest first, up to the
//   UTC day's remaining SIGNUP_DAILY_CAP, so they are admitted after 00:00.
// - stale: re-sends a self-serve pending row untouched for SELF_SERVE_STALE_MS
//   (its message was lost).
// The job sweep never starts a job whose signup is pending or waiting_cap
// (the consumer admits it), so without this such a signup stays
// provisioning forever. Queued and creating rows are the job sweep's
// (unstarted jobs, dead runs). #859's signup alerts are not ported:
// ALERT_KEYS covers them (signup_cap, welcome_unsent, job_failed).
//
// Messages are { signupId } only. Nothing here writes a signups row; the
// provisioner's consumer does every admission. Logs carry counts only.
import { SELF_SERVE_STALE_MS } from "@oa/shared/provisioning/state";
import { signupDailyCap } from "./conditions.js";
import { ULID_RE } from "./contract.js";
import { bound, DutyFailure, d1, type ProvapiEnv } from "./env.js";
/** Rows re-sent per list per tick. */
export const SIGNUPS_LIMIT = 50;
/**
 * The SIGNUPS_ENABLED values that run the duty: #859's "true", and the
 * design's staging "test-users" (design v7 7, P29). Anything else (unset
 * included) is off. TODO(contract): C2 exports no SIGNUPS_ENABLED parser.
 */
export const SIGNUPS_ON = ["true", "test-users"] as const;

const DAY_MS = 86_400_000;
// Queues' sendBatch takes at most 100 messages.
const BATCH = 100;

// The cap counts self-serve admissions only (design v7 7), as signup_cap does.
const WAITING = `SELECT signup_id FROM signups WHERE source = 'self-serve' AND status = 'waiting_cap'
ORDER BY created_at, signup_id
LIMIT min(?3, max(0, ?1 - (SELECT count(*) FROM signups WHERE source = 'self-serve' AND admitted_at >= ?2)))`;
const STALE = `SELECT signup_id FROM signups WHERE source = 'self-serve' AND status = 'pending' AND updated_at < ?1
ORDER BY updated_at, signup_id LIMIT ?2`;

export function signupsOn(v: string | undefined): boolean {
  return (SIGNUPS_ON as readonly string[]).includes(v ?? "");
}

async function send(
  q: NonNullable<ProvapiEnv["SIGNUPS"]>,
  ids: string[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH)
    await q.sendBatch(
      ids.slice(i, i + BATCH).map((signupId) => ({ body: { signupId } })),
    );
}

const ids = (r: { results: { signup_id: unknown }[] }) =>
  r.results
    .map((x) => x.signup_id)
    .filter((s): s is string => typeof s === "string" && ULID_RE.test(s));

/** One tick: the stale pending rows, then the waiting_cap requeue. */
export async function signupsDue(env: ProvapiEnv, now: number): Promise<void> {
  if (!signupsOn(env.SIGNUPS_ENABLED)) return;
  const q = bound(env.SIGNUPS);
  const db = env.PLATFORM_DB;
  const cap = signupDailyCap(env.SIGNUP_DAILY_CAP);
  const [stale, waiting] = await d1(
    db.batch<{ signup_id: unknown }>([
      db.prepare(STALE).bind(now - SELF_SERVE_STALE_MS, SIGNUPS_LIMIT),
      db
        .prepare(WAITING)
        .bind(cap, Math.floor(now / DAY_MS) * DAY_MS, SIGNUPS_LIMIT),
    ]),
  );
  const resend = stale ? ids(stale) : [];
  // No cap configured: waiting_cap rows wait for one (as #859).
  const requeue = cap > 0 && waiting ? ids(waiting) : [];
  try {
    await send(q, [...resend, ...requeue]);
  } catch {
    throw new DutyFailure("rpc_error");
  }
  if (resend.length || requeue.length)
    console.log(
      "provapi signups",
      `stale=${resend.length}`,
      `requeued=${requeue.length}`,
    );
}
