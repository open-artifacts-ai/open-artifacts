import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { stripTerminalControls } from "@oa/bus-ipc";

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
  // Terminal controls (C0, C1, escape sequences), invisible and bidi format
  // characters and line separators never reach the file: one line per event.
  const s = stripTerminalControls(String(v))
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
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
  /**
   * The logs folder, checked on every call: a real folder (never a link) owned
   * by this user, opened by descriptor and made owner-only through it. Returns
   * its identity so the caller can tell a swap during the write.
   */
  const checkDir = async (
    dir: string,
  ): Promise<{ dev: number; ino: number }> => {
    const ls = await lstat(dir).catch(() => undefined);
    if (ls && ls.isSymbolicLink()) throw new Error("folder is a symlink");
    if (ls && !ls.isDirectory()) throw new Error("not a folder");
    if (!ls) await mkdir(dir, { recursive: true, mode: 0o700 });
    const dh = await open(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const st = await dh.stat();
      if (typeof process.getuid === "function" && st.uid !== process.getuid())
        throw new Error("folder is not yours");
      const again = await lstat(dir);
      if (
        again.isSymbolicLink() ||
        again.dev !== st.dev ||
        again.ino !== st.ino
      )
        throw new Error("folder changed");
      if ((st.mode & 0o777) !== 0o700) await dh.chmod(0o700);
      return { dev: st.dev, ino: st.ino };
    } finally {
      await dh.close();
    }
  };
  const sameDir = async (dir: string, id: { dev: number; ino: number }) => {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || st.dev !== id.dev || st.ino !== id.ino)
      throw new Error("folder changed");
  };
  /** Open without following a link, check it is a regular file, fchmod through the descriptor. */
  const openChecked = async (f: string, flags: number) => {
    const fh = await open(
      f,
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      // A symlink, a FIFO or a device is never used.
      if (!(await fh.stat()).isFile()) throw new Error("not a regular file");
      // Only when wrong: fchmod bumps ctime on every call.
      if (((await fh.stat()).mode & 0o777) !== 0o600) await fh.chmod(0o600);
      return fh;
    } catch (e) {
      await fh.close();
      throw e;
    }
  };
  const write = async (line: string): Promise<void> => {
    try {
      const dir = dirname(file);
      const id = await checkDir(dir);
      if (size === undefined) {
        size = 0;
        for (const f of [file, `${file}.1`]) {
          const st = await lstat(f).catch(() => undefined);
          if (!st) continue;
          const fh = await openChecked(f, constants.O_RDONLY);
          try {
            if (f === file) size = (await fh.stat()).size;
          } finally {
            await fh.close();
          }
        }
      }
      if (size > 0 && size + Buffer.byteLength(line) > max) {
        await sameDir(dir, id);
        await rename(file, `${file}.1`);
        size = 0;
      }
      // Accepted residual (#2304): a same-user double swap of the logs folder
      // (to a symlink and back) around this open can still land a line in the
      // target. It needs same-user write access to ~/.oa-bus, so it is not
      // closed here.
      const fh = await openChecked(
        file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      );
      try {
        // The folder is still the one checked: the file was opened inside it.
        await sameDir(dir, id);
        await fh.write(line);
      } finally {
        await fh.close();
      }
      size += Buffer.byteLength(line);
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
