import {
  type DaemonFrame,
  messageHeader,
  neutralizeBody,
  stripTerminalControls,
} from "@oa/bus-ipc";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";

/**
 * agy S3: an Antigravity (agy) session receives through a watcher, a process
 * the session itself starts outside agy's sandbox (`oa-bus agy-watch`), the
 * only kind of process agy gives its agentapi address and token. One watcher
 * serves one agy process, whichever conversation it shows: it hands each
 * message to `agy agentapi send-message <conversation> <text>`, which lands
 * inside a running turn at its next tool step, or wakes an idle session.
 *
 * With no watcher up for the session's agy process the message is held here,
 * its receipt pending, and goes the moment one comes up. Nothing is queued
 * while one is up: agy places the message itself.
 */

export type AgyWatcherKey = { pid: number; procStart: string };

type Watcher = AgyWatcherKey & {
  /** Writes a frame on the watcher's connection; false when it is gone. */
  push: (f: DaemonFrame) => boolean;
};

type Waiting = {
  ref: string;
  key: AgyWatcherKey;
  wake: (why: "up" | "closed") => void;
};

/** What a watcher said of a push, or that it never said. */
type Said = "ok" | "failed" | "unknown" | "lost";

type InFlight = {
  watcher: Watcher;
  done: (o: Said) => void;
};

export type AgyTransportOptions = {
  /** How long a watcher has to answer a push before it is pushed again. Default 30 s. */
  answerTimeoutMs?: number;
  log?: (msg: string) => void;
};

const same = (a: AgyWatcherKey, b: AgyWatcherKey) =>
  a.pid === b.pid && a.procStart === b.procStart;

/** The text agy shows the model: the bus's header, the msg id, then the body as data. */
export function agyMessageText(agent: AgentRecord, mail: Mail): string {
  const header = `${messageHeader({
    from: mail.from_name,
    to: agent.busName,
    namespace: mail.namespace,
    global: agent.global,
  })} (msg_id ${mail.msg_id})`;
  // The bus's own oversized notice is not peer text: it is never escaped.
  return mail.notice
    ? `${header}\n\n${mail.body}`
    : `${header}\n\n${neutralizeBody(stripTerminalControls(mail.body))}`;
}

export class AgyTransport {
  #watchers = new Set<Watcher>();
  #waiting = new Set<Waiting>();
  #inflight = new Map<string, InFlight>();
  #stopped = false;

  constructor(private readonly opts: AgyTransportOptions = {}) {}

  /** The watcher up for this agy process, if any. */
  watcherFor(key: AgyWatcherKey): Watcher | undefined {
    for (const w of this.#watchers) if (same(w, key)) return w;
    return undefined;
  }

  /**
   * A watcher's connection opened. A second one for the same agy process is
   * refused at hello (watcherFor); this one takes every held message of it.
   */
  up(key: AgyWatcherKey, push: Watcher["push"]): Watcher {
    const w: Watcher = { ...key, push };
    this.#watchers.add(w);
    for (const wait of [...this.#waiting])
      if (same(wait.key, key)) wait.wake("up");
    return w;
  }

  /** The watcher's connection closed: what it was handed waits for the next one. */
  down(w: Watcher): void {
    this.#watchers.delete(w);
    for (const [msgId, f] of this.#inflight)
      if (f.watcher === w) {
        this.#inflight.delete(msgId);
        f.done("lost");
      }
  }

  /** The watcher answered msgId; true only for a push to that same watcher. */
  answered(
    msgId: string,
    w: Watcher,
    said: "ok" | "failed" | "unknown",
  ): boolean {
    const f = this.#inflight.get(msgId);
    if (f?.watcher !== w) return false;
    this.#inflight.delete(msgId);
    f.done(said);
    return true;
  }

  /** The session closed (its agy process ended, another conversation took over). */
  closed(ref: string): void {
    for (const wait of [...this.#waiting])
      if (wait.ref === ref) wait.wake("closed");
  }

  /** The daemon is stopping: nothing held waits any more. */
  stop(): void {
    this.#stopped = true;
    for (const wait of [...this.#waiting]) wait.wake("closed");
  }

  /** How many messages wait for a watcher, for this agy process or all. */
  held(key?: AgyWatcherKey): number {
    let n = 0;
    for (const w of this.#waiting) if (!key || same(w.key, key)) n += 1;
    return n;
  }

  async deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    const procStart = agent.procStart;
    // S2 records always carry it; without it no watcher can be matched.
    if (procStart === undefined) return { ok: false, reason: "queued" };
    const key = { pid: agent.pid, procStart };
    const text = agyMessageText(agent, mail);
    for (;;) {
      if (this.#stopped || !agent.live)
        return { ok: false, reason: "closed", closedBy: "liveness" };
      const w = this.watcherFor(key);
      if (!w) {
        // Held: the receipt stays pending until a watcher comes up.
        if ((await this.#wait(agent.ref, key)) === "closed")
          return { ok: false, reason: "closed", closedBy: "liveness" };
        continue;
      }
      const got = await this.#push(w, agent.ref, mail.msg_id, text);
      // The watcher acks only what agy's agentapi or agy's own mailbox says
      // agy took.
      if (got === "ok") return { ok: true };
      // agy said no (it may be starting up): the deliver chain retries.
      if (got === "failed")
        return { ok: false, reason: "timeout", retryable: true };
      // An earlier hand-off may have reached agy and its mailbox cannot say:
      // a timeout that may have delivered (#2110). Never acked, never pushed
      // again here: the receipt stays pending until the hub delivers again.
      if (got === "unknown") return { ok: false, reason: "timeout" };
      // "lost": the watcher went away or went quiet before it answered. The
      // next push carries the same msg_id; a watcher checks agy's mailbox
      // before it hands over an id an earlier one may have, so this never
      // doubles a message.
    }
  }

  #wait(ref: string, key: AgyWatcherKey): Promise<"up" | "closed"> {
    return new Promise((resolve) => {
      const wait: Waiting = {
        ref,
        key,
        wake: (why) => {
          this.#waiting.delete(wait);
          resolve(why);
        },
      };
      this.#waiting.add(wait);
    });
  }

  #push(w: Watcher, ref: string, msgId: string, text: string): Promise<Said> {
    // One push per id at a time; a second deliver of it joins the hub's chain.
    this.#inflight.get(msgId)?.done("lost");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#inflight.get(msgId) !== entry) return;
        this.#inflight.delete(msgId);
        this.opts.log?.(`agy watcher did not answer ${msgId} in time`);
        resolve("lost");
      }, this.opts.answerTimeoutMs ?? 30_000);
      timer.unref();
      const entry: InFlight = {
        watcher: w,
        done: (o) => {
          clearTimeout(timer);
          resolve(o);
        },
      };
      this.#inflight.set(msgId, entry);
      const pushed = w.push({
        v: 1,
        id: `agy-${msgId}`.slice(0, 64),
        type: "agy_deliver",
        msg_id: msgId,
        conversation_id: ref,
        text,
      });
      if (!pushed) {
        this.#inflight.delete(msgId);
        clearTimeout(timer);
        this.#watchers.delete(w);
        resolve("lost");
      }
    });
  }
}
