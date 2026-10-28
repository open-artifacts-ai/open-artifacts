import { describe, expect, it } from "vitest";
import {
  ANIMALS,
  ArtifactEventSchema,
  GetArtifactInputSchema,
  PresenceEntrySchema,
} from "../src/index.js";

const person = {
  key: "aaaaaaaaaaaaaaaa",
  kind: "person",
  name: "Ada",
  named: true,
  color: 0,
} as const;

describe("viewer presence contract", () => {
  it("ANIMALS has 50 to 70 unique ids and names", () => {
    expect(new Set(ANIMALS.map((a) => a.id)).size).toBe(ANIMALS.length);
    expect(new Set(ANIMALS.map((a) => a.name)).size).toBe(ANIMALS.length);
    expect(ANIMALS.length).toBeGreaterThanOrEqual(50);
    expect(ANIMALS.length).toBeLessThanOrEqual(70);
    for (const a of ANIMALS) expect(a.name).toMatch(/^[A-Z][A-Za-z ]+$/);
  });

  it("exactly the 13 Lucide animals are lucide: true", () => {
    expect(
      ANIMALS.filter((a) => a.lucide)
        .map((a) => a.id)
        .sort(),
    ).toEqual(
      [
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
      ].sort(),
    );
  });

  it("presence frame parses through ArtifactEventSchema", () => {
    const frame = {
      type: "presence",
      total: 3,
      viewers: [
        person,
        {
          key: "bbbbbbbbbbbbbbbb",
          kind: "anon",
          name: "Anonymous Duck",
          named: false,
          color: 3,
          animal: "duck",
        },
        {
          key: "cccccccccccccccc",
          kind: "agent",
          name: "Claude",
          named: true,
          color: 8,
          agent: {
            owner: "Ada",
            product: "Claude",
            state: "editing",
            activity: "fixing a typo",
          },
        },
      ],
    };
    expect(ArtifactEventSchema.parse(frame)).toEqual(frame);
  });

  it("presence entry has no email, id or anonId field", () => {
    const parsed = PresenceEntrySchema.parse({
      ...person,
      email: "a@b.c",
      anonId: "x",
      id: "u1",
    });
    expect(parsed).toEqual(person);
    expect(Object.keys(PresenceEntrySchema.shape)).toEqual([
      "key",
      "kind",
      "name",
      "named",
      "color",
      "animal",
      "agent",
    ]);
  });

  it("names over 80 chars are refused", () => {
    expect(
      PresenceEntrySchema.safeParse({ ...person, name: "x".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      PresenceEntrySchema.safeParse({ ...person, name: "x".repeat(80) })
        .success,
    ).toBe(true);
  });

  it("activity over 80 is refused on GetArtifactInputSchema", () => {
    const base = { id: "abcdefghijkmnpqr" };
    expect(
      GetArtifactInputSchema.safeParse({ ...base, activity: "x".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      GetArtifactInputSchema.safeParse({ ...base, activity: "x".repeat(80) })
        .success,
    ).toBe(true);
  });

  it("an old-shape hello (no you) still parses", () => {
    expect(ArtifactEventSchema.parse({ type: "hello", version: 2 })).toEqual({
      type: "hello",
      version: 2,
    });
    expect(
      ArtifactEventSchema.parse({
        type: "hello",
        version: 2,
        you: "aaaaaaaaaaaaaaaa",
      }),
    ).toMatchObject({ you: "aaaaaaaaaaaaaaaa" });
  });

  it("a gone frame with retryAfterMs still parses", () => {
    const f = { type: "gone", reason: "changed", retryAfterMs: 1500 };
    expect(ArtifactEventSchema.parse(f)).toEqual(f);
  });
});
