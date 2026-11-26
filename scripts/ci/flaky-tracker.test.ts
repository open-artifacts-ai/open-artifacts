// cloud #447: the public CI flaky tracker. The vitest fixture is an excerpt of
// run 45651408126 attempt 1, job test-shard (server); the Playwright one
// follows the list reporter's summary (lib/runner, generateSummaryMessage).
import { describe, expect, it } from "vitest";
import {
  BOT,
  codeSpan,
  decide,
  type Exec,
  type Failure,
  keyOf,
  MAX_TESTS_PER_RUN,
  parsePlaywright,
  parseStore,
  parseVitest,
  type RunInfo,
  repoDir,
  type Sighting,
  sleeper,
  storeComment,
  summaryMarker,
  TWICE_NOTE,
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
      recorded: [
        { key: keyOf(F.id), run: 800, attempt: 1, at: "2026-11-22T00:00:00Z" },
      ],
      open: [],
      nowMs: NOW,
    });
    expect(a.kind).toBe("create");
    expect(a.kind === "create" && a.seen.map((s) => s.run)).toEqual([800, 900]);
  });

  it("does not count a sighting older than 7 days, another test, or the same run twice", () => {
    for (const r of [
      { key: keyOf(F.id), run: 700, attempt: 1, at: "2026-11-18T00:00:00Z" },
      {
        key: keyOf("vitest:other"),
        run: 800,
        attempt: 1,
        at: "2026-11-25T00:00:00Z",
      },
      { key: keyOf(F.id), run: 900, attempt: 1, at: "2026-11-26T10:00:00Z" },
    ])
      expect(
        decide({ f: F, sighting: S, recorded: [r], open: [], nowMs: NOW }).kind,
      ).toBe("record");
  });

  it("bumps the open issue, and skips a run it already notes", () => {
    const body = `<!-- flaky-key: ${keyOf(F.id)} -->\n<!-- flaky-seen: 2026-11-20T00:00:00Z 600/1 -->`;
    expect(
      decide({
        f: F,
        sighting: S,
        recorded: [],
        open: [{ number: 5, body }],
        nowMs: NOW,
      }).kind,
    ).toBe("bump");
    const noted = `${body.split("\n")[0]}\n<!-- flaky-seen: 2026-11-26T10:00:00Z 900/1 -->`;
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

describe("the store", () => {
  it("round-trips its lines and keeps titles inert", () => {
    const c = storeComment(RUN, [
      { f: { ...F, title: "@someone #12 `x`" }, sighting: S },
    ]);
    expect(parseStore(c)).toEqual([{ key: keyOf(F.id), ...S }]);
    expect(c).toContain(codeSpan("@someone #12 `x`"));
    expect(codeSpan("a `b`")).toBe("`` a `b` ``");
  });
});

/** A fake GitHub: one failed attempt with the given job log, then the issue API. */
function fakeGh(o: {
  log: string;
  storeComments?: { user: string; body: string }[];
  open?: { number: number; body: string; login?: string }[];
}) {
  const calls: string[][] = [];
  const created: { title: string; body: string; label: string }[] = [];
  const comments: { n: string; body: string }[] = [];
  const store = [...(o.storeComments ?? [])];
  const issues = (o.open ?? []).map((i) => ({
    ...i,
    label: "flaky",
    login: i.login ?? "app/github-actions",
  }));
  const val = (args: string[], k: string) => args[args.indexOf(k) + 1] ?? "";
  const exec: Exec = (_cmd, args) => {
    calls.push(args);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (args[0] === "api") {
      if (/\/attempts\/1$/.test(path))
        return ok(JSON.stringify({ conclusion: "failure", head_sha: SHA }));
      if (/\/attempts\/1\/jobs/.test(path))
        return ok(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                name: "test-shard (server)",
                conclusion: "failure",
                completed_at: "2026-11-26T10:00:00.123Z",
              },
              {
                id: 2,
                name: "test",
                conclusion: "failure",
                completed_at: null,
              },
            ],
          }),
        );
      if (path.endsWith("/jobs/1/logs")) return ok(o.log);
      if (path.endsWith("/jobs/2/logs"))
        return ok("##[error]Process completed with exit code 1.");
      if (/\/issues\/\d+\/comments/.test(path))
        return ok(
          store
            .filter((c) => c.user === BOT)
            .map((c) => JSON.stringify(c.body))
            .join("\n"),
        );
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
            .filter((i) => i.label === label)
            .map((i) => ({
              number: i.number,
              body: i.body,
              author: { login: i.login },
            })),
        ),
      );
    }
    if (args[0] === "issue" && args[1] === "create") {
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
      });
      return ok("");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      comments.push({ n: args[2] as string, body: val(args, "--body") });
      store.push({ user: BOT, body: val(args, "--body") });
      return ok("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const i = issues.find((x) => String(x.number) === args[2]);
      if (i) i.body = val(args, "--body");
      return ok("");
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls, created, comments };
}

const ONE_FAIL = VITEST_LOG.split("\n").slice(0, 7).join("\n");
const ID = parseVitest(ONE_FAIL)[0]?.id as string;

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

  it("second run in 7 days: opens one flaky issue with both run links, owner assigned", () => {
    const prior = storeComment({ ...RUN, runId: 800 }, [
      {
        f: parseVitest(ONE_FAIL)[0] as Failure,
        sighting: { at: "2026-11-24T09:00:00Z", run: 800, attempt: 1 },
      },
    ]);
    const g = fakeGh({
      log: ONE_FAIL,
      open: [],
      storeComments: [
        { user: BOT, body: prior },
        // Anyone can comment on a public issue: never counted.
        { user: "mallory", body: prior.replace("800/1", "801/1") },
      ],
    });
    // The store issue exists.
    g.exec("gh", [
      "issue",
      "create",
      "--title",
      "store",
      "--body",
      "",
      "--label",
      "flaky-sightings",
    ]);
    g.created.length = 0;
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done).toEqual([{ action: "create", id: ID }]);
    const issue = g.created[0];
    expect(issue?.label).toBe("flaky");
    expect(issue?.body).toContain(`<!-- flaky-key: ${keyOf(ID)} -->`);
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
  });

  it("bumps the open issue with the run link", () => {
    const body = `<!-- flaky-key: ${keyOf(ID)} -->\nhi\n<!-- flaky-seen: 2026-11-24T09:00:00Z 800/1; 2026-11-25T09:00:00Z 850/1 -->`;
    const g = fakeGh({ log: ONE_FAIL, open: [{ number: 7, body }] });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done).toContainEqual({ action: "bump", id: ID, issue: 7 });
    const bump = g.comments.find((c) => c.n === "7");
    expect(bump?.body).toContain(`/actions/runs/900/attempts/1`);
    expect(bump?.body).toContain(TWICE_NOTE);
  });

  it(`more than ${MAX_TESTS_PER_RUN} failed tests: one summary issue, nothing recorded`, () => {
    const log = Array.from(
      { length: MAX_TESTS_PER_RUN + 1 },
      (_, i) => ` FAIL  test/t${i}.test.ts > case ${i}`,
    ).join("\n");
    const g = fakeGh({ log });
    const r = track({ exec: g.exec, run: RUN, nowMs: NOW });
    expect(r.done).toEqual([{ action: "summary", id: "summary:900" }]);
    expect(g.created).toHaveLength(1);
    expect(g.created[0]?.body).toContain(summaryMarker(900));
    expect(g.comments).toEqual([]);
  });

  it("a failure outside the tests files nothing", () => {
    const g = fakeGh({ log: "##[error]Process completed with exit code 1." });
    expect(track({ exec: g.exec, run: RUN, nowMs: NOW }).done).toEqual([]);
    expect(g.calls.some((c) => c[0] === "issue")).toBe(false);
  });
});
