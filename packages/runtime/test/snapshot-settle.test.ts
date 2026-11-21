import { describe, expect, it } from "vitest";
import { SETTLE, type SettleProbe, settle } from "../src/snapshot.js";

/** A probe on a virtual clock: sleep advances time, and each tick may change the page. */
function probe(page: {
  loadedAt?: number;
  imagesAt?: number;
  /** Times at which a new resource starts loading. */
  fetches?: number[];
}): SettleProbe & { t: number } {
  const p = {
    t: 0,
    loaded: () => p.t >= (page.loadedAt ?? 0),
    imagesDone: () => p.t >= (page.imagesAt ?? 0),
    resources: () => (page.fetches ?? []).filter((at) => at <= p.t).length,
    now: () => p.t,
    sleep: async (ms: number) => {
      p.t += ms;
    },
  };
  return p;
}

describe("settle", () => {
  it("returns once a loaded page has been quiet for quietMs", async () => {
    const p = probe({});
    await settle(p);
    expect(p.t).toBe(SETTLE.quietMs);
  });

  it("waits for images that are still loading", async () => {
    const p = probe({ imagesAt: 1_200 });
    await settle(p);
    expect(p.t).toBe(1_200);
  });

  it("waits for the load event", async () => {
    const p = probe({ loadedAt: 900 });
    await settle(p);
    expect(p.t).toBe(900);
  });

  it("restarts the quiet window when a new resource starts", async () => {
    // Each fetch lands inside the previous quiet window, so the wait runs to 700 + quietMs.
    const p = probe({ fetches: [0, 300, 700] });
    await settle(p);
    expect(p.t).toBe(700 + SETTLE.quietMs);
  });

  it("gives up at maxMs on a page that never settles", async () => {
    const p = probe({ imagesAt: Number.POSITIVE_INFINITY });
    await settle(p);
    expect(p.t).toBe(SETTLE.maxMs);
  });
});
