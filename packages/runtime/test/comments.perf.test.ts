import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Count how often anchors are resolved: scroll and resize must never do it.
const resolved = vi.hoisted(() => ({ calls: 0, builds: 0 }));
vi.mock("@oa/shared", async (orig) => {
  const m = await orig<typeof import("@oa/shared")>();
  return {
    ...m,
    createTextResolver: (text: string) => {
      resolved.builds++;
      const r = m.createTextResolver(text);
      return (a: Parameters<typeof r>[0]) => {
        resolved.calls++;
        return r(a);
      };
    },
  };
});

import { type ArtifactToShell, createTextAnchor } from "@oa/shared";
import { createComments } from "../src/comments.js";

let seed = 7;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function pageAndThreads() {
  const words: string[] = [];
  for (let i = 0; i < 40_000; i++)
    words.push(Math.floor(rnd() * 36 ** 6).toString(36));
  const paras: string[] = [];
  for (let i = 0; i < words.length; i += 25)
    paras.push(words.slice(i, i + 25).join(" "));
  document.body.innerHTML = paras.map((p) => `<p>${p}</p>`).join("");
  const text = Array.from(document.querySelectorAll("p"))
    .map((p) => p.textContent)
    .join("");
  const threads = Array.from({ length: 100 }, (_, i) => {
    const at = 500 + i * 1900;
    let a = createTextAnchor(text, at, at + 40, 1);
    if (i % 2)
      a = { ...a, exact: `${a.exact.slice(0, 20)}#${a.exact.slice(21)}` };
    return { id: `t${i}`, anchor: a };
  });
  return threads;
}

function boot() {
  const handlers: ((m: unknown) => void)[] = [];
  const sent: ArtifactToShell[] = [];
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    frames.push(cb),
  );
  const c = createComments({
    on: (l) => {
      handlers.push(l as (m: unknown) => void);
      return () => {};
    },
    send: (m) => void sent.push(m),
  });
  const shell = (m: object) => {
    for (const h of handlers) h({ oa: 1, ...m });
  };
  const frame = () => {
    for (const cb of frames.splice(0)) cb(0);
  };
  return { c, shell, frame, sent };
}

/**
 * Worst measured wall time of one full re-anchor pass over this fixture (100
 * anchors over a 40,000-word page): the 91-105 ms a frame costs when the 1 s
 * max wait fires, measured on a 24-core host quiet and with the package suite
 * plus 4 CPU hogs (90.6-105.3 ms over 10 runs). The first pass, on
 * `comments.set`, costs the same (99-108 ms).
 */
const ANCHOR_PASS_MS = 105;
/**
 * The work: `comments.set`'s first pass, then one pass per frame in the worst
 * case (this page mutates every frame, so every frame may re-anchor).
 */
const ANCHOR_PASSES = 1 + 30;
/**
 * Slack over ANCHOR_PASS_MS for a runner slower than the worst one measured: a
 * CI shard takes this test 2.0 s where it takes 0.43 s here (4.6x).
 */
const ANCHOR_HEADROOM = 3;
/**
 * Per-test timeout from its own work: passes x worst pass x headroom (9,765
 * ms). The 5 s default is 1.5x the worst-case work (31 x 105 ms = 3,255 ms),
 * which is what made this case flake on a loaded runner (#1575).
 */
const ANCHOR_TIMEOUT_MS = ANCHOR_PASSES * ANCHOR_PASS_MS * ANCHOR_HEADROOM;

describe("many anchors", () => {
  beforeEach(() => {
    resolved.calls = 0;
    resolved.builds = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves once per text version; scroll and resize only re-measure", async () => {
    const threads = pageAndThreads();
    const { c, shell, frame } = boot();
    const t0 = performance.now();
    shell({ type: "comments.mode", mode: "select" });
    shell({ type: "comments.set", threads });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(resolved.builds).toBe(1);
    expect(resolved.calls).toBe(100);
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
      frame();
      c.flush();
    }
    expect(resolved.builds).toBe(1);
    expect(resolved.calls).toBe(100);
    c.dispose();
  });

  it(
    "a page that mutates every frame re-resolves on the timer only, and still re-anchors",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const threads = pageAndThreads();
      const { c, shell, frame } = boot();
      shell({ type: "comments.mode", mode: "select" });
      shell({ type: "comments.set", threads });
      expect(resolved.builds).toBe(1);
      const p = document.querySelector("p") as HTMLElement;
      for (let i = 0; i < 30; i++) {
        p.append("x"); // a mutation between every pair of scroll frames
        await flush();
        window.dispatchEvent(new Event("scroll"));
        frame();
        await vi.advanceTimersByTimeAsync(100); // never 150 ms quiet: only the max wait fires
      }
      // 3 s of constant change: the 1 s max wait fires about 3 times, never per frame
      expect(resolved.builds).toBeGreaterThanOrEqual(2);
      expect(resolved.builds).toBeLessThanOrEqual(5);
      // once the page settles, the trailing timer lands one more
      const before = resolved.builds;
      await vi.advanceTimersByTimeAsync(200);
      expect(resolved.builds).toBeLessThanOrEqual(before + 1);
      c.dispose();
    },
    ANCHOR_TIMEOUT_MS,
  );
});
