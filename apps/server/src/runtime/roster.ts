import {
  AGENT_PRESENT_MS,
  ANIMALS,
  PRESENCE_LIST_MAX,
  PRESENCE_NAME_MAX,
  PRESENCE_PALETTE_SIZE,
  type PresenceEntry,
  stripNameControls,
} from "@oa/shared";

/** Pure roster builder for viewer presence: no I/O, `now` is a parameter. */

/** What the route passes for one connecting viewer. */
export type PresenceIdentity = {
  key: string;
  kind: "person" | "anon";
  /** null for anon or nameless. */
  name: string | null;
  guest: boolean;
};

/** One per live socket or grace row. */
export type SeatRow = PresenceIdentity & { since: number };

export type AgentRow = {
  key: string;
  product: string | null;
  owner: string;
  /** `u:{id}`. Server-only: never in a viewers entry. */
  ownerActor: string;
  /** Owner-only: leaves via `labels`, never in `viewers`. */
  label: string | null;
  since: number;
  seen: number;
  lastWrite: number | null;
  activity: string | null;
};

export type Roster = {
  viewers: PresenceEntry[];
  total: number;
  /** ownerActor -> (agent key -> label), for the owner-only variants. */
  labels: Map<string, Map<string, string>>;
};

/** FNV-1a 32, shared by color and animal. Not for security. */
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

export const colorOf = (key: string): number =>
  hash(key) % PRESENCE_PALETTE_SIZE;

/** Strip controls, trim, collapse whitespace, cut to 80 code points; empty is null. */
export const cleanName = (s: string | null): string | null => {
  if (s === null) return null;
  const t = stripNameControls(s).replace(/\s+/g, " ").trim();
  const cut = [...t].slice(0, PRESENCE_NAME_MAX).join("").trim();
  return cut === "" ? null : cut;
};

/**
 * A member's name for the presence roster. Member.name falls back to the
 * email when the user has no real name (effectiveName), and an email never
 * goes to another viewer: that case is null (compared after cleaning, so
 * trailing spaces, zero-width characters and case do not hide it) (the
 * roster shows "Member"). Viewers and agent owners both use it.
 */
export const presenceName = (u: {
  name: string | null;
  email: string;
}): string | null => {
  const n = cleanName(u.name);
  return n !== null && n.toLowerCase() === u.email.toLowerCase() ? null : n;
};

const byArrival = <T extends { since: number; key: string }>(a: T, b: T) =>
  a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function buildRoster(
  seats: SeatRow[],
  agents: AgentRow[],
  now: number,
): Roster {
  // One entry per key, at the earliest arrival.
  const seatByKey = new Map<string, SeatRow>();
  for (const s of seats) {
    const prev = seatByKey.get(s.key);
    if (!prev || s.since < prev.since) seatByKey.set(s.key, s);
  }
  const ordered = [...seatByKey.values()].sort(byArrival);

  // Animals go out oldest first so earlier arrivals keep theirs. Past
  // ANIMALS.length anons a second round reuses them with " 2", " 3".
  const n = ANIMALS.length;
  const taken: Set<number>[] = [];
  const animalOf = new Map<string, { index: number; round: number }>();
  for (const s of ordered) {
    if (s.kind !== "anon") continue;
    const start = hash(s.key) % n;
    for (let round = 0; ; round++) {
      if (!taken[round]) taken[round] = new Set();
      const used = taken[round] as Set<number>;
      let found = -1;
      for (let i = 0; i < n; i++) {
        const idx = (start + i) % n;
        if (!used.has(idx)) {
          found = idx;
          break;
        }
      }
      if (found >= 0) {
        used.add(found);
        animalOf.set(s.key, { index: found, round });
        break;
      }
    }
  }

  const entries: { since: number; entry: PresenceEntry }[] = [];
  for (const s of ordered) {
    if (s.kind === "anon") {
      const a = animalOf.get(s.key);
      const animal = ANIMALS[a?.index ?? 0];
      const suffix = a && a.round > 0 ? ` ${a.round + 1}` : "";
      entries.push({
        since: s.since,
        entry: {
          key: s.key,
          kind: "anon",
          name: `Anonymous ${animal.name}${suffix}`,
          named: false,
          color: colorOf(s.key),
          animal: animal.id,
        },
      });
      continue;
    }
    const name = cleanName(s.name);
    entries.push({
      since: s.since,
      entry: {
        key: s.key,
        kind: "person",
        name: name ?? (s.guest ? "Guest" : "Member"),
        named: name !== null,
        color: colorOf(s.key),
      },
    });
  }

  const labels: Roster["labels"] = new Map();
  const present = agents.filter((a) => now - a.seen <= AGENT_PRESENT_MS);
  const nth = new Map<string, number>();
  for (const a of [...present].sort(byArrival)) {
    const product = cleanName(a.product);
    const base = product ?? "Agent";
    const count = (nth.get(base) ?? 0) + 1;
    nth.set(base, count);
    const activity = cleanName(a.activity);
    entries.push({
      since: a.since,
      entry: {
        key: a.key,
        kind: "agent",
        name: count === 1 ? base : `${base}-${count}`,
        named: product !== null,
        color: colorOf(a.key),
        agent: {
          owner: cleanName(a.owner) ?? "Member",
          ...(product !== null ? { product } : {}),
          state:
            a.lastWrite !== null && now - a.lastWrite <= AGENT_PRESENT_MS
              ? "editing"
              : "viewing",
          ...(activity !== null ? { activity } : {}),
        },
      },
    });
    const label = cleanName(a.label);
    if (label !== null) {
      const m = labels.get(a.ownerActor) ?? new Map<string, string>();
      m.set(a.key, label);
      labels.set(a.ownerActor, m);
    }
  }

  // Most recent arrival first.
  entries.sort(
    (a, b) => b.since - a.since || (a.entry.key < b.entry.key ? -1 : 1),
  );
  return {
    viewers: entries.slice(0, PRESENCE_LIST_MAX).map((e) => e.entry),
    total: entries.length,
    labels,
  };
}
