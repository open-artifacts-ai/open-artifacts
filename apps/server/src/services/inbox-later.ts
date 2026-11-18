// #2762 "Later": a Needs-you item put off once. The rows hold (user, item id,
// until); the item itself is still the open ask or held request, so nothing
// here copies it. Never touches artifact_asks.
import type { Env } from "../env.js";

/** One hour ahead, or the next 08:00 (UTC until the person's time zone is stored). */
export function laterUntil(
  which: "hour" | "morning",
  now: number,
  /** The offset of the person's zone from UTC, minutes (0: UTC). */
  offsetMin = 0,
): number {
  if (which === "hour") return now + 60 * 60_000;
  const local = new Date(now + offsetMin * 60_000);
  const next = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    8,
  );
  const at = next > local.getTime() ? next : next + 86_400_000;
  return at - offsetMin * 60_000;
}

/** The person's put-off items: item id -> until (ms). */
export async function laterRows(
  env: Env,
  userId: string,
): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "select item_id, until from inbox_later where user_id = ?",
  )
    .bind(userId)
    .all<{ item_id: string; until: number }>();
  return new Map(results.map((r) => [r.item_id, r.until]));
}

/**
 * Records the put-off. False: the item was put off before (once only), by the
 * primary key, so two taps race to one row.
 */
export async function recordLater(
  env: Env,
  userId: string,
  itemId: string,
  until: number,
  now: number,
): Promise<boolean> {
  const r = await env.DB.prepare(
    "insert or ignore into inbox_later (user_id, item_id, until, used, created_at) values (?, ?, ?, 1, ?)",
  )
    .bind(userId, itemId, until, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * The daily sweep: rows whose item is gone (the ask closed or deleted, the
 * held request gone) go. One statement.
 */
export async function sweepInboxLater(env: Env, _now: number): Promise<number> {
  const r = await env.DB.prepare(
    `delete from inbox_later where
       (item_id like 'ask:%' and not exists (
          select 1 from artifact_asks a
           where a.comment_id = substr(inbox_later.item_id, 5)
             and a.addressee = inbox_later.user_id and a.open = 1))
       or (item_id like 'request:%' and not exists (
          select 1 from held_requests h
           where h.id = substr(inbox_later.item_id, 9)
             and h.receiver_id = inbox_later.user_id))
       or (item_id not like 'ask:%' and item_id not like 'request:%')`,
  ).run();
  return r.meta.changes ?? 0;
}
