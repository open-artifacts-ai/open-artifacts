import { retryAfterFromClose } from "@oa/shared";
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

/**
 * The doc is at its limit: 2 MB on every plan, so no plan or upgrade wording.
 * Product's longer text adds "Remove something, such as an image, to keep
 * editing, or start a new doc." Left out: the editor is read-only here, and
 * nothing in this repo shows the room accepts an edit that only shrinks the
 * doc once it is over the limit (doc-ops refuses every edit then). Add it back
 * when the room is known to take deletes, and make deletes possible.
 */
export const DOC_TOO_LARGE = "This doc is full (2 MB).";
/** The server's code for a rejected write that would grow the doc past its limit. */
export const DOC_TOO_LARGE_CODE = "doc_too_large";
const GENERIC_ERROR = "This doc can't save changes right now.";

/** The error copy for a server error code, or null for none. */
export function errorCopy(code: string | null): string | null {
  if (!code) return null;
  return code === DOC_TOO_LARGE_CODE ? DOC_TOO_LARGE : GENERIC_ERROR;
}

/**
 * Copy for the wire spec's states (artifact UkN5r8hpoXu9DYxG). Product writes
 * the final words; PLACEHOLDER marks the ones the spec does not give.
 */
/** Spec: close 4403 access_removed. */
export const ACCESS_REMOVED = "You no longer have access.";
/** Spec: hello reason room_full. */
export const ROOM_FULL = "You can read; editing opens when someone leaves.";
/** PLACEHOLDER: the button beside ROOM_FULL (the spec says "offer to reconnect"). */
export const ROOM_FULL_RETRY = "Try again";
/** Product's copy: close 4404 not_found. */
export const NOT_FOUND =
  "This doc was deleted. Its owner can restore it from Trash.";
/** Product's copy: close 1007 bad_frame, the second time. */
export const BAD_FRAME =
  "This doc can't sync right now. Reload the page to try again. Copy any unsaved changes first.";
/** The share of the cap that counts as near (hello bytes). */
export const NEAR_CAP_SHARE = 0.9;
/** Product's copy: hello bytes near the cap, in MB to one decimal. */
export const nearCap = (bytes: number) =>
  `This doc is almost full (${(bytes / 1048576).toFixed(1)} of 2 MB). Images take the most space.`;

/** A version was saved or restored (wire spec: broadcast, so no polling). */
export type VersionEvent =
  | { kind: "saved"; version: number; name?: string; auto: boolean }
  | { kind: "restored"; from: number; version: number };

/**
 * The title-bar words for a version event. Spec: "Saved as v5". PLACEHOLDER:
 * the named form. Product's restore note, "Restored v3. Saved as v7.", pushes
 * Share onto a third row at 390 (e2e/doc-wire.spec.ts checks it does not), so
 * the short form stays. Auto-saves get no note (Design, showsNote).
 */
export function versionNote(e: VersionEvent): string {
  if (e.kind === "restored") return `Restored v${e.from} as v${e.version}`;
  return e.name
    ? `Saved as v${e.version} (${e.name})`
    : `Saved as v${e.version}`;
}

/** Design: an auto-save is quiet; named saves and restores say so. */
export const showsNote = (e: VersionEvent): boolean =>
  !(e.kind === "saved" && e.auto);

/**
 * 1013 try_again: the room is busy. y-websocket resets its backoff once a
 * connection has synced, so a client that syncs and is then told to wait would
 * retry about every 200 ms. The room backs off itself: 1 s, 2 s, 4 s ... up to
 * 30 s, each with up to 25% knocked off (so the steps still grow), reset once
 * a connection has stayed up 10 s.
 */
export const BUSY_BASE_MS = 1000;
export const BUSY_MAX_MS = 30_000;
export const BUSY_STABLE_MS = 10_000;
/**
 * The jitter's source. Mock mode only: an e2e sets window.__oaJitter (0 to 1)
 * so its timing does not depend on chance. Real builds always use Math.random.
 */
const jitterSource = (): number => {
  if (import.meta.env.VITE_MOCK === "1") {
    const j = (window as unknown as { __oaJitter?: number }).__oaJitter;
    if (typeof j === "number") return j;
  }
  return Math.random();
};
export const busyDelay = (
  attempt: number,
  random: () => number = Math.random,
): number =>
  Math.min(BUSY_MAX_MS, BUSY_BASE_MS * 2 ** attempt) * (0.75 + 0.25 * random());

/** Why the socket stopped for good (the client does not retry). */
export type RoomEnd = "access_removed" | "not_found" | "bad_frame";

export interface DocSnapshot {
  status: DocStatus;
  /** The server's last error code ({type:"error", code}), if any. */
  error: string | null;
  /** The role the server gave in its hello frame; null before it. Server only. */
  role: "edit" | "read" | null;
  /** Why role is "read" when it is not the viewer's permission. */
  reason: "room_full" | "access" | null;
  /** Stored doc size and the cap, from hello. */
  bytes: number | null;
  cap: number | null;
  /** The socket was closed for good; see RoomEnd. */
  ended: RoomEnd | null;
}

/** What to say about the room (not the doc-full alert), or null. */
export function roomNotice(
  s: DocSnapshot,
): { text: string; retry?: string } | null {
  if (s.ended === "access_removed") return { text: ACCESS_REMOVED };
  if (s.ended === "not_found") return { text: NOT_FOUND };
  if (s.ended === "bad_frame") return { text: BAD_FRAME };
  if (s.role === "read" && s.reason === "room_full")
    return { text: ROOM_FULL, retry: ROOM_FULL_RETRY };
  if (s.bytes && s.cap && s.bytes >= s.cap * NEAR_CAP_SHARE && s.bytes < s.cap)
    return { text: nearCap(s.bytes) };
  return null;
}

/** The part of y-websocket's WebsocketProvider the room uses. */
export interface RoomProvider {
  awareness: WebsocketProvider["awareness"];
  wsconnected: boolean;
  synced: boolean;
  ws: {
    onmessage: ((e: { data: unknown }) => void) | null;
    bufferedAmount?: number;
    addEventListener?: (
      type: "close",
      cb: (e: { code: number; reason?: string }) => void,
    ) => void;
  } | null;
  /** y-websocket's socket control: disconnect() also stops its reconnecting. */
  disconnect?(): void;
  connect?(): void;
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
  /**
   * Version events from the room. A restore by someone else arrives as an
   * ordinary doc update (the room applies it as one edit), so the text needs
   * no reload; the events are for the version list and the title bar.
   */
  onVersion(cb: (e: VersionEvent) => void): () => void;
  /** Close and reopen the socket (the "Try again" beside a full room). */
  reconnect(): void;
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
    // e2e: each worker's room port arrives as window.__OA_DOC_WS.
    return (
      (window as unknown as { __OA_DOC_WS?: string }).__OA_DOC_WS ||
      import.meta.env.VITE_DOC_WS ||
      "ws://localhost:1235"
    );
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/v1/artifacts`;
}

export const roomName = (artifactId: string) => `${artifactId}/doc`;

/**
 * Which server closes y-websocket reconnects after. Its default treats every
 * 4400-4499 close as final, but the wire spec's 4401 auth_expired means "the
 * cookie re-authorizes: reconnect silently". Only 4403 (access removed) and
 * 4404 (doc deleted) are final; 1007 and 1013 reconnect (1007 once, see the
 * room), with the provider's backoff. A 4403 whose reason is
 * accessChangedCloseReason (the room, #2154: authorized just before an access
 * change) is not final: the room reconnects after the wait it names.
 */
export const roomShouldReconnect = (e: {
  code: number;
  reason?: string;
}): boolean =>
  (e.code !== 4403 || retryAfterFromClose(e.reason) !== null) &&
  e.code !== 4404;

export function defaultProvider(artifactId: string, ydoc: Y.Doc): RoomProvider {
  // disableBc: other tabs sync through the server, so "Saved" means saved.
  return new WebsocketProvider(roomServerUrl(), roomName(artifactId), ydoc, {
    disableBc: true,
    shouldReconnect: roomShouldReconnect,
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
    role: null,
    reason: null,
    bytes: null,
    cap: null,
    ended: null,
  };
  let role: DocSnapshot["role"] = null;
  let reason: DocSnapshot["reason"] = null;
  let bytes: number | null = null;
  let cap: number | null = null;
  let ended: RoomEnd | null = null;
  let badFrames = 0;
  // 1013: how many busy closes in a row, the pending reconnect, and the timer
  // that forgives them once a connection has stayed up.
  let busyCloses = 0;
  let busyTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  const versionListeners = new Set<(e: VersionEvent) => void>();

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
    const next: DocSnapshot = {
      status: compute(),
      error,
      role,
      reason,
      bytes,
      cap,
      ended,
    };
    if (
      (Object.keys(next) as (keyof DocSnapshot)[]).every(
        (k) => next[k] === snapshot[k],
      )
    )
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
    // Close codes from the room (wire spec): 4401 auth_expired is the cookie
    // re-authorizing, so y-websocket's own reconnect is right; 4403 and 4404
    // end it; 1007 gets one resync; 1013 waits its own growing delay.
    ws.addEventListener?.("close", (ev) => {
      if (destroyed) return;
      const stop = (why: RoomEnd) => {
        ended = why;
        provider.disconnect?.();
        publish();
      };
      const retry = ev.code === 4403 ? retryAfterFromClose(ev.reason) : null;
      if (retry !== null) {
        // Opened just as access changed (#2154): re-authorize after the wait.
        provider.disconnect?.();
        clearTimeout(busyTimer);
        busyTimer = setTimeout(() => {
          if (!destroyed) provider.connect?.();
        }, retry);
      } else if (ev.code === 4403) stop("access_removed");
      else if (ev.code === 4404) stop("not_found");
      else if (ev.code === 1013) {
        // Take over from y-websocket's backoff (disconnect() stops its retry).
        provider.disconnect?.();
        clearTimeout(busyTimer);
        busyTimer = setTimeout(
          () => {
            if (!destroyed) provider.connect?.();
          },
          busyDelay(busyCloses++, jitterSource),
        );
      } else if (ev.code === 1007) {
        if (++badFrames > 1) stop("bad_frame");
        else
          setTimeout(() => {
            if (destroyed) return;
            provider.disconnect?.();
            provider.connect?.();
          }, 0);
      }
    });
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return binary?.(e);
      try {
        const frame = JSON.parse(e.data) as {
          type?: string;
          code?: unknown;
          role?: unknown;
          reason?: unknown;
          bytes?: unknown;
          cap?: unknown;
          version?: unknown;
          from?: unknown;
        };
        if (frame.type === "hello") {
          // The first frame: the role comes from the server only.
          role = frame.role === "edit" ? "edit" : "read";
          reason =
            frame.reason === "room_full" || frame.reason === "access"
              ? frame.reason
              : null;
          bytes = typeof frame.bytes === "number" ? frame.bytes : null;
          cap = typeof frame.cap === "number" ? frame.cap : null;
          publish();
        }
        if (frame.type === "saved" && typeof frame.version === "number") {
          const f = frame as {
            version: number;
            name?: unknown;
            auto?: unknown;
          };
          for (const l of [...versionListeners])
            l({
              kind: "saved",
              version: f.version,
              ...(typeof f.name === "string" && f.name ? { name: f.name } : {}),
              auto: f.auto === true,
            });
        }
        if (
          frame.type === "restored" &&
          typeof frame.version === "number" &&
          typeof frame.from === "number"
        )
          for (const l of [...versionListeners])
            l({ kind: "restored", from: frame.from, version: frame.version });
        // rate_limited and bad_update (#2154) come just before a 1013 or 1007
        // close, which the close handler answers; they say nothing themselves.
        if (
          frame.type === "error" &&
          frame.code !== "rate_limited" &&
          frame.code !== "bad_update"
        ) {
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
    if (status === "connected") {
      connected = true;
      // Up for BUSY_STABLE_MS: the room is not busy any more.
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        busyCloses = 0;
      }, BUSY_STABLE_MS);
    } else if (status === "disconnected") {
      clearTimeout(stableTimer);
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
    onVersion(cb) {
      versionListeners.add(cb);
      return () => versionListeners.delete(cb);
    },
    reconnect() {
      if (destroyed) return;
      ended = null;
      badFrames = 0;
      provider.disconnect?.();
      provider.connect?.();
    },
    destroy(discard = false) {
      destroyed = true;
      clearTimeout(batchTimer);
      clearTimeout(drainTimer);
      clearTimeout(busyTimer);
      clearTimeout(stableTimer);
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
      versionListeners.clear();
      provider.destroy();
      ydoc.destroy();
    },
  };
}

const IDLE: DocSnapshot = {
  status: "connecting",
  error: null,
  role: null,
  reason: null,
  bytes: null,
  cap: null,
  ended: null,
};
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
