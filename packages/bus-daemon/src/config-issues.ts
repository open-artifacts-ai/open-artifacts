import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigFile } from "@oa/bus-ipc";
import { BusConfigSchema, CONFIG_FILE } from "@oa/bus-protocol";
import { globalFile, readGlobalDirs } from "./global.ts";
import { resolveNamespace } from "./namespace.ts";
import { isApproved, namespacesFile, readApprovals } from "./namespaces.ts";
import { type GroupCheck, type OwnFile, readOwnFile } from "./own-file.ts";

export type { ConfigFile };

/** POSIX single quotes: nothing inside is expanded; a quote becomes '\\''. */
export const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The exact step that clears `why` for `file`. The path is quoted: it may come from a clone. */
function fixFor(file: string, why: string): string {
  const q = shq(file);
  if (why === "is writable by everyone") return `run chmod o-w ${q}`;
  if (why === "is writable by others") return `run chmod go-w ${q}`;
  if (why === "is writable by a group others share")
    return `run chmod g-w ${q}`;
  if (why === "belongs to another user")
    return `remove it (rm ${q}) or take it over (chown "$USER" ${q})`;
  if (why === "is a symlink" || why === "is not a regular file")
    return `remove it (rm ${q}), then save a regular file there`;
  if (why.startsWith("cannot be read")) return `run chmod u+r ${q}`;
  return `fix or remove ${q}`;
}

/** One `.oa-bus.json` the daemon read: refused, noted, or fine (undefined). */
export function configIssue(
  file: string,
  own: OwnFile,
  valid = true,
): ConfigFile | undefined {
  if (own.state === "unsafe")
    return {
      file,
      state: "refused",
      reason: own.why,
      fix: fixFor(file, own.why),
    };
  if (own.state === "ok" && !valid)
    return {
      file,
      state: "refused",
      reason: "is not a valid .oa-bus.json",
      fix: `edit ${shq(file)} to valid JSON, or remove it`,
    };
  if (own.state === "ok" && own.note)
    return {
      file,
      state: "noted",
      reason: own.note,
      fix: `optional: run chmod g-w ${shq(file)}`,
    };
  return undefined;
}

/** A `.oa-bus.json` namespace waiting for the user's approval (#1525). */
export type PendingNamespace = {
  file: string;
  dir: string;
  namespace: string;
  /** The approvals file consulted; default `<OA_BUS_HOME>/namespaces.json`. */
  approvals?: string | undefined;
  /** #1570: set for a git remote that changed; replaces the `.oa-bus.json` wording. */
  reason?: string;
  /** #1570: the namespace the folder first got; with `reason`, `file` is its `.git`. */
  recorded?: string;
};

/** The exact step that approves `dir`'s namespace. */
export const approveCommand = (dir: string): string =>
  `oa-bus namespace approve ${shq(dir)}`;

/** The pending entry as listed, whatever the file says now. */
export const pendingIssue = (p: PendingNamespace): ConfigFile => ({
  file: p.file,
  state: "pending",
  reason:
    p.reason ?? `sets namespace "${p.namespace}", which you have not approved`,
  fix: approveCommand(p.dir),
});

/** Whether `p` still waits: the file still asks for it and no approval covers it. */
function stillPending(p: PendingNamespace, uid: number | undefined): boolean {
  // A git remote change has no file to re-read: it waits until approved or cleared by the next resolve.
  if (p.recorded !== undefined)
    return !isApproved(p.dir, p.namespace, readApprovals(p.approvals).entries);
  const own = readOwnFile(p.file, uid, { allowGroupWrite: true });
  if (own.state !== "ok") return false;
  try {
    const parsed = BusConfigSchema.safeParse(JSON.parse(own.text));
    if (!parsed.success || parsed.data.namespace !== p.namespace) return false;
  } catch {
    return false;
  }
  return !isApproved(p.dir, p.namespace, readApprovals(p.approvals).entries);
}

/** Whether `text` is a `.oa-bus.json` the daemon would use. */
export function isValidConfig(text: string): boolean {
  try {
    return BusConfigSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/** Reads `file` as the daemon reads a `.oa-bus.json`. */
export function inspectConfig(
  file: string,
  uid: number | undefined,
  group?: GroupCheck,
): ConfigFile | undefined {
  const own = readOwnFile(file, uid, {
    allowGroupWrite: true,
    ...(group ? { group } : {}),
  });
  return configIssue(file, own, own.state !== "ok" || isValidConfig(own.text));
}

/** The allowlist, read as the daemon reads it (strict: group-writable is refused). */
export function inspectGlobal(file = globalFile()): ConfigFile | undefined {
  const { error } = readGlobalDirs(file);
  if (error === undefined) return undefined;
  return {
    file,
    state: "refused",
    reason: error,
    fix:
      error === "is not valid JSON"
        ? `remove it (rm ${shq(file)}), then run oa-bus global add <dir> again`
        : fixFor(file, error),
  };
}

/** The approvals file, read as the daemon reads it (strict, as global.json). */
export function inspectApprovals(
  file = namespacesFile(),
): ConfigFile | undefined {
  const { error } = readApprovals(file);
  if (error === undefined) return undefined;
  return {
    file,
    state: "refused",
    reason: error,
    fix:
      error === "is not valid JSON"
        ? `remove it (rm ${shq(file)}), then run oa-bus namespace approve <dir> again`
        : fixFor(file, error),
  };
}

/**
 * The `.oa-bus.json` files that were refused or noted, kept by path. A
 * namespace read records what it saw; `list` re-reads each, so a fixed file
 * drops off.
 */
export class ConfigIssues {
  #files = new Map<
    string,
    { uid: number | undefined; group?: GroupCheck | undefined }
  >();

  /** Records the result of reading `file` (undefined: it is fine now). */
  set(
    file: string,
    uid: number | undefined,
    issue: ConfigFile | undefined,
    group?: GroupCheck,
  ) {
    if (issue) this.#files.set(file, { uid, group });
    else this.#files.delete(file);
  }

  #pending = new Map<
    string,
    { p: PendingNamespace; uid: number | undefined }
  >();

  /** Records a namespace waiting for approval, or clears it (undefined). */
  setPending(
    file: string,
    uid: number | undefined,
    pending: PendingNamespace | undefined,
  ) {
    if (pending) this.#pending.set(file, { p: pending, uid });
    else this.#pending.delete(file);
  }

  /** The git remote changes waiting for approval (#1570). */
  remoteChanges(): PendingNamespace[] {
    return [...this.#pending.values()]
      .map((e) => e.p)
      .filter((p) => p.recorded !== undefined);
  }

  /** Every tracked file, re-read now; `within` keeps only those at these paths. */
  list(
    within?: ReadonlySet<string>,
    opts: { pending?: boolean } = {},
  ): ConfigFile[] {
    const out: ConfigFile[] = [];
    for (const [file, { p, uid }] of [...this.#pending]) {
      if (within && !within.has(file)) continue;
      if (stillPending(p, uid)) {
        if (opts.pending) out.push(pendingIssue(p));
      } else this.#pending.delete(file);
    }
    for (const [file, { uid, group }] of [...this.#files]) {
      if (within && !within.has(file)) continue;
      const issue = inspectConfig(file, uid, group);
      if (issue) out.push(issue);
      else this.#files.delete(file);
    }
    return out;
  }
}

/**
 * Every refused or noted config file that applies at `cwd`: each
 * `.oa-bus.json` from the real cwd up, then the allowlist. For `doctor`,
 * which reads without a daemon.
 */
export function scanConfigFiles(
  cwd: string,
  opts: {
    uid?: number;
    globalFile?: string;
    namespacesFile?: string;
    remotesFile?: string;
    group?: GroupCheck;
    gitRemote?: (dir: string) => string | null;
    gitRoot?: (dir: string) => string | null;
  } = {},
): ConfigFile[] {
  const uid = opts.uid ?? process.getuid?.();
  const out: ConfigFile[] = [];
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  for (const file of configPaths(real)) {
    const issue = inspectConfig(file, uid, opts.group);
    if (issue) out.push(issue);
  }
  // A namespace the user has not approved: resolved as the daemon resolves it.
  const seen = new ConfigIssues();
  try {
    resolveNamespace(real, {
      issues: seen,
      allowMissing: true,
      ...(opts.uid === undefined ? {} : { uid: opts.uid }),
      ...(opts.group ? { group: opts.group } : {}),
      ...(opts.namespacesFile ? { namespacesFile: opts.namespacesFile } : {}),
      ...(opts.remotesFile
        ? { remotesFile: opts.remotesFile, recordRemote: false }
        : {}),
      ...(opts.gitRemote ? { gitRemote: opts.gitRemote } : {}),
      ...(opts.gitRoot ? { gitRoot: opts.gitRoot } : {}),
    });
  } catch {}
  out.push(
    ...seen
      .list(undefined, { pending: true })
      .filter((f) => f.state === "pending"),
  );
  const a = inspectApprovals(opts.namespacesFile);
  if (a) out.push(a);
  const g = inspectGlobal(opts.globalFile);
  if (g) out.push(g);
  return out;
}

/**
 * Every `.oa-bus.json` path the daemon reads for a session in `cwd` (a
 * realpath), nearest first. One walker for the daemon and doctor.
 */
export function configPaths(cwd: string): string[] {
  const out: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    out.push(join(dir, CONFIG_FILE));
    if (dirname(dir) === dir) return out;
  }
}
