// Waiting for a daemon frame (e2e/real/frame-wait.ts): bounded, and a wait that
// timed out leaves nothing behind to swallow a later frame. On a fake clock.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FRAME_WAIT_MS, findFrame, takeFrame } from "../e2e/real/frame-wait";

afterEach(() => vi.useRealTimers());

type F = { type: string };

describe("takeFrame", () => {
  it("takes a frame already queued, out of the queue", async () => {
    const frames: F[] = [{ type: "a" }, { type: "b" }];
    const got = await takeFrame(frames, [], (f) => f.type === "b", "b");
    expect(got.type).toBe("b");
    expect(frames).toEqual([{ type: "a" }]);
  });

  it("a frame that arrives goes to the waiter that wants it", async () => {
    const waiters: ((f: F) => void)[] = [];
    const p = takeFrame([] as F[], waiters, (f) => f.type === "b", "b");
    waiters.shift()?.({ type: "a" }); // not wanted: the waiter puts itself back
    expect(waiters).toHaveLength(1);
    waiters.shift()?.({ type: "b" });
    await expect(p).resolves.toEqual({ type: "b" });
  });

  it("at the deadline it fails by name and takes its waiter out", async () => {
    vi.useFakeTimers();
    const waiters: ((f: F) => void)[] = [];
    const p = takeFrame([] as F[], waiters, () => false, "a hello_ok frame");
    const caught = p.catch((e: Error) => e.message);
    expect(waiters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FRAME_WAIT_MS);
    expect(await caught).toMatch(/a hello_ok frame: no answer/);
    expect(waiters).toHaveLength(0);
  });

  it("a dead waiter does not swallow a later frame", async () => {
    vi.useFakeTimers();
    const frames: F[] = [];
    const waiters: ((f: F) => void)[] = [];
    const dead = takeFrame(frames, waiters, (f) => f.type === "x", "x").catch(
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(FRAME_WAIT_MS);
    await dead;
    // The next frame finds no waiter, so it is queued for the next wait.
    expect(waiters).toHaveLength(0);
    frames.push({ type: "later" });
    await expect(
      takeFrame(frames, waiters, (f) => f.type === "later", "later"),
    ).resolves.toEqual({ type: "later" });
  });
});

describe("findFrame", () => {
  it("finds a queued frame and leaves it in place", async () => {
    const frames: F[] = [{ type: "a" }];
    await expect(
      findFrame(frames, [], (f) => f.type === "a", "a"),
    ).resolves.toEqual({ type: "a" });
    expect(frames).toHaveLength(1);
  });

  it("wakes on a new frame", async () => {
    const frames: F[] = [];
    const waiters: (() => void)[] = [];
    const p = findFrame(frames, waiters, (f) => f.type === "a", "a");
    frames.push({ type: "a" });
    for (const w of waiters.splice(0)) w();
    await expect(p).resolves.toEqual({ type: "a" });
  });

  it("at the deadline it fails by name and takes its waiter out", async () => {
    vi.useFakeTimers();
    const waiters: (() => void)[] = [];
    const caught = findFrame(
      [] as F[],
      waiters,
      () => false,
      "a roster frame",
    ).catch((e: Error) => e.message);
    expect(waiters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FRAME_WAIT_MS);
    expect(await caught).toMatch(/a roster frame: no answer/);
    expect(waiters).toHaveLength(0);
  });
});
