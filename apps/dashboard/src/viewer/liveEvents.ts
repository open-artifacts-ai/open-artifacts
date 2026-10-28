import {
  type ArtifactEvent,
  ArtifactEventSchema,
  EVENTS_GONE_CLOSE,
  R,
} from "@oa/shared";

/** The server closes near its signed-URL TTL with this: reconnect at once. */
export const EVENTS_TTL_CLOSE = 4408;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export type GoneReason = Extract<ArtifactEvent, { type: "gone" }>["reason"];

export interface ArtifactEventsOptions {
  id: string;
  /**
   * Embed mode: always `?embed=1`, so the server treats the socket as
   * anonymous (browsers send cookies on WebSockets).
   */
  embed: boolean;
  onEvent: (e: Exclude<ArtifactEvent, { type: "gone" }>) => void;
  /**
   * A `gone` frame (or a bare 4403 close, read as "changed"). No reconnect
   * until `resume`.
   */
  onGone: (reason: GoneReason) => void;
  /**
   * The socket couldn't connect (a 429, a refusal) or dropped: refetch on
   * focus. A first connect that never got a hello isn't retried until
   * `retry`, so no storm; once one hello came, reconnects back off instead.
   */
  onDown: () => void;
}

export const eventsUrl = (id: string, embed: boolean) => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${R.events(id)}${embed ? "?embed=1" : ""}`;
};

/**
 * The page may be reachable again: window focus, the tab turning visible, or
 * the network coming back. Calls `cb` on each; returns the unsubscribe.
 */
export function onWake(cb: () => void) {
  const onVisible = () => {
    if (document.visibilityState === "visible") cb();
  };
  window.addEventListener("focus", cb);
  window.addEventListener("online", cb);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("focus", cb);
    window.removeEventListener("online", cb);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * One R.events socket per viewer. Server to client only: this never sends a
 * frame (the server closes with 1008 if it gets one). Reconnects on 4408 at
 * once, and with capped backoff once any connect has said hello (a failed
 * reconnect keeps backing off); each connect's hello carries the current
 * version, so missed ones catch up.
 */
export function connectArtifactEvents(opts: ArtifactEventsOptions) {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let paused = false;
  /** A connect failed: wait for `retry` (a window focus) instead. */
  let idle = false;
  /** Some connect in this life got a hello: the server takes us, so keep trying. */
  let everHello = false;
  /** A gone's retryAfterMs (#816): no reconnect before this time. */
  let notBefore = 0;

  const open = () => {
    if (stopped || paused) return;
    idle = false;
    let hello = false;
    const sock = new WebSocket(eventsUrl(opts.id, opts.embed));
    ws = sock;
    sock.onmessage = (e) => {
      if (ws !== sock || typeof e.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(e.data);
      } catch {
        return;
      }
      const f = ArtifactEventSchema.safeParse(raw);
      if (!f.success) return;
      if (f.data.type === "gone") {
        gone(sock, f.data.reason, f.data.retryAfterMs);
        return;
      }
      if (f.data.type === "hello") {
        hello = true;
        everHello = true;
        attempt = 0;
      }
      opts.onEvent(f.data);
    };
    sock.onclose = (e) => {
      if (ws !== sock || stopped) return;
      ws = null;
      if (e?.code === EVENTS_GONE_CLOSE) {
        gone(sock, "changed");
        return;
      }
      if (e?.code === EVENTS_TTL_CLOSE) {
        attempt = 0;
        open();
        return;
      }
      opts.onDown();
      if (!hello && !everHello) {
        idle = true;
        return;
      }
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
  };

  const gone = (sock: WebSocket, reason: GoneReason, retryAfterMs?: number) => {
    if (paused) return;
    paused = true;
    notBefore = Date.now() + (retryAfterMs ?? 0);
    if (ws === sock) ws = null;
    sock.close();
    opts.onGone(reason);
  };

  // Next task: a mount that unmounts at once (StrictMode) never connects.
  timer = setTimeout(open, 0);
  return {
    /** Access is still there after a gone: connect again. */
    resume() {
      if (stopped || !paused) return;
      paused = false;
      attempt = 0;
      // The server asked for a pause (a socket opened just as access
      // changed): wait it out instead of looping on gone.
      const wait = notBefore - Date.now();
      clearTimeout(timer);
      if (wait > 0) timer = setTimeout(open, wait);
      else open();
    },
    /** After a failed first connect: one more try (focus, visible, online). */
    retry() {
      if (stopped || paused || !idle) return;
      open();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}
