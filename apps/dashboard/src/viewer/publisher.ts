/**
 * #2610 part 1: who published the version on screen, in OA Product's words.
 * Pure, so the rules (who sees the agent, how the line shortens) are tested
 * apart from the title bar.
 */
import type { AgentRef, UserRef } from "@oa/shared";
import { personFirst, personName } from "../layout/person";
import { relativeTime } from "../library/time";

export type Publisher = {
  /** The agent, for a member; null for a person-published page, a guest or a signed-out visitor. */
  agent: AgentRef | null;
  person: UserRef;
  /** The person is the viewer: "your agent". */
  mine: boolean;
  version: number;
  /** The version on screen is the current one. */
  current: boolean;
  createdAt: string;
};

/**
 * The publisher as the viewer may see it. Guests and signed-out visitors see
 * the person only: never the agent's name or picture, whatever the server sent.
 */
export function publisherFor(
  info: {
    agent: AgentRef | null;
    createdBy: UserRef;
    version: number;
    createdAt: string;
  },
  viewer: { outsider: boolean; meId: string | null },
  currentVersion: number,
): Publisher {
  return {
    agent: viewer.outsider ? null : info.agent,
    person: info.createdBy,
    mine: viewer.meId !== null && viewer.meId === info.createdBy.id,
    version: info.version,
    current: info.version === currentVersion,
    createdAt: info.createdAt,
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "20 min ago", "2 h ago", "yesterday", then "3 Nov". */
export function shortAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = Math.max(0, now - t);
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  if (ms < 2 * DAY) return "yesterday";
  return shortDate(iso);
}

/** "3 Nov". */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** "Leo's agent", or "your agent". */
const whoseShort = (p: Publisher) =>
  p.mine ? "your agent" : `${personFirst(p.person)}'s agent`;
/** "Leo Urbina's agent", or "your agent". */
const whoseLong = (p: Publisher) =>
  p.mine ? "your agent" : `${personName(p.person)}'s agent`;

/** The line's name: the agent, or the person who published. */
export const publisherName = (p: Publisher) =>
  p.agent ? p.agent.name : personName(p.person);

/**
 * The parts beside the title, in the order they drop as the row tightens:
 * the time (or, on an older version, "v9 · 3 Nov") first, then "Leo's
 * agent", then the name. Stage 3 is the picture only.
 */
export function lineParts(
  p: Publisher,
  stage: 0 | 1 | 2 | 3,
  now = Date.now(),
): string[] {
  if (stage >= 3) return [];
  const when = p.current
    ? shortAgo(p.createdAt, now)
    : `v${p.version} · ${shortDate(p.createdAt)}`;
  const parts = [publisherName(p)];
  if (p.agent && stage < 2) parts.push(whoseShort(p));
  if (stage < 1) parts.push(when);
  return parts;
}

/** The accessible name and tooltip: always the full line. */
export function fullLine(p: Publisher, now = Date.now()): string {
  const when = relativeTime(p.createdAt, now);
  return p.agent
    ? `Published by ${p.agent.name}, ${whoseShort(p)}, ${when}`
    : `Published by ${personName(p.person)}, ${when}`;
}

/** The sheet's two lines: "Published by OA Design" and "Leo Urbina's agent · 2 hours ago · version 12". */
export function sheetLines(p: Publisher, now = Date.now()): [string, string] {
  const when = relativeTime(p.createdAt, now);
  const tail = `${when} · version ${p.version}`;
  return p.agent
    ? [`Published by ${p.agent.name}`, `${whoseLong(p)} · ${tail}`]
    : [`Published by ${personName(p.person)}`, tail];
}
