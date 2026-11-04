// Cross-package *reads*: a file that reaches another package's files with a
// path literal and `fs` instead of importing them is invisible to pnpm's
// `--filter ...[base]` (the test job's affected-only run on pull requests), so
// a change in the package it reads never runs it (#1353, #1308).
//   node scripts/ci/workspace-reads.ts check         -> exit 1 on a new or stale entry
//   node scripts/ci/workspace-reads.ts check --warn   -> warnings only, always exit 0
//
// scripts/ci/workspace-reads-known.txt is this check's baseline: the findings
// that exist today. It only shrinks, so the check turns fatal once it is empty.
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ownerOf,
  type Pkg,
  trackedSources,
  workspace,
} from "./workspace-imports.ts";

/** A literal that resolves into a package the reading file must declare. */
export interface Read {
  file: string;
  /** The package read, which the reader must declare. */
  package: string;
  /** The literal as written. */
  literal: string;
}

export const KNOWN = "scripts/ci/workspace-reads-known.txt";
const REPO_PATH = /^(?:apps|packages|scripts|tests)\//;
// One string literal in either quote, or a template with no interpolation. A
// literal is only a candidate when it is single-line and interpolation-free:
// without the `\n` and `${` exclusions one stray or interpolated backtick spans
// the rest of its file, and every later literal in it is never seen.
const LITERAL =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n$]|\\.|\$(?!\{))*`/g;
// A path and nothing else: prose, test names and code live in string literals.
const PORTABLE = /^[A-Za-z0-9._/-]+$/;

/** The repo paths a source file names: relative literals and repo-root ones. */
function paths(
  file: string,
  text: string,
): { literal: string; path: string }[] {
  const out: { literal: string; path: string }[] = [];
  for (const m of text.matchAll(LITERAL)) {
    const literal = m[0].slice(1, -1);
    if (m[0].startsWith("`") && literal.includes("${")) continue;
    if (!PORTABLE.test(literal)) continue;
    if (literal.startsWith("./") || literal.startsWith("../")) {
      const path = normalize(join(dirname(file), literal));
      if (path.startsWith("..")) continue;
      out.push({ literal, path });
    } else if (REPO_PATH.test(literal)) {
      out.push({ literal, path: normalize(literal) });
    }
  }
  return out;
}

/** Every read into another package the reader does not declare, once each. */
export function reads(
  pkgs: Pkg[],
  files: { path: string; text: string }[],
): Read[] {
  const out: Read[] = [];
  for (const f of files) {
    const from = ownerOf(pkgs, f.path);
    if (!from) continue;
    const seen = new Set<string>();
    for (const { literal, path } of paths(f.path, f.text)) {
      const owner = ownerOf(pkgs, path);
      if (!owner || owner === from || from.deps.has(owner.name)) continue;
      if (seen.has(owner.name)) continue;
      seen.add(owner.name);
      out.push({ file: f.path, package: owner.name, literal });
    }
  }
  return out;
}

/**
 * The "<file> <package>" entries of the known file: comments cut from the end of
 * a line, comment and blank lines dropped. A trailing comment says why a line is
 * tolerated, so a reader does not have to declare a dependency that would be
 * wrong (#1056's forbidden lists).
 */
export function parseKnown(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.split("#")[0].trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Findings the known file lacks, and known entries that no longer happen. */
export function drift(
  findings: Read[],
  known: string[],
): { added: Read[]; stale: string[] } {
  const key = (r: Read) => `${r.file} ${r.package}`;
  const now = new Set(findings.map(key));
  const have = new Set(known);
  return {
    added: findings.filter((r) => !have.has(key(r))),
    stale: known.filter((l) => !now.has(l)),
  };
}

const hint = (pkg: string) =>
  `declare ${pkg} in its package.json, or remove the line from workspace-reads-known.txt`;
/** The package named by a "<file> <package>" known line. */
const knownPkg = (line: string) => line.slice(line.lastIndexOf(" ") + 1);

/** What to print and what to exit with: `check`, or `check --warn`. */
export function report(
  findings: Read[],
  known: string[],
  warn: boolean,
): { lines: string[]; code: number } {
  const { added, stale } = drift(findings, known);
  if (warn)
    return {
      lines: [
        ...added.map(
          (r) =>
            `::warning file=${r.file}::new cross-package read of ${r.package} (${r.literal}); ${hint(r.package)}`,
        ),
        ...stale.map(
          (l) =>
            `::warning file=${KNOWN}::stale entry "${l}"; ${hint(knownPkg(l))}`,
        ),
        `workspace-reads (warn only): ${findings.length} cross-package read(s); ${added.length} new, ${stale.length} stale`,
      ],
      code: 0,
    };
  return {
    lines: [
      ...added.map(
        (r) =>
          `${r.file}: reads ${r.literal} in ${r.package}; ${hint(r.package)}`,
      ),
      ...stale.map(
        (l) =>
          `${l}: stale entry in workspace-reads-known.txt; ${hint(knownPkg(l))}`,
      ),
    ],
    code: added.length + stale.length ? 1 : 0,
  };
}

function main(argv: string[]): number {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const [cmd, ...flags] = argv;
  if (cmd !== "check") {
    console.error("usage: workspace-reads.ts check [--warn]");
    return 2;
  }
  const warn = flags.includes("--warn");
  const out = report(
    reads(workspace(root), trackedSources(root)),
    parseKnown(readFileSync(join(root, KNOWN), "utf8")),
    warn,
  );
  for (const line of out.lines) {
    if (warn) console.log(line);
    else console.error(line);
  }
  return out.code;
}

if (relative(process.argv[1] ?? "", fileURLToPath(import.meta.url)) === "")
  process.exit(main(process.argv.slice(2)));
