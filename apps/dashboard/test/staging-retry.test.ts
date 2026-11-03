// T19's api helper (e2e/staging/retry.ts): a read that got no response is
// tried again; a write never is, and an answer that arrived is returned as is.
import { describe, expect, it, vi } from "vitest";
import { isNetworkError, sendRead } from "../e2e/staging/retry";

/** What undici throws when the connection is cut: TypeError, cause ECONNRESET. */
const reset = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
const noWait = { wait: async () => {} };

describe("sendRead", () => {
  it("a GET that loses its connection is sent again, then succeeds", async () => {
    const send = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const res = await sendRead(undefined, send, noWait);
    expect(res.status).toBe(404);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a GET gives up after the bounded tries and throws the last error", async () => {
    const send = vi.fn<() => Promise<Response>>().mockRejectedValue(reset());
    await expect(sendRead("GET", send, noWait)).rejects.toThrow("fetch failed");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "a %s with the same error is never sent twice",
    async (method) => {
      const send = vi.fn<() => Promise<Response>>().mockRejectedValue(reset());
      await expect(sendRead(method, send, noWait)).rejects.toThrow(
        "fetch failed",
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([403, 500, 503])(
    "a %i that arrived is returned as is, not retried",
    async (status) => {
      const send = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValue(new Response(null, { status }));
      expect((await sendRead("GET", send, noWait)).status).toBe(status);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("an error that isn't a lost connection is thrown at once", async () => {
    const send = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValue(new Error("bad JSON"));
    await expect(sendRead("GET", send, noWait)).rejects.toThrow("bad JSON");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits the short backoff between tries", async () => {
    const waits: number[] = [];
    const send = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(reset())
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await sendRead("GET", send, {
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([250, 1000]);
  });
});

it("isNetworkError: a cut connection and a timeout, never a plain error", () => {
  expect(isNetworkError(reset())).toBe(true);
  expect(isNetworkError(new DOMException("t", "TimeoutError"))).toBe(true);
  expect(isNetworkError(new Error("x"))).toBe(false);
});
