import { afterEach, describe, expect, it } from "vitest";
import {
  InfraError,
  isNetworkError,
  setupFetch,
} from "../src/fetch-timeout.ts";
import { deleteThrowaways } from "../src/fixtures.ts";
import { retryIdempotent, sendProbe } from "../src/http.ts";
import { note, setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { infraOf, notesOf } from "../src/report.ts";
import type { Target } from "../src/targets.ts";

const URL_ = "https://rl-b.example.test/api/v1/me";
const fetchFailed = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  });
/** A send that answers from `script` in order: a status or an error to throw. */
function scripted(script: (number | Error)[]) {
  const calls: string[] = [];
  const go = async (r: Request) => {
    calls.push(`${r.method} ${await r.text()}`);
    const s = script.shift();
    if (s === undefined) throw new Error("script ran out");
    if (s instanceof Error) throw s;
    return new Response(s === 204 ? null : "x", { status: s });
  };
  return { go, calls };
}
const fast = { backoff: [0, 0] };

afterEach(() => {
  setCurrentTest(() => undefined);
  takeFileNotes();
});

describe("isNetworkError", () => {
  it("no response at all: fetch failed, socket codes, aborts and timeouts", () => {
    expect(isNetworkError(fetchFailed())).toBe(true);
    expect(isNetworkError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isNetworkError(new DOMException("x", "TimeoutError"))).toBe(true);
    expect(
      isNetworkError(Object.assign(new Error("r"), { code: "ECONNRESET" })),
    ).toBe(true);
  });
  it("never an assertion, an HTTP error or another TypeError", () => {
    expect(isNetworkError(new Error("expected 200, got 404"))).toBe(false);
    expect(isNetworkError(new TypeError("x is not a function"))).toBe(false);
    expect(isNetworkError("fetch failed")).toBe(false);
  });
});

describe("retryIdempotent", () => {
  it("GET: retries a fetch failed and a 5xx, then answers", async () => {
    const s = scripted([fetchFailed(), 503, 200]);
    const res = await retryIdempotent(new Request(URL_), {
      ...fast,
      send: s.go,
    });
    expect(res.status).toBe(200);
    expect(s.calls).toHaveLength(3);
  });

  it("PUT: the body is sent again on the retry", async () => {
    const s = scripted([fetchFailed(), 200]);
    await retryIdempotent(new Request(URL_, { method: "PUT", body: "b" }), {
      ...fast,
      send: s.go,
    });
    expect(s.calls).toEqual(["PUT b", "PUT b"]);
  });

  it("never retries a 4xx", async () => {
    const s = scripted([404, 200]);
    const res = await retryIdempotent(new Request(URL_), {
      ...fast,
      send: s.go,
    });
    expect(res.status).toBe(404);
    expect(s.calls).toHaveLength(1);
  });

  it("never retries a POST (a publish) or a DELETE, even on fetch failed", async () => {
    for (const method of ["POST", "DELETE"]) {
      const s = scripted([fetchFailed(), 200]);
      await expect(
        retryIdempotent(new Request(URL_, { method, body: "p" }), {
          ...fast,
          send: s.go,
        }),
      ).rejects.toThrow("fetch failed");
      expect(s.calls).toHaveLength(1);
    }
  });

  it("never retries a non-network error", async () => {
    const s = scripted([new Error("boom"), 200]);
    await expect(
      retryIdempotent(new Request(URL_), { ...fast, send: s.go }),
    ).rejects.toThrow("boom");
    expect(s.calls).toHaveLength(1);
  });

  it("3 tries at most: the last 5xx is returned, the last error thrown", async () => {
    const a = scripted([500, 502, 503, 200]);
    expect(
      (await retryIdempotent(new Request(URL_), { ...fast, send: a.go }))
        .status,
    ).toBe(503);
    expect(a.calls).toHaveLength(3);
    const b = scripted([fetchFailed(), fetchFailed(), fetchFailed(), 200]);
    await expect(
      retryIdempotent(new Request(URL_), { ...fast, send: b.go }),
    ).rejects.toThrow("fetch failed");
    expect(b.calls).toHaveLength(3);
  });

  it("notes each retry on the running test", async () => {
    const meta = {};
    setCurrentTest(() => ({ meta }));
    const s = scripted([fetchFailed(), 200]);
    await retryIdempotent(new Request(URL_), { ...fast, send: s.go });
    expect(notesOf(meta)).toEqual([
      "GET /api/v1/me retried (try 2 of 3; ECONNRESET)",
    ]);
  });
});

describe("sendProbe", () => {
  it("no response: one more try, then the answer (whatever its status)", async () => {
    const s = scripted([fetchFailed(), 403]);
    expect((await sendProbe(new Request(URL_), s.go)).status).toBe(403);
    expect(s.calls).toHaveLength(2);
  });

  it("no response twice: infra, never a verdict", async () => {
    const s = scripted([fetchFailed(), fetchFailed()]);
    const e = await sendProbe(
      new Request(URL_, { method: "POST", body: "p" }),
      s.go,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InfraError);
    expect(infraOf([e as Error])).toMatch(
      /^infra: probe POST \/api\/v1\/me on rl-b\.example\.test got no response twice \(ECONNRESET\)/,
    );
    expect(s.calls).toEqual(["POST p", "POST p"]);
  });

  it("a response is never retried, and nor is another error", async () => {
    const a = scripted([500, 200]);
    expect((await sendProbe(new Request(URL_), a.go)).status).toBe(500);
    expect(a.calls).toHaveLength(1);
    const b = scripted([new Error("boom"), 200]);
    await expect(sendProbe(new Request(URL_), b.go)).rejects.toThrow("boom");
  });
});

describe("setup publishes", () => {
  it("no response: infra at once, never retried", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      throw fetchFailed();
    }) as unknown as typeof fetch;
    const e = await setupFetch(
      "rl-b",
      new Request(URL_, { method: "POST", body: "{}" }),
      { fetch: f },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InfraError);
    expect((e as Error).message).toBe(
      "infra: setup publish got no response on rl-b (ECONNRESET)",
    );
    expect(calls).toBe(1);
  });
});

describe("deleteThrowaways", () => {
  const t = { name: "rl-b", app: "https://rl-b.example.test" } as Target;
  const pat = { kind: "pat", token: "x" } as const;

  it("one retry per id, counts failures, never throws mid-loop", async () => {
    const s = scripted([
      fetchFailed(), // id 1: retried
      204,
      fetchFailed(), // id 2: fails twice
      new Error("boom"),
      500, // id 3: 500 then 404 (already gone)
      404,
    ]);
    expect(await deleteThrowaways(t, pat, ["1", "2", "3"], s.go)).toBe(1);
    expect(s.calls).toHaveLength(6);
  });
});

describe("notes", () => {
  it("outside a test: kept for the file", () => {
    note("GET /healthz retried");
    expect(takeFileNotes()).toEqual(["GET /healthz retried"]);
    expect(takeFileNotes()).toEqual([]);
  });
});
