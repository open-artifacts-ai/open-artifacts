/**
 * For you (#2512): what the bell shows and how a row reads. Pure, so the
 * rules are unit-tested apart from the UI. The server sorts and filters the
 * inbox (R.meInbox); the client never re-sorts it.
 */
import type { Inbox, InboxItem } from "@oa/shared";

export type BellState = { count: number; dot: boolean };

/** The number counts only "Needs you"; unread updates light a dot, only when there is no number. */
export function bellState(counts: Inbox["counts"]): BellState {
  const count = counts.needsYou;
  return { count, dot: count === 0 && counts.unreadUpdates > 0 };
}

/** The bell's accessible name. */
export function bellName({ count, dot }: BellState): string {
  if (count === 1) return "For you, 1 needs you";
  if (count > 1) return `For you, ${count} need you`;
  return dot ? "For you, new updates" : "For you";
}

/** The counts as the list stands (after a change made here, before the server answers). */
export const countsOf = (i: Pick<Inbox, "needsYou" | "updates">) => ({
  needsYou: i.needsYou.length,
  unreadUpdates: i.updates.filter((x) => x.readAt === null).length,
});

/** Only an item with one obvious action (a button on its row) may be put off, and only once. */
export const canLater = (x: InboxItem) =>
  x.level === "needs_you" &&
  x.kind === "machine" &&
  !x.later &&
  !x.backFromLater;

export const unread = (x: InboxItem) =>
  x.level === "update" && x.readAt === null;

/** The comment an ask item is about ("ask:<commentId>"). */
export const askComment = (x: InboxItem) =>
  x.kind === "ask" && x.id.startsWith("ask:") ? x.id.slice(4) : null;

/** How long an agent has been blocked: the server's waitingSince, never the agent's own words. */
export const waitMs = (x: InboxItem, now = Date.now()) => {
  if (x.urgency !== "waiting" || !x.waitingSince) return undefined;
  const t = Date.parse(x.waitingSince);
  return Number.isNaN(t) ? undefined : Math.max(0, now - t);
};

/**
 * The same-origin path for an item's href, or null. The contract already
 * refuses others; this re-checks before any navigation (a tab or newline is
 * stripped by URL parsers, so "/\t/evil.example" resolves off-site).
 */
export function safePath(
  href: string,
  origin = location.origin,
): string | null {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "waiting 4 min", "waiting 2 h", "waiting 1 day". */
export function waitText(ms: number): string {
  if (ms < HOUR) return `waiting ${Math.max(1, Math.floor(ms / MIN))} min`;
  if (ms < DAY) return `waiting ${Math.floor(ms / HOUR)} h`;
  const d = Math.floor(ms / DAY);
  return `waiting ${d} ${d === 1 ? "day" : "days"}`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "8:00", "22:00": the caller's clock, 24-hour, no leading zero on the hour. */
export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "just now", "20 min ago", "1 h ago", "yesterday", then "Nov 2". */
export function agoText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = Math.max(0, now - t);
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (t >= startOfDay(now) || ms < 12 * HOUR)
    return `${Math.floor(ms / HOUR)} h ago`;
  if (t >= startOfDay(now) - DAY) return "yesterday";
  return new Date(t).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
  });
}

/** "Back tomorrow at 8:00", or "Back at 15:30" later today. */
export function backText(until: string, now = Date.now()): string {
  const t = Date.parse(until);
  if (Number.isNaN(t)) return "";
  const today = startOfDay(now);
  if (t < today + DAY) return `Back at ${clock(until)}`;
  if (t < today + 2 * DAY) return `Back tomorrow at ${clock(until)}`;
  const day = new Date(t).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
  });
  return `Back ${day} at ${clock(until)}`;
}

/** "6 updates since 22:00" (the contract has no page count yet). */
export function awayText(a: NonNullable<InboxItem["away"]>): string {
  return `${a.count} ${a.count === 1 ? "update" : "updates"} since ${clock(a.since)}`;
}

/** The muted line under a row's text. A waiting ask shows its wait instead of a time. */
export function contextLine(x: InboxItem, now = Date.now()): string {
  const when = agoText(x.createdAt, now);
  const on = `on "${x.artifact.title}"`;
  switch (x.kind) {
    case "ask": {
      const who = x.actor ? `${x.actor.name} asks · ${on}` : on;
      return waitMs(x, now) !== undefined ? who : `${who} · ${when}`;
    }
    case "machine":
      return `It wants to connect agents as you · ${when}`;
    case "share":
      return `"${x.artifact.title}" · ${when}`;
    case "away":
      return x.away ? awayText(x.away) : when;
    default:
      return `${on} · ${when}`;
  }
}
