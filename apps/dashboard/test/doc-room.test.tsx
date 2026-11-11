import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  AWARENESS_MS,
  createDocRoom,
  DOC_TOO_LARGE,
  errorCopy,
  UPDATE_BATCH_MS,
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
    expect(DOC_TOO_LARGE).toBe("This doc is at its size limit for your plan.");
    room.destroy();
  });

  it("after doc_too_large reconnects the provider once to resync", () => {
    const room = open();
    fake.connect();
    expect([fake.connects, fake.disconnects]).toEqual([1, 0]);
    const frame = JSON.stringify({ type: "error", code: "doc_too_large" });
    fake.frame(frame);
    vi.advanceTimersByTime(1);
    expect([fake.connects, fake.disconnects]).toEqual([2, 1]);
    expect(room.getSnapshot().error).toBe("doc_too_large");
    // Synced again: the room is back to Saved, the error still shown.
    expect(room.getSnapshot().status).toBe("saved");
    // The new socket is watched too, and a repeat does not reconnect again.
    fake.frame(frame);
    vi.advanceTimersByTime(1000);
    expect([fake.connects, fake.disconnects]).toEqual([2, 1]);
    room.destroy();
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
