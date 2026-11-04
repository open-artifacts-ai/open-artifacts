import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type BusConfig,
  BusConfigSchema,
  CONFIG_FILE,
  mergeConfigs,
  namespaceFrom,
  normalizeRemote,
} from "@oa/bus-protocol";
import { globalFile, isGlobalDir, readGlobalDirs } from "./global.ts";
import { readOwnFile } from "./own-file.ts";

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
  const { cfg, asked } = readConfigs(cwd, deps);
  const global = !missing && allowlisted(cwd, deps);
  // A repo anyone can write to must not widen what its agents see.
  if (!global)
    for (const file of asked)
      once(
        deps,
        `global:${file}`,
        `ignoring global in ${file}: only \`npx @open-artifacts/bus global add\` makes a directory global`,
      );
  if (cfg.namespace)
    return { namespace: cfg.namespace, global, source: "config" };

  const remoteUrl = (deps.gitRemote ?? gitRemote)(cwd);
  const root = (deps.gitRoot ?? gitRoot)(cwd);
  const namespace = namespaceFrom({
    remoteUrl,
    gitRootName: root ? basename(root) : null,
    cwd,
  });
  const source =
    remoteUrl && normalizeRemote(remoteUrl) ? "git" : root ? "dir" : "cwd";
  return { namespace, global, source };
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
): { cfg: BusConfig; asked: string[] } {
  const uid = deps.uid ?? process.getuid?.();
  const configs: BusConfig[] = [];
  const asked: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, CONFIG_FILE);
    const own = readOwnFile(file, uid);
    if (own.state === "unsafe")
      // Another user could plant one in a shared parent such as /tmp.
      once(deps, file, `ignoring ${file}: it ${own.why}`);
    if (own.state === "ok") {
      let parsed: ReturnType<typeof BusConfigSchema.safeParse> | undefined;
      try {
        parsed = BusConfigSchema.safeParse(JSON.parse(own.text));
      } catch {}
      if (parsed?.success) {
        configs.push(parsed.data);
        if (parsed.data.global === true) asked.push(file);
      } else deps.log?.(`ignoring invalid ${file}`);
    }
    if (dirname(dir) === dir) break;
  }
  return { cfg: mergeConfigs(configs), asked };
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
