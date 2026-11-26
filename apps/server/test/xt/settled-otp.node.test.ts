import { describe, expect, it } from "vitest";
import { buffered, type SettleOtp, settleOtp } from "./settled-otp.js";

// A fake clock and a fake ask: the helper's time is `t`, moved by the test.
type R = { status: number; outcome?: string };

function rig(over: Partial<SettleOtp<R>> & { ask: SettleOtp<R>["ask"] }) {
  let t = 1_000;
  const aborts: AbortController[] = [];
  const signals: number[] = [];
  const run = () =>
    settleOtp<R>({
      outcome: async (r) => r.outcome ?? null,
      deadlineMs: 13_000,
      holdMs: 8_000,
      quickMax: 20,
      fail: (m) => new Error(m),
      where: "https://x",
      now: () => t,
      signalFor: (ms) => {
        signals.push(ms);
        const c = new AbortController();
        aborts.push(c);
        return c.signal;
      },
      ...over,
    });
  return {
    run,
    advance: (ms: number) => {
      t += ms;
    },
    aborts,
    signals,
  };
}

describe("settleOtp", () => {
  it("returns a code, and a final 404, as they are", async () => {
    const a = rig({ ask: async () => ({ status: 200 }) });
    expect((await a.run()).status).toBe(200);
    const b = rig({ ask: async () => ({ status: 404, outcome: "sent" }) });
    expect((await b.run()).status).toBe(404);
  });

  it("each ask holds for the time left at most, and is cut off at the deadline", async () => {
    const waits: number[] = [];
    let n = 0;
    let advance: (ms: number) => void = () => {};
    const r = rig({
      ask: async (wait) => {
        waits.push(wait);
        advance(wait); // the hold runs its whole length
        return n++ < 1
          ? { status: 404, outcome: "pending" }
          : { status: 404, outcome: "sent" };
      },
    });
    advance = r.advance;
    await r.run();
    // 13 s in all: a first hold of 8 s, then the 5 s left (not another 8).
    expect(waits).toEqual([8_000, 5_000]);
    expect(r.signals).toEqual([13_000, 5_000]);
  });

  it("a response that arrives after the bound is refused, even a final one", async () => {
    let advance: (ms: number) => void = () => {};
    const r = rig({
      ask: async () => {
        advance(14_000); // the answer comes at 14 s against a 13 s bound
        return { status: 404, outcome: "sent" };
      },
    });
    advance = r.advance;
    await expect(r.run()).rejects.toThrow(/answered after the 13000 ms bound/);
  });

  it("a held ask that never answers fails at the deadline, not after", async () => {
    const r = rig({ ask: () => new Promise<R>(() => {}) });
    const p = r.run();
    const caught = p.then(
      () => new Error("resolved"),
      (e: Error) => e,
    );
    await Promise.resolve();
    expect(r.aborts).toHaveLength(1);
    r.aborts[0]?.abort(); // the deadline's signal fires
    expect((await caught).message).toMatch(/still pending after 13000 ms/);
  });

  it("pending until the deadline fails with still pending", async () => {
    let advance: (ms: number) => void = () => {};
    const r = rig({
      ask: async (wait) => {
        advance(wait);
        return { status: 404, outcome: "pending" };
      },
    });
    advance = r.advance;
    await expect(r.run()).rejects.toThrow(/still pending after 13000 ms/);
  });

  it("an install that answers pending at once is judged not to hold", async () => {
    const r = rig({ ask: async () => ({ status: 404, outcome: "pending" }) });
    await expect(r.run()).rejects.toThrow(/without holding the request/);
  });

  it("a 404 with no recognized outcome fails at once", async () => {
    const r = rig({ ask: async () => ({ status: 404 }) });
    await expect(r.run()).rejects.toThrow(/no recognized outcome/);
  });
});

describe("settleOtp with the body read inside the ask", () => {
  /** A 404 whose headers are in and whose body arrives when `release` is called. */
  function slowBody() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await gate;
        c.enqueue(
          new TextEncoder().encode('{"error":{"details":{"outcome":"sent"}}}'),
        );
        c.close();
      },
    });
    return { res: new Response(body, { status: 404 }), release };
  }
  const outcome = async (r: Response) =>
    ((await r.clone().json()) as { error: { details: { outcome: string } } })
      .error.details.outcome;

  it("headers on time, body after the bound: refused", async () => {
    const { res, release } = slowBody();
    let t = 1_000;
    const p = settleOtp<Response>({
      ask: async (_w, signal) => {
        const b = buffered(res, signal);
        t += 14_000; // the body lands past the 13 s bound
        release();
        return b;
      },
      outcome,
      deadlineMs: 13_000,
      holdMs: 8_000,
      quickMax: 20,
      fail: (m) => new Error(m),
      where: "https://x",
      now: () => t,
      signalFor: () => new AbortController().signal,
    });
    await expect(p).rejects.toThrow(/answered after the 13000 ms bound/);
  });

  it("a body that never ends is cut off with the deadline", async () => {
    const { res } = slowBody(); // never released
    const c = new AbortController();
    const p = settleOtp<Response>({
      ask: (_w, signal) => buffered(res, signal),
      outcome,
      deadlineMs: 13_000,
      holdMs: 8_000,
      quickMax: 20,
      fail: (m) => new Error(m),
      where: "https://x",
      signalFor: () => c.signal,
    }).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await Promise.resolve();
    c.abort();
    expect(await p).toMatch(/still pending after 13000 ms/);
  });

  it("a body on time is read once and kept for later reads", async () => {
    const r = await buffered(
      new Response("hello", { status: 200 }),
      new AbortController().signal,
    );
    expect(await r.text()).toBe("hello");
    expect(r.status).toBe(200);
  });
});
