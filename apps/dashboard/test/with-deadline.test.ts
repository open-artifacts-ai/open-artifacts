import { afterEach, describe, expect, it, vi } from "vitest";
import { withDeadline } from "../e2e/staging/with-deadline.ts";

afterEach(() => vi.useRealTimers());

describe("withDeadline", () => {
  it("rejects with the label once ms pass, and not a tick before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: "pending" | "rejected" | "resolved" = "pending";
    let message = "";
    void withDeadline(new Promise<never>(() => {}), 5_000, "close frame").then(
      () => {
        outcome = "resolved";
      },
      (e: Error) => {
        outcome = "rejected";
        message = e.message;
      },
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("rejected");
    expect(message).toContain("close frame");
    expect(message).toContain("5000 ms");
  });

  it("resolves with the op's value and leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(withDeadline(Promise.resolve(7), 1_000, "x")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the op's own rejection through, timer cleared", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(
      withDeadline(Promise.reject(new Error("boom")), 1_000, "x"),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});
