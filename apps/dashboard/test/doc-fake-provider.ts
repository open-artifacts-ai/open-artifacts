import { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import {
  type RoomProvider,
  roomShouldReconnect,
} from "../src/viewer/doc/useDocRoom";

// biome-ignore lint/suspicious/noExplicitAny: event args vary.
type Cb = (...a: any[]) => void;

/**
 * A stand-in for y-websocket's WebsocketProvider: the same fields and events
 * the room uses, and the same registered senders (which record what they send).
 */
export class FakeProvider implements RoomProvider {
  awareness: Awareness;
  wsconnected = false;
  synced = false;
  ws: {
    onmessage: ((e: { data: unknown }) => void) | null;
    bufferedAmount: number;
    addEventListener: (
      type: "close",
      cb: (e: { code: number; reason?: string }) => void,
    ) => void;
  } | null = null;
  private closers: ((e: { code: number; reason?: string }) => void)[] = [];
  sentUpdates: Uint8Array[] = [];
  sentAwareness: number[][] = [];
  destroyed = false;
  connects = 0;
  disconnects = 0;
  private handlers = new Map<string, Set<Cb>>();
  _updateHandler: (update: Uint8Array, origin: unknown) => void;
  _awarenessUpdateHandler: (c: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => void;

  /** y-websocket's: whether it reconnects after the server closes with a code. */
  shouldConnect = true;
  /** A hello frame sent on every connect, as the real room does (#2490); null: none. */
  autoHello: Record<string, unknown> | null = null;
  /** Upgrades are refused (a browser's 1006): sockets never open. */
  refuse = false;
  constructor(
    public doc: Y.Doc,
    public shouldReconnect: (e: {
      code: number;
      reason?: string;
    }) => boolean = roomShouldReconnect,
  ) {
    this.awareness = new Awareness(doc);
    this._updateHandler = (update, origin) => {
      // Like y-websocket's broadcastMessage: a closed socket drops it.
      if (origin !== this && this.wsconnected) this.sentUpdates.push(update);
    };
    this.doc.on("update", this._updateHandler);
    this._awarenessUpdateHandler = ({ added, updated, removed }) => {
      this.sentAwareness.push([...added, ...updated, ...removed]);
    };
    this.awareness.on("update", this._awarenessUpdateHandler);
  }
  on(event: string, cb: Cb) {
    const set = this.handlers.get(event) ?? new Set<Cb>();
    this.handlers.set(event, set);
    set.add(cb);
  }
  off(event: string, cb: Cb) {
    this.handlers.get(event)?.delete(cb);
  }
  private emit(event: string, ...args: unknown[]) {
    for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args);
  }
  /** The socket opens; `sync` also completes the sync exchange. */
  connect(sync = true) {
    this.shouldConnect = true;
    this.connects++;
    this.closers = [];
    this.ws = {
      onmessage: null,
      bufferedAmount: 0,
      addEventListener: (_t, cb) => this.closers.push(cb),
    };
    if (this.refuse) {
      // y-websocket says "connecting" for every socket it makes.
      this.emit("status", { status: "connecting" });
      return;
    }
    this.wsconnected = true;
    this.emit("status", { status: "connected" });
    if (this.autoHello)
      this.frame(
        JSON.stringify({
          type: "hello",
          role: "edit",
          bytes: 0,
          cap: 2097152,
          version: 1,
          ...this.autoHello,
        }),
      );
    if (sync) {
      this.synced = true;
      this.emit("sync", true);
    }
  }
  disconnect() {
    this.shouldConnect = false;
    this.disconnects++;
    this.wsconnected = false;
    this.synced = false;
    this.emit("status", { status: "disconnected" });
  }
  /** The server closes the socket with a code (the wire spec's 4401 ... 1013). */
  close(code: number, reason?: string) {
    for (const cb of [...this.closers]) cb({ code, reason });
    this.wsconnected = false;
    this.synced = false;
    this.emit("status", { status: "disconnected" });
    // Like y-websocket: a close the policy allows is retried after a backoff
    // (a no-op if something already reconnected); one it does not is final.
    if (!this.shouldReconnect({ code, reason })) this.shouldConnect = false;
    else
      setTimeout(() => {
        if (this.shouldConnect && !this.wsconnected) this.connect();
      }, 200);
  }
  emitSync() {
    this.emit("sync", this.synced);
  }
  /** The server sends a text frame. */
  frame(data: string) {
    this.ws?.onmessage?.({ data });
  }
  destroy() {
    this.destroyed = true;
  }
}

/** Builds providers and remembers the last one. */
export function fakeProviders() {
  const made: { last: FakeProvider | null } = { last: null };
  const make = (_id: string, ydoc: Y.Doc) => {
    made.last = new FakeProvider(ydoc);
    // An editor's room says hello like the real one; a test can change it.
    made.last.autoHello = {};
    return made.last;
  };
  return { make, made };
}
