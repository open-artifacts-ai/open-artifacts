import { describe, expect, it, vi } from "vitest";
import { Seen } from "../src/dedupe.ts";

describe("delivery dedupe", () => {
  it("delivers a repeated msg_id once but acks it every time", () => {
    const seen = new Seen(3);
    const inject = vi.fn((_id: string) => true);
    const ack = vi.fn();
    const deliver = (id: string) => {
      if (seen.has(id)) {
        ack(id); // the hub redelivers after a missed ack
        return;
      }
      if (inject(id)) {
        seen.add(id);
        ack(id);
      }
    };
    deliver("m1");
    deliver("m1");
    deliver("m2");
    deliver("m1");
    expect(inject.mock.calls).toEqual([["m1"], ["m2"]]);
    expect(ack).toHaveBeenCalledTimes(4);
  });

  it("leaves a failed delivery retryable", () => {
    const seen = new Seen(3);
    seen.add("m1");
    // A timeout calls seen.delete, so the hub's next attempt delivers.
    seen.delete("m1");
    expect(seen.has("m1")).toBe(false);
    expect(seen.add("m1")).toBe(true);
  });

  it("forgets beyond its capacity", () => {
    const seen = new Seen(2);
    seen.add("a");
    seen.add("b");
    seen.add("c");
    expect(seen.has("a")).toBe(false);
    expect(seen.add("a")).toBe(true);
  });
});

describe("Seen LRU", () => {
  it("is LRU: a recently repeated id survives eviction", () => {
    const s = new Seen(3);
    s.add("a");
    s.add("b");
    s.add("c");
    expect(s.add("a")).toBe(false); // touch a
    s.add("d"); // should evict b, not a
    expect(s.add("a")).toBe(false);
  });
});
