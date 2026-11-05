import type { ClientFrame } from "@oa/bus-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FramePacer } from "../src/pacer.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const f = (type: string, n = 0) =>
  ({ v: 1, id: `${type}-${n}`, type }) as unknown as ClientFrame;

function pacer(
  over: Partial<ConstructorParameters<typeof FramePacer>[0]> = {},
) {
  const sent: { id: string; at: number }[] = [];
  const p = new FramePacer({
    send: (data) => {
      sent.push({ id: data, at: Date.now() });
      return true;
    },
    ...over,
  });
  return { p, sent, ids: () => sent.map((s) => s.id) };
}

describe("frame pacer", () => {
  it("never sends more than 40 frames in any second under a burst of 300", () => {
    const { p, sent } = pacer();
    for (let i = 0; i < 300; i++) p.push(f("send", i), `s${i}`);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(300);
    for (let i = 0; i < sent.length; i++) {
      const inWindow = sent.filter(
        (s) => s.at >= sent[i].at && s.at < sent[i].at + 1000,
      ).length;
      expect(inWindow).toBeLessThanOrEqual(40);
    }
    // Paced, not dribbled: 300 frames go out in well under 10 s.
    expect(sent.at(-1)?.at ?? 0).toBeLessThan(sent[0].at + 10_000);
  });

  it("sends a small burst at once and the rest paced", () => {
    const { p, sent } = pacer();
    for (let i = 0; i < 20; i++) p.push(f("send", i), `s${i}`);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(20);
  });

  it("sends hello, then ack/refuse, then agent_up/agent_down, then the rest", () => {
    const { p, ids } = pacer({ burst: 1 });
    // The first push takes the only token; everything after it queues.
    p.push(f("list", 0), "list0");
    p.push(f("agent_up", 2), "up2");
    p.push(f("ack", 5), "ack5");
    p.push(f("agent_down", 6), "down6");
    p.push(f("refuse", 7), "refuse7");
    p.push(f("hello", 8), "hello8");
    p.push(f("send", 1), "send1");
    vi.advanceTimersByTime(5_000);
    expect(ids()).toEqual([
      "list0",
      "hello8",
      "ack5",
      "refuse7",
      // Registrations never count as starving user frames.
      "up2",
      "down6",
      "send1",
    ]);
  });

  it("a sessions snapshot waits for what was queued before it, and nothing later overtakes it", () => {
    const { p, ids } = pacer({ burst: 1 });
    p.push(f("hello"), "hello");
    p.push(f("send", 1), "send1");
    p.push(f("agent_up", 2), "up2");
    p.push(f("sessions"), "sessions");
    p.push(f("ack", 3), "ack3");
    p.push(f("agent_up", 4), "up4");
    vi.advanceTimersByTime(5_000);
    expect(ids()).toEqual(["hello", "up2", "send1", "sessions", "ack3", "up4"]);
  });

  it("gives waiting user frames at least one token in four", () => {
    const { p, ids } = pacer({ burst: 1 });
    p.push(f("hello"), "hello");
    for (let i = 0; i < 20; i++) p.push(f("ack", i), `ack${i}`);
    p.push(f("send", 1), "send1");
    p.push(f("list", 2), "list2");
    vi.advanceTimersByTime(5_000);
    expect(ids().indexOf("send1")).toBe(4);
    expect(ids().indexOf("list2")).toBe(8);
  });

  it("holds an agent's frames behind its queued agent_up, even with its share due", () => {
    const { p, ids } = pacer({ burst: 1 });
    const up = (ref: string) =>
      ({
        v: 1,
        id: `up-${ref}`,
        type: "agent_up",
        agent_ref: ref,
      }) as unknown as ClientFrame;
    const send = (ref: string) =>
      ({
        v: 1,
        id: `send-${ref}`,
        type: "send",
        from_ref: ref,
      }) as unknown as ClientFrame;
    p.push(f("hello"), "hello");
    for (let i = 0; i < 6; i++) p.push(f("ack", i), `ack${i}`);
    p.push(up("r1"), "up-r1");
    p.push(send("r1"), "send-r1");
    p.push(send("r2"), "send-r2");
    vi.advanceTimersByTime(5_000);
    // r2 takes the share at once; r1 waits for its agent_up.
    expect(ids()).toEqual([
      "hello",
      "ack0",
      "ack1",
      "ack2",
      "send-r2",
      "ack3",
      "ack4",
      "ack5",
      "up-r1",
      "send-r1",
    ]);
  });

  it("never drops agent_up, agent_down, sessions or acks for space, and warns near the bound", () => {
    const log = vi.fn();
    const { p } = pacer({ burst: 1, max: 5, log });
    p.push(f("hello"), "hello");
    for (let i = 0; i < 3; i++) p.push(f("agent_up", i), `up${i}`);
    expect(log).not.toHaveBeenCalled();
    p.push(f("ack", 3), "ack3");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/near its bound/));
    p.push(f("sessions"), "sessions");
    expect(p.push(f("agent_down", 4), "down4")).toBe(true);
    expect(p.size).toBe(6);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/over its bound/));
    expect(p.push(f("send", 5), "send5")).toBe(false);
  });

  it("remove() drops a still-queued frame by id", () => {
    const { p, ids } = pacer({ burst: 1 });
    p.push(f("hello"), "hello");
    p.push(f("send", 1), "send1");
    p.push(f("send", 2), "send2");
    expect(p.remove("send-1")).toBe(true);
    expect(p.remove("send-1")).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(ids()).toEqual(["hello", "send2"]);
  });

  it("hands unsent frames back to their keeper: on clear, on overflow, and when the socket is closing", () => {
    let open = true;
    const sent: string[] = [];
    const back: string[] = [];
    const p = new FramePacer({
      burst: 1,
      max: 3,
      send: (d) => {
        if (!open) return false;
        sent.push(d);
        return true;
      },
    });
    const keep = (n: number) => () => back.push(`send${n}`);
    p.push(f("hello"), "hello");
    p.push(f("send", 1), "send1", keep(1));
    p.push(f("send", 2), "send2", keep(2));
    p.push(f("ack", 3), "ack3");
    p.push(f("ack", 4), "ack4"); // over the bound: send1 goes back
    expect(back).toEqual(["send1"]);
    open = false;
    vi.advanceTimersByTime(5_000);
    // Not written, not lost: still queued.
    expect(sent).toEqual(["hello"]);
    expect(p.size).toBe(3);
    p.clear();
    expect(back).toEqual(["send1", "send2"]);
  });

  it("drops the oldest lowest-priority frame when full, logs it and reports it", () => {
    const log = vi.fn();
    const onDropped = vi.fn();
    const { p, ids } = pacer({ burst: 1, max: 3, log, onDropped });
    p.push(f("hello"), "hello"); // sent at once
    expect(p.push(f("send", 1), "send1")).toBe(true);
    expect(p.push(f("agent_up", 2), "up2")).toBe(true);
    expect(p.push(f("send", 3), "send3")).toBe(true);
    expect(p.push(f("ack", 4), "ack4")).toBe(true);
    expect(onDropped).toHaveBeenCalledWith(f("send", 1));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropped .*send/));
    expect(p.size).toBe(3);
    vi.advanceTimersByTime(5_000);
    expect(ids()).toEqual(["hello", "ack4", "up2", "send3"]);
  });

  it("refuses a new frame when the queue is full of higher-priority ones", () => {
    const onDropped = vi.fn();
    const { p } = pacer({ burst: 1, max: 2, onDropped });
    p.push(f("hello"), "hello");
    p.push(f("ack", 1), "ack1");
    p.push(f("ack", 2), "ack2");
    expect(p.push(f("send", 3), "send3")).toBe(false);
    expect(onDropped).not.toHaveBeenCalled();
    expect(p.size).toBe(2);
  });

  it("clear() drops what is queued and stops the timer", () => {
    const { p, sent } = pacer({ burst: 1 });
    for (let i = 0; i < 10; i++) p.push(f("send", i), `s${i}`);
    p.clear();
    expect(p.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a send that throws is logged and pacing continues", () => {
    const log = vi.fn();
    let n = 0;
    const p = new FramePacer({
      burst: 1,
      log,
      send: () => {
        if (n++ === 1) throw new Error("boom");
        return true;
      },
    });
    for (let i = 0; i < 4; i++) p.push(f("send", i), `s${i}`);
    vi.advanceTimersByTime(5_000);
    expect(n).toBe(4);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/boom/));
  });
});
