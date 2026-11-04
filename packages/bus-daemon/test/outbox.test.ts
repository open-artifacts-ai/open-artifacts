import { describe, expect, it, vi } from "vitest";
import { Outbox } from "../src/outbox.ts";

describe("outbox", () => {
  it("sends at once while the hub is up", () => {
    const send = vi.fn(() => true);
    const o = new Outbox<string>({ send });
    o.push("a");
    expect(send).toHaveBeenCalledWith("a", expect.any(Function));
    expect(o.size).toBe(0);
  });

  it("takes back, in order, frames accepted but never written", () => {
    const unsent: (() => void)[] = [];
    let up = true;
    const sent: string[] = [];
    const o = new Outbox<string>({
      send: (f, back) => {
        if (!up) return false;
        sent.push(f);
        unsent.push(back);
        return true;
      },
    });
    o.push("a");
    o.push("b");
    o.push("c");
    up = false;
    o.push("d");
    // The link drops before b and c were written: they go back ahead of d.
    unsent[2]();
    unsent[1]();
    expect(o.size).toBe(3);
    up = true;
    sent.length = 0;
    o.flush();
    expect(sent).toEqual(["b", "c", "d"]);
  });

  it("queues while the hub is down and flushes in order", () => {
    let up = false;
    const sent: string[] = [];
    const o = new Outbox<string>({
      send: (f) => {
        if (up) sent.push(f);
        return up;
      },
    });
    o.push("a");
    o.push("b");
    expect(o.size).toBe(2);
    up = true;
    o.flush();
    expect(sent).toEqual(["a", "b"]);
    expect(o.size).toBe(0);
  });

  it("keeps the rest queued when the link drops mid-flush", () => {
    let budget = 0;
    const sent: string[] = [];
    const o = new Outbox<string>({
      send: (f) => {
        if (budget <= 0) return false;
        budget -= 1;
        sent.push(f);
        return true;
      },
    });
    o.push("a");
    o.push("b");
    o.push("c");
    budget = 1;
    o.flush();
    budget = 5;
    o.flush();
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest past the cap and logs it", () => {
    const log = vi.fn();
    const sent: number[] = [];
    let up = false;
    const o = new Outbox<number>({
      send: (f) => {
        if (up) sent.push(f);
        return up;
      },
      max: 100,
      log,
    });
    for (let i = 0; i < 105; i++) o.push(i);
    expect(o.size).toBe(100);
    expect(log).toHaveBeenCalledTimes(5);
    up = true;
    o.flush();
    expect(sent[0]).toBe(5);
    expect(sent).toHaveLength(100);
  });

  it("drops frames older than ten minutes and logs it", () => {
    let now = 0;
    let up = false;
    const log = vi.fn();
    const sent: string[] = [];
    const o = new Outbox<string>({
      send: (f) => {
        if (up) sent.push(f);
        return up;
      },
      now: () => now,
      log,
    });
    o.push("old");
    now = 9 * 60_000;
    o.push("new");
    now = 10 * 60_000 + 1;
    up = true;
    o.flush();
    expect(sent).toEqual(["new"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/expired/));
  });

  it("drops and logs frames that went stale while queued", () => {
    let up = false;
    const log = vi.fn();
    const sent: string[] = [];
    const gone = new Set(["b"]);
    const o = new Outbox<string>({
      send: (f) => {
        if (up) sent.push(f);
        return up;
      },
      stale: (f) => gone.has(f),
      log,
    });
    o.push("a");
    o.push("b");
    o.push("c");
    up = true;
    o.flush();
    expect(sent).toEqual(["a", "c"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no longer live/));
  });
});

describe("a frame handed back while the link stays up", () => {
  it("is retried after retryMs, once, without a reconnect", () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      let back: (() => void) | undefined;
      const o = new Outbox<string>({
        retryMs: 500,
        send: (f, unsent) => {
          sent.push(f);
          back ??= unsent;
          return true;
        },
      });
      o.push("a");
      back?.(); // dropped for space before it was written
      o.push("b"); // waits behind a
      expect(sent).toEqual(["a"]);
      vi.advanceTimersByTime(499);
      expect(sent).toEqual(["a"]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(["a", "a", "b"]);
      expect(o.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("outbox stop", () => {
  it("clears a pending retry", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn((_f: string, _unsent: () => void) => true);
      const o = new Outbox<string>({ send });
      o.push("a");
      send.mock.calls[0][1]();
      expect(vi.getTimerCount()).toBe(1);
      o.stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
