import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { excerptOf } from "@oa/bus-ipc";
import {
  AgentRefSchema,
  BusNameSchema,
  MAILBOX_RETAIN_MS,
  MsgIdSchema,
  type ReceiptReason,
  ReceiptReasonSchema,
  type ReceiptState,
  type SendFrame,
  WireNamespaceSchema,
} from "@oa/bus-protocol";

/** Who sent a message, so a later expiry or refusal reaches that session. */
export type SentMeta = {
  from_ref: string;
  /** The sender's bus name when it sent, for `oa-bus status`; absent in old entries. */
  from_name?: string;
  to_name: string;
  namespace?: string;
  /** What the notice quotes of the body (`excerptOf`); absent in old entries. */
  excerpt?: string;
};
/**
 * A final expired/refused receipt the sender has not been told yet, or `lost`:
 * a send given up on after its link dropped, its fate unknown (C16).
 */
export type Outcome =
  | { state: "expired" | "refused"; reason?: ReceiptReason }
  | { state: "lost"; reason?: undefined };
/**
 * `delivered`: the hub delivered it; never a notice. `late`: after send_message
 * stopped waiting, so the sender's next tool result says so, once (`shown`).
 * `native`: a reply no tool call sent, so never late.
 */
type Entry = SentMeta & {
  at: number;
  native?: true;
  outcome?: Outcome;
  delivered?: true;
  late?: true;
  shown?: true;
};
type Late = { msgId: string; meta: SentMeta };

/** The entry's meta, without its bookkeeping. */
const metaOf = ({
  at: _,
  outcome: __,
  delivered: ___,
  late: ____,
  shown: _____,
  native: ______,
  ...meta
}: Entry): SentMeta => meta;

const validOutcome = (o: unknown): o is Outcome => {
  if (o === undefined) return true;
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return r.state === "lost"
    ? r.reason === undefined
    : (r.state === "expired" || r.state === "refused") &&
        (r.reason === undefined ||
          ReceiptReasonSchema.safeParse(r.reason).success);
};

const valid = (id: string, e: unknown): e is Entry => {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return (
    MsgIdSchema.safeParse(id).success &&
    AgentRefSchema.safeParse(r.from_ref).success &&
    BusNameSchema.safeParse(r.to_name).success &&
    (r.namespace === undefined ||
      WireNamespaceSchema.safeParse(r.namespace).success) &&
    typeof r.at === "number" &&
    validOutcome(r.outcome) &&
    (r.delivered === undefined || r.delivered === true) &&
    (r.late === undefined || r.late === true) &&
    (r.shown === undefined || r.shown === true) &&
    (r.native === undefined || r.native === true)
  );
};

/** An excerpt as stored: one line, at most 40 characters and an ellipsis, no quotes. */
const validExcerpt = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length > 0 &&
  Array.from(x).length <= 41 &&
  !/["\r\n]/.test(x);

/**
 * Outgoing msg_ids not yet told to their sender, kept on disk (0600, written
 * atomically, batched per tick) so a restarted daemon still tells the sender.
 * An entry lives a little past the mail TTL, so the hub's expiry always finds
 * it; one with an outcome waits there for its sender to be live again.
 */
export class SentStore {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #log: ((msg: string) => void) | undefined;
  #all = new Map<string, Entry>();
  #dirty: NodeJS.Immediate | undefined;

  constructor(
    private readonly file?: string,
    opts: {
      ttlMs?: number;
      max?: number;
      now?: () => number;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.#ttlMs = opts.ttlMs ?? MAILBOX_RETAIN_MS + 300_000;
    this.#max = opts.max ?? 10_000;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log;
    this.#load();
  }

  add(msgId: string, meta: SentMeta, outcome?: Outcome, native = false): void {
    this.#prune();
    this.#all.delete(msgId);
    this.#all.set(msgId, {
      ...meta,
      at: this.#now(),
      ...(outcome ? { outcome } : {}),
      ...(native ? { native } : {}),
    });
    this.#cap();
    this.#save();
  }

  /** The sender of `msgId`; undefined when unknown or too old. */
  get(msgId: string): SentMeta | undefined {
    const e = this.#all.get(msgId);
    if (!e || e.at < this.#now() - this.#ttlMs) return undefined;
    return metaOf(e);
  }

  /** Records that the hub delivered `msgId`, `late` past send_message's wait; kept a full TTL from now. */
  deliver(msgId: string, late = false): void {
    const e = this.#all.get(msgId);
    // An outcome already settled is still owed to its sender.
    if (!e || e.outcome) return;
    const { outcome: _, ...rest } = e;
    this.#all.delete(msgId);
    this.#all.set(msgId, {
      ...rest,
      at: this.#now(),
      delivered: true,
      ...(late && !e.native ? { late } : {}),
    });
    this.#save();
  }

  /** `ref`'s late deliveries not yet shown, oldest first. */
  lateFor(ref: string): Late[] {
    this.#prune();
    const out: Late[] = [];
    for (const [msgId, e] of this.#all)
      if (e.from_ref === ref && e.late && !e.shown)
        out.push({ msgId, meta: metaOf(e) });
    return out;
  }

  /** These late deliveries reached their sender: never shown again. */
  shown(msgIds: string[]): void {
    let changed = false;
    for (const id of msgIds) {
      const e = this.#all.get(id);
      if (e?.late && !e.shown) changed = e.shown = true;
    }
    if (changed) this.#save();
  }

  /** Every late delivery since `cutoff` (ms), oldest first; read-only. */
  lateSince(cutoff: number): (Late & { at: number })[] {
    const out: (Late & { at: number })[] = [];
    for (const [msgId, e] of this.#all)
      if (e.late && e.at >= cutoff)
        out.push({ msgId, meta: metaOf(e), at: e.at });
    return out;
  }

  outcome(msgId: string): Outcome | undefined {
    return this.#all.get(msgId)?.outcome;
  }

  isDelivered(msgId: string): boolean {
    return this.#all.get(msgId)?.delivered === true;
  }

  /** Records the final receipt until the sender has been told. */
  /** The owed notice lives a full TTL from now, and moves to the back of the age order. */
  settle(msgId: string, outcome: Outcome): void {
    const e = this.#all.get(msgId);
    if (!e) return;
    this.#all.delete(msgId);
    this.#all.set(msgId, { ...e, at: this.#now(), outcome });
    this.#save();
  }

  delete(msgId: string): void {
    if (this.#all.delete(msgId)) this.#save();
  }

  /** Settled entries whose sender is `ref`, oldest first. */
  untold(ref: string): { msgId: string; meta: SentMeta; outcome: Outcome }[] {
    this.#prune();
    const out: { msgId: string; meta: SentMeta; outcome: Outcome }[] = [];
    for (const [msgId, e] of this.#all) {
      if (e.from_ref !== ref || !e.outcome) continue;
      out.push({ msgId, meta: metaOf(e), outcome: e.outcome });
    }
    return out;
  }

  /** Writes now; a stopping daemon calls this so nothing batched is lost. */
  flush(): void {
    if (!this.#dirty) return;
    clearImmediate(this.#dirty);
    this.#dirty = undefined;
    this.#write();
  }

  /**
   * Insertion order is age order: the first key is the oldest. Delivered
   * records go first: nothing is owed on them.
   */
  #cap(): void {
    let over = this.#all.size - this.#max;
    if (over <= 0) return;
    for (const [id, e] of this.#all) {
      if (over <= 0) return;
      if (e.delivered) {
        this.#all.delete(id);
        over--;
      }
    }
    for (; over > 0; over--)
      this.#all.delete(this.#all.keys().next().value as string);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    let pruned = false;
    for (const [id, e] of this.#all)
      if (e.at < cutoff) pruned = this.#all.delete(id);
    if (pruned) this.#save();
  }

  #load(): void {
    if (!this.file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const entries = Object.entries(raw).filter(([id, e]) => valid(id, e));
    entries.sort(([, a], [, b]) => (a as Entry).at - (b as Entry).at);
    for (const [id, e] of entries) {
      const {
        from_ref,
        from_name,
        to_name,
        namespace,
        excerpt,
        at,
        outcome,
        delivered,
        late,
        shown,
        native,
      } = e as Entry;
      this.#all.set(id, {
        from_ref,
        ...(BusNameSchema.safeParse(from_name).success ? { from_name } : {}),
        to_name,
        ...(namespace === undefined ? {} : { namespace }),
        ...(validExcerpt(excerpt) ? { excerpt } : {}),
        at,
        ...(outcome
          ? {
              outcome:
                outcome.state === "lost"
                  ? { state: outcome.state }
                  : {
                      state: outcome.state,
                      ...(outcome.reason ? { reason: outcome.reason } : {}),
                    },
            }
          : {}),
        ...(delivered ? { delivered } : {}),
        ...(delivered && late ? { late } : {}),
        ...(delivered && late && shown ? { shown } : {}),
        ...(native ? { native } : {}),
      });
    }
    this.#prune();
    this.#cap();
  }

  /** One write per tick, however many changes it saw. */
  #save(): void {
    if (!this.file || this.#dirty) return;
    this.#dirty = setImmediate(() => {
      this.#dirty = undefined;
      this.#write();
    });
    this.#dirty.unref();
  }

  /** Disk trouble is logged; memory still serves this daemon's lifetime. */
  #write(): void {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#all)), {
        mode: 0o600,
        flag: "wx",
      });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch (e) {
      this.#log?.(
        `sent file write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

export type Notice = { msgId: string; meta: SentMeta } & Outcome;
type Final = { msg_id: string; state: ReceiptState; reason?: ReceiptReason };

/** How long a tool call's send waits past its receipt for delivered (or a refusal or expiry). */
export const DELIVERED_WAIT_MS = 5000;

/** Runs `fn` after `ms`; the returned function cancels it. */
export type Timer = (ms: number, fn: () => void) => () => void;
const unrefTimer: Timer = (ms, fn) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/** How long a receipt_update may wait for its own send's receipt. */
const EARLY_MS = 60_000;
const EARLY_MAX = 1000;
/** Final receipts already handled, remembered so a repeat is a no-op. */
const FINALS_MAX = 10_000;

/**
 * Links a `send` to its hub receipt, then the receipt's msg_id to its later
 * `receipt_update`. Returns what the sending session must be told, if
 * anything; the notice stays in the store until `told`.
 */
export class Receipts {
  /** Hub frame id → the send waiting for its receipt. Short-lived. */
  #sending = new Map<string, { meta: SentMeta; native: boolean; at: number }>();
  /** msg_id → a receipt_update that beat its send's receipt. */
  #early = new Map<string, Final & { at: number }>();
  /** msg_ids whose final receipt_update was handled: a repeat (B14 resend) is ignored. */
  #finals = new Set<string>();
  /** msg_id → a tool call's send waiting for its final receipt (`final`), or that final if it came first. */
  #waiting = new Map<
    string,
    { final?: Final; done?: (f: Final | undefined) => void }
  >();
  readonly #now: () => number;
  readonly #after: Timer;

  constructor(
    private readonly store: SentStore,
    opts: { now?: () => number; after?: Timer } = {},
  ) {
    this.#now = opts.now ?? Date.now;
    this.#after = opts.after ?? unrefTimer;
  }

  /** `native`: no tool call waits for this receipt, so a refusal is a notice too. */
  sending(
    f: SendFrame,
    namespace: string | undefined,
    native: boolean,
    fromName?: string,
  ): void {
    const excerpt = typeof f.body === "string" ? excerptOf(f.body) : undefined;
    const cutoff = this.#now() - 15 * 60_000;
    for (const [id, s] of this.#sending)
      if (s.at < cutoff) this.#sending.delete(id);
    this.#sending.set(f.id, {
      meta: {
        from_ref: f.from_ref,
        ...(fromName ? { from_name: fromName } : {}),
        to_name: f.to_name,
        ...(namespace ? { namespace } : {}),
        ...(excerpt ? { excerpt } : {}),
      },
      native,
      at: this.#now(),
    });
  }

  /** A send given up on with no tool call left to tell: owed as a notice, keyed by its frame id. */
  lost(frameId: string): Notice | undefined {
    const s = this.#sending.get(frameId);
    if (!s) return undefined;
    this.#sending.delete(frameId);
    const outcome: Outcome = { state: "lost" };
    this.store.add(frameId, s.meta, outcome);
    return { msgId: frameId, meta: s.meta, ...outcome };
  }

  /** The hub answered this send with an error (or an undecodable frame): no receipt follows. */
  forget(frameId: string): void {
    this.#sending.delete(frameId);
  }

  /**
   * `waits`: a tool call is about to wait on this send with `final`.
   * `ended`: its tool call already ended (a held send), so a refusal is a notice.
   */
  receipt(
    f: { id: string } & Final,
    waits = false,
    ended = false,
  ): Notice | undefined {
    const s = this.#sending.get(f.id);
    if (!s) return undefined;
    this.#sending.delete(f.id);
    if (f.state === "pending") {
      this.store.add(f.msg_id, s.meta, undefined, s.native);
      if (waits) this.#waiting.set(f.msg_id, {});
      const early = this.#early.get(f.msg_id);
      if (!early) return undefined;
      this.#early.delete(f.msg_id);
      return early.at >= this.#now() - EARLY_MS
        ? this.update(early)
        : undefined;
    }
    if ((!s.native && !ended) || f.state !== "refused") return undefined;
    const outcome: Outcome = { state: f.state, reason: f.reason };
    this.store.add(f.msg_id, s.meta, outcome);
    return { msgId: f.msg_id, meta: s.meta, ...outcome };
  }

  update(f: Final): Notice | undefined {
    if (f.state === "pending" || this.#finals.has(f.msg_id)) return undefined;
    const meta = this.store.get(f.msg_id);
    if (!meta) {
      this.#keepEarly(f);
      return undefined;
    }
    this.#final(f.msg_id);
    // Nothing follows delivered.
    if (this.store.isDelivered(f.msg_id)) return undefined;
    if (f.state === "delivered") {
      // No send waiting: it is late, and the sender's next tool result says so.
      this.store.deliver(f.msg_id, !this.#answer(f));
      return undefined;
    }
    const outcome: Outcome = { state: f.state, reason: f.reason };
    this.store.settle(f.msg_id, outcome);
    // The waiting tool call tells the sender (`told`), or, if it went away, a notice does (`notice`).
    if (this.#answer(f)) return undefined;
    return { msgId: f.msg_id, meta, ...outcome };
  }

  /**
   * The final receipt for a send `receipt` was told waits, once it comes;
   * undefined when none came within `ms` (or the hub link dropped).
   */
  final(msgId: string, ms: number): Promise<Final | undefined> {
    const w = this.#waiting.get(msgId);
    if (!w) return Promise.resolve(undefined);
    if (w.final) {
      this.#waiting.delete(msgId);
      return Promise.resolve(w.final);
    }
    return new Promise((resolve) => {
      const cancel = this.#after(ms, () => w.done?.(undefined));
      w.done = (f) => {
        cancel();
        this.#waiting.delete(msgId);
        resolve(f);
      };
    });
  }

  /** The hub link dropped: every waiting send answers now, as it stands. */
  release(): void {
    for (const w of [...this.#waiting.values()]) w.done?.(undefined);
    this.#waiting.clear();
  }

  /** Hands `f` to the send waiting on it; false when none waits. */
  #answer(f: Final): boolean {
    const w = this.#waiting.get(f.msg_id);
    if (!w) return false;
    const final: Final = {
      msg_id: f.msg_id,
      state: f.state,
      ...(f.reason ? { reason: f.reason } : {}),
    };
    if (w.done) w.done(final);
    else w.final = final;
    return true;
  }

  /** The owed notice for `msgId`, if one is owed. */
  notice(msgId: string): Notice | undefined {
    const meta = this.store.get(msgId);
    const outcome = this.store.outcome(msgId);
    return meta && outcome ? { msgId, meta, ...outcome } : undefined;
  }

  /** The sender has been told: forget the message. */
  told(msgId: string): void {
    this.store.delete(msgId);
  }

  /** Notices still owed to `ref`, e.g. after a restart or while it was away. */
  owed(ref: string): Notice[] {
    return this.store
      .untold(ref)
      .map(({ msgId, meta, outcome }) => ({ msgId, meta, ...outcome }));
  }

  #final(msgId: string): void {
    this.#finals.add(msgId);
    if (this.#finals.size > FINALS_MAX)
      this.#finals.delete(this.#finals.values().next().value as string);
  }

  #keepEarly(f: Final): void {
    const cutoff = this.#now() - EARLY_MS;
    for (const [id, e] of this.#early)
      if (e.at < cutoff) this.#early.delete(id);
    this.#early.set(f.msg_id, { ...f, at: this.#now() });
    while (this.#early.size > EARLY_MAX)
      this.#early.delete(this.#early.keys().next().value as string);
  }
}
