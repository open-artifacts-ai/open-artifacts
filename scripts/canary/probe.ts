// The canary's own bus agent: a second machine on the same member's bus,
// talking the hub's wire protocol directly (packages/bus-protocol). It sends
// the client its messages and records every reply, in arrival order. It never
// goes through the daemon under test.
import { randomBytes } from "node:crypto";
import { PATHS } from "./hub.ts";
import { type Unsubscribe, waitFor } from "./lib.ts";

type Frame = { type: string; [k: string]: unknown };
/** One message to the probe: the sender's bus name and hub agent id, and its body. */
export type Mail = { from: string; fromId?: string; body: string; at: number };

/** Whose reply counts: this run's client session, by its hub agent id and name. */
export type Peer = { name: string; id: string };

/** A probe kind no wave-1 client uses, so the client is never mistaken for it. */
export const PROBE_KIND = "hermes";

export class Probe {
  readonly mail: Mail[] = [];
  readonly frames: Frame[] = [];
  name = "";
  #ws: WebSocket;
  #n = 0;
  /**
   * The hub refuses a frame id a machine already used, across connections.
   * Each probe takes its own prefix, so a reused machine never collides.
   */
  #idPrefix = `p${randomBytes(6).toString("hex")}-`;

  /** Why the hub closed the socket, once it has. */
  closed: string | undefined;
  #ping: ReturnType<typeof setInterval>;
  #wakes = new Set<() => void>();

  /** A `waitFor` source: wakes on every frame from the hub, and on close. */
  readonly onFrame = (wake: () => void): Unsubscribe => {
    this.#wakes.add(wake);
    return () => this.#wakes.delete(wake);
  };
  #wakeAll() {
    for (const w of [...this.#wakes]) w();
  }

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    // A keepalive, as the daemon sends one (packages/bus-daemon hub.ts).
    this.#ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 20_000);
    ws.addEventListener("close", (ev) => {
      this.closed = `the hub closed the probe socket (${ev.code} ${ev.reason})`;
      clearInterval(this.#ping);
      this.#wakeAll();
    });
    ws.addEventListener("message", (ev) => {
      const text = String(ev.data);
      if (!text.startsWith("{")) return;
      let f: Frame;
      try {
        f = JSON.parse(text) as Frame;
      } catch {
        return;
      }
      this.frames.push(f);
      if (f.type === "deliver" && typeof f.body === "string") {
        this.mail.push({
          from: String(f.from_name),
          ...(typeof f.from_id === "string" ? { fromId: f.from_id } : {}),
          body: f.body,
          at: Date.now(),
        });
        this.#send({ type: "ack", msg_id: f.msg_id });
      }
      this.#wakeAll();
    });
  }

  /** Connects with `machineToken`, says hello, and registers as a global agent. */
  static async open(
    origin: string,
    machineToken: string,
    name: string,
  ): Promise<Probe> {
    const url = `${origin.replace(/^http/, "ws")}${PATHS.connect}`;
    // Node's WebSocket (undici) takes headers; the DOM type does not say so.
    const ws = new (
      WebSocket as unknown as new (
        u: string,
        init: { headers: Record<string, string> },
      ) => WebSocket
    )(url, { headers: { authorization: `Bearer ${machineToken}` } });
    await waitFor<true>(
      "probe: the socket to open",
      () => {
        if (ws.readyState === WebSocket.OPEN) return true;
        if (ws.readyState >= WebSocket.CLOSING)
          throw new Error("probe: socket error");
        return undefined;
      },
      {
        ms: 30_000,
        on: [
          (wake) => {
            ws.addEventListener("open", wake);
            ws.addEventListener("error", wake);
            ws.addEventListener("close", wake);
            return () => {
              ws.removeEventListener("open", wake);
              ws.removeEventListener("error", wake);
              ws.removeEventListener("close", wake);
            };
          },
        ],
      },
    );
    const p = new Probe(ws);
    p.#send({
      type: "hello",
      machine_label: "canary-probe",
      client_version: "0.0.0",
      caps: ["ids", "rename"],
    });
    await p.next("hello_ok");
    p.#send({
      type: "agent_up",
      agent_ref: "probe",
      kind: PROBE_KIND,
      proposed_name: name,
      namespace: "canary",
      global: true,
    });
    const ok = await p.next("agent_ok");
    p.name = String(ok.bus_name);
    return p;
  }

  #send(f: Record<string, unknown>) {
    this.#ws.send(
      JSON.stringify({ v: 1, id: `${this.#idPrefix}${++this.#n}`, ...f }),
    );
  }

  /** The first frame of `type` not yet taken; waits on the socket, never a timer. */
  async next(type: string, ms = 30_000): Promise<Frame> {
    return waitFor(
      `probe: a ${type} frame`,
      () => {
        const i = this.frames.findIndex((f) => f.type === type);
        if (i >= 0) return this.frames.splice(i, 1)[0];
        if (this.closed) throw new Error(this.closed);
        return undefined;
      },
      { ms, on: [this.onFrame] },
    );
  }

  /**
   * Sends `body` to `to`; resolves on the hub's receipt. With `to.id` the hub
   * delivers only while that name is still that agent (`to_id`), so a message
   * never reaches another session that took the name.
   */
  async send(to: string | Peer, body: string): Promise<Frame> {
    const name = typeof to === "string" ? to : to.name;
    this.#send({
      type: "send",
      from_ref: "probe",
      to_name: name,
      ...(typeof to === "string" ? {} : { to_id: to.id }),
      body,
    });
    const r = await this.next("receipt").catch((e: Error) => {
      // Say what the hub sent instead (an error frame names its code).
      const other = this.frames
        .filter((f) => f.type !== "deliver" && f.type !== "receipt_update")
        .slice(-3)
        .map((f) =>
          JSON.stringify({
            type: f.type,
            code: f.code,
            reason: f.reason,
            message: f.message,
          }),
        );
      throw new Error(
        `${e.message}${other.length ? `; the hub sent ${other.join(", ")}` : ""}${this.closed ? `; ${this.closed}` : ""}`,
      );
    });
    if (r.state === "refused")
      throw new Error(`probe: the hub refused the send (${String(r.reason)})`);
    return r;
  }

  /** Whether `m` came from `from`: by hub agent id when the hub sent one, and by name. */
  static isFrom(m: Mail, from: Peer | undefined): boolean {
    if (!from) return true;
    return m.from === from.name && m.fromId === from.id;
  }

  /**
   * The first message from `from` whose body is exactly `text` (trimmed),
   * waiting up to `ms` on the socket. A message from any other session, or
   * one that only contains the text, never counts.
   */
  reply(text: string, ms: number, from?: Peer): Promise<Mail> {
    return waitFor(
      `a reply "${text}"${from ? ` from ${from.name}` : ""}`,
      () => {
        const m = this.mail.find(
          (x) => x.body.trim() === text && Probe.isFrom(x, from),
        );
        if (!m && this.closed) throw new Error(this.closed);
        return m;
      },
      { ms, on: [this.onFrame] },
    );
  }

  /** Where in the mail the first exact `text` from `from` is, or -1. */
  indexOf(text: string, from?: Peer): number {
    return this.mail.findIndex(
      (x) => x.body.trim() === text && Probe.isFrom(x, from),
    );
  }

  close() {
    clearInterval(this.#ping);
    this.#ws.close();
  }
}
