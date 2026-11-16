// #2610 part 1: who published the version on screen, in OA Product's words.
import { describe, expect, it } from "vitest";
import {
  fullLine,
  lineParts,
  publisherFor,
  sheetLines,
  shortAgo,
} from "../src/viewer/publisher";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const agent = {
  name: "OA Design",
  version: null,
  linked: true,
  animal: { id: "fox", color: 1 },
};
const leo = { id: "u-leo", email: "leo@example.com", name: "Leo Urbina" };
const maya = { id: "u-maya", email: "maya@example.com", name: "Maya Chen" };
const member = { outsider: false, meId: "u-ada" };

describe("who sees what", () => {
  const info = { agent, createdBy: leo, version: 12, createdAt: ago(2) };
  it("a member sees the agent and the person", () => {
    const p = publisherFor(info, member, 12);
    expect(p.agent?.name).toBe("OA Design");
    expect(fullLine(p, NOW)).toBe(
      "Published by OA Design, Leo's agent, 2 hours ago",
    );
  });
  it("a guest or a signed-out visitor sees the person only, whatever the server sent", () => {
    for (const outsider of [
      { outsider: true, meId: "u-g" },
      { outsider: true, meId: null },
    ]) {
      const p = publisherFor(info, outsider, 12);
      expect(p.agent).toBeNull();
      expect(fullLine(p, NOW)).toBe("Published by Leo Urbina, 2 hours ago");
      expect(lineParts(p, 0, NOW).join(" · ")).not.toContain("OA Design");
    }
  });
  it("your own agent", () => {
    const p = publisherFor(info, { outsider: false, meId: "u-leo" }, 12);
    expect(lineParts(p, 0, NOW)).toEqual([
      "OA Design",
      "your agent",
      "2 h ago",
    ]);
    expect(sheetLines(p, NOW)[1]).toBe("your agent · 2 hours ago · version 12");
  });
});

describe("the line beside the title", () => {
  const p = publisherFor(
    { agent, createdBy: leo, version: 12, createdAt: ago(2) },
    member,
    12,
  );
  it("drops the time, then whose agent, then the name", () => {
    expect(lineParts(p, 0, NOW)).toEqual([
      "OA Design",
      "Leo's agent",
      "2 h ago",
    ]);
    expect(lineParts(p, 1, NOW)).toEqual(["OA Design", "Leo's agent"]);
    expect(lineParts(p, 2, NOW)).toEqual(["OA Design"]);
    expect(lineParts(p, 3, NOW)).toEqual([]);
  });
  it("the full line stays the name at every stage", () => {
    expect(fullLine(p, NOW)).toBe(
      "Published by OA Design, Leo's agent, 2 hours ago",
    );
  });
  it("a page a person published: their name", () => {
    const q = publisherFor(
      { agent: null, createdBy: maya, version: 3, createdAt: ago(2) },
      member,
      3,
    );
    expect(lineParts(q, 0, NOW)).toEqual(["Maya Chen", "2 h ago"]);
    expect(fullLine(q, NOW)).toBe("Published by Maya Chen, 2 hours ago");
    expect(sheetLines(q, NOW)).toEqual([
      "Published by Maya Chen",
      "2 hours ago · version 3",
    ]);
  });
  it("an older version names itself", () => {
    const q = publisherFor(
      {
        agent: null,
        createdBy: maya,
        version: 9,
        createdAt: "2026-11-03T10:00:00Z",
      },
      member,
      12,
    );
    expect(lineParts(q, 0, NOW)).toEqual(["Maya Chen", "v9 · 3 Nov"]);
  });
});

describe("the sheet", () => {
  it("Published by, then whose agent, when and which version", () => {
    const p = publisherFor(
      { agent, createdBy: leo, version: 12, createdAt: ago(2) },
      member,
      12,
    );
    expect(sheetLines(p, NOW)).toEqual([
      "Published by OA Design",
      "Leo Urbina's agent · 2 hours ago · version 12",
    ]);
  });
});

describe("short times", () => {
  it.each([
    [0, "just now"],
    [0.5, "30 min ago"],
    [2, "2 h ago"],
    [30, "yesterday"],
  ])("%s h", (h, s) => {
    expect(shortAgo(ago(h), NOW)).toBe(s);
  });
});
