import { type BillingUsage, BillingUsageSchema } from "@oa/shared";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { billingOn } from "./plan.js";
import {
  BillingUnavailableError,
  billingCall,
  USAGE_PATH,
} from "./transport.js";

// CREATOR: the person a bill counts. A user is a creator in a UTC calendar
// month when, during it, they (signed in, by any credential: a session, a
// PAT or an OAuth grant, so an agent counts for the person who owns it):
// - publish a version (a new artifact or a new version of one: publish,
//   publish_artifact, POST versions), or
// - write live data (set, update, delete, or the owner's reset) on an
//   artifact where they are an editor, manager or owner.
// Never counted: restoring a version, moving or transferring an artifact,
// renames and setting changes, thumbnails, per-viewer storage, a viewer's
// data write (viewers are free: a poll vote), and anonymous writes.
//
// Each counts once a month: creator_months (month, user_id), insert or
// ignore. The list behind each bill stays in that table and in billing's
// usage row. Ids are users.id (opaque, per install), never an email.

/** A UTC calendar month, YYYY-MM. */
export const monthOf = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 7);

/** The month before `month` (YYYY-MM). */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const RECORD = `insert or ignore into creator_months (month, user_id, source, first_at)
  values (?1, ?2, ?3, ?4)`;

/**
 * The publish batch's creator row: inserted only once the version row
 * exists (the batch's guards may have written none). Hosted only; null
 * self-hosted.
 */
export function creatorStmt(
  env: Env,
  userId: string,
  artifactId: string,
  now: number,
): D1PreparedStatement | null {
  if (!billingOn(env)) return null;
  return env.DB.prepare(
    `insert or ignore into creator_months (month, user_id, source, first_at)
     select ?1, ?2, 'version', ?3
     where exists (select 1 from versions where artifact_id = ?4 and created_by = ?2 and created_at = ?3)`,
  ).bind(monthOf(now), userId, now, artifactId);
}

/** Already recorded in this isolate (month:user): skips the D1 write. */
const seen = new Set<string>();

/**
 * A live-data write by `userId` at editor level or above (CREATOR). Hosted
 * only. Never throws.
 */
export async function recordDataCreator(
  env: Env,
  userId: string,
  now: number,
): Promise<void> {
  if (!billingOn(env)) return;
  const month = monthOf(now);
  const key = `${month}:${userId}`;
  if (seen.has(key)) return;
  try {
    await env.DB.prepare(RECORD).bind(month, userId, "data", now).run();
    if (seen.size > 10_000) seen.clear();
    seen.add(key);
  } catch (e) {
    logWarn("billing_creator_failed", e);
  }
}

/** Test seam: forget what this isolate recorded. */
export const forgetRecordedCreators = () => seen.clear();

/** The month's creators (opaque user ids), sorted. */
export async function creatorsOf(env: Env, month: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "select user_id as id from creator_months where month = ?1 order by user_id",
  )
    .bind(month)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** The month's creator count. */
export async function creatorCount(env: Env, month: string): Promise<number> {
  const r = await env.DB.prepare(
    "select count(*) as n from creator_months where month = ?1",
  )
    .bind(month)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** settings key: the last month whose final report billing accepted. */
export const USAGE_SENT_KEY = "billing.usage.sent";

/**
 * Signed POST /usage { install, month, creators, count, ts } for `month`.
 * Billing keeps the list (its usage row). Throws BillingUnavailableError.
 */
export async function sendUsage(
  env: Env,
  month: string,
  now: number,
): Promise<BillingUsage> {
  const creators = await creatorsOf(env, month);
  const raw = await billingCall(
    env,
    USAGE_PATH,
    { month, creators, count: creators.length },
    now,
  );
  const r = BillingUsageSchema.safeParse(raw);
  if (!r.success || r.data.month !== month)
    throw new BillingUnavailableError("bad_answer");
  logInfo("billing_usage", { month, count: r.data.count });
  return r.data;
}

/**
 * The scheduler tick's monthly report: once a month, the previous month's
 * final list, until billing accepts it (then USAGE_SENT_KEY). Never throws.
 */
export async function usageTick(env: Env, now: number): Promise<void> {
  if (!billingOn(env)) return;
  const prev = previousMonth(monthOf(now));
  try {
    const sent = await env.DB.prepare(
      "select value from settings where key = ?1",
    )
      .bind(USAGE_SENT_KEY)
      .first<{ value: string }>();
    if (sent && sent.value >= prev) return;
    await sendUsage(env, prev, now);
    await env.DB.prepare(
      `insert into settings (key, value) values (?1, ?2)
       on conflict (key) do update set value = excluded.value where settings.value < excluded.value`,
    )
      .bind(USAGE_SENT_KEY, prev)
      .run();
  } catch (e) {
    const why = e instanceof BillingUnavailableError ? e.why : "error";
    logWarn("billing_usage_failed", undefined, { why });
  }
}
