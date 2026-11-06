import { describe, expect, it } from "vitest";
import {
  ANIMALS,
  ArtifactDataGetInputSchema,
  ArtifactEventSchema,
  GetArtifactInputSchema,
  PRESENCE_ID_RE,
  PRESENCE_KEY_RE,
  PresenceEntrySchema,
} from "../src/index.js";

const LUCIDE = [
  "bird",
  "bug",
  "cat",
  "dog",
  "fish",
  "panda",
  "rabbit",
  "rat",
  "shrimp",
  "snail",
  "squirrel",
  "turtle",
  "worm",
];
const KEY = "abcdefghijklmnop";

describe("viewer presence contract", () => {
  it("ANIMALS has 50 to 70 unique ids and names", () => {
    expect(ANIMALS.length).toBeGreaterThanOrEqual(50);
    expect(ANIMALS.length).toBeLessThanOrEqual(70);
    expect(new Set(ANIMALS.map((a) => a.id)).size).toBe(ANIMALS.length);
    expect(new Set(ANIMALS.map((a) => a.name)).size).toBe(ANIMALS.length);
    for (const a of ANIMALS) {
      expect(a.name).toMatch(/^[A-Z][A-Za-z ]+$/);
      expect(a.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it("exactly the 13 Lucide animals are lucide: true", () => {
    const ids = ANIMALS.filter((a) => a.lucide)
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual([...LUCIDE].sort());
    for (const id of ["duck", "capybara", "axolotl", "llama"]) {
      expect(ANIMALS.some((a) => a.id === id && !a.lucide)).toBe(true);
    }
  });

  it("id and key patterns", () => {
    expect(PRESENCE_ID_RE.test("a".repeat(16))).toBe(true);
    expect(PRESENCE_ID_RE.test("a".repeat(15))).toBe(false);
    expect(PRESENCE_ID_RE.test("a".repeat(65))).toBe(false);
    expect(PRESENCE_ID_RE.test(`${"a".repeat(16)}!`)).toBe(false);
    expect(PRESENCE_KEY_RE.test(KEY)).toBe(true);
    expect(PRESENCE_KEY_RE.test(`${KEY}q`)).toBe(false);
  });

  it("presence frame parses through ArtifactEventSchema", () => {
    const frame = {
      type: "presence",
      total: 3,
      viewers: [
        { key: KEY, kind: "person", name: "Ada", named: true, color: 0 },
        {
          key: KEY,
          kind: "anon",
          name: "Anonymous Duck",
          named: false,
          color: 8,
          animal: "duck",
        },
        {
          key: KEY,
          kind: "agent",
          name: "Claude Code",
          named: true,
          color: 3,
          agent: {
            owner: "Ada",
            product: "Claude Code",
            state: "editing",
            activity: "reading the page",
          },
        },
      ],
    };
    expect(ArtifactEventSchema.parse(frame)).toEqual(frame);
  });

  it("presence entry has no email, id or anonId field", () => {
    expect(Object.keys(PresenceEntrySchema.shape)).toEqual([
      "key",
      "kind",
      "name",
      "named",
      "color",
      "animal",
      "agent",
    ]);
    const parsed = PresenceEntrySchema.parse({
      key: KEY,
      kind: "person",
      name: "Ada",
      named: true,
      color: 1,
      email: "a@b.c",
      anonId: "x",
    });
    expect(parsed).not.toHaveProperty("email");
    expect(parsed).not.toHaveProperty("anonId");
  });

  it("names over 80 chars are refused", () => {
    const e = {
      key: KEY,
      kind: "person",
      named: true,
      color: 0,
    };
    expect(
      PresenceEntrySchema.safeParse({ ...e, name: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      PresenceEntrySchema.safeParse({ ...e, name: "x".repeat(80) }).success,
    ).toBe(true);
  });

  it("activity over 80 is refused on the read inputs", () => {
    const base = { id: "x".repeat(16) };
    expect(
      GetArtifactInputSchema.safeParse({ ...base, activity: "x".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      GetArtifactInputSchema.safeParse({ ...base, activity: "x".repeat(80) })
        .success,
    ).toBe(true);
    expect(
      ArtifactDataGetInputSchema.safeParse({
        ...base,
        collection: "c",
        docId: "d",
        activity: "x".repeat(81),
      }).success,
    ).toBe(false);
  });

  it("an old-shape hello (no you) still parses; hello with you parses", () => {
    expect(ArtifactEventSchema.parse({ type: "hello", version: 1 })).toEqual({
      type: "hello",
      version: 1,
    });
    expect(
      ArtifactEventSchema.parse({ type: "hello", version: 1, you: KEY }),
    ).toEqual({ type: "hello", version: 1, you: KEY });
    expect(
      ArtifactEventSchema.safeParse({ type: "hello", version: 1, you: "no" })
        .success,
    ).toBe(false);
  });

  it("a gone frame with retryAfterMs still parses", () => {
    const f = { type: "gone", reason: "changed", retryAfterMs: 500 };
    expect(ArtifactEventSchema.parse(f)).toEqual(f);
  });
});
