// cloud #447: the public CI flaky tracker. The vitest fixture is an excerpt of
// run 45651408126 attempt 1, job test-shard (server); the Playwright one
// follows the list reporter's summary (lib/runner, generateSummaryMessage).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  BOT,
  bumpedBody,
  codeSpan,
  decide,
  type Exec,
  type Failure,
  inert,
  issueTitle,
  keyOf,
  LIST_MAX,
  loadRun,
  MAX_FILED_PER_RUN,
  markerBlock,
  newIssueBody,
  parseMarks,
  parsePlaywright,
  parseStore,
  parseVitest,
  RECONCILE_HOURS,
  RERUN_DAYS,
  type Recorded,
  type RunInfo,
  recentRuns,
  reconcile,
  repoDir,
  type Sighting,
  STORE_MAX_COMMENTS,
  sleeper,
  storeBody,
  storeComments,
  summaryText,
  track,
} from "./flaky-tracker.ts";

const E = "\u001b";
const VITEST_LOG = [
  "2026-11-25T16:10:09.0088001Z  RUN  v4.1.12 /home/runner/work/open-artifacts/open-artifacts/apps/server",
  "2026-11-25T16:16:01.8753635Z  ❯ test/comments.withdraw.test.ts (17 tests | 1 failed) 4080ms",
  "2026-11-25T16:16:01.8765054Z      × a partial failure is reported, and withdraw_ask with replacedBy finishes it 199ms",
  `2026-11-25T16:27:12.1775979Z ${E}[31m⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯${E}[39m`,
  `2026-11-25T16:27:12.1777909Z ${E}[41m${E}[1m FAIL ${E}[22m${E}[49m test/comments.withdraw.test.ts${E}[2m > ${E}[22mreplace${E}[2m > ${E}[22ma partial failure is reported, and withdraw_ask with replacedBy finishes it`,
  "2026-11-25T16:27:12.1784039Z TypeError: .toMatch() expects to receive a string, but got undefined",
  "2026-11-25T16:27:12.1978127Z  Test Files  1 failed | 334 passed (335)",
  // A second package of the same job (`pnpm -r test`), and a file that failed outside a test.
  "2026-11-25T16:33:51.1278257Z  RUN  v4.1.12 /home/runner/work/open-artifacts/open-artifacts/scripts/setup",
  "2026-11-25T16:33:58.1739952Z  FAIL  test/rebuild.test.ts [ test/rebuild.test.ts ]",
  "2026-11-25T16:34:05.1065418Z  RUN  v4.1.12 /__w/open-artifacts/open-artifacts/packages/ui",
  "2026-11-25T16:34:06.0000000Z  FAIL  |chromium| test/button.test.tsx > Button > focus ring",
].join("\n");

const PW_LOG = [
  "2026-11-25T16:33:38.0957120Z   ✘   2 e2e/doc-versions.spec.ts:87:3 › light 1280 › the doc's versions @smoke (3.0s)",
  "2026-11-25T16:34:00.0000000Z   2 failed",
  "2026-11-25T16:34:00.0000001Z     e2e/doc-versions.spec.ts:87:3 › light 1280 › the doc's versions @smoke ",
  "2026-11-25T16:34:00.0000002Z     [chromium] › e2e/real/share.spec.ts:12:1 › share › a link opens ",
  "2026-11-25T16:34:00.0000003Z   12 passed (23.6s)",
].join("\n");

describe("parseVitest", () => {
  it("names each FAIL line with its repo-relative file, per RUN root", () => {
    expect(parseVitest(VITEST_LOG)).toEqual([
      {
        suite: "vitest",
        id: "vitest:apps/server/test/comments.withdraw.test.ts:replace > a partial failure is reported, and withdraw_ask with replacedBy finishes it",
        title:
          "replace > a partial failure is reported, and withdraw_ask with replacedBy finishes it",
        file: "apps/server/test/comments.withdraw.test.ts",
      },
      {
        suite: "vitest",
        id: "vitest:scripts/setup/test/rebuild.test.ts:(file failed outside a test)",
        title: "(file failed outside a test)",
        file: "scripts/setup/test/rebuild.test.ts",
      },
      {
        suite: "vitest",
        id: "vitest:packages/ui/test/button.test.tsx:Button > focus ring",
        title: "Button > focus ring",
        file: "packages/ui/test/button.test.tsx",
      },
    ]);
  });

  it("finds nothing in a job that failed outside the tests", () => {
    expect(
      parseVitest(
        "2026-11-25T16:09:35Z ERR_PNPM_FETCH_503 GET https://registry.npmjs.org/x\n##[error]Process completed with exit code 1.",
      ),
    ).toEqual([]);
  });

  it("maps runner paths to repo-relative dirs", () => {
    expect(repoDir("/home/runner/work/open-artifacts/open-artifacts")).toBe("");
    expect(repoDir("/__w/r/r/apps/landing/")).toBe("apps/landing");
  });
});

describe("parsePlaywright", () => {
  it("names each test of the `N failed` list under apps/dashboard, with or without a project", () => {
    expect(parsePlaywright(PW_LOG).map((f) => [f.file, f.title])).toEqual([
      [
        "apps/dashboard/e2e/doc-versions.spec.ts",
        "light 1280 › the doc's versions @smoke",
      ],
      ["apps/dashboard/e2e/real/share.spec.ts", "share › a link opens"],
    ]);
  });
});

const REPO = "open-artifacts-ai/open-artifacts";
const SHA = "a".repeat(40);
const RUN: RunInfo = {
  repo: REPO,
  runId: 900,
  attempt: 2,
  sha: SHA,
  url: `https://github.com/${REPO}/actions/runs/900`,
};
const NOW = Date.parse("2026-11-26T12:00:00Z");
const F: Failure = {
  suite: "vitest",
  id: "vitest:apps/server/test/a.test.ts:x",
  title: "x",
  file: "apps/server/test/a.test.ts",
};
const S: Sighting = { at: "2026-11-26T10:00:00Z", run: 900, attempt: 1 };
const rec = (run: number, at: string, id = F.id): Recorded => ({
  key: keyOf(id),
  run,
  attempt: 1,
  at,
});
const issueBody = (seen: Sighting[], id = F.id) =>
  `hi\n\n${markerBlock([`key ${keyOf(id)}`, ...seen.map((s) => `seen ${s.at} ${s.run}/${s.attempt}`)])}`;

describe("the workflow", () => {
  const wf = parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../.github/workflows/flaky-tracker.yml",
      ),
      "utf8",
    ),
  );

  it("serializes every tracker run in one concurrency group with no per-run part, queueing every pending run", () => {
    const jobs = Object.values(wf.jobs) as {
      concurrency?: {
        group: string;
        "cancel-in-progress": boolean;
        queue: string;
      };
    }[];
    expect(jobs).toHaveLength(1);
    expect(wf.concurrency).toBeUndefined();
    const c = jobs[0]?.concurrency;
    expect(c?.group).toBe("flaky-tracker");
    expect(c?.group).not.toContain("${{");
    // queue: max keeps up to 100 pending runs instead of only the newest; it
    // can't be combined with cancel-in-progress true.
    expect(c?.queue).toBe("max");
    expect(c?.["cancel-in-progress"]).toBe(false);
  });

  it("names the watched workflow by its file, never by workflow_run.name (the run-name)", () => {
    const text = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../.github/workflows/flaky-tracker.yml",
      ),
      "utf8",
    );
    // Only in comments: no expression or condition reads it.
    expect(text).not.toMatch(
      /\$\{\{[^}]*workflow_run\.name|workflow_run\.name\s*[!=]=/,
    );
    expect(JSON.stringify(wf.jobs)).not.toContain("workflow_run.name");
    expect(wf.jobs.track.if).toContain(
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
    );
  });

  it("counts runs from forks, but only ever runs this repo's default branch", () => {
    expect(wf.jobs.track.if).not.toContain("head_repository");
    const steps = wf.jobs.track.steps as {
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
    }[];
    // No ref or repository: on workflow_run that is the default branch, never
    // the run's head. Only scripts/ci, and no token left in the checkout.
    expect(
      steps.filter((s) => s.uses?.startsWith("actions/checkout@")),
    ).toEqual([
      {
        uses: expect.any(String),
        with: { "sparse-checkout": "scripts/ci", "persist-credentials": false },
      },
    ]);
    // A fork's values reach a script only through env, never an expression.
    for (const s of steps) if (s.run) expect(s.run).not.toContain("${{");
  });

  it("reconciles after every CI completion and on dispatch, never on a clock, through the same script", () => {
    // cloud #264: event-only. A dropped tracker event is caught by the next
    // CI completion's reconcile.
    expect(wf.on).toEqual({
      workflow_run: { workflows: ["CI"], types: ["completed"] },
      workflow_dispatch: null,
    });
    expect(wf.on.schedule).toBeUndefined();
    expect(String(wf.jobs.track.if).replace(/\s+/g, " ").trim()).toBe(
      "github.repository == 'open-artifacts-ai/open-artifacts' && github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || (github.event.workflow_run.path == '.github/workflows/ci.yml' && github.event.workflow_run.conclusion != 'cancelled' && github.event.workflow_run.conclusion != 'skipped'))",
    );
    const steps = wf.jobs.track.steps as { if?: string; run?: string }[];
    const event = steps.find((s) => s.run?.includes("--run-id"));
    const recon = steps.find((s) => s.run?.includes("--reconcile"));
    // The event's own run only when it passed on attempt 2 or later.
    expect(String(event?.if).replace(/\s+/g, " ").trim()).toBe(
      "github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.run_attempt > 1",
    );
    // No condition: every tracker run reconciles, right after the record step.
    expect(recon?.if).toBeUndefined();
    expect(steps.indexOf(recon as (typeof steps)[number])).toBe(
      steps.indexOf(event as (typeof steps)[number]) + 1,
    );
    expect(recon?.run).toContain("scripts/ci/flaky-tracker.ts");
  });
});

describe("decide", () => {
  it("records a first sighting and opens nothing", () => {
    expect(
      decide({ f: F, sighting: S, recorded: [], open: [], nowMs: NOW }).kind,
    ).toBe("record");
  });

  it("opens an issue on the second run within 7 days, with both runs", () => {
    const a = decide({
      f: F,
      sighting: S,
      recorded: [rec(800, "2026-11-22T00:00:00Z")],
      open: [],
      nowMs: NOW,
    });
    expect(a.kind).toBe("create");
    expect(a.kind === "create" && a.seen.map((s) => s.run)).toEqual([800, 900]);
  });

  it("does not count a sighting older than 7 days, another test, or the same run twice", () => {
    for (const r of [
      rec(700, "2026-11-18T00:00:00Z"),
      rec(800, "2026-11-25T00:00:00Z", "vitest:other"),
      rec(900, "2026-11-26T10:00:00Z"),
    ])
      expect(
        decide({ f: F, sighting: S, recorded: [r], open: [], nowMs: NOW }).kind,
      ).toBe("record");
  });

  it("bumps the open issue only with 2 runs in 7 days, and skips a run it already notes", () => {
    const body = issueBody([
      { at: "2026-11-10T00:00:00Z", run: 600, attempt: 1 },
    ]);
    const open = [{ number: 5, body }];
    // The issue is open, but the last sighting is 16 days old: record only.
    expect(
      decide({
        f: F,
        sighting: S,
        recorded: [rec(600, "2026-11-10T00:00:00Z")],
        open,
        nowMs: NOW,
      }).kind,
    ).toBe("record");
    const a = decide({
      f: F,
      sighting: S,
      recorded: [rec(850, "2026-11-25T00:00:00Z")],
      open,
      nowMs: NOW,
    });
    expect(a.kind).toBe("bump");
    expect(a.kind === "bump" && a.window.map((s) => s.run)).toEqual([850, 900]);
    const noted = issueBody([S]);
    expect(
      decide({
        f: F,
        sighting: S,
        recorded: [],
        open: [{ number: 5, body: noted }],
        nowMs: NOW,
      }).kind,
    ).toBe("skip");
  });
});

const HOSTILE = [
  `x --> @mallory <!-- flaky-tracker\nkey ${keyOf("vitest:victim")}\n-->`,
  "y ---> @mallory #1 `z`",
  "<!--- flaky-key: 0123456789abcdef --> flaky-seen: 2026-11-26T00:00:00Z 1/1",
];

describe("untrusted text", () => {
  it("inert() leaves no comment delimiter or marker word", () => {
    for (const t of [...HOSTILE, "<!-->", "<!---->", "-->-->", "a->b"]) {
      const s = inert(t);
      expect(s).not.toMatch(/<!--|-->|<!-|->/);
      expect(s).not.toMatch(/flaky-(tracker|key|seen|summary|sightings|prev)/i);
    }
  });

  it("a hostile title or file can't forge or end a marker block", () => {
    for (const title of HOSTILE) {
      const f: Failure = {
        suite: "vitest",
        title,
        file: `test/${title}.test.ts`,
        id: `vitest:test/${title}.test.ts:${title}`,
      };
      const [store] = storeComments(RUN, [{ f, sighting: S }]);
      expect(parseStore(store ?? "")).toEqual([{ key: keyOf(f.id), ...S }]);
      const body = newIssueBody({ f, run: RUN, seen: [S], owner: null });
      expect(parseMarks(body)).toEqual({
        key: keyOf(f.id),
        seen: [S],
        sightings: [],
        passed: [],
      });
      for (const text of [store ?? "", body]) {
        // The only `<!--` and `-->` are the bot's trailing block.
        expect(text.match(/<!--/g)).toHaveLength(1);
        expect(text.match(/-->/g)).toHaveLength(1);
        // Every mention sits inside a code span.
        expect(text.replace(/(`+)[\s\S]*?\1/g, "")).not.toContain("@");
      }
      // The victim's open issue is not matched by the hostile test.
      expect(
        decide({
          f: { ...F, id: "vitest:victim" },
          sighting: S,
          recorded: [],
          open: [{ number: 1, body }],
          nowMs: NOW,
        }).kind,
      ).toBe("record");
      const t = issueTitle(f);
      expect(t).not.toMatch(/[`#@]/);
      expect(t).not.toMatch(/<!-|->/);
    }
  });

  it("ids reach markers only as a hex hash", () => {
    const f: Failure = { ...F, id: "vitest:a-->b:--->c" };
    const [store] = storeComments(RUN, [{ f, sighting: S }]);
    const body = newIssueBody({ f, run: RUN, seen: [S], owner: null });
    for (const text of [store ?? "", body]) {
      const block = text.slice(text.lastIndexOf("<!-- flaky-tracker"));
      expect(block).not.toContain("a--");
      expect(block.slice(0, -3)).not.toContain(">");
      expect(block).toContain(keyOf(f.id));
    }
    expect(keyOf(f.id)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a marker block that is not trailing is ignored", () => {
    const block = markerBlock([`key ${keyOf(F.id)}`]);
    expect(parseMarks(`${block}\nmore text`).key).toBeUndefined();
    expect(parseMarks(`text\n${block}\n`).key).toBe(keyOf(F.id));
  });

  it("keeps titles inert in the store's text", () => {
    const [c] = storeComments(RUN, [
      { f: { ...F, title: "@someone #12 `x`" }, sighting: S },
    ]);
    expect(c).toContain(codeSpan("@someone #12 `x`"));
    expect(codeSpan("a `b`")).toBe("`` a `b` ``");
  });

  it("splits a large run's store lines under the comment limit", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      f: { ...F, id: `${F.id}${i}`, title: "t".repeat(600) },
      sighting: S,
    }));
    const cs = storeComments(RUN, rows);
    expect(cs.length).toBeGreaterThan(1);
    for (const c of cs) expect(c.length).toBeLessThan(65536);
    expect(cs.flatMap(parseStore)).toHaveLength(400);
    // Only the last part marks the run, and none when marksRun is false.
    expect(cs.map((c) => parseMarks(c).passed.length)).toEqual([
      ...cs.slice(1).map(() => 0),
      1,
    ]);
    expect(
      storeComments(RUN, rows, false).flatMap((c) => parseMarks(c).passed),
    ).toEqual([]);
  });
});

describe("bumpedBody", () => {
  it("replaces only the trailing block", () => {
    const b = bumpedBody(issueBody([S]), keyOf(F.id), [S, { ...S, run: 901 }]);
    expect(b.startsWith("hi\n")).toBe(true);
    expect(parseMarks(b).seen.map((s) => s.run)).toEqual([900, 901]);
    expect(b.match(/<!--/g)).toHaveLength(1);
  });
});

type FakeIssue = {
  number: number;
  body: string;
  label: string;
  login?: string;
  comments?: number;
  created_at?: string;
  closed?: boolean;
};

type Listed = {
  id: number;
  run_attempt: number;
  conclusion: string;
  created_at: string;
  updated_at: string;
};
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
/** A CI run that passed on `attempt`, created and last updated so long before NOW. */
const rerun = (
  id: number,
  o: { attempt?: number; created?: number; updated?: number } = {},
): Listed => ({
  id,
  run_attempt: o.attempt ?? 2,
  conclusion: "success",
  created_at: iso(NOW - (o.created ?? DAY)),
  updated_at: iso(NOW - (o.updated ?? HOUR)),
});
/**
 * The runs API's list-workflow-runs, as GitHub answers it: the runs created
 * in the query's range (both ends included), newest first, the full
 * total_count, but only the first LIST_MAX of them reachable by page.
 */
function listPage(runs: Listed[], path: string): string {
  const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const [a, b] = (q.get("created") ?? "").split("..");
  if (!a || !b) throw new Error(`no created range in ${path}`);
  const per = Number(q.get("per_page"));
  const page = Number(q.get("page"));
  const hit = runs
    .filter(
      (r) =>
        r.created_at >= a &&
        r.created_at <= b &&
        (q.get("status") !== "success" || r.conclusion === "success"),
    )
    .sort((x, y) => y.created_at.localeCompare(x.created_at));
  const reachable = hit.slice(0, LIST_MAX);
  return JSON.stringify({
    total_count: hit.length,
    workflow_runs: reachable.slice((page - 1) * per, page * per),
  });
}
/** The created ranges the reconcile listed, in order, once per range. */
const ranges = (calls: string[][]) => [
  ...new Set(
    calls
      .map((c) => c.find((a) => a.includes("/actions/workflows/")) ?? "")
      .filter(Boolean)
      .map((p) =>
        new URLSearchParams(p.slice(p.indexOf("?") + 1)).get("created"),
      ),
  ),
];

/** A fake GitHub: one failed attempt with the given job log, then the issue API. */
function fakeGh(o: {
  log: string;
  jobConclusion?: string;
  attemptConclusion?: string;
  /** The runs of ci.yml the runs API holds, for the reconcile's listing. */
  runs?: Listed[];
  headRepo?: string;
  storeComments?: { user: string; body: string; issue?: number }[];
  issues?: FakeIssue[];
  /** How many `flaky` issue creates fail before they work again. */
  failCreates?: number;
}) {
  let failCreates = o.failCreates ?? 0;
  const calls: string[][] = [];
  const created: { title: string; body: string; label: string }[] = [];
  const comments: { n: string; body: string }[] = [];
  const store = (o.storeComments ?? []).map((c) => ({
    issue: c.issue ?? 1,
    ...c,
  }));
  const issues: FakeIssue[] = (o.issues ?? []).map((i) => ({
    login: "app/github-actions",
    created_at: "2026-11-01T00:00:00Z",
    ...i,
  }));
  const val = (args: string[], k: string) => args[args.indexOf(k) + 1] ?? "";
  const exec: Exec = (_cmd, args) => {
    calls.push(args);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (args[0] === "api") {
      if (/\/actions\/workflows\/ci\.yml\/runs\?/.test(path))
        return ok(listPage(o.runs ?? [], path));
      if (/\/attempts\/2$/.test(path))
        return ok(
          JSON.stringify({
            conclusion: "success",
            head_sha: SHA,
            head_repository: { full_name: o.headRepo ?? REPO },
          }),
        );
      if (/\/attempts\/1$/.test(path))
        return ok(
          JSON.stringify({
            conclusion: o.attemptConclusion ?? "failure",
            head_sha: SHA,
          }),
        );
      if (/\/attempts\/1\/jobs/.test(path))
        return ok(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                name: "test-shard (server)",
                conclusion: o.jobConclusion ?? "failure",
                completed_at: "2026-11-26T10:00:00.123Z",
              },
              {
                id: 2,
                name: "test",
                conclusion: "failure",
                completed_at: null,
              },
              {
                id: 3,
                name: "lint",
                conclusion: "cancelled",
                completed_at: null,
              },
            ],
          }),
        );
      if (path.endsWith("/jobs/1/logs")) return ok(o.log);
      if (path.endsWith("/jobs/2/logs"))
        return ok("##[error]Process completed with exit code 1.");
      if (path.endsWith("/jobs/3/logs")) return ok(o.log);
      const cm = /\/issues\/(\d+)\/comments/.exec(path);
      if (cm)
        return ok(
          store
            .filter((c) => c.user === BOT && c.issue === Number(cm[1]))
            .map((c) => JSON.stringify(c.body))
            .join("\n"),
        );
      const im = /\/issues\/(\d+)$/.exec(path);
      if (im) {
        const i = issues.find((x) => x.number === Number(im[1]));
        if (!i) return { code: 1, stdout: "", stderr: "HTTP 404" };
        return ok(
          JSON.stringify({
            number: i.number,
            body: i.body,
            created_at: i.created_at,
            comments:
              i.comments ?? store.filter((c) => c.issue === i.number).length,
            user: { login: i.login === "app/github-actions" ? BOT : i.login },
          }),
        );
      }
      if (path.includes("/commits?"))
        return ok(JSON.stringify([{ author: { login: "dev1" } }]));
      if (path.includes("/assignees/")) return ok("");
    }
    if (args[0] === "label" && args[1] === "list")
      return ok(
        JSON.stringify([{ name: "flaky" }, { name: "flaky-sightings" }]),
      );
    if (args[0] === "issue" && args[1] === "list") {
      const label = val(args, "--label");
      return ok(
        JSON.stringify(
          issues
            .filter((i) => i.label === label && !i.closed)
            .map((i) => ({
              number: i.number,
              body: i.body,
              author: { login: i.login },
            })),
        ),
      );
    }
    if (args[0] === "issue" && args[1] === "create") {
      if (val(args, "--label") === "flaky" && failCreates > 0) {
        failCreates--;
        return { code: 1, stdout: "", stderr: "HTTP 422: Validation Failed" };
      }
      const c = {
        title: val(args, "--title"),
        body: val(args, "--body"),
        label: val(args, "--label"),
      };
      created.push(c);
      issues.push({
        number: 100 + issues.length,
        body: c.body,
        label: c.label,
        login: "app/github-actions",
        created_at: "2026-11-26T11:00:00Z",
      });
      return ok("");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      comments.push({ n: args[2] as string, body: val(args, "--body") });
      store.push({
        issue: Number(args[2]),
        user: BOT,
        body: val(args, "--body"),
      });
      return ok("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const i = issues.find((x) => String(x.number) === args[2]);
      if (i) i.body = val(args, "--body");
      return ok("");
    }
    if (args[0] === "issue" && args[1] === "close") {
      const i = issues.find((x) => String(x.number) === args[2]);
      if (i) i.closed = true;
      comments.push({ n: args[2] as string, body: val(args, "--comment") });
      return ok("");
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls, created, comments, issues };
}

const ONE_FAIL = VITEST_LOG.split("\n").slice(0, 7).join("\n");
const ONE = parseVitest(ONE_FAIL)[0] as Failure;
const ID = ONE.id;
const STORE: FakeIssue = {
  number: 1,
  body: storeBody(),
  label: "flaky-sightings",
};
const priorStore = (run: number, at: string, f = ONE) =>
  storeComments({ ...RUN, runId: run }, [
    { f, sighting: { at, run, attempt: 1 } },
  ])[0] as string;

describe("loadRun", () => {
  const exec =
    (o: object): Exec =>
    () => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
  it("reads the passing attempt", () => {
    expect(
      loadRun(
        exec({
          conclusion: "success",
          head_sha: SHA,
          head_repository: { full_name: REPO },
        }),
        REPO,
        900,
        2,
      ),
    ).toEqual(RUN);
  });
  it("reads a fork PR's run the same way", () => {
    expect(
      loadRun(
        exec({
          conclusion: "success",
          head_sha: SHA,
          head_repository: { full_name: "mallory/open-artifacts" },
        }),
        REPO,
        900,
        2,
      ),
    ).toEqual(RUN);
  });
  it("refuses a head sha that is not a full sha", () => {
    expect(() =>
      loadRun(
        exec({ conclusion: "success", head_sha: "main; $(x)" }),
        REPO,
        900,
        2,
      ),
    ).toThrow("bad head sha");
  });
});

describe("summaryText", () => {
  it("keeps a fork's test names plain text in the step summary", () => {
    const id = "vitest:a.test.ts:x ```` ![p](https://x.example) <!-- y";
    const out = summaryText(["Flaky tracker:", `  record ${id}`]);
    const lines = out.split("\n");
    // A fence longer than the name's longest backtick run (4) opens and
    // closes it, so nothing inside renders as markdown.
    expect(lines[0]).toBe("`````");
    expect(lines.at(-2)).toBe("`````");
    expect(out).not.toContain("<!--");
    expect(out).toContain("![p](https://x.example)");
  });
});

describe("track", () => {
  sleeper.sleep = () => {};

  it("first sighting: makes the store, records the test, files no flaky issue", () => {
    const g = fakeGh({ log: ONE_FAIL });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(g.created.map((c) => c.label)).toEqual(["flaky-sightings"]);
    expect(g.comments).toHaveLength(1);
    expect(parseStore(g.comments[0]?.body ?? "")).toEqual([
      { key: keyOf(ID), run: 900, attempt: 1, at: "2026-11-26T10:00:00Z" },
    ]);
    expect(r.done).toEqual([{ action: "record", id: ID }]);
    expect(r.notes).toEqual(["attempt 1: job test failed outside the tests"]);
  });

  it("a timed-out job counts like a failed one", () => {
    const g = fakeGh({
      log: ONE_FAIL,
      jobConclusion: "timed_out",
      attemptConclusion: "timed_out",
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done).toEqual([{ action: "record", id: ID }]);
    // The cancelled job (same log) is not read.
    expect(g.calls.some((c) => c.at(-1)?.endsWith("/jobs/3/logs"))).toBe(false);
  });

  it("second run in 7 days: opens one flaky issue with both run links, owner assigned", () => {
    const prior = priorStore(800, "2026-11-24T09:00:00Z");
    const g = fakeGh({
      log: ONE_FAIL,
      issues: [STORE],
      storeComments: [
        { user: BOT, body: prior },
        // Anyone can comment on a public issue: never counted.
        { user: "mallory", body: prior.replace("800/1", "801/1") },
      ],
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done).toEqual([{ action: "create", id: ID }]);
    const issue = g.created[0];
    expect(issue?.label).toBe("flaky");
    expect(parseMarks(issue?.body ?? "").key).toBe(keyOf(ID));
    expect(issue?.body).toContain(
      `https://github.com/${REPO}/actions/runs/800/attempts/1`,
    );
    expect(issue?.body).toContain(
      `https://github.com/${REPO}/actions/runs/900/attempts/1`,
    );
    expect(issue?.body).toContain("dev1 (assigned)");
    expect(
      g.calls.some(
        (c) =>
          c[1] === "create" && c.includes("--assignee") && c.includes("dev1"),
      ),
    ).toBe(true);
    expect(g.calls.find((c) => c.includes("--jq"))?.at(-1)).toContain(
      `select(.user.login == "${BOT}")`,
    );

    // The tracker rerun for the same event changes nothing.
    const before = g.calls.filter(
      (c) => c[0] === "issue" && c[1] !== "list",
    ).length;
    const again = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(again.done).toEqual([
      { action: "skip", id: ID, issue: expect.any(Number) },
    ]);
    expect(
      g.calls.filter((c) => c[0] === "issue" && c[1] !== "list").length,
    ).toBe(before);
    // The sightings, then the run marker once the issue was filed.
    expect(
      g.comments.map((c) => [
        parseStore(c.body).length,
        parseMarks(c.body).passed,
      ]),
    ).toEqual([
      [1, []],
      [0, ["900/2"]],
    ]);
  });

  it("a failed issue create leaves the run unmarked, so the next reconcile files it", () => {
    const g = fakeGh({
      log: ONE_FAIL,
      runs: [rerun(900)],
      issues: [STORE],
      storeComments: [
        { user: BOT, body: priorStore(800, "2026-11-24T09:00:00Z") },
      ],
      failCreates: 1,
    });
    expect(() => track({ exec: g.exec, run: RUN, nowMs: NOW })).toThrow(
      /issue create/,
    );
    // The sighting is kept, with no run marker.
    expect(
      g.comments.map((c) => [
        parseStore(c.body).length,
        parseMarks(c.body).passed,
      ]),
    ).toEqual([[1, []]]);
    const [r] = reconcile({ exec: g.exec, repo: REPO, nowMs: NOW });
    expect(r?.result).toBe("tracked");
    expect(r?.done).toEqual([{ action: "create", id: ID }]);
    expect(g.created.filter((c) => c.label === "flaky")).toHaveLength(1);
    // Nothing stored twice; the run marked once the filing worked.
    expect(
      g.comments.map((c) => [
        parseStore(c.body).length,
        parseMarks(c.body).passed,
      ]),
    ).toEqual([
      [1, []],
      [0, ["900/2"]],
    ]);
    expect(
      reconcile({ exec: g.exec, repo: REPO, nowMs: NOW }).map((x) => x.result),
    ).toEqual(["recorded already"]);
  });

  it("bumps the open issue with the run links when seen twice in 7 days", () => {
    const g = fakeGh({
      log: ONE_FAIL,
      issues: [
        STORE,
        {
          number: 7,
          label: "flaky",
          body: issueBody(
            [{ at: "2026-11-24T09:00:00Z", run: 800, attempt: 1 }],
            ID,
          ),
        },
      ],
      storeComments: [
        { user: BOT, body: priorStore(800, "2026-11-24T09:00:00Z") },
      ],
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done).toContainEqual({ action: "bump", id: ID, issue: 7 });
    const bump = g.comments.find((c) => c.n === "7");
    expect(bump?.body).toContain("/actions/runs/900/attempts/1");
    expect(bump?.body).toContain("/actions/runs/800/attempts/1");
    expect(bump?.body).toContain("failed in 2 runs within 7 days");
    const seen = parseMarks(g.issues.find((i) => i.number === 7)?.body ?? "");
    expect(seen.seen.map((s) => s.run)).toEqual([800, 900]);
  });

  it("an open issue whose last sighting is past the window is not bumped", () => {
    const g = fakeGh({
      log: ONE_FAIL,
      issues: [
        STORE,
        {
          number: 7,
          label: "flaky",
          body: issueBody(
            [{ at: "2026-11-10T09:00:00Z", run: 600, attempt: 1 }],
            ID,
          ),
        },
      ],
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done).toEqual([{ action: "record", id: ID }]);
    expect(g.comments.map((c) => c.n)).toEqual(["1"]);
  });

  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...ONE,
      title: `case ${i}`,
      file: `test/t${i}.test.ts`,
      id: `vitest:test/t${i}.test.ts:case ${i}`,
    }));
  const log = (fs: Failure[]) =>
    fs.map((f) => ` FAIL  ${f.file} > ${f.title}`).join("\n");

  it(`more than ${MAX_FILED_PER_RUN} first sightings: all recorded, nothing filed`, () => {
    const g = fakeGh({
      log: log(many(MAX_FILED_PER_RUN + 3)),
      issues: [STORE],
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done.every((d) => d.action === "record")).toBe(true);
    expect(g.created).toEqual([]);
    expect(g.comments.flatMap((c) => parseStore(c.body))).toHaveLength(
      MAX_FILED_PER_RUN + 3,
    );
  });

  it(`more than ${MAX_FILED_PER_RUN} tests to file: all recorded, one summary instead`, () => {
    const fs = many(MAX_FILED_PER_RUN + 3);
    // Six were seen before; two are first sightings.
    const seenBefore = fs.slice(0, MAX_FILED_PER_RUN + 1);
    const g = fakeGh({
      log: log(fs),
      issues: [STORE],
      storeComments: seenBefore.map((f) => ({
        user: BOT,
        body: priorStore(800, "2026-11-24T09:00:00Z", f),
      })),
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(g.comments.flatMap((c) => parseStore(c.body))).toHaveLength(
      fs.length,
    );
    expect(r.done.filter((d) => d.action === "record")).toHaveLength(2);
    expect(r.done).toContainEqual({ action: "summary", id: "summary:900" });
    expect(g.created).toHaveLength(1);
    const body = g.created[0]?.body ?? "";
    expect(parseMarks(body).summary).toBe(900);
    expect(body).toContain("/actions/runs/800/attempts/1");
    expect(body).not.toContain("case 7");
    // A rerun skips the summary it filed.
    const again = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(again.done).toContainEqual({
      action: "skip",
      id: "summary:900",
      issue: expect.any(Number),
    });
    expect(g.created).toHaveLength(1);
  });

  it(`${MAX_FILED_PER_RUN} tests to file: each filed on its own`, () => {
    const fs = many(MAX_FILED_PER_RUN + 3);
    const g = fakeGh({
      log: log(fs),
      issues: [STORE],
      storeComments: fs.slice(0, MAX_FILED_PER_RUN).map((f) => ({
        user: BOT,
        body: priorStore(800, "2026-11-24T09:00:00Z", f),
      })),
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done.filter((d) => d.action === "create")).toHaveLength(
      MAX_FILED_PER_RUN,
    );
    expect(g.created).toHaveLength(MAX_FILED_PER_RUN);
  });

  it(`a store past ${STORE_MAX_COMMENTS} comments is closed and continued, and both are read`, () => {
    const g = fakeGh({
      log: ONE_FAIL,
      issues: [{ ...STORE, comments: STORE_MAX_COMMENTS + 1 }],
      storeComments: [
        { user: BOT, body: priorStore(800, "2026-11-24T09:00:00Z") },
      ],
    });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    const next = g.issues.find(
      (i) => i.label === "flaky-sightings" && i.number !== 1,
    );
    expect(parseMarks(next?.body ?? "").prev).toBe(1);
    expect(g.issues.find((i) => i.number === 1)?.closed).toBe(true);
    expect(g.comments.find((c) => c.n === "1")?.body).toContain(
      `#${next?.number}`,
    );
    // This run's line, then its run marker after the filing, went to the new
    // store; the old one's sighting counted.
    expect(
      g.comments
        .filter((c) => c.n === String(next?.number))
        .map((c) => [parseStore(c.body).length, parseMarks(c.body).passed]),
    ).toEqual([
      [1, []],
      [0, ["900/2"]],
    ]);
    expect(r.done).toEqual([{ action: "create", id: ID }]);
  });

  it("a store comment names the run's passing attempt", () => {
    const g = fakeGh({ log: ONE_FAIL });
    track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(parseMarks(g.comments[0]?.body ?? "").passed).toEqual(["900/2"]);
  });

  it("a failure outside the tests files nothing", () => {
    const g = fakeGh({ log: "##[error]Process completed with exit code 1." });
    expect(track({ exec: g.exec, run: RUN, nowMs: NOW }).done).toEqual([]);
    expect(g.calls.some((c) => c[0] === "issue")).toBe(false);
  });
});

describe("reconcile", () => {
  sleeper.sleep = () => {};
  const writes = (g: ReturnType<typeof fakeGh>) =>
    g.calls.filter((c) => c[0] === "issue" && c[1] !== "list").length;

  it(`lists passing reruns updated in the last ${RECONCILE_HOURS} hours, forks' too, in small reads`, () => {
    const g = fakeGh({ log: ONE_FAIL });
    expect(reconcile({ exec: g.exec, repo: REPO, nowMs: NOW })).toEqual([]);
    const list = g.calls.filter((c) =>
      c.some((a) => a.includes("/actions/workflows/ci.yml/runs?")),
    );
    expect(list).toHaveLength(1);
    const path = list[0]?.find((a) => a.startsWith("repos/")) ?? "";
    expect(path).toContain("status=success");
    expect(path).toContain("per_page=100&page=1");
    // Created in the last 30 days and 26 hours: a rerun up to 30 days after
    // creation, updated in the last 26 hours.
    expect(RERUN_DAYS).toBe(30);
    expect(decodeURIComponent(path)).toContain(
      "created=2026-10-26T10:00:00Z..2026-11-26T12:00:00Z",
    );
    const jq = list[0]?.[list[0].indexOf("--jq") + 1] ?? "";
    expect(jq).toContain("total_count");
    expect(jq).not.toContain("head_repository");
    // Nothing to do: no store read, no write.
    expect(g.calls.some((c) => c[0] === "issue")).toBe(false);
  });

  it("finds a run created days ago that passed on a rerun in the last 26 hours", () => {
    const runs = [
      // Created 4 days ago, passed on attempt 3 two hours ago.
      rerun(901, { attempt: 3, created: 4 * DAY, updated: 2 * HOUR }),
      // Created 25 days ago: still inside GitHub's 30-day rerun period.
      rerun(902, { created: 25 * DAY, updated: 3 * HOUR }),
      // Created 31 days and 3 hours ago: past 30 days plus 26 hours.
      rerun(903, { created: 31 * DAY + 3 * HOUR, updated: 3 * HOUR }),
      // Updated 27 hours ago: an earlier reconcile had it.
      rerun(904, { created: 2 * DAY, updated: 27 * HOUR }),
      // Passed on its first attempt: nothing to track.
      rerun(905, { attempt: 1, created: 2 * DAY }),
    ];
    const g = fakeGh({ log: ONE_FAIL, runs });
    expect(recentRuns(g.exec, REPO, NOW)).toEqual([
      { runId: 901, attempt: 3 },
      { runId: 902, attempt: 2 },
    ]);
  });

  it("finds a legal rerun that passed 29d 23h 55m after creation, scanned 10 minutes later", () => {
    const MIN = 60 * 1000;
    const late = rerun(901, {
      attempt: 3,
      created: 10 * MIN + 29 * DAY + 23 * HOUR + 55 * MIN,
      updated: 10 * MIN,
    });
    const g = fakeGh({ log: ONE_FAIL, runs: [late] });
    expect(recentRuns(g.exec, REPO, NOW)).toEqual([{ runId: 901, attempt: 3 }]);
    // Still found until its update leaves the 26-hour window.
    expect(recentRuns(g.exec, REPO, NOW + 25 * HOUR)).toEqual([
      { runId: 901, attempt: 3 },
    ]);
  });

  it("counts a 25-day-old run's failure by its job's completion time, not the run's creation", () => {
    // Run 900 was created 25 days ago; attempt 1's job failed at
    // 2026-11-26T10:00:00Z and attempt 2 passed an hour ago. With run 800's
    // sighting two days earlier, that is twice in 7 days.
    const g = fakeGh({
      log: ONE_FAIL,
      runs: [rerun(900, { created: 25 * DAY })],
      issues: [STORE],
      storeComments: [
        { user: BOT, body: priorStore(800, "2026-11-24T09:00:00Z") },
      ],
    });
    const [r] = reconcile({ exec: g.exec, repo: REPO, nowMs: NOW });
    expect(r?.result).toBe("tracked");
    expect(r?.done).toEqual([{ action: "create", id: ID }]);
    expect(parseStore(g.comments[0]?.body ?? "")).toEqual([
      { key: keyOf(ID), run: 900, attempt: 1, at: "2026-11-26T10:00:00Z" },
    ]);
  });

  it("splits a range whose listing reaches 1,000 runs, so none is missed", () => {
    // 999 runs that passed first time in the last day, and the oldest one, a
    // rerun from 20 days ago: 1,000 in the range, GitHub's limit.
    const runs = [
      ...Array.from({ length: LIST_MAX - 1 }, (_, i) =>
        rerun(10_000 + i, { attempt: 1, created: HOUR + i * 60_000 }),
      ),
      rerun(901, { created: 20 * DAY }),
    ];
    const g = fakeGh({ log: ONE_FAIL, runs });
    expect(recentRuns(g.exec, REPO, NOW)).toEqual([{ runId: 901, attempt: 2 }]);
    expect(ranges(g.calls)).toEqual([
      "2026-10-26T10:00:00Z..2026-11-26T12:00:00Z",
      "2026-10-26T10:00:00Z..2026-11-10T23:00:00Z",
      "2026-11-10T23:00:01Z..2026-11-26T12:00:00Z",
    ]);
  });

  it("finds the oldest of 1,145 runs, past the 1,000 one listing returns", () => {
    // As public CI had for 9 to 15 November: one query reaches only the
    // newest 1,000.
    const runs = [
      ...Array.from({ length: 1144 }, (_, i) =>
        rerun(10_000 + i, { attempt: 1, created: 2 * DAY + i * 300_000 }),
      ),
      rerun(901, { attempt: 3, created: 8 * DAY, updated: 2 * HOUR }),
    ];
    const g = fakeGh({ log: ONE_FAIL, runs });
    expect(recentRuns(g.exec, REPO, NOW)).toEqual([{ runId: 901, attempt: 3 }]);
    // The whole range held 1,145, so it was split before paging.
    expect(ranges(g.calls)[0]).toBe(
      "2026-10-26T10:00:00Z..2026-11-26T12:00:00Z",
    );
    expect(ranges(g.calls).length).toBeGreaterThan(1);
  });

  it("fails loudly when one second holds 1,000 runs", () => {
    const runs = Array.from({ length: LIST_MAX }, (_, i) =>
      rerun(10_000 + i, { created: 5 * DAY }),
    );
    const g = fakeGh({ log: ONE_FAIL, runs });
    const at = iso(NOW - 5 * DAY);
    expect(() => recentRuns(g.exec, REPO, NOW)).toThrow(
      `1000 runs created at ${at}: GitHub lists at most 1000 for one query`,
    );
    expect(() => reconcile({ exec: g.exec, repo: REPO, nowMs: NOW })).toThrow(
      /1000 runs created at/,
    );
  });

  it("records a run the event missed, through the same code", () => {
    const g = fakeGh({ log: ONE_FAIL, runs: [rerun(900)] });
    const r = reconcile({ exec: g.exec, repo: REPO, nowMs: NOW });
    expect(r).toEqual([
      {
        runId: 900,
        attempt: 2,
        result: "tracked",
        done: [{ action: "record", id: ID }],
        notes: ["attempt 1: job test failed outside the tests"],
      },
    ]);
    expect(g.created.map((c) => c.label)).toEqual(["flaky-sightings"]);
    const body = g.comments[0]?.body ?? "";
    expect(parseStore(body)).toEqual([
      { key: keyOf(ID), run: 900, attempt: 1, at: "2026-11-26T10:00:00Z" },
    ]);
    expect(parseMarks(body).passed).toEqual(["900/2"]);
  });

  it("a run already in the store adds nothing and bumps nothing", () => {
    // Run 800 was recorded, and run 900 filed its issue, by their events.
    const g = fakeGh({
      log: ONE_FAIL,
      runs: [rerun(800), rerun(900)],
      issues: [STORE],
      storeComments: [
        { user: BOT, body: priorStore(800, "2026-11-24T09:00:00Z") },
      ],
    });
    expect(track({ exec: g.exec, run: RUN, nowMs: NOW }).done).toEqual([
      { action: "create", id: ID },
    ]);
    const before = writes(g);
    const reads = g.calls.length;
    const r = reconcile({ exec: g.exec, repo: REPO, nowMs: NOW });
    expect(r.map((x) => [x.runId, x.result])).toEqual([
      [800, "recorded already"],
      [900, "recorded already"],
    ]);
    expect(writes(g)).toBe(before);
    // Neither run's attempts or logs are read again.
    expect(
      g.calls.slice(reads).some((c) => c.some((a) => a.includes("/attempts/"))),
    ).toBe(false);
  });

  it("a forged passed line from someone else doesn't hide a run", () => {
    const g = fakeGh({
      log: ONE_FAIL,
      runs: [rerun(900)],
      issues: [STORE],
      storeComments: [{ user: "mallory", body: markerBlock(["passed 900/2"]) }],
    });
    const [r] = reconcile({ exec: g.exec, repo: REPO, nowMs: NOW });
    expect(r?.result).toBe("tracked");
    expect(g.comments).toHaveLength(1);
  });

  it("records a fork PR's run like any other", () => {
    const o = { log: ONE_FAIL, runs: [rerun(900)] };
    const fork = fakeGh({ ...o, headRepo: "mallory/open-artifacts" });
    const ours = fakeGh(o);
    const r = reconcile({ exec: fork.exec, repo: REPO, nowMs: NOW });
    expect(r).toEqual(reconcile({ exec: ours.exec, repo: REPO, nowMs: NOW }));
    expect(r.map((x) => x.result)).toEqual(["tracked"]);
    expect(fork.comments).toEqual(ours.comments);
    expect(parseStore(fork.comments[0]?.body ?? "")).toEqual([
      { key: keyOf(ID), run: 900, attempt: 1, at: "2026-11-26T10:00:00Z" },
    ]);
  });
});
