import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PinBadgeSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  badgeFor,
  draftBadge,
  PRESENCE_HEX,
} from "../src/viewer/comments/pinBadge";

const person = (name: string) => ({ kind: "user", name, me: false }) as const;

describe("pin badges (#2019)", () => {
  it("a person is their initials, named for the button", () => {
    expect(badgeFor(person("Ada Lovelace"))).toEqual({
      initials: "AL",
      label: "Comment by Ada Lovelace",
    });
  });

  it("an unlinked agent is the dashed robot, never initials like a person", () => {
    const b = badgeFor({ kind: "agent", name: "Some Bot", me: false } as never);
    expect(b).toMatchObject({ dashed: true, label: "Comment by Some Bot" });
    expect("initials" in b).toBe(false);
    expect(PinBadgeSchema.safeParse(b).success).toBe(true);
  });

  it("a guest or capped viewer gets no animal even if one slipped through (#2004)", () => {
    const linked = {
      kind: "agent",
      name: "Ada's agent",
      linked: true,
      animal: { id: "duck", color: 1 },
      me: false,
    } as never;
    expect(badgeFor(linked, true)).toMatchObject({ dashed: true });
    expect(badgeFor(linked, false)).not.toHaveProperty("dashed");
  });

  it("a linked agent is its animal in its palette colour, and fits the frame's schema", () => {
    for (const id of ["duck", "cat", "raccoon", "not-an-animal"]) {
      const b = badgeFor({
        kind: "agent",
        name: "Claude Code",
        linked: true,
        animal: { id, color: 11 },
        me: false,
      } as never);
      expect(PinBadgeSchema.safeParse(b).success).toBe(true);
      expect(b).toMatchObject({ color: PRESENCE_HEX[2] });
      expect("icon" in b && b.icon).toBeTruthy();
    }
  });

  it("the ghost's initials are the typed name's", () => {
    expect(draftBadge("leo urbina")).toEqual({ initials: "LU" });
    expect(draftBadge("")).toEqual({ initials: "?" });
  });

  it("the palette matches viewer.css", () => {
    const css = readFileSync(
      join(process.cwd(), "src/viewer/viewer.css"),
      "utf8",
    );
    PRESENCE_HEX.forEach((hex, i) => {
      expect(css).toContain(`--oa-presence-${i}: ${hex};`);
    });
  });
});

describe("the frame schema (#2019)", () => {
  it("refuses a badge with extra keys or an oversized icon", () => {
    expect(
      PinBadgeSchema.safeParse({ initials: "A", name: "Ada" }).success,
    ).toBe(false);
    expect(
      PinBadgeSchema.safeParse({ icon: "x".repeat(6001), color: "#000000" })
        .success,
    ).toBe(false);
    expect(
      PinBadgeSchema.safeParse({ icon: "<path/>", color: "red" }).success,
    ).toBe(false);
  });
});
