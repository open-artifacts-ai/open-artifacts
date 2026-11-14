// #2512: what the bell shows and how a "For you" row reads (inbox contract, #2513).
import type { InboxItem } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  agoText,
  askComment,
  awayText,
  backText,
  bellName,
  bellState,
  canLater,
  contextLine,
  countsOf,
  safePath,
  waitMs,
  waitText,
} from "../src/foryou/model";

const NOW = new Date(2026, 10, 14, 15, 30).getTime();
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const item = (o: Partial<InboxItem> & { id: string }): InboxItem => ({
  level: "needs_you",
  kind: "ask",
  artifact: { id: "Cd5fGhJkLm6nPqRs", title: "Open Artifacts Asks" },
  actor: { kind: "agent", name: "OA Manager", agentId: "agent:manager" },
  text: o.id,
  href: "/a/Cd5fGhJkLm6nPqRs",
  createdAt: at(1),
  readAt: null,
  ...o,
});
const upd = (id: string, read: boolean) =>
  item({ id, level: "update", kind: "reply", readAt: read ? at(0) : null });

describe("the bell", () => {
  it("counts only Needs you; updates never add to it", () => {
    expect(bellState({ needsYou: 2, unreadUpdates: 3 })).toEqual({
      count: 2,
      dot: false,
    });
  });

  it("shows a dot for unread updates when nothing needs you", () => {
    expect(bellState({ needsYou: 0, unreadUpdates: 1 })).toEqual({
      count: 0,
      dot: true,
    });
  });

  it("is quiet with nothing at all", () => {
    expect(bellState({ needsYou: 0, unreadUpdates: 0 })).toEqual({
      count: 0,
      dot: false,
    });
  });

  it("recounts from the list after a change here (Later leaves Needs you)", () => {
    expect(
      countsOf({
        needsYou: [item({ id: "a" })],
        updates: [upd("u", false), upd("v", true)],
      }),
    ).toEqual({ needsYou: 1, unreadUpdates: 1 });
  });

  it("has an accessible name for each state", () => {
    expect(bellName({ count: 2, dot: false })).toBe("For you, 2 need you");
    expect(bellName({ count: 1, dot: false })).toBe("For you, 1 needs you");
    expect(bellName({ count: 0, dot: true })).toBe("For you, new updates");
    expect(bellName({ count: 0, dot: false })).toBe("For you");
  });
});

describe("Later", () => {
  const machine = item({
    id: "itm:m",
    kind: "machine",
    actor: null,
    machine: { id: "m", name: "Box" },
  });
  it("is offered once, and only on a single-action item", () => {
    expect(canLater(machine)).toBe(true);
    expect(canLater({ ...machine, backFromLater: true })).toBe(false);
    expect(
      canLater({ ...machine, later: { until: at(-60), used: true } }),
    ).toBe(false);
    expect(canLater(item({ id: "ask:c1" }))).toBe(false);
    expect(canLater(upd("u", false))).toBe(false);
  });
});

describe("asks", () => {
  it("finds the comment from the item id", () => {
    expect(askComment(item({ id: "ask:c1" }))).toBe("c1");
    expect(askComment(item({ id: "itm:x", kind: "mention" }))).toBeNull();
  });

  it("takes the wait from the server's waitingSince, only when waiting", () => {
    const w = item({ id: "ask:c1", urgency: "waiting", waitingSince: at(4) });
    expect(waitMs(w, NOW)).toBe(4 * 60_000);
    expect(waitMs({ ...w, urgency: "plain" }, NOW)).toBeUndefined();
    expect(contextLine(w, NOW)).toBe(
      'OA Manager asks · on "Open Artifacts Asks"',
    );
    expect(contextLine({ ...w, urgency: "plain" }, NOW)).toBe(
      'OA Manager asks · on "Open Artifacts Asks" · 1 min ago',
    );
  });
});

describe("hrefs", () => {
  const o = "https://oa.example";
  it("keeps same-origin paths", () => {
    expect(safePath("/a/x?thread=t#c", o)).toBe("/a/x?thread=t#c");
  });
  it("refuses anything that leaves the origin", () => {
    expect(safePath("/\t/evil.example", o)).toBeNull();
    expect(safePath("//evil.example/a", o)).toBeNull();
    expect(safePath("https://evil.example/", o)).toBeNull();
    expect(safePath("/\\evil.example", o)).toBeNull();
  });
});

describe("words", () => {
  it("says how long an agent has waited", () => {
    expect(waitText(30_000)).toBe("waiting 1 min");
    expect(waitText(4 * 60_000)).toBe("waiting 4 min");
    expect(waitText(2 * 3600_000)).toBe("waiting 2 h");
    expect(waitText(24 * 3600_000)).toBe("waiting 1 day");
    expect(waitText(3 * 24 * 3600_000)).toBe("waiting 3 days");
  });

  it("says when a row happened", () => {
    expect(agoText(at(0), NOW)).toBe("just now");
    expect(agoText(at(20), NOW)).toBe("20 min ago");
    expect(agoText(at(60), NOW)).toBe("1 h ago");
    expect(agoText(at(26 * 60), NOW)).toBe("yesterday");
  });

  it("writes each kind's line", () => {
    const m = item({ id: "itm:m", kind: "machine", createdAt: at(20) });
    expect(contextLine(m, NOW)).toBe(
      "It wants to connect agents as you · 20 min ago",
    );
    const r = item({
      id: "itm:r",
      level: "update",
      kind: "reply",
      createdAt: at(60),
    });
    expect(contextLine(r, NOW)).toBe('on "Open Artifacts Asks" · 1 h ago');
  });

  it("says when Later brings it back", () => {
    const tomorrow8 = new Date(2026, 10, 15, 8, 0).toISOString();
    expect(backText(tomorrow8, NOW)).toBe("Back tomorrow at 8:00");
    expect(backText(new Date(2026, 10, 14, 16, 30).toISOString(), NOW)).toBe(
      "Back at 16:30",
    );
  });

  it("sums up While you were away", () => {
    const since = new Date(2026, 10, 13, 22, 0).toISOString();
    expect(awayText({ since, count: 6 })).toBe("6 updates since 22:00");
  });
});
