import { afterEach, describe, expect, it, vi } from "vitest";
import { HEALTH_ASKS_MAX, liveFetch } from "./live-fetch.js";

const seq = (...steps: (number | Error)[]) => {
  const calls: Request[] = [];
  const f = (async (r: Request) => {
    calls.push(r);
    const s = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (s instanceof Error) throw s;
    return new Response("x", { status: s });
  }) as typeof fetch;
  return { f, calls };
};
const o = (
  f: typeof fetch,
  healthy: (origin: string) => Promise<boolean> = async () => true,
) => ({
  fetch: f,
  healthy,
});

describe("liveFetch (xt:live, flake server #2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a GET on a thrown error, then answers", async () => {
    const { f, calls } = seq(new TypeError("fetch failed"), 200);
    const r = await liveFetch(new Request("https://x.test/healthz"), o(f));
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("retries 502/503/504, at most 3 tries", async () => {
    const { f, calls } = seq(502, 503, 504, 200);
    const r = await liveFetch(new Request("https://x.test/"), o(f));
    expect(r.status).toBe(504);
    expect(calls).toHaveLength(3);
  });

  it("waits for a health answer before it resends, and asks the host's origin", async () => {
    const { f, calls } = seq(new TypeError("fetch failed"), 200);
    const events: string[] = [];
    let asks = 0;
    const healthy = async (origin: string) => {
      events.push(`health ${origin} (${calls.length} sent)`);
      return ++asks >= 3;
    };
    const r = await liveFetch(
      new Request("https://x.test/a/b?q=1"),
      o(f, healthy),
    );
    expect(r.status).toBe(200);
    // The resend came only after the third health answer, not before.
    expect(asks).toBe(3);
    expect(events).toEqual(Array(3).fill("health https://x.test (1 sent)"));
    expect(calls).toHaveLength(2);
  });

  it("by default the health answer is GET <origin>/healthz returning 200", async () => {
    const seen: string[] = [];
    let n = 0;
    const f = (async (r: Request | string) => {
      const url = typeof r === "string" ? r : r.url;
      seen.push(url);
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      if (++n === 1) throw new TypeError("fetch failed");
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    const r = await liveFetch(new Request("https://x.test/a?q=1"), {
      fetch: f,
    });
    expect(r.status).toBe(200);
    expect(seen).toEqual([
      "https://x.test/a?q=1",
      "https://x.test/healthz",
      "https://x.test/a?q=1",
    ]);
  });

  it("does not ask the host before the first try, nor after a 4xx", async () => {
    const { f } = seq(404);
    let asks = 0;
    await liveFetch(
      new Request("https://x.test/"),
      o(f, async () => {
        asks++;
        return true;
      }),
    );
    expect(asks).toBe(0);
  });

  it("resends once the health wait is up when the host never answers, and not before", async () => {
    // Only Date is faked; each health ask moves it forward by STEP, so the
    // wait runs out on the fake clock and no wall time is spent.
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const STEP = 100;
    const WAIT = 500;
    const asks: { at: number; sentThen: number; left: number }[] = [];
    const sent: number[] = [];
    const f = (async () => {
      sent.push(Date.now());
      return new Response("x", { status: sent.length === 1 ? 503 : 200 });
    }) as typeof fetch;
    const r = await liveFetch(new Request("https://x.test/"), {
      fetch: f,
      healthy: async (_origin, left) => {
        asks.push({ at: Date.now(), sentThen: sent.length, left });
        vi.advanceTimersByTime(STEP);
        return false;
      },
      healthWaitMs: WAIT,
    });
    expect(r.status).toBe(200);
    // Every ask before the deadline saw exactly one request; the last came
    // one step before it. The second request followed, once, at the deadline.
    expect(asks.map((a) => a.at)).toEqual([0, 100, 200, 300, 400]);
    for (const a of asks) expect(a.sentThen).toBe(1);
    // Each ask may take only what is left of the wait (a held /healthz
    // cannot carry the resend past the deadline).
    expect(asks.map((a) => a.left)).toEqual([500, 400, 300, 200, 100]);
    expect(sent).toEqual([0, WAIT]);
  });

  it("the default health ask is bounded by what is left of the wait", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const bounds: (AbortSignal | null | undefined)[] = [];
    const f = (async (r: Request | string, init?: RequestInit) => {
      const url = typeof r === "string" ? r : r.url;
      if (url.endsWith("/healthz")) {
        bounds.push(init?.signal);
        return new Response("ok", { status: 200 });
      }
      return new Response("x", { status: bounds.length === 0 ? 503 : 200 });
    }) as typeof fetch;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const r = await liveFetch(new Request("https://x.test/"), {
      fetch: f,
      timeoutMs: 400,
      healthWaitMs: 20,
    });
    expect(r.status).toBe(200);
    expect(bounds).toHaveLength(1);
    // The health ask's own bound is the 20 ms left of the wait, not 400.
    expect(timeout.mock.calls.map((c) => c[0])).toContain(20);
    timeout.mockRestore();
  });

  it("asks a host that refuses at once at most HEALTH_ASKS_MAX times, then resends once", async () => {
    // The clock never moves and the answer is instant: only the cap ends it.
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const { f, calls } = seq(503, 200);
    let asks = 0;
    const r = await liveFetch(new Request("https://x.test/"), {
      fetch: f,
      healthy: async () => {
        asks++;
        // Past the cap, answer so an uncapped loop ends and fails the count
        // below instead of hanging.
        return asks > HEALTH_ASKS_MAX * 2;
      },
      healthWaitMs: 10_000,
    });
    expect(r.status).toBe(200);
    expect(asks).toBe(HEALTH_ASKS_MAX);
    expect(calls).toHaveLength(2);
  });

  it("never retries a 4xx", async () => {
    const { f, calls } = seq(404, 200);
    const r = await liveFetch(new Request("https://x.test/"), o(f));
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("never retries a POST", async () => {
    const { f, calls } = seq(new TypeError("fetch failed"), 200);
    await expect(
      liveFetch(
        new Request("https://x.test/auth/code/request", {
          method: "POST",
          body: "{}",
        }),
        o(f),
      ),
    ).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(1);
  });

  it("bounds every attempt", async () => {
    // A real fetch holds its in-flight Request. This fake must too: if only
    // the abort listener points at it, a GC in a busy full run collects the
    // Request with its signal and listener, the abort never reaches it, and
    // the test hangs to vitest's 30 s limit.
    const inFlight: Request[] = [];
    const hang = ((r: Request) => {
      inFlight.push(r);
      return new Promise((_, rej) =>
        r.signal.addEventListener("abort", () => rej(r.signal.reason)),
      );
    }) as typeof fetch;
    await expect(
      liveFetch(new Request("https://x.test/", { method: "POST" }), {
        fetch: hang,
        timeoutMs: 20,
      }),
    ).rejects.toThrow();
    expect(inFlight).toHaveLength(1);
  });
});
