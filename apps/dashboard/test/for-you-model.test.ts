// #2512: what the bell counts and how "For you" is ordered (PROVISIONAL shapes).
import type { ForYouItem } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  agoText,
  awayText,
  backText,
  bellName,
  bellState,
  canLater,
  laterItems,
  needsYou,
  updates,
  visibleItems,
  waitText,
} from "../src/foryou/model";

const NOW = new Date(2026, 10, 14, 15, 30).getTime();
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const item = (o: Partial<ForYouItem> & { id: string }): ForYouItem => ({
  level: "needs",
  kind: "ask",
  title: o.id,
  context: "",
  at: at(1),
  read: false,
  ...o,
});
const upd = (id: string, read: boolean, min = 5) =>
  item({ id, level: "update", kind: "reply", read, at: at(min) });

describe("the bell", () => {
  it("counts only Needs you; updates never add to it", () => {
    const s = bellState([
      item({ id: "a" }),
      upd("u1", false),
      upd("u2", false),
    ]);
    expect(s).toEqual({ count: 1, dot: false });
  });

  it("shows a dot for unread updates when nothing needs you", () => {
    expect(bellState([upd("u1", false)])).toEqual({ count: 0, dot: true });
    expect(bellState([upd("u1", true)])).toEqual({ count: 0, dot: false });
  });

  it("is quiet with nothing at all", () => {
    expect(bellState([])).toEqual({ count: 0, dot: false });
  });

  it("does not count an item put off with Later", () => {
    const later = item({
      id: "m",
      later: { state: "snoozed", until: at(-60) },
    });
    expect(bellState([later, item({ id: "a" })]).count).toBe(1);
  });

  it("has an accessible name for each state", () => {
    expect(bellName({ count: 2, dot: false })).toBe("For you, 2 need you");
    expect(bellName({ count: 1, dot: false })).toBe("For you, 1 needs you");
    expect(bellName({ count: 0, dot: true })).toBe("For you, new updates");
    expect(bellName({ count: 0, dot: false })).toBe("For you");
  });
});

describe("Needs you", () => {
  it("sorts the longest wait first, then the newest", () => {
    const list = needsYou([
      item({ id: "plain-new", at: at(1) }),
      item({ id: "wait-4", waitingMs: 4 * 60_000 }),
      item({ id: "plain-old", at: at(90) }),
      item({ id: "wait-40", waitingMs: 40 * 60_000 }),
    ]);
    expect(list.map((x) => x.id)).toEqual([
      "wait-40",
      "wait-4",
      "plain-new",
      "plain-old",
    ]);
  });

  it("puts an item back from Later on top", () => {
    const list = needsYou([
      item({ id: "wait", waitingMs: 60 * 60_000 }),
      item({ id: "back", later: { state: "returned" }, at: at(26 * 60) }),
    ]);
    expect(list.map((x) => x.id)).toEqual(["back", "wait"]);
  });

  it("offers Later once, and only on a single-action item", () => {
    const machine = item({ id: "m", kind: "machine", action: { href: "/x" } });
    expect(canLater(machine)).toBe(true);
    expect(canLater({ ...machine, later: { state: "returned" } })).toBe(false);
    expect(
      canLater({ ...machine, later: { state: "snoozed", until: at(-60) } }),
    ).toBe(false);
    expect(canLater(item({ id: "ask" }))).toBe(false);
    expect(canLater(upd("u", false))).toBe(false);
  });

  it("folds put-off items into Later, soonest back first", () => {
    const a = item({ id: "a", later: { state: "snoozed", until: at(-600) } });
    const b = item({ id: "b", later: { state: "snoozed", until: at(-60) } });
    const items = [a, b, item({ id: "c" })];
    expect(laterItems(items).map((x) => x.id)).toEqual(["b", "a"]);
    expect(needsYou(items).map((x) => x.id)).toEqual(["c"]);
  });
});

describe("billing", () => {
  const bill = item({ id: "bill", kind: "billing", audience: "admins" });
  it("shows only to owners and admins", () => {
    expect(visibleItems([bill], "owner")).toHaveLength(1);
    expect(visibleItems([bill], "admin")).toHaveLength(1);
    expect(visibleItems([bill], "member")).toHaveLength(0);
    expect(visibleItems([bill], "guest")).toHaveLength(0);
    expect(visibleItems([{ ...bill, audience: undefined }], "member")).toEqual(
      [],
    );
  });
});

describe("updates", () => {
  it("hides those folded into While you were away until shown", () => {
    const items = [upd("a", false, 1), upd("b", false, 600), upd("c", true, 2)];
    const away = { updates: 1, pages: 1, since: at(700), ids: ["b"] };
    expect(updates(items, away, false).map((x) => x.id)).toEqual(["a", "c"]);
    expect(updates(items, away, true).map((x) => x.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
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

  it("says when Later brings it back", () => {
    const tomorrow8 = new Date(2026, 10, 15, 8, 0).toISOString();
    expect(backText(tomorrow8, NOW)).toBe("Back tomorrow at 8:00");
    expect(backText(new Date(2026, 10, 14, 16, 30).toISOString(), NOW)).toBe(
      "Back at 16:30",
    );
  });

  it("sums up While you were away", () => {
    const since = new Date(2026, 10, 13, 22, 0).toISOString();
    expect(awayText({ updates: 6, pages: 3, since, ids: [] })).toBe(
      "6 updates on 3 pages since 22:00",
    );
  });
});
