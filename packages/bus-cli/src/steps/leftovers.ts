import {
  lstatSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AdapterDeps,
  agentDirEnv,
  ompAgentDir,
  paths,
} from "./adapters.ts";
import { codexHome } from "./codex.ts";
import { hermesHome } from "./hermes.ts";
import { skillDir } from "./skill.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

type Deps = Pick<AdapterDeps, "home" | "env" | "busHome">;

/**
 * Files and folders install may create in a harness's own config. Install notes
 * which of these were not there before it ran (`made` in install.json), so
 * `uninstall --purge` can delete only those, and only once they are empty again.
 */
export function leftoverTargets(deps: Deps): {
  files: string[];
  dirs: string[];
} {
  const env = deps.env ?? {};
  const p = paths(deps as AdapterDeps);
  const piDir = agentDirEnv(deps.home, env) ?? join(deps.home, ".pi/agent");
  const skill = (h: Parameters<typeof skillDir>[1]) =>
    skillDir({ home: deps.home, env }, h);
  return {
    files: [
      join(codexHome(deps.home, env), "AGENTS.md"),
      p.codex,
      ...p.opencodeConfigs,
      p.opencodeCli,
    ],
    dirs: [
      skill("claude"),
      skill("pi"),
      skill("hermes"),
      join(hermesHome(deps.home, env), "plugins"),
      join(deps.home, ".local", "bin"),
      join(ompAgentDir(deps.home, env), "extensions"),
      join(piDir, "extensions"),
      skill("opencode"),
      skill("openclaw"),
    ],
  };
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const madeOf = (installFile: string): string[] => {
  const v = readInstallFile(installFile).made;
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
};

/** Before install writes anything: remember which targets do not exist yet. */
export function noteMade(deps: Deps): void {
  const file = paths(deps as AdapterDeps).record;
  const t = leftoverTargets(deps);
  const before = madeOf(file);
  const made = [
    ...new Set([
      ...before,
      ...[...t.files, ...t.dirs].filter((x) => !exists(x)),
    ]),
  ];
  if (made.length === before.length) return;
  updateInstallFile(file, { made });
}

/** Empty, or exactly the `{}` install wrote: nothing of the user's. */
function emptyFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    if (st.size === 0) return true;
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (
      typeof doc === "object" &&
      doc !== null &&
      !Array.isArray(doc) &&
      Object.keys(doc).length === 0
    );
  } catch {
    return false;
  }
}

/** The paths `made` records, read now: purge deletes install.json. */
export const readMade = (installFile: string) => madeOf(installFile);

/** Deletes recorded files that are empty again and recorded folders that are empty. Returns what went. */
export function removeMade(made: string[]): string[] {
  const gone: string[] = [];
  for (const path of made) {
    if (!emptyFile(path)) continue;
    rmSync(path, { force: true });
    gone.push(path);
  }
  // Deepest first, so a parent emptied by its child goes in the same run.
  for (const path of made
    .filter((x) => !gone.includes(x))
    .sort((a, b) => b.length - a.length)) {
    try {
      if (!lstatSync(path).isDirectory()) continue;
      if (readdirSync(path).length > 0) continue;
      rmdirSync(path);
      gone.push(path);
    } catch {}
  }
  return gone;
}
