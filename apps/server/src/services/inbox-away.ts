// "While you were away" (#2512, design v10 screen 1): one Update row that sums
// up what arrived during the person's quiet hours, "6 updates on 3 pages since
// 22:00". Only with quiet hours set (S4's prefs): the window is the last span
// that has ended, in their time zone. Synthesized on read, like the member
// set-up lines; its read state is one settings row (awayReadKey).
import type { InboxItem } from "@oa/shared";
import type { Env } from "../env.js";
import { awayCount, awayReadKey } from "./inbox-items.js";
import { getPrefs } from "./notification-prefs.js";
import { instantAt, wall } from "./zone-time.js";

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * The last quiet-hours span that has ended by `now`, as [start, end) in ms, or
 * null with no quiet hours. A span that crosses midnight starts the day before
 * its end; one inside a day starts the same day.
 */
export function awayWindow(
  quiet: { start: string; end: string } | null,
  zone: string,
  now: number,
): { start: number; end: number } | null {
  if (!quiet) return null;
  const endM = minutes(quiet.end);
  const startM = minutes(quiet.start);
  const w = wall(now, zone);
  const at = (y: number, mo: number, d: number, m: number) =>
    instantAt(zone, y, mo, d, Math.floor(m / 60), m % 60);
  // The most recent end at or before now: today's, else yesterday's.
  let day = new Date(Date.UTC(w.y, w.mo - 1, w.d));
  let end = at(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    endM,
  );
  if (end > now) {
    day = new Date(day.getTime() - 86_400_000);
    end = at(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      endM,
    );
  }
  // Its start: the same day when the span is inside a day, else the day before.
  const startDay = startM < endM ? day : new Date(day.getTime() - 86_400_000);
  const start = at(
    startDay.getUTCFullYear(),
    startDay.getUTCMonth() + 1,
    startDay.getUTCDate(),
    startM,
  );
  return { start, end };
}

type Me = Parameters<typeof awayCount>[1];

/** The row, or null: no quiet hours, nothing unread in the window, or it was read. */
export async function awayItem(
  env: Env,
  caller: Me,
  now = Date.now(),
): Promise<InboxItem | null> {
  const prefs = await getPrefs(env, caller.user.id);
  const win = awayWindow(prefs.quietHours, prefs.timeZone, now);
  if (!win) return null;
  const read = await env.DB.prepare("select value from settings where key = ?")
    .bind(awayReadKey(caller.user.id))
    .first<{ value: string }>();
  if (read && Number(read.value) >= win.start) return null;
  const { count, pages } = await awayCount(env, caller, win.start, win.end);
  if (count === 0) return null;
  return {
    id: `away:${new Date(win.start).toISOString()}`,
    level: "update",
    kind: "away",
    away: {
      since: new Date(win.start).toISOString(),
      count,
      pages,
    },
    artifact: null,
    actor: null,
    text: "While you were away",
    href: "/",
    createdAt: new Date(win.end).toISOString(),
    readAt: null,
  };
}
