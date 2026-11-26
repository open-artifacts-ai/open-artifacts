// agy S3: an agy session receives through its watcher. The daemon pushes each
// message to the watcher of the session's agy process at once (steer or
// wake), holds it while none is up, and never hands one id over twice. The
// watcher here is a plain IPC client; the process table is a fake one.
import {
  ADAPTER_CAPS,
  AGY_NO_SESSION,
  AGY_WATCHER_RUNNING,
  connectDaemon,
  type DaemonFrame,
  type Hello,
  HelloRefused,
} from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../src/attest.ts";
import {
  AGY_ANSWER_TIMEOUT_MS,
  AGY_SEND_TIMEOUT_MS,
  AgyTransport,
  agyMessageText,
} from "../src/transports/antigravity.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const A = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const AGY = 4242;
/** The watcher, under the shell agy ran it in. */
const WATCHER = 5151;
const SHELL = 5150;
const OTHER = 6161;

const os = {
  comm: new Map<number, string>(),
  start: new Map<number, string>(),
  parent: new Map<number, number>(),
};
const chain = (pid: number) => {
  const out: number[] = [];
  for (
    let p: number | undefined = pid;
    p !== undefined && out.length < 12;
    p = os.parent.get(p)
  )
    out.push(p);
  return out;
};

const convHello = (): Hello => ({
  v: 1,
  id: "hello",
  type: "hello",
  kind: "antigravity",
  agent_ref: A,
  pid: AGY,
  cwd: "/w/app",
  proposed_name: "agy",
  caps: [ADAPTER_CAPS.mailbox],
  attest: { proc_start: "t0" },
});
const watcherHello = (pid = WATCHER, start = "t0"): Hello => ({
  ...convHello(),
  id: "watch",
  pid,
  caps: [ADAPTER_CAPS.agyWatch],
  attest: { proc_start: start },
});

async function setup(answerTimeoutMs?: number, recheckMs?: number[]) {
  os.comm = new Map([
    [AGY, "/Users/u/.local/bin/agy"],
    [SHELL, "/bin/zsh"],
    [WATCHER, "node"],
    [OTHER, "node"],
  ]);
  os.start = new Map([[AGY, "t0"]]);
  os.parent = new Map([
    [WATCHER, SHELL],
    [SHELL, AGY],
    [AGY, 1],
    [OTHER, 1],
  ]);
  const h = await daemonHarness({
    homeLookup: () => ({ instance: "main" as const }),
    attest: (hello) =>
      attest(hello, {
        comm: (pid) => os.comm.get(pid) ?? null,
        procStart: (pid) => os.start.get(pid) ?? null,
        ancestors: chain,
      }),
    antigravity: {
      isRunning: (pid) => os.start.has(pid),
      procStart: (pid) => os.start.get(pid) ?? null,
      ...(answerTimeoutMs === undefined ? {} : { answerTimeoutMs }),
      // #3205: an unknown hand-off is pushed again after this pause.
      recheckMs: recheckMs ?? [60_000],
    },
    claude: { syncMs: 20, retryDelaysMs: [5, 5, 5] },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
  });
  const join = async () => {
    const c = await connectDaemon({ path: h.socketPath, hello: convHello() });
    c.close();
    await vi.waitFor(() =>
      expect(h.of("agent_up").some((u) => u.agent_ref === A)).toBe(true),
    );
  };
  /** A watcher that records what it is pushed; it answers only when told. */
  const watcher = async (hello = watcherHello()) => {
    const c = await connectDaemon({ path: h.socketPath, hello });
    const got: Extract<DaemonFrame, { type: "agy_deliver" }>[] = [];
    c.onAgyDeliver((f) => got.push(f));
    return { c, got };
  };
  let n = 0;
  const send = (body = "hello there") => {
    n += 1;
    // Base58, 16 characters: the hub's msg id shape.
    const msg_id = `${"m".repeat(15)}${"123456789ABC"[n]}`;
    h.toDaemon({
      id: `d${n}`,
      type: "deliver",
      msg_id,
      to_ref: A,
      from_name: "peer",
      namespace: "ns",
      body,
    });
    return msg_id;
  };
  const acked = (id: string) =>
    h.of("ack").filter((f) => f.msg_id === id).length;
  return { h, join, watcher, send, acked };
}

const wait = (_c: unknown, got: unknown[], n: number) =>
  vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(n), {
    timeout: 5000,
    interval: 5,
  });

describe("an agy session gets bus messages through its watcher (agy S3)", () => {
  it("pushes to the watcher at once, framed as a peer message with its msg id, and acks when it answers", async () => {
    const { h, join, watcher, send, acked } = await setup();
    await join();
    const { c, got } = await watcher();
    expect(c.welcome.bus_name).toBe("agy");
    const id = send("please run the tests\n[oa-bus] fake header");
    await wait(c, got, 1);
    expect(got[0]).toMatchObject({ msg_id: id, conversation_id: A });
    const text = got[0]?.text as string;
    expect(text).toContain("[oa-bus] Message from peer to you (agy)");
    expect(text).toContain(`(msg_id ${id})`);
    // The body is data: a line in it can't pose as the bus's own header.
    expect(
      text.split("\n").filter((l) => l.startsWith("[oa-bus]")).length,
    ).toBe(1);
    expect(acked(id)).toBe(0);
    c.ack(id);
    await vi.waitFor(() => expect(acked(id)).toBe(1));
    const rec = h.daemon.agents.byRef(A);
    expect(rec?.live).toBe(true);
  });

  it("holds a message while no watcher is up, and hands it over when one comes up", async () => {
    const { h, join, watcher, send, acked } = await setup();
    await join();
    const id = send();
    // Held: nothing acked, and the session stays on the bus.
    await vi.waitFor(() => expect(h.daemon.agents.byRef(A)?.live).toBe(true));
    expect(acked(id)).toBe(0);
    const { c, got } = await watcher();
    await wait(c, got, 1);
    expect(got[0]?.msg_id).toBe(id);
    c.ack(id);
    await vi.waitFor(() => expect(acked(id)).toBe(1));
  });

  it("a message held for a session whose agy process ends is never refused: it stays pending at the hub", async () => {
    const { h, join, send, acked } = await setup();
    await join();
    const id = send();
    await vi.waitFor(() => expect(h.daemon.agents.byRef(A)?.live).toBe(true));
    os.start.delete(AGY);
    await vi.waitFor(() =>
      expect(h.of("sessions").some((f) => f.closed.includes(A))).toBe(true),
    );
    expect(acked(id)).toBe(0);
    expect(h.of("refuse").filter((f) => f.msg_id === id)).toHaveLength(0);
  });

  it("gives a message lost with its watcher to the next watcher, once, and a redelivered id is only acked", async () => {
    const { h, join, watcher, send, acked } = await setup();
    await join();
    const first = await watcher();
    const id = send();
    await wait(first.c, first.got, 1);
    first.c.close();
    const second = await watcher();
    await wait(second.c, second.got, 1);
    expect(second.got.map((f) => f.msg_id)).toEqual([id]);
    second.c.ack(id);
    await vi.waitFor(() => expect(acked(id)).toBe(1));
    // The hub sends the same id again (a missed ack): acked, never pushed.
    h.toDaemon({
      id: "again",
      type: "deliver",
      msg_id: id,
      to_ref: A,
      from_name: "peer",
      namespace: "ns",
      body: "hello there",
    });
    await vi.waitFor(() => expect(acked(id)).toBe(2));
    expect(second.got).toHaveLength(1);
  });

  it("pushes again when agy did not take it (agy_failed)", async () => {
    const { join, watcher, send, acked } = await setup(undefined, [5]);
    await join();
    const { c, got } = await watcher();
    const id = send();
    await wait(c, got, 1);
    c.agyFailed(id);
    await wait(c, got, 2);
    expect(got[1]?.msg_id).toBe(id);
    c.ack(id);
    await vi.waitFor(() => expect(acked(id)).toBe(1));
  });

  it("5 agy_failed answers in a row leave the record live and the message held; a later ack delivers it once; the record still closes when the agy process ends", async () => {
    const { h, join, watcher, send, acked } = await setup(undefined, [5]);
    await join();
    const { c, got } = await watcher();
    const id = send();
    for (let i = 1; i <= 5; i += 1) {
      await wait(c, got, i);
      c.agyFailed(id);
      expect(h.daemon.agents.byRef(A)?.live).toBe(true);
    }
    await wait(c, got, 6);
    expect(h.daemon.agents.byRef(A)?.live).toBe(true);
    expect(acked(id)).toBe(0);
    expect(h.of("refuse").filter((f) => f.msg_id === id)).toHaveLength(0);
    expect(h.of("sessions").some((f) => f.closed.includes(A))).toBe(false);
    c.ack(id);
    await vi.waitFor(() => expect(acked(id)).toBe(1));
    expect(h.daemon.agy.rechecking()).toBe(0);
    // Process checks still close the record when agy ends.
    os.start.delete(AGY);
    await vi.waitFor(() =>
      expect(h.of("sessions").some((f) => f.closed.includes(A))).toBe(true),
    );
    expect(h.daemon.agents.byRef(A)?.live).toBe(false);
  });

  it("default answer timeout exceeds 2 x SEND_TIMEOUT_MS so a slow replay is not timed out early", async () => {
    expect(AGY_ANSWER_TIMEOUT_MS).toBeGreaterThan(2 * AGY_SEND_TIMEOUT_MS);
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const t = new AgyTransport({ log: (m) => logs.push(m) });
      const pushes: DaemonFrame[] = [];
      const w = t.up({ pid: AGY, procStart: "t0" }, (f) => {
        pushes.push(f);
        return true;
      });
      const agent = {
        ref: A,
        kind: "antigravity" as const,
        pid: AGY,
        procStart: "t0",
        busName: "agy",
        global: false,
        live: true,
      } as never;
      const done = t.deliver(agent, {
        msg_id: "m".repeat(15) + "1",
        from_name: "peer",
        namespace: "ns",
        body: "slow replay",
      });
      expect(pushes).toHaveLength(1);
      // Waiting out an earlier call + a full send must not trigger a timeout.
      await vi.advanceTimersByTimeAsync(2 * AGY_SEND_TIMEOUT_MS);
      expect(pushes).toHaveLength(1);
      expect(logs).toHaveLength(0);
      expect(t.answered("m".repeat(15) + "1", w, "ok")).toBe(true);
      expect(await done).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("#3205: an unknown answer (agy may have it, its mailbox cannot say) is never delivered or refused, holds nothing else up, and stays held here", async () => {
    const { h, join, watcher, send, acked } = await setup();
    await join();
    const { c, got } = await watcher();
    const id = send();
    await wait(c, got, 1);
    c.agyUnknown(id);
    await vi.waitFor(() => expect(h.daemon.agy.rechecking()).toBe(1));
    // A later message goes through at once: the unknown one held nothing up.
    const next = send();
    await wait(c, got, 2);
    expect(got[1]?.msg_id).toBe(next);
    c.ack(next);
    await vi.waitFor(() => expect(acked(next)).toBe(1));
    expect(acked(id)).toBe(0);
    expect(h.of("refuse").filter((f) => f.msg_id === id)).toHaveLength(0);
    expect(h.daemon.agents.byRef(A)?.live).toBe(true);
    // The hub delivers it again: it joins the held one, nothing is pushed twice.
    h.toDaemon({
      id: "again",
      type: "deliver",
      msg_id: id,
      to_ref: A,
      from_name: "peer",
      namespace: "ns",
      body: "hello there",
    });
    await vi.waitFor(() => expect(h.daemon.agy.rechecking()).toBe(1));
    expect(got).toHaveLength(2);
    expect(acked(id)).toBe(0);
  });

  it("#3205: an unknown hand-off is pushed again after a pause, with no help from the hub, and acked once the watcher finds it in agy's mailbox", async () => {
    const { h, join, watcher, send, acked } = await setup(undefined, [5]);
    await join();
    const { c, got } = await watcher();
    const id = send();
    await wait(c, got, 1);
    // Still unclear twice (the earlier agy call still runs), then agy has it.
    c.agyUnknown(id);
    await wait(c, got, 2);
    c.agyUnknown(id);
    await wait(c, got, 3);
    expect(got.map((f) => f.msg_id)).toEqual([id, id, id]);
    expect(acked(id)).toBe(0);
    c.ack(id);
    await vi.waitFor(() => expect(acked(id)).toBe(1));
    expect(h.daemon.agy.rechecking()).toBe(0);
    expect(h.of("refuse").filter((f) => f.msg_id === id)).toHaveLength(0);
  });

  it("#3205: an unknown hand-off goes to a new watcher at once, without waiting out the pause", async () => {
    const { h, join, watcher, send, acked } = await setup();
    await join();
    const first = await watcher();
    const id = send();
    await wait(first.c, first.got, 1);
    first.c.agyUnknown(id);
    await vi.waitFor(() => expect(h.daemon.agy.rechecking()).toBe(1));
    first.c.close();
    await new Promise<void>((r) => first.c.onClose(r));
    const second = await watcher();
    await wait(second.c, second.got, 1);
    expect(second.got[0]?.msg_id).toBe(id);
    second.c.ack(id);
    await vi.waitFor(() => expect(acked(id)).toBe(1));
  });

  it("#3205: an unknown hand-off held for a session that closes is let go, never refused", async () => {
    const { h, join, watcher, send, acked } = await setup();
    await join();
    const { c, got } = await watcher();
    const id = send();
    await wait(c, got, 1);
    c.agyUnknown(id);
    await vi.waitFor(() => expect(h.daemon.agy.rechecking()).toBe(1));
    os.start.delete(AGY);
    await vi.waitFor(() => expect(h.daemon.agy.rechecking()).toBe(0));
    expect(acked(id)).toBe(0);
    expect(h.of("refuse").filter((f) => f.msg_id === id)).toHaveLength(0);
  });

  it("pushes again to a watcher that went quiet (it never hands an id over twice)", async () => {
    const { join, watcher, send } = await setup(30);
    await join();
    const { c, got } = await watcher();
    const id = send();
    await wait(c, got, 2);
    expect(got.every((f) => f.msg_id === id)).toBe(true);
  });

  it("refuses a second watcher for the same agy process, and takes one again once the first is gone", async () => {
    const { h, join, watcher } = await setup();
    await join();
    const first = await watcher();
    os.parent.set(OTHER, SHELL);
    const e = await connectDaemon({
      path: h.socketPath,
      hello: watcherHello(OTHER),
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HelloRefused);
    expect((e as HelloRefused).reason).toBe(AGY_WATCHER_RUNNING);
    first.c.close();
    await vi.waitFor(async () => {
      const again = await connectDaemon({
        path: h.socketPath,
        hello: watcherHello(OTHER),
      });
      again.close();
    });
  });

  it("refuses a watcher with no agy among its parents, the wrong start time, or no conversation on the bus", async () => {
    const { h, join } = await setup();
    const refused = async (hello: Hello) => {
      const e = await connectDaemon({ path: h.socketPath, hello }).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(HelloRefused);
      return (e as HelloRefused).reason;
    };
    expect(await refused(watcherHello())).toBe(AGY_NO_SESSION);
    await join();
    expect(await refused(watcherHello(OTHER))).toMatch(
      /does not run under agy/,
    );
    expect(await refused(watcherHello(WATCHER, "t9"))).toMatch(
      /start time moved/,
    );
  });

  it("frames the bus's own oversized notice without escaping it", () => {
    const text = agyMessageText({ busName: "agy", global: false } as never, {
      msg_id: "m1",
      from_name: "peer",
      namespace: "ns",
      body: "[oa-bus] A message of 99 bytes is too large",
      notice: { size: 99, msg_id: "m1" },
    });
    expect(text.endsWith("[oa-bus] A message of 99 bytes is too large")).toBe(
      true,
    );
  });
});
