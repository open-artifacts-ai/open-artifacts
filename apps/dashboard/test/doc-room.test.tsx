import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  AWARENESS_MS,
  BAD_FRAME,
  createDocRoom,
  DOC_TOO_LARGE,
  errorCopy,
  NOT_FOUND,
  nearCap,
  ROOM_FULL,
  ROOM_FULL_RETRY,
  roomNotice,
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
    vi.advanceTimersByTime(1000);
    const s = room.getSnapshot();
    expect([s.ended, s.error]).toEqual([null, null]);
    // The provider's own backoff reconnects; the room never calls disconnect.
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
    vi.advanceTimersByTime(5000);
    const s = room.getSnapshot();
    expect(s.ended).toBeNull();
    expect(s.status).toBe("offline");
    // Not stopped by the room.
    expect(fake.disconnects).toBe(0);
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
