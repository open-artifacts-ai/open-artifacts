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
 *
 * #3205: a message whose hand-off is unknown (an earlier agy call may have
 * reached agy, and agy's mailbox cannot say yet) stays held here too. It is
 * pushed again after a pause, or as soon as a new watcher comes up, and that
 * watcher asks agy's mailbox again: present acks it (Delivered), absent once
 * the earlier call is surely gone sends it once, still unclear answers
 * unknown again. It is never acked on a guess and never sent twice.
 */

export type AgyWatcherKey = { pid: number; procStart: string };

type Watcher = AgyWatcherKey & {
  /** Writes a frame on the watcher's connection; false when it is gone. */
  push: (f: DaemonFrame) => boolean;
};

type Waiting = {
  ref: string;
  key: AgyWatcherKey;
  /** A message whose hand-off is unknown, pausing before it is pushed again. */
  recheck?: true;
  wake: (why: "up" | "closed") => void;
};

/** What a watcher said of a push, or that it never said. */
type Said = "ok" | "failed" | "unknown" | "lost";

type InFlight = {
  watcher: Watcher;
  done: (o: Said) => void;
};

export type AgyTransportOptions = {
  /** How long a watcher has to answer a push before it is pushed again. Default AGY_ANSWER_TIMEOUT_MS (50 s). */
  answerTimeoutMs?: number;
  /**
   * #3205: the pauses before an unknown or failed hand-off is pushed again,
   * the last repeated. Default 2 s, 5 s, 10 s, then every 30 s.
   */
  recheckMs?: readonly number[];
  log?: (msg: string) => void;
};

/** How long `agy agentapi send-message` may take; shared with `oa-bus agy-watch`. */
export const AGY_SEND_TIMEOUT_MS = 20_000;
/**
 * How long the daemon waits for a watcher's answer before pushing again.
 * Strictly greater than 2 x AGY_SEND_TIMEOUT_MS: a replayed hand-off can wait
 * out an earlier call (up to AGY_SEND_TIMEOUT_MS) and then run its own send
 * (up to AGY_SEND_TIMEOUT_MS), plus margin for IPC and mailbox checks.
 */
export const AGY_ANSWER_TIMEOUT_MS = 2 * AGY_SEND_TIMEOUT_MS + 10_000;

const RECHECK_MS = [2000, 5000, 10_000, 30_000] as const;

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
    for (const w of this.#waiting)
      if (!w.recheck && (!key || same(w.key, key))) n += 1;
    return n;
  }

  /** #3205: how many unknown hand-offs wait to be pushed again. */
  rechecking(): number {
    let n = 0;
    for (const w of this.#waiting) if (w.recheck) n += 1;
    return n;
  }

  async deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    const procStart = agent.procStart;
    // S2 records always carry it; without it no watcher can be matched.
    if (procStart === undefined) return { ok: false, reason: "queued" };
    const key = { pid: agent.pid, procStart };
    let rechecks = 0;
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
      // Framed at each push: a rename meanwhile shows the session's new name.
      const text = agyMessageText(agent, mail);
      const got = await this.#push(w, agent.ref, mail.msg_id, text);
      // The watcher acks only what agy's agentapi or agy's own mailbox says
      // agy took.
      if (got === "ok") return { ok: true };
      // agy said no (e.g. its language server is restarting) or (#3205) an
      // earlier hand-off may have reached agy and its mailbox cannot say yet.
      // Never acked on a guess and never sent through the generic retry chain
      // (which closes the record on exhaustion, and nothing reopens an
      // antigravity record): held here, the receipt pending, and pushed again
      // after a pause (or to a new watcher at once). For unknown, the
      // watcher's mailbox check decides then and never sends an id twice
      // while that is unclear.
      if (got === "failed" || got === "unknown") {
        const pauses = this.opts.recheckMs ?? RECHECK_MS;
        const ms = pauses[Math.min(rechecks, pauses.length - 1)] ?? 30_000;
        rechecks += 1;
        if ((await this.#wait(agent.ref, key, ms)) === "closed")
          return { ok: false, reason: "closed", closedBy: "liveness" };
        continue;
      }
      // "lost": the watcher went away or went quiet before it answered. The
      // next push carries the same msg_id; a watcher checks agy's mailbox
      // before it hands over an id an earlier one may have, so this never
      // doubles a message.
    }
  }

  /**
   * Until a watcher for `key` comes up or the session closes; with `ms`
   * (#3205, a recheck), also until that pause ends.
   */
  #wait(
    ref: string,
    key: AgyWatcherKey,
    ms?: number,
  ): Promise<"up" | "closed"> {
    if (this.#stopped) return Promise.resolve("closed");
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait: Waiting = {
        ref,
        key,
        ...(ms === undefined ? {} : { recheck: true as const }),
        wake: (why) => {
          if (timer) clearTimeout(timer);
          this.#waiting.delete(wait);
          resolve(why);
        },
      };
      this.#waiting.add(wait);
      if (ms !== undefined) {
        timer = setTimeout(() => wait.wake("up"), ms);
        timer.unref();
      }
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
      }, this.opts.answerTimeoutMs ?? AGY_ANSWER_TIMEOUT_MS);
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
