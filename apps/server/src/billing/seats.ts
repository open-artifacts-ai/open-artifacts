import { BillingSeatsSchema } from "@oa/shared";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { billingActive } from "./plan.js";
import {
  BillingUnavailableError,
  billingCall,
  SEATS_PATH,
} from "./transport.js";

// MEMBER (#2580): the person a Team or Business bill counts, every month.
// A user row with role owner, admin or member, status 'active', a first
// login (last_seen_at set), and not restricted (manual or by sync). Guests,
// people invited who never signed in, suspended, removed and erased users
// never count; agents are not user rows. The instance sends the true count
// (may be 0); billing bills at least 1.

const COUNT = `select count(*) as n from users
  where role in ('owner', 'admin', 'member') and status = 'active'
    and last_seen_at is not null
    and restricted_manual = 0 and restricted_sync = 0`;

/** The install's member count now. */
export async function memberCount(env: Pick<Env, "DB">): Promise<number> {
  const r = await env.DB.prepare(COUNT).first<{ n: number }>();
  return r?.n ?? 0;
}

/** settings key: the last count billing accepted and when ({ members, at }). */
export const SEATS_SENT_KEY = "billing.seats.sent";
/** The daily reconcile resends when the last accepted report is this old. */
export const SEATS_DAILY_MS = 23 * 3_600_000;

/**
 * Signed POST /seats { members }: the count read now. Throws
 * BillingUnavailableError. Records what billing accepted (SEATS_SENT_KEY).
 */
export async function sendSeats(env: Env, now: number): Promise<number> {
  const members = await memberCount(env);
  const raw = await billingCall(env, SEATS_PATH, { members }, now);
  const r = BillingSeatsSchema.safeParse(raw);
  if (!r.success) throw new BillingUnavailableError("bad_answer");
  await env.DB.prepare(
    `insert into settings (key, value) values (?1, ?2)
     on conflict (key) do update set value = excluded.value`,
  )
    .bind(SEATS_SENT_KEY, JSON.stringify({ members, at: now }))
    .run();
  logInfo("billing_seats", { members, applied: r.data.applied });
  return members;
}

async function lastSent(
  env: Env,
): Promise<{ members: number; at: number } | null> {
  const row = await env.DB.prepare("select value from settings where key = ?1")
    .bind(SEATS_SENT_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as { members?: unknown; at?: unknown };
    return typeof v.members === "number" && typeof v.at === "number"
      ? { members: v.members, at: v.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * Reports the count when it moved since billing last accepted one (every
 * hook), or, with `daily`, also when the last accepted report is older than
 * SEATS_DAILY_MS (the scheduled tick's reconcile). Hosted only; never
 * throws: a failure is logged and the next hook or the daily tick repairs it.
 */
export async function reportSeats(
  env: Env,
  now: number,
  daily = false,
): Promise<void> {
  if (!billingActive(env)) return;
  try {
    const sent = await lastSent(env);
    if (sent && !(daily && now - sent.at >= SEATS_DAILY_MS)) {
      if ((await memberCount(env)) === sent.members) return;
    }
    await sendSeats(env, now);
  } catch (e) {
    const why = e instanceof BillingUnavailableError ? e.why : "error";
    logWarn("billing_seats_failed", undefined, { why });
  }
}

/** reportSeats in `ctx.waitUntil` (fire and forget); inline when there is no ctx. */
export function reportSeatsAfter(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
): void {
  if (!billingActive(env)) return;
  const p = reportSeats(env, Date.now());
  if (ctx) ctx.waitUntil(p);
}
