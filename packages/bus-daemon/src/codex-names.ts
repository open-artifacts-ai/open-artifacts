import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { type GroupCheck, ownGroup } from "./own-file.ts";

/** Most of `session_index.jsonl` read per call: the latest entries are at the end. */
export const CODEX_INDEX_MAX_BYTES = 1024 * 1024;

export type CodexThreadName = { name: string; chosen: boolean };

/**
 * Codex records thread names, including automatic titles, in
 * `<codex home>/session_index.jsonl`. The latest entry for an id wins.
 * A name is chosen when it differs from the first name visible in the read. Only
 * that file is read, never a rollout or a session. The read is bounded (the
 * last 1 MB), a partial first line, a bad line or a nameless entry is skipped,
 * and a missing file (an older Codex) is no names, never an error.
 *
 * The file is opened as own-file.ts does: never through a symlink, never
 * blocking (a FIFO cannot hang the daemon). It must be a regular file owned
 * by us, not world-writable, and group-writable only in our private group
 * (#1527). Any refusal is no names, never an error.
 */
export const codexThreadNames = (
  home: string,
  opts: { uid?: number | undefined; group?: GroupCheck } = {},
): Map<string, CodexThreadName> => {
  const uid = "uid" in opts ? opts.uid : process.getuid?.();
  const names = new Map<string, CodexThreadName>();
  let fd: number;
  try {
    fd = openSync(
      join(home, "session_index.jsonl"),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return names;
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return names;
    if (uid !== undefined && st.uid !== uid) return names;
    if (st.mode & 0o002) return names;
    if (st.mode & 0o020) {
      const g = opts.group ?? ownGroup();
      if (st.gid !== g.gid || !g.isPrivate(st.gid)) return names;
    }
    const len = Math.min(st.size, CODEX_INDEX_MAX_BYTES);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, st.size - len + got);
      if (n <= 0) break;
      got += n;
    }
    text = buf.subarray(0, got).toString("utf8");
    // A read that began mid-file starts in the middle of a line: drop it.
    if (st.size > len) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return names;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  const firstNames = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o !== "object" || o === null) continue;
    const { id, thread_name } = o as { id?: unknown; thread_name?: unknown };
    if (typeof id !== "string" || id === "") continue;
    // The latest entry wins, so a cleared name clears it.
    const name = typeof thread_name === "string" ? thread_name.trim() : "";
    if (name === "") {
      names.delete(id);
      continue;
    }
    const first = firstNames.get(id) ?? name;
    firstNames.set(id, first);
    names.set(id, { name, chosen: name !== first });
  }
  return names;
};
