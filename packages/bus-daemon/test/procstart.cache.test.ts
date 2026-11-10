import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcStartUnknownError } from "@oa/bus-adapter-claude-code";
import { describe, expect, it, vi } from "vitest";
import {
  cachedProcStart,
  liveClaudeSessions,
  PROC_START_TTL_MS,
} from "../src/liveness/claude.ts";

describe("cachedProcStart (default 60 s TTL)", () => {
  it("hits within the TTL with no second ps, even across 2 s ticks", () => {
    let t = 0;
    const ps = vi.fn(() => "s");
    const cached = cachedProcStart(ps, () => true, { now: () => t });
    for (; t < PROC_START_TTL_MS; t += 2000) cached(7, "a");
    expect(ps).toHaveBeenCalledTimes(1);
    t = PROC_START_TTL_MS * 1.5 + 1;
    cached(7, "a");
    expect(ps).toHaveBeenCalledTimes(2);
  });

  it("spreads refreshes: entries made together do not all expire on one tick", () => {
    let t = 0;
    const ps = vi.fn(() => "s");
    const cached = cachedProcStart(ps, () => true, { now: () => t });
    for (let pid = 100; pid < 116; pid += 1) cached(pid, "a");
    ps.mockClear();
    let max = 0;
    for (t = 2000; t <= PROC_START_TTL_MS * 2; t += 2000) {
      ps.mockClear();
      for (let pid = 100; pid < 116; pid += 1) cached(pid, "a");
      max = Math.max(max, ps.mock.calls.length);
    }
    expect(max).toBeLessThanOrEqual(3);
  });

  it("no re-read when only the file's mtime changes", () => {
    const d = mkdtempSync(join(tmpdir(), "ps-mtime-"));
    const f = join(d, "4242.json");
    const write = () =>
      writeFileSync(
        f,
        JSON.stringify({
          pid: 4242,
          sessionId: "s-1",
          procStart: "p",
          messagingSocketPath: "/x",
        }),
      );
    write();
    const ps = vi.fn(() => "p");
    const deps = {
      dir: d,
      procStart: cachedProcStart(ps, () => true, { now: () => 0 }),
      isRunning: () => true,
    };
    expect(liveClaudeSessions(deps)).toHaveLength(1);
    utimesSync(f, new Date(1e12), new Date(1e12));
    write();
    expect(liveClaudeSessions(deps)).toHaveLength(1);
    expect(ps).toHaveBeenCalledTimes(1);
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
