import { useEffect, useState, useSyncExternalStore } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

/** Outgoing doc updates are merged and sent at most this often. */
export const UPDATE_BATCH_MS = 75;
/** Cursor (awareness) updates leave at most this often. */
export const AWARENESS_MS = 250;
/** How often to ask the socket whether it has flushed what we wrote. */
const DRAIN_POLL_MS = 50;

export type DocStatus = "connecting" | "saving" | "saved" | "offline";

export const DOC_TOO_LARGE = "This doc is at its size limit for your plan.";
/** The server's code for a rejected write that would grow the doc past its limit. */
export const DOC_TOO_LARGE_CODE = "doc_too_large";
const GENERIC_ERROR = "This doc can't save changes right now.";

/** The error copy for a server error code, or null for none. */
export function errorCopy(code: string | null): string | null {
  if (!code) return null;
  return code === DOC_TOO_LARGE_CODE ? DOC_TOO_LARGE : GENERIC_ERROR;
}

export interface DocSnapshot {
  status: DocStatus;
  /** The server's last error code ({type:"error", code}), if any. */
  error: string | null;
}

/** The part of y-websocket's WebsocketProvider the room uses. */
export interface RoomProvider {
  awareness: WebsocketProvider["awareness"];
  wsconnected: boolean;
  synced: boolean;
  ws: {
    onmessage: ((e: { data: unknown }) => void) | null;
    bufferedAmount?: number;
  } | null;
  // biome-ignore lint/suspicious/noExplicitAny: y-websocket's event args vary by event.
  on(event: string, cb: (...a: any[]) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  off(event: string, cb: (...a: any[]) => void): void;
  destroy(): void;
  // y-websocket's own senders. The room replaces them with batched ones.
  _updateHandler?: (update: Uint8Array, origin: unknown) => void;
  _awarenessUpdateHandler?: (
    c: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
}

export interface DocRoom {
  ydoc: Y.Doc;
  provider: RoomProvider;
  subscribe(cb: () => void): () => void;
  getSnapshot(): DocSnapshot;
  /** discard: drop unsent edits instead of sending them (a resync). */
  destroy(discard?: boolean): void;
}

/**
 * The server URL for a room (y-websocket joins it with the room name). The
 * real one is the page's own origin, authenticated by the session cookie. In
 * mock mode (VITE_MOCK) it is a local y-websocket server, VITE_DOC_WS.
 */
export function roomServerUrl(): string {
  if (import.meta.env.VITE_MOCK === "1")
    return import.meta.env.VITE_DOC_WS || "ws://localhost:1235";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/v1/artifacts`;
}

export const roomName = (artifactId: string) => `${artifactId}/doc`;

export function defaultProvider(artifactId: string, ydoc: Y.Doc): RoomProvider {
  // disableBc: other tabs sync through the server, so "Saved" means saved.
  return new WebsocketProvider(roomServerUrl(), roomName(artifactId), ydoc, {
    disableBc: true,
  }) as unknown as RoomProvider;
}

/**
 * One doc room: a Y.Doc and its provider, with batched sends, a saved/saving
 * state and the server's error frames. Framework free so a test can drive it
 * with a fake provider; useDocRoom wraps it for React.
 */
export function createDocRoom(
  makeProvider: (ydoc: Y.Doc) => RoomProvider,
  opts: {
    /** A room that replaces one that hit doc_too_large: starts with that error. */
    error?: string | null;
    /**
     * Called once, when the server rejects an edit as too large. The server
     * dropped it and y-protocols will not resend it, but it is still in this
     * Y.Doc: the owner replaces the room with a fresh one.
     */
    onResync?: () => void;
  } = {},
): DocRoom {
  const ydoc = new Y.Doc();
  const provider = makeProvider(ydoc);
  const listeners = new Set<() => void>();
  let snapshot: DocSnapshot = {
    status: "connecting",
    error: opts.error ?? null,
  };

  let connected = !!provider.wsconnected;
  let sawDisconnect = false;
  let synced = !!provider.synced;
  // Local updates written but not yet sent, and sent but not yet drained.
  let buffer: Uint8Array | null = null;
  let draining = false;
  let unsent = false;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let error: string | null = opts.error ?? null;
  // A replacement room never asks for another replacement.
  let resynced = !!opts.error;
  let destroyed = false;

  const compute = (): DocStatus => {
    if (!connected) return sawDisconnect ? "offline" : "connecting";
    return synced && !buffer && !draining && !unsent ? "saved" : "saving";
  };
  const publish = () => {
    const next: DocSnapshot = { status: compute(), error };
    if (next.status === snapshot.status && next.error === snapshot.error)
      return;
    snapshot = next;
    for (const l of [...listeners]) l();
  };

  // Doc updates: merge for UPDATE_BATCH_MS, then hand to y-websocket's sender.
  const sendUpdate = provider._updateHandler;
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === provider) return; // came from the server
    buffer = buffer ? Y.mergeUpdates([buffer, update]) : update;
    batchTimer ??= setTimeout(flushUpdates, UPDATE_BATCH_MS);
    publish();
  };
  const pollDrain = () => {
    drainTimer = undefined;
    if (!connected) {
      // Written while offline: reconnecting and syncing sends it.
      draining = false;
      unsent = true;
    } else if ((provider.ws?.bufferedAmount ?? 0) > 0) {
      drainTimer = setTimeout(pollDrain, DRAIN_POLL_MS);
      return;
    } else {
      draining = false;
    }
    publish();
  };
  function flushUpdates() {
    batchTimer = undefined;
    const update = buffer;
    buffer = null;
    if (update) {
      sendUpdate?.(update, null);
      if (connected && synced) {
        draining = true;
        clearTimeout(drainTimer);
        drainTimer = setTimeout(pollDrain, DRAIN_POLL_MS);
      } else {
        // Offline or not yet synced: the next sync sends it.
        unsent = true;
      }
    }
    publish();
  }
  // Ours replaces the handler y-websocket registered on the doc.
  if (sendUpdate) ydoc.off("update", sendUpdate as never);
  ydoc.on("update", onUpdate);

  // Cursor updates: one send per AWARENESS_MS carrying every changed client.
  const sendAwareness = provider._awarenessUpdateHandler;
  let awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAwareness = 0;
  const changed = new Set<number>();
  const flushAwareness = () => {
    awarenessTimer = undefined;
    if (changed.size === 0) return;
    const updated = [...changed];
    changed.clear();
    lastAwareness = Date.now();
    sendAwareness?.({ added: [], updated, removed: [] }, null);
  };
  const onAwareness = (
    c: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    // Only our own state goes out; remote states arrived from the server.
    if (origin === provider) return;
    for (const id of [...c.added, ...c.updated, ...c.removed]) {
      if (id === ydoc.clientID) changed.add(id);
    }
    if (changed.size === 0 || awarenessTimer) return;
    const wait = lastAwareness + AWARENESS_MS - Date.now();
    // Leading edge: send now if the last send was long enough ago.
    if (wait <= 0) flushAwareness();
    else awarenessTimer = setTimeout(flushAwareness, wait);
  };
  if (sendAwareness) provider.awareness.off("update", sendAwareness as never);
  provider.awareness.on("update", onAwareness);

  // Server error frames are JSON text; y-websocket would parse them as binary.
  const wrapped = new WeakSet<object>();
  const watchSocket = () => {
    const ws = provider.ws;
    if (!ws || wrapped.has(ws)) return;
    wrapped.add(ws);
    const binary = ws.onmessage;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return binary?.(e);
      try {
        const frame = JSON.parse(e.data) as { type?: string; code?: unknown };
        if (frame.type === "error") {
          error = typeof frame.code === "string" ? frame.code : "error";
          publish();
          // The rejected edit is still in this Y.Doc: ask for a fresh room
          // (once). The editor is read-only meanwhile and after.
          if (error === DOC_TOO_LARGE_CODE && !resynced) {
            resynced = true;
            setTimeout(() => {
              if (!destroyed) opts.onResync?.();
            }, 0);
          }
        }
      } catch {
        // Not JSON: ignore.
      }
    };
  };

  const onStatus = ({ status }: { status: string }) => {
    if (status === "connected") connected = true;
    else if (status === "disconnected") {
      connected = false;
      sawDisconnect = true;
      synced = false;
    }
    watchSocket();
    publish();
  };
  const onSync = (state: boolean) => {
    synced = state;
    if (state && connected) {
      // The sync exchange sends everything written while away.
      unsent = false;
    }
    publish();
  };
  provider.on("status", onStatus);
  provider.on("sync", onSync);
  watchSocket();

  return {
    ydoc,
    provider,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => snapshot,
    destroy(discard = false) {
      destroyed = true;
      clearTimeout(batchTimer);
      clearTimeout(drainTimer);
      // Send what is still waiting, then leave (unless it is being thrown away).
      if (buffer && !discard) sendUpdate?.(buffer, null);
      buffer = null;
      provider.awareness.off("update", onAwareness);
      provider.awareness.setLocalState(null);
      clearTimeout(awarenessTimer);
      sendAwareness?.(
        { added: [], updated: [], removed: [ydoc.clientID] },
        null,
      );
      ydoc.off("update", onUpdate);
      provider.off("status", onStatus);
      provider.off("sync", onSync);
      listeners.clear();
      provider.destroy();
      ydoc.destroy();
    },
  };
}

const IDLE: DocSnapshot = { status: "connecting", error: null };
const none = () => () => {};

/** The room for an artifact: created on mount, destroyed on unmount. */
export function useDocRoom(
  artifactId: string,
  makeProvider: (
    artifactId: string,
    ydoc: Y.Doc,
  ) => RoomProvider = defaultProvider,
): { room: DocRoom | null } & DocSnapshot {
  const [room, setRoom] = useState<DocRoom | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: makeProvider is a stable seam.
  useEffect(() => {
    let current: DocRoom;
    const open = (error?: string | null) => {
      current = createDocRoom((ydoc) => makeProvider(artifactId, ydoc), {
        error,
        onResync: () => {
          // doc_too_large: the rejected edit is in the local Y.Doc. Rebuild
          // the room (Y.Doc and provider; the editor rebinds to it) so local
          // state is what the server holds. It stays read-only.
          const old = current;
          open(DOC_TOO_LARGE_CODE);
          old.destroy(true);
        },
      });
      setRoom(current);
    };
    open();
    return () => {
      current.destroy();
      setRoom(null);
    };
  }, [artifactId]);
  const snap = useSyncExternalStore(
    room ? room.subscribe : none,
    room ? room.getSnapshot : () => IDLE,
  );
  return { room, ...snap };
}
