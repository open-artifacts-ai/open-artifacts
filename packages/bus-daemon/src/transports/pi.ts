import type { DaemonFrame } from "@oa/bus-ipc";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";

export type PiTransportOptions = {
  /** Writes a frame on the session's live adapter connection; false when it has none. */
  push: (agentRef: string, frame: DaemonFrame) => boolean;
  /** How long the extension has to call pi.sendMessage and ack. Default 10 s. */
  ackTimeoutMs?: number;
  /** Most timed-out ids kept per session for a late ack; the oldest go first. Default 1000. */
  lateAckCap?: number;
};

type Waiter = { ref: string; done: (o: DeliverOutcome) => void };

/**
 * Pi receives on its extension's live connection: the daemon pushes the
 * message, the extension hands it to pi.sendMessage and acks. Only that ack,
 * from the session the message was pushed to, makes it delivered.
 */
export class PiTransport {
  #waiting = new Map<string, Waiter>();
  /** Timed-out pushes: msg_id -> the session whose late ack still counts, until its link closes. */
  #late = new Map<string, string>();
  /** The same ids per session, oldest first, for the cap and for dropRef. */
  #lateByRef = new Map<string, Set<string>>();

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
    if (this.#late.get(msgId) !== ref) return false;
    this.#forget(msgId);
    return true;
  }

  /** The session's last connection closed: nothing it was pushed can be acked now. */
  dropRef(ref: string): void {
    for (const msgId of this.#lateByRef.get(ref) ?? [])
      this.#late.delete(msgId);
    this.#lateByRef.delete(ref);
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
    this.#late.set(msgId, ref);
    const ids = this.#lateByRef.get(ref) ?? new Set<string>();
    this.#lateByRef.set(ref, ids);
    ids.add(msgId);
    const cap = this.opts.lateAckCap ?? 1000;
    while (ids.size > cap) {
      const oldest = ids.values().next().value as string;
      ids.delete(oldest);
      this.#late.delete(oldest);
    }
  }

  #forget(msgId: string): void {
    const ref = this.#late.get(msgId);
    if (ref === undefined) return;
    this.#late.delete(msgId);
    const ids = this.#lateByRef.get(ref);
    ids?.delete(msgId);
    if (ids?.size === 0) this.#lateByRef.delete(ref);
  }
}
