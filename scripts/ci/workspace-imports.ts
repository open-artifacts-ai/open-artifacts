// Cross-package imports must be declared, so pnpm's `--filter ...[base]` (the
// test job's affected-only run on pull requests) sees every dependent.
//   node scripts/ci/workspace-imports.ts check         -> exit 1 on any undeclared import
//   node scripts/ci/workspace-imports.ts scope <base>  -> "all" or "affected"
//
// A relative import that leaves its package must land in a package the
// importer declares (dependencies, devDependencies or peerDependencies), or in
// one of ROOT_PATHS: shared non-package files some packages read. pnpm can't
// see those, so a change under one (or to root config, the lockfile or a
// workflow) runs the full suite: "all".
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Non-package paths packages may import from (a change here runs everything). */
export const ROOT_PATHS = [
  "design/emails/",
  "design/screens/",
  "scripts/ci/",
  "scripts/ops/",
  "package.json",
];
/** Changes that can affect every package, or CI itself. */
const GLOBAL: RegExp[] = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^biome\.json$/,
  /^\.nvmrc$/,
  /^\.npmrc$/,
  /^vitest\.config\.ts$/,
  /^\.github\//,
];
const TOPS = ["apps", "packages", "scripts", "tests"];
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const IMPORT =
  /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*["']((?:\.\.?\/)+[^"']+)["']/g;

export interface Pkg {
  dir: string;
  name: string;
  deps: Set<string>;
}

/** Workspace packages: a dir directly under apps/, packages/, scripts/ or tests/ with a package.json. */
export function workspace(root: string): Pkg[] {
  const out: Pkg[] = [];
  for (const top of TOPS) {
    if (!existsSync(join(root, top))) continue;
    for (const d of readdirSync(join(root, top), { withFileTypes: true })) {
      const pj = join(root, top, d.name, "package.json");
      if (!d.isDirectory() || !existsSync(pj)) continue;
      const j = JSON.parse(readFileSync(pj, "utf8"));
      out.push({
        dir: `${top}/${d.name}`,
        name: j.name,
        deps: new Set(
          Object.keys({
            ...j.dependencies,
            ...j.devDependencies,
            ...j.peerDependencies,
          }),
        ),
      });
    }
  }
  return out;
}

/** The package dir owning a repo path, or undefined (outside every package). */
export const ownerOf = (pkgs: Pkg[], path: string): Pkg | undefined =>
  pkgs
    .filter((p) => path === p.dir || path.startsWith(`${p.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];

export interface Violation {
  file: string;
  /** The import as written. */
  spec: string;
  /** What the importer must declare, or the non-package path it reached. */
  missing: string;
}

/** Every cross-package import that pnpm's graph would miss. */
export function violations(
  pkgs: Pkg[],
  files: { path: string; text: string }[],
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    const from = ownerOf(pkgs, f.path);
    if (!from || !SOURCE.test(f.path)) continue;
    for (const m of f.text.matchAll(IMPORT)) {
      const spec = m[1] as string;
      const to = normalize(join(dirname(f.path), spec));
      if (to.startsWith("..")) continue;
      const owner = ownerOf(pkgs, to);
      if (owner === from) continue;
      if (owner) {
        if (!from.deps.has(owner.name))
          out.push({ file: f.path, spec, missing: owner.name });
      } else if (!ROOT_PATHS.some((r) => to === r || to.startsWith(r)))
        out.push({ file: f.path, spec, missing: to });
    }
  }
  return out;
}

/** "all" when a change can reach packages pnpm can't see; else "affected". */
export const scope = (changed: string[]): "all" | "affected" =>
  changed.some(
    (f) =>
      GLOBAL.some((g) => g.test(f)) ||
      ROOT_PATHS.some((r) => f === r || f.startsWith(r)),
  )
    ? "all"
    : "affected";

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

export function trackedSources(root: string): { path: string; text: string }[] {
  return git(root, ["ls-files", ...TOPS])
    .split("\n")
    .filter((p) => SOURCE.test(p) && !p.includes("/node_modules/"))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), "utf8") }));
}

function main(argv: string[]): number {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const [cmd, base] = argv;
  if (cmd === "check") {
    const v = violations(workspace(root), trackedSources(root));
    for (const x of v)
      console.error(
        x.missing.startsWith("@")
          ? `${x.file}: imports ${x.spec}; declare ${x.missing} (workspace:*) in its package.json`
          : `${x.file}: imports ${x.spec} (${x.missing}), outside every package; add it to ROOT_PATHS in scripts/ci/workspace-imports.ts`,
      );
    return v.length ? 1 : 0;
  }
  if (cmd === "scope" && base) {
    const changed = git(root, ["diff", "--name-only", `${base}...HEAD`])
      .split("\n")
      .filter(Boolean);
    console.log(scope(changed));
    return 0;
  }
  console.error("usage: workspace-imports.ts check | scope <base sha>");
  return 2;
}

if (relative(process.argv[1] ?? "", fileURLToPath(import.meta.url)) === "")
  process.exit(main(process.argv.slice(2)));
