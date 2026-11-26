import { describe, expect, it } from "vitest";
import {
  type Answer,
  type FindIndexed,
  findIndexed,
} from "../smoke/search-settle.js";

// The smoke search wait on a fake clock `t` and fake asks: one budget covers
// every hold, every body read and the search.
function rig(over: Partial<FindIndexed> & Pick<FindIndexed, "versions">) {
  let t = 1_000;
  const signals: number[] = [];
  const run = () =>
    findIndexed({
      search: async () => ({ status: 200, text: "hit" }),
      indexed: (text) => text === "indexed",
      listed: (text) => text === "hit",
      budgetMs: 60_000,
      holdMs: 25_000,
      quickMax: 5,
      now: () => t,
      signalFor: (ms) => {
        signals.push(ms);
        return new AbortController().signal;
      },
      ...over,
    });
  return {
    run,
    advance: (ms: number) => {
      t += ms;
    },
    signals,
    now: () => t,
  };
}
const ok = (text: string): Answer => ({ status: 200, text });

describe("findIndexed", () => {
  it("one held ask, then one search", async () => {
    const calls: string[] = [];
    const r = rig({
      versions: async () => (calls.push("v"), ok("indexed")),
      search: async () => (calls.push("s"), ok("hit")),
    });
    await r.run();
    expect(calls).toEqual(["v", "s"]);
  });

  it("each hold asks for the time left at most, and its signal is the time left", async () => {
    const waits: number[] = [];
    let n = 0;
    let advance: (ms: number) => void = () => {};
    const r = rig({
      versions: async (wait) => {
        waits.push(wait);
        n++;
        advance(n < 3 ? wait : 1_000); // the first two run out their wait
        return ok(n < 3 ? "pending" : "indexed");
      },
    });
    advance = r.advance;
    await r.run();
    expect(waits).toEqual([25_000, 25_000, 10_000]);
    // Each ask's signal is the time left; the search gets what remains (0 left: 60 - 50).
    expect(r.signals.slice(0, 3)).toEqual([60_000, 35_000, 10_000]);
  });

  it("the search gets only what is left of the one budget", async () => {
    let advance: (ms: number) => void = () => {};
    const r = rig({
      versions: async () => {
        advance(40_000);
        return ok("indexed");
      },
    });
    advance = r.advance;
    await r.run();
    expect(r.signals).toEqual([60_000, 20_000]);
  });

  it("an indexed answer that arrives after the budget is refused", async () => {
    let advance: (ms: number) => void = () => {};
    const r = rig({
      versions: async () => {
        advance(61_000);
        return ok("indexed");
      },
    });
    advance = r.advance;
    await expect(r.run()).rejects.toThrow(/after the 60000 ms budget/);
  });

  it("a search answer that arrives after the budget is refused", async () => {
    let advance: (ms: number) => void = () => {};
    const r = rig({
      versions: async () => {
        advance(30_000);
        return ok("indexed");
      },
      search: async () => {
        advance(31_000);
        return ok("hit");
      },
    });
    advance = r.advance;
    await expect(r.run()).rejects.toThrow(/search: answered after/);
  });

  it("a budget spent before the search fails, not a search past it", async () => {
    let advance: (ms: number) => void = () => {};
    const r = rig({
      versions: async () => {
        advance(60_000);
        return ok("indexed");
      },
    });
    advance = r.advance;
    await expect(r.run()).rejects.toThrow(/searched too late/);
  });

  it("never indexed: fails at the budget", async () => {
    let advance: (ms: number) => void = () => {};
    const r = rig({
      versions: async (wait) => {
        advance(wait);
        return ok("pending");
      },
    });
    advance = r.advance;
    await expect(r.run()).rejects.toThrow(/not indexed within 60000 ms/);
  });

  it("an install that answers at once, again and again, is not held", async () => {
    const r = rig({ versions: async () => ok("pending") });
    await expect(r.run()).rejects.toThrow(/without holding/);
  });

  it("a refused PAT or a failing ask fails at once, naming the answer", async () => {
    const r = rig({ versions: async () => ({ status: 401, text: "no" }) });
    await expect(r.run()).rejects.toThrow(/versions: 401 no/);
    const s = rig({
      versions: async () => ok("indexed"),
      search: async () => ({ status: 503, text: "down" }),
    });
    await expect(s.run()).rejects.toThrow(/search: 503 down/);
  });

  it("an indexed artifact the search does not list fails", async () => {
    const r = rig({
      versions: async () => ok("indexed"),
      search: async () => ok("miss"),
    });
    await expect(r.run()).rejects.toThrow(/not listed/);
  });
});
