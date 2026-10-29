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

/** The cap var; anything but a whole number defers every signup (cap 0). */
export function dailyCap(v: string | undefined): number {
  return v !== undefined && /^[0-9]{1,6}$/.test(v) ? Number(v) : 0;
}

/** Starts the signup's Workflow; an instance that already exists is success. */
async function start(env: ConsumerEnv, m: SignupMessage): Promise<void> {
  const params: ProvisionParams = {
    signupId: m.signupId,
    slug: m.slug,
    ownerSub: m.ownerSub,
  };
  try {
    await env.PROVISION_INSTALL.create({ id: m.signupId, params });
  } catch (e) {
    // create throws on an id in use; get finds that instance, or rethrows.
    try {
      await env.PROVISION_INSTALL.get(m.signupId);
    } catch {
      throw e;
    }
  }
}

// Fixed categories and the signup id only: never the body or an error's text.
const log = (signupId: string | null, outcome: string) =>
  console.log(JSON.stringify({ event: "signup", signupId, outcome }));

async function deadLetter(
  env: ConsumerEnv,
  msg: Message<unknown>,
  reason: string,
): Promise<void> {
  const signupId = signupIdOf(msg.body);
  // Our own payload, so the runtime never dead-letters the body (and email).
  await env.SIGNUPS_DLQ.send({ signupId });
  log(signupId, reason);
  msg.ack();
}

/**
 * One message: validate, record under the cap, start the Workflow when the
 * row is (still) queued or creating, then ack. A failure retries with backoff;
 * the last delivery dead-letters the id instead.
 */
export async function handleSignup(
  msg: Message<unknown>,
  env: ConsumerEnv,
  now = Date.now(),
): Promise<void> {
  const m = parseSignup(msg.body);
  if (!m) return deadLetter(env, msg, "bad_shape");
  try {
    let outcome: string = await recordSignup(
      env.PLATFORM_DB,
      m,
      dailyCap(env.SIGNUP_DAILY_CAP),
      now,
    );
    if (outcome === "exists") {
      const row = await env.PLATFORM_DB.prepare(
        "SELECT status FROM signups WHERE signup_id = ?",
      )
        .bind(m.signupId)
        .first<{ status: string }>();
      outcome = `exists_${row?.status ?? "missing"}`;
    }
    if (
      outcome === "queued" ||
      outcome === "exists_queued" ||
      outcome === "exists_creating"
    )
      await start(env, m);
    log(m.signupId, outcome);
    msg.ack();
  } catch {
    if (msg.attempts > MAX_RETRIES)
      return deadLetter(env, msg, "retries_exhausted");
    log(m.signupId, "retry");
    msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** msg.attempts) });
  }
}
