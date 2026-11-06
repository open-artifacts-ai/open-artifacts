// T19's api helper (e2e/staging/retry.ts): a read that got no response is
// tried again; a write never is, and an answer that arrived is returned as is.
import { describe, expect, it, vi } from "vitest";
import { InfraError, isNetworkError, sendRead } from "../e2e/staging/retry";

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

// #1596: a socket failure before any response is infra, named; an answer is not.
describe("sendRead infra classification", () => {
  it("a write that is reset is infra, named, and sent once", async () => {
    const send = vi.fn<() => Promise<Response>>().mockRejectedValue(reset());
    const e = await sendRead("POST", send, {
      ...noWait,
      route: "/api/x",
    }).catch((x) => x);
    expect(e).toBeInstanceOf(InfraError);
    expect(e.message).toBe("infra: no_response ECONNRESET POST /api/x (1 try)");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a GET reset on every try is infra after the bounded tries", async () => {
    const send = vi.fn<() => Promise<Response>>().mockRejectedValue(reset());
    const e = await sendRead("GET", send, { ...noWait, route: "/r" }).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(InfraError);
    expect(e.message).toContain("no_response ECONNRESET GET /r (3 tries)");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each(["POST", "GET"])("an HTTP 500 on %s stays a response", async (m) => {
    const send = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 500 }));
    expect((await sendRead(m, send, noWait)).status).toBe(500);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a success passes", async () => {
    const send = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    expect((await sendRead("POST", send, noWait)).status).toBe(200);
  });

  it("a timeout is not reclassified", async () => {
    const t = new DOMException("t", "TimeoutError");
    const send = vi.fn<() => Promise<Response>>().mockRejectedValue(t);
    await expect(sendRead("POST", send, noWait)).rejects.toBe(t);
  });
});
