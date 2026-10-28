import { describe, expect, it } from "vitest";
import { liveFetch } from "./live-fetch.js";

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
const o = (f: typeof fetch) => ({ fetch: f, backoffMs: 1 });

describe("liveFetch (xt:live, flake server #2)", () => {
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
    const hang = ((r: Request) =>
      new Promise((_, rej) =>
        r.signal.addEventListener("abort", () => rej(r.signal.reason)),
      )) as typeof fetch;
    await expect(
      liveFetch(new Request("https://x.test/", { method: "POST" }), {
        fetch: hang,
        timeoutMs: 20,
      }),
    ).rejects.toThrow();
  });
});
