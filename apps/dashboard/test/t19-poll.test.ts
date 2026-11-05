// T19's helpers for #1251: polling on a product signal, and the Turnstile
// stand-in that hands the page the dummy token.
import { describe, expect, it, vi } from "vitest";
import { untilSettled } from "../e2e/staging/poll";
import { stubTurnstile, TURNSTILE_DUMMY_TOKEN } from "../e2e/staging/turnstile";

const noWait = { wait: async () => {} };

describe("untilSettled", () => {
  it("reads until the answer isn't pending, with no fixed budget", async () => {
    const answers = ["pending", "pending", "pending", "ineligible"];
    const read = vi.fn(async () => answers.shift() as string);
    await expect(
      untilSettled(read, (v) => v === "pending", noWait),
    ).resolves.toBe("ineligible");
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("returns at once when the first answer is settled", async () => {
    const read = vi.fn(async () => "code");
    await untilSettled(read, (v) => v === "pending", noWait);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a read that throws (a refusal) fails at once, never polls past it", async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("pending")
      .mockRejectedValueOnce(new Error("rl-a otp hook: 429"));
    await expect(
      untilSettled(read, (v) => v === "pending", noWait),
    ).rejects.toThrow("rl-a otp hook: 429");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("waits the interval between reads", async () => {
    const waits: number[] = [];
    const answers = ["pending", "done"];
    await untilSettled(
      async () => answers.shift() as string,
      (v) => v === "pending",
      { intervalMs: 1000, wait: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([1000]);
  });
});

describe("stubTurnstile", () => {
  it("renders a widget that hands the page the dummy token", async () => {
    const g = globalThis as unknown as { window?: unknown };
    const had = g.window;
    g.window = globalThis;
    try {
      stubTurnstile(TURNSTILE_DUMMY_TOKEN);
      const api = (
        globalThis as unknown as {
          turnstile: {
            render: (
              el: unknown,
              o: { callback: (t: string) => void },
            ) => string;
          };
        }
      ).turnstile;
      const token = await new Promise<string>((done) =>
        api.render({}, { callback: done }),
      );
      expect(token).toBe("XXXX.DUMMY.TOKEN.XXXX");
    } finally {
      g.window = had;
      delete (globalThis as { turnstile?: unknown }).turnstile;
    }
  });
});
