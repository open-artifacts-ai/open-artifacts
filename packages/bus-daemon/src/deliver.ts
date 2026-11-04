import { oversizedText, stripTerminalControls } from "@oa/bus-ipc";
import { type DeliverFrame, frameId, type RefuseFrame } from "@oa/bus-protocol";
import type { AgentRecord, AgentTable } from "./agents.ts";
import { Seen } from "./dedupe.ts";
import type { HubConnection } from "./hub.ts";

export type Mail = {
  msg_id: string;
  from_name: string;
  namespace: string;
  body: string;
  /**
   * Set when the body is over the inline cap: `body` is then the bus's own
   * fetch notice, not text the peer wrote.
   */
  notice?: { size: number; msg_id: string };
};
type Detail = RefuseFrame["detail"];
/**
 * `cause` means the harness turned it down; `closed` alone means the session
 * is gone. `queued`: the session cannot take it now (a Codex thread under
 * `codex exec`, or no `codex` binary), so the hub's receipt stays pending.
 */
export type DeliverOutcome =
  | { ok: true }
  | { ok: false; reason: "closed" | "timeout" | "queued"; cause?: Detail };
export type DeliverFn = (
  agent: AgentRecord,
  mail: Mail,
) => Promise<DeliverOutcome>;
/**
 * Puts a short local notice from Open Artifacts bus in front of a session (its mail
 * expired or was refused). A notice is never a message: nothing it causes
 * routes back to a peer. False when the session could not be reached.
 * `msgId` is the mail it is about: the same on every retry of the notice.
 */
export type NotifyFn = (
  agent: AgentRecord,
  text: string,
  msgId: string,
) => Promise<boolean>;

export function createDeliver(ctx: {
  agents: AgentTable;
  hub: Pick<HubConnection, "send">;
  transports: Partial<Record<AgentRecord["kind"], DeliverFn>>;
  /** The transport found the session closed; report it to the hub. */
  onClosed: (agent: AgentRecord) => void;
  log?: (msg: string) => void;
}) {
  // Seen means delivered: an id is added only after the harness confirms it.
  const seen = new Seen();
  const inflight = new Map<string, { ref: string; settled: Promise<void> }>();
  const ack = (msg_id: string) =>
    ctx.hub.send({ v: 1, id: frameId(), type: "ack", msg_id });
  const refuse = (msg_id: string, detail: Detail) =>
    ctx.hub.send({
      v: 1,
      id: frameId(),
      type: "refuse",
      msg_id,
      reason: "closed",
      detail,
    });

  const fail = (msg_id: string) => (e: unknown) => {
    // Callers fire and forget; a leaked rejection would crash the daemon.
    ctx.log?.(
      `delivery of ${msg_id} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  };
  const deliver = (frame: DeliverFrame): Promise<void> =>
    attempt(frame).catch(fail(frame.msg_id));

  const attempt = async (frame: DeliverFrame): Promise<void> => {
    const { msg_id } = frame;
    if (seen.has(msg_id)) {
      ack(msg_id); // the hub redelivers after a missed ack
      return;
    }
    const running = inflight.get(msg_id);
    if (running) {
      // A redelivery while the first attempt is in flight joins it.
      await running.settled;
      if (seen.has(msg_id)) ack(msg_id);
      return;
    }
    const agent = ctx.agents.byRef(frame.to_ref);
    const fn = agent?.live ? ctx.transports[agent.kind] : undefined;
    if (!agent || !fn) {
      refuse(msg_id, "dropped"); // waking a closed session injects nothing
      return;
    }
    // A peer's body never reaches a harness with terminal controls in it.
    const body =
      frame.body === undefined
        ? oversizedText(frame.notice?.size ?? 0, msg_id)
        : stripTerminalControls(frame.body);
    const done = fn(agent, {
      msg_id,
      from_name: stripTerminalControls(frame.from_name),
      namespace: frame.namespace,
      body,
      ...(frame.body === undefined
        ? { notice: { size: frame.notice?.size ?? 0, msg_id } }
        : {}),
    }).catch((e: unknown): DeliverOutcome => {
      ctx.log?.(
        `transport threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, reason: "timeout" };
    });
    const settled = done
      .then((outcome) => {
        inflight.delete(msg_id);
        // Once the adapter confirmed it, the transport's later word changes nothing.
        if (seen.has(msg_id)) return;
        if (outcome.ok) {
          seen.add(msg_id);
          ack(msg_id);
        } else if (outcome.cause) {
          refuse(msg_id, outcome.cause);
        } else if (outcome.reason === "closed") {
          agent.live = false;
          ctx.onClosed(agent);
          refuse(msg_id, "dropped");
        }
        // A timeout or a queued stays unrecorded and unacked: the receipt stays pending.
      })
      .catch(fail(msg_id));
    inflight.set(msg_id, { ref: agent.ref, settled });
    await settled;
  };

  return {
    deliver,
    /** The adapter confirms injection. Only the delivery's own agent may. */
    confirm: (msgId: string, ref: string): boolean => {
      if (inflight.get(msgId)?.ref !== ref) return false;
      if (seen.add(msgId)) ack(msgId);
      return true;
    },
    /**
     * A transport vouches for a delivery whose attempt already settled (a
     * late ack): recorded and acked, so the hub's retry injects nothing.
     */
    delivered: (msgId: string): void => {
      if (seen.add(msgId)) ack(msgId);
    },
  };
}
