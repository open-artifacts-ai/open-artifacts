import type { CommentThread } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  arrange,
  createGate,
  frameThreads,
  numbering,
} from "../src/viewer/comments/model";

const author = { kind: "user", name: "Sam Secret", me: false } as const;
const thread = (
  id: string,
  anchor: CommentThread["anchor"],
  over: Partial<CommentThread> = {},
): CommentThread => ({
  id,
  anchor,
  version: 1,
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: `2026-11-05T10:00:0${id.length}Z`,
  comments: [
    {
      id: `c-${id}`,
      body: "private words",
      author,
      createdAt: "2026-11-05T10:00:00Z",
      editedAt: null,
      can: { edit: false, delete: false },
    },
  ],
  ...over,
});
const text = {
  kind: "text",
  version: 1,
  exact: "hello",
  prefix: "",
  suffix: "",
} as const;

describe("frameThreads", () => {
  it("carries only ids, anchors and numbers: never comment text or names", () => {
    const out = frameThreads(
      [thread("a", text), thread("bb", { kind: "note" })],
      "a",
    );
    expect(out).toEqual([{ id: "a", anchor: text, n: 1, active: true }]);
    const json = JSON.stringify(out);
    expect(json).not.toContain("private words");
    expect(json).not.toContain("Sam Secret");
  });
  it("marks resolved threads and skips ids the frame schema would refuse", () => {
    const out = frameThreads(
      [thread("a", text, { status: "resolved" }), thread("bad id!", text)],
      null,
    );
    expect(out).toEqual([{ id: "a", anchor: text, n: 1, resolved: true }]);
  });
  it("numbers by creation order", () => {
    const n = numbering([
      thread("bbb", text, { createdAt: "2026-11-05T10:00:09Z" }),
      thread("a", text, { createdAt: "2026-11-05T10:00:01Z" }),
    ]);
    expect(n.get("a")).toBe(1);
    expect(n.get("bbb")).toBe(2);
  });
});

describe("arrange", () => {
  it("puts notes first, then by position, then unplaced; orphans apart", () => {
    const t = [
      thread("n", { kind: "note" }),
      thread("low", text),
      thread("high", text),
      thread("none", text),
      thread("gone", text),
    ];
    const pos = new Map([
      ["low", { state: "exact" as const, top: 500 }],
      ["high", { state: "exact" as const, top: 10 }],
      ["none", { state: "exact" as const, top: null }],
      ["gone", { state: "orphan" as const, top: null }],
    ]);
    const r = arrange(t, pos);
    expect(r.ordered.map((x) => x.id)).toEqual(["n", "high", "low", "none"]);
    expect(r.orphans.map((x) => x.id)).toEqual(["gone"]);
  });
});

describe("createGate", () => {
  it("lets max through per window", () => {
    let now = 0;
    const g = createGate(2, 1000, () => now);
    expect([g(), g(), g()]).toEqual([true, true, false]);
    now = 1001;
    expect(g()).toBe(true);
  });
});
