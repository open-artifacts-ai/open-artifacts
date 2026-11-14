/**
 * For you (#2512): what the bell counts and how the list is ordered. Pure, so
 * the rules are unit-tested apart from the UI. Shapes are PROVISIONAL until
 * OA Backend's contract lands (see @oa/shared for-you.ts).
 */
import type { ForYouAway, ForYouItem, Role } from "@oa/shared";

/** Billing is for owners and admins only, as the Plan page is. */
const forRole = (x: ForYouItem, role: Role | undefined) =>
  !(x.kind === "billing" || x.audience === "admins") ||
  role === "owner" ||
  role === "admin";

/** The items this caller may see. */
export const visibleItems = (
  items: readonly ForYouItem[],
  role: Role | undefined,
): ForYouItem[] => items.filter((x) => forRole(x, role));

const snoozedNow = (x: ForYouItem) => x.later?.state === "snoozed";

/** "Needs you", in order: back from Later first, then the longest wait, then newest. */
export function needsYou(items: readonly ForYouItem[]): ForYouItem[] {
  return items
    .filter((x) => x.level === "needs" && !snoozedNow(x))
    .sort(
      (a, b) =>
        Number(b.later?.state === "returned") -
          Number(a.later?.state === "returned") ||
        (b.waitingMs ?? -1) - (a.waitingMs ?? -1) ||
        Date.parse(b.at) - Date.parse(a.at),
    );
}

/** Put off with Later, soonest back first. */
export function laterItems(items: readonly ForYouItem[]): ForYouItem[] {
  const until = (x: ForYouItem) =>
    x.later?.state === "snoozed" ? Date.parse(x.later.until) : 0;
  return items
    .filter((x) => x.level === "needs" && snoozedNow(x))
    .sort((a, b) => until(a) - until(b));
}

/** Updates, newest first; those folded into "While you were away" stay out until shown. */
export function updates(
  items: readonly ForYouItem[],
  away: ForYouAway | null | undefined,
  showAway: boolean,
): ForYouItem[] {
  const folded = new Set(showAway ? [] : (away?.ids ?? []));
  return items
    .filter((x) => x.level === "update" && !folded.has(x.id))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Only an item with one obvious action (a button on its row) may be put off. */
export const canLater = (x: ForYouItem) =>
  x.level === "needs" && !!x.action && !x.later;

export type BellState = { count: number; dot: boolean };

/** The number counts only "Needs you"; updates never add to it, they light a dot (when there is no number). */
export function bellState(items: readonly ForYouItem[]): BellState {
  const count = needsYou(items).length;
  const dot = count === 0 && items.some((x) => x.level === "update" && !x.read);
  return { count, dot };
}

/** The bell's accessible name. */
export function bellName({ count, dot }: BellState): string {
  if (count === 1) return "For you, 1 needs you";
  if (count > 1) return `For you, ${count} need you`;
  return dot ? "For you, new updates" : "For you";
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "waiting 4 min", "waiting 2 h", "waiting 1 day": the server's duration, never the agent's claim. */
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

/** "6 updates on 3 pages since 22:00". */
export function awayText(a: ForYouAway): string {
  const u = `${a.updates} ${a.updates === 1 ? "update" : "updates"}`;
  const p = `${a.pages} ${a.pages === 1 ? "page" : "pages"}`;
  return `${u} on ${p} since ${clock(a.since)}`;
}

/** The muted line: the server's words, then how long ago (a waiting ask shows its wait instead). */
export const contextLine = (x: ForYouItem, now = Date.now()) =>
  x.waitingMs !== undefined
    ? x.context
    : `${x.context} · ${agoText(x.at, now)}`;

/** Where Later puts an item, as the client guesses it until the server answers. */
export function laterUntil(when: "hour" | "morning", now = Date.now()): string {
  if (when === "hour") return new Date(now + HOUR).toISOString();
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}
