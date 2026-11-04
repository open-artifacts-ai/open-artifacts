import { lateDeliveredText, receiptText, unconfirmedText } from "@oa/bus-ipc";
import { afterEach, expect, describe as group, it, vi } from "vitest";
import type { NotifyFn } from "../src/deliver.ts";
import { Resends } from "../src/resend.ts";
import { Receipts, SentStore } from "../src/sent.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const ID = "mmmmmmmmmmmmmmm1";
const ID2 = "mmmmmmmmmmmmmmm2";

/** A fake clock: timers fire in order as it advances. */
function clock() {
  let now = 0;
  const due = new Map<() => void, number>();
  return {
    now: () => now,
    after: (ms: number, fn: () => void) => {
      due.set(fn, now + ms);
      return () => void due.delete(fn);
    },
    advance: (ms: number) => {
      now += ms;
      for (const [fn, at] of [...due].sort((a, b) => a[1] - b[1]))
        if (at <= now && due.delete(fn)) fn();
    },
  };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function setup(
  over: Parameters<typeof daemonHarness>[0] = {},
  /** The delivered wait (C17) runs on the same fake clock. */
  fakeDelivered = false,
) {
  const c = clock();
  const notify = vi.fn<NotifyFn>(async () => true);
  const log = vi.fn<(msg: string) => void>();
  const h = await daemonHarness({
    notifiers: { "claude-code": notify },
    resendTimer: c.after,
    resendNow: c.now,
    ...(fakeDelivered ? { deliveredTimer: c.after } : {}),
    log,
    ...over,
    // No session files here: never let sync close the test's agents.
    claude: { syncMs: 3_600_000 },
  });
  /** The hub registers `ref`'s nth agent_up. */
  const ok = async (n: number, ref = "A") => {
    const up = (await h.next("agent_up", n)) as { id: string };
    h.toDaemon({ id: up.id, type: "agent_ok", agent_ref: ref, bus_name: ref });
  };
  const drop = async () => {
    const old = h.hubSock();
    old?.terminate();
    await vi.waitFor(() => {
      expect(h.hubSock()).not.toBe(old);
      expect(h.daemon.hub.open).toBe(true);
    });
  };
  /** Every send as written; an id never carries two payloads. */
  const sends = () => {
    const out = h.raw.filter((r) => JSON.parse(r).type === "send");
    const byId = new Map<string, Set<string>>();
    for (const r of out) {
      const id = JSON.parse(r).id as string;
      byId.set(id, (byId.get(id) ?? new Set()).add(r));
    }
    for (const s of byId.values()) expect(s.size).toBe(1);
    return out;
  };
  /** What `a`'s next tool result appends (late outcomes), once each. */
  const lateOf = async (a: Awaited<ReturnType<typeof h.adapter>>) => {
    const r = (await a.request({ type: "self", late: true } as never)) as {
      late?: string[];
    };
    return r.late ?? [];
  };
  /**
   * A failure wakes the sender as a notice, exactly once, with no bus call
   * needed; it never rides the next tool result too.
   */
  const noticedOnce = async (
    a: Awaited<ReturnType<typeof h.adapter>>,
    text: string,
  ) => {
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][1]).toBe(text);
    await tick(100);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await lateOf(a)).toEqual([]);
  };
  return { h, c, notify, log, ok, drop, sends, lateOf, noticedOnce };
}

group("a send whose link drops before its receipt (C16)", () => {
  it("is resent with the same id once its sender is registered again; one answer", async () => {
    const { h, ok, drop, sends } = await setup();
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", id: "7", to: "bob", body: "hi" });
    const first = await h.next("send");
    await drop();
    await h.next("agent_up", 2);
    await tick();
    // Not before the hub has the sender again.
    expect(sends()).toHaveLength(1);
    await ok(2);
    const again = await h.next("send", 2);
    expect(again.id).toBe(first.id);
    // Byte for byte the same frame.
    expect(new Set(sends()).size).toBe(1);
    h.toDaemon({ id: again.id, type: "receipt", msg_id: ID, state: "pending" });
    await expect(reply).resolves.toMatchObject({
      id: "7",
      type: "receipt",
      msg_id: ID,
    });
    // Answered: a later link never sends it again.
    await drop();
    await ok(3);
    await tick();
    expect(sends()).toHaveLength(2);
  });

  it("a resend of a send already delivered answers delivered once, with no notice", async () => {
    const { h, ok, drop, notify } = await setup({ deliveredWaitMs: 5000 });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await ok(2);
    const again = await h.next("send", 2);
    // B14: the original receipt, then its current state.
    h.toDaemon({ id: again.id, type: "receipt", msg_id: ID, state: "pending" });
    const update = { id: "u1", type: "receipt_update", msg_id: ID };
    h.toDaemon({ ...update, state: "delivered" });
    await expect(reply).resolves.toMatchObject({ state: "delivered" });
    // The same final update again, and a repeated receipt: no-ops.
    h.toDaemon({ ...update, state: "delivered" });
    h.toDaemon({ id: again.id, type: "receipt", msg_id: ID, state: "pending" });
    await tick(100);
    expect(notify).not.toHaveBeenCalled();
  });

  it("concurrent sends from two agents each go again under their own id", async () => {
    const { h, ok, drop, sends } = await setup();
    const a = await h.adapter("A");
    await ok(1, "A");
    const b = await h.adapter("B");
    await ok(2, "B");
    const answered = a.request({ type: "send", to: "bob", body: "one" });
    const s0 = await h.next("send", 1);
    h.toDaemon({ id: s0.id, type: "receipt", msg_id: ID, state: "pending" });
    await answered;
    const ra = a.request({ type: "send", to: "bob", body: "two" });
    const rb = b.request({ type: "send", to: "bob", body: "three" });
    await h.next("send", 3);
    const [sa, sb] = h.of("send").slice(1);
    await drop();
    // Registered in the other order; each resends only its own.
    await vi.waitFor(() => expect(h.of("agent_up").length).toBe(4));
    const ups = h.of("agent_up").slice(2);
    const upB = ups.find((u) => u.agent_ref === "B");
    h.toDaemon({
      id: upB?.id,
      type: "agent_ok",
      agent_ref: "B",
      bus_name: "B",
    });
    const r1 = await h.next("send", 4);
    expect(r1.id).toBe(sb.id);
    const upA = ups.find((u) => u.agent_ref === "A");
    h.toDaemon({
      id: upA?.id,
      type: "agent_ok",
      agent_ref: "A",
      bus_name: "A",
    });
    const r2 = await h.next("send", 5);
    expect(r2.id).toBe(sa.id);
    h.toDaemon({ id: sa.id, type: "receipt", msg_id: ID2, state: "pending" });
    h.toDaemon({
      id: sb.id,
      type: "receipt",
      msg_id: "mmmmmmmmmmmmmmm3",
      state: "pending",
    });
    await expect(ra).resolves.toMatchObject({ msg_id: ID2 });
    await expect(rb).resolves.toMatchObject({ msg_id: "mmmmmmmmmmmmmmm3" });
    // The send answered before the drop never went again.
    expect(sends().filter((r) => r.includes(s0.id))).toHaveLength(1);
  });

  it("the window ends with the Unconfirmed copy, verbatim and not an error", async () => {
    const { h, c, ok } = await setup({ hub: { backoffMs: () => 60_000 } });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    h.hubSock()?.terminate();
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(false));
    c.advance(59_000);
    await tick();
    c.advance(1000);
    // Shown as-is by the adapters (R3); `held`: its msg_id is no hub id (R4).
    await expect(reply).resolves.toMatchObject({
      type: "receipt",
      state: "pending",
      held: true,
      text: unconfirmedText("bob", "hi"),
    });
  });

  it("gives up after too many lost links", async () => {
    const { h, ok, drop } = await setup();
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    for (let i = 0; i < 3; i++) await drop();
    await tick();
    let done = false;
    void reply.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    await drop();
    await expect(reply).resolves.toMatchObject({
      text: unconfirmedText("bob", "hi"),
    });
  });

  it("the delivered wait (C17) runs on the resend's receipt", async () => {
    const { h, c, ok, drop, notify } = await setup(
      { deliveredWaitMs: 5000 },
      true,
    );
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await ok(2);
    const again = await h.next("send", 2);
    h.toDaemon({ id: again.id, type: "receipt", msg_id: ID, state: "pending" });
    await tick();
    let done = false;
    void reply.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    c.advance(5000);
    await expect(reply).resolves.toMatchObject({
      msg_id: ID,
      state: "pending",
    });
    // Answered: the window has nothing left to fail.
    c.advance(60_000);
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "delivered",
    });
    await tick(100);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a refused resend answers refused and is never sent again", async () => {
    const { h, ok, drop, sends } = await setup();
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await ok(2);
    const again = await h.next("send", 2);
    // Refused at send time stores no key at the hub: this is a fresh verdict.
    h.toDaemon({
      id: again.id,
      type: "receipt",
      msg_id: ID,
      state: "refused",
      reason: "inbox_full",
    });
    await expect(reply).resolves.toMatchObject({
      state: "refused",
      reason: "inbox_full",
    });
    await drop();
    await ok(3);
    await tick();
    expect(sends()).toHaveLength(2);
  });

  it("a rate-limited resend goes again after a backoff, same id", async () => {
    const { h, c, ok, drop, sends } = await setup();
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await ok(2);
    const again = await h.next("send", 2);
    h.toDaemon({
      id: again.id,
      type: "error",
      code: "rate_limited",
      message: "Too many sends in flight",
    });
    await tick();
    expect(sends()).toHaveLength(2);
    c.advance(1000);
    const third = await h.next("send", 3);
    expect(third.id).toBe(again.id);
    h.toDaemon({ id: third.id, type: "receipt", msg_id: ID, state: "pending" });
    await expect(reply).resolves.toMatchObject({ msg_id: ID });
    expect(new Set(sends()).size).toBe(1);
  });

  it("a bad_frame on a resend is logged and ends as Unconfirmed", async () => {
    const { h, ok, drop, log, sends } = await setup();
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await ok(2);
    const again = await h.next("send", 2);
    h.toDaemon({
      id: again.id,
      type: "error",
      code: "bad_frame",
      message: "frame id reused",
    });
    await expect(reply).resolves.toMatchObject({
      text: unconfirmedText("bob", "hi"),
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("frame id reused"),
    );
    await drop();
    await ok(3);
    await tick();
    expect(sends()).toHaveLength(2);
  });

  it("a tool call that times out while its send is held is told Queued, and the send goes on", async () => {
    const { h, ok, drop } = await setup({ pendingTimeoutMs: 300 });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", id: "7", to: "bob", body: "hi" });
    const first = await h.next("send");
    await drop();
    // Never an error: an error invites a resend under a new id.
    await expect(reply).resolves.toMatchObject({
      id: "7",
      type: "receipt",
      state: "pending",
      held: true,
    });
    expect(await reply).not.toHaveProperty("text");
    await ok(2);
    const again = await h.next("send", 2);
    expect(again.id).toBe(first.id);
  });

  it("a held send refused after its call ended wakes the sender as a notice", async () => {
    const { h, ok, drop, noticedOnce } = await setup({
      pendingTimeoutMs: 300,
    });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
    await ok(2);
    const again = await h.next("send", 2);
    h.toDaemon({
      id: again.id,
      type: "receipt",
      msg_id: ID,
      state: "refused",
      reason: "inbox_full",
    });
    // The Refused notice, verbatim (Design: C16 2b).
    await noticedOnce(
      a,
      receiptText(
        { state: "refused", reason: "inbox_full" },
        "bob",
        undefined,
        "hi",
      ),
    );
  });

  it("a held send given up on after its call ended wakes the sender as an Unconfirmed notice", async () => {
    const { h, c, ok, noticedOnce } = await setup({
      pendingTimeoutMs: 300,
      hub: { backoffMs: () => 60_000 },
    });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi there" });
    await h.next("send");
    h.hubSock()?.terminate();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
    c.advance(60_000);
    await noticedOnce(a, unconfirmedText("bob", "hi there"));
  });

  it("a held send delivered after its call ended rides the next tool result, never a notice", async () => {
    const { h, ok, drop, notify, lateOf } = await setup({
      pendingTimeoutMs: 300,
    });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
    await ok(2);
    const again = await h.next("send", 2);
    h.toDaemon({ id: again.id, type: "receipt", msg_id: ID, state: "pending" });
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "delivered",
    });
    await vi.waitFor(async () =>
      expect(await lateOf(a)).toEqual([lateDeliveredText("bob", "hi")]),
    );
    expect(await lateOf(a)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("waits past the window for a resend in flight on the open link", async () => {
    const { h, c, ok, drop, notify } = await setup({ pendingTimeoutMs: 300 });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
    await ok(2);
    const again = await h.next("send", 2);
    // The window ends with the resend written and unanswered.
    c.advance(60_000);
    await tick();
    h.toDaemon({ id: again.id, type: "receipt", msg_id: ID, state: "pending" });
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
      reason: "recipient_closed",
    });
    // Its real outcome, not a give-up.
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][1]).toContain("Expired");
  });

  it("an overdue resend whose link drops too is given up, not sent again", async () => {
    const { h, c, ok, drop, sends, noticedOnce } = await setup({
      pendingTimeoutMs: 300,
    });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await drop();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
    await ok(2);
    await h.next("send", 2);
    c.advance(60_000);
    await drop();
    await ok(3);
    await noticedOnce(a, unconfirmedText("bob", "hi"));
    await tick();
    expect(sends()).toHaveLength(2);
  });

  it("a send never answered on a link that held is not resent past the window", async () => {
    const { h, c, ok, drop, sends, noticedOnce } = await setup({
      pendingTimeoutMs: 300,
    });
    const a = await h.adapter("A");
    await ok(1);
    const reply = a.request({ type: "send", to: "bob", body: "hi" });
    await h.next("send");
    await expect(reply).resolves.toMatchObject({ code: "timeout" });
    // Hours later the link drops: the hub may have forgotten its key.
    c.advance(2 * 60 * 60_000);
    await drop();
    await ok(2);
    await noticedOnce(a, unconfirmedText("bob", "hi"));
    await tick();
    expect(sends()).toHaveLength(1);
  });

  it("names the sender's namespace, so a resend is judged where the first send was", async () => {
    const { h, ok } = await setup();
    const a = await h.adapter("A");
    await ok(1);
    a.request({ type: "send", to: "bob", body: "hi" }).catch(() => {});
    expect(await h.next("send")).toMatchObject({ to_namespace: "ns" });
  });

  it("a send never written is not held: a list or a fresh send while down fails as before", async () => {
    const { h, ok } = await setup({ hub: { backoffMs: () => 60_000 } });
    const a = await h.adapter("A");
    await ok(1);
    h.hubSock()?.terminate();
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(false));
    await expect(
      a.request({ type: "send", to: "bob", body: "hi" }),
    ).resolves.toMatchObject({ code: "hub_unavailable" });
  });
});

group("receipt_update is idempotent per msg_id (B14)", () => {
  const frame = {
    v: 1 as const,
    id: "f1",
    type: "send" as const,
    from_ref: "A",
    to_name: "bob",
    body: "hi",
  };
  it("a repeated final update never notifies twice, told or not", () => {
    const r = new Receipts(new SentStore());
    r.sending(frame, "ns", true);
    r.receipt({ id: "f1", msg_id: ID, state: "pending" });
    const expired = {
      msg_id: ID,
      state: "expired" as const,
      reason: "recipient_closed" as const,
    };
    expect(r.update(expired)).toMatchObject({ msgId: ID, state: "expired" });
    expect(r.update(expired)).toBeUndefined();
    r.told(ID);
    expect(r.update(expired)).toBeUndefined();
    expect(r.owed("A")).toEqual([]);
  });

  it("a lost send is a notice, a native reply's or a tool call's; never a late result", () => {
    const store = new SentStore();
    const r = new Receipts(store);
    r.sending(frame, "ns", true);
    expect(r.lost("f1")).toMatchObject({ msgId: "f1", state: "lost" });
    r.sending({ ...frame, id: "f2" }, "ns", false);
    expect(r.lost("f2")).toMatchObject({ msgId: "f2", state: "lost" });
    expect(store.lateFor("A")).toEqual([]);
    expect(r.owed("A").map((n) => n.msgId)).toEqual(["f1", "f2"]);
  });
});

group("Resends", () => {
  const frame = {
    v: 1 as const,
    id: "f1",
    type: "send" as const,
    from_ref: "A",
    to_name: "bob",
    body: "hi",
  };
  const make = (send: (f: unknown, unsent: () => void) => boolean) => {
    const c = clock();
    const expire = vi.fn();
    const r = new Resends({
      send,
      expire,
      after: c.after,
      now: c.now,
      graceMs: 10_000,
    });
    r.track(frame, false);
    r.dropped();
    return { c, r, expire };
  };

  it("an overdue resend the hub never answers is given up a grace period later", () => {
    const { c, r, expire } = make(() => true);
    r.up("A");
    c.advance(60_000);
    expect(expire).not.toHaveBeenCalled();
    c.advance(10_000);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("an overdue resend the hub rate-limits is given up, not retried", () => {
    const send = vi.fn(() => true);
    const { c, r, expire } = make(send);
    r.up("A");
    c.advance(60_000);
    expect(r.limited("f1")).toBe(true);
    expect(expire).toHaveBeenCalledTimes(1);
    c.advance(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a resend that could not be queued goes again on the next agent_ok", () => {
    const send = vi.fn(() => false);
    const { r } = make(send);
    r.up("A");
    send.mockReturnValue(true);
    r.up("A");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a resend the pacer dropped unsent goes again after a backoff", () => {
    let unsent = () => {};
    const send = vi.fn((_f: unknown, u: () => void) => {
      unsent = u;
      return true;
    });
    const { c, r } = make(send);
    r.up("A");
    unsent();
    c.advance(1000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
