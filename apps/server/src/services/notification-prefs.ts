// #2512 S4: a member's notification choices (R.meNotificationPrefs): browser
// notifications for what needs them, "every ask" or only the waiting ones,
// one quiet-hours window in their time zone, and whether the lock screen shows
// details. No row is the defaults. Email stays exactly as before.
import { type NotificationPrefs, NotificationPrefsSchema } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import { takeAll } from "../email/send.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { audit, userActor } from "./audit.js";
import { instantAt, wall } from "./zone-time.js";

/** Saves one member may make per day (a person flipping switches, never a loop). */
export const PREFS_WRITES_PER_DAY = 100;

export const DEFAULT_PREFS: NotificationPrefs = {
  needsYou: { inApp: true, browser: false },
  updates: { inApp: true, browser: false },
  browserAllAsks: false,
  quietHours: null,
  timeZone: "UTC",
  lockScreenDetail: false,
};

type Row = {
  needs_you_browser: number;
  updates_browser: number;
  browser_all_asks: number;
  quiet_start: string | null;
  quiet_end: string | null;
  time_zone: string;
  lock_detail: number;
};

export async function getPrefs(
  env: Env,
  userId: string,
): Promise<NotificationPrefs> {
  const r = await stmt(
    env.DB,
    `select needs_you_browser, updates_browser, browser_all_asks, quiet_start, quiet_end, time_zone, lock_detail
       from notification_prefs where user_id = ?1`,
  )
    .bind(userId)
    .first<Row>();
  if (!r) return DEFAULT_PREFS;
  return {
    needsYou: { inApp: true, browser: r.needs_you_browser === 1 },
    updates: { inApp: true, browser: r.updates_browser === 1 },
    browserAllAsks: r.browser_all_asks === 1,
    quietHours:
      r.quiet_start && r.quiet_end
        ? { start: r.quiet_start, end: r.quiet_end }
        : null,
    timeZone: r.time_zone,
    lockScreenDetail: r.lock_detail === 1,
  };
}

const validZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Replaces the member's choices. The time zone must be a real IANA name and
 * quiet hours must span some time (start is not end). A change is audited as
 * settings.change on the member, in the same batch; an unchanged save writes
 * nothing. Rate limited per member per day.
 */
export async function putPrefs(
  env: Env,
  userId: string,
  body: unknown,
): Promise<NotificationPrefs> {
  const p = NotificationPrefsSchema.safeParse(body);
  if (!p.success)
    throw new ApiError("bad_request", "Invalid request body", p.error.issues);
  const next = p.data;
  if (!validZone(next.timeZone))
    throw new ApiError("bad_request", "Unknown time zone", {
      path: "timeZone",
      reason: "invalid",
    });
  if (next.quietHours && next.quietHours.start === next.quietHours.end)
    throw new ApiError("bad_request", "Quiet hours need a start and an end", {
      path: "quietHours",
      reason: "empty",
    });
  const before = await getPrefs(env, userId);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const diff = (k: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from, to };
  };
  diff("browser", before.needsYou.browser, next.needsYou.browser);
  diff("updatesBrowser", before.updates.browser, next.updates.browser);
  diff("browserAllAsks", before.browserAllAsks, next.browserAllAsks);
  diff("quietHours", before.quietHours, next.quietHours);
  diff("timeZone", before.timeZone, next.timeZone);
  diff("lockScreenDetail", before.lockScreenDetail, next.lockScreenDetail);
  if (Object.keys(changes).length === 0) return before;
  const day = new Date().toISOString().slice(0, 10);
  if (
    (await takeAll(env, [[`prefs:u:${userId}`, PREFS_WRITES_PER_DAY, day]])) !==
    -1
  )
    throw new ApiError(
      "rate_limited",
      "Too many changes today. Try again tomorrow.",
    );
  const now = Date.now();
  await env.DB.batch([
    stmt(
      env.DB,
      `insert into notification_prefs
         (user_id, needs_you_browser, updates_browser, browser_all_asks, quiet_start, quiet_end, time_zone, lock_detail, updated_at)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       on conflict (user_id) do update set
         needs_you_browser = excluded.needs_you_browser,
         updates_browser = excluded.updates_browser,
         browser_all_asks = excluded.browser_all_asks,
         quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
         time_zone = excluded.time_zone, lock_detail = excluded.lock_detail,
         updated_at = excluded.updated_at`,
    ).bind(
      userId,
      next.needsYou.browser ? 1 : 0,
      next.updates.browser ? 1 : 0,
      next.browserAllAsks ? 1 : 0,
      next.quietHours?.start ?? null,
      next.quietHours?.end ?? null,
      next.timeZone,
      next.lockScreenDetail ? 1 : 0,
      now,
    ),
    audit(
      env,
      "settings.change",
      { type: "user", id: userId },
      userActor(userId),
      { detail: { notificationPrefs: changes } },
    ),
  ]);
  return next;
}

const hm = (s: string): number =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** The minute of the day (0 to 1439) and the seconds into it, in `timeZone`. */
function localClock(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const n = (t: string) =>
    Number(parts.find((x) => x.type === t)?.value ?? "0");
  return { minute: n("hour") * 60 + n("minute"), second: n("second") };
}

/**
 * Whether `now` is inside the member's quiet hours and, when it is, the time
 * (ms since the epoch) they end. A window may cross midnight. Pure: the
 * caller reads the prefs.
 */
export function quietState(
  prefs: Pick<NotificationPrefs, "quietHours" | "timeZone">,
  now: number,
): { quiet: false } | { quiet: true; until: number } {
  const q = prefs.quietHours;
  if (!q) return { quiet: false };
  const s = hm(q.start);
  const e = hm(q.end);
  let clock: { minute: number; second: number };
  try {
    clock = localClock(now, prefs.timeZone);
  } catch {
    return { quiet: false };
  }
  const m = clock.minute;
  const inside = s < e ? m >= s && m < e : m >= s || m < e;
  if (!inside) return { quiet: false };
  const minutes = (e - m + 1440) % 1440 || 1440;
  return {
    quiet: true,
    until: now + minutes * 60_000 - clock.second * 1000 - (now % 1000),
  };
}

/**
 * "Away until <time>" for the member's own agents: the time quiet hours end,
 * or null outside them (or with none set). Nothing breaks through during quiet
 * hours, and their agents may say so. The bus status reads this (OA Bus).
 */
export async function awayUntil(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<number | null> {
  const s = quietState(await getPrefs(env, userId), now);
  return s.quiet ? s.until : null;
}

/**
 * The next time the quiet-hours state flips (ms): the end of the window while
 * inside it, else the next start. Null with no quiet hours or a bad zone.
 * Pure: the caller reads the prefs.
 */
export function nextQuietEdge(
  prefs: Pick<NotificationPrefs, "quietHours" | "timeZone">,
  now: number,
): number | null {
  const q = prefs.quietHours;
  if (!q) return null;
  const s = quietState(prefs, now);
  if (s.quiet) return s.until;
  try {
    const start = hm(q.start);
    const w = wall(now, prefs.timeZone);
    const today = instantAt(
      prefs.timeZone,
      w.y,
      w.mo,
      w.d,
      Math.floor(start / 60),
      start % 60,
    );
    if (today > now) return today;
    const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
    return instantAt(
      prefs.timeZone,
      t.getUTCFullYear(),
      t.getUTCMonth() + 1,
      t.getUTCDate(),
      Math.floor(start / 60),
      start % 60,
    );
  } catch {
    return null;
  }
}

/**
 * What the bus tells a person's own agents (#2759): when quiet hours end (null
 * outside them) and when that next changes (null: never, no quiet hours), from
 * one read of their prefs.
 */
export async function awayState(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<{ until: number | null; next: number | null }> {
  const prefs = await getPrefs(env, userId);
  const s = quietState(prefs, now);
  return {
    until: s.quiet ? s.until : null,
    next: nextQuietEdge(prefs, now),
  };
}
