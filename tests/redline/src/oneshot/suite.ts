import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The gate binding (docs/ops/redline-signin.md). The verdicts carry
// suiteSha(): git HEAD of the directory holding capture.ts, which the gate
// compares with CI's GITHUB_SHA. So the one-shot driver (this branch) never
// uses its own copy of the capture: it imports runCaptures, the preflight and
// the suite runner from a frozen suite checkout, refuses unless that
// checkout is at the expected commit with a clean tree, and runs the live
// suite there.

export const DEFAULT_SUITE = join(
  homedir(),
  "code",
  "projects",
  "openartifacts-capture",
);
/** The commit the gate is bound to (main, frozen for the red-line run). */
export const DEFAULT_EXPECT_SHA = "5469cf7811e17857091d49dc18e0daa327bdbf89";

export type CaptureMod = typeof import("../capture.ts");
export type PreflightMod = typeof import("../preflight.ts");
export type SigninMod = typeof import("../signin.ts");
export type TargetsMod = typeof import("../targets.ts");

export interface Suite {
  dir: string;
  sha: string;
  capture: CaptureMod;
  preflight: PreflightMod;
  signin: SigninMod;
  targets: TargetsMod;
}

/** What each frozen module must export, and of which kind. */
export const REQUIRED = {
  capture: {
    runCaptures: "function",
    decodeBrokerState: "function",
    suiteSha: "function",
    CAPTURE_LEGS: "object",
  },
  preflight: {
    preflight: "function",
    gaps: "function",
    formatPreflight: "function",
  },
  signin: {
    googleUrlOf: "function",
    startGoogle: "function",
    CAPTURE_FLOWS: "object",
  },
  targets: { loadTargets: "function", secretFileName: "function" },
} as const;

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * The checkout's binding problems (empty: bound): a git checkout, HEAD equal
 * to `expectSha`, no modified, staged or untracked files (ignored files,
 * like node_modules, don't count), installed and generated.
 */
export function bindingGaps(dir: string, expectSha: string): string[] {
  const fix = `git -C ${dir} checkout --detach ${expectSha} && git -C ${dir} status`;
  if (!existsSync(join(dir, "tests", "redline", "src", "capture.ts")))
    return [
      `the suite checkout ${dir} is missing or has no tests/redline (git worktree add --detach ${dir} ${expectSha}, or pass --suite <path>)`,
    ];
  let head: string;
  try {
    head = git(dir, ["rev-parse", "HEAD"]);
  } catch {
    return [`${dir} is not a git checkout`];
  }
  const out: string[] = [];
  if (head !== expectSha)
    out.push(
      `the suite checkout ${dir} is at ${head.slice(0, 12)}, not ${expectSha.slice(0, 12)} (${fix})`,
    );
  let dirty = "";
  try {
    dirty = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  } catch {
    dirty = "?";
  }
  if (dirty)
    out.push(
      `the suite checkout ${dir} has local changes (${dirty.split("\n").length} paths): commit them elsewhere or reset it; the gate needs a clean tree`,
    );
  const installFix = `pnpm -C ${dir} install --frozen-lockfile && pnpm -C ${dir} --filter @oa/provision build`;
  if (
    !existsSync(join(dir, "node_modules")) ||
    !existsSync(join(dir, "tests", "redline", "node_modules", ".bin", "vitest"))
  )
    out.push(`the suite checkout ${dir} is not installed (${installFix})`);
  else if (!existsSync(join(dir, "packages", "provision", "dist", "index.js")))
    out.push(`the suite checkout ${dir} is not generated (${installFix})`);
  return out;
}

/** Each export the driver needs that a frozen module lacks (empty: compatible). */
export function apiGaps(
  mods: Record<keyof typeof REQUIRED, unknown>,
): string[] {
  const out: string[] = [];
  for (const [m, names] of Object.entries(REQUIRED) as [
    keyof typeof REQUIRED,
    Record<string, string>,
  ][])
    for (const [n, kind] of Object.entries(names)) {
      const v = (mods[m] as Record<string, unknown> | undefined)?.[n];
      if (typeof v !== kind)
        out.push(`${m}.ts at the suite commit has no ${kind} ${n}`);
    }
  return out;
}

export class BindingRefused extends Error {
  override name = "BindingRefused";
  readonly gaps: string[];
  constructor(gaps: string[]) {
    super(gaps.join("; "));
    this.gaps = gaps;
  }
}

/**
 * Loads the frozen suite's modules (dynamic import of its files), after the
 * binding check, and confirms its suiteSha() is the expected commit: the SHA
 * the verdicts will carry.
 */
export async function loadSuite(
  dir: string,
  expectSha: string,
): Promise<Suite> {
  const g = bindingGaps(dir, expectSha);
  if (g.length) throw new BindingRefused(g);
  const src = join(dir, "tests", "redline", "src");
  const imp = (f: string) => import(pathToFileURL(join(src, f)).href);
  const [capture, preflight, signin, targets] = await Promise.all([
    imp("capture.ts"),
    imp("preflight.ts"),
    imp("signin.ts"),
    imp("targets.ts"),
  ]);
  const a = apiGaps({ capture, preflight, signin, targets });
  if (a.length) throw new BindingRefused(a);
  const sha = (capture as CaptureMod).suiteSha();
  if (sha !== expectSha)
    throw new BindingRefused([
      `the frozen capture reports suiteSha ${sha.slice(0, 12)}, not ${expectSha.slice(0, 12)}`,
    ]);
  return { dir, sha, capture, preflight, signin, targets };
}

/**
 * The live suite in the frozen checkout (its scripts/redline.ts), with the
 * capture's verdicts. Resolves with its exit code; forwards signals.
 */
export function runSuiteIn(
  dir: string,
  env: Record<string, string | undefined>,
  o: { gate: boolean; onChild?: (pid: number) => void } = { gate: true },
): Promise<number> {
  const pkg = join(dir, "tests", "redline");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(pkg, "scripts", "redline.ts"),
      ...(o.gate ? ["--gate"] : []),
    ],
    { cwd: pkg, stdio: "inherit", env },
  );
  if (child.pid) o.onChild?.(child.pid);
  return new Promise((r) =>
    child.on("exit", (c, sig) => r(c ?? (sig ? 1 : 0))),
  );
}
