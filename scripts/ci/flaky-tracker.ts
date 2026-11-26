// The flaky tracker for public CI (cloud #447; the cloud repo has its own for
// its CI and redline-staging, and both behave the same). Tracking only: it
// reruns nothing and blocks nothing. flaky-tracker.yml runs it when a CI run
// passes on attempt 2 or later; runs are serialized per repo (one concurrency
// group, queued). A reconcile (--reconcile), right after every tracker run
// and on dispatch, never on a clock, catches any run that event missed: it
// lists every CI run created in the last RERUN_DAYS plus QUIET_DAYS (plus
// RECONCILE_HOURS of slack) that passed on attempt 2 or later, however long
// ago it passed, and tracks each one the store has no `passed` line for,
// through the same code. So a dropped event is caught by the next completion
// even when it comes QUIET_DAYS after a rerun on the last allowed day. One
// reconcile starts no run after RECONCILE_MS, RECONCILE_CALLS gh calls or
// RECONCILE_LOGS job logs (it always does one), oldest first, and logs "backlog: N left":
// each run is saved as it finishes, so the next completion carries on. That line means the run is fully handled: it is written with the run's
// sightings when nothing is filed, else in its own store comment after every
// filing succeeded (so a failed filing is retried), and on its own when the
// earlier attempts hold no failed test (so the run is not read again).
// Every test that failed on an earlier attempt of that run, with the same
// head commit, failed and then passed with nothing changed.
//
// Where the failures come from: each earlier attempt's failed or timed-out
// job logs.
//   - Vitest: ` RUN  vX /<workspace>/<dir>` names the root, then the summary
//     lists ` FAIL  <file> > <describe> > <test>` (or `<file> [ <file> ]` for
//     a file that failed outside a test). The file is <dir>/<file>.
//   - Playwright (e2e-shard, list reporter, cwd apps/dashboard): `  N failed`
//     then `    [project] › <file>:L:C › <title>` per test.
// A job that failed outside the tests (install, typecheck, lint, the `test`
// and `e2e` roll-ups) parses to no test: it is infrastructure, not a flaky
// test, and only shows in the step summary. Runs from fork PRs count too:
// their logs are anyone's text, so they are only parsed, never run, and every
// title, file and id from them is untrusted (see inert()).
//
// Two in seven days. Every sighting (test, run, attempt, time) is recorded
// first, in one open store issue labelled `flaky-sightings`, as comments by
// github-actions[bot] holding machine-readable lines. A test is filed (its
// `flaky` issue opened, or the open one bumped, with the run links) only when
// it was seen in 2 or more different runs within 7 days of this failure,
// counting this one; a first sighting never files anything. The 7 days are
// measured between the failures' own times (each failed job's completion),
// never from when the tracker runs, so a run the reconcile tracks days late
// files exactly what its event would have. When more than
// MAX_FILED_PER_RUN tests would be filed from one run, one summary issue is
// filed instead of those. A store with more than STORE_MAX_COMMENTS comments
// is closed and continued in a new one that names it, and the read follows
// that chain back over the window.
//
// Untrusted text (test titles, file paths, ids) never carries marker text:
// inert() breaks every `<!--`, `-->` and marker word before it is written,
// titles are code spans, and issue titles lose backticks, `#` and `@`. Ids
// reach markers only as a hex hash. Markers are read only from the trailing
// block a bot comment or bot issue ends with.
//
// One issue per test, keyed on its identity only (suite, repo-relative file,
// title), never its error text. The owner is the last author of the test file
// at the run's head commit, assigned when GitHub allows it, else named in
// plain text.
//
// Usage: node --experimental-strip-types scripts/ci/flaky-tracker.ts --repo o/n --run-id <id> --attempt <n>
//        node --experimental-strip-types scripts/ci/flaky-tracker.ts --repo o/n --reconcile
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
/** More tests than this filed from one run: one summary issue instead. */
export const MAX_FILED_PER_RUN = 5;
/** A store issue with more comments than this is closed and continued. */
export const STORE_MAX_COMMENTS = 2000;
/** Job (and attempt) conclusions that count as failed. */
export const FAILED = new Set(["failure", "timed_out"]);
const SUMMARY_LIST_MAX = 50;
/** The runs an issue's marker keeps, so a tracker rerun can skip its run. */
const SEEN_KEEP = 100;
/** Under GitHub's 65536-character comment and body limit. */
const COMMENT_MAX = 60000;
const TITLE_CLIP = 500;
const STORE_CHAIN_MAX = 10;
/**
 * The workflow files whose runs the tracker watches (flaky-tracker.yml). The
 * reconcile lists runs by file: a run's `name` is its run-name, not the
 * workflow's name, so it is never read.
 */
export const WATCHED = ["ci.yml"];
/**
 * The most time, gh calls and job logs one reconcile spends before it stops
 * starting runs, well inside the job's 10 minutes (on main, the listing alone
 * is about 70 calls, and a run about 5 to 12 at 1 to 2 s each). The rest is
 * the backlog: each run's work is saved in the store as it finishes, and the
 * next CI completion's reconcile carries on, oldest first.
 */
export const RECONCILE_MS = 4 * 60 * 1000;
export const RECONCILE_CALLS = 150;
export const RECONCILE_LOGS = 25;
/** One gh call that takes longer is killed, and retried like a 5xx. */
const GH_TIMEOUT_MS = 120_000;
/** Slack on top of RERUN_DAYS plus QUIET_DAYS in the reconcile's range. */
export const RECONCILE_HOURS = 26;
/** GitHub lets a run be rerun for this many days after it was created. */
export const RERUN_DAYS = 30;
/**
 * The longest stretch with no event (so no reconcile) the reconcile still
 * covers: a run rerun on its last allowed day and then QUIET_DAYS with no
 * completion is still listed when the next completion comes. Every handled
 * run is marked, so listing further back costs only the listing.
 */
export const QUIET_DAYS = 30;
/** list-workflow-runs returns at most this many runs for one query. */
export const LIST_MAX = 1000;
const PER_PAGE = 100;
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

/** The marker key of a test id: a hex hash, so no id text reaches a marker. */
export const keyOf = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 16);

const MARKER_WORD = /flaky-(tracker|key|seen|sightings|summary|prev)/gi;

/**
 * Untrusted text (a test title, file path or id) made unable to open or close
 * an HTML comment or spell a marker word: `<!-` and `->` get a space, so no
 * `<!--` or `-->` (nor `--->`) is left, and `flaky-key` becomes `flaky_key`.
 */
export function inert(s: string): string {
  return s
    .replace(MARKER_WORD, "flaky_$1")
    .replace(/<!-/g, "<! -")
    .replace(/->/g, "- >");
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 3)}...` : s;

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

/** Untrusted text for a body: clipped, inert, in a code span. */
const shown = (s: string) => codeSpan(inert(clip(s, TITLE_CLIP)));

/**
 * Untrusted text for an issue title, where code spans don't render: no
 * backticks, and `#` and `@` swapped for their fullwidth forms, so nothing
 * links an issue or mentions anyone.
 */
export function titleText(s: string): string {
  return inert(s).replace(/`/g, "").replace(/#/g, "＃").replace(/@/g, "＠");
}

// The marker block: the last thing in a bot comment or bot issue body,
// `<!-- flaky-tracker`, one machine-readable line each, then `-->`. Only that
// trailing block is read, and untrusted text can't contain `<!--`, so no text
// before it can forge or end one.
const BLOCK_START = "<!-- flaky-tracker";

export const markerBlock = (lines: string[]) =>
  [BLOCK_START, ...lines, "-->"].join("\n");

/** Where the trailing marker block starts, or -1. */
function blockAt(text: string): number {
  const t = text.trimEnd();
  if (!t.endsWith("\n-->")) return -1;
  const i = t.lastIndexOf(`\n${BLOCK_START}\n`);
  if (i >= 0) return i + 1;
  return t.startsWith(`${BLOCK_START}\n`) ? 0 : -1;
}

export type Recorded = Sighting & { key: string };
/** A tracked run's passing attempt, as `run/attempt`. */
export type Passed = string;
export type Marks = {
  key?: string;
  summary?: number;
  prev?: number;
  seen: Sighting[];
  sightings: Recorded[];
  passed: Passed[];
};

const AT = String.raw`\d{4}-\d\d-\d\dT[\d:]+Z`;
const KEY_RE = /^key ([0-9a-f]{16})$/;
const SUMMARY_RE = /^summary (\d+)$/;
const PREV_RE = /^prev (\d+)$/;
const PASSED_RE = /^passed (\d+\/\d+)$/;
const SEEN_RE = new RegExp(`^seen (${AT}) (\\d+)/(\\d+)$`);
const SIGHTING_RE = new RegExp(
  `^sighting ([0-9a-f]{16}) (\\d+)/(\\d+) (${AT})$`,
);

/** The marks of a bot comment or body's trailing block (empty if none). */
export function parseMarks(text: string): Marks {
  const out: Marks = { seen: [], sightings: [], passed: [] };
  const t = text.replace(/\r/g, "");
  const i = blockAt(t);
  if (i < 0) return out;
  const inner = t
    .trimEnd()
    .slice(i + BLOCK_START.length + 1, -"\n-->".length)
    .split("\n");
  for (const raw of inner) {
    const l = raw.trim();
    let m = KEY_RE.exec(l);
    if (m) out.key = m[1];
    m = SUMMARY_RE.exec(l);
    if (m) out.summary = Number(m[1]);
    m = PREV_RE.exec(l);
    if (m) out.prev = Number(m[1]);
    m = PASSED_RE.exec(l);
    if (m) out.passed.push(m[1] as string);
    m = SEEN_RE.exec(l);
    if (m)
      out.seen.push({
        at: m[1] as string,
        run: Number(m[2]),
        attempt: Number(m[3]),
      });
    m = SIGHTING_RE.exec(l);
    if (m)
      out.sightings.push({
        key: m[1] as string,
        run: Number(m[2]),
        attempt: Number(m[3]),
        at: m[4] as string,
      });
  }
  return out;
}

export const parseStore = (comment: string) => parseMarks(comment).sightings;

const passedMark = (run: RunInfo) => `passed ${run.runId}/${run.attempt}`;

/**
 * The store comment that marks this run handled (`passed run/attempt`, which
 * the reconcile skips): written after every filing for the run succeeded.
 */
export const runDoneComment = (run: RunInfo) =>
  [
    `Run ${run.url} passed on attempt ${run.attempt}: its issues are filed.`,
    "",
    markerBlock([passedMark(run)]),
  ].join("\n");

/**
 * The store comment that marks a run handled whose earlier attempts hold no
 * failed test (only failures outside the tests), so the reconcile, which
 * looks back over the whole rerun period, never reads it again.
 */
export const noTestComment = (run: RunInfo) =>
  [
    `Run ${run.url} passed on attempt ${run.attempt}: no failed test in its earlier attempts.`,
    "",
    markerBlock([passedMark(run)]),
  ].join("\n");

/**
 * The store comments for this run's sightings, split to stay under GitHub's
 * comment limit. Each ends with its own marker block. Only the last one names
 * the run's passing attempt (`passed run/attempt`), and only when marksRun:
 * a split part never marks the run on its own.
 */
export function storeComments(
  run: RunInfo,
  rows: { f: Failure; sighting: Sighting }[],
  marksRun = true,
): string[] {
  const head = `Run ${run.url} passed on attempt ${run.attempt} after these failed:`;
  const out: string[] = [];
  let text: string[] = [];
  let marks: string[] = [];
  let size = 0;
  const flush = (last: boolean) => {
    if (!marks.length) return;
    out.push(
      [
        head,
        ...text,
        "",
        markerBlock([...(last && marksRun ? [passedMark(run)] : []), ...marks]),
      ].join("\n"),
    );
    text = [];
    marks = [];
    size = 0;
  };
  for (const { f, sighting: s } of rows) {
    const t = `- attempt ${s.attempt}: ${shown(f.title)} in ${shown(f.file)}`;
    const m = `sighting ${keyOf(f.id)} ${s.run}/${s.attempt} ${s.at}`;
    if (size + t.length + m.length + 2 > COMMENT_MAX - head.length - 100)
      flush(false);
    text.push(t);
    marks.push(m);
    size += t.length + m.length + 2;
  }
  flush(true);
  return out;
}

/**
 * The sightings within WINDOW_DAYS of `atMs` (a failure's own time), before
 * or after it, one per run (the earliest). Never the tracker's clock: a run
 * tracked late, or out of order, is judged as it would have been on time.
 */
export function inWindow(s: Sighting[], atMs: number): Sighting[] {
  const span = WINDOW_DAYS * DAY_MS;
  const byRun = new Map<number, Sighting>();
  for (const x of s) {
    if (Math.abs(Date.parse(x.at) - atMs) > span) continue;
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

const runUrl = (repo: string, s: { run: number; attempt: number }) =>
  `https://github.com/${repo}/actions/runs/${s.run}/attempts/${s.attempt}`;

export function issueTitle(f: Failure): string {
  return clip(
    `Flaky: ${titleText(f.title)} (${titleText(f.file.split("/").pop() ?? "")})`,
    240,
  );
}

export type Owner = { login: string; assignable: boolean } | null;

const seenLines = (key: string, seen: Sighting[]) => [
  `key ${key}`,
  ...seen.slice(-SEEN_KEEP).map((x) => `seen ${x.at} ${x.run}/${x.attempt}`),
];

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
    `A ${f.suite === "vitest" ? "Vitest" : "Playwright"} test in CI failed and then passed on a rerun of the same run, with the same commit, in ${o.seen.length} runs within ${WINDOW_DAYS} days. Nothing changed between the attempts, so the test is flaky.`,
    "",
    `Test: ${shown(f.title)}`,
    `File: ${shown(f.file)}`,
    `Last author of the file at ${run.sha.slice(0, 12)}: ${owner}`,
    "",
    "Failed on:",
    ...o.seen.map((s) => `- ${runUrl(run.repo, s)} (${s.at})`),
    `Passed on: ${runUrl(run.repo, { run: run.runId, attempt: run.attempt })}`,
    "",
    "This issue only tracks the flake: it changes no retry and blocks nothing. Fix the test, or the race it found, and close the issue. A later flake of the same test is noted here while it is open.",
    "",
    markerBlock(seenLines(keyOf(f.id), o.seen)),
  ].join("\n");
}

/** The body with its trailing marker block replaced by the new sightings. */
export function bumpedBody(
  body: string,
  key: string,
  seen: Sighting[],
): string {
  const i = blockAt(body.replace(/\r/g, ""));
  const head = (i < 0 ? body : body.replace(/\r/g, "").slice(0, i)).trimEnd();
  return `${head}\n\n${markerBlock(seenLines(key, seen))}`;
}

export function bumpComment(o: {
  run: RunInfo;
  sighting: Sighting;
  window: Sighting[];
}): string {
  return [
    `Failed again on ${runUrl(o.run.repo, o.sighting)}, passed on attempt ${o.run.attempt}.`,
    "",
    `This test failed in ${o.window.length} runs within ${WINDOW_DAYS} days:`,
    ...o.window.map((s) => `- ${runUrl(o.run.repo, s)} (${s.at})`),
  ].join("\n");
}

export type Issue = { number: number; body: string };

export type Action =
  | { kind: "record"; f: Failure; sighting: Sighting }
  | {
      kind: "create";
      f: Failure;
      sighting: Sighting;
      seen: Sighting[];
      window: Sighting[];
    }
  | {
      kind: "bump";
      f: Failure;
      sighting: Sighting;
      issue: Issue;
      seen: Sighting[];
      window: Sighting[];
    }
  | { kind: "skip"; f: Failure; sighting: Sighting; issue: number };

/**
 * What one test's sighting does, given the store's sightings of it (any run)
 * and the open `flaky` issues. Skip when its open issue notes this run
 * already (a tracker rerun). Otherwise file it only when it was seen in 2 or
 * more different runs within WINDOW_DAYS of this sighting's own time,
 * counting this one: bump its open issue, or open one. Else only record it.
 * When the tracker runs never decides it, so a late replay files the same.
 */
export function decide(o: {
  f: Failure;
  sighting: Sighting;
  recorded: Recorded[];
  open: Issue[];
}): Action {
  const { f, sighting } = o;
  const key = keyOf(f.id);
  const issue = o.open.find((i) => parseMarks(i.body).key === key);
  const prior = issue ? parseMarks(issue.body).seen : [];
  if (issue && prior.some((p) => p.run === sighting.run))
    return { kind: "skip", f, sighting, issue: issue.number };
  const window = inWindow(
    [...o.recorded.filter((r) => r.key === key), sighting],
    Date.parse(sighting.at),
  );
  if (window.length < 2) return { kind: "record", f, sighting };
  if (issue)
    return {
      kind: "bump",
      f,
      sighting,
      issue,
      seen: [...prior, sighting],
      window,
    };
  return { kind: "create", f, sighting, seen: window, window };
}

type Attempt = {
  conclusion: string | null;
  head_sha: string;
};
type Job = {
  id: number;
  name: string;
  conclusion: string | null;
  completed_at: string | null;
};

/**
 * The run to track, from its passing attempt. A fork PR's run counts like any
 * other: its logs are only read as text.
 */
export function loadRun(
  exec: Exec,
  repo: string,
  runId: number,
  attempt: number,
): RunInfo {
  const last = JSON.parse(
    gh(exec, [
      "api",
      `repos/${repo}/actions/runs/${runId}/attempts/${attempt}`,
    ]),
  ) as Attempt;
  if (last.conclusion !== "success")
    throw new Error(`attempt ${attempt} did not pass (${last.conclusion})`);
  if (!/^[0-9a-f]{40}$/.test(last.head_sha)) throw new Error("bad head sha");
  return {
    repo,
    runId,
    attempt,
    sha: last.head_sha,
    url: `https://github.com/${repo}/actions/runs/${runId}`,
  };
}

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
 * Every test that failed on an earlier failed or timed-out attempt with the
 * same head sha, once each (its earliest attempt), and notes on what else
 * failed.
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
    if (!FAILED.has(att.conclusion ?? "")) continue;
    if (att.head_sha !== run.sha) {
      notes.push(`attempt ${a}: another commit (${att.head_sha}), skipped`);
      continue;
    }
    const jobs = (
      JSON.parse(
        gh(exec, ["api", `${base}/attempts/${a}/jobs?per_page=100`]),
      ) as { jobs: Job[] }
    ).jobs.filter((j) => FAILED.has(j.conclusion ?? ""));
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
  // gh prints nothing at all, not `[]`, when no label matches the search.
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
    ]).trim() || "[]",
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

type IssueInfo = {
  number: number;
  comments: number;
  created_at: string;
  body: string | null;
  user?: { login?: string } | null;
};

const issueInfo = (exec: Exec, repo: string, n: number) =>
  JSON.parse(gh(exec, ["api", `repos/${repo}/issues/${n}`])) as IssueInfo;

/**
 * The store issues to read: the open ones, and each one's predecessor (its
 * bot-written `prev` mark) while the store began after `from` (by default the
 * window's start).
 */
export function storeChain(
  exec: Exec,
  repo: string,
  open: Issue[],
  nowMs: number,
  from = nowMs - WINDOW_DAYS * DAY_MS,
): number[] {
  const out: number[] = [];
  const queue = open.map((i) => i.number);
  while (queue.length && out.length < STORE_CHAIN_MAX) {
    const n = queue.shift() as number;
    if (out.includes(n)) continue;
    const info = issueInfo(exec, repo, n);
    if (!byBot(info.user?.login)) continue;
    out.push(n);
    const prev = parseMarks(info.body ?? "").prev;
    if (prev && Date.parse(info.created_at) > from) queue.push(prev);
  }
  return out;
}

/**
 * The stores' sightings and passed runs since `fromMs` (by default when the
 * window opened), from bot comments only.
 */
function readStore(
  exec: Exec,
  repo: string,
  stores: number[],
  nowMs: number,
  fromMs = nowMs - WINDOW_DAYS * DAY_MS,
): { sightings: Recorded[]; passed: Set<Passed> } {
  const since = new Date(fromMs).toISOString();
  const sightings: Recorded[] = [];
  const passed = new Set<Passed>();
  for (const n of stores) {
    const lines = gh(exec, [
      "api",
      "--paginate",
      `repos/${repo}/issues/${n}/comments?since=${since}&per_page=100`,
      "--jq",
      `.[] | select(.user.login == "${BOT}") | .body | @json`,
    ]);
    for (const l of lines.split("\n")) {
      if (!l.trim()) continue;
      const m = parseMarks(JSON.parse(l) as string);
      sightings.push(...m.sightings);
      for (const p of m.passed) passed.add(p);
    }
  }
  return { sightings, passed };
}

const STORE_TITLE = "Flaky test sightings (the flaky tracker's store)";

export function storeBody(prev?: number): string {
  return [
    "The flaky tracker's store (scripts/ci/flaky-tracker.ts). Each comment by github-actions[bot] lists the tests that failed and then passed on a rerun of one CI run, one machine-readable line per test in its trailing HTML comment. A test seen in two runs within 7 days gets its own issue labelled `flaky`.",
    "",
    `Keep this issue open; closing it starts a new store and forgets the last 7 days. Past ${STORE_MAX_COMMENTS} comments the tracker closes it and continues in a new one.`,
    ...(prev
      ? ["", `Continues #${prev}.`, "", markerBlock([`prev ${prev}`])]
      : []),
  ].join("\n");
}

function createIssue(
  exec: Exec,
  repo: string,
  o: { title: string; body: string; label: string; assignee?: string },
) {
  gh(
    exec,
    [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      o.title,
      "--body",
      o.body,
      "--label",
      o.label,
      ...(o.assignee ? ["--assignee", o.assignee] : []),
    ],
    true,
  );
}

const comment = (exec: Exec, repo: string, n: number, body: string) =>
  gh(
    exec,
    ["issue", "comment", String(n), "--repo", repo, "--body", body],
    true,
  );

/**
 * The open store to write to (the newest), and every store to read. A store
 * past STORE_MAX_COMMENTS is continued in a new one first, then closed.
 */
function openStore(
  exec: Exec,
  repo: string,
  nowMs: number,
  fromMs: number,
  notes: string[],
): { store: number; read: number[] } {
  ensureLabel(
    exec,
    repo,
    STORE_LABEL,
    "The flaky tracker's store of sightings",
  );
  let open = listOpen(exec, repo, STORE_LABEL);
  if (!open.length) {
    createIssue(exec, repo, {
      title: STORE_TITLE,
      body: storeBody(),
      label: STORE_LABEL,
    });
    open = listOpen(exec, repo, STORE_LABEL);
  }
  let newest = open.at(-1);
  if (!newest) throw new Error("no store issue after creating one");
  const full = issueInfo(exec, repo, newest.number).comments;
  if (full > STORE_MAX_COMMENTS) {
    const old = newest.number;
    createIssue(exec, repo, {
      title: STORE_TITLE,
      body: storeBody(old),
      label: STORE_LABEL,
    });
    open = listOpen(exec, repo, STORE_LABEL);
    newest = open.at(-1);
    if (!newest || newest.number === old)
      throw new Error("no new store issue after creating one");
    gh(
      exec,
      [
        "issue",
        "close",
        String(old),
        "--repo",
        repo,
        "--comment",
        `This store is full (${full} comments). The flaky tracker continues in #${newest.number} and still reads this one for the last ${WINDOW_DAYS} days.`,
      ],
      true,
    );
    notes.push(`store #${old} full, continued in #${newest.number}`);
  }
  return {
    store: newest.number,
    read: storeChain(exec, repo, open, nowMs, fromMs),
  };
}

export type Done = {
  action: Action["kind"] | "summary";
  id: string;
  issue?: number;
};

export function summaryIssue(
  run: RunInfo,
  filed: (Action & { kind: "create" | "bump" })[],
): { title: string; body: string } {
  const list = filed
    .slice(0, SUMMARY_LIST_MAX)
    .map(
      (a) =>
        `- ${shown(a.f.title)} in ${shown(a.f.file)}: ${a.window.map((s) => runUrl(run.repo, s)).join(", ")}`,
    );
  const more = filed.length - list.length;
  return {
    title: `Flaky: ${filed.length} tests failed in two runs within ${WINDOW_DAYS} days, again on CI run ${run.runId}`,
    body: [
      `${filed.length} tests failed and then passed on a rerun of CI run ${run.runId} (passed on attempt ${run.attempt}, same commit), and each did the same in another run within ${WINDOW_DAYS} days. More than ${MAX_FILED_PER_RUN} at once usually means the environment broke, not that each test is flaky, so this one issue stands in for their own issues and bumps. Every sighting is recorded in the store.`,
      "",
      `Passed on: ${runUrl(run.repo, { run: run.runId, attempt: run.attempt })}`,
      "",
      "Tests, with the runs they failed on:",
      ...list,
      ...(more > 0 ? [`- and ${more} more`] : []),
      "",
      "Look at the failed attempts. If it was the environment, close this issue.",
      "",
      markerBlock([`summary ${run.runId}`]),
    ].join("\n"),
  };
}

export function track(o: { exec: Exec; run: RunInfo; nowMs: number }): {
  done: Done[];
  notes: string[];
} {
  const { exec, run, nowMs } = o;
  const { found, notes } = collect(exec, run);

  // The store is read from WINDOW_DAYS before this run's earliest failure,
  // not before now: a run tracked days late still sees the sightings it
  // pairs with (decide() judges by the failures' own times).
  const fromMs =
    Math.min(nowMs, ...found.map(({ sighting }) => Date.parse(sighting.at))) -
    WINDOW_DAYS * DAY_MS;
  const { store, read } = openStore(exec, run.repo, nowMs, fromMs, notes);
  const kept = readStore(exec, run.repo, read, nowMs, fromMs);
  const stored = kept.sightings;
  const marked = kept.passed.has(`${run.runId}/${run.attempt}`);
  // No failed test, only failures outside the tests: nothing to record, but
  // the run is marked handled, so the reconcile never reads it again.
  if (!found.length) {
    if (!marked) comment(exec, run.repo, store, noTestComment(run));
    return { done: [], notes };
  }
  const fresh = found.filter(
    ({ f, sighting }) =>
      !stored.some((r) => r.key === keyOf(f.id) && r.run === sighting.run),
  );
  const recorded: Recorded[] = [
    ...stored,
    ...fresh.map(({ f, sighting }) => ({ key: keyOf(f.id), ...sighting })),
  ];

  ensureLabel(
    exec,
    run.repo,
    LABEL,
    "A test that failed and then passed on a rerun, in two runs within 7 days",
  );
  // Tracker runs are serialized (flaky-tracker.yml), so one list is current.
  const open = listOpen(exec, run.repo, LABEL);
  const actions = found.map(({ f, sighting }) =>
    decide({ f, sighting, recorded, open }),
  );
  const done: Done[] = [];
  const filed: (Action & { kind: "create" | "bump" })[] = [];
  for (const a of actions) {
    if (a.kind === "create" || a.kind === "bump") filed.push(a);
    else
      done.push({
        action: a.kind,
        id: a.f.id,
        ...(a.kind === "skip" ? { issue: a.issue } : {}),
      });
  }

  // Record every sighting before any filing, so the evidence survives a
  // failure below; a rerun of the tracker finds this run's lines there and
  // adds none. The run marker (`passed run/attempt`) means "fully handled",
  // and the reconcile skips a marked run. With nothing to file it rides on
  // the last store part. With filings it is written last (finish), so a
  // failed create or bump leaves the run unmarked and the next reconcile
  // tracks it again, where decide() sees the stored sightings.
  for (const body of storeComments(run, fresh, !filed.length))
    comment(exec, run.repo, store, body);
  const finish = () => {
    if (!marked && filed.length)
      comment(exec, run.repo, store, runDoneComment(run));
    return { done, notes };
  };

  if (filed.length > MAX_FILED_PER_RUN) {
    const had = open.find((i) => parseMarks(i.body).summary === run.runId);
    if (had)
      done.push({
        action: "skip",
        id: `summary:${run.runId}`,
        issue: had.number,
      });
    else {
      createIssue(exec, run.repo, {
        ...summaryIssue(run, filed),
        label: LABEL,
      });
      done.push({ action: "summary", id: `summary:${run.runId}` });
    }
    return finish();
  }

  for (const a of filed) {
    const { f, sighting } = a;
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
          bumpedBody(a.issue.body, keyOf(f.id), a.seen),
        ],
        true,
      );
      comment(
        exec,
        run.repo,
        a.issue.number,
        bumpComment({ run, sighting, window: a.window }),
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
    createIssue(exec, run.repo, {
      title: issueTitle(f),
      body: newIssueBody({ f, run, seen: a.seen, owner }),
      label: LABEL,
      ...(owner?.assignable ? { assignee: owner.login } : {}),
    });
    done.push({ action: "create", id: f.id });
  }
  return finish();
}

const isoSec = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** A listed run, as listRuns asks the API for it. */
type RunRow = {
  id: number;
  run_attempt: number;
  conclusion: string | null;
};

/**
 * Every run a list-workflow-runs query (`path`, with no created, page or
 * per_page) finds created from `from` to `to` (ms, whole seconds, both ends
 * included). GitHub returns at most LIST_MAX runs for one query, so a range
 * whose total_count is LIST_MAX or more is halved and each half listed the
 * same way. A one-second range that still has that many throws: the list
 * would be incomplete.
 */
export function listRuns(
  exec: Exec,
  path: string,
  from: number,
  to: number,
): RunRow[] {
  const range = encodeURIComponent(`${isoSec(from)}..${isoSec(to)}`);
  const page = (p: number) =>
    JSON.parse(
      gh(exec, [
        "api",
        `${path}&created=${range}&per_page=${PER_PAGE}&page=${p}`,
        "--jq",
        "{total_count, workflow_runs: [.workflow_runs[] | {id, run_attempt, conclusion}]}",
      ]),
    ) as { total_count: number; workflow_runs: RunRow[] };
  const first = page(1);
  if (first.total_count >= LIST_MAX) {
    if (to - from < 1000)
      throw new Error(
        `${first.total_count} runs created at ${isoSec(from)}: GitHub lists at most ${LIST_MAX} for one query, so the reconcile can't see them all`,
      );
    const mid = from + Math.floor((to - from) / 2000) * 1000;
    return [
      ...listRuns(exec, path, from, mid),
      ...listRuns(exec, path, mid + 1000, to),
    ];
  }
  const out = [...first.workflow_runs];
  for (let p = 2; (p - 1) * PER_PAGE < first.total_count; p++)
    out.push(...page(p).workflow_runs);
  return out;
}

/**
 * The start of the reconcile's range, in whole seconds: RERUN_DAYS plus
 * QUIET_DAYS plus RECONCILE_HOURS ago. A run can be rerun up to RERUN_DAYS
 * after it was created, and the next completion may come up to QUIET_DAYS
 * after that rerun, so the range never depends on when the next event comes
 * within that bound.
 */
export const reconcileFrom = (nowMs: number) =>
  Math.floor(nowMs / 1000) * 1000 -
  (RERUN_DAYS + QUIET_DAYS) * DAY_MS -
  RECONCILE_HOURS * 3600 * 1000;

/**
 * The runs the reconcile looks at: every run of the watched workflows created
 * since reconcileFrom whose latest attempt (2 or later) passed, however long
 * ago it passed, fork PRs' runs too, oldest first. No update window: a run
 * whose event was dropped stays a candidate until the store marks it, even
 * after QUIET_DAYS with no event. Whether a failure counts toward two in seven days is decided later, by the failed
 * job's completion time, never by the run's creation.
 */
export function recentRuns(
  exec: Exec,
  repo: string,
  nowMs: number,
): { runId: number; attempt: number }[] {
  const to = Math.floor(nowMs / 1000) * 1000;
  const from = reconcileFrom(nowMs);
  const out = new Map<number, number>();
  for (const wf of WATCHED)
    for (const r of listRuns(
      exec,
      `repos/${repo}/actions/workflows/${wf}/runs?status=success`,
      from,
      to,
    ))
      if (r.conclusion === "success" && r.run_attempt > 1)
        out.set(r.id, r.run_attempt);
  return [...out]
    .map(([runId, attempt]) => ({ runId, attempt }))
    .sort((a, b) => a.runId - b.runId);
}

/**
 * The `passed run/attempt` lines of the stores, without creating one, over
 * the whole reconcile range: a run's mark is written after the run was
 * created, so every listed run's mark is in a comment since reconcileFrom.
 */
function passedRuns(exec: Exec, repo: string, nowMs: number): Set<Passed> {
  const open = listOpen(exec, repo, STORE_LABEL);
  if (!open.length) return new Set();
  const from = reconcileFrom(nowMs);
  return readStore(
    exec,
    repo,
    storeChain(exec, repo, open, nowMs, from),
    nowMs,
    from,
  ).passed;
}

export type Reconciled = {
  runId: number;
  attempt: number;
  /** "left": not started this time (the budget ran out); the next reconcile takes it. */
  result: "recorded already" | "tracked" | "error" | "left";
  done: Done[];
  notes: string[];
};

/**
 * Tracks the recent runs the workflow_run event missed, oldest first. A run
 * the store already has (its `passed run/attempt` line) is skipped before any
 * other read, so it adds nothing and bumps nothing. Each other run goes
 * through loadRun and track like an event would, and is saved (marked) in the
 * store when it finishes, so a job cut off later loses none of it. One run's
 * error doesn't stop the rest. Once `ms` milliseconds, `calls` gh calls or
 * `logs` job logs are spent, no further run is started (one always is): those are "left", and the next
 * reconcile (the next CI completion) takes them, oldest first. Oldest first
 * because the oldest is nearest to leaving the range; a quiet stretch of up
 * to QUIET_DAYS only delays them. `onRun` sees each result as it is made.
 */
export function reconcile(o: {
  exec: Exec;
  repo: string;
  nowMs: number;
  calls?: number;
  logs?: number;
  ms?: number;
  /** The wall clock the time budget reads (a fake one in tests). */
  clock?: () => number;
  onRun?: (r: Reconciled) => void;
}): Reconciled[] {
  const { repo, nowMs } = o;
  const clock = o.clock ?? Date.now;
  const start = clock();
  const spent = { calls: 0, logs: 0 };
  const exec: Exec = (cmd, args) => {
    spent.calls++;
    if (args.some((a) => /\/actions\/jobs\/\d+\/logs$/.test(a))) spent.logs++;
    return o.exec(cmd, args);
  };
  const runs = recentRuns(exec, repo, nowMs);
  if (!runs.length) return [];
  const passed = passedRuns(exec, repo, nowMs);
  const out: Reconciled[] = [];
  let started = 0;
  const push = (r: Reconciled) => {
    out.push(r);
    o.onRun?.(r);
  };
  for (const { runId, attempt } of runs) {
    const base = { runId, attempt, done: [], notes: [] };
    if (passed.has(`${runId}/${attempt}`)) {
      out.push({ ...base, result: "recorded already" });
      continue;
    }
    // At least one run each time, so a listing that alone spends the budget
    // still never stops the backlog.
    if (
      started > 0 &&
      (spent.calls >= (o.calls ?? RECONCILE_CALLS) ||
        spent.logs >= (o.logs ?? RECONCILE_LOGS) ||
        clock() - start >= (o.ms ?? RECONCILE_MS))
    ) {
      out.push({ ...base, result: "left" });
      continue;
    }
    started++;
    try {
      const run = loadRun(exec, repo, runId, attempt);
      push({ ...base, result: "tracked", ...track({ exec, run, nowMs }) });
    } catch (e) {
      push({ ...base, result: "error", notes: [(e as Error).message] });
    }
  }
  return out;
}

/** The step summary's lines for a reconcile: each run it worked on, then the backlog. */
export function reconcileLines(all: Reconciled[]): string[] {
  const worked = all.filter(
    (r) => r.result === "tracked" || r.result === "error",
  );
  const left = all.filter((r) => r.result === "left").length;
  return [
    `Flaky tracker reconcile: ${all.length} runs created in the last ${RERUN_DAYS + QUIET_DAYS} days and ${RECONCILE_HOURS} hours passed on attempt 2 or later; ${all.length - worked.length - left} recorded already, ${worked.length} worked on now`,
    ...worked.flatMap((r) => runResultLines(r)),
    `backlog: ${left} left${left ? " (the next CI completion's reconcile carries on)" : ""}`,
  ];
}

const runResultLines = (r: Reconciled) => [
  `- CI run ${r.runId} attempt ${r.attempt}: ${r.result}`,
  ...doneLines(r.done, r.notes),
];

const doneLines = (done: Done[], notes: string[]) => [
  ...done.map((d) => `  ${d.action} ${d.issue ? `#${d.issue} ` : ""}${d.id}`),
  ...notes.map((n) => `  note: ${n}`),
];

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: GH_TIMEOUT_MS,
  });
  // A killed call (the timeout) says "timed out", which gh() retries.
  const err = r.error
    ? /ETIMEDOUT/.test(String(r.error))
      ? `timed out after ${GH_TIMEOUT_MS / 1000} s`
      : String(r.error)
    : "";
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: err || (r.stderr ?? ""),
  };
};

function main(argv: string[]) {
  const repo = flag(argv, "repo");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("bad --repo");
  if (argv.includes("--reconcile")) return mainReconcile(repo);
  const runId = Number(flag(argv, "run-id"));
  const attempt = Number(flag(argv, "attempt"));
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("bad --run-id");
  if (!Number.isSafeInteger(attempt) || attempt < 2)
    throw new Error("bad --attempt: the tracker needs attempt 2 or later");
  const run = loadRun(realExec, repo, runId, attempt);
  const lines = [
    `Flaky tracker, CI run ${runId} (passed on attempt ${attempt}):`,
  ];
  const { done, notes } = track({ exec: realExec, run, nowMs: Date.now() });
  lines.push(
    ...(done.length ? [] : ["  no failed test found in the earlier attempts"]),
    ...doneLines(done, notes),
  );
  report(lines);
}

/**
 * The step summary is markdown and the ids come from job logs (a fork PR's
 * too): a fence longer than any backtick run in them keeps it all plain text.
 */
export function summaryText(lines: string[]): string {
  const text = lines.map(inert).join("\n");
  const fence = "`".repeat(
    Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)),
  );
  return `${fence}\n${text}\n${fence}\n`;
}

function report(lines: string[]) {
  console.log(lines.join("\n"));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, summaryText(lines));
}

function mainReconcile(repo: string) {
  // Each run's result goes to the log as it is made, so a job cut off still
  // shows what it saved.
  const all = reconcile({
    exec: realExec,
    repo,
    nowMs: Date.now(),
    onRun: (r) => console.log(runResultLines(r).map(inert).join("\n")),
  });
  report(reconcileLines(all));
  if (all.some((r) => r.result === "error"))
    throw new Error("a run failed to reconcile (see above)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`flaky-tracker: ${(e as Error).message}`);
    process.exit(1);
  }
}
