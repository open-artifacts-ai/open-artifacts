import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { home } from "./config.ts";
import { sameDir } from "./global.ts";
import { readOwnFile } from "./own-file.ts";

/**
 * The user's namespace approvals, `<OA_BUS_HOME>/namespaces.json`:
 * `{"approved": [{"dir": "/real/path", "namespace": "name"}]}`. A
 * `.oa-bus.json` namespace that differs from the derived one counts only for
 * a directory listed here with exactly that namespace (#1525): a cloned repo
 * cannot move its agents into another team's namespace on its own.
 */
export const namespacesFile = (h = home()): string =>
  join(h, "namespaces.json");

export type Approval = { dir: string; namespace: string };

/** `error` completes "<file> …": why the file approves nothing. */
export type Approvals = { entries: Approval[]; error?: string };

/**
 * The approvals. None when the file is missing; none with `error` when it is
 * unreadable, malformed, or not safely ours (read strictly, as global.json:
 * a group-writable file is refused).
 */
export function readApprovals(file = namespacesFile()): Approvals {
  const own = readOwnFile(file);
  if (own.state === "none") return { entries: [] };
  if (own.state === "unsafe") return { entries: [], error: own.why };
  try {
    const raw = JSON.parse(own.text) as { approved?: unknown } | null;
    const list = raw?.approved;
    if (
      raw &&
      !Array.isArray(raw) &&
      Array.isArray(list) &&
      list.every(
        (e) =>
          e &&
          typeof e === "object" &&
          typeof e.dir === "string" &&
          isAbsolute(e.dir) &&
          typeof e.namespace === "string" &&
          e.namespace !== "",
      )
    )
      return {
        entries: list.map((e) => ({ dir: e.dir, namespace: e.namespace })),
      };
  } catch {}
  return { entries: [], error: "is not valid JSON" };
}

/** Whether `dir` (the directory holding the `.oa-bus.json`) is approved for exactly `namespace`, by identity. */
export function isApproved(
  dir: string,
  namespace: string,
  entries: readonly Approval[],
): boolean {
  return entries.some((e) => e.namespace === namespace && sameDir(e.dir, dir));
}

/** Replaces the approvals: 0600, written to a new file then renamed, never through a symlink. */
export function writeApprovals(entries: readonly Approval[], h = home()): void {
  mkdirSync(h, { recursive: true, mode: 0o700 });
  chmodSync(h, 0o700);
  const tmp = join(h, `.namespaces.json.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ approved: entries }, null, 2)}\n`);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, namespacesFile(h));
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}

/**
 * One line per approve or revoke in `<home>/logs/approvals.log` (0600,
 * appended): time, action, directory, namespace, and whether stdin was a terminal.
 */
export function logApproval(
  entry: {
    action: "approve" | "revoke";
    dir: string;
    namespace: string;
    tty: boolean;
  },
  h = home(),
  now = new Date(),
): void {
  const dir = join(h, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "approvals.log");
  const line = `${now.toISOString()} ${entry.action} dir=${JSON.stringify(entry.dir)} namespace=${JSON.stringify(entry.namespace)} tty=${entry.tty ? "yes" : "no"}\n`;
  appendFileSync(file, line, { mode: 0o600 });
  chmodSync(file, 0o600);
}
