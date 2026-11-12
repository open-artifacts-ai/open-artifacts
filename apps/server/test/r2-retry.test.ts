import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  breakerOpen,
  putIdempotent,
  resetBreaker,
  retryingR2,
  setRetryDeps,
  withRetries,
} from "../src/db/retry.js";
import { isStorageFailure } from "../src/db/storage-failure.js";
import { toErrorResponse } from "../src/http/errors.js";

const r2Down = (op = "get") =>
  new Error(
    `${op}: We encountered an internal error. Please try again. (10001)`,
  );

function fakeBucket(outcomes: unknown[]) {
  let n = 0;
  const next = () => {
    const o = outcomes[n++];
    return o instanceof Error
      ? Promise.reject(o)
      : Promise.resolve(o === undefined ? "ok" : o);
  };
  return {
    get: vi.fn(next),
    head: vi.fn(next),
    list: vi.fn(next),
    delete: vi.fn(next),
    put: vi.fn(next),
  } as unknown as R2Bucket & Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  resetBreaker();
  setRetryDeps({ sleep: async () => {}, random: () => 0.5 });
});
afterEach(() => {
  setRetryDeps(null);
  resetBreaker();
  vi.restoreAllMocks();
});

describe("R2 transient errors (#2218)", () => {
  it("classifies 10001, 10043 and lost connections; not 404s or preconditions", () => {
    expect(isStorageFailure(r2Down())).toBe(true);
    expect(
      isStorageFailure(new Error("put: Service Unavailable (10043)")),
    ).toBe(true);
    expect(isStorageFailure(new Error("head: Network connection lost."))).toBe(
      true,
    );
    expect(
      isStorageFailure(
        new Error("get: The specified key does not exist. (10007)"),
      ),
    ).toBe(false);
    expect(
      isStorageFailure(new Error("put: Precondition failed (10031)")),
    ).toBe(false);
  });

  it.each(["get", "head", "list", "delete"] as const)(
    "%s fails once, then succeeds",
    async (op) => {
      const b = fakeBucket([r2Down(op), "value"]);
      const w = retryingR2(b);
      await expect(
        (w[op] as (k: string) => Promise<unknown>)("k"),
      ).resolves.toBe("value");
      expect(b[op]).toHaveBeenCalledTimes(2);
    },
  );

  it("fails always: bounded attempts, then a retryable 503", async () => {
    const b = fakeBucket([r2Down(), r2Down(), r2Down(), r2Down()]);
    const err = await retryingR2(b)
      .get("k")
      .catch((e) => e);
    expect(b.get).toHaveBeenCalledTimes(3);
    const res = toErrorResponse(err);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "storage_unavailable",
    );
  });

  it("a 404 (null) and a non-transient error are not retried", async () => {
    const b = fakeBucket([null]);
    expect(await retryingR2(b).get("k")).toBeNull();
    expect(b.get).toHaveBeenCalledTimes(1);
    const c = fakeBucket([new Error("get: Precondition failed (10031)")]);
    await expect(retryingR2(c).get("k")).rejects.toThrow(/10031/);
    expect(c.get).toHaveBeenCalledTimes(1);
  });

  it("a plain put (streams, conditional) is never retried", async () => {
    const b = fakeBucket([r2Down("put"), "ok"]);
    await expect(retryingR2(b).put("k", "v", {})).rejects.toThrow(/10001/);
    expect(b.put).toHaveBeenCalledTimes(1);
  });

  it("putIdempotent retries a fresh-key in-memory put", async () => {
    const b = fakeBucket([r2Down("put"), "stored"]);
    await expect(putIdempotent(b, "k", "bytes")).resolves.toBe("stored");
    expect(b.put).toHaveBeenCalledTimes(2);
  });

  it("logs op, binding and code on failure, never the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = fakeBucket([r2Down("put")]);
    await retryingR2(b)
      .put("secret-user-key", "v")
      .catch(() => {});
    const out = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("r2_failed");
    expect(out).toContain("FILES");
    expect(out).toContain("10001");
    expect(out).not.toContain("secret-user-key");
  });

  it("withRetries wraps FILES once per env", () => {
    const b = fakeBucket([]);
    const e = withRetries({ FILES: b });
    expect(e.FILES).toBe(e.FILES);
    expect(e.FILES).not.toBe(b);
  });

  it("R2 failures trip only R2's breaker, and a retried put logs no r2_failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = fakeBucket(Array.from({ length: 20 }, () => r2Down()));
    for (let i = 0; i < 5; i++)
      await retryingR2(b)
        .get("k")
        .catch(() => {});
    expect(breakerOpen(undefined, "r2")).toBe(true);
    expect(breakerOpen(undefined, "d1")).toBe(false);
    expect(breakerOpen(undefined, "kv")).toBe(false);
    resetBreaker();
    warn.mockClear();
    const p = fakeBucket([r2Down("put"), "stored"]);
    await putIdempotent(retryingR2(p), "k", "v");
    expect(warn.mock.calls.map((c) => String(c[0])).join("")).not.toContain(
      "r2_failed",
    );
  });
});

describe("R2 retry bounds and maybe-committed puts (#2218)", () => {
  it("slow failures stop retrying within the elapsed budget", async () => {
    let t = 1_000;
    setRetryDeps({ now: () => t, sleep: async () => {}, random: () => 0.5 });
    const b = {
      get: vi.fn(async () => {
        t += 8_000;
        throw r2Down();
      }),
    } as unknown as R2Bucket;
    await retryingR2(b)
      .get("k")
      .catch(() => {});
    expect(b.get).toHaveBeenCalledTimes(1);
  });

  it("a breaker opened while a retry sleeps stops that retry", async () => {
    const t = 1_000;
    const b = fakeBucket(Array.from({ length: 20 }, () => r2Down()));
    setRetryDeps({
      now: () => t,
      random: () => 0.5,
      sleep: async () => {
        // Another request trips the breaker meanwhile.
        for (let i = 0; i < 5; i++)
          await retryingR2(fakeBucket([r2Down(), r2Down(), r2Down()]))
            .head("x")
            .catch(() => {});
      },
    });
    await retryingR2(b)
      .get("k")
      .catch(() => {});
    expect(b.get).toHaveBeenCalledTimes(1);
  });

  it("a put that committed but lost its reply, then 10058 on replay, succeeds without a delete", async () => {
    const stored = { size: 5 } as R2Object;
    const b = {
      put: vi
        .fn()
        .mockRejectedValueOnce(r2Down("put"))
        .mockRejectedValueOnce(
          new Error(
            "put: Reduce your concurrent request rate for the same object. (10058)",
          ),
        ),
      head: vi.fn(async () => stored),
      delete: vi.fn(),
    } as unknown as R2Bucket;
    await expect(putIdempotent(b, "k", "hello")).resolves.toBe(stored);
    expect(b.delete).not.toHaveBeenCalled();
  });

  it("10058 with a size mismatch answers retryable, not 500", async () => {
    const b = {
      put: vi
        .fn()
        .mockRejectedValueOnce(r2Down("put"))
        .mockRejectedValue(
          new Error(
            "put: Reduce your concurrent request rate for the same object. (10058)",
          ),
        ),
      head: vi.fn(async () => ({ size: 99 }) as R2Object),
    } as unknown as R2Bucket;
    const err = await putIdempotent(b, "k", "hello").catch((e) => e);
    expect(toErrorResponse(err).status).toBe(503);
  });
});
