import {
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { MAILBOX_RETAIN_MS } from "@oa/bus-protocol";
import { globRollout, readLines, threadRow } from "./codex-attest.ts";

/** What a restart reads of a rollout when it has no offset: its last 2 MB. */
export const TAKEN_TAIL_CAP = 2 * 1024 * 1024;

/** A queued item waiting for a turn to take it. */
export type TakenPending = {
  thread: string;
  /** When it was queued (ms). */
  at: number;
  /** The first line of the text the transport queued; a user item is "taken" only if it starts with it. */
  head: string;
};

export type TakenOptions = {
  /** Codex's home, read only for the thread's rollout path. */
  home: string;
  /** TakenPending ids, kept on disk so a restart keeps watching. */
  file: string;
  /** A turn took `id`: the transport vouches for it (late ack). */
  onTaken: (id: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** Past this, a watch is dropped silently; default the hub's mailbox retention. */
  ttlMs?: number;
  tailCap?: number;
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
  readonly #pending = new Map<string, TakenPending>();
  readonly #reads = new Map<string, { rollout: string; offset: number }>();
  readonly #now: () => number;

  constructor(private readonly opts: TakenOptions) {
    this.#now = opts.now ?? Date.now;
    for (const [id, p] of Object.entries(this.#load()))
      this.#pending.set(id, p);
  }

  has(id: string): boolean {
    return this.#pending.has(id);
  }

  size(): number {
    return this.#pending.size;
  }

  watch(id: string, thread: string, head: string): void {
    this.#pending.set(id, { thread, head, at: this.#now() });
    this.#save();
  }

  /** Reads each watched thread's new rollout lines; acks what a turn took. */
  check(): void {
    if (!this.#pending.size) return;
    const cutoff = this.#now() - (this.opts.ttlMs ?? MAILBOX_RETAIN_MS);
    let changed = false;
    for (const [id, p] of this.#pending)
      if (p.at < cutoff) {
        this.#pending.delete(id);
        changed = true;
        this.opts.log?.(
          `codex ${id} was never taken by a turn within the retention window; no longer watched`,
        );
      }
    const taken: string[] = [];
    for (const thread of new Set(
      [...this.#pending.values()].map((p) => p.thread),
    ))
      this.#scan(thread, taken);
    for (const id of taken) {
      this.#pending.delete(id);
      changed = true;
    }
    if (changed) this.#save();
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

  #scan(thread: string, taken: string[]): void {
    let st = this.#reads.get(thread);
    if (!st) {
      const rollout = this.#rollout(thread);
      if (!rollout) return;
      st = { rollout, offset: -1 };
      this.#reads.set(thread, st);
    }
    let fd: number;
    try {
      fd = openSync(st.rollout, "r");
    } catch {
      this.#reads.delete(thread); // moved: found again next time
      return;
    }
    try {
      const size = fstatSync(fd).size;
      let skipFirst = false;
      if (st.offset < 0 || st.offset > size) {
        st.offset = Math.max(0, size - (this.opts.tailCap ?? TAKEN_TAIL_CAP));
        skipFirst = st.offset > 0;
      }
      st.offset = readLines(fd, st.offset, size, skipFirst, (line) => {
        for (const text of userTexts(line))
          for (const [id, p] of this.#pending)
            if (
              p.thread === thread &&
              !taken.includes(id) &&
              startsWithHead(text, p.head)
            )
              taken.push(id);
        return false;
      });
    } finally {
      closeSync(fd);
    }
  }

  #load(): Record<string, TakenPending> {
    try {
      const raw = JSON.parse(readFileSync(this.opts.file, "utf8")) as Record<
        string,
        Partial<TakenPending>
      >;
      const out: Record<string, TakenPending> = Object.create(null);
      for (const [id, p] of Object.entries(raw))
        if (
          typeof p?.thread === "string" &&
          typeof p.head === "string" &&
          typeof p.at === "number"
        )
          out[id] = { thread: p.thread, head: p.head, at: p.at };
      return out;
    } catch {
      return {};
    }
  }

  #save(): void {
    const tmp = `${this.opts.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#pending)), {
        mode: 0o600,
      });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.opts.file);
    } catch (e) {
      this.opts.log?.(
        `ERROR: codex watch list not saved (${e instanceof Error ? e.message : String(e)}); a restart forgets it`,
      );
    }
  }
}
