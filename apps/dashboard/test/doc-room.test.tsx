import { accessChangedCloseReason } from "@oa/shared";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  AWARENESS_MS,
  BAD_FRAME,
  BUSY_STABLE_MS,
  busyDelay,
  createDocRoom,
  DOC_TOO_LARGE,
  defaultProvider,
  errorCopy,
  NOT_FOUND,
  nearCap,
  ROOM_FULL,
  ROOM_FULL_RETRY,
  roomNotice,
  roomShouldReconnect,
  showsNote,
  UPDATE_BATCH_MS,
  versionNote,
} from "../src/viewer/doc/useDocRoom";
import { FakeProvider } from "./doc-fake-provider";

let fake: FakeProvider;
const open = () =>
  createDocRoom((ydoc) => {
    fake = new FakeProvider(ydoc);
    return fake;
  });
const type = (room: ReturnType<typeof open>, text: string) =>
  room.ydoc.getText("t").insert(0, text);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("doc room status", () => {
  it("is connecting, then Saved once connected and synced", () => {
    const room = open();
    expect(room.getSnapshot().status).toBe("connecting");
    fake.connect();
    expect(room.getSnapshot().status).toBe("saved");
    room.destroy();
  });

  it("says Saving while a local update is unsent or undrained, then Saved", () => {
    const room = open();
    fake.connect();
    type(room, "hi");
    expect(room.getSnapshot().status).toBe("saving");
    vi.advanceTimersByTime(UPDATE_BATCH_MS);
    expect(fake.sentUpdates).toHaveLength(1);
    // Sent, but the socket still holds bytes.
    (fake.ws as { bufferedAmount: number }).bufferedAmount = 10;
    vi.advanceTimersByTime(200);
    expect(room.getSnapshot().status).toBe("saving");
    (fake.ws as { bufferedAmount: number }).bufferedAmount = 0;
    vi.advanceTimersByTime(200);
    expect(room.getSnapshot().status).toBe("saved");
    room.destroy();
  });

  it("says Offline when disconnected, and Saving until the resync", () => {
    const room = open();
    fake.connect();
    fake.disconnect();
    expect(room.getSnapshot().status).toBe("offline");
    type(room, "offline edit");
    vi.advanceTimersByTime(UPDATE_BATCH_MS + 200);
    expect(room.getSnapshot().status).toBe("offline");
    fake.connect(false);
    expect(room.getSnapshot().status).toBe("saving");
    fake.synced = true;
    act(() => fake.emitSync());
    expect(room.getSnapshot().status).toBe("saved");
    room.destroy();
  });

  it("notifies subscribers only on change", () => {
    const room = open();
    const seen: string[] = [];
    room.subscribe(() => seen.push(room.getSnapshot().status));
    fake.connect();
    type(room, "a");
    type(room, "b");
    vi.advanceTimersByTime(UPDATE_BATCH_MS + 200);
    expect(seen).toEqual(["saving", "saved", "saving", "saved"]);
    room.destroy();
  });
});

describe("doc room throttling", () => {
  it("merges edits into one send per batch", () => {
    const room = open();
    fake.connect();
    for (const c of "hello") room.ydoc.getText("t").insert(0, c);
    expect(fake.sentUpdates).toHaveLength(0);
    vi.advanceTimersByTime(UPDATE_BATCH_MS);
    expect(fake.sentUpdates).toHaveLength(1);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, fake.sentUpdates[0]);
    expect(copy.getText("t").toString()).toBe("olleh");
    room.destroy();
  });

  it("does not echo updates that came from the server", () => {
    const room = open();
    fake.connect();
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "x");
    Y.applyUpdate(room.ydoc, Y.encodeStateAsUpdate(remote), fake);
    vi.advanceTimersByTime(1000);
    expect(fake.sentUpdates).toHaveLength(0);
    room.destroy();
  });

  it("sends cursor updates at most every 250 ms", () => {
    const room = open();
    fake.connect();
    fake.awareness.setLocalStateField("user", { name: "A" });
    expect(fake.sentAwareness).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      fake.awareness.setLocalStateField("cursor", { i });
      vi.advanceTimersByTime(20);
    }
    expect(fake.sentAwareness.length).toBeLessThanOrEqual(2);
    vi.advanceTimersByTime(AWARENESS_MS);
    const n = fake.sentAwareness.length;
    expect(n).toBeLessThanOrEqual(3);
    vi.advanceTimersByTime(5 * AWARENESS_MS);
    expect(fake.sentAwareness).toHaveLength(n);
    room.destroy();
  });

  it("cleans up on destroy: flushes, leaves, and detaches", () => {
    const room = open();
    fake.connect();
    type(room, "last words");
    room.destroy();
    expect(fake.sentUpdates).toHaveLength(1);
    expect(fake.destroyed).toBe(true);
    expect(fake.awareness.getLocalState()).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(fake.sentUpdates).toHaveLength(1);
  });
});

describe("doc room error frames", () => {
  it("reads {type:'error', code} text frames and shows the size message", () => {
    const room = open();
    fake.connect();
    fake.frame(JSON.stringify({ type: "error", code: "doc_too_large" }));
    expect(room.getSnapshot().error).toBe("doc_too_large");
    expect(errorCopy("doc_too_large")).toBe(DOC_TOO_LARGE);
    expect(DOC_TOO_LARGE).toBe("This doc is full (2 MB).");
    room.destroy();
  });

  it("asks for a fresh room once after doc_too_large, and a replacement does not", () => {
    const onResync = vi.fn();
    const room = createDocRoom(
      (ydoc) => {
        fake = new FakeProvider(ydoc);
        return fake;
      },
      { onResync },
    );
    fake.connect();
    const frame = JSON.stringify({ type: "error", code: "doc_too_large" });
    fake.frame(frame);
    expect(onResync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(room.getSnapshot().error).toBe("doc_too_large");
    fake.frame(frame);
    vi.advanceTimersByTime(1000);
    expect(onResync).toHaveBeenCalledTimes(1);
    expect([fake.connects, fake.disconnects]).toEqual([1, 0]);
    room.destroy();

    // A replacement starts with the error and never asks again.
    const again = vi.fn();
    const next = createDocRoom(
      (ydoc) => {
        fake = new FakeProvider(ydoc);
        return fake;
      },
      { error: "doc_too_large", onResync: again },
    );
    expect(next.getSnapshot().error).toBe("doc_too_large");
    fake.connect();
    fake.frame(frame);
    vi.advanceTimersByTime(1000);
    expect(again).not.toHaveBeenCalled();
    next.destroy();
  });

  it("destroy(true) drops unsent edits", () => {
    const room = open();
    fake.connect();
    type(room, "rejected");
    room.destroy(true);
    expect(fake.sentUpdates).toHaveLength(0);
  });

  it("does not reconnect for other errors", () => {
    const room = open();
    fake.connect();
    fake.frame(JSON.stringify({ type: "error", code: "forbidden" }));
    vi.advanceTimersByTime(1000);
    expect([fake.connects, fake.disconnects]).toEqual([1, 0]);
    room.destroy();
  });

  it("ignores text that is not an error frame", () => {
    const room = open();
    fake.connect();
    fake.frame("not json");
    fake.frame(JSON.stringify({ type: "hello" }));
    expect(room.getSnapshot().error).toBeNull();
    room.destroy();
  });
});

describe("the wire spec: hello and close codes", () => {
  const hello = (role: string, extra: object = {}) =>
    JSON.stringify({
      type: "hello",
      role,
      bytes: 1000,
      cap: 2097152,
      version: 1,
      ...extra,
    });
  const ready = () => {
    const room = open();
    fake.connect();
    return room;
  };

  it("hello sets the role, reason and sizes from the server", () => {
    const room = ready();
    expect(room.getSnapshot().role).toBeNull();
    fake.frame(hello("read", { reason: "room_full" }));
    expect(room.getSnapshot()).toMatchObject({
      role: "read",
      reason: "room_full",
      bytes: 1000,
      cap: 2097152,
    });
    fake.frame(hello("edit"));
    expect(room.getSnapshot()).toMatchObject({ role: "edit", reason: null });
    room.destroy();
  });

  it("hello's version is kept; a malformed one is not (#2490)", () => {
    const room = ready();
    expect(room.getSnapshot().version).toBeNull();
    fake.frame(hello("edit", { version: 4 }));
    expect(room.getSnapshot().version).toBe(4);
    fake.frame(hello("edit", { version: -1 }));
    expect(room.getSnapshot().version).toBe(4);
    room.destroy();
  });

  it("a hello at the cap is doc_too_large without a resync; a later one under it clears it", () => {
    const onResync = vi.fn();
    const room = createDocRoom(
      (ydoc) => {
        fake = new FakeProvider(ydoc);
        return fake;
      },
      { onResync },
    );
    fake.connect();
    fake.frame(hello("edit", { bytes: 2097152 }));
    expect(room.getSnapshot().error).toBe("doc_too_large");
    vi.advanceTimersByTime(10);
    expect(onResync).not.toHaveBeenCalled();
    fake.frame(hello("edit", { bytes: 1000 }));
    expect(room.getSnapshot().error).toBeNull();
    room.destroy();
  });

  it("a viewer's hello says read with reason access", () => {
    const room = ready();
    fake.frame(hello("read", { reason: "access" }));
    expect(room.getSnapshot()).toMatchObject({
      role: "read",
      reason: "access",
    });
    expect(roomNotice(room.getSnapshot())).toBeNull();
    room.destroy();
  });

  it("a full room says so and offers to reconnect; reconnect reopens the socket", () => {
    const room = ready();
    fake.frame(hello("read", { reason: "room_full" }));
    expect(roomNotice(room.getSnapshot())).toEqual({
      text: ROOM_FULL,
      retry: ROOM_FULL_RETRY,
    });
    const before = [fake.connects, fake.disconnects];
    room.reconnect();
    expect([fake.connects, fake.disconnects]).toEqual([
      before[0] + 1,
      before[1] + 1,
    ]);
    room.destroy();
  });

  it("warns near the cap, not before and not past it", () => {
    const room = ready();
    fake.frame(hello("edit", { bytes: 1_000_000 }));
    expect(roomNotice(room.getSnapshot())).toBeNull();
    fake.frame(hello("edit", { bytes: 1_950_000 }));
    expect(roomNotice(room.getSnapshot())?.text).toBe(nearCap(1_950_000));
    expect(nearCap(1_950_000)).toBe(
      "This doc is almost full (1.9 of 2 MB). Images take the most space.",
    );
    room.destroy();
  });

  it("4401 auth_expired reconnects silently: nothing shown, nothing stopped", () => {
    const room = ready();
    fake.frame(hello("edit"));
    fake.close(4401);
    expect(room.getSnapshot().status).toBe("offline");
    vi.advanceTimersByTime(1000);
    const s = room.getSnapshot();
    expect([s.ended, s.error]).toEqual([null, null]);
    // A NEW socket opened (the provider's backoff, allowed by the policy) and
    // the doc is saved again; the room never calls disconnect.
    expect(fake.connects).toBe(2);
    expect(s.status).toBe("saved");
    expect(fake.disconnects).toBe(0);
    expect(roomNotice(s)).toBeNull();
    room.destroy();
  });

  it("4403 access_removed ends it: no retry, the spec's copy", () => {
    const room = ready();
    fake.close(4403);
    const s = room.getSnapshot();
    expect(s.ended).toBe("access_removed");
    expect(roomNotice(s)?.text).toBe("You no longer have access.");
    // The room stops y-websocket's reconnecting: one disconnect() after the close.
    expect(fake.disconnects).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(fake.connects).toBe(1);
    room.destroy();
  });

  it("4403 'access changed; retry after N ms' (#2154) reconnects after N ms, not final", () => {
    const room = ready();
    fake.close(4403, accessChangedCloseReason(1500));
    expect(room.getSnapshot().ended).toBeNull();
    vi.advanceTimersByTime(1499);
    expect(fake.connects).toBe(1);
    vi.advanceTimersByTime(1);
    expect(fake.connects).toBe(2);
    expect(room.getSnapshot().ended).toBeNull();
    room.destroy();
  });

  it("4403 after a hello reconnects; the next hello clears it; a close before one ends it", () => {
    const room = ready();
    fake.frame(JSON.stringify({ type: "hello", role: "edit" }));
    fake.close(4403);
    expect(room.getSnapshot().ended).toBeNull();
    vi.advanceTimersByTime(250);
    expect(fake.connects).toBe(2);
    fake.frame(JSON.stringify({ type: "hello", role: "edit" }));
    // Another access change: same again, but this time the reconnect fails.
    fake.close(4403);
    vi.advanceTimersByTime(250);
    expect(fake.connects).toBe(3);
    fake.close(1006);
    expect(room.getSnapshot().ended).toBe("access_removed");
    vi.advanceTimersByTime(5000);
    expect(fake.connects).toBe(3);
    room.destroy();
  });

  it("4404 not_found ends it with the gone copy", () => {
    const room = ready();
    fake.close(4404);
    expect(room.getSnapshot().ended).toBe("not_found");
    expect(roomNotice(room.getSnapshot())?.text).toBe(NOT_FOUND);
    vi.advanceTimersByTime(5000);
    expect(fake.connects).toBe(1);
    room.destroy();
  });

  it("1007 bad_frame reconnects once, then stops and reports", () => {
    const room = ready();
    fake.close(1007);
    vi.advanceTimersByTime(1);
    expect(room.getSnapshot().ended).toBeNull();
    expect(fake.connects).toBe(2);
    fake.close(1007);
    expect(room.getSnapshot().ended).toBe("bad_frame");
    expect(roomNotice(room.getSnapshot())?.text).toBe(BAD_FRAME);
    vi.advanceTimersByTime(5000);
    expect(fake.connects).toBe(2);
    room.destroy();
  });

  it("1013 try_again is left to the provider's backoff", () => {
    const room = ready();
    fake.close(1013);
    expect(room.getSnapshot().status).toBe("offline");
    vi.advanceTimersByTime(5000);
    const s = room.getSnapshot();
    // Not ended: the room waits its own delay, then reconnects.
    expect(s.ended).toBeNull();
    expect(fake.connects).toBe(2);
    expect(s.status).toBe("saved");
    room.destroy();
  });
});

describe("1013 try_again backs off by itself", () => {
  afterEach(() => vi.restoreAllMocks());

  it("busyDelay: 1 s, 2 s, 4 s ... capped at 30 s, with up to 25% off, and still growing", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => busyDelay(n, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect([0, 1, 2, 3, 4, 5].map((n) => busyDelay(n, () => 0))).toEqual([
      750, 1500, 3000, 6000, 12000, 22500,
    ]);
    // Worst case for each step is still shorter than the best of the next.
    for (let n = 0; n < 4; n++)
      expect(busyDelay(n, () => 1)).toBeLessThan(busyDelay(n + 1, () => 0));
  });

  it("each 1013 waits longer than the last; the provider's own 200 ms retry is stopped", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const room = open();
    fake.connect();
    const gaps: number[] = [];
    for (const want of [1000, 2000, 4000, 8000]) {
      const before = fake.connects;
      fake.close(1013);
      // Not before the delay (y-websocket alone would retry at 200 ms) ...
      vi.advanceTimersByTime(want - 1);
      expect(fake.connects, `before ${want}`).toBe(before);
      // ... and at it.
      vi.advanceTimersByTime(1);
      expect(fake.connects, `at ${want}`).toBe(before + 1);
      gaps.push(want);
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000]);
    room.destroy();
  });

  it("caps at 30 s", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const room = open();
    fake.connect();
    // Each reconnect is closed again at once, so nothing resets the count.
    for (const wait of [1000, 2000, 4000, 8000, 16000, 30000]) {
      fake.close(1013);
      vi.advanceTimersByTime(wait);
    }
    const before = fake.connects;
    fake.close(1013);
    vi.advanceTimersByTime(29_999);
    expect(fake.connects).toBe(before);
    vi.advanceTimersByTime(1);
    expect(fake.connects).toBe(before + 1);
    room.destroy();
  });

  it("resets once a connection has stayed up 10 s", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const room = open();
    fake.connect();
    for (const want of [1000, 2000]) {
      fake.close(1013);
      vi.advanceTimersByTime(want);
    }
    // Up for 10 s: the room is not busy any more.
    vi.advanceTimersByTime(BUSY_STABLE_MS);
    const before = fake.connects;
    fake.close(1013);
    vi.advanceTimersByTime(999);
    expect(fake.connects).toBe(before);
    vi.advanceTimersByTime(1);
    expect(fake.connects).toBe(before + 1);
    room.destroy();
  });

  it("a connection that dies before 10 s does not reset it", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const room = open();
    fake.connect();
    fake.close(1013);
    vi.advanceTimersByTime(1000);
    // Reconnected, then closed again after 9 s: the next wait is 2 s, not 1 s.
    vi.advanceTimersByTime(9000);
    const before = fake.connects;
    fake.close(1013);
    vi.advanceTimersByTime(1999);
    expect(fake.connects).toBe(before);
    vi.advanceTimersByTime(1);
    expect(fake.connects).toBe(before + 1);
    room.destroy();
  });

  it("destroying the room cancels a pending reconnect", () => {
    const room = open();
    fake.connect();
    fake.close(1013);
    room.destroy();
    const before = fake.connects;
    vi.advanceTimersByTime(60_000);
    expect(fake.connects).toBe(before);
  });

  it("4401 still reconnects on the provider's own backoff", () => {
    const room = open();
    fake.connect();
    fake.close(4401);
    vi.advanceTimersByTime(200);
    expect(fake.connects).toBe(2);
    room.destroy();
  });
});

describe("the reconnect policy", () => {
  it("only 4403 and 4404 are final; 4401, 1007 and 1013 reconnect", () => {
    for (const code of [4401, 1007, 1013, 1006])
      expect(roomShouldReconnect({ code }), String(code)).toBe(true);
    for (const code of [4403, 4404])
      expect(roomShouldReconnect({ code }), String(code)).toBe(false);
    expect(
      roomShouldReconnect({
        code: 4403,
        reason: accessChangedCloseReason(250),
      }),
    ).toBe(true);
  });

  it("defaultProvider hands the policy to y-websocket, which by default would stop at 4401", () => {
    const doc = new Y.Doc();
    const p = defaultProvider("A1", doc) as unknown as {
      shouldReconnect: (e: { code: number }) => boolean;
      destroy(): void;
    };
    try {
      expect(p.shouldReconnect({ code: 4401 })).toBe(true);
      expect(p.shouldReconnect({ code: 4403 })).toBe(false);
      expect(p.shouldReconnect({ code: 4404 })).toBe(false);
    } finally {
      p.destroy();
      doc.destroy();
    }
  });

  it("rate_limited and bad_update are ignored: no error, no alert copy", () => {
    const room = open();
    fake.connect();
    fake.frame(JSON.stringify({ type: "error", code: "rate_limited" }));
    expect(room.getSnapshot().error).toBeNull();
    // #2154 sends bad_update before its 1007 close; the close handler answers.
    fake.frame(JSON.stringify({ type: "error", code: "bad_update" }));
    expect(room.getSnapshot().error).toBeNull();
    expect(errorCopy(room.getSnapshot().error)).toBeNull();
    // Other codes still show the generic message.
    fake.frame(JSON.stringify({ type: "error", code: "forbidden" }));
    expect(room.getSnapshot().error).toBe("forbidden");
    room.destroy();
  });
});

describe("the wire spec: saved and restored", () => {
  const events = () => {
    const room = open();
    fake.connect();
    const seen: unknown[] = [];
    room.onVersion((e) => seen.push(e));
    return { room, seen };
  };

  it("a saved frame becomes a version event, named or not, auto or not", () => {
    const { room, seen } = events();
    fake.frame(JSON.stringify({ type: "saved", version: 5, auto: true }));
    fake.frame(
      JSON.stringify({
        type: "saved",
        version: 6,
        name: "Before launch",
        auto: false,
      }),
    );
    expect(seen).toEqual([
      { kind: "saved", version: 5, auto: true },
      { kind: "saved", version: 6, name: "Before launch", auto: false },
    ]);
    expect(versionNote(seen[0] as never)).toBe("Saved as v5");
    expect(versionNote(seen[1] as never)).toBe("Saved as v6 (Before launch)");
    room.destroy();
  });

  it("a restored frame becomes an event; the text arrives as a doc update, so nothing reloads", () => {
    const { room, seen } = events();
    fake.frame(JSON.stringify({ type: "restored", from: 3, version: 7 }));
    expect(seen).toEqual([{ kind: "restored", from: 3, version: 7 }]);
    expect(versionNote(seen[0] as never)).toBe("Restored v3 as v7");
    // Not an error, and the room is untouched.
    expect(room.getSnapshot().error).toBeNull();
    expect(fake.connects).toBe(1);
    room.destroy();
  });

  it("only named saves and restores get a note; auto-saves are quiet", () => {
    expect(showsNote({ kind: "saved", version: 5, auto: true })).toBe(false);
    expect(showsNote({ kind: "saved", version: 5, auto: false })).toBe(true);
    expect(
      showsNote({
        kind: "saved",
        version: 6,
        name: "Before launch",
        auto: false,
      }),
    ).toBe(true);
    expect(showsNote({ kind: "restored", from: 3, version: 7 })).toBe(true);
  });

  it("ignores malformed version frames and stops after unsubscribe", () => {
    const room = open();
    fake.connect();
    const seen: unknown[] = [];
    const off = room.onVersion((e) => seen.push(e));
    fake.frame(JSON.stringify({ type: "saved" }));
    fake.frame(JSON.stringify({ type: "restored", version: 2 }));
    expect(seen).toEqual([]);
    off();
    fake.frame(JSON.stringify({ type: "saved", version: 9, auto: false }));
    expect(seen).toEqual([]);
    room.destroy();
  });
});

describe("4401, then the session is gone (logged out)", () => {
  const HELLO = JSON.stringify({ type: "hello", role: "edit" });
  const withAuth = (signedIn: boolean) => {
    const checkAuth = vi.fn(async () => signedIn);
    const room = createDocRoom(
      (ydoc) => {
        fake = new FakeProvider(ydoc);
        return fake;
      },
      { checkAuth },
    );
    fake.connect();
    fake.frame(HELLO);
    return { room, checkAuth };
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("a 4401 and a reconnect that gets its hello: no check, nothing ends", async () => {
    const { room, checkAuth } = withAuth(true);
    fake.close(4401);
    vi.advanceTimersByTime(200);
    fake.frame(HELLO);
    await flush();
    expect(checkAuth).not.toHaveBeenCalled();
    expect(room.getSnapshot().ended).toBeNull();
    room.destroy();
  });

  it("a reconnect refused before its hello while still signed in keeps trying", async () => {
    const { room, checkAuth } = withAuth(true);
    fake.close(4401);
    fake.refuse = true;
    vi.advanceTimersByTime(200);
    fake.close(1006);
    await flush();
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(room.getSnapshot().ended).toBeNull();
    vi.advanceTimersByTime(200);
    expect(fake.connects).toBe(3);
    room.destroy();
  });

  it("signed out with nothing unsent: ends signed_out, says the changes are saved, offers Log in", async () => {
    const { room, checkAuth } = withAuth(false);
    // An edit made and sent while connected.
    type(room, "sent before the cut");
    vi.advanceTimersByTime(UPDATE_BATCH_MS + 100);
    expect(room.getSnapshot().status).toBe("saved");
    fake.close(4401);
    fake.refuse = true;
    vi.advanceTimersByTime(200);
    fake.close(1006);
    await flush();
    expect(checkAuth).toHaveBeenCalled();
    const s = room.getSnapshot();
    expect([s.ended, s.endSaved]).toEqual(["signed_out", true]);
    expect(roomNotice(s)).toEqual({
      text: "You've been logged out. Log in again to keep editing. Your changes are saved.",
      login: "Log in",
    });
    // No more reconnects: it stopped.
    const n = fake.connects;
    vi.advanceTimersByTime(10_000);
    expect(fake.connects).toBe(n);
    room.destroy();
  });

  it("signed out with an edit written after the cut: no 'saved' line, and the edit exists only in this tab's memory", async () => {
    const { room } = withAuth(false);
    fake.close(4401);
    fake.refuse = true;
    // Typed while the socket was down: never sent.
    const sent = fake.sentUpdates.length;
    type(room, "written offline");
    vi.advanceTimersByTime(UPDATE_BATCH_MS + 10);
    // The reconnect (y-websocket's backoff) is refused before its hello.
    vi.advanceTimersByTime(200);
    fake.close(1006);
    await flush();
    const s = room.getSnapshot();
    expect([s.ended, s.endSaved]).toEqual(["signed_out", false]);
    expect(roomNotice(s)?.text).toBe(
      "You've been logged out. Log in again to keep editing.",
    );
    // Evidence: it never left (the fake records every send), and nothing
    // keeps it across a page load: a new room (signing in reloads the page)
    // starts from an empty Y.Doc and only gets what the server holds.
    const offline = fake.sentUpdates.slice(sent).some((u) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, u);
      return d.getText("t").toString().includes("written offline");
    });
    expect(offline).toBe(false);
    expect(room.ydoc.getText("t").toString()).toContain("written offline");
    const after = open();
    expect(after.ydoc.getText("t").toString()).toBe("");
    after.destroy();
    room.destroy();
  });
});
