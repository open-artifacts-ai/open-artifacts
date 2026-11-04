import type { DaemonFrame } from "@oa/bus-ipc";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";

export type PiTransportOptions = {
  /** Writes a frame on the session's live adapter connection; false when it has none. */
  push: (agentRef: string, frame: DaemonFrame) => boolean;
  /** How long the extension has to call pi.sendMessage and ack. Default 10 s. */
  ackTimeoutMs?: number;
  /** How long after a timeout that session's ack still confirms the message. Default 60 s. */
  lateAckMs?: number;
};

type Waiter = { ref: string; done: (o: DeliverOutcome) => void };

/**
 * Pi receives on its extension's live connection: the daemon pushes the
 * message, the extension hands it to pi.sendMessage and acks. Only that ack,
 * from the session the message was pushed to, makes it delivered.
 */
export class PiTransport {
  #waiting = new Map<string, Waiter>();
  /** Timed-out pushes: msg_id -> the session whose late ack still counts. */
  #late = new Map<string, { ref: string; timer: NodeJS.Timeout }>();

  constructor(private readonly opts: PiTransportOptions) {}

  async deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    const pushed = this.opts.push(agent.ref, {
      v: 1,
      id: `deliver-${mail.msg_id}`,
      type: "deliver",
      msg_id: mail.msg_id,
      from_name: mail.from_name,
      namespace: mail.namespace,
      ...(mail.notice ? { notice: mail.notice } : { body: mail.body }),
    });
    if (!pushed) return { ok: false, reason: "closed" };
    this.#forget(mail.msg_id);
    return new Promise<DeliverOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(mail.msg_id);
        this.#remember(mail.msg_id, agent.ref);
        resolve({ ok: false, reason: "timeout" });
      }, this.opts.ackTimeoutMs ?? 10_000);
      timer.unref();
      this.#waiting.set(mail.msg_id, {
        ref: agent.ref,
        done: (o) => {
          clearTimeout(timer);
          resolve(o);
        },
      });
    });
  }

  /** The extension acked msgId; true only for a push to that same session still waiting. */
  acked(msgId: string, ref: string): boolean {
    const w = this.#waiting.get(msgId);
    if (w?.ref !== ref) return false;
    this.#waiting.delete(msgId);
    w.done({ ok: true });
    return true;
  }

  /** An ack that came after the timeout, from the session it was pushed to; true once. */
  lateAck(msgId: string, ref: string): boolean {
    if (this.#late.get(msgId)?.ref !== ref) return false;
    this.#forget(msgId);
    return true;
  }

  /** The session's last connection closed: nothing it was pushed can be acked now. */
  dropRef(ref: string): void {
    for (const [msgId, w] of this.#waiting) {
      if (w.ref !== ref) continue;
      this.#waiting.delete(msgId);
      w.done({ ok: false, reason: "closed" });
    }
  }

  /** An Open Artifacts bus notice about mail `msgId` (expired or refused); never a message from a peer. */
  async notify(
    agent: AgentRecord,
    text: string,
    msgId: string,
  ): Promise<boolean> {
    return this.opts.push(agent.ref, {
      v: 1,
      id: "0",
      type: "notice",
      text,
      msg_id: msgId,
    });
  }

  #remember(msgId: string, ref: string): void {
    this.#forget(msgId);
    const timer = setTimeout(
      () => this.#late.delete(msgId),
      this.opts.lateAckMs ?? 60_000,
    );
    timer.unref();
    this.#late.set(msgId, { ref, timer });
  }

  #forget(msgId: string): void {
    clearTimeout(this.#late.get(msgId)?.timer);
    this.#late.delete(msgId);
  }
}
