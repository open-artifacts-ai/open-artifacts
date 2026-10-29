import {
  AGENT_PRESENT_MS,
  ANIMALS,
  PRESENCE_LIST_MAX,
  PresenceEntrySchema,
  PresenceFrameSchema,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  type AgentRow,
  buildRoster,
  cleanName,
  colorOf,
  type SeatRow,
} from "../src/runtime/roster.js";

const NOW = 10_000_000;
const k = (n: number | string) => String(n).padStart(16, "k");
const seat = (
  key: string,
  since: number,
  o: Partial<SeatRow> = {},
): SeatRow => ({
  key,
  kind: "person",
  name: "Ada",
  guest: false,
  since,
  ...o,
});
const agent = (
  key: string,
  since: number,
  o: Partial<AgentRow> = {},
): AgentRow => ({
  key,
  product: "Claude Code",
  owner: "Ada",
  ownerActor: "u:secret-1",
  label: null,
  since,
  seen: NOW,
  lastWrite: null,
  activity: null,
  ...o,
});
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};
const anonKeys = (count: number, sameSlot = false) => {
  const out: string[] = [];
  const slot = fnv(k(0)) % ANIMALS.length;
  for (let i = 1; out.length < count; i++) {
    const key = k(`a${i}`);
    if (!sameSlot || fnv(key) % ANIMALS.length === slot) out.push(key);
  }
  return out;
};
const anon = (key: string, since: number): SeatRow => ({
  key,
  kind: "anon",
  name: null,
  guest: false,
  since,
});

describe("buildRoster", () => {
  it("two seats with one key show once, at the earliest since", () => {
    const r = buildRoster(
      [seat(k(1), 500), seat(k(1), 100), seat(k(2), 300)],
      [],
      NOW,
    );
    expect(r.total).toBe(2);
    expect(r.viewers.map((v) => v.key)).toEqual([k(2), k(1)]);
  });

  it("most recent arrival first across people, anon and agents", () => {
    const r = buildRoster(
      [seat(k(1), 100), anon(k(2), 300)],
      [agent(k(3), 200)],
      NOW,
    );
    expect(r.viewers.map((v) => v.key)).toEqual([k(2), k(3), k(1)]);
  });

  it('nameless person is "Member", nameless guest is "Guest", named: false', () => {
    const r = buildRoster(
      [
        seat(k(1), 1, { name: null }),
        seat(k(2), 2, { name: " ‮ ", guest: true }),
      ],
      [],
      NOW,
    );
    const by = Object.fromEntries(r.viewers.map((v) => [v.key, v]));
    expect(by[k(1)]).toMatchObject({ name: "Member", named: false });
    expect(by[k(2)]).toMatchObject({ name: "Guest", named: false });
  });

  it('anon names are "Anonymous " + animal; two anons never share an animal', () => {
    const [a, b] = anonKeys(2, true);
    const r = buildRoster([anon(a, 1), anon(b, 2)], [], NOW);
    expect(r.viewers.every((v) => v.name.startsWith("Anonymous "))).toBe(true);
    expect(new Set(r.viewers.map((v) => v.animal)).size).toBe(2);
    for (const v of r.viewers) {
      const an = ANIMALS.find((x) => x.id === v.animal);
      expect(v.name).toBe(`Anonymous ${an?.name}`);
      expect(v.named).toBe(false);
    }
  });

  it("animal assignment is stable for the earlier arrival when a later one joins", () => {
    const [a, b] = anonKeys(2, true);
    const before = buildRoster([anon(a, 1)], [], NOW).viewers[0];
    const after = buildRoster([anon(a, 1), anon(b, 2)], [], NOW).viewers.find(
      (v) => v.key === a,
    );
    expect(after?.animal).toBe(before?.animal);
  });

  it('ANIMALS.length + 1 anons: the last gets a numbered name ("Anonymous Duck 2")', () => {
    const keys = anonKeys(ANIMALS.length + 1);
    const r = buildRoster(
      keys.map((key, i) => anon(key, i + 1)),
      [],
      NOW,
    );
    expect(r.total).toBe(ANIMALS.length + 1);
    const last = r.viewers.find((v) => v.key === keys[keys.length - 1]);
    expect(last?.name).toMatch(/^Anonymous \w+ 2$/);
    expect(new Set(r.viewers.map((v) => v.name)).size).toBe(ANIMALS.length + 1);
  });

  it('agents: same product gets "-2", "-3" in arrival order; no product names it "Agent"', () => {
    const r = buildRoster(
      [],
      [
        agent(k(3), 30),
        agent(k(1), 10),
        agent(k(2), 20),
        agent(k(4), 40, { product: null }),
      ],
      NOW,
    );
    const name = (key: string) => r.viewers.find((v) => v.key === key)?.name;
    expect(name(k(1))).toBe("Claude Code");
    expect(name(k(2))).toBe("Claude Code-2");
    expect(name(k(3))).toBe("Claude Code-3");
    expect(name(k(4))).toBe("Agent");
    expect(r.viewers.find((v) => v.key === k(1))?.agent?.owner).toBe("Ada");
  });

  it("agent state is editing within AGENT_PRESENT_MS of lastWrite, else viewing; stale agents drop", () => {
    const r = buildRoster(
      [],
      [
        agent(k(1), 1, { lastWrite: NOW - AGENT_PRESENT_MS + 1 }),
        agent(k(2), 2, { lastWrite: NOW - AGENT_PRESENT_MS - 1 }),
        agent(k(3), 3, { lastWrite: null }),
        agent(k(4), 4, { seen: NOW - AGENT_PRESENT_MS - 1 }),
      ],
      NOW,
    );
    expect(r.total).toBe(3);
    const st = (key: string) =>
      r.viewers.find((v) => v.key === key)?.agent?.state;
    expect(st(k(1))).toBe("editing");
    expect(st(k(2))).toBe("viewing");
    expect(st(k(3))).toBe("viewing");
    expect(st(k(4))).toBeUndefined();
  });

  it("an owner-only label is never in viewers, only in labels for the ownerActor", () => {
    const r = buildRoster([], [agent(k(1), 1, { label: "my laptop" })], NOW);
    expect(JSON.stringify(r.viewers)).not.toContain("my laptop");
    expect(r.labels.get("u:secret-1")?.get(k(1))).toBe("my laptop");
  });

  it("roster over 100 is cut to 100 with total = full count", () => {
    const seats = Array.from({ length: 130 }, (_, i) => seat(k(i), i));
    const r = buildRoster(seats, [], NOW);
    expect(r.viewers).toHaveLength(PRESENCE_LIST_MAX);
    expect(r.total).toBe(130);
    expect(r.viewers[0]?.key).toBe(k(129));
  });

  it('JSON of the roster never contains ownerActor or "u:"', () => {
    const r = buildRoster(
      [seat(k(1), 1), anon(k(2), 2)],
      [agent(k(3), 3, { label: "x" })],
      NOW,
    );
    const json = JSON.stringify({ viewers: r.viewers, total: r.total });
    expect(json).not.toContain("u:");
    expect(json).not.toContain("secret");
    for (const v of r.viewers) PresenceEntrySchema.parse(v);
    expect(r.viewers.every((v) => v.color === colorOf(v.key))).toBe(true);
  });
});

describe("cleanName", () => {
  it("cuts a 500-char name to 80 and strips U+202E and U+200B", () => {
    const out = cleanName(`‮​${"a".repeat(500)}`);
    expect(out).toBe("a".repeat(80));
  });
  it("collapses whitespace and returns null for empty", () => {
    expect(cleanName("  a \t  b ")).toBe("a b");
    expect(cleanName("​ ")).toBeNull();
    expect(cleanName(null)).toBeNull();
  });
});

describe("length caps (UTF-16 units, as the shared schema counts)", () => {
  const emoji = "\u{1F600}"; // 2 UTF-16 units
  it("cleanName cuts 80 emoji to 40 whole ones (80 units), never half a pair", () => {
    const out = cleanName(emoji.repeat(80)) as string;
    expect(out.length).toBe(80);
    expect(out).toBe(emoji.repeat(40));
    // An odd cut point drops the high surrogate rather than split it.
    const odd = cleanName(`a${emoji.repeat(80)}`) as string;
    expect(odd).toBe(`a${emoji.repeat(39)}`);
    expect(odd.length).toBe(79);
  });

  it("80-emoji names and activity, and an 80-char product with a clash, build entries and a frame the schemas accept", () => {
    const product = "p".repeat(80);
    const r = buildRoster(
      [seat(k(1), 1, { name: emoji.repeat(80) })],
      [
        agent(k(2), 2, {
          product,
          owner: emoji.repeat(80),
          activity: emoji.repeat(80),
        }),
        agent(k(3), 3, { product, activity: `x${emoji.repeat(80)}` }),
        agent(k(4), 4, { product: emoji.repeat(80) }),
        agent(k(5), 5, { product: emoji.repeat(80) }),
      ],
      NOW,
    );
    for (const v of r.viewers) PresenceEntrySchema.parse(v);
    PresenceFrameSchema.parse({
      type: "presence",
      viewers: r.viewers,
      total: r.total,
    });
    const names = r.viewers.map((v) => v.name);
    expect(names).toContain(product);
    expect(names).toContain(`${"p".repeat(78)}-2`);
    expect(names).toContain(`${emoji.repeat(39)}-2`);
    for (const v of r.viewers) {
      expect(v.name.length).toBeLessThanOrEqual(80);
      expect(v.agent?.activity?.length ?? 0).toBeLessThanOrEqual(80);
    }
  });
});
