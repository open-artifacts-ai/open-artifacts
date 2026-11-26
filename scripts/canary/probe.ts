// The canary's own bus agent: a second machine on the same member's bus,
// talking the hub's wire protocol directly (packages/bus-protocol). It sends
// the client its messages and records every reply, in arrival order. It never
// goes through the daemon under test.
import { PATHS } from "./hub.ts";
import { until } from "./lib.ts";

type Frame = { type: string; [k: string]: unknown };
export type Mail = { from: string; body: string; at: number };

/** A probe kind no wave-1 client uses, so the client is never mistaken for it. */
export const PROBE_KIND = "hermes";

export class Probe {
  readonly mail: Mail[] = [];
  readonly frames: Frame[] = [];
  name = "";
  #ws: WebSocket;
  #n = 0;

  /** Why the hub closed the socket, once it has. */
  closed: string | undefined;
  #ping: ReturnType<typeof setInterval>;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    // A keepalive, as the daemon sends one (packages/bus-daemon hub.ts).
    this.#ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 20_000);
    ws.addEventListener("close", (ev) => {
      this.closed = `the hub closed the probe socket (${ev.code} ${ev.reason})`;
      clearInterval(this.#ping);
    });
    ws.addEventListener("message", (ev) => {
      const text = String(ev.data);
      if (!text.startsWith("{")) return;
      const f = JSON.parse(text) as Frame;
      this.frames.push(f);
      if (f.type === "deliver" && typeof f.body === "string") {
        this.mail.push({
          from: String(f.from_name),
          body: f.body,
          at: Date.now(),
        });
        this.#send({ type: "ack", msg_id: f.msg_id });
      }
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
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () =>
        reject(new Error("probe: socket error")),
      );
    });
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
    this.#ws.send(JSON.stringify({ v: 1, id: `p${++this.#n}`, ...f }));
  }

  /** The first frame of `type` not yet taken. */
  async next(type: string, ms = 30_000): Promise<Frame> {
    return until(
      `probe: a ${type} frame`,
      () => {
        const i = this.frames.findIndex((f) => f.type === type);
        if (i < 0) return undefined;
        const [f] = this.frames.splice(i, 1);
        return f;
      },
      { ms, everyMs: 50 },
    );
  }

  /** Sends `body` to the agent named `to`; resolves on the hub's receipt. */
  async send(to: string, body: string): Promise<Frame> {
    this.#send({ type: "send", from_ref: "probe", to_name: to, body });
    const r = await this.next("receipt");
    if (r.state === "refused")
      throw new Error(`probe: the hub refused the send (${String(r.reason)})`);
    return r;
  }

  /** The first reply whose body contains `text`, waiting up to `ms`. */
  reply(text: string, ms: number): Promise<Mail> {
    return until(
      `a reply containing "${text}"`,
      () => {
        const m = this.mail.find((x) => x.body.includes(text));
        if (!m && this.closed) throw new Error(this.closed);
        return m;
      },
      { ms, everyMs: 200 },
    );
  }

  close() {
    clearInterval(this.#ping);
    this.#ws.close();
  }
}
