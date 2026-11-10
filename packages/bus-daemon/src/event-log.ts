import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Rotate at about 1 MB; one old file (`.1`) is kept. */
export const EVENT_LOG_MAX_BYTES = 1_000_000;

/**
 * The fields an event may carry. Anything else (a body, a token, a proof, a
 * hash, file contents) is dropped, so a caller's mistake cannot reach the file.
 */
const FIELDS = new Set([
  "name",
  "ref",
  "thread",
  "agent",
  "ns",
  "kind",
  "pid",
  "reason",
  "code",
  "version",
  "state",
  "id",
]);

const MAX_VALUE = 120;

/** Lines waiting for the disk; past it, lines are dropped and counted. */
export const EVENT_LOG_MAX_PENDING = 1000;

export type EventFields = Record<string, string | number | boolean | undefined>;
export type EventLog = {
  (event: string, fields?: EventFields): void;
  /** Resolves when every queued write has settled (tests, shutdown). */
  flush: () => Promise<void>;
};

const one = (v: string | number | boolean): string => {
  // Control characters and newlines never reach the file: one line per event.
  const s = [...String(v)]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/ +/g, " ")
    .slice(0, MAX_VALUE);
  return /^[\w.:/@+-]+$/.test(s) ? s : JSON.stringify(s);
};

/** `2026-11-11T10:00:00.000Z event k=v ...`, allow-listed fields only. */
export function formatEvent(
  at: Date,
  event: string,
  fields: EventFields = {},
): string {
  const parts = [at.toISOString(), event.replace(/[^\w.-]/g, "_")];
  for (const [k, v] of Object.entries(fields))
    if (v !== undefined && FIELDS.has(k)) parts.push(`${k}=${one(v)}`);
  return parts.join(" ");
}

/**
 * The daemon's always-on event log: one line per event, appended off the
 * event loop. Best effort: a write or rotation error is swallowed, and a
 * caller never waits on the disk.
 */
export function createEventLog(
  file: string,
  opts: { maxBytes?: number; maxPending?: number; now?: () => Date } = {},
): EventLog {
  const max = opts.maxBytes ?? EVENT_LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  let chain: Promise<void> = Promise.resolve();
  let size: number | undefined;
  const write = async (line: string): Promise<void> => {
    try {
      if (size === undefined) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        size = await stat(file).then(
          (s) => s.size,
          () => 0,
        );
      }
      if (size > 0 && size + line.length > max) {
        await rename(file, `${file}.1`);
        size = 0;
      }
      await appendFile(file, line, { mode: 0o600 });
      size += line.length;
    } catch {
      // Best effort: re-measure on the next line.
      size = undefined;
    }
  };
  const maxPending = opts.maxPending ?? EVENT_LOG_MAX_PENDING;
  let pending = 0;
  let dropped = 0;
  const enqueue = (line: string): void => {
    pending++;
    chain = chain
      .then(() => write(line))
      .then(() => {
        pending--;
        // Drained: say once how many lines were lost meanwhile.
        if (pending === 0 && dropped > 0) {
          const n = dropped;
          dropped = 0;
          enqueue(`${formatEvent(now(), "events_dropped", {})} n=${n}\n`);
        }
      });
  };
  const log = ((event: string, fields?: EventFields) => {
    try {
      const line = `${formatEvent(now(), event, fields)}\n`;
      if (pending >= maxPending) dropped++;
      else enqueue(line);
    } catch {}
  }) as EventLog;
  log.flush = async () => {
    // The drain line is queued from inside the chain: wait until it settles.
    let c: Promise<void>;
    do {
      c = chain;
      await c;
    } while (c !== chain);
  };
  return log;
}
