// #2762 "Later": a Needs-you item put off once. The rows hold (user, item id,
// until); the item itself is still the open ask or held request, so nothing
// here copies it. Never touches artifact_asks.

import type { Env } from "../env.js";
import { pushOn } from "./web-push.js";
import { instantAt, wall } from "./zone-time.js";

/**
 * One hour ahead, or the next 08:00 on the person's clock in `zone` (an IANA
 * name; UTC when none is known): today's if still ahead, else tomorrow's.
 */
export function laterUntil(
  which: "hour" | "morning",
  now: number,
  zone = "UTC",
): number {
  if (which === "hour") return now + 60 * 60_000;
  const w = wall(now, zone);
  const today = instantAt(zone, w.y, w.mo, w.d, 8);
  if (today > now) return today;
  // Tomorrow's date by calendar arithmetic, then its 08:00 in the zone.
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
  return instantAt(
    zone,
    t.getUTCFullYear(),
    t.getUTCMonth() + 1,
    t.getUTCDate(),
    8,
  );
}

/** "tomorrow at 8:00" or "at 14:30": when they will look, on their clock. */
export function laterWhen(until: number, now: number, zone = "UTC"): string {
  const u = wall(until, zone);
  const n = wall(now, zone);
  const clock = `${u.h}:${String(u.mi).padStart(2, "0")}`;
  const sameDay = u.y === n.y && u.mo === n.mo && u.d === n.d;
  return `${sameDay ? "" : "tomorrow "}at ${clock}${zone === "UTC" ? " UTC" : ""}`;
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
  if (pushOn(env) && r.meta.changes)
    await env.ARTIFACT_RUNTIME.getByName(`push:${userId}`).pushEvent(
      userId,
      undefined,
      until,
    );
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
       or (item_id like 'mention:%' and not exists (
          select 1 from inbox_items i
           where i.id = substr(inbox_later.item_id, 9)
             and i.user_id = inbox_later.user_id and i.read_at is null))
       or (item_id not like 'ask:%' and item_id not like 'request:%' and item_id not like 'mention:%')`,
  ).run();
  return r.meta.changes ?? 0;
}
