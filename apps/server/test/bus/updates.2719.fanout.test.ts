// #2719: a run-version change reaches members a page at a time. The request
// tells the owner and the first page; a cursor in settings carries the rest to
// the recovery cron, which tells one page per tick.
import { BUS_CAPS, type ClientFrame, PING, PONG } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  drainRunVersionFanout,
  RUN_VERSION_FANOUT_KEY,
  setBusRunVersion,
} from "../../src/services/bus.js";
import {
  type Daemon,
  daemon,
  e,
  framesSeen,
  hello,
  machine,
  member,
  waitFor,
} from "./helpers.js";
import { eventually } from "./helpers.ts";

const CAP = [BUS_CAPS.runVersion];
const CORE = "0.1.0";

const cursor = async () => {
  const r = await e.DB.prepare("select value from settings where key = ?")
    .bind(RUN_VERSION_FANOUT_KEY)
    .first<{ value: string }>();
  return r ? (JSON.parse(r.value) as { after: string; gen: string }) : null;
};

/** The owner and n members each with a connected, cap'd machine; no other live machine. */
async function setup(n: number) {
  await e.DB.prepare("update bus_machines set revoked_at = 1").run();
  await e.DB.prepare("delete from settings where key in (?, 'bus_run_version')")
    .bind(RUN_VERSION_FANOUT_KEY)
    .run();
  const owner = await member("owner");
  const ds = new Map<string, Daemon>();
  for (let i = 0; i < n; i++) {
    const who = await member();
    const m = await machine("m", who.userId);
    const d = await daemon(m.token);
    d.send({ ...hello(`h${i}`), caps: CAP } as ClientFrame);
    await waitFor(d, "hello_ok");
    ds.set(who.userId, d);
  }
  const order = [...ds.keys()].sort();
  /**
   * How many run_version pushes the member's socket got. A ping
   * is the round trip (its pong arrives after every frame sent before it,
   * and unlike a hello it makes the hub send nothing of its own).
   */
  const heard = async (id: string) => {
    const d = ds.get(id) as Daemon;
    const pongs = () => d.raw.filter((t) => t === PONG).length;
    const n = pongs();
    d.ws.send(PING);
    await eventually(() => expect(pongs()).toBeGreaterThan(n));
    // The hello's own answer is the first run_version frame.
    return framesSeen(d).filter((f) => f.type === "run_version").length - 1;
  };
  return { owner, order, heard };
}

describe("run-version fan-out pages (#2719)", () => {
  it("pages by user_id: request, then cron ticks, then the cursor is gone", async () => {
    const { owner, order, heard } = await setup(5);
    await setBusRunVersion(e, owner.userId, CORE, false, 2);
    expect((await cursor())?.after).toBe(order[1]);
    expect(await Promise.all(order.map(heard))).toEqual([1, 1, 0, 0, 0]);
    await drainRunVersionFanout(e, 2);
    expect((await cursor())?.after).toBe(order[3]);
    expect(await Promise.all(order.map(heard))).toEqual([1, 1, 1, 1, 0]);
    await drainRunVersionFanout(e, 2);
    expect(await cursor()).toBeNull();
    expect(await Promise.all(order.map(heard))).toEqual([1, 1, 1, 1, 1]);
    await drainRunVersionFanout(e, 2); // nothing stored: a no-op
    expect(await Promise.all(order.map(heard))).toEqual([1, 1, 1, 1, 1]);
  });

  it("a newer change mid-drain restarts from the start with a new gen", async () => {
    const { owner, order, heard } = await setup(4);
    await setBusRunVersion(e, owner.userId, CORE, false, 2);
    const first = await cursor();
    await setBusRunVersion(e, owner.userId, null, false, 2);
    const second = await cursor();
    expect(second?.after).toBe(order[1]);
    expect(second?.gen).not.toBe(first?.gen);
    await drainRunVersionFanout(e, 2);
    expect(await cursor()).toBeNull();
    expect(await Promise.all(order.map(heard))).toEqual([2, 2, 1, 1]);
  });

  it("a drain advances whatever cursor it read, by compare-and-set", async () => {
    const { owner, order } = await setup(4);
    await setBusRunVersion(e, owner.userId, CORE, false, 1);
    const newer = JSON.stringify({ after: order[0], gen: "newer" });
    await e.DB.prepare("update settings set value = ? where key = ?")
      .bind(newer, RUN_VERSION_FANOUT_KEY)
      .run();
    await drainRunVersionFanout(e, 1);
    // It read "newer" itself, so it advanced that one; gen is unchanged.
    expect((await cursor())?.gen).toBe("newer");
  });

  it("members within one page store nothing and clear an old cursor", async () => {
    const { owner } = await setup(2);
    await e.DB.prepare("insert into settings (key, value) values (?, ?)")
      .bind(RUN_VERSION_FANOUT_KEY, JSON.stringify({ after: "a", gen: "old" }))
      .run();
    await setBusRunVersion(e, owner.userId, CORE, false, 2);
    expect(await cursor()).toBeNull();
  });
});
