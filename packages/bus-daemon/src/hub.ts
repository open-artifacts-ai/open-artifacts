import {
  BUS_CAPS,
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  frameId,
  LIMITS,
  PING,
  PONG,
  type ServerFrame,
} from "@oa/bus-protocol";
import WebSocket from "ws";
import { FramePacer } from "./pacer.ts";

export type HubOptions = {
  url: string;
  token: string;
  label: string;
  version: string;
  /** Read on every open; sent as `sessions` right after `hello`. */
  sessions: () => { open: string[]; closed: string[] };
  onFrame: (frame: ServerFrame) => void;
  /** A frame the decoder rejected but whose id it recovered: it answers that request. */
  onBadFrame?: (id: string, error: "bad_frame" | "too_large") => void;
  onRevoked: () => void;
  onOpen: () => void;
  /** An open link dropped; requests in flight on it will not be answered. */
  onClose?: () => void;
  /** Debug log sink. Never receives the token. */
  log?: (msg: string) => void;
  /** Test seam: fixed delays. */
  backoffMs?: (attempt: number) => number;
  /** Keepalive interval; the link is dropped after two silent intervals. */
  pingMs?: number;
  handshakeTimeoutMs?: number;
  /** Open time after which a connection counts as stable and backoff resets. */
  stableMs?: number;
  /** Test seam: the frame encoder; default `encodeFrame`. */
  encode?: (frame: ClientFrame) => string;
  /** Pacing of outgoing frames; defaults in `FramePacer`. */
  pace?: { rate?: number; burst?: number; max?: number };
  /** A queued frame dropped for space: its request will not be answered. */
  onDropped?: (frame: ClientFrame) => void;
  /** Test override of the cooldown floor after a rate limit; default `LIMITS.rateLimitCooldownMs`. */
  rateLimitedMs?: number;
};

export class HubConnection {
  #ws?: WebSocket;
  #attempt = 0;
  #stopped = false;
  #warned = false;
  #timer?: NodeJS.Timeout;
  #limitedLogged = false;
  readonly #pacer: FramePacer;
  reconnecting = false;
  /** Why the last attempt failed: a Node error code, `timeout`, `HTTP 502` or `rate limited`. */
  lastError?: string;

  constructor(private readonly opts: HubOptions) {
    this.#pacer = new FramePacer({
      ...opts.pace,
      send: (data) => {
        if (this.#ws?.readyState !== WebSocket.OPEN) return false;
        this.#ws.send(data);
        return true;
      },
      onDropped: (f) => {
        const dropped = opts.onDropped;
        if (dropped) this.#guard("onDropped", () => dropped(f));
      },
      log: opts.log,
    });
  }

  start(): void {
    this.#stopped = false;
    if (this.#ws || this.#timer) return;
    this.#connect();
  }

  /**
   * Queues a frame, paced; false when the link is down or the frame cannot go.
   * `onUnsent` is called if a queued frame is never written (the link dropped).
   */
  send(frame: ClientFrame, onUnsent?: () => void): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    let data: string;
    try {
      data = (this.opts.encode ?? encodeFrame)(frame);
    } catch (e) {
      // Like a closed socket: never sent, never a crash. The error's message
      // may quote the frame, so only its name is logged.
      this.opts.log?.(
        `could not encode a ${frame.type} frame (${frame.id}): ${e instanceof Error ? e.name : "error"}`,
      );
      return false;
    }
    return this.#pacer.push(frame, data, onUnsent);
  }

  /** Drops a frame still queued: its request was given up on. */
  cancel(id: string): boolean {
    return this.#pacer.remove(id);
  }

  get open(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  stop(): void {
    this.#stopped = true;
    this.reconnecting = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pacer.clear();
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    else ws?.terminate();
  }

  #guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.opts.log?.(
        `${what} threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  #revoke(): void {
    this.#stopped = true;
    this.reconnecting = false;
    this.#guard("onRevoked", () => this.opts.onRevoked());
  }

  #connect(): void {
    this.#timer = undefined;
    if (this.#stopped) return;
    const pingMs = this.opts.pingMs ?? 25_000;
    const ws = new WebSocket(this.opts.url, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: this.opts.handshakeTimeoutMs ?? 15_000,
    });
    this.#ws = ws;
    let lastRx = Date.now();
    // The upgrade itself was answered 429: the cooldown, not a failure.
    let limitedUpgrade = false;
    let keepalive: NodeJS.Timeout | undefined;
    let stable: NodeJS.Timeout | undefined;
    const markStable = () => {
      this.#attempt = 0;
      clearTimeout(stable);
    };

    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      limitedUpgrade = res.statusCode === 429;
      this.lastError = limitedUpgrade
        ? "rate limited"
        : `HTTP ${res.statusCode}`;
      // A revoked token is refused at the upgrade, never with a 4403 close,
      // and always with 401 (CONTRACT §GET /hub). A 403 is a WAF or a proxy:
      // transient, with backoff.
      if (res.statusCode === 401) {
        this.#ws = undefined;
        this.#revoke();
      }
      ws.terminate();
    });
    ws.on("open", () => {
      this.reconnecting = false;
      this.lastError = undefined;
      lastRx = Date.now();
      this.send({
        v: 1,
        id: frameId(),
        type: "hello",
        machine_label: this.opts.label,
        client_version: this.opts.version,
        // Reply ids: the hub then names each sender's agent (deliver.from_id).
        // Mailboxes: the hub then sends queued/since, away rows and the new
        // refusals, and honours agent_up.replaces (#1295).
        caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
      });
      this.#guard("sessions", () => {
        this.send({
          v: 1,
          id: frameId(),
          type: "sessions",
          ...this.opts.sessions(),
        });
      });
      this.#guard("onOpen", () => this.opts.onOpen());
      stable = setTimeout(() => {
        markStable();
        // A link that held: a later rate-limited close is news again.
        this.#limitedLogged = false;
      }, this.opts.stableMs ?? 10_000);
      keepalive = setInterval(() => {
        if (Date.now() - lastRx > 2 * pingMs) {
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(PING);
      }, pingMs);
    });
    ws.on("message", (data) => {
      lastRx = Date.now();
      const text = String(data);
      if (text === PONG) return;
      const r = decodeServerFrame(text);
      if (!r.ok) {
        if (!this.#warned) {
          this.#warned = true;
          this.opts.log?.(`dropped ${r.error} frame from hub`);
        }
        const { id } = r;
        const bad = this.opts.onBadFrame;
        if (id !== undefined && bad)
          this.#guard("onBadFrame", () => bad(id, r.error));
        return;
      }
      markStable();
      this.#guard("onFrame", () => this.opts.onFrame(r.frame));
    });
    ws.on("close", (code, reason) => {
      clearInterval(keepalive);
      clearTimeout(stable);
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      // Queued frames were for this link; a reconnect replays what matters.
      this.#pacer.clear();
      if (this.opts.onClose) this.#guard("onClose", this.opts.onClose);
      if (code === 4403) {
        this.#revoke();
        return;
      }
      if (this.#stopped) return;
      this.reconnecting = true;
      let wait = (this.opts.backoffMs ?? defaultBackoff)(this.#attempt++);
      // Transient, but hammering a limit only extends it.
      if (
        limitedUpgrade ||
        code === LIMITS.rateLimitCloseCode ||
        (code === LIMITS.protocolCloseCode && String(reason) === "rate limited")
      ) {
        const cooldown = this.opts.rateLimitedMs ?? LIMITS.rateLimitCooldownMs;
        wait = Math.max(wait, cooldown + Math.random() * (cooldown / 2));
        this.lastError = "rate limited";
        if (!this.#limitedLogged) {
          this.#limitedLogged = true;
          const what = limitedUpgrade
            ? "the hub is rate limiting this machine"
            : "the hub closed the link as rate limited";
          this.opts.log?.(`${what}; retrying in ${Math.round(wait / 1000)} s`);
        }
      }
      this.#timer = setTimeout(() => this.#connect(), wait);
    });
    ws.on("error", (e: NodeJS.ErrnoException) => {
      // Close follows; status shows why.
      if (!limitedUpgrade && !this.lastError?.startsWith("HTTP "))
        this.lastError = /timeout/i.test(e.message)
          ? "timeout"
          : (e.code ?? "error");
    });
  }
}

function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() / 2));
}
