import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DELIVERED_WAIT_MS, Receipts, SentStore } from "../src/sent.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");
const meta = { from_ref: "s1", to_name: "peer", namespace: "ns" };
const ID = "mmmmmmmmmmmmmmm1";

describe("SentStore", () => {
  it("survives a restart, 0600, until deleted", () => {
    const f = file();
    const s = new SentStore(f);
    s.add(ID, meta);
    s.flush();
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const next = new SentStore(f);
    expect(next.get(ID)).toEqual(meta);
    next.delete(ID);
    expect(next.get(ID)).toBeUndefined();
    next.flush();
    expect(new SentStore(f).get(ID)).toBeUndefined();
  });

  it("keeps the excerpt across a restart, and still loads an entry without one", () => {
    const f = file();
    const s = new SentStore(f);
    s.add(ID, { ...meta, excerpt: "Can you regenerate…" });
    s.add("mmmmmmmmmmmmmmm2", meta);
    s.flush();
    const next = new SentStore(f);
    expect(next.get(ID)).toEqual({ ...meta, excerpt: "Can you regenerate…" });
    expect(next.get("mmmmmmmmmmmmmmm2")).toEqual(meta);
  });

  it("drops a stored excerpt that could break the quoting", () => {
    const f = file();
    const at = Date.now();
    writeFileSync(
      f,
      JSON.stringify({
        [ID]: { ...meta, at, excerpt: 'a "b"' },
        mmmmmmmmmmmmmmm2: { ...meta, at, excerpt: "a\nb" },
        mmmmmmmmmmmmmmm3: { ...meta, at, excerpt: 7 },
      }),
    );
    const s = new SentStore(f);
    for (const id of [ID, "mmmmmmmmmmmmmmm2", "mmmmmmmmmmmmmmm3"])
      expect(s.get(id)).toEqual(meta);
  });

  it("keeps an untold outcome across a restart", () => {
    const f = file();
    const s = new SentStore(f);
    s.add(ID, meta);
    s.settle(ID, { state: "expired", reason: "recipient_closed" });
    s.flush();
    expect(new SentStore(f).untold("s1")).toEqual([
      {
        msgId: ID,
        meta,
        outcome: { state: "expired", reason: "recipient_closed" },
      },
    ]);
    expect(new SentStore(f).untold("other")).toEqual([]);
  });

  it("an owed notice lives a full TTL from when its outcome settled", () => {
    let t = 0;
    const s = new SentStore(file(), { ttlMs: 65 * 60_000, now: () => t });
    s.add(ID, meta);
    t = 60 * 60_000;
    s.settle(ID, { state: "expired" });
    t = 120 * 60_000;
    expect(s.untold("s1")).toEqual([
      { msgId: ID, meta, outcome: { state: "expired" } },
    ]);
    t = 126 * 60_000;
    expect(s.untold("s1")).toEqual([]);
  });

  it("batches writes: one per tick, however many changes", async () => {
    const f = file();
    const s = new SentStore(f);
    for (let i = 1; i <= 9; i++) s.add(`mmmmmmmmmmmmmmm${i}`, meta);
    s.delete("mmmmmmmmmmmmmmm9");
    expect(() => statSync(f)).toThrow();
    await new Promise((r) => setImmediate(r));
    expect(Object.keys(JSON.parse(readFileSync(f, "utf8")))).toHaveLength(8);
  });

  it("forgets entries past the TTL and prunes them from disk", () => {
    const f = file();
    let t = 0;
    const s = new SentStore(f, { ttlMs: 1000, now: () => t });
    s.add(ID, meta);
    t = 2000;
    s.add("mmmmmmmmmmmmmmm2", meta);
    s.flush();
    expect(Object.keys(JSON.parse(readFileSync(f, "utf8")))).toEqual([
      "mmmmmmmmmmmmmmm2",
    ]);
    expect(
      new SentStore(f, { ttlMs: 1000, now: () => t }).get(ID),
    ).toBeUndefined();
  });

  it("keeps at most max entries, dropping the oldest", () => {
    let t = 0;
    const s = new SentStore(file(), { max: 2, now: () => ++t });
    s.add("mmmmmmmmmmmmmmm1", meta);
    s.add("mmmmmmmmmmmmmmm2", meta);
    s.add("mmmmmmmmmmmmmmm3", meta);
    expect(s.get("mmmmmmmmmmmmmmm1")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm3")).toEqual(meta);
  });

  it("ignores a corrupt or hostile file", () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        __proto__: { from_ref: "x" },
        "bad id": { ...meta, at: Date.now() },
        mmmmmmmmmmmmmmm1: {
          from_ref: "bad ref/..",
          to_name: "p",
          at: Date.now(),
        },
        mmmmmmmmmmmmmmm2: { ...meta, at: "now" },
        mmmmmmmmmmmmmmm3: { ...meta, at: Date.now(), outcome: { state: "x" } },
      }),
    );
    const s = new SentStore(f);
    expect(s.get("bad id")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm1")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm2")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm3")).toBeUndefined();
    writeFileSync(f, "{not json");
    expect(new SentStore(f).get(ID)).toBeUndefined();
  });

  it("logs a failed write and keeps serving from memory", () => {
    const log = vi.fn();
    const s = new SentStore(join(file(), "missing-dir", "sent.json"), { log });
    s.add(ID, meta);
    s.flush();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/sent file write failed/),
    );
    expect(s.get(ID)).toEqual(meta);
  });
});

describe("Receipts", () => {
  const hi = { ...meta, excerpt: "hi" };
  const send = (id: string) => ({
    v: 1 as const,
    id,
    type: "send" as const,
    from_ref: "s1",
    to_name: "peer",
    body: "hi",
  });

  it("tells a native sender of a refusal at once; a tool call reads its own", () => {
    const r = new Receipts(new SentStore());
    r.sending(send("f1"), "ns", true);
    r.sending(send("f2"), "ns", false);
    const refused = (id: string) =>
      r.receipt({ id, msg_id: ID, state: "refused", reason: "too_large" });
    expect(refused("f1")).toEqual({
      msgId: ID,
      meta: hi,
      state: "refused",
      reason: "too_large",
    });
    expect(refused("f2")).toBeUndefined();
    expect(refused("f3")).toBeUndefined();
  });

  it("forgets a send whose receipt never came, or that the hub answered with an error", () => {
    let t = 0;
    const r = new Receipts(new SentStore(), { now: () => t });
    r.sending(send("f1"), "ns", true);
    r.sending(send("f3"), "ns", true);
    r.forget("f3");
    expect(
      r.receipt({ id: "f3", msg_id: ID, state: "refused", reason: "closed" }),
    ).toBeUndefined();
    t = 16 * 60_000;
    r.sending(send("f2"), "ns", true);
    expect(
      r.receipt({ id: "f1", msg_id: ID, state: "refused", reason: "closed" }),
    ).toBeUndefined();
  });

  it("an update that beats its receipt is applied when the receipt comes, within 60 s", () => {
    let t = 0;
    const r = new Receipts(new SentStore(), { now: () => t });
    r.sending(send("f1"), "ns", false);
    expect(r.update({ msg_id: ID, state: "expired" })).toBeUndefined();
    expect(r.receipt({ id: "f1", msg_id: ID, state: "pending" })).toEqual({
      msgId: ID,
      meta: hi,
      state: "expired",
    });
    const late = "mmmmmmmmmmmmmmm2";
    r.sending(send("f2"), "ns", false);
    r.update({ msg_id: late, state: "expired" });
    t = 61_000;
    expect(
      r.receipt({ id: "f2", msg_id: late, state: "pending" }),
    ).toBeUndefined();
  });

  it("keeps a notice owed until told", () => {
    const r = new Receipts(new SentStore());
    r.sending(send("f1"), "ns", false);
    r.receipt({ id: "f1", msg_id: ID, state: "pending" });
    r.update({ msg_id: ID, state: "refused", reason: "closed" });
    expect(r.owed("s1")).toEqual([
      { msgId: ID, meta: hi, state: "refused", reason: "closed" },
    ]);
    r.told(ID);
    expect(r.owed("s1")).toEqual([]);
  });
});

describe("Receipts: a send waits for delivery (C17)", () => {
  const send = (id: string) => ({
    v: 1 as const,
    id,
    type: "send" as const,
    from_ref: "s1",
    to_name: "peer",
    body: "hi",
  });
  const ID2 = "mmmmmmmmmmmmmmm2";
  /** A tool call's send: its receipt came back pending and it now waits. */
  const waiting = (r: Receipts, frameId: string, msgId: string) => {
    r.sending(send(frameId), "ns", false);
    expect(
      r.receipt({ id: frameId, msg_id: msgId, state: "pending" }, true),
    ).toBeUndefined();
    return r.final(msgId, DELIVERED_WAIT_MS);
  };
  const withClock = async (fn: () => Promise<void>) => {
    vi.useFakeTimers();
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  };

  it("waits at most 5 s", () => {
    expect(DELIVERED_WAIT_MS).toBeLessThanOrEqual(5000);
  });

  it("answers delivered inside the window, and records it", () =>
    withClock(async () => {
      const store = new SentStore();
      const r = new Receipts(store);
      const final = waiting(r, "f1", ID);
      await vi.advanceTimersByTimeAsync(DELIVERED_WAIT_MS - 1);
      expect(r.update({ msg_id: ID, state: "delivered" })).toBeUndefined();
      await expect(final).resolves.toEqual({ msg_id: ID, state: "delivered" });
      expect(store.isDelivered(ID)).toBe(true);
      expect(r.owed("s1")).toEqual([]);
    }));

  it("answers queued at the window's end; a later delivered is recorded, never a notice", () =>
    withClock(async () => {
      const store = new SentStore();
      const r = new Receipts(store);
      const final = waiting(r, "f1", ID);
      await vi.advanceTimersByTimeAsync(DELIVERED_WAIT_MS);
      await expect(final).resolves.toBeUndefined();
      expect(store.isDelivered(ID)).toBe(false);
      expect(r.update({ msg_id: ID, state: "delivered" })).toBeUndefined();
      expect(store.isDelivered(ID)).toBe(true);
      expect(r.owed("s1")).toEqual([]);
      // Nothing follows delivered: a later expiry is not a notice either.
      expect(r.update({ msg_id: ID, state: "expired" })).toBeUndefined();
      expect(r.owed("s1")).toEqual([]);
    }));

  it.each([
    [{ state: "refused", reason: "closed" }],
    [{ state: "expired" }],
    [{ state: "expired", reason: "recipient_closed" }],
  ] as const)(
    "answers %o inside the window, told there and not again as a notice",
    (update) =>
      withClock(async () => {
        const r = new Receipts(new SentStore());
        const final = waiting(r, "f1", ID);
        await vi.advanceTimersByTimeAsync(1000);
        expect(r.update({ msg_id: ID, ...update })).toBeUndefined();
        await expect(final).resolves.toEqual({ msg_id: ID, ...update });
        // Owed until the caller knows the tool result was written.
        expect(r.notice(ID)?.msgId).toBe(ID);
        r.told(ID);
        expect(r.owed("s1")).toEqual([]);
      }),
  );

  it("an update that beats the receipt answers the waiting send", () =>
    withClock(async () => {
      const store = new SentStore();
      const r = new Receipts(store);
      r.sending(send("f1"), "ns", false);
      expect(r.update({ msg_id: ID, state: "delivered" })).toBeUndefined();
      expect(
        r.receipt({ id: "f1", msg_id: ID, state: "pending" }, true),
      ).toBeUndefined();
      await expect(r.final(ID, DELIVERED_WAIT_MS)).resolves.toEqual({
        msg_id: ID,
        state: "delivered",
      });
      expect(store.isDelivered(ID)).toBe(true);
    }));

  it("an early refusal answers the waiting send, and is no notice", () =>
    withClock(async () => {
      const r = new Receipts(new SentStore());
      r.sending(send("f1"), "ns", false);
      r.update({ msg_id: ID, state: "refused", reason: "closed" });
      expect(
        r.receipt({ id: "f1", msg_id: ID, state: "pending" }, true),
      ).toBeUndefined();
      await expect(r.final(ID, DELIVERED_WAIT_MS)).resolves.toEqual({
        msg_id: ID,
        state: "refused",
        reason: "closed",
      });
      // Owed until the caller knows the tool result was written.
      expect(r.notice(ID)?.msgId).toBe(ID);
      r.told(ID);
      expect(r.owed("s1")).toEqual([]);
    }));

  it("two concurrent sends resolve independently", () =>
    withClock(async () => {
      const r = new Receipts(new SentStore());
      const a = waiting(r, "f1", ID);
      const b = waiting(r, "f2", ID2);
      await vi.advanceTimersByTimeAsync(1000);
      r.update({ msg_id: ID2, state: "delivered" });
      await expect(b).resolves.toEqual({ msg_id: ID2, state: "delivered" });
      let doneA = false;
      void a.then(() => {
        doneA = true;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(doneA).toBe(false);
      r.update({ msg_id: ID, state: "refused", reason: "closed" });
      await expect(a).resolves.toEqual({
        msg_id: ID,
        state: "refused",
        reason: "closed",
      });
    }));

  it("a dropped hub link answers every waiting send as queued, at once", () =>
    withClock(async () => {
      const r = new Receipts(new SentStore());
      const a = waiting(r, "f1", ID);
      const b = waiting(r, "f2", ID2);
      await vi.advanceTimersByTimeAsync(100);
      r.release();
      await expect(a).resolves.toBeUndefined();
      await expect(b).resolves.toBeUndefined();
      // After the drop an expiry is a notice again.
      expect(r.update({ msg_id: ID, state: "expired" })).toMatchObject({
        msgId: ID,
        state: "expired",
      });
    }));

  it("a native send (no tool call waits) is not held", () =>
    withClock(async () => {
      const r = new Receipts(new SentStore());
      r.sending(send("f1"), "ns", true);
      r.receipt({ id: "f1", msg_id: ID, state: "pending" });
      await expect(r.final(ID, DELIVERED_WAIT_MS)).resolves.toBeUndefined();
      expect(r.update({ msg_id: ID, state: "expired" })).toMatchObject({
        state: "expired",
      });
    }));
});

describe("late deliveries (C17 part 2)", () => {
  const send = (id: string, from_ref = "s1") => ({
    v: 1 as const,
    id,
    type: "send" as const,
    from_ref,
    to_name: "peer",
    body: "hi",
  });
  const ID2 = "mmmmmmmmmmmmmmm2";

  it("only a delivered past the window is late; each is handed out once, to its own sender", async () => {
    let t = 1000;
    const store = new SentStore(undefined, { now: () => t });
    const r = new Receipts(store, { now: () => t });
    r.sending(send("f1"), "ns", false, "alice");
    r.receipt({ id: "f1", msg_id: ID, state: "pending" }, true);
    const final = r.final(ID, 1000);
    r.update({ msg_id: ID, state: "delivered" });
    await final;
    r.sending(send("f2"), "ns", false, "alice");
    r.receipt({ id: "f2", msg_id: ID2, state: "pending" });
    t = 2000;
    r.update({ msg_id: ID2, state: "delivered" });
    expect(store.lateFor("s2")).toEqual([]);
    expect(store.lateFor("s1")).toEqual([
      { msgId: ID2, meta: { ...meta, from_name: "alice", excerpt: "hi" } },
    ]);
    store.shown([ID2]);
    expect(store.lateFor("s1")).toEqual([]);
  });

  it("status reads every late delivery of the last hour without marking it shown", () => {
    let t = 0;
    const store = new SentStore(undefined, { now: () => t });
    const r = new Receipts(store, { now: () => t });
    for (const [f, id, ref] of [
      ["f1", ID, "s1"],
      ["f2", ID2, "s2"],
    ] as const) {
      r.sending(send(f, ref), "ns", false, ref);
      r.receipt({ id: f, msg_id: id, state: "pending" });
    }
    r.update({ msg_id: ID, state: "delivered" });
    t = 30 * 60_000;
    r.update({ msg_id: ID2, state: "delivered" });
    t = 61 * 60_000;
    expect(store.lateSince(t - 3600_000)).toEqual([
      {
        msgId: ID2,
        meta: { ...meta, from_ref: "s2", from_name: "s2", excerpt: "hi" },
        at: 30 * 60_000,
      },
    ]);
    expect(store.lateFor("s2").map((l) => l.msgId)).toEqual([ID2]);
  });

  it("late and shown survive a restart", () => {
    const f = file();
    const s = new SentStore(f);
    const r = new Receipts(s);
    r.sending(send("f1"), "ns", false, "alice");
    r.receipt({ id: "f1", msg_id: ID, state: "pending" });
    r.sending(send("f2"), "ns", false, "alice");
    r.receipt({ id: "f2", msg_id: ID2, state: "pending" });
    r.update({ msg_id: ID, state: "delivered" });
    r.update({ msg_id: ID2, state: "delivered" });
    expect(s.lateFor("s1")).toHaveLength(2);
    s.shown([ID, ID2]);
    s.flush();
    const next = new SentStore(f);
    expect(next.lateFor("s1")).toEqual([]);
    expect(next.lateSince(0).map((l) => l.meta.from_name)).toEqual([
      "alice",
      "alice",
    ]);
  });
});

it("a native reply delivered is never late", () => {
  const store = new SentStore();
  const r = new Receipts(store);
  r.sending(
    {
      v: 1,
      id: "f1",
      type: "send",
      from_ref: "s1",
      to_name: "peer",
      body: "hi",
    },
    "ns",
    true,
  );
  r.receipt({ id: "f1", msg_id: ID, state: "pending" });
  r.update({ msg_id: ID, state: "delivered" });
  expect(store.lateFor("s1")).toEqual([]);
  expect(store.lateSince(0)).toEqual([]);
});

describe("C17 review fixes", () => {
  const ID2 = "mmmmmmmmmmmmmmm2";
  const ID3 = "mmmmmmmmmmmmmmm3";

  it("under the cap, a delivered record goes before a notice still owed", () => {
    const s = new SentStore(undefined, { max: 2 });
    s.add(ID, meta);
    s.settle(ID, { state: "expired" });
    s.add(ID2, meta);
    s.deliver(ID2);
    s.add(ID3, meta);
    expect(s.untold("s1").map((u) => u.msgId)).toEqual([ID]);
    expect(s.get(ID3)).toEqual(meta);
    expect(s.isDelivered(ID2)).toBe(false);
  });

  it("deliver() keeps an outcome already settled", () => {
    const s = new SentStore();
    s.add(ID, meta);
    s.settle(ID, { state: "expired" });
    s.deliver(ID, true);
    expect(s.untold("s1")).toEqual([
      { msgId: ID, meta, outcome: { state: "expired" } },
    ]);
    expect(s.isDelivered(ID)).toBe(false);
    expect(s.lateSince(0)).toEqual([]);
  });
});
