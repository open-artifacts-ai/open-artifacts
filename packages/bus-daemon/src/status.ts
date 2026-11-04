import { STATUS_COPY, type Unframed } from "@oa/bus-ipc";
import {
  type ClientFrame,
  frameId,
  type ServerFrame,
  type StatusState,
} from "@oa/bus-protocol";
import type { Timer } from "./sent.ts";

/**
 * The local guard: at most one `status` frame per agent this often. Updates
 * in between are coalesced, the latest kept, as the hub does in its 5 s
 * window; this only keeps a runaway adapter off the socket's frame budget.
 */
export const STATUS_EVERY_MS = 1000;
/** How long a sent status's id is kept to match a late hub error to its agent. */
export const STATUS_ERROR_MS = 60_000;

export { STATUS_COPY } from "@oa/bus-ipc";

type Reply = (f: Unframed) => unknown;
const refuse = (code: string): Unframed => ({
  type: "error",
  code,
  message:
    STATUS_COPY[code as keyof typeof STATUS_COPY] ?? STATUS_COPY.bad_frame,
});

type Update = { state: StatusState; label?: string };
type Guard = { queued?: Update; stop: () => void };
/** A status the hub refused, or that never went: told on the agent's next set_status. */
type Earlier = { code: string; message: string };

const unrefTimer: Timer = (ms, fn) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/** set_status becomes a hub `status` frame. The hub answers nothing on success. */
export class AgentStatusRelay {
  readonly #guards = new Map<string, Guard>();
  /** Sent status ids, to their agent, while a late hub error may still name them. */
  readonly #sent = new Map<string, { ref: string; stop: () => void }>();
  readonly #earlier = new Map<string, Earlier>();
  readonly #after: Timer;

  constructor(
    private readonly opts: {
      /** `onUnsent`: the frame was queued but never written (dropped, or the link closed). */
      send: (f: ClientFrame, onUnsent?: () => void) => boolean;
      /** Whether the hub link is open, to tell a busy queue from a dropped link. */
      open: () => boolean;
      log?: (msg: string) => void;
      after?: Timer;
      statusEveryMs?: number;
    },
  ) {
    this.#after = opts.after ?? unrefTimer;
  }

  /**
   * Answered at once: the hub replies nothing on success. A refusal of an
   * earlier status, or one that never went, rides on this answer.
   */
  status(
    ref: string,
    state: StatusState,
    label: string | undefined,
    reply: Reply,
  ): void {
    const update: Update = { state, ...(label === undefined ? {} : { label }) };
    const earlier = this.#earlier.get(ref);
    this.#earlier.delete(ref);
    const g = this.#guards.get(ref);
    // In the window: the newer claim replaces any queued one, as at the hub.
    if (g) g.queued = update;
    else this.#sendStatus(ref, update);
    reply({ type: "status_set", ...(earlier ? { earlier } : {}) });
  }

  #sendStatus(ref: string, u: Update): void {
    const id = frameId();
    const ok = this.opts.send(
      {
        v: 1,
        id,
        type: "status",
        from_ref: ref,
        state: u.state,
        ...(u.label === undefined ? {} : { label: u.label }),
      },
      () => this.#unsent(ref, id, u),
    );
    if (!ok) {
      // Refused at push on an open link (a full queue): like a dropped frame.
      if (this.opts.open()) this.#hold(ref, u);
      else this.#owe(ref, "hub_unavailable");
      return;
    }
    const stop = this.#after(STATUS_ERROR_MS, () => this.#sent.delete(id));
    this.#sent.set(id, { ref, stop });
    this.#hold(ref);
  }

  /** Never written: the latest goes again when the guard's window ends, unless a newer one waits. */
  #unsent(ref: string, id: string, u: Update): void {
    this.#sent.get(id)?.stop();
    this.#sent.delete(id);
    const g = this.#guards.get(ref);
    if (!this.opts.open()) {
      if (!g?.queued) this.#owe(ref, "hub_unavailable");
      return;
    }
    if (g) g.queued ??= u;
    else this.#hold(ref, u);
  }

  /** Opens the guard's window with `queued` waiting: it goes when the window ends. */
  #hold(ref: string, queued?: Update): void {
    const guard: Guard = {
      queued,
      stop: this.#after(this.opts.statusEveryMs ?? STATUS_EVERY_MS, () => {
        this.#guards.delete(ref);
        if (guard.queued) this.#sendStatus(ref, guard.queued);
      }),
    };
    this.#guards.set(ref, guard);
  }

  #owe(ref: string, code: string): void {
    const r = refuse(code) as Earlier;
    this.#earlier.set(ref, { code, message: r.message });
  }

  /** A hub `error` naming a sent status; false for anything else. */
  answer(f: ServerFrame): boolean {
    if (f.type !== "error") return false;
    const sent = this.#sent.get(f.id);
    if (!sent) return false;
    sent.stop();
    this.#sent.delete(f.id);
    this.opts.log?.(`the hub refused a status from ${sent.ref}: ${f.code}`);
    this.#owe(sent.ref, f.code);
    return true;
  }

  /** The hub link dropped: queued updates will not go. */
  dropped(): void {
    for (const [ref, g] of this.#guards) {
      g.stop();
      if (g.queued) this.#owe(ref, "hub_unavailable");
    }
    this.#guards.clear();
  }
}
