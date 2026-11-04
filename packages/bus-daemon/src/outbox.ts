type Entry<T> = { frame: T; at: number; seq: number };

/**
 * Frames that must reach the hub even if it is down right now (a Claude
 * session's native reply): bounded in count and age, flushed in order. A frame
 * counts as sent only once written: one the link drops unsent comes back.
 */
export class Outbox<T> {
  #queue: Entry<T>[] = [];
  #seq = 0;
  #retry?: NodeJS.Timeout;
  readonly #max: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(
    private readonly opts: {
      /** True once the frame is accepted; `unsent` hands it back if it is then never written. */
      send: (frame: T, unsent: () => void) => boolean;
      max?: number;
      maxAgeMs?: number;
      /** A frame handed back is retried this soon while the link stays up; default 1 s. */
      retryMs?: number;
      now?: () => number;
      /** A frame whose sender is gone by flush time is dropped, not sent late. */
      stale?: (frame: T) => boolean;
      log?: (msg: string) => void;
    },
  ) {
    this.#max = opts.max ?? 100;
    this.#maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
    this.#now = opts.now ?? Date.now;
  }

  /** Cancels a pending retry; the queue is kept. */
  stop(): void {
    clearTimeout(this.#retry);
    this.#retry = undefined;
  }

  get size(): number {
    return this.#queue.length;
  }

  push(frame: T): void {
    const e = { frame, at: this.#now(), seq: this.#seq++ };
    // Never overtake what is already waiting.
    if (this.#queue.length === 0 && this.#send(e)) return;
    this.#queue.push(e);
    this.#bound();
  }

  #send(e: Entry<T>): boolean {
    return this.opts.send(e.frame, () => this.#back(e));
  }

  /** Accepted but never written (the link dropped): back in its place. */
  #back(e: Entry<T>): void {
    const i = this.#queue.findIndex((q) => q.seq > e.seq);
    this.#queue.splice(i < 0 ? this.#queue.length : i, 0, e);
    this.#bound();
    // Handed back on overflow the link is still up: no reconnect will flush it.
    // One timer at a time; a flush while the link is down just keeps the queue.
    if (this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.flush();
    }, this.opts.retryMs ?? 1000);
    this.#retry.unref();
  }

  #bound(): void {
    if (this.#queue.length > this.#max) {
      this.#queue.shift();
      this.opts.log?.(
        `outbox full: dropped the oldest queued frame (max ${this.#max})`,
      );
    }
  }

  flush(): void {
    const cutoff = this.#now() - this.#maxAgeMs;
    const fresh = this.#queue.filter((e) => e.at >= cutoff);
    const expired = this.#queue.length - fresh.length;
    if (expired)
      this.opts.log?.(`outbox: ${expired} queued frame(s) expired unsent`);
    const live = fresh.filter((e) => !this.opts.stale?.(e.frame));
    if (live.length < fresh.length)
      this.opts.log?.(
        `outbox: dropped ${fresh.length - live.length} queued frame(s) from agents no longer live`,
      );
    this.#queue = live;
    // Off the queue before sending: a frame handed back meanwhile lands in place.
    for (let e = this.#queue.shift(); e; e = this.#queue.shift())
      if (!this.#send(e)) {
        this.#queue.unshift(e);
        break;
      }
  }
}
