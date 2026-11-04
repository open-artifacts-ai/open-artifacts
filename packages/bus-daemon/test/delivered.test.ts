import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStatus } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyFn } from "../src/deliver.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const ID = "mmmmmmmmmmmmmmm1";
const ID2 = "mmmmmmmmmmmmmmm2";
/** A fake clock for the delivered wait: nothing times out until `elapse`. */
function manualClock() {
  const due = new Set<() => void>();
  return {
    after: (_ms: number, fn: () => void) => {
      due.add(fn);
      return () => due.delete(fn);
    },
    waiting: () => due.size,
    elapse: () => {
      for (const fn of [...due]) {
        due.delete(fn);
        fn();
      }
    },
  };
}

/** A tool call's send whose receipt came back pending; the reply is still out. */
async function queued(
  h: Awaited<ReturnType<typeof daemonHarness>>,
  msgId = ID,
  n = 1,
) {
  const a = await h.adapter(`A${n}`);
  const reply = a.request({ type: "send", to: "peer", body: "hi" });
  const sent = await h.next("send", n);
  h.toDaemon({ id: sent.id, type: "receipt", msg_id: msgId, state: "pending" });
  return reply;
}

/** Settled yet? Without waiting on it. */
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((r) => setImmediate(r));
  return done;
};

describe("send_message waits for delivered (C17)", () => {
  const harness = async (over: Parameters<typeof daemonHarness>[0] = {}) => {
    const clock = manualClock();
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      deliveredWaitMs: 5000,
      deliveredTimer: clock.after,
      ...over,
    });
    /** A queued send, now waiting on the clock. */
    const waiting = async (msgId = ID, n = 1) => {
      const before = clock.waiting();
      const a = await h.adapter(`A${n}`);
      const reply = a.request({ type: "send", to: "peer", body: "hi" });
      const sent = await h.next("send", n);
      h.toDaemon({
        id: sent.id,
        type: "receipt",
        msg_id: msgId,
        state: "pending",
      });
      await vi.waitFor(() => expect(clock.waiting()).toBe(before + 1));
      return { a, reply };
    };
    const update = (state: string, msgId = ID, reason?: string) =>
      h.toDaemon({
        type: "receipt_update",
        id: `u-${msgId}`,
        msg_id: msgId,
        state,
        ...(reason ? { reason } : {}),
      });
    return { h, clock, notify, waiting, update };
  };

  it("answers delivered when it comes inside the window", async () => {
    const { clock, notify, waiting, update } = await harness();
    const { reply } = await waiting();
    expect(await settled(reply)).toBe(false);
    update("delivered");
    await expect(reply).resolves.toMatchObject({
      type: "receipt",
      msg_id: ID,
      state: "delivered",
    });
    expect(clock.waiting()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("answers queued at the window's end; a later delivered is no notice", async () => {
    const { clock, notify, waiting, update } = await harness();
    const { reply } = await waiting();
    expect(await settled(reply)).toBe(false);
    clock.elapse();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
    update("delivered");
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ["refused", "closed"],
    ["expired", "recipient_closed"],
  ])(
    "answers %s (%s) inside the window, with no notice after",
    async (state, reason) => {
      const { notify, waiting, update } = await harness();
      const { reply } = await waiting();
      update(state, ID, reason);
      await expect(reply).resolves.toMatchObject({ msg_id: ID, state, reason });
      await new Promise((r) => setTimeout(r, 100));
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("an update that beats the receipt answers the send without waiting", async () => {
    const { h, clock, update } = await harness();
    const a = await h.adapter("A");
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    update("delivered");
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    await expect(reply).resolves.toMatchObject({ state: "delivered" });
    expect(clock.waiting()).toBe(0);
  });

  it("two concurrent sends resolve independently", async () => {
    const { clock, waiting, update } = await harness();
    const a = await waiting(ID, 1);
    const b = await waiting(ID2, 2);
    update("delivered", ID2);
    await expect(b.reply).resolves.toMatchObject({
      msg_id: ID2,
      state: "delivered",
    });
    expect(await settled(a.reply)).toBe(false);
    clock.elapse();
    await expect(a.reply).resolves.toMatchObject({
      msg_id: ID,
      state: "pending",
    });
  });

  it("a hub link drop during the wait answers queued without the clock", async () => {
    const { h, waiting } = await harness();
    const { reply } = await waiting();
    h.hubSock()?.terminate();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
  });

  it("stopping the daemon during the wait answers queued, not an error", async () => {
    const { h, waiting } = await harness();
    const { reply } = await waiting();
    await h.daemon.stop();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
  });

  it("a refusal for a tool call that went away becomes a notice", async () => {
    const piNotify = vi.fn<NotifyFn>(async () => true);
    const { h, update } = await harness({ notifiers: { pi: piNotify } });
    const a = await h.adapter("P1", { kind: "pi" });
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    reply.catch(() => {});
    const sent = await h.next("send");
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    // The Pi link goes; the daemon closes the agent, which the hub hears.
    const before = h.of("sessions").length;
    a.close();
    await h.next("sessions", before + 1);
    update("refused", ID, "closed");
    // Back again: the owed notice is told.
    await h.adapter("P1", { kind: "pi" });
    await vi.waitFor(() => expect(piNotify).toHaveBeenCalledTimes(1));
    expect(piNotify.mock.calls[0][1]).toMatch(/^×\s+Refused \(closed\)/);
  });
});

/** The hub replays missed receipt_updates after agent_up on reconnect (B6). */
describe("replayed receipt_updates after a reconnect", () => {
  const sentFile = () =>
    join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");
  const reconnect = async (h: Awaited<ReturnType<typeof daemonHarness>>) => {
    const ups = h.of("agent_up").length;
    h.hubSock()?.terminate();
    await h.next("agent_up", ups + 1);
  };
  const update = (state: string, id = "u1") => ({
    type: "receipt_update",
    id,
    msg_id: ID,
    state,
  });

  it("records a replayed delivered and never notices it", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const file = sentFile();
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: file,
    });
    await expect(queued(h)).resolves.toMatchObject({ state: "pending" });
    await reconnect(h);
    h.toDaemon(update("delivered"));
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(file, "utf8"))[ID]).toMatchObject({
        delivered: true,
      }),
    );
    // Replayed again, and an expiry after it: still nothing.
    h.toDaemon(update("delivered", "u2"));
    h.toDaemon(update("expired", "u3"));
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it("notices a replayed expiry once, and never one already told", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await expect(queued(h)).resolves.toMatchObject({ state: "pending" });
    await reconnect(h);
    h.toDaemon(update("expired"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][1]).toMatch(
      /^×\s+Expired: your message to peer/,
    );
    // A second reconnect replays it again: already told, so no second notice.
    await reconnect(h);
    h.toDaemon(update("expired", "u2"));
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notices a replayed refusal once, and never one already settled", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await expect(queued(h)).resolves.toMatchObject({ state: "pending" });
    h.toDaemon({ ...update("refused"), reason: "closed" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await reconnect(h);
    h.toDaemon({ ...update("refused", "u2"), reason: "closed" });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("late deliveries are shown (C17 part 2)", () => {
  const LATE =
    '✓  Delivered: your message to peer, "hi",\n   was delivered after all.';
  const sentFile = () =>
    join(mkdtempSync(join(tmpdir(), "ob-late-")), "sent.json");
  /** Records ID as delivered late from `ref`'s send, and waits until it is on disk. */
  const deliveredLate = async (
    h: Awaited<ReturnType<typeof daemonHarness>>,
    file: string,
    kind: "claude-code" | "pi" = "claude-code",
    ref = "A1",
  ) => {
    const a = await h.adapter(ref, { kind });
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    expect(await reply).toMatchObject({ state: "pending" });
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(file, "utf8"))[ID]).toMatchObject({
        late: true,
      }),
    );
    return a;
  };

  it("rides once on the sender's next tool-call reply, never on another agent's", async () => {
    const file = sentFile();
    const h = await daemonHarness({ sentFile: file });
    const b = await h.adapter("B1");
    const a = await deliveredLate(h, file);
    // B asks first: A's late delivery is not B's.
    expect(await b.request({ type: "self", late: true })).not.toHaveProperty(
      "late",
    );
    expect(await a.request({ type: "self", late: true })).toMatchObject({
      type: "agent",
      late: [LATE],
    });
    expect(await a.request({ type: "self", late: true })).not.toHaveProperty(
      "late",
    );
  });

  it("a request that is not a tool call (Pi's on-delivery self) neither carries nor consumes it", async () => {
    const file = sentFile();
    const h = await daemonHarness({ sentFile: file });
    const a = await deliveredLate(h, file);
    expect(await a.request({ type: "self" })).not.toHaveProperty("late");
    expect(await a.request({ type: "self", late: true })).toMatchObject({
      late: [LATE],
    });
  });

  it("an ack's error reply does not consume it", async () => {
    const file = sentFile();
    const h = await daemonHarness({ sentFile: file });
    const a = await deliveredLate(h, file);
    // Not a delivery to A: the daemon answers an error the adapter drops.
    a.ack(ID2);
    expect(await a.request({ type: "self", late: true })).toMatchObject({
      late: [LATE],
    });
  });

  it("rides on an error reply too", async () => {
    const file = sentFile();
    const h = await daemonHarness({ sentFile: file });
    const a = await deliveredLate(h, file);
    const pendingErr = a.request({ type: "fetch", msg_id: ID2, late: true });
    const f = await h.next("fetch");
    h.toDaemon({ type: "error", id: f.id, code: "not_found", message: "gone" });
    expect(await pendingErr).toMatchObject({ type: "error", late: [LATE] });
  });

  it("a reply that could not be written does not mark it shown", async () => {
    const file = sentFile();
    const h = await daemonHarness({ sentFile: file });
    // A Pi link: closing its last connection closes the agent, which the hub hears.
    const a = await deliveredLate(h, file, "pi", "P1");
    const pendingFetch = a.request({ type: "fetch", msg_id: ID2, late: true });
    pendingFetch.catch(() => {});
    const f = await h.next("fetch");
    const before = h.of("sessions").length;
    a.close();
    await h.next("sessions", before + 1);
    h.toDaemon({ type: "error", id: f.id, code: "not_found", message: "gone" });
    const again = await h.adapter("P1", { kind: "pi" });
    expect(await again.request({ type: "self", late: true })).toMatchObject({
      late: [LATE],
    });
  });

  it("a delivered inside the window is not late", async () => {
    const h = await daemonHarness({
      deliveredWaitMs: 5000,
      deliveredTimer: manualClock().after,
    });
    const a = await h.adapter("A1");
    const reply = queued(h);
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    expect(await reply).toMatchObject({ state: "delivered" });
    expect(await a.request({ type: "self", late: true })).not.toHaveProperty(
      "late",
    );
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.late ?? []).toEqual([]);
  });

  it("status lists late deliveries, read-only", async () => {
    const file = sentFile();
    const h = await daemonHarness({ sentFile: file });
    const a = await deliveredLate(h, file);
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.late).toEqual([
      {
        from: expect.any(String),
        to: "peer",
        excerpt: "hi",
        at: expect.any(Number),
      },
    ]);
    // Status did not mark it shown.
    expect(await a.request({ type: "self", late: true })).toMatchObject({
      late: [LATE],
    });
  });
});
