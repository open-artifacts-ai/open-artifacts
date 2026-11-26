// Guards the rule Leo set (#3115): tests control time with fake timers or wait
// on a signal, never sleep. No baseline, no exemptions: the check fails on any
// wait it finds, anywhere in a test file or test fixture.
//
// What it finds (each is a way to wait on the wall clock):
//   - a `new Promise(...)` whose executor calls `setTimeout` (arrow or brace
//     body, one line or many, with or without a type argument), and
//     `promisify(setTimeout)`;
//   - `setTimeout`, `setInterval` or `scheduler` from `node:timers/promises`,
//     and `scheduler.wait(`;
//   - a `sleep` helper or call;
//   - Playwright's `waitForTimeout`, and `toPass` / `expect.poll` given
//     `intervals`;
//   - a shell `sleep N` in a fixture, or a `sleep` child process.
// Comments are not code and are not scanned. A fake clock (`vi.useFakeTimers`,
// `advanceTimersByTime`), a signal wait and `setImmediate` are fine.
//
// Usage: node --experimental-strip-types scripts/ci/no-test-sleeps.ts [--list]
//   --list prints the hits grouped by file, with counts, and still exits 1 on any.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const CODE = "ts|tsx|mts|cts|js|jsx|mjs|cjs|sh";

/** Test files and fixtures: under a test, tests or e2e folder, or named *.test / *.spec. */
export const isTest = (path: string) =>
  new RegExp(`(^|/)(test|tests|__tests__|e2e)/.+\\.(${CODE})$`).test(path) ||
  new RegExp(`\\.(test|spec)\\.(${CODE})$`).test(path);

const SKIP = /(^|\/)(node_modules|dist|dist-assets|\.wrangler)\//;

/**
 * This checker's own test: it holds the shapes as data to prove they are
 * caught, so it is the one file where they are not a wait.
 */
const SELF_TEST = "scripts/ci/no-test-sleeps.test.ts";

export type Hit = { file: string; line: number; why: string; text: string };

/**
 * `text` with every comment blanked (newlines kept, so offsets and lines
 * stay), strings and template literals left as they are: a fixture script in a
 * template literal is code to the checker.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && n === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") {
          out += text[i] as string;
          i++;
        }
        if (i < text.length) out += text[i] as string;
        i++;
        if (c !== "`" && text[i] === "\n") break; // an unterminated quote ends at the line
      }
      if (i < text.length) out += text[i] as string;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The index of the `)` closing the `(` at `open`, skipping strings; -1 when unbalanced. */
function closeParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < code.length && code[i] !== c; i++)
        if (code[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

type Found = { index: number; why: string };

/** The call bodies `opener(` ... `)` in `code`: where the opener starts and what is inside. */
function* calls(code: string, opener: RegExp) {
  for (const m of code.matchAll(opener)) {
    const open = (m.index as number) + m[0].length - 1;
    const end = closeParen(code, open);
    yield {
      index: m.index as number,
      body: code.slice(open, end < 0 ? undefined : end),
    };
  }
}

const RULES: ((code: string) => Found[])[] = [
  // new Promise(<executor>) whose executor reaches setTimeout, however it is written.
  (code) => {
    const out: Found[] = [];
    for (const c of calls(code, /new\s+Promise\b[^(;]*\(/g))
      if (/\bsetTimeout\s*\(/.test(c.body))
        out.push({ index: c.index, why: "setTimeout promise" });
    for (const m of code.matchAll(/\bpromisify\s*\(\s*setTimeout\s*\)/g))
      out.push({ index: m.index as number, why: "setTimeout promise" });
    return out;
  },
  // node:timers/promises (a timer wait) and scheduler.wait.
  (code) => {
    const out: Found[] = [];
    for (const m of code.matchAll(
      /import\s*(?:\*\s*as\s+\w+|\{([^}]*)\})\s*from\s*["'`](?:node:)?timers\/promises["'`]/g,
    )) {
      const names = (m[1] ?? "*")
        .split(",")
        .map((n) => n.trim().split(/\s+/)[0]);
      if (
        names.some(
          (n) =>
            n === "*" ||
            n === "setTimeout" ||
            n === "setInterval" ||
            n === "scheduler",
        )
      )
        out.push({ index: m.index as number, why: "timers/promises" });
    }
    for (const m of code.matchAll(
      /\brequire\s*\(\s*["'`](?:node:)?timers\/promises["'`]\s*\)/g,
    ))
      out.push({ index: m.index as number, why: "timers/promises" });
    for (const m of code.matchAll(/\bscheduler\.wait\s*\(/g))
      out.push({ index: m.index as number, why: "timers/promises" });
    return out;
  },
  (code) =>
    [
      ...code.matchAll(
        /\bawait\s+sleep(?:For|Ms|Sync|Async)?\(|\b(?:const|let|var|function)\s+sleep(?:For|Ms|Sync|Async)?\s*[=(:]/g,
      ),
    ].map((m) => ({ index: m.index as number, why: "sleep" })),
  (code) =>
    [...code.matchAll(/\.waitForTimeout\s*\(/g)].map((m) => ({
      index: m.index as number,
      why: "waitForTimeout",
    })),
  // toPass / expect.poll given intervals: a fixed re-ask schedule.
  (code) => {
    const out: Found[] = [];
    for (const c of calls(code, /\.toPass\s*\(|\bexpect\s*\.poll\s*\(/g))
      if (/\bintervals?\s*:/.test(c.body))
        out.push({ index: c.index, why: "poll intervals" });
    return out;
  },
  // A shell `sleep N` in a fixture, or a `sleep` child process.
  (code) => {
    const out: Found[] = [];
    for (const m of code.matchAll(
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]sleep["'`]/g,
    ))
      out.push({ index: m.index as number, why: "shell sleep" });
    for (const m of code.matchAll(/(?:^|[\s;&|("'`])sleep\s+\d[\d.]*/gm))
      out.push({ index: m.index as number, why: "shell sleep" });
    return out;
  },
];

/** Every bare wait in `text`, in line order. */
export function scanText(text: string, file = ""): Hit[] {
  const code = stripComments(text);
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let at = 0;
  for (const l of lines) {
    lineStarts.push(at);
    at += l.length + 1;
  }
  const lineOf = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const rule of RULES)
    for (const f of rule(code)) {
      const line = lineOf(f.index);
      const key = `${line}:${f.why}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        file,
        line,
        why: f.why,
        text: (lines[line - 1] ?? "").trim(),
      });
    }
  return out.sort((a, b) => a.line - b.line);
}

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP.test(`${p}/`)) continue;
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

/** The bare waits in the tree. */
export function scan(base: string): Hit[] {
  const hits: Hit[] = [];
  for (const dir of ["apps", "packages", "scripts", "tests"]) {
    let files: string[];
    try {
      files = walk(join(base, dir));
    } catch {
      continue; // a checkout without that folder
    }
    for (const file of files) {
      const rel = relative(base, file);
      if (!isTest(rel) || rel === SELF_TEST) continue;
      hits.push(...scanText(readFileSync(file, "utf8"), rel));
    }
  }
  return hits;
}

const main = () => {
  const hits = scan(root);
  if (process.argv.includes("--list")) {
    const by = new Map<string, Hit[]>();
    for (const h of hits) by.set(h.file, [...(by.get(h.file) ?? []), h]);
    for (const [file, hs] of [...by].sort(([a], [b]) => (a < b ? -1 : 1))) {
      console.log(`${file}: ${hs.length}`);
      for (const h of hs) console.log(`  ${h.line}: ${h.why}: ${h.text}`);
    }
  } else
    for (const h of hits)
      console.log(`no-test-sleeps: ${h.file}:${h.line}: ${h.why}: ${h.text}`);
  if (hits.length > 0) {
    console.log(
      `no-test-sleeps: ${hits.length} wait(s). Tests control time with fake timers or wait on a signal, never sleep; there is no exemption.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("no-test-sleeps: ok, no waits in test files");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
