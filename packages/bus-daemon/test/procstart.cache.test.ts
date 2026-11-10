import { ProcStartUnknownError } from "@oa/bus-adapter-claude-code";
import { describe, expect, it, vi } from "vitest";
import { cachedProcStart, PROC_START_TTL_MS } from "../src/liveness/claude.ts";

describe("cachedProcStart (default 60 s TTL)", () => {
  it("hits within the TTL with no second ps, even across 2 s ticks", () => {
    let t = 0;
    const ps = vi.fn(() => "s");
    const cached = cachedProcStart(ps, () => true, { now: () => t });
    for (; t < PROC_START_TTL_MS; t += 2000) cached(7, "a");
    expect(ps).toHaveBeenCalledTimes(1);
    t = PROC_START_TTL_MS;
    cached(7, "a");
    expect(ps).toHaveBeenCalledTimes(2);
  });

  it("a stamp change re-reads", () => {
    const ps = vi.fn(() => "s");
    const cached = cachedProcStart(ps, () => true, { now: () => 0 });
    cached(7, "a");
    cached(7, "b");
    expect(ps).toHaveBeenCalledTimes(2);
  });

  it("a dead pid is gone and is re-read if it returns", () => {
    let up = true;
    const ps = vi.fn(() => "s");
    const cached = cachedProcStart(ps, () => up, { now: () => 0 });
    expect(cached(7, "a")).toBe("s");
    up = false;
    expect(cached(7, "a")).toBeNull();
    up = true;
    cached(7, "a");
    expect(ps).toHaveBeenCalledTimes(2);
  });

  it("a ps timeout keeps the last known start: the live session is not dropped", () => {
    let t = 0;
    let slow = false;
    const ps = vi.fn(() => {
      if (slow) throw new ProcStartUnknownError(7);
      return "s";
    });
    const cached = cachedProcStart(ps, () => true, { now: () => t });
    expect(cached(7, "a")).toBe("s");
    slow = true;
    t = PROC_START_TTL_MS + 1;
    expect(cached(7, "a")).toBe("s");
    expect(cached(7, "b")).toBe("s");
  });
});
