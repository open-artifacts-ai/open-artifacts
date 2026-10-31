// The signups consumer (self-serve, design v7 7). A message is { signupId }
// only: the API has already written the row (pending), its signup_secret and
// its create job. The consumer admits the row under the daily cap, starts the
// row's job (instance id = job id, params { jobId }), and never reads or
// writes the email.
import type { WorkflowParams } from "@oa/shared/provisioning";
import { parseSignup, signupIdOf } from "./message.js";

export interface ConsumerEnv {
  PLATFORM_DB: D1Database;
  PROVISION_INSTALL: Workflow<WorkflowParams>;
  SIGNUP_DAILY_CAP: string;
  /**
   * "true" admits signups, and so does "test-users" on staging (the API let
   * only test users through); anything else acks each one, row left pending.
   */
  SIGNUPS_ENABLED: string;
  OA_ENV: string;
}

const DAY_MS = 86_400_000;

export type Admission =
  | "queued"
  | "waiting_cap"
  | "missing"
  | "running"
  | "settled";

/**
 * Admits a signup once. A pending or waiting_cap row moves to queued (with
 * admitted_at) only while fewer than `cap` self-serve rows were admitted this
 * UTC day (admin rows never count), else to waiting_cap: one batch (D1's transaction), so two deliveries at the
 * boundary can't both pass.
 */
export async function admit(
  db: D1Database,
  signupId: string,
  cap: number,
  now: number,
): Promise<Admission> {
  const row = await db
    .prepare("SELECT status FROM signups WHERE signup_id = ?")
    .bind(signupId)
    .first<{ status: string }>();
  if (!row) return "missing";
  switch (row.status) {
    case "queued":
    case "creating":
      return "running";
    case "ready":
    case "failed":
      return "settled";
    case "pending":
    case "waiting_cap":
      break;
    default:
      throw new Error("signups row has an unknown status");
  }
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const [queued, waiting] = await db.batch([
    db
      .prepare(
        `UPDATE signups SET status = 'queued', admitted_at = ?1, updated_at = ?1
         WHERE signup_id = ?2 AND status IN ('pending', 'waiting_cap')
           AND (SELECT count(*) FROM signups
                WHERE source = 'self-serve' AND admitted_at >= ?3) < ?4`,
      )
      .bind(now, signupId, dayStart, cap),
    db
      .prepare(
        `UPDATE signups SET status = 'waiting_cap', updated_at = ?1
         WHERE signup_id = ?2 AND status IN ('pending', 'waiting_cap')`,
      )
      .bind(now, signupId),
  ]);
  if ((queued?.meta.changes ?? 0) > 0) return "queued";
  if ((waiting?.meta.changes ?? 0) > 0) return "waiting_cap";
  // Another delivery moved it between the read and the batch.
  return admit(db, signupId, cap, now);
}

/** The cap var: 1 to 9999, or null (a config error, never a silent deferral). */
export function dailyCap(v: string | undefined): number | null {
  return v !== undefined && /^[1-9][0-9]{0,3}$/.test(v) ? Number(v) : null;
}

/** Whether SIGNUPS_ENABLED admits signups in this env. */
export function signupsOpen(env: ConsumerEnv): boolean {
  return (
    env.SIGNUPS_ENABLED === "true" ||
    (env.SIGNUPS_ENABLED === "test-users" && env.OA_ENV === "staging")
  );
}

/** Starts the row's job; an instance that already exists is success. */
async function start(env: ConsumerEnv, signupId: string): Promise<void> {
  const row = await env.PLATFORM_DB.prepare(
    "SELECT job_id FROM signups WHERE signup_id = ?",
  )
    .bind(signupId)
    .first<{ job_id: string }>();
  if (!row) throw new Error("signups row vanished");
  const jobId = row.job_id;
  const params: WorkflowParams = { jobId };
  try {
    await env.PROVISION_INSTALL.create({ id: jobId, params });
  } catch (e) {
    // create throws on an id in use; get finds that instance, or rethrows.
    try {
      await env.PROVISION_INSTALL.get(jobId);
    } catch {
      throw e;
    }
  }
}

// Fixed categories and the signup id only: never an error's text.
const log = (signupId: string | null, outcome: string) =>
  console.log(JSON.stringify({ event: "signup", signupId, outcome }));

const backoff = (msg: Message<unknown>) => ({
  delaySeconds: Math.min(300, 10 * 2 ** msg.attempts),
});

/**
 * One message: a bad shape is acked, and so is every message while signups
 * are closed (signupsOpen; the row stays pending, the scheduler's sweep
 * re-sends it once open). Otherwise admit, start the Workflow
 * when the row is queued or running, then ack. A missing row, a bad cap or a
 * D1 or Workflows error retries; after max_retries the runtime DLQ takes the
 * message, which holds the id only.
 */
export async function handleSignup(
  msg: Message<unknown>,
  env: ConsumerEnv,
  now = Date.now(),
): Promise<void> {
  const m = parseSignup(msg.body);
  if (!m) {
    log(signupIdOf(msg.body), "bad_shape");
    msg.ack();
    return;
  }
  if (!signupsOpen(env)) {
    log(m.signupId, "disabled");
    msg.ack();
    return;
  }
  const cap = dailyCap(env.SIGNUP_DAILY_CAP);
  if (cap === null) {
    log(m.signupId, "cap_config");
    msg.retry(backoff(msg));
    return;
  }
  let outcome: Admission;
  try {
    outcome = await admit(env.PLATFORM_DB, m.signupId, cap, now);
    if (outcome === "queued" || outcome === "running")
      await start(env, m.signupId);
  } catch {
    log(m.signupId, "retry");
    msg.retry(backoff(msg));
    return;
  }
  log(m.signupId, outcome);
  if (outcome === "missing") msg.retry(backoff(msg));
  else msg.ack();
}
