// Pure roster building for viewer presence: dedupe, order, animals, colors and
// agent names. No I/O and no clock (callers pass `now`), so it is tested
// directly. Names come only through publicName/cleanName (an email-shaped name
// is never a name), and nothing here emits an email, user id or ownerActor in
// `viewers`; a token label goes only into `labels`, keyed by its owner.
import {
  AGENT_PRESENT_MS,
  ANIMALS,
  PRESENCE_LIST_MAX,
  PRESENCE_NAME_MAX,
  PRESENCE_PALETTE_SIZE,
  type PresenceEntry,
} from "@oa/shared";
import { cleanName, publicName } from "../services/agent-display.js";

export { cleanName };

/** What the route passes for a viewer (`name` null for anon or nameless). */
export type PresenceIdentity = {
  key: string;
  kind: "person" | "anon";
  name: string | null;
  guest: boolean;
};

/** One per live socket or grace row. */
export type SeatRow = PresenceIdentity & { since: number };

export type AgentRow = {
  key: string;
  product: string | null;
  owner: string;
  ownerActor: string;
  label: string | null;
  since: number;
  seen: number;
  lastWrite: number | null;
  activity: string | null;
};

/** FNV-1a, 32 bit: the one small non-crypto hash for color and animal. */
export const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** Stable color index; an agent's key is per session, so each gets its own. */
export const colorOf = (key: string): number =>
  fnv1a(key) % PRESENCE_PALETTE_SIZE;

/** A person's public name: null when absent, blank or email-shaped. */
const personName = (name: string | null): string | null => publicName({ name });

type Arrival = { key: string; since: number };
const byArrival = (a: Arrival, b: Arrival) =>
  a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Anonymous animals, oldest arrival first so earlier arrivals keep theirs:
 * preferred slot `hash % ANIMALS.length`, else the next free one; with every
 * animal taken, a second round numbered " 2", then " 3".
 */
const assignAnimals = (
  anons: Arrival[],
): Map<string, { id: string; name: string }> => {
  const rounds: Set<number>[] = [];
  const out = new Map<string, { id: string; name: string }>();
  for (const a of [...anons].sort(byArrival)) {
    let r = 0;
    while ((rounds[r]?.size ?? 0) >= ANIMALS.length) r++;
    const taken = rounds[r] ?? new Set<number>();
    rounds[r] = taken;
    let i = fnv1a(a.key) % ANIMALS.length;
    while (taken.has(i)) i = (i + 1) % ANIMALS.length;
    taken.add(i);
    const animal = ANIMALS[i];
    if (!animal) continue;
    out.set(a.key, {
      id: animal.id,
      name: r === 0 ? animal.name : `${animal.name} ${r + 1}`,
    });
  }
  return out;
};

/**
 * The roster, most recent arrival first, cut to PRESENCE_LIST_MAX with `total`
 * the full count. `labels` maps ownerActor to (agent key to private label) for
 * owner-only variants of the frame.
 */
export const buildRoster = (
  seats: SeatRow[],
  agents: AgentRow[],
  now: number,
): {
  viewers: PresenceEntry[];
  total: number;
  labels: Map<string, Map<string, string>>;
} => {
  // One face per key, at the earliest arrival.
  const first = new Map<string, SeatRow>();
  for (const s of [...seats].sort(byArrival)) {
    if (!first.has(s.key)) first.set(s.key, s);
  }
  const people = [...first.values()];
  const animals = assignAnimals(people.filter((s) => s.kind === "anon"));

  // One face per agent key, at the earliest arrival.
  const liveByKey = new Map<string, AgentRow>();
  for (const a of [...agents].sort(byArrival)) {
    if (now - a.seen <= AGENT_PRESENT_MS && !liveByKey.has(a.key)) {
      liveByKey.set(a.key, a);
    }
  }
  const live = [...liveByKey.values()];
  const labels = new Map<string, Map<string, string>>();

  const entries: { since: number; key: string; entry: PresenceEntry }[] = [];

  for (const s of people) {
    const color = colorOf(s.key);
    if (s.kind === "anon") {
      const an = animals.get(s.key);
      entries.push({
        since: s.since,
        key: s.key,
        entry: {
          key: s.key,
          kind: "anon",
          name: `Anonymous ${an?.name ?? "Guest"}`,
          named: false,
          color,
          ...(an ? { animal: an.id } : {}),
        },
      });
      continue;
    }
    const name = personName(s.name);
    entries.push({
      since: s.since,
      key: s.key,
      entry: {
        key: s.key,
        kind: "person",
        name: name ?? (s.guest ? "Guest" : "Member"),
        named: name !== null,
        color,
      },
    });
  }

  // Every name on the roster so far. An agent's "-N" suffix skips any N
  // already taken, so a client-chosen "Claude Code-2" never sits beside a
  // server-assigned one.
  const used = new Set(entries.map((e) => e.entry.name));
  for (const a of live) {
    const product = personName(a.product);
    const base = product ?? "Agent";
    let name = base;
    for (let n = 2; used.has(name); n++) {
      const suffix = `-${n}`;
      const room = PRESENCE_NAME_MAX - suffix.length;
      name = `${[...base].slice(0, room).join("").trimEnd()}${suffix}`;
    }
    used.add(name);
    const activity = cleanName(a.activity);
    entries.push({
      since: a.since,
      key: a.key,
      entry: {
        key: a.key,
        kind: "agent",
        name,
        named: product !== null,
        color: colorOf(a.key),
        agent: {
          owner: personName(a.owner) ?? "Member",
          ...(product ? { product } : {}),
          state:
            a.lastWrite !== null && now - a.lastWrite <= AGENT_PRESENT_MS
              ? "editing"
              : "viewing",
          ...(activity ? { activity } : {}),
        },
      },
    });
    const label = cleanName(a.label);
    if (label) {
      const m = labels.get(a.ownerActor) ?? new Map<string, string>();
      m.set(a.key, label);
      labels.set(a.ownerActor, m);
    }
  }

  entries.sort(
    (x, y) => y.since - x.since || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
  return {
    viewers: entries.slice(0, PRESENCE_LIST_MAX).map((e) => e.entry),
    total: entries.length,
    labels,
  };
};
