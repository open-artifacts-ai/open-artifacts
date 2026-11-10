import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  BUS_CMD,
  type BusConfig,
  BusConfigSchema,
  mergeConfigs,
  namespaceFrom,
  normalizeRemote,
} from "@oa/bus-protocol";
import {
  approveCommand,
  ConfigIssues,
  configIssue,
  configPaths,
} from "./config-issues.ts";
import { globalFile, isGlobalDir, readGlobalDirs, sameDir } from "./global.ts";
import {
  isApproved,
  namespacesFile,
  readApprovals,
  readRemotes,
  remotesFile,
  writeRemotes,
} from "./namespaces.ts";
import { type GroupCheck, readOwnFile } from "./own-file.ts";

export type Namespace = {
  namespace: string;
  global: boolean;
  source: "config" | "git" | "dir" | "cwd";
};

export type NamespaceDeps = {
  gitRemote?: (dir: string) => string | null;
  gitRoot?: (dir: string) => string | null;
  /** The shared git dir (`git rev-parse --git-common-dir`); worktrees of one repo share it. */
  gitCommonDir?: (dir: string) => string | null;
  log?: (msg: string) => void;
  /** Owner a config file must have; defaults to this process's uid. */
  uid?: number;
  /** A cwd that no longer exists is used unresolved instead of throwing. */
  allowMissing?: boolean;
  /** The user's allowlist; default `<OA_BUS_HOME>/global.json`. */
  globalFile?: string;
  /** The user's namespace approvals; default `<OA_BUS_HOME>/namespaces.json`. */
  namespacesFile?: string;
  /**
   * The file recording each git folder's first remote-derived namespace
   * (#1570). Unset: no pinning, so a caller opts in (the daemon, doctor, link).
   */
  remotesFile?: string;
  /** With `remotesFile`: false reads the record but never writes it (doctor). */
  recordRemote?: boolean;
  /** Collects the config files refused or noted, for status, doctor and self. */
  issues?: ConfigIssues;
  /** Tests inject the group check (which group is the user's private one). */
  group?: GroupCheck;
};

const warned = new Set<string>();

/** Logs `msg` once per key for the life of the process. */
const once = (deps: NamespaceDeps, key: string, msg: string) => {
  if (warned.has(key)) return;
  warned.add(key);
  deps.log?.(msg);
};

/**
 * The namespace: every `.oa-bus.json` from the real cwd up (nearest wins per
 * key); else the shared fallback chain. Global comes only from the user's
 * allowlist; a `global` in `.oa-bus.json` is ignored. Throws if cwd does not
 * resolve, unless allowMissing.
 */
export function resolveNamespace(
  start: string,
  deps: NamespaceDeps = {},
): Namespace {
  let cwd: string;
  let missing = false;
  try {
    cwd = realpathSync(start);
  } catch (e) {
    if (!deps.allowMissing) throw e;
    cwd = resolve(start);
    missing = true;
    if (!warned.has(cwd)) {
      warned.add(cwd);
      deps.log?.(`${cwd} does not resolve; using it as given`);
    }
  }
  const { cfg, asked, nsFile } = readConfigs(cwd, deps);
  const global = !missing && allowlisted(cwd, deps);
  // A repo anyone can write to must not widen what its agents see.
  if (!global)
    for (const file of asked)
      once(
        deps,
        `global:${file}`,
        `ignoring global in ${file}: only \`${BUS_CMD} global add\` makes a directory global`,
      );
  const remoteUrl = (deps.gitRemote ?? gitRemote)(cwd);
  const root = (deps.gitRoot ?? gitRoot)(cwd);
  let derived = namespaceFrom({
    remoteUrl,
    gitRootName: root ? basename(root) : null,
    cwd,
  });
  const source =
    remoteUrl && normalizeRemote(remoteUrl) ? "git" : root ? "dir" : "cwd";
  // #1570: the first namespace a repo gets is recorded whatever its source (a folder with no
  // origin yet included); a later one that differs needs the user's approval. A namespace the
  // user approved for a .oa-bus.json wins anyway, so it leaves the pin quiet.
  if (root && deps.remotesFile && !missing) {
    const cfgWins =
      Boolean(cfg.namespace && nsFile) &&
      cfg.namespace !== derived &&
      approved(nsFile as string, cfg.namespace as string, deps);
    derived = pinRemote(root, cwd, derived, deps, cfgWins);
  }
  const fallback: Namespace = { namespace: derived, global, source };
  if (!cfg.namespace || !nsFile) return fallback;
  // The same as the derived namespace: nothing to approve.
  if (cfg.namespace === derived) {
    deps.issues?.setPending(nsFile, deps.uid ?? process.getuid?.(), undefined);
    return fallback;
  }
  if (approved(nsFile, cfg.namespace, deps))
    return { namespace: cfg.namespace, global, source: "config" };
  // A repo's own file must not move its agents into another namespace.
  const dir = dirname(nsFile);
  deps.issues?.setPending(nsFile, deps.uid ?? process.getuid?.(), {
    file: nsFile,
    dir,
    namespace: cfg.namespace,
    approvals: deps.namespacesFile,
  });
  once(
    deps,
    `ns:${nsFile}:${cfg.namespace}`,
    `ignoring namespace "${cfg.namespace}" in ${nsFile}: not approved; run: ${approveCommand(dir)}`,
  );
  return fallback;
}

/**
 * The namespace a git folder gets from its remote. The first one seen is
 * recorded without a prompt; a later one that differs is used only when the
 * user approved it for the folder (as #1525), else the recorded one stays and
 * the change waits as pending.
 */
function pinRemote(
  rootPath: string,
  cwd: string,
  derived: string,
  deps: NamespaceDeps,
  quiet: boolean,
): string {
  const uid = deps.uid ?? process.getuid?.();
  const recordFile = deps.remotesFile ?? remotesFile();
  const root = recordRoot(rootPath, cwd, deps);
  const marker = join(root, ".git");
  const list = readRemotes(recordFile);
  if (list.error) {
    // Kept visible as a config issue in doctor and status (inspectRemotes).
    once(
      deps,
      `remotes:${recordFile}:${list.error}`,
      `${recordFile} ${list.error}: remotes are not pinned`,
    );
    return derived;
  }
  const prior = list.entries.find((e) => sameDir(e.dir, root));
  const write = (entries: typeof list.entries) => {
    if (deps.recordRemote === false) return;
    try {
      // A deleted checkout's entry must not hold a later one at that path.
      writeRemotes(
        entries.filter((e) => e === prior || existsSync(e.dir)),
        dirname(recordFile),
      );
    } catch (e) {
      once(
        deps,
        `remotes-write:${recordFile}`,
        `cannot write ${recordFile}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  if (!prior) {
    write([...list.entries, { dir: root, namespace: derived }]);
    return derived;
  }
  if (prior.namespace === derived) {
    deps.issues?.setPending(marker, uid, undefined);
    return derived;
  }
  if (quiet) {
    deps.issues?.setPending(marker, uid, undefined);
    return derived;
  }
  if (approved(join(root, "x"), derived, deps)) {
    write(
      list.entries.map((e) => (e === prior ? { ...e, namespace: derived } : e)),
    );
    deps.issues?.setPending(marker, uid, undefined);
    return derived;
  }
  deps.issues?.setPending(marker, uid, {
    file: marker,
    dir: root,
    namespace: derived,
    approvals: deps.namespacesFile,
    reason: `now derives namespace "${derived}" from its git remote, but it first got "${prior.namespace}", and you have not approved the change`,
    recorded: prior.namespace,
  });
  once(
    deps,
    `remote:${root}:${derived}`,
    `keeping namespace "${prior.namespace}" for ${root}: its git remote now gives "${derived}", not approved; run: ${approveCommand(root)}`,
  );
  return prior.namespace;
}

/**
 * The folder a repo's record is keyed by: the work tree that holds the shared
 * git dir, so every worktree of one repo shares one record (a new worktree
 * cannot start a fresh one). Falls back to the checkout's own root.
 */
function recordRoot(root: string, cwd: string, deps: NamespaceDeps): string {
  let common: string | null = null;
  if (deps.gitCommonDir) common = deps.gitCommonDir(cwd);
  else if (!deps.gitRoot) common = gitCommonDir(cwd);
  let real = root;
  try {
    real = realpathSync(root);
  } catch {}
  if (!common) return real;
  try {
    const c = realpathSync(resolve(cwd, common));
    return basename(c) === ".git" ? dirname(c) : c;
  } catch {
    return real;
  }
}

/** The record key of the repo `dir` is in; undefined outside git. For `self`. */
export function gitRecordRoot(
  dir: string,
  deps: Pick<NamespaceDeps, "gitRoot" | "gitCommonDir"> = {},
): string | undefined {
  const root = (deps.gitRoot ?? gitRoot)(dir);
  return root ? recordRoot(root, dir, deps) : undefined;
}

/**
 * The git remote change of the folder `dir` is in that waits for approval
 * (#1570): the repo root, the namespace its remote now gives and the one it
 * first got. Reads only; nothing is recorded.
 */
export function remoteChange(
  dir: string,
  deps: Pick<
    NamespaceDeps,
    "remotesFile" | "namespacesFile" | "gitRemote" | "gitRoot" | "gitCommonDir"
  >,
): { root: string; namespace: string; recorded: string } | undefined {
  const issues = new ConfigIssues();
  try {
    resolveNamespace(dir, { ...deps, issues, recordRemote: false });
  } catch {
    return undefined;
  }
  const p = issues.remoteChanges()[0];
  return p?.recorded === undefined
    ? undefined
    : { root: p.dir, namespace: p.namespace, recorded: p.recorded };
}

/** Whether the user approved `namespace` for the directory holding `file`. */
function approved(file: string, namespace: string, deps: NamespaceDeps) {
  const path = deps.namespacesFile ?? namespacesFile();
  const list = readApprovals(path);
  if (list.error)
    once(
      deps,
      `approvals:${path}:${list.error}`,
      `${path} ${list.error}: no namespace is approved`,
    );
  return isApproved(dirname(file), namespace, list.entries);
}

/** Whether `cwd` (a realpath) is in the user's allowlist, by directory identity. */
function allowlisted(cwd: string, deps: NamespaceDeps): boolean {
  const file = deps.globalFile ?? globalFile();
  const list = readGlobalDirs(file);
  if (list.error)
    once(
      deps,
      `allowlist:${file}:${list.error}`,
      `${file} ${list.error}: no directory is global`,
    );
  if (list.dirs.length === 0) return false;
  try {
    return isGlobalDir(cwd, list.dirs, (entry) =>
      once(
        deps,
        `stale:${file}:${entry}`,
        `ignoring ${entry} in ${file}: its path is no longer real (a symlink now stands in it)`,
      ),
    );
  } catch {
    return false;
  }
}

/**
 * Every usable `.oa-bus.json` from `cwd` (a realpath) up, merged nearest
 * first, and the files that asked for global. Each is read with readOwnFile:
 * a symlink, a FIFO, another user's file or one others can write is skipped.
 */
function readConfigs(
  cwd: string,
  deps: NamespaceDeps,
): { cfg: BusConfig; asked: string[]; nsFile: string | undefined } {
  const uid = deps.uid ?? process.getuid?.();
  const configs: BusConfig[] = [];
  const asked: string[] = [];
  /** The nearest file that sets a namespace: the one the user approves. */
  let nsFile: string | undefined;
  for (const file of configPaths(cwd)) {
    const own = readOwnFile(file, uid, {
      allowGroupWrite: true,
      ...(deps.group ? { group: deps.group } : {}),
    });
    if (own.state === "unsafe")
      // Another user could plant one in a shared parent such as /tmp.
      once(deps, file, `ignoring ${file}: it ${own.why}`);
    let valid = true;
    if (own.state === "ok") {
      if (own.note) once(deps, `note:${file}`, `using ${file}: it ${own.note}`);
      let parsed: ReturnType<typeof BusConfigSchema.safeParse> | undefined;
      try {
        parsed = BusConfigSchema.safeParse(JSON.parse(own.text));
      } catch {}
      if (parsed?.success) {
        configs.push(parsed.data);
        if (parsed.data.global === true) asked.push(file);
        if (parsed.data.namespace !== undefined && nsFile === undefined)
          nsFile = file;
      } else {
        valid = false;
        deps.log?.(`ignoring invalid ${file}`);
      }
    }
    deps.issues?.set(file, uid, configIssue(file, own, valid), deps.group);
  }
  return { cfg: mergeConfigs(configs), asked, nsFile };
}

/**
 * The merged `.oa-bus.json` that applies at `dir`, read as the daemon reads
 * it; `{}` when `dir` does not resolve. doctor uses it to explain an ignored
 * `global`.
 */
export function nearestConfig(
  dir: string,
  deps: Pick<NamespaceDeps, "uid" | "log"> = {},
): BusConfig {
  try {
    return readConfigs(realpathSync(dir), deps).cfg;
  } catch {
    return {};
  }
}

const git = (cwd: string, args: string[]): string | null => {
  try {
    return (
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
};
const gitRemote = (cwd: string) => git(cwd, ["remote", "get-url", "origin"]);
const gitRoot = (cwd: string) => git(cwd, ["rev-parse", "--show-toplevel"]);
const gitCommonDir = (cwd: string) =>
  git(cwd, ["rev-parse", "--git-common-dir"]);
