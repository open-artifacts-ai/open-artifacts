import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * msg_ids Claude is holding for the user, kept on disk so a restarted daemon
 * never injects a second copy. Entries older than the hold window are pruned.
 */
export class HeldStore {
  readonly #ttlMs: number;
  readonly #now: () => number;
  constructor(
    private readonly file: string,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#ttlMs = opts.ttlMs ?? 3_600_000;
    this.#now = opts.now ?? Date.now;
  }

  has(msgId: string): boolean {
    return msgId in this.#read();
  }

  add(msgId: string): void {
    this.#write({ ...this.#read(), [msgId]: this.#now() });
  }

  delete(msgId: string): void {
    const all = this.#read();
    if (!(msgId in all)) return;
    delete all[msgId];
    this.#write(all);
  }

  #read(): Record<string, number> {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
    const out: Record<string, number> = Object.create(null);
    if (!raw || typeof raw !== "object") return out;
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, at] of Object.entries(raw))
      if (typeof at === "number" && at >= cutoff) out[id] = at;
    return out;
  }

  #write(all: Record<string, number>): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
