import {
  AGENT_PRESENT_MS,
  ANIMALS,
  PRESENCE_LIST_MAX,
  PRESENCE_PALETTE_SIZE,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  type AgentRow,
  buildRoster,
  cleanName,
  colorOf,
  fnv1a,
  type SeatRow,
} from "../src/runtime/roster.js";

const NOW = 1_000_000_000;
const key = (n: number) => `k${String(n).padStart(15, "0")}`;
const seat = (n: number, o: Partial<SeatRow> = {}): SeatRow => ({
  key: key(n),
  kind: "person",
  name: `Person ${n}`,
  guest: false,
  since: NOW - 10_000 + n,
  ...o,
});
const agent = (n: number, o: Partial<AgentRow> = {}): AgentRow => ({
  key: key(n),
  product: "Claude Code",
  owner: "Ada",
  ownerActor: `u:owner${n}`,
  label: null,
  since: NOW - 10_000 + n,
  seen: NOW - 1_000,
  lastWrite: null,
  activity: null,
  ...o,
});
/** Anon keys that all prefer the same animal slot. */
const clashing = (count: number): string[] => {
  const out: string[] = [];
  for (let i = 0; out.length < count; i++) {
    const k = `a${String(i).padStart(15, "0")}`;
    if (fnv1a(k) % ANIMALS.length === 0) out.push(k);
  }
  return out;
};
const anon = (k: string, since: number): SeatRow => ({
  key: k,
  kind: "anon",
  name: null,
  guest: false,
  since,
});

describe("buildRoster", () => {
  it("two seats with one key show once, at the earliest since", () => {
    // key(1) has seats at NOW-500 and NOW-9000; the agent arrived between.
    const r = buildRoster(
      [seat(1, { since: NOW - 500 }), seat(1, { since: NOW - 9_000 })],
      [agent(3, { since: NOW - 4_000 })],
      NOW,
    );
    expect(r.total).toBe(2);
    expect(r.viewers.map((v) => v.key)).toEqual([key(3), key(1)]);
  });

  it("most recent arrival first across people, anon and agents", () => {
    const r = buildRoster(
      [seat(1, { since: 100 }), anon("z".repeat(16), 300)],
      [agent(2, { since: 200, seen: NOW })],
      NOW,
    );
    expect(r.viewers.map((v) => v.kind)).toEqual(["anon", "agent", "person"]);
  });

  it('nameless person is "Member", nameless guest is "Guest", named: false', () => {
    const r = buildRoster(
      [seat(1, { name: null }), seat(2, { name: null, guest: true })],
      [],
      NOW,
    );
    const by = Object.fromEntries(r.viewers.map((v) => [v.key, v]));
    expect(by[key(1)]).toMatchObject({ name: "Member", named: false });
    expect(by[key(2)]).toMatchObject({ name: "Guest", named: false });
  });

  it("an email-shaped name appears as the placeholder, never the email", () => {
    const r = buildRoster(
      [seat(1, { name: "ada@example.com" }), seat(2, { name: null })],
      [agent(3, { owner: "bob@example.com" })],
      NOW,
    );
    const json = JSON.stringify(r);
    expect(json).not.toContain("@");
    const by = Object.fromEntries(r.viewers.map((v) => [v.key, v]));
    expect(by[key(1)]).toMatchObject({ name: "Member", named: false });
    expect(by[key(3)]?.agent?.owner).toBe("Member");
  });

  it('anon names are "Anonymous " + animal; two anons never share an animal', () => {
    const [a, b] = clashing(2) as [string, string];
    const r = buildRoster([anon(a, 100), anon(b, 200)], [], NOW);
    const names = r.viewers.map((v) => v.name);
    expect(new Set(names).size).toBe(2);
    for (const v of r.viewers) {
      expect(v.named).toBe(false);
      expect(v.name).toBe(
        `Anonymous ${ANIMALS.find((x) => x.id === v.animal)?.name}`,
      );
    }
    expect(r.viewers.find((v) => v.key === a)?.animal).toBe(ANIMALS[0]?.id);
  });

  it("animal assignment is stable for the earlier arrival when a later one joins", () => {
    const [a, b] = clashing(2) as [string, string];
    const before = buildRoster([anon(a, 100)], [], NOW);
    const after = buildRoster([anon(a, 100), anon(b, 200)], [], NOW);
    const pick = (r: typeof before, k: string) =>
      r.viewers.find((v) => v.key === k)?.animal;
    expect(pick(after, a)).toBe(pick(before, a));
  });

  it('ANIMALS.length + 1 anons: the last gets a numbered name ("Anonymous Duck 2")', () => {
    const keys = Array.from(
      { length: ANIMALS.length + 1 },
      (_, i) => `n${String(i).padStart(15, "0")}`,
    );
    const r = buildRoster(
      keys.map((k, i) => anon(k, 100 + i)),
      [],
      NOW,
    );
    const last = r.viewers[0];
    expect(last?.key).toBe(keys[keys.length - 1]);
    expect(last?.name).toMatch(/^Anonymous [A-Za-z ]+ 2$/);
    expect(new Set(r.viewers.map((v) => v.name)).size).toBe(keys.length);
  });

  it('agents: same product gets "-2", "-3" in arrival order; no product names it "Agent"', () => {
    const r = buildRoster(
      [],
      [
        agent(1, { since: 1 }),
        agent(2, { since: 2 }),
        agent(3, { since: 3 }),
        agent(4, { since: 4, product: null }),
      ],
      NOW,
    );
    const name = (n: number) => r.viewers.find((v) => v.key === key(n))?.name;
    expect(name(1)).toBe("Claude Code");
    expect(name(2)).toBe("Claude Code-2");
    expect(name(3)).toBe("Claude Code-3");
    expect(name(4)).toBe("Agent");
    expect(r.viewers.find((v) => v.key === key(4))?.named).toBe(false);
  });

  it('agent state is "editing" when lastWrite is within AGENT_PRESENT_MS, else "viewing"; stale agents are dropped', () => {
    const r = buildRoster(
      [],
      [
        agent(1, { lastWrite: NOW - AGENT_PRESENT_MS }),
        agent(2, { lastWrite: NOW - AGENT_PRESENT_MS - 1 }),
        agent(3, { lastWrite: null }),
        agent(4, { seen: NOW - AGENT_PRESENT_MS - 1 }),
      ],
      NOW,
    );
    const st = (n: number) =>
      r.viewers.find((v) => v.key === key(n))?.agent?.state;
    expect(st(1)).toBe("editing");
    expect(st(2)).toBe("viewing");
    expect(st(3)).toBe("viewing");
    expect(st(4)).toBeUndefined();
    expect(r.total).toBe(3);
  });

  it("an owner-only label is never in viewers, only in labels for the ownerActor", () => {
    const r = buildRoster(
      [],
      [agent(1, { label: "my laptop", ownerActor: "u:abc" })],
      NOW,
    );
    expect(JSON.stringify(r.viewers)).not.toContain("my laptop");
    expect(r.labels.get("u:abc")?.get(key(1))).toBe("my laptop");
    expect(r.labels.size).toBe(1);
  });

  it("agent activity and owner are cleaned and carried", () => {
    const r = buildRoster(
      [],
      [agent(1, { activity: "  reading‮  the page ", owner: "Ada" })],
      NOW,
    );
    expect(r.viewers[0]?.agent).toEqual({
      owner: "Ada",
      product: "Claude Code",
      state: "viewing",
      activity: "reading the page",
    });
  });

  it("cleanName cuts a 500-char name to 80 and strips U+202E and U+200B", () => {
    const out = cleanName(`a‮​${"b".repeat(500)}`);
    expect([...(out ?? "")].length).toBe(80);
    expect(out).not.toMatch(/[‮​]/);
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(null)).toBeNull();
  });

  it("roster over 100 is cut to 100 with total = full count", () => {
    const seats = Array.from({ length: 130 }, (_, i) => seat(i + 1));
    const r = buildRoster(seats, [], NOW);
    expect(r.viewers).toHaveLength(PRESENCE_LIST_MAX);
    expect(r.total).toBe(130);
  });

  it('JSON of the roster never contains ownerActor or "u:"', () => {
    const r = buildRoster(
      [seat(1)],
      [agent(2, { ownerActor: "u:secretowner", label: "private" })],
      NOW,
    );
    const json = JSON.stringify(r.viewers);
    expect(json).not.toContain("u:");
    expect(json).not.toContain("secretowner");
  });

  it("colorOf is stable and within the palette", () => {
    for (let i = 0; i < 50; i++) {
      const c = colorOf(key(i));
      expect(c).toBe(colorOf(key(i)));
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(PRESENCE_PALETTE_SIZE);
    }
  });
});
