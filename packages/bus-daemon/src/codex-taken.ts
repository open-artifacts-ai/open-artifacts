import {
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { MAILBOX_RETAIN_MS } from "@oa/bus-protocol";
import { globRollout, readLines, threadRow } from "./codex-attest.ts";

/** The hub keeps a notice record this long (#1752); a notice watch is dropped then. */
export const NOTICE_WATCH_MS = 6 * 60 * 60 * 1000;

/** Most bytes of one rollout one record reads per pass; the rest waits for the next tick. */
export const TAKEN_SCAN_BUDGET = 2 * 1024 * 1024;

/**
 * One durable record per queued id, in one file (written whole: tmp + rename,
 * 0600). Only `taken`, read back from it, ever authorizes "delivered".
 * - attempt: written BEFORE `codex queue` runs; a restart finding it does not
 *   know whether Codex got the item.
 * - queued: `codex queue` exited 0 (or was killed at its timeout: `maybe`).
 * - taken: the rollout holds the user item that starts with the head.
 * - lost: never taken within its window; never to be reported delivered.
 */
export type TakenRecord = {
  state: "attempt" | "queued" | "taken" | "lost";
  thread: string;
  /** When it was first attempted (ms). */
  at: number;
  /** The first line of the text the transport queued; a user item is "taken" only if it starts with it. Absent: nothing to watch (a wake, a notice). */
  head?: string;
  /** Own retention (ms); a hub notice is kept 6 h, mail MAILBOX_RETAIN_MS. */
  ttlMs?: number;
  /** `codex queue` was killed at its timeout: it may or may not have written the row. */
  maybe?: true;
  /** The rollout read, its size before the spawn, and how far it has been scanned. */
  rollout?: string;
  startOffset?: number;
  scannedTo?: number;
  ino?: number;
  sig?: string;
};

export type TakenOptions = {
  /** Codex's home, read only for the thread's rollout path. */
  home: string;
  /** The records, kept on disk so a restart keeps watching. */
  file: string;
  /** A turn took `id`: the transport vouches for it (late ack). */
  onTaken: (id: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** Past this, a record is dropped; default the hub's mailbox retention. */
  ttlMs?: number;
  /** Bytes of one rollout read per record per pass; default TAKEN_SCAN_BUDGET. */
  scanBudget?: number;
};

/** The rollout's first bytes (up to 512): its first line names the session (timestamp, id), so a replacement differs. */
function prefix(fd: number, size: number): string | undefined {
  const buf = Buffer.alloc(Math.min(512, size));
  if (buf.length === 0 || readSync(fd, buf, 0, buf.length, 0) <= 0)
    return undefined;
  return buf.toString("latin1");
}

/** Whether two prefixes of one file agree over the shorter of them. */
const samePrefix = (a: string, b: string): boolean => {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
};

/** The texts of one rollout line when it is a user item, else none. */
export function userTexts(line: string): string[] {
  if (!line.includes("[oa-bus]")) return [];
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  const r = rec as { type?: unknown; payload?: Record<string, unknown> };
  const p = r?.payload;
  if (!p || typeof p !== "object") return [];
  if (r.type === "response_item" && p.type === "message" && p.role === "user") {
    const out: string[] = [];
    if (Array.isArray(p.content))
      for (const c of p.content as unknown[]) {
        const t = (c as { text?: unknown } | null)?.text;
        if (typeof t === "string") out.push(t);
      }
    return out;
  }
  if (
    r.type === "event_msg" &&
    p.type === "user_message" &&
    typeof p.message === "string"
  )
    return [p.message];
  return [];
}

/**
 * Whether a user item is the one queued with `head`: its text must START with
 * the exact header line the transport wrote and a blank line. A peer's body
 * naming another msg_id sits below the header, never at the start.
 */
export const startsWithHead = (text: string, head: string): boolean =>
  text.startsWith(`${head}\n\n`);

/**
 * Which queued Codex items a turn has taken, read from the thread's rollout
 * (the user item a turn appends). A model cannot write a user item; a
 * same-user writer to CODEX_HOME could, which the attestation already assumes
 * away, and forging only moves a receipt from pending to delivered.
 */
export class TakenWatch {
  readonly #recs = new Map<string, TakenRecord>();
  readonly #now: () => number;

  constructor(private readonly opts: TakenOptions) {
    this.#now = opts.now ?? Date.now;
    for (const [id, r] of Object.entries(this.#load())) this.#recs.set(id, r);
  }

  /** The record's state, or none. */
  state(id: string): TakenRecord["state"] | undefined {
    return this.#recs.get(id)?.state;
  }

  /** Whether `codex queue` was killed at its timeout for this id. */
  maybe(id: string): boolean {
    return this.#recs.get(id)?.maybe === true;
  }

  /** How many records still wait for a turn. */
  size(): number {
    let n = 0;
    for (const r of this.#recs.values())
      if (
        r.head !== undefined &&
        (r.state === "attempt" || r.state === "queued")
      )
        n++;
    return n;
  }

  /**
   * Writes the attempt BEFORE `codex queue` runs. False when it could not be
   * written: the caller must not spawn, and must report a retryable failure.
   * Replaces any earlier record (a re-queue after an interrupted attempt).
   */
  attempt(id: string, thread: string, head?: string, ttlMs?: number): boolean {
    const prev = this.#recs.get(id);
    const rollout = this.#rollout(thread);
    let startOffset = 0;
    let ino: number | undefined;
    let sig: string | undefined;
    if (rollout) {
      try {
        const fd = openSync(rollout, "r");
        try {
          const st = fstatSync(fd);
          startOffset = st.size;
          ino = st.ino;
          sig = prefix(fd, st.size);
        } finally {
          closeSync(fd);
        }
      } catch {
        // Not there yet: read from 0 once it is.
      }
    }
    this.#recs.set(id, {
      state: "attempt",
      thread,
      at: this.#now(),
      ...(head === undefined ? {} : { head }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
      ...(rollout ? { rollout } : {}),
      startOffset,
      scannedTo: startOffset,
      ...(ino === undefined ? {} : { ino }),
      ...(sig === undefined ? {} : { sig }),
    });
    if (this.#save()) return true;
    if (prev) this.#recs.set(id, prev);
    else this.#recs.delete(id);
    return false;
  }

  /** `codex queue` exited 0 (or, with `maybe`, was killed at its timeout). A taken record stays taken. */
  queued(id: string, maybe = false): void {
    const r = this.#recs.get(id);
    if (!r || r.state !== "attempt") return;
    r.state = "queued";
    if (maybe) r.maybe = true;
    this.#save();
  }

  /** `codex queue` failed: nothing was queued, so the attempt goes (a retry starts fresh). */
  drop(id: string): void {
    if (this.#recs.get(id)?.state !== "attempt") return;
    this.#recs.delete(id);
    this.#save();
  }

  /**
   * An interrupted attempt (a restart found it): whether the rollout, from
   * before the spawn to its end, holds the item. True marks it taken. False
   * means unknown (Codex's own queue store is not readable here): the caller
   * re-queues once, and a possible duplicate beats a silent loss.
   */
  reconcile(id: string): boolean {
    const r = this.#recs.get(id);
    if (!r || r.state !== "attempt" || r.head === undefined) return false;
    const found: string[] = [];
    this.#scan(id, r, found, Number.POSITIVE_INFINITY);
    if (!found.length) return false;
    r.state = "taken";
    this.#save();
    return true;
  }

  /** Reads each watched record's new rollout lines; acks what a turn took. */
  check(): void {
    if (!this.#recs.size) return;
    const now = this.#now();
    let changed = false;
    const taken: string[] = [];
    const was = new Map<string, number | undefined>();
    for (const [id, r] of this.#recs) {
      const ttl = r.ttlMs ?? this.opts.ttlMs ?? MAILBOX_RETAIN_MS;
      if (
        r.state !== "attempt" &&
        r.state !== "queued" &&
        now - r.at > 2 * ttl
      ) {
        this.#recs.delete(id);
        changed = true;
      } else if (
        (r.state === "attempt" || r.state === "queued") &&
        now - r.at > ttl
      ) {
        if (r.head !== undefined)
          this.opts.log?.(
            `codex ${id} was never taken by a turn within the retention window; no longer watched`,
          );
        r.state = "lost";
        changed = true;
      } else if (
        r.head !== undefined &&
        (r.state === "attempt" || r.state === "queued")
      ) {
        const found: string[] = [];
        const before = r.scannedTo;
        this.#scan(id, r, found, this.opts.scanBudget ?? TAKEN_SCAN_BUDGET);
        if (found.length) {
          was.set(id, before);
          r.state = "taken";
          taken.push(id);
          changed = true;
        } else if (r.scannedTo !== before) changed = true;
      }
    }
    // Read back before it is reported: only a saved `taken` acks.
    if (changed && !this.#save()) {
      for (const id of taken) {
        const r = this.#recs.get(id);
        if (r) {
          // Read again next pass, from where it was.
          r.state = "queued";
          r.scannedTo = was.get(id);
        }
      }
      return;
    }
    for (const id of taken) {
      try {
        this.opts.onTaken(id);
      } catch (e) {
        this.opts.log?.(
          `ack of taken ${id} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  #rollout(thread: string): string | undefined {
    return (
      threadRow(this.opts.home, thread)?.rollout_path ??
      globRollout(this.opts.home, thread)
    );
  }

  /** Scans forward from `scannedTo`, at most `budget` bytes; pushes `id` into `found` on a match. */
  #scan(id: string, r: TakenRecord, found: string[], budget: number): void {
    if (!r.rollout) {
      r.rollout = this.#rollout(r.thread);
      if (!r.rollout) return;
    }
    let fd: number;
    try {
      fd = openSync(r.rollout, "r");
    } catch {
      r.rollout = undefined; // moved: found again next time
      return;
    }
    try {
      const stat = fstatSync(fd);
      const size = stat.size;
      // A replaced file: another inode, or (Linux reuses inodes) another first line.
      const sig = prefix(fd, size);
      if (
        r.ino !== undefined &&
        (r.ino !== stat.ino ||
          (r.sig !== undefined && sig !== undefined && !samePrefix(r.sig, sig)))
      )
        r.scannedTo = 0;
      r.ino = stat.ino;
      // A file that was shorter than 512 bytes grows into a longer prefix.
      if (
        sig !== undefined &&
        (r.sig === undefined || sig.length > r.sig.length)
      )
        r.sig = sig;
      let from = r.scannedTo ?? r.startOffset ?? 0;
      if (from > size) from = 0; // truncated
      const limit = Math.min(size, from + budget);
      let done = readLines(fd, from, limit, false, (line) => {
        for (const text of userTexts(line))
          if (r.head !== undefined && startsWithHead(text, r.head)) {
            found.push(id);
            return true;
          }
        return false;
      });
      // One line longer than the budget has no end to stop at: step over it.
      if (done === from && limit < size && limit - from >= TAKEN_SCAN_BUDGET)
        done = limit;
      r.scannedTo = done;
    } finally {
      closeSync(fd);
    }
  }

  #load(): Record<string, TakenRecord> {
    try {
      const raw = JSON.parse(readFileSync(this.opts.file, "utf8")) as Record<
        string,
        Partial<TakenRecord>
      >;
      const out: Record<string, TakenRecord> = Object.create(null);
      const states = ["attempt", "queued", "taken", "lost"];
      for (const [id, p] of Object.entries(raw))
        if (
          typeof p?.thread === "string" &&
          typeof p.at === "number" &&
          typeof p.state === "string" &&
          states.includes(p.state) &&
          (p.head === undefined || typeof p.head === "string")
        )
          out[id] = {
            state: p.state as TakenRecord["state"],
            thread: p.thread,
            at: p.at,
            ...(p.head === undefined ? {} : { head: p.head }),
            ...(typeof p.ttlMs === "number" ? { ttlMs: p.ttlMs } : {}),
            ...(p.maybe === true ? { maybe: true as const } : {}),
            ...(typeof p.rollout === "string" ? { rollout: p.rollout } : {}),
            ...(typeof p.startOffset === "number"
              ? { startOffset: p.startOffset }
              : {}),
            ...(typeof p.scannedTo === "number"
              ? { scannedTo: p.scannedTo }
              : {}),
            ...(typeof p.ino === "number" ? { ino: p.ino } : {}),
            ...(typeof p.sig === "string" ? { sig: p.sig } : {}),
          };
      return out;
    } catch {
      return {};
    }
  }

  #save(): boolean {
    const tmp = `${this.opts.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#recs)), {
        mode: 0o600,
      });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.opts.file);
      return true;
    } catch (e) {
      this.opts.log?.(
        `ERROR: codex record list not saved (${e instanceof Error ? e.message : String(e)}); a restart forgets it`,
      );
      return false;
    }
  }
}
