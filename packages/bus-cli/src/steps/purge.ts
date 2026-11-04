import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shortSocketDir, unsafeSocketDir } from "@oa/bus-adapter-claude-code";

/** Files Open Artifacts bus writes at the top of its home. */
const FILES = [
  "machine.json",
  "install.json",
  "daemon.sock",
  "sent.json",
  "claude-held.json",
  "claude-held.injected.json",
  "opencode-uncertain.json",
  "revoked",
];
/** Leftovers of an interrupted atomic write or socket close. */
const TEMP = [
  /^\.machine\.json\.[0-9a-f]+\.tmp$/,
  /^(install|sent|claude-held(\.injected)?|opencode-uncertain)\.json\.\d+\.tmp$/,
  // The adapters' atomic writes: <file>.<pid>.<hex>.tmp.
  /^install\.json\.\d+\.[0-9a-f]+\.tmp$/,
  /^daemon\.sock\.keep-\d+$/,
];
/**
 * Folders Open Artifacts bus creates, and what in them is the bus's. A folder goes only
 * once that leaves it empty; anything else in it stays.
 */
const FOLDERS: {
  path: string;
  ours: (name: string, path: string) => boolean;
}[] = [
  // The CLI copy the service runs: install replaces it whole.
  { path: "bin", ours: () => true },
  { path: "logs", ours: (n) => /^daemon(\.err)?\.log(\.\d+)?$/.test(n) },
  { path: "integrations/opencode", ours: (n) => n === "oa_bus" },
  { path: "integrations", ours: () => false },
  { path: "opencode-tui", ours: (n) => /^\d+\.json(\.\d+\.tmp)?$/.test(n) },
  {
    path: "claude-return",
    ours: (_n, p) => kind(p) === "socket",
  },
];

function kind(path: string): "dir" | "socket" | "other" | undefined {
  try {
    const st = lstatSync(path);
    return st.isDirectory() ? "dir" : st.isSocket() ? "socket" : "other";
  } catch {
    return undefined;
  }
}

const remove = (path: string, k: "dir" | "socket" | "other") =>
  rmSync(path, { recursive: k === "dir", force: true });

const rmdirIfEmpty = (path: string) => {
  try {
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * The short socket folder a long home needs: only its sockets, and only when
 * the folder is ours (a symlink or another user's folder is never touched).
 */
function purgeShort(dir: string, removed: string[]): void {
  if (kind(dir) !== "dir" || unsafeSocketDir(dir)) return;
  const ret = join(dir, "claude-return");
  for (const [d, ours] of [
    [ret, (_n: string, p: string) => kind(p) === "socket"],
    [dir, (n: string) => /^daemon\.sock(\.keep-\d+)?$/.test(n)],
  ] as const) {
    if (kind(d) !== "dir") continue;
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const k = kind(path);
      if (k === undefined || k === "dir" || !ours(name, path)) continue;
      remove(path, k);
      removed.push(path);
    }
  }
  if (rmdirIfEmpty(ret)) removed.push(ret);
  if (rmdirIfEmpty(dir)) removed.push(dir);
}

/**
 * Removes only what Open Artifacts bus created in `home`, then `home` if that left it
 * empty. A home that is not the default ~/.oa-bus must hold machine.json or
 * install.json, or it is refused: it may be someone's folder.
 */
export function purge(
  home: string,
  opts: { isDefault: boolean },
): { refused: true } | { removed: string[]; leftDir: boolean } {
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return { removed: [], leftDir: false };
  }
  if (
    !opts.isDefault &&
    !entries.includes("machine.json") &&
    !entries.includes("install.json")
  )
    return { refused: true };
  // Named from the home, so before the home goes.
  const short = shortSocketDir(home);
  const removed: string[] = [];
  for (const name of [
    ...FILES,
    ...entries.filter((n) => TEMP.some((re) => re.test(n))),
  ]) {
    const path = join(home, name);
    const k = kind(path);
    // A known file name that is a directory is not ours; a symlink is removed, never followed.
    if (k === undefined || k === "dir") continue;
    remove(path, k);
    removed.push(name);
  }
  for (const folder of FOLDERS) {
    const dir = join(home, folder.path);
    // A symlinked folder is someone's: never followed, never removed.
    if (kind(dir) !== "dir") continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const k = kind(path);
      if (k === undefined || !folder.ours(name, path)) continue;
      remove(path, k);
      removed.push(join(folder.path, name));
    }
    if (rmdirIfEmpty(dir)) removed.push(folder.path);
  }
  purgeShort(short, removed);
  return { removed, leftDir: !rmdirIfEmpty(home) };
}
