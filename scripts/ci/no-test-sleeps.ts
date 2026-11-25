// Guards the anti-flake rule Leo set: tests control time with fake timers or
// wait on a signal, never sleep. Scans test files for the bare-wait idioms
// (a setTimeout promise, a `sleep` helper or call, Playwright's
// `waitForTimeout`) and fails when one is added. Existing ones are listed in
// `test-sleep-baseline.json`, which only shrinks: retire one and take it out
// of that file in the same change.
//
// A line that genuinely must wait may say why, on itself or the line above:
//   // sleep-ok: the socket has no event this test can observe (see #1234)
// The reason must be at least ten characters; "TODO" is not a reason.
//
// Usage: node --experimental-strip-types scripts/ci/no-test-sleeps.ts [--update]
//   --update rewrites the baseline from what is in the tree now.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = join(root, "scripts/ci/test-sleep-baseline.json");
const MARK = /sleep-ok:\s*(\S.{9,})/i;

/** Test files: a folder named test or e2e, or a *.test / *.spec file. */
export const isTest = (path: string) =>
  /\/(test|e2e)\//.test(path) ||
  /\.(test|spec)\.(ts|tsx|mts)$/.test(path) ||
  /\/tests\/[^/]+\.(ts|tsx)$/.test(path);

/** The idioms that wait without a signal; the first that matches names the line. */
export const RULES: [name: string, re: RegExp][] = [
  ["sleep", /\bawait\s+sleep\w*\(|\b(?:const|function)\s+sleep\w*\s*[=(]/],
  ["waitForTimeout", /\.waitForTimeout\(/],
  [
    "setTimeout promise",
    /new Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\(/,
  ],
];

const SKIP = /\/(node_modules|dist|dist-assets|\.wrangler)\//;

/**
 * This checker's own test: it holds the idioms as data to prove they are
 * caught, so it is the one file where they are not a wait.
 */
const SELF_TEST = "scripts/ci/no-test-sleeps.test.ts";

export type Hit = { file: string; line: number; why: string; text: string };

/** Every bare wait in `text`, in line order; `// sleep-ok: <why>` exempts one. */
export function scanText(text: string, file = ""): Hit[] {
  const lines = text.split("\n");
  const out: Hit[] = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return; // a comment about the rule, not a call
    const why = RULES.find(([, re]) => re.test(line))?.[0];
    if (!why) return;
    // The reason may sit on the line itself or the one above it.
    const allowed = MARK.test(line) || (i > 0 && MARK.test(lines[i - 1] ?? ""));
    if (allowed) return;
    out.push({ file, line: i + 1, why, text: line.trim() });
  });
  return out;
}

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
};

/** The bare waits in the tree, by file. */
export function scan(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const dir of ["apps", "packages", "scripts", "tests"]) {
    let files: string[];
    try {
      files = walk(join(root, dir));
    } catch {
      continue; // a checkout without that folder
    }
    for (const file of files) {
      const rel = relative(root, file);
      if (!isTest(rel) || rel === SELF_TEST) continue;
      hits.push(...scanText(readFileSync(file, "utf8"), rel));
    }
  }
  return hits;
}

/** Why the check failed, or nothing when the tree matches the baseline. */
export function check(
  hits: Hit[],
  baseline: Record<string, number>,
): { added: string[]; stale: string[] } {
  const counted = new Map<string, number>();
  for (const h of hits) counted.set(h.file, (counted.get(h.file) ?? 0) + 1);
  const added: string[] = [];
  const stale: string[] = [];
  for (const [file, n] of counted) {
    const was = baseline[file] ?? 0;
    if (n > was)
      for (const h of hits.filter((x) => x.file === file))
        added.push(`${h.file}:${h.line}: ${h.why}: ${h.text}`);
  }
  for (const [file, was] of Object.entries(baseline)) {
    const n = counted.get(file) ?? 0;
    if (n < was) stale.push(`${file}: ${was - n} gone (baseline says ${was})`);
  }
  return { added, stale };
}

/**
 * The baseline at `ref` (the pull request's base), from git: the file in the
 * tree may only lower a count, never raise one or add a path, so a hand edit or
 * an `--update` cannot quietly grow the list. Missing ref (a shallow or
 * detached checkout, a push build): nothing to compare against.
 */
export function baseBaseline(ref: string): Record<string, number> | null {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    git(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return null; // no such ref: the caller fails rather than skipping
  }
  try {
    const text = git(["show", `${ref}:scripts/ci/test-sleep-baseline.json`]);
    return JSON.parse(text) as Record<string, number>;
  } catch {
    // The ref is there, the file is not: the base branch predates the check,
    // so it had no bare waits on its list to compare against.
    return {};
  }
}

/**
 * Whether the rule itself changed since `ref`. The only reason a count may grow
 * is a rule that finds more waits; every other growth is a hand edit growing
 * the list, which is what this check is for.
 */
export function ruleChanged(ref: string, cwd = root): boolean {
  try {
    execFileSync(
      "git",
      ["diff", "--quiet", ref, "--", "scripts/ci/no-test-sleeps.ts"],
      {
        cwd,
        stdio: "ignore",
      },
    );
    return false;
  } catch {
    return true;
  }
}

export type Growth = { file: string; message: string };

/** Keys raised above the base's count, or added since it. */
export function grown(
  tree: Record<string, number>,
  base: Record<string, number>,
): Growth[] {
  const out: Growth[] = [];
  for (const [file, n] of Object.entries(tree)) {
    const was = base[file] ?? 0;
    if (n > was)
      out.push({
        file,
        message:
          was === 0
            ? `${file}: ${n} added (not in the baseline on the base branch)`
            : `${file}: ${n}, was ${was} on the base branch`,
      });
  }
  return out;
}

/**
 * Which growth is allowed. Only a file this change did not touch may grow, and
 * only when the rule changed: a rule that finds more waits legitimately raises
 * counts in files nobody edited, while a sleep added in the same change is
 * exactly what this check exists to refuse (#3090 review).
 */
export function allowedGrowth(
  grew: Growth[],
  o: { ruleChanged: boolean; untouched: (file: string) => boolean },
): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const g of grew) {
    if (o.ruleChanged && o.untouched(g.file)) allowed.push(g.message);
    else denied.push(g.message);
  }
  return { allowed, denied };
}

/** Whether `file` is byte-identical to `ref`'s copy. */
export function fileUnchanged(ref: string, file: string, cwd = root): boolean {
  try {
    execFileSync("git", ["diff", "--quiet", ref, "--", file], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const main = () => {
  const hits = scan(root);
  const counted: Record<string, number> = {};
  for (const h of hits) counted[h.file] = (counted[h.file] ?? 0) + 1;
  const sorted = Object.fromEntries(
    Object.entries(counted).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
    const total = Object.values(sorted).reduce((n, x) => n + x, 0);
    console.log(
      `no-test-sleeps: baseline written, ${total} in ${Object.keys(sorted).length} files`,
    );
    return;
  }
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<
      string,
      number
    >;
  } catch {
    console.log("no-test-sleeps: no baseline; run with --update");
    process.exitCode = 1;
    return;
  }
  const { added, stale } = check(hits, baseline);
  for (const line of added) console.log(`no-test-sleeps: NEW ${line}`);
  for (const line of stale)
    console.log(`no-test-sleeps: STALE ${line}, lower the baseline`);
  // The baseline itself may only shrink (#3090 review).
  const at = process.argv.indexOf("--base");
  const ref = at === -1 ? undefined : process.argv[at + 1];
  const base = ref ? baseBaseline(ref) : null;
  if (ref && !base) {
    console.log(
      `no-test-sleeps: cannot read the baseline at ${ref}; the base commit has to be fetched (only-shrinks is checked against it)`,
    );
    process.exitCode = 1;
    return;
  }
  const grew = base ? grown(baseline, base) : [];
  const { allowed, denied } = allowedGrowth(grew, {
    ruleChanged: !!ref && ruleChanged(ref),
    untouched: (file) => !!ref && fileUnchanged(ref, file),
  });
  for (const line of allowed)
    console.log(
      `no-test-sleeps: GREW (the rule changed, file untouched) ${line}`,
    );
  for (const line of denied) console.log(`no-test-sleeps: RAISED ${line}`);
  if (added.length > 0 || stale.length > 0 || denied.length > 0) {
    console.log(
      "no-test-sleeps: tests control time with fake timers or wait on a signal, never sleep. Add `// sleep-ok: <why>` if a wait is the only way.",
    );
    process.exitCode = 1;
    return;
  }
  const total = Object.values(sorted).reduce((n, x) => n + x, 0);
  console.log(
    `no-test-sleeps: ok, ${total} known in ${Object.keys(sorted).length} files`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
