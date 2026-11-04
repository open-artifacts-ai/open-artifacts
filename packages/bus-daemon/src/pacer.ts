import type { ClientFrame } from "@oa/bus-protocol";

/** Lanes, highest first; `sessions` is not in one: it is a barrier. */
const LANE: Partial<Record<ClientFrame["type"], number>> = {
  hello: 0,
  ack: 1,
  refuse: 1,
  agent_up: 2,
  agent_down: 2,
};
/** send, list, fetch: the user's requests. Only this lane is ever dropped. */
const USER = 3;
/** While user frames wait behind acks, at least one token in this many is theirs. */
const USER_SHARE = 4;

type Entry = {
  frame: ClientFrame;
  data: string;
  /** Called if the frame is never written: the caller keeps it. */
  onUnsent?: () => void;
};
/** Frames queued between two `sessions` snapshots; the snapshot goes after them. */
type Segment = { lanes: Entry[][]; barrier?: Entry };
const segment = (): Segment => ({
  lanes: Array.from({ length: USER + 1 }, () => []),
});

/**
 * Frames to the hub, paced under its per-socket limit (50 frames/s): a token
 * bucket of `burst` refilled at `rate`/s, so no second ever carries more than
 * burst + rate frames (40 by default). A `sessions` snapshot never overtakes
 * a frame queued before it. Bounded: overflow drops the oldest user frame;
 * registration and ack frames are never dropped.
 */
export class FramePacer {
  #segments: Segment[] = [segment()];
  #tokens: number;
  #at: number;
  #timer?: NodeJS.Timeout;
  /** Tokens spent on higher lanes in a row while user frames waited. */
  #starved = 0;
  #nearFull = false;
  readonly #rate: number;
  readonly #burst: number;
  readonly #max: number;

  constructor(
    private readonly opts: {
      /** False when the frame was not written (the socket is closing). */
      send: (data: string) => boolean;
      /** Tokens per second; default 35. */
      rate?: number;
      /** Bucket size; default 5. */
      burst?: number;
      /** Queued frames; default 1000. */
      max?: number;
      /** A queued frame dropped for space: its request will not be answered. */
      onDropped?: (frame: ClientFrame) => void;
      log?: (msg: string) => void;
    },
  ) {
    this.#rate = opts.rate ?? 35;
    this.#burst = opts.burst ?? 5;
    this.#max = opts.max ?? 1000;
    this.#tokens = this.#burst;
    this.#at = Date.now();
  }

  get size(): number {
    let n = 0;
    for (const s of this.#segments)
      n += s.lanes.reduce((m, l) => m + l.length, 0) + (s.barrier ? 1 : 0);
    return n;
  }

  /** False when the frame itself was dropped for space. */
  push(frame: ClientFrame, data: string, onUnsent?: () => void): boolean {
    const e: Entry = { frame, data, onUnsent };
    const last = this.#segments[this.#segments.length - 1];
    if (frame.type === "sessions") {
      last.barrier = e;
      this.#segments.push(segment());
    } else last.lanes[LANE[frame.type] ?? USER].push(e);
    const size = this.size;
    if (size > this.#max) {
      const lane = this.#segments
        .map((s) => s.lanes[USER])
        .find((l) => l.length > 0);
      const dropped = lane?.shift();
      if (!dropped)
        this.opts.log?.(
          `hub queue over its bound (${size}/${this.#max}): registrations and acks are kept`,
        );
      else {
        this.opts.log?.(
          `hub queue full: dropped a queued ${dropped.frame.type} frame (max ${this.#max})`,
        );
        if (dropped === e) return false;
        if (dropped.onUnsent) dropped.onUnsent();
        else this.opts.onDropped?.(dropped.frame);
      }
    } else if (!this.#nearFull && size >= this.#max * 0.8) {
      this.#nearFull = true;
      this.opts.log?.(`hub queue near its bound (${size}/${this.#max})`);
    }
    this.#pump();
    return true;
  }

  /** Drops a still-queued frame by id (its request was given up on). */
  remove(id: string): boolean {
    for (const s of this.#segments)
      for (const l of s.lanes) {
        const i = l.findIndex((e) => e.frame.id === id);
        if (i >= 0) {
          l.splice(i, 1);
          return true;
        }
      }
    return false;
  }

  /** Empties the queue; frames with a keeper go back to it, in order. */
  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const all: Entry[] = [];
    for (const s of this.#segments) {
      for (const l of s.lanes) all.push(...l);
      if (s.barrier) all.push(s.barrier);
    }
    this.#segments = [segment()];
    this.#starved = 0;
    this.#nearFull = false;
    for (const e of all) e.onUnsent?.();
  }

  #refill(): void {
    const now = Date.now();
    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + ((now - this.#at) * this.#rate) / 1000,
    );
    this.#at = now;
  }

  /** The next frame and how to take it off the queue; undefined when empty. */
  #pick(): { e: Entry; take: () => void } | undefined {
    const s = this.#segments[0];
    const user = s.lanes[USER];
    const high = s.lanes.slice(0, USER).find((l) => l.length > 0);
    // A frame from an agent whose agent_up is still queued would be refused not_registered.
    const ups = new Set(
      s.lanes[LANE.agent_up as number].flatMap((e) =>
        e.frame.type === "agent_up" ? [e.frame.agent_ref] : [],
      ),
    );
    const i = user.findIndex(
      (e) => !("from_ref" in e.frame) || !ups.has(e.frame.from_ref),
    );
    const fromUser =
      i < 0
        ? undefined
        : {
            e: user[i],
            take: () => {
              user.splice(i, 1);
              this.#starved = 0;
            },
          };
    if (fromUser && high && this.#starved >= USER_SHARE - 1) return fromUser;
    if (high) {
      // Only acks and refuses starve user frames; registrations go first.
      const starving =
        fromUser !== undefined && high === s.lanes[LANE.ack as number];
      return {
        e: high[0],
        take: () => {
          high.shift();
          if (starving) this.#starved++;
        },
      };
    }
    if (fromUser) return fromUser;
    if (!s.barrier) return undefined;
    return { e: s.barrier, take: () => void this.#segments.shift() };
  }

  #pump(): void {
    if (this.#timer) return;
    this.#refill();
    while (this.#tokens >= 1) {
      const next = this.#pick();
      if (!next) break;
      let written: boolean;
      try {
        written = this.opts.send(next.e.data);
      } catch (e) {
        this.opts.log?.(
          `sending a ${next.e.frame.type} frame threw: ${e instanceof Error ? e.message : String(e)}`,
        );
        // Never retried in a loop: the next frame goes on.
        written = true;
      }
      // A closing socket: all stays queued until close hands it to its keepers.
      if (!written) return;
      next.take();
      this.#tokens--;
    }
    const size = this.size;
    if (size < this.#max / 2) this.#nearFull = false;
    if (size === 0) return;
    const wait = Math.ceil(((1 - this.#tokens) * 1000) / this.#rate);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pump();
    }, wait);
    this.#timer.unref();
  }
}
