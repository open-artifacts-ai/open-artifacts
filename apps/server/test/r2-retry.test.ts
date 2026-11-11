import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    return o instanceof Error ? Promise.reject(o) : Promise.resolve(o === undefined ? "ok" : o);
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
});
