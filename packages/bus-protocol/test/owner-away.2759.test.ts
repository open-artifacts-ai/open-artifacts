import { describe, expect, it } from "vitest";
import {
  BUS_CAPS,
  OwnerAwayUntilSchema,
  ServerFrameSchema,
} from "../src/index.ts";

const hello = {
  v: 1,
  id: "h",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.3",
};

describe("owner_away (#2759)", () => {
  it("is one cap token", () => {
    expect(BUS_CAPS.ownerAway).toBe("owner_away");
  });
  it("hello_ok.owner_away_until takes an ISO UTC time, null or nothing", () => {
    for (const v of [
      "2026-11-18T07:00Z",
      "2026-11-18T07:00:00Z",
      "2026-11-18T07:00:00.123Z",
      null,
    ])
      expect(
        ServerFrameSchema.safeParse({ ...hello, owner_away_until: v }).success,
        String(v),
      ).toBe(true);
    expect(ServerFrameSchema.safeParse(hello).success).toBe(true);
  });
  it("refuses a bad time", () => {
    for (const v of [
      "",
      "tomorrow",
      "2026-11-18",
      "2026-11-18T07:00:00+02:00",
      "2026-11-18T07:00:00",
      "2026-13-45T99:00:00Z",
      "2026-11-18T07:00:00.1234567Z",
      `2026-11-18T07:00:00Z${" ".repeat(40)}`,
      1700000000000,
    ])
      expect(OwnerAwayUntilSchema.safeParse(v).success, String(v)).toBe(false);
    expect(
      ServerFrameSchema.safeParse({ ...hello, owner_away_until: "soon" })
        .success,
    ).toBe(false);
  });
  it("the owner_away push decodes strictly", () => {
    const f = { v: 1, id: "p", type: "owner_away" };
    expect(
      ServerFrameSchema.safeParse({ ...f, until: "2026-11-18T07:00:00Z" })
        .success,
    ).toBe(true);
    expect(ServerFrameSchema.safeParse({ ...f, until: null }).success).toBe(
      true,
    );
    expect(ServerFrameSchema.safeParse(f).success).toBe(false);
    expect(
      ServerFrameSchema.safeParse({ ...f, until: null, extra: 1 }).success,
    ).toBe(false);
    expect(ServerFrameSchema.safeParse({ ...hello, extra: 1 }).success).toBe(
      false,
    );
  });
});
