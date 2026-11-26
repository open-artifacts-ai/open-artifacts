// The teardown that spends a refusal's device codes (e2e/real/spend-codes.ts):
// bounded, errors ignored, never failing a test. On a fake clock.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEND_BOUND_MS, spendCodes } from "../e2e/real/spend-codes";

afterEach(() => vi.useRealTimers());

const never = () => new Promise<Response>(() => {});

describe("spendCodes", () => {
  it("asks the token endpoint once per code", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (u: unknown, init?: RequestInit) => {
      urls.push(`${String(u)} ${init?.body}`);
      return new Response("{}");
    }) as unknown as typeof fetch;
    await spendCodes("http://h.test", ["a", "b"], f);
    expect(urls).toEqual([
      'http://h.test/bus/device/token {"device_code":"a"}',
      'http://h.test/bus/device/token {"device_code":"b"}',
    ]);
  });

  it("ends at its bound when a call never answers, not before", async () => {
    vi.useFakeTimers();
    let done = false;
    const run = spendCodes("http://h.test", ["a"], never as typeof fetch).then(
      () => {
        done = true;
      },
    );
    await vi.advanceTimersByTimeAsync(SPEND_BOUND_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(done).toBe(true);
  });

  it("ignores a failing call", async () => {
    const f = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(
      spendCodes("http://h.test", ["a"], f),
    ).resolves.toBeUndefined();
  });

  it("an empty list returns at once", async () => {
    await expect(
      spendCodes("http://h.test", [], never as typeof fetch),
    ).resolves.toBeUndefined();
  });
});
