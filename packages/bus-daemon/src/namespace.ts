import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
  type ConfigIssues,
  configIssue,
  configPaths,
} from "./config-issues.ts";
import { globalFile, isGlobalDir, readGlobalDirs } from "./global.ts";
import { isApproved, namespacesFile, readApprovals } from "./namespaces.ts";
import { type GroupCheck, readOwnFile } from "./own-file.ts";

export type Namespace = {
  namespace: string;
  global: boolean;
  source: "config" | "git" | "dir" | "cwd";
};

export type NamespaceDeps = {
  gitRemote?: (dir: string) => string | null;
  gitRoot?: (dir: string) => string | null;
  log?: (msg: string) => void;
  /** Owner a config file must have; defaults to this process's uid. */
  uid?: number;
  /** A cwd that no longer exists is used unresolved instead of throwing. */
  allowMissing?: boolean;
  /** The user's allowlist; default `<OA_BUS_HOME>/global.json`. */
  globalFile?: string;
  /** The user's namespace approvals; default `<OA_BUS_HOME>/namespaces.json`. */
  namespacesFile?: string;
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
  const derived = namespaceFrom({
    remoteUrl,
    gitRootName: root ? basename(root) : null,
    cwd,
  });
  const source =
    remoteUrl && normalizeRemote(remoteUrl) ? "git" : root ? "dir" : "cwd";
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
