import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import {
  BUS_HUB_TIMEOUT_MS,
  busView,
  listBusAgents,
} from "../../src/services/bus.js";
import { e, machine, member } from "./helpers.js";

// services/bus.ts busView's `live`: whether the hub's state is known (#1300
// review M1, Backend's spec). One case each: never connected (known, no hub
// read), hub read ok, hub read failed, hub read timed out, bus unbound, hosted.

/** Marks `id` as having connected once (what /bus/connect writes). */
const connectedOnce = (id: string) =>
  e.DB.prepare("update bus_machines set last_used_at = ? where id = ?")
    .bind(Date.now(), id)
    .run();

/** An env whose BUS_HUB stub answers snapshot() with `snapshot`; counts the calls. */
function fakeHub(snapshot: () => Promise<unknown>) {
  const seen = { snapshots: 0 };
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      snapshot: () => {
        seen.snapshots++;
        return snapshot();
      },
    }),
  };
  return { env: { ...e, BUS_HUB: ns } as unknown as Env, seen };
}

describe("busView live", () => {
  it("no unrevoked machine ever connected: live, no agents, connected false, and no hub read", async () => {
    const m = await member();
    const a = await machine("never", m.userId);
    const { env, seen } = fakeHub(() => Promise.reject(new Error("read")));
    const v = await busView(env, m.userId);
    expect(v.live).toBe(true);
    expect(v.agents).toEqual([]);
    expect(v.machines.map((x) => [x.id, x.connected])).toEqual([[a.id, false]]);
    expect(seen.snapshots).toBe(0);
  });

  it("a revoked machine that connected doesn't count: still live with no hub answer", async () => {
    const m = await member();
    const old = await machine("old", m.userId);
    await connectedOnce(old.id);
    await e.DB.prepare("update bus_machines set revoked_at = ? where id = ?")
      .bind(Date.now(), old.id)
      .run();
    await machine("never", m.userId);
    const { env } = fakeHub(() => Promise.reject(new Error("read")));
    const v = await busView(env, m.userId);
    expect(v.live).toBe(true);
    expect(v.machines.every((x) => x.connected === false)).toBe(true);
  });

  it("a machine connected and the hub answers: live, connected from the hub", async () => {
    const m = await member();
    const a = await machine("on", m.userId);
    const b = await machine("off", m.userId);
    await connectedOnce(a.id);
    await connectedOnce(b.id);
    const { env } = fakeHub(async () => ({ connected: [a.id], agents: [] }));
    const v = await busView(env, m.userId);
    expect(v.live).toBe(true);
    expect(
      Object.fromEntries(v.machines.map((x) => [x.id, x.connected])),
    ).toEqual({
      [a.id]: true,
      [b.id]: false,
    });
  });

  it("a machine connected and the hub read fails: not live, connected null", async () => {
    const m = await member();
    const a = await machine("on", m.userId);
    await connectedOnce(a.id);
    const { env, seen } = fakeHub(() => Promise.reject(new Error("read")));
    const v = await busView(env, m.userId);
    expect(seen.snapshots).toBe(1);
    expect(v.live).toBe(false);
    expect(v.agents).toEqual([]);
    expect(v.machines[0]?.connected).toBeNull();
  });

  it(
    "a machine connected and the hub read times out: not live, connected null",
    async () => {
      const m = await member();
      const a = await machine("on", m.userId);
      await connectedOnce(a.id);
      const { env } = fakeHub(() => new Promise(() => {}));
      const v = await busView(env, m.userId);
      expect(v.live).toBe(false);
      expect(v.machines[0]?.connected).toBeNull();
    },
    BUS_HUB_TIMEOUT_MS + 10_000,
  );

  it("the bus unbound or hosted: not live, even with no machine that ever connected", async () => {
    const m = await member();
    await machine("never", m.userId);
    const unbound = { ...e, BUS_HUB: undefined } as Env;
    const hosted = { ...e, HOSTED: "1" } as Env;
    for (const env of [unbound, hosted]) {
      const v = await busView(env, m.userId);
      expect(v.live).toBe(false);
      expect(v.agents).toEqual([]);
      expect(v.machines[0]?.connected).toBe(false);
    }
  });
});

describe("listBusAgents", () => {
  it("never connected: no agents, live", async () => {
    const m = await member();
    await machine("never", m.userId);
    expect(await listBusAgents(e, m.userId)).toEqual({
      agents: [],
      live: true,
    });
  });
});
