// Guards the rule Leo set (#3115): tests control time with fake timers or wait
// on a signal, never sleep. No baseline, no exemptions: the check fails on any
// wait it finds, anywhere in a test file or test fixture.
//
// What it finds (each is a way to wait on the wall clock):
//   - a `new Promise(...)` whose executor calls `setTimeout` (arrow or brace
//     body, one line or many, with or without a type argument), and
//     `promisify(setTimeout)`;
//   - `timers/promises`: a static or dynamic import or a require of it (but a
//     lone `setImmediate`), however its `setTimeout` is aliased, and
//     `scheduler.wait(`; `Atomics.wait(`;
//   - a `sleep` helper or call;
//   - Playwright's `waitForTimeout`, and `toPass` / `expect.poll` given
//     `intervals`;
//   - a shell `sleep N` in a fixture, or a `sleep` child process;
//   - Python: `time.sleep`, `asyncio.sleep`, `trio`/`anyio`/`gevent` sleep, and a
//     `sleep` imported from `time` or `asyncio`.
// Comments are not code and are not scanned. A fake clock (`vi.useFakeTimers`,
// `advanceTimersByTime`), a signal wait and `setImmediate` are fine.
//
// Every tracked or new file in the repo is a candidate, this checker's own test
// included: a test file is one under any test, tests, e2e, __tests__ or
// test-browser folder, or named *.test.*, *.spec.*, test_*.py, *_test.py.
//
// Usage: node --experimental-strip-types scripts/ci/no-test-sleeps.ts [--list]
//   --list prints the hits grouped by file, with counts, and still exits 1 on any.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const CODE = "ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|py";

/**
 * Test files and their fixtures and helpers, anywhere in the repo: under a
 * test, tests, e2e, __tests__ or test-browser folder, or named *.test.*,
 * *.spec.*, test_*.py or *_test.py (or conftest.py).
 */
export const isTest = (path: string) => {
  const code = new RegExp(`\\.(${CODE})$`);
  if (!code.test(path)) return false;
  return (
    /(^|\/)(test|tests|e2e|__tests__|test-browser)\//.test(path) ||
    /\.(test|spec)\.[a-z]+$/.test(path) ||
    /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/.test(path)
  );
};

const SKIP =
  /(^|\/)(node_modules|dist|dist-assets|build|coverage|\.wrangler|\.venv|__pycache__)\//;

export type Hit = { file: string; line: number; why: string; text: string };

/**
 * `text` with every comment blanked (newlines kept, so offsets and lines
 * stay), strings and template literals left as they are: a fixture script in a
 * template literal is code to the checker.
 */
export function stripComments(text: string, hash = false): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (
      hash
        ? c === "#" && (i === 0 || /[\s;]/.test(text[i - 1] as string))
        : c === "/" && n === "/"
    ) {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (!hash && c === "/" && n === "*") {
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

const JS_RULES: ((code: string) => Found[])[] = [
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
  // timers/promises (a timer wait), however it is imported or aliased, and
  // scheduler.wait. Only a lone `setImmediate` (a yield) may come from it.
  (code) => {
    const out: Found[] = [];
    const names = (list: string) =>
      list.split(",").map((n) => n.trim().split(/[\s:]+/)[0] ?? "");
    for (const m of code.matchAll(/["'`](?:node:)?timers\/promises["'`]/g)) {
      const before = code.slice(
        Math.max(0, (m.index as number) - 240),
        m.index,
      );
      const after = code.slice(
        (m.index as number) + m[0].length,
        (m.index as number) + m[0].length + 40,
      );
      const picked =
        /import\s*\{([^}]*)\}\s*from\s*$/.exec(before) ??
        /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*$/.exec(
          before,
        );
      const onlyImmediate =
        picked !== null
          ? names(picked[1] as string).every((n) => n === "setImmediate")
          : /^\s*\)\s*\)\s*\.setImmediate\b/.test(after);
      if (!onlyImmediate)
        out.push({ index: m.index as number, why: "timers/promises" });
    }
    for (const m of code.matchAll(
      /\bscheduler\.wait\s*\(|\bAtomics\.wait\s*\(/g,
    ))
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
  shellSleep,
];

/** A shell `sleep N` in a fixture string or script, or a `sleep` child process. */
function shellSleep(code: string): Found[] {
  const out: Found[] = [];
  for (const m of code.matchAll(
    /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]sleep["'`]/g,
  ))
    out.push({ index: m.index as number, why: "shell sleep" });
  for (const m of code.matchAll(/(?:^|[\s;&|("'`])sleep\s+\d[\d.]*/gm))
    out.push({ index: m.index as number, why: "shell sleep" });
  return out;
}

const PY_RULES: ((code: string) => Found[])[] = [
  // time.sleep, asyncio.sleep, trio/anyio/gevent/eventlet sleep, and a `sleep`
  // imported from them.
  (code) => {
    const out: Found[] = [];
    for (const m of code.matchAll(
      /\b(?:time|asyncio|trio|anyio|gevent|eventlet)\.sleep\s*\(/g,
    ))
      out.push({ index: m.index as number, why: "sleep" });
    for (const m of code.matchAll(
      /\bfrom\s+(?:time|asyncio|trio|anyio|gevent|eventlet)\s+import\s+[^\n]*\bsleep\b/g,
    ))
      out.push({ index: m.index as number, why: "sleep" });
    // A bare `sleep(...)` is a wait only where `sleep` came from one of them.
    if (
      /\bfrom\s+(?:time|asyncio|trio|anyio|gevent|eventlet)\s+import\s+[^\n]*\bsleep\b/.test(
        code,
      )
    )
      for (const m of code.matchAll(/^\s*(?:await\s+)?sleep\s*\(/gm))
        out.push({ index: m.index as number, why: "sleep" });
    return out;
  },
  // A `sleep` child process: ["sleep", "5"].
  (code) =>
    [...code.matchAll(/\[\s*["']sleep["']\s*[,\]]/g)].map((m) => ({
      index: m.index as number,
      why: "shell sleep",
    })),
  shellSleep,
];

const SH_RULES: ((code: string) => Found[])[] = [shellSleep];

/** The rules and the comment style for a file, by extension. */
const kindOf = (file: string) =>
  /\.py$/.test(file)
    ? { rules: PY_RULES, hash: true }
    : /\.(sh|bash)$/.test(file)
      ? { rules: SH_RULES, hash: true }
      : { rules: JS_RULES, hash: false };

/** Every bare wait in `text`, in line order. */
export function scanText(text: string, file = ""): Hit[] {
  const kind = kindOf(file);
  const code = stripComments(text, kind.hash);
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
  for (const rule of kind.rules)
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

/** Every file the repo tracks or would (new, not ignored), relative to `base`; a plain walk without git. */
function repoFiles(base: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: base, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return walk(base).map((f) => relative(base, f));
  }
}

/** The bare waits in the repo's test files and fixtures. */
export function scan(base: string): Hit[] {
  const hits: Hit[] = [];
  for (const rel of repoFiles(base)) {
    if (SKIP.test(rel) || !isTest(rel)) continue;
    let text: string;
    try {
      text = readFileSync(join(base, rel), "utf8");
    } catch {
      continue; // deleted in the work tree, or a directory
    }
    hits.push(...scanText(text, rel));
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
