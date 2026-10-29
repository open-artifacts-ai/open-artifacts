// Every message ends acked or in SIGNUPS_DLQ as { signupId }, never as its
// body: the config has no runtime dead_letter_queue. An accepted signup that
// never got a row (dropped after a DLQ outage) is reconciled by the sign-up
// service (SS4), which holds the signupId it minted.
import {
  type ProvisionParams,
  parseSignup,
  type SignupMessage,
  signupIdOf,
} from "./message.js";

/** What a dead-lettered signup carries: its id only, never the email. */
export interface DlqPayload {
  signupId: string | null;
}

export interface ConsumerEnv {
  PLATFORM_DB: D1Database;
  PROVISION_INSTALL: Workflow<ProvisionParams>;
  SIGNUPS_DLQ: Queue<DlqPayload>;
  SIGNUP_DAILY_CAP: string;
}

/** wrangler.jsonc's max_retries: a message is delivered at most this + 1 times. */
export const MAX_RETRIES = 5;
const DAY_MS = 86_400_000;

/**
 * Records a signup once, settling the daily cap atomically: one batch (D1's
 * transaction) whose conditional insert sees every earlier write, so two
 * deliveries at the boundary can't both pass. The secret row is written only
 * while the signup still needs it (never again after `done` removed it).
 */
export async function recordSignup(
  db: D1Database,
  m: SignupMessage,
  cap: number,
  now: number,
): Promise<"queued" | "waiting_cap" | "exists"> {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const [queued, waiting] = await db.batch([
    db
      .prepare(
        `INSERT INTO signups (signup_id, owner_sub, slug, status, created_at, updated_at)
         SELECT ?1, ?2, ?3, 'queued', ?4, ?4
         WHERE (SELECT count(*) FROM signups WHERE created_at >= ?5 AND status != 'failed') < ?6
         ON CONFLICT (signup_id) DO NOTHING`,
      )
      .bind(m.signupId, m.ownerSub, m.slug, now, dayStart, cap),
    db
      .prepare(
        `INSERT INTO signups (signup_id, owner_sub, slug, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'waiting_cap', ?4, ?4)
         ON CONFLICT (signup_id) DO NOTHING`,
      )
      .bind(m.signupId, m.ownerSub, m.slug, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO signup_secret (signup_id, owner_email)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM signups WHERE signup_id = ?1
           AND status IN ('queued', 'waiting_cap', 'creating'))`,
      )
      .bind(m.signupId, m.ownerEmail),
  ]);
  if ((queued?.meta.changes ?? 0) > 0) return "queued";
  if ((waiting?.meta.changes ?? 0) > 0) return "waiting_cap";
  return "exists";
}

/** The cap var: 1 to 9999, or null (a config error, never a silent deferral). */
export function dailyCap(v: string | undefined): number | null {
  return v !== undefined && /^[1-9][0-9]{0,3}$/.test(v) ? Number(v) : null;
}

/** Starts the signup's Workflow; an instance that already exists is success. */
async function start(env: ConsumerEnv, params: ProvisionParams): Promise<void> {
  try {
    await env.PROVISION_INSTALL.create({ id: params.signupId, params });
  } catch (e) {
    // create throws on an id in use; get finds that instance, or rethrows.
    try {
      await env.PROVISION_INSTALL.get(params.signupId);
    } catch {
      throw e;
    }
  }
}

// Fixed categories and the signup id only: never the body or an error's text.
const log = (signupId: string | null, outcome: string) =>
  console.log(JSON.stringify({ event: "signup", signupId, outcome }));

const backoff = (msg: Message<unknown>) => ({
  delaySeconds: Math.min(300, 10 * 2 ** msg.attempts),
});

/**
 * Writes { signupId } to SIGNUPS_DLQ and acks. A failed send retries; on the
 * last delivery the message is dropped (logged by id), since the config has
 * no runtime dead_letter_queue that could receive the body.
 */
async function deadLetter(
  env: ConsumerEnv,
  msg: Message<unknown>,
  reason: string,
): Promise<void> {
  const signupId = signupIdOf(msg.body);
  try {
    await env.SIGNUPS_DLQ.send({ signupId });
  } catch {
    if (msg.attempts <= MAX_RETRIES) {
      log(signupId, "dlq_retry");
      msg.retry(backoff(msg));
    } else {
      log(signupId, "dropped");
      msg.ack();
    }
    return;
  }
  log(signupId, reason);
  msg.ack();
}

/**
 * One message: validate, record under the cap, start the Workflow when the
 * row is (still) queued or creating, then ack. A redelivery starts from the
 * stored row, and one whose slug or sub differ from it is dead-lettered. A
 * failure retries with backoff; the last delivery dead-letters the id.
 */
export async function handleSignup(
  msg: Message<unknown>,
  env: ConsumerEnv,
  now = Date.now(),
): Promise<void> {
  const m = parseSignup(msg.body);
  if (!m) return deadLetter(env, msg, "bad_shape");
  let outcome: string;
  try {
    const cap = dailyCap(env.SIGNUP_DAILY_CAP);
    if (cap === null) {
      log(m.signupId, "cap_config");
      throw new Error("SIGNUP_DAILY_CAP is not 1-9999");
    }
    outcome = await recordSignup(env.PLATFORM_DB, m, cap, now);
    let params: ProvisionParams = {
      signupId: m.signupId,
      slug: m.slug,
      ownerSub: m.ownerSub,
    };
    if (outcome === "exists") {
      const row = await env.PLATFORM_DB.prepare(
        "SELECT slug, owner_sub, status FROM signups WHERE signup_id = ?",
      )
        .bind(m.signupId)
        .first<{ slug: string; owner_sub: string; status: string }>();
      if (!row) throw new Error("signup row missing after insert");
      outcome =
        row.slug !== m.slug || row.owner_sub !== m.ownerSub
          ? "mismatch"
          : `exists_${row.status}`;
      params = {
        signupId: m.signupId,
        slug: row.slug,
        ownerSub: row.owner_sub,
      };
    }
    if (
      outcome === "queued" ||
      outcome === "exists_queued" ||
      outcome === "exists_creating"
    )
      await start(env, params);
  } catch {
    if (msg.attempts > MAX_RETRIES)
      return deadLetter(env, msg, "retries_exhausted");
    log(m.signupId, "retry");
    msg.retry(backoff(msg));
    return;
  }
  if (outcome === "mismatch") return deadLetter(env, msg, "mismatch");
  log(m.signupId, outcome);
  msg.ack();
}
