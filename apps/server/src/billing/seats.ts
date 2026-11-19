import { BillingSeatsSchema } from "@oa/shared";
import { sendEmail } from "../email/send.js";
import { seatJumpEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { getSettings } from "../services/members.js";
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
  let raw: unknown;
  try {
    raw = await billingCall(env, SEATS_PATH, { members }, now);
  } catch (e) {
    // Billing from before #2580 has no /seats (404) or refuses it (400
    // bad_body): settled, never retried soon; logged once a day at most.
    if (
      !(e instanceof BillingUnavailableError) ||
      !(e.why === "http_404" || (e.why === "http_400" && e.code === "bad_body"))
    )
      throw e;
    const prev = await lastSent(env);
    if (!prev || now - prev.at >= SEATS_DAILY_MS)
      logWarn("billing_seats_unsupported", undefined, { why: e.why });
    await saveSent(env, members, now, true);
    return members;
  }
  const r = BillingSeatsSchema.safeParse(raw);
  if (!r.success) throw new BillingUnavailableError("bad_answer");
  await saveSent(env, members, now, r.data.retry !== true);
  logInfo("billing_seats", { members, applied: r.data.applied });
  if (r.data.jump) await notifyJump(env, r.data.jump, now);
  return members;
}

/**
 * #2588: billing billed a big member jump at once; tell the owner(s) (Product's
 * copy, seatJumpEmail). Once per jump: a settings row keyed on the new count
 * and the UTC day is claimed before the send, and released again when nothing
 * went out so a later report may retry. Best effort: never throws, so the
 * report never fails on it.
 */
async function notifyJump(
  env: Env,
  jump: { from: number; to: number },
  now: number,
): Promise<void> {
  const key = `billing.seats.jump:${jump.to}:${new Date(now).toISOString().slice(0, 10)}`;
  let claimed = false;
  try {
    const claim = await env.DB.prepare(
      "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
    )
      .bind(key, JSON.stringify({ from: jump.from, to: jump.to, at: now }))
      .run();
    if ((claim.meta.changes ?? 0) === 0) return;
    claimed = true;
    const { results } = await env.DB.prepare(
      "select id, email from users where role = 'owner' and status = 'active' order by created_at, id limit 5",
    ).all<{ id: string; email: string }>();
    const instance = (await getSettings(env)).name;
    let sent = false;
    for (const o of results)
      sent =
        (await sendEmail(
          env,
          o.id,
          o.email,
          () =>
            seatJumpEmail({
              instance,
              recipient: o.email,
              appHost: env.APP_HOST,
              from: jump.from,
              to: jump.to,
            }),
          { kind: "seat_jump", instance, now },
        )) || sent;
    if (!sent) {
      await env.DB.prepare("delete from settings where key = ?1")
        .bind(key)
        .run();
      claimed = false;
    }
  } catch (e) {
    logWarn("billing_seat_jump_email_failed", e);
    if (claimed)
      await env.DB.prepare("delete from settings where key = ?1")
        .bind(key)
        .run()
        .catch(() => undefined);
  }
}

async function saveSent(
  env: Env,
  members: number,
  at: number,
  ok: boolean,
): Promise<void> {
  await env.DB.prepare(
    `insert into settings (key, value) values (?1, ?2)
     on conflict (key) do update set value = excluded.value`,
  )
    .bind(SEATS_SENT_KEY, JSON.stringify({ members, at, ok }))
    .run();
}

async function lastSent(
  env: Env,
): Promise<{ members: number; at: number; ok: boolean } | null> {
  const row = await env.DB.prepare("select value from settings where key = ?1")
    .bind(SEATS_SENT_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as {
      members?: unknown;
      at?: unknown;
      ok?: unknown;
    };
    return typeof v.members === "number" && typeof v.at === "number"
      ? { members: v.members, at: v.at, ok: v.ok !== false }
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
    if (sent?.ok && !(daily && now - sent.at >= SEATS_DAILY_MS)) {
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

/**
 * The routes (ROUTE_POLICY keys) after which the member count is re-checked:
 * everything that changes a user's role, status, restriction, existence or
 * first login. test/billing-seats.test.ts fails when a user-mutating members
 * or directory route is neither here nor in SEAT_ROUTES_EXEMPT.
 */
export const SEAT_ROUTES: ReadonlySet<string> = new Set([
  // Sign-in (first login) and the OAuth consent step.
  "GET /auth/callback",
  "GET /auth/callback/google",
  "POST /auth/code/verify",
  "GET /api/v1/directory/callback",
  "POST /oauth/authorize",
  // Members: invite, role, remove, restore, erase, identity reset, restrict.
  "POST /api/v1/members",
  "PATCH /api/v1/members/:id",
  "DELETE /api/v1/members/:id",
  "POST /api/v1/members/:id/restore",
  "POST /api/v1/members/:id/erase",
  "POST /api/v1/members/:id/transfer",
  "DELETE /api/v1/members/:id/identities/google",
  "PUT /api/v1/members/:id/restricted",
  "DELETE /api/v1/members/:id/restricted",
  // Directory: groups mapped to roles, restricted groups, sync, connect.
  "PUT /api/v1/directory/org-mappings/:groupId",
  "DELETE /api/v1/directory/org-mappings/:groupId",
  "PUT /api/v1/directory/restricted-groups/:groupId",
  "DELETE /api/v1/directory/restricted-groups/:groupId",
  "POST /api/v1/directory/confirm",
  "POST /api/v1/directory/sync",
  "POST /api/v1/directory/held/:groupId/confirm",
  "POST /api/v1/directory/held/:groupId/snooze",
  "DELETE /api/v1/directory/held/:groupId/snooze",
  "POST /api/v1/directory/disconnect",
  "DELETE /api/v1/directory",
]);

/** Member and directory writes that cannot move the count (the guard test). */
export const SEAT_ROUTES_EXEMPT: ReadonlySet<string> = new Set([
  "POST /api/v1/directory/cancel",
]);
