import { describe, expect, it } from "vitest";
import { boundFetch } from "../src/fetch-timeout.ts";

/** A fetch that answers only when its signal aborts, with the abort reason. */
const stalled: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const s = init?.signal;
    if (!s) return;
    s.addEventListener("abort", () => reject(s.reason), { once: true });
  });

describe("boundFetch", () => {
  it("a request that never answers rejects with a timeout", async () => {
    await expect(boundFetch(stalled, 20)("http://x.invalid/")).rejects.toThrow(
      /timeout|aborted/i,
    );
  });

  it("keeps the caller's own signal", async () => {
    const c = new AbortController();
    const p = boundFetch(stalled, 60_000)("http://x.invalid/", {
      signal: c.signal,
    });
    c.abort(new Error("caller abort"));
    await expect(p).rejects.toThrow("caller abort");
  });

  it("keeps a Request's own signal", async () => {
    const c = new AbortController();
    const p = boundFetch(
      stalled,
      60_000,
    )(new Request("http://x.invalid/", { signal: c.signal }));
    c.abort(new Error("request abort"));
    await expect(p).rejects.toThrow("request abort");
  });

  it("passes the answer and init through", async () => {
    let seen: RequestInit | undefined;
    const ok: typeof fetch = async (_i, init) => {
      seen = init;
      return new Response("ok", { status: 201 });
    };
    const r = await boundFetch(ok)("http://x.invalid/", {
      method: "POST",
      redirect: "manual",
    });
    expect(r.status).toBe(201);
    expect(seen?.method).toBe("POST");
    expect(seen?.redirect).toBe("manual");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});
