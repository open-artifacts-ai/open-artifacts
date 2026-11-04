import type { SendFrame } from "@oa/bus-protocol";
import type { Timer } from "./sent.ts";

/** How long a send that lost its link keeps being resent; well under the hub's 1 h dedupe window. */
export const RESEND_WINDOW_MS = 60_000;
/** How long an overdue resend in flight may still wait for its answer. */
const GRACE_MS = 10_000;
/** Links a send may lose before it is given up on. */
export const RESEND_MAX_DROPS = 3;
/** First wait before a resend the hub rate-limited (or the pacer dropped) goes again; doubles each time. */
const RETRY_BASE_MS = 1000;

type Entry = {
  frame: SendFrame;
  native: boolean;
  /** When it was first handed to the hub. */
  at: number;
  /** Links lost while this send had no receipt. */
  drops: number;
  /** The link it last went out on (-1: not since a failed try); a resend goes once per link. */
  link: number;
  /** Retries so far (rate-limited, or dropped unsent). */
  retries: number;
  /** The window ended while a resend was in flight: given up if that link drops too. */
  overdue?: true;
  /** Cancels the window's timer. */
  stopExpire?: () => void;
  /** Cancels a pending retry's timer. */
  stopRetry?: () => void;
};

const unrefTimer: Timer = (ms, fn) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/**
 * Sends the hub has not answered yet. One whose link drops is kept, frame and
 * id unchanged, and resent once its sender is registered on the next link: the
 * hub dedupes on (sender, id), so a send it already took is never delivered
 * twice (B14). In memory only: a daemon restart forgets them.
 */
export class Resends {
  #all = new Map<string, Entry>();
  #link = 0;
  readonly #windowMs: number;
  readonly #graceMs: number;
  readonly #maxDrops: number;
  readonly #after: Timer;
  readonly #now: () => number;

  constructor(
    private readonly opts: {
      /** Queues the frame, unchanged; false when it cannot go. `unsent`: queued, then never written. */
      send: (f: SendFrame, unsent: () => void) => boolean;
      /** Gave up on a send: no answer comes for it. */
      expire: (f: SendFrame, native: boolean) => void;
      windowMs?: number;
      /** Default GRACE_MS. */
      graceMs?: number;
      maxDrops?: number;
      after?: Timer;
      now?: () => number;
      log?: (msg: string) => void;
    },
  ) {
    this.#windowMs = opts.windowMs ?? RESEND_WINDOW_MS;
    this.#graceMs = opts.graceMs ?? GRACE_MS;
    this.#maxDrops = opts.maxDrops ?? RESEND_MAX_DROPS;
    this.#after = opts.after ?? unrefTimer;
    this.#now = opts.now ?? Date.now;
  }

  /** A send handed to the hub on the current link. */
  track(frame: SendFrame, native: boolean): void {
    // One the hub never answered on a link that held is not kept forever.
    this.#sweep();
    this.#all.set(frame.id, {
      frame,
      native,
      at: this.#now(),
      drops: 0,
      link: this.#link,
      retries: 0,
    });
  }

  /** The hub answered it, or it never went out: no resend. */
  untrack(id: string): void {
    const e = this.#all.get(id);
    if (!e) return;
    e.stopExpire?.();
    e.stopRetry?.();
    this.#all.delete(id);
  }

  /** The frame a send went out as, while it is tracked. */
  frame(id: string): SendFrame | undefined {
    return this.#all.get(id)?.frame;
  }

  /** It went out on a link that dropped before the hub answered. */
  held(id: string): boolean {
    return (this.#all.get(id)?.drops ?? 0) > 0;
  }

  /** The link dropped: every unanswered send waits for the next one. */
  dropped(): void {
    this.#link++;
    // Too old to resend: the hub may have dropped its key and would deliver it again.
    this.#sweep();
    for (const [id, e] of [...this.#all]) {
      e.stopRetry?.();
      e.stopRetry = undefined;
      if (e.overdue || ++e.drops > this.#maxDrops) {
        this.#giveUp(id, e);
        continue;
      }
      e.stopExpire ??= this.#after(this.#windowMs, () => {
        e.stopExpire = undefined;
        // A resend in flight on the open link: wait a little for its answer, or the link's drop.
        if (e.link !== this.#link || e.stopRetry) {
          this.#giveUp(id, e);
          return;
        }
        e.overdue = true;
        e.stopExpire = this.#after(this.#graceMs, () => {
          e.stopExpire = undefined;
          this.#giveUp(id, e);
        });
      });
    }
  }

  /** `ref` is registered on the current link: its held sends go again. */
  up(ref: string): void {
    for (const e of [...this.#all.values()])
      if (e.drops > 0 && e.link !== this.#link && e.frame.from_ref === ref)
        this.#send(e);
  }

  /** The hub rate-limited a resend: it goes again later, within the window. False when not a resend. */
  limited(id: string): boolean {
    const e = this.#all.get(id);
    if (!e || e.drops === 0) return false;
    // Past its window: no more retries.
    if (e.overdue) this.#giveUp(id, e);
    else this.#later(e);
    return true;
  }

  /** The daemon is stopping: forget everything, timers included. */
  stop(): void {
    for (const id of [...this.#all.keys()]) this.untrack(id);
  }

  #send(e: Entry): void {
    e.stopRetry?.();
    e.stopRetry = undefined;
    const link = this.#link;
    e.link = link;
    // Never written (the pacer was full, or the socket closing): it goes again.
    const unsent = () => {
      if (this.#all.get(e.frame.id) !== e || e.link !== link) return;
      e.link = -1;
      if (link === this.#link) this.#later(e);
    };
    if (!this.opts.send(e.frame, unsent)) unsent();
  }

  /** Sends `e` again after a backoff, on this link only; a dropped link resends on the next agent_ok. */
  #later(e: Entry): void {
    const link = this.#link;
    e.stopRetry?.();
    e.stopRetry = this.#after(RETRY_BASE_MS * 2 ** e.retries++, () => {
      e.stopRetry = undefined;
      if (link === this.#link) this.#send(e);
    });
  }

  /** Sends never dropped and unanswered past the window: given up, never resent. */
  #sweep(): void {
    const cutoff = this.#now() - this.#windowMs;
    for (const [id, e] of [...this.#all])
      if (e.drops === 0 && e.at < cutoff) this.#giveUp(id, e);
  }

  #giveUp(id: string, e: Entry): void {
    this.untrack(id);
    this.opts.log?.(
      `gave up resending ${id}: no receipt after ${e.drops} lost link(s)`,
    );
    this.opts.expire(e.frame, e.native);
  }
}
