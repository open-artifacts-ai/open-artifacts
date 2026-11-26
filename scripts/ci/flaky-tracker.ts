// The flaky tracker for public CI (cloud #447; the cloud repo has its own for
// its CI and redline-staging). Tracking only: it reruns nothing and blocks
// nothing. flaky-tracker.yml runs it when a CI run passes on attempt 2 or
// later. Every test that failed on an earlier attempt of that run, with the
// same head commit, failed and then passed with nothing changed.
//
// Where the failures come from: each earlier attempt's failed job logs.
//   - Vitest: ` RUN  vX /<workspace>/<dir>` names the root, then the summary
//     lists ` FAIL  <file> > <describe> > <test>` (or `<file> [ <file> ]` for
//     a file that failed outside a test). The file is <dir>/<file>.
//   - Playwright (e2e-shard, list reporter, cwd apps/dashboard): `  N failed`
//     then `    [project] › <file>:L:C › <title>` per test.
// A job that failed outside the tests (install, typecheck, lint, the `test`
// and `e2e` roll-ups) parses to no test: it is infrastructure, not a flaky
// test, and only shows in the step summary.
//
// Two in seven days. Every sighting (test, run, attempt, time) is recorded in
// one open store issue labelled `flaky-sightings`, as one comment per tracker
// run holding machine-readable lines. A test gets an issue labelled `flaky`
// only once it was seen in two different runs within 7 days; while that issue
// is open, each later sighting bumps it. Why this store: it needs no service
// and no secret (the default token writes issues), comments are append-only
// so two tracker runs at once never overwrite each other, a comment is
// readable as soon as it is written (issue search lags), and `?since=` bounds
// the read to the window. Anyone can comment on a public issue, so only
// comments by github-actions[bot] count.
//
// One issue per test, keyed on its identity only (suite, repo-relative file,
// title), never its error text. A run with more than MAX_TESTS_PER_RUN failed
// tests was a broken attempt rather than flaky tests: one summary issue lists
// them, and nothing is recorded per test. The owner is the last author of the
// test file at the run's head commit, assigned when GitHub allows it, else
// named in plain text.
//
// Usage: node --experimental-strip-types scripts/ci/flaky-tracker.ts --repo o/n --run-id <id> --attempt <n>
// Needs GH_TOKEN (actions: read, contents: read, issues: write).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const LABEL = "flaky";
export const STORE_LABEL = "flaky-sightings";
export const BOT = "github-actions[bot]";
/** Where Playwright runs (pnpm --filter @oa/dashboard exec playwright). */
export const PW_PACKAGE = "apps/dashboard";
export const WINDOW_DAYS = 7;
export const TWICE_NOTE = "failed in two runs within 7 days";
/** More distinct failed tests than this in one run: one summary issue. */
export const MAX_TESTS_PER_RUN = 5;
const SUMMARY_LIST_MAX = 50;
const DAY_MS = 24 * 3600 * 1000;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

const TRANSIENT =
  /HTTP 50[0234]|status code: 50[0234]|Server Error|timed? ?out|connection reset|\bEOF\b/i;
export const sleeper = {
  sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

/** A gh call. Reads retry a transient 5xx twice; a write runs once. */
export function gh(exec: Exec, args: string[], write = false): string {
  const tries = write ? 1 : 3;
  for (let i = 0; ; i++) {
    const r = exec("gh", args);
    if (r.code === 0) return r.stdout;
    if (i + 1 < tries && TRANSIENT.test(r.stderr)) {
      sleeper.sleep(2000 * (i + 1));
      continue;
    }
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  }
}

export type Suite = "vitest" | "playwright";
export type Failure = { suite: Suite; id: string; title: string; file: string };
export type Sighting = { at: string; run: number; attempt: number };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes in job logs
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

export function logLines(log: string): string[] {
  return log
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(STAMP, "").replace(ANSI, ""));
}

const failure = (suite: Suite, file: string, title: string): Failure => ({
  suite,
  id: `${suite}:${file}:${title}`,
  title,
  file,
});

function dedupe(fs: Failure[]): Failure[] {
  const seen = new Set<string>();
  return fs.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

/** The repo-relative dir of a runner path (`/home/runner/work/r/r/x`, `/__w/r/r/x`). */
export function repoDir(abs: string): string {
  return abs
    .replace(/^(?:\/home\/runner\/work|\/__w)\/[^/]+\/[^/]+\/?/, "")
    .replace(/\/$/, "");
}

/** The tests vitest's summary lists as FAIL, with repo-relative files. */
export function parseVitest(log: string): Failure[] {
  let root = "";
  const out: Failure[] = [];
  for (const l of logLines(log)) {
    const run = /^ RUN {2}v\S+ (\/\S+)\s*$/.exec(l);
    if (run) {
      root = repoDir(run[1] as string);
      continue;
    }
    const m =
      /^ FAIL {2}(?:\|[^|]+\| )?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?: > (.+?)| \[ .*\])\s*$/.exec(
        l,
      );
    if (!m) continue;
    const file = root ? `${root}/${m[1]}` : (m[1] as string);
    out.push(failure("vitest", file, m[2] ?? "(file failed outside a test)"));
  }
  return dedupe(out);
}

/** The tests Playwright's list reporter names under `N failed`. */
export function parsePlaywright(log: string): Failure[] {
  const out: Failure[] = [];
  const lines = logLines(log);
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {2}\d+ failed\s*$/.test(lines[i] ?? "")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^ {4}(?:\[[^\]]*\] › )?(\S+?):\d+:\d+ › (.+?)\s*$/.exec(
        lines[j] ?? "",
      );
      if (!m) break;
      out.push(failure("playwright", `${PW_PACKAGE}/${m[1]}`, m[2] as string));
    }
  }
  return dedupe(out);
}

/** The marker key of a test id: short, and safe inside an HTML comment. */
export const keyOf = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 16);

// The store: each tracker comment holds `<!-- flaky-sightings` then one line
// per sighting, `<key> <run>/<attempt> <time>`, then `-->`.
const LINE_RE = /^([0-9a-f]{16}) (\d+)\/(\d+) (\d{4}-\d\d-\d\dT[\d:]+Z)$/;

export type Recorded = Sighting & { key: string };

export function parseStore(comment: string): Recorded[] {
  const m = /<!-- flaky-sightings\n([\s\S]*?)\n-->/.exec(comment);
  if (!m) return [];
  return (m[1] as string)
    .split("\n")
    .map((l) => LINE_RE.exec(l.trim()))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => ({
      key: x[1] as string,
      run: Number(x[2]),
      attempt: Number(x[3]),
      at: x[4] as string,
    }));
}

export function storeComment(
  run: RunInfo,
  rows: { f: Failure; sighting: Sighting }[],
): string {
  return [
    "<!-- flaky-sightings",
    ...rows.map(
      ({ f, sighting: s }) => `${keyOf(f.id)} ${s.run}/${s.attempt} ${s.at}`,
    ),
    "-->",
    `Run ${run.url} passed on attempt ${run.attempt} after these failed:`,
    ...rows.map(
      ({ f, sighting: s }) =>
        `- attempt ${s.attempt}: ${codeSpan(f.title)} in ${codeSpan(f.file)}`,
    ),
  ].join("\n");
}

const SEEN_RE = /<!-- flaky-seen: ([^>]*?) -->/;

export function parseSeen(body: string): Sighting[] {
  const m = SEEN_RE.exec(body);
  if (!m) return [];
  return (m[1] as string)
    .split(";")
    .map((s) => /^\s*(\S+) (\d+)\/(\d+)\s*$/.exec(s))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => ({
      at: x[1] as string,
      run: Number(x[2]),
      attempt: Number(x[3]),
    }));
}

const seenMarker = (s: Sighting[]) =>
  `<!-- flaky-seen: ${s.map((x) => `${x.at} ${x.run}/${x.attempt}`).join("; ")} -->`;

/** The sightings within the window ending now, one per run (the earliest). */
export function inWindow(s: Sighting[], nowMs: number): Sighting[] {
  const from = nowMs - WINDOW_DAYS * DAY_MS;
  const byRun = new Map<number, Sighting>();
  for (const x of s) {
    if (Date.parse(x.at) < from) continue;
    const had = byRun.get(x.run);
    if (!had || x.attempt < had.attempt) byRun.set(x.run, x);
  }
  return [...byRun.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export type RunInfo = {
  repo: string;
  runId: number;
  attempt: number;
  sha: string;
  url: string;
};

const runUrl = (repo: string, s: Sighting) =>
  `https://github.com/${repo}/actions/runs/${s.run}/attempts/${s.attempt}`;

/**
 * `s` as an inline code span no backtick inside can end early, so a mention or
 * an issue ref in a test title stays inert text.
 */
export function codeSpan(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

export function issueTitle(f: Failure): string {
  const t = `Flaky: ${f.title} (${f.file.split("/").pop()})`;
  return t.length > 240 ? `${t.slice(0, 237)}...` : t;
}

export type Owner = { login: string; assignable: boolean } | null;

export function newIssueBody(o: {
  f: Failure;
  run: RunInfo;
  seen: Sighting[];
  owner: Owner;
}): string {
  const { f, run } = o;
  const owner = o.owner
    ? o.owner.assignable
      ? `${o.owner.login} (assigned)`
      : `${o.owner.login} (named only: GitHub can't assign them here)`
    : "unknown (no commit found, or the lookup failed)";
  return [
    `<!-- flaky-key: ${keyOf(f.id)} -->`,
    `A ${f.suite === "vitest" ? "Vitest" : "Playwright"} test in CI failed and then passed on a rerun of the same run, with the same commit, in ${o.seen.length} runs within ${WINDOW_DAYS} days. Nothing changed between the attempts, so the test is flaky.`,
    "",
    `Test: ${codeSpan(f.title)}`,
    `File: ${codeSpan(f.file)}`,
    `Last author of the file at ${run.sha.slice(0, 12)}: ${owner}`,
    "",
    "Failed on:",
    ...o.seen.map((s) => `- ${runUrl(run.repo, s)} (${s.at})`),
    `Passed on: ${runUrl(run.repo, { ...run, run: run.runId, at: "" })}`,
    "",
    "This issue only tracks the flake: it changes no retry and blocks nothing. Fix the test, or the race it found, and close the issue. A later flake of the same test is noted here while it is open.",
    "",
    seenMarker(o.seen),
  ].join("\n");
}

export function bumpedBody(body: string, seen: Sighting[]): string {
  const marker = seenMarker(seen);
  return SEEN_RE.test(body)
    ? body.replace(SEEN_RE, () => marker)
    : `${body}\n${marker}`;
}

export function bumpComment(o: {
  run: RunInfo;
  sighting: Sighting;
  twice: boolean;
}): string {
  return [
    `Failed again on ${runUrl(o.run.repo, o.sighting)}, passed on attempt ${o.run.attempt}.`,
    ...(o.twice ? ["", `This test ${TWICE_NOTE}.`] : []),
  ].join("\n");
}

export type Issue = { number: number; body: string };

export type Action =
  | { kind: "record"; f: Failure; sighting: Sighting }
  | { kind: "create"; f: Failure; sighting: Sighting; seen: Sighting[] }
  | {
      kind: "bump";
      f: Failure;
      sighting: Sighting;
      issue: Issue;
      seen: Sighting[];
    }
  | { kind: "skip"; f: Failure; sighting: Sighting; issue: number };

/**
 * What one test's sighting does, given the store's sightings of it (any run)
 * and the open `flaky` issues: bump its open issue (skip when the issue notes
 * this run already), open one when it was seen in two runs within the window,
 * else only record it.
 */
export function decide(o: {
  f: Failure;
  sighting: Sighting;
  recorded: Recorded[];
  open: Issue[];
  nowMs: number;
}): Action {
  const { f, sighting } = o;
  const key = keyOf(f.id);
  const issue = o.open.find((i) =>
    i.body.includes(`<!-- flaky-key: ${key} -->`),
  );
  if (issue) {
    const prior = parseSeen(issue.body);
    if (prior.some((p) => p.run === sighting.run))
      return { kind: "skip", f, sighting, issue: issue.number };
    return { kind: "bump", f, sighting, issue, seen: [...prior, sighting] };
  }
  const seen = inWindow(
    [...o.recorded.filter((r) => r.key === key), sighting],
    o.nowMs,
  );
  if (seen.length >= 2) return { kind: "create", f, sighting, seen };
  return { kind: "record", f, sighting };
}

type Attempt = { conclusion: string | null; head_sha: string };
type Job = {
  id: number;
  name: string;
  conclusion: string | null;
  completed_at: string | null;
};

function jobLog(exec: Exec, repo: string, id: number): string {
  const path = `repos/${repo}/actions/jobs/${id}/logs`;
  try {
    return gh(exec, ["api", "--allow-escape-sequences", path]);
  } catch (e) {
    if (!/unknown flag/.test((e as Error).message)) throw e;
    return gh(exec, ["api", path]);
  }
}

/**
 * Every test that failed on an earlier failed attempt with the same head sha,
 * once each (its earliest attempt), and notes on what else failed.
 */
export function collect(
  exec: Exec,
  run: RunInfo,
): { found: { f: Failure; sighting: Sighting }[]; notes: string[] } {
  const base = `repos/${run.repo}/actions/runs/${run.runId}`;
  const found = new Map<string, { f: Failure; sighting: Sighting }>();
  const notes: string[] = [];
  for (let a = 1; a < run.attempt; a++) {
    const att = JSON.parse(
      gh(exec, ["api", `${base}/attempts/${a}`]),
    ) as Attempt;
    if (att.conclusion !== "failure") continue;
    if (att.head_sha !== run.sha) {
      notes.push(`attempt ${a}: another commit (${att.head_sha}), skipped`);
      continue;
    }
    const jobs = (
      JSON.parse(
        gh(exec, ["api", `${base}/attempts/${a}/jobs?per_page=100`]),
      ) as { jobs: Job[] }
    ).jobs.filter((j) => j.conclusion === "failure");
    for (const j of jobs) {
      const log = jobLog(exec, run.repo, j.id);
      const fs = [...parseVitest(log), ...parsePlaywright(log)];
      if (!fs.length)
        notes.push(`attempt ${a}: job ${j.name} failed outside the tests`);
      const at = (j.completed_at ?? new Date().toISOString()).replace(
        /\.\d+Z$/,
        "Z",
      );
      for (const f of fs)
        if (!found.has(f.id))
          found.set(f.id, { f, sighting: { at, run: run.runId, attempt: a } });
    }
  }
  return { found: [...found.values()], notes };
}

export function ownerOf(exec: Exec, run: RunInfo, f: Failure): Owner {
  const commits = JSON.parse(
    gh(exec, [
      "api",
      `repos/${run.repo}/commits?path=${encodeURIComponent(f.file)}&sha=${run.sha}&per_page=1`,
    ]),
  ) as { author?: { login?: string } | null }[];
  const login = commits[0]?.author?.login;
  if (!login) return null;
  if (login.endsWith("[bot]")) return { login, assignable: false };
  // 204 when they can be assigned here, 404 otherwise.
  const r = exec("gh", ["api", `repos/${run.repo}/assignees/${login}`]);
  return { login, assignable: r.code === 0 };
}

function ensureLabel(exec: Exec, repo: string, name: string, about: string) {
  const labels = JSON.parse(
    gh(exec, [
      "label",
      "list",
      "--repo",
      repo,
      "--search",
      name,
      "--json",
      "name",
    ]),
  ) as { name: string }[];
  if (labels.some((l) => l.name === name)) return;
  gh(
    exec,
    [
      "label",
      "create",
      name,
      "--repo",
      repo,
      "--color",
      "FBCA04",
      "--description",
      about,
    ],
    true,
  );
}

/** gh prints the Actions bot as `app/github-actions` in issue lists. */
const byBot = (login: string | undefined) =>
  login === BOT || login === "app/github-actions";

/** Open issues with the label, opened by the Actions bot, oldest first. */
function listOpen(exec: Exec, repo: string, label: string): Issue[] {
  const all = JSON.parse(
    gh(exec, [
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,body,author",
      "--limit",
      "500",
    ]),
  ) as (Issue & { author?: { login?: string } })[];
  return all
    .filter((i) => byBot(i.author?.login))
    .map(({ number, body }) => ({ number, body }))
    .sort((a, b) => a.number - b.number);
}

/** The store's sightings since the window opened, from bot comments only. */
function readStore(
  exec: Exec,
  repo: string,
  stores: Issue[],
  nowMs: number,
): Recorded[] {
  const since = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
  const out: Recorded[] = [];
  for (const s of stores) {
    const lines = gh(exec, [
      "api",
      "--paginate",
      `repos/${repo}/issues/${s.number}/comments?since=${since}&per_page=100`,
      "--jq",
      `.[] | select(.user.login == "${BOT}") | .body | @json`,
    ]);
    for (const l of lines.split("\n"))
      if (l.trim()) out.push(...parseStore(JSON.parse(l) as string));
  }
  return out;
}

const STORE_BODY = [
  "The flaky tracker's store (scripts/ci/flaky-tracker.ts). Each comment by github-actions[bot] lists the tests that failed and then passed on a rerun of one CI run, one machine-readable line per test in its HTML comment. A test seen in two runs within 7 days gets its own issue labelled `flaky`.",
  "",
  "Keep this issue open; closing it starts a new store and forgets the last 7 days.",
].join("\n");

export type Done = {
  action: Action["kind"] | "summary";
  id: string;
  issue?: number;
};

export const summaryMarker = (runId: number) =>
  `<!-- flaky-summary: ${runId} -->`;

export function summaryIssue(
  run: RunInfo,
  tests: { f: Failure; sighting: Sighting }[],
): { title: string; body: string } {
  const attempts = [...new Set(tests.map((t) => t.sighting.attempt))].sort(
    (a, b) => a - b,
  );
  const list = tests
    .slice(0, SUMMARY_LIST_MAX)
    .map((t) => `- ${codeSpan(t.f.title)} in ${codeSpan(t.f.file)}`);
  const more = tests.length - list.length;
  return {
    title: `Flaky: ${tests.length} tests failed on CI run ${run.runId}, then passed`,
    body: [
      summaryMarker(run.runId),
      `${tests.length} tests failed on attempt ${attempts.join(", ")} of CI run ${run.runId} and the same run passed on attempt ${run.attempt}, with the same commit. More than ${MAX_TESTS_PER_RUN} at once usually means the attempt itself was broken (an outage, a bad runner), not that each test is flaky, so nothing was recorded or filed per test.`,
      "",
      ...attempts.map(
        (a) =>
          `Failed attempt: ${runUrl(run.repo, { run: run.runId, attempt: a, at: "" })}`,
      ),
      `Passed on: ${runUrl(run.repo, { run: run.runId, attempt: run.attempt, at: "" })}`,
      "",
      ...list,
      ...(more > 0 ? [`- and ${more} more`] : []),
      "",
      "Look at the failed attempt. If it was the environment, close this issue.",
    ].join("\n"),
  };
}

export function track(o: { exec: Exec; run: RunInfo; nowMs: number }): {
  done: Done[];
  notes: string[];
} {
  const { exec, run, nowMs } = o;
  const { found, notes } = collect(exec, run);
  if (!found.length) return { done: [], notes };
  ensureLabel(
    exec,
    run.repo,
    LABEL,
    "A test that failed and then passed on a rerun, in two runs within 7 days",
  );
  if (found.length > MAX_TESTS_PER_RUN) {
    const marker = summaryMarker(run.runId);
    const had = listOpen(exec, run.repo, LABEL).find((i) =>
      i.body.includes(marker),
    );
    if (had)
      return {
        done: [
          { action: "skip", id: `summary:${run.runId}`, issue: had.number },
        ],
        notes,
      };
    const { title, body } = summaryIssue(run, found);
    gh(
      exec,
      [
        "issue",
        "create",
        "--repo",
        run.repo,
        "--title",
        title,
        "--body",
        body,
        "--label",
        LABEL,
      ],
      true,
    );
    return { done: [{ action: "summary", id: `summary:${run.runId}` }], notes };
  }

  // Record first, so the evidence survives a failure below. A rerun of the
  // tracker finds this run's lines already there and adds none.
  ensureLabel(
    exec,
    run.repo,
    STORE_LABEL,
    "The flaky tracker's store of sightings",
  );
  let stores = listOpen(exec, run.repo, STORE_LABEL);
  if (!stores.length) {
    gh(
      exec,
      [
        "issue",
        "create",
        "--repo",
        run.repo,
        "--title",
        "Flaky test sightings (the flaky tracker's store)",
        "--body",
        STORE_BODY,
        "--label",
        STORE_LABEL,
      ],
      true,
    );
    stores = listOpen(exec, run.repo, STORE_LABEL);
  }
  const store = stores[0];
  if (!store) throw new Error("no store issue after creating one");
  const recorded = readStore(exec, run.repo, stores, nowMs);
  const fresh = found.filter(
    ({ f, sighting }) =>
      !recorded.some((r) => r.key === keyOf(f.id) && r.run === sighting.run),
  );
  if (fresh.length)
    gh(
      exec,
      [
        "issue",
        "comment",
        String(store.number),
        "--repo",
        run.repo,
        "--body",
        storeComment(run, fresh),
      ],
      true,
    );

  const done: Done[] = [];
  for (const { f, sighting } of found) {
    // A fresh list right before each write: tracker runs are not serialized.
    const a = decide({
      f,
      sighting,
      recorded,
      open: listOpen(exec, run.repo, LABEL),
      nowMs,
    });
    if (a.kind === "record" || a.kind === "skip") {
      done.push({
        action: a.kind,
        id: f.id,
        ...(a.kind === "skip" ? { issue: a.issue } : {}),
      });
      continue;
    }
    if (a.kind === "bump") {
      // The body first: it is what decide() reads, so a rerun skips this run.
      gh(
        exec,
        [
          "issue",
          "edit",
          String(a.issue.number),
          "--repo",
          run.repo,
          "--body",
          bumpedBody(a.issue.body, a.seen),
        ],
        true,
      );
      const twice =
        inWindow(
          [...recorded.filter((r) => r.key === keyOf(f.id)), ...a.seen],
          nowMs,
        ).length >= 2;
      gh(
        exec,
        [
          "issue",
          "comment",
          String(a.issue.number),
          "--repo",
          run.repo,
          "--body",
          bumpComment({ run, sighting, twice }),
        ],
        true,
      );
      done.push({ action: "bump", id: f.id, issue: a.issue.number });
      continue;
    }
    let owner: Owner = null;
    try {
      owner = ownerOf(exec, run, f);
    } catch (e) {
      notes.push(`owner of ${f.id} unknown: ${(e as Error).message}`);
    }
    gh(
      exec,
      [
        "issue",
        "create",
        "--repo",
        run.repo,
        "--title",
        issueTitle(f),
        "--body",
        newIssueBody({ f, run, seen: a.seen, owner }),
        "--label",
        LABEL,
        ...(owner?.assignable ? ["--assignee", owner.login] : []),
      ],
      true,
    );
    done.push({ action: "create", id: f.id });
  }
  return { done, notes };
}

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? String(r.error ?? ""),
  };
};

function main(argv: string[]) {
  const repo = flag(argv, "repo");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("bad --repo");
  const runId = Number(flag(argv, "run-id"));
  const attempt = Number(flag(argv, "attempt"));
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("bad --run-id");
  if (!Number.isSafeInteger(attempt) || attempt < 2)
    throw new Error("bad --attempt: the tracker needs attempt 2 or later");
  const last = JSON.parse(
    gh(realExec, [
      "api",
      `repos/${repo}/actions/runs/${runId}/attempts/${attempt}`,
    ]),
  ) as Attempt;
  if (last.conclusion !== "success")
    throw new Error(`attempt ${attempt} did not pass (${last.conclusion})`);
  if (!/^[0-9a-f]{40}$/.test(last.head_sha)) throw new Error("bad head sha");
  const run: RunInfo = {
    repo,
    runId,
    attempt,
    sha: last.head_sha,
    url: `https://github.com/${repo}/actions/runs/${runId}`,
  };
  const { done, notes } = track({ exec: realExec, run, nowMs: Date.now() });
  const lines = [
    `Flaky tracker, CI run ${runId} (passed on attempt ${attempt}):`,
    ...(done.length ? [] : ["  no failed test found in the earlier attempts"]),
    ...done.map((d) => `  ${d.action} ${d.issue ? `#${d.issue} ` : ""}${d.id}`),
    ...notes.map((n) => `  note: ${n}`),
  ];
  console.log(lines.join("\n"));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${lines.join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`flaky-tracker: ${(e as Error).message}`);
    process.exit(1);
  }
}
