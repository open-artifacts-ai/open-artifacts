import type { DaemonFrame } from "@oa/bus-ipc";
import {
  type ClientFrame,
  type DeliverFrame,
  MAILBOX_RETAIN_MS,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentRecord, AgentTable } from "../src/agents.ts";
import { createDeliver, type Mail } from "../src/deliver.ts";
import {
  AGY_EXPIRY_MARGIN_MS,
  AgyTransport,
} from "../src/transports/antigravity.ts";

const DAY = 24 * 60 * 60 * 1000;
const BASE_TIME = Date.parse("2026-11-26T10:00:00.000Z");
const REF = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const KEY = { pid: 4242, procStart: "t0" };

const makeAgent = (): AgentRecord => ({
  ref: REF,
  kind: "antigravity",
  proposedName: "agy",
  busName: "agy",
  namespace: "ns",
  global: false,
  pid: KEY.pid,
  procStart: KEY.procStart,
  cwd: "/w/app",
  live: true,
});

const makeMail = (msg_id: string, expiresAt?: number): Mail => ({
  msg_id,
  from_name: "peer",
  namespace: "ns",
  body: "hello",
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgyTransport expiry", () => {
  it("refusal at day 0, watcher reconnects at day 8: nothing pushed, resolves expired, and createDeliver sends no ack/refuse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const logs: string[] = [];
    const transport = new AgyTransport({ log: (m) => logs.push(m) });
    const firstPushes: DaemonFrame[] = [];
    const w1 = transport.up(KEY, (f) => {
      firstPushes.push(f);
      return true;
    });

    const id = "m".repeat(15) + "1";
    const expiresAt = BASE_TIME + MAILBOX_RETAIN_MS;
    const done = transport.deliver(makeAgent(), makeMail(id, expiresAt));
    expect(firstPushes).toHaveLength(1);
    expect(transport.answered(id, w1, "failed")).toBe(true);
    transport.down(w1);

    await vi.advanceTimersByTimeAsync(8 * DAY);

    const secondPushes: DaemonFrame[] = [];
    transport.up(KEY, (f) => {
      secondPushes.push(f);
      return true;
    });

    expect(await done).toEqual({ ok: false, reason: "expired" });
    expect(secondPushes).toHaveLength(0);
    expect(transport.held()).toBe(0);
    expect(logs).toContain(
      `agy: ${id} expired before agy took it; not handed over`,
    );

    // Same scenario through createDeliver: no ack and no refuse sent to the hub.
    vi.setSystemTime(BASE_TIME);
    const agents = new AgentTable();
    agents.up(makeAgent());
    const sent: ClientFrame[] = [];
    const deliverLogs: string[] = [];
    const t2 = new AgyTransport({ log: (m) => deliverLogs.push(m) });
    const d = createDeliver({
      agents,
      hub: {
        send: (f) => {
          sent.push(f);
          return true;
        },
      },
      transports: { antigravity: (a, m) => t2.deliver(a, m) },
      onClosed: () => {},
      log: (m) => deliverLogs.push(m),
    });

    const w2 = t2.up(KEY, () => true);
    const id2 = "m".repeat(15) + "2";
    const frame: DeliverFrame = {
      v: 1,
      id: "d2",
      type: "deliver",
      msg_id: id2,
      to_ref: REF,
      from_name: "peer",
      namespace: "ns",
      body: "hello",
      expires_at: new Date(BASE_TIME + MAILBOX_RETAIN_MS).toISOString(),
    };
    const p = d.deliver(frame);
    expect(t2.answered(id2, w2, "failed")).toBe(true);
    t2.down(w2);

    await vi.advanceTimersByTimeAsync(8 * DAY);
    const laterPushes: DaemonFrame[] = [];
    t2.up(KEY, (f) => {
      laterPushes.push(f);
      return true;
    });
    await p;
    d.stop();

    expect(laterPushes).toHaveLength(0);
    expect(sent.filter((f) => f.type === "ack" || f.type === "refuse")).toEqual(
      [],
    );
  });

  it("already expired on first push (expiresAt 7 days + 1 ms ago): nothing pushed, resolves expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const transport = new AgyTransport();
    const pushes: DaemonFrame[] = [];
    transport.up(KEY, (f) => {
      pushes.push(f);
      return true;
    });

    const id = "m".repeat(15) + "3";
    const outcome = await transport.deliver(
      makeAgent(),
      makeMail(id, BASE_TIME - MAILBOX_RETAIN_MS - 1),
    );
    expect(outcome).toEqual({ ok: false, reason: "expired" });
    expect(pushes).toHaveLength(0);
    expect(transport.held()).toBe(0);
  });

  it("just under the limit (expiresAt = now + AGY_EXPIRY_MARGIN_MS + 1000): pushed once, ok", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const transport = new AgyTransport();
    const pushes: DaemonFrame[] = [];
    const w = transport.up(KEY, (f) => {
      pushes.push(f);
      return true;
    });

    const id = "m".repeat(15) + "4";
    const done = transport.deliver(
      makeAgent(),
      makeMail(id, BASE_TIME + AGY_EXPIRY_MARGIN_MS + 1000),
    );
    expect(pushes).toHaveLength(1);
    expect(transport.answered(id, w, "ok")).toBe(true);
    expect(await done).toEqual({ ok: true });
  });

  it("held with no watcher ever: resolves expired once fake time passes the cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const transport = new AgyTransport();
    const id = "m".repeat(15) + "5";
    const expiresAt = BASE_TIME + MAILBOX_RETAIN_MS;
    const done = transport.deliver(makeAgent(), makeMail(id, expiresAt));
    expect(transport.held(KEY)).toBe(1);

    await vi.advanceTimersByTimeAsync(
      MAILBOX_RETAIN_MS - AGY_EXPIRY_MARGIN_MS - 1,
    );
    expect(transport.held(KEY)).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toEqual({ ok: false, reason: "expired" });
    expect(transport.held(KEY)).toBe(0);
  });

  it("no expiresAt (older hub): held from day 0, expires by day 8; succeeds when watcher comes up at day 6", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const t1 = new AgyTransport();
    const id1 = "m".repeat(15) + "6";
    const d1 = t1.deliver(makeAgent(), makeMail(id1));
    expect(t1.held(KEY)).toBe(1);

    await vi.advanceTimersByTimeAsync(8 * DAY);
    const pushes1: DaemonFrame[] = [];
    t1.up(KEY, (f) => {
      pushes1.push(f);
      return true;
    });
    expect(await d1).toEqual({ ok: false, reason: "expired" });
    expect(pushes1).toHaveLength(0);
    expect(t1.held(KEY)).toBe(0);

    // Day 6: still within MAILBOX_RETAIN_MS - AGY_EXPIRY_MARGIN_MS.
    vi.setSystemTime(BASE_TIME);
    const t2 = new AgyTransport();
    const id2 = "m".repeat(15) + "7";
    const d2 = t2.deliver(makeAgent(), makeMail(id2));
    expect(t2.held(KEY)).toBe(1);

    await vi.advanceTimersByTimeAsync(6 * DAY);
    const pushes2: DaemonFrame[] = [];
    const w = t2.up(KEY, (f) => {
      pushes2.push(f);
      return true;
    });
    await vi.waitFor(() => expect(pushes2).toHaveLength(1));
    expect(t2.answered(id2, w, "ok")).toBe(true);
    expect(await d2).toEqual({ ok: true });
    expect(t2.held(KEY)).toBe(0);
  });

  it("no expiresAt: redelivery after expiry does not restart the clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const transport = new AgyTransport();
    const id = "m".repeat(15) + "8";
    const first = transport.deliver(makeAgent(), makeMail(id));
    expect(transport.held(KEY)).toBe(1);

    await vi.advanceTimersByTimeAsync(MAILBOX_RETAIN_MS - AGY_EXPIRY_MARGIN_MS);
    expect(await first).toEqual({ ok: false, reason: "expired" });

    const pushes: DaemonFrame[] = [];
    transport.up(KEY, (f) => {
      pushes.push(f);
      return true;
    });
    const second = await transport.deliver(makeAgent(), makeMail(id));
    expect(second).toEqual({ ok: false, reason: "expired" });
    expect(pushes).toHaveLength(0);
    expect(transport.held(KEY)).toBe(0);
  });

  it("no expiresAt: closed at day 3 then redelivered at day 8 does not restart the clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const transport = new AgyTransport();
    const id = "m".repeat(15) + "9";
    const first = transport.deliver(makeAgent(), makeMail(id));
    expect(transport.held(KEY)).toBe(1);

    await vi.advanceTimersByTimeAsync(3 * DAY);
    transport.closed(REF);
    expect(await first).toEqual({
      ok: false,
      reason: "closed",
      closedBy: "liveness",
    });

    await vi.advanceTimersByTimeAsync(5 * DAY);
    const pushes: DaemonFrame[] = [];
    transport.up(KEY, (f) => {
      pushes.push(f);
      return true;
    });
    const second = await transport.deliver(makeAgent(), makeMail(id));
    expect(second).toEqual({ ok: false, reason: "expired" });
    expect(pushes).toHaveLength(0);
    expect(transport.held(KEY)).toBe(0);
  });
});
