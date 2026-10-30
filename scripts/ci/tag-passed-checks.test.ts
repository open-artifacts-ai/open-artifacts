import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// tag-passed-checks.sh: a tag deploys only after every earlier check passed.
// Each condition, failed alone, stops the gate and is named; an API error is a
// failure, never a pass.
const SCRIPT = script("tag-passed-checks.sh");
const TAG = "v0.80.0";
const SHA = "c".repeat(40);
const REPO = "open-artifacts-ai/open-artifacts";

// gh api -X GET <path>: $STATE/<key>.json, or exit 1 when it is missing.
const gh = `
p="\${@: -1}"; p="\${p#repos/$REPO/}"
case "$p" in
  releases/tags/*) k=release ;;
  commits/*) k=commit ;;
  compare/*) k=compare ;;
  actions/workflows/release-please.yml/runs\\?*) k=runs ;;
  actions/runs/*/jobs\\?*) k=jobs ;;
  *) exit 1 ;;
esac
[ -f "$STATE/$k.json" ] || { echo "HTTP 404" >&2; exit 1; }
cat "$STATE/$k.json"`;

type State = Record<string, unknown>;
const good = (): State => ({
  release: {
    tag_name: TAG,
    draft: false,
    prerelease: false,
    published_at: "2026-10-30T00:00:00Z",
    assets: [
      { name: "oa-release-staging-0.80.0.tar", state: "uploaded" },
      { name: "oa-release-prod-0.80.0.tar", state: "uploaded" },
    ],
  },
  commit: { sha: SHA },
  compare: { status: "behind" },
  runs: {
    workflow_runs: [
      {
        id: 41,
        head_sha: SHA,
        event: "push",
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-30T00:00:00Z",
      },
    ],
  },
  jobs: {
    jobs: [
      "release-please",
      "verify-release",
      "hosted-check",
      "hosted-attach-staging",
      "hosted-attach-prod",
    ].map((name) => ({ name, conclusion: "success" })),
  },
});

const run = (state: State, env = "prod", tag = TAG) => {
  const sb = sandbox({ gh });
  const dir = join(sb.dir, "state");
  mkdirSync(dir);
  for (const [k, v] of Object.entries(state))
    if (v !== undefined)
      writeFileSync(
        join(dir, `${k}.json`),
        typeof v === "string" ? v : JSON.stringify(v),
      );
  const r = sb.run(["bash", SCRIPT, env, tag], {
    env: {
      STATE: dir,
      REPO,
      GH_TOKEN: "gh-token-SHOULD-NEVER-APPEAR",
      GITHUB_REPOSITORY: REPO,
    },
  });
  expect(r.out + r.err).not.toContain("SHOULD-NEVER-APPEAR");
  return { ...r, calls: sb.log() };
};

// biome-ignore lint/suspicious/noExplicitAny: test fixtures
const edit = (f: (s: any) => void) => {
  const s = good();
  f(s);
  return s;
};
const jobIs = (name: string, conclusion: string | null) =>
  // biome-ignore lint/suspicious/noExplicitAny: test fixtures
  edit((s: any) => {
    s.jobs.jobs = s.jobs.jobs.map((j: { name: string }) =>
      j.name === name ? { name, conclusion } : j,
    );
  });

describe("tag-passed-checks.sh", () => {
  it("passes when every check holds, for both envs, reading only", () => {
    for (const env of ["staging", "prod"]) {
      const r = run(good(), env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`${TAG} passed every check for ${env}`);
      for (const c of r.calls.filter((c) => c.startsWith("gh ")))
        expect(c).toMatch(/^gh api -X GET /);
    }
    // identical (the tag is main's head) is on main too.
    expect(run(edit((s) => (s.compare.status = "identical"))).code).toBe(0);
  });

  const cases: [string, State, RegExp][] = [
    [
      "no release",
      edit((s) => delete s.release),
      /release v0\.80\.0: GitHub API error/,
    ],
    ["a draft", edit((s) => (s.release.draft = true)), /is a draft/],
    [
      "a prerelease",
      edit((s) => (s.release.prerelease = true)),
      /is a prerelease/,
    ],
    [
      "not published",
      edit((s) => (s.release.published_at = null)),
      /not published/,
    ],
    ["another tag", edit((s) => (s.release.tag_name = "v0.79.0")), /not found/],
    [
      "no commit",
      edit((s) => delete s.commit),
      /commit of v0\.80\.0: GitHub API error/,
    ],
    [
      "off main (ahead)",
      edit((s) => (s.compare.status = "ahead")),
      /not on main \(ahead\)/,
    ],
    [
      "off main (diverged)",
      edit((s) => (s.compare.status = "diverged")),
      /not on main/,
    ],
    [
      "compare error",
      edit((s) => delete s.compare),
      /on main: GitHub API error/,
    ],
    ["no push run", edit((s) => (s.runs.workflow_runs = [])), /no push run/],
    [
      "a run for another commit",
      edit((s) => (s.runs.workflow_runs[0].head_sha = "d".repeat(40))),
      /no push run/,
    ],
    [
      "a dispatch run",
      edit((s) => (s.runs.workflow_runs[0].event = "workflow_dispatch")),
      /no push run/,
    ],
    [
      "run in progress",
      edit((s) => (s.runs.workflow_runs[0].status = "in_progress")),
      /not completed/,
    ],
    [
      "run failed",
      edit((s) => (s.runs.workflow_runs[0].conclusion = "failure")),
      /concluded failure/,
    ],
    [
      "latest run failed",
      edit((s) =>
        s.runs.workflow_runs.push({
          ...s.runs.workflow_runs[0],
          id: 42,
          conclusion: "failure",
          created_at: "2026-10-30T01:00:00Z",
        }),
      ),
      /concluded failure/,
    ],
    [
      "runs error",
      edit((s) => delete s.runs),
      /release-please run: GitHub API error/,
    ],
    [
      "jobs error",
      edit((s) => delete s.jobs),
      /release-please jobs: GitHub API error/,
    ],
    [
      "verify-release failed",
      jobIs("verify-release", "failure"),
      /job verify-release: failure/,
    ],
    [
      "verify-release skipped",
      jobIs("verify-release", "skipped"),
      /job verify-release: skipped/,
    ],
    [
      "hosted-check failed",
      jobIs("hosted-check", "failure"),
      /job hosted-check: failure/,
    ],
    [
      "hosted-attach-prod failed",
      jobIs("hosted-attach-prod", "failure"),
      /job hosted-attach-prod: failure/,
    ],
    [
      "hosted-attach-prod missing",
      edit(
        (s) =>
          (s.jobs.jobs = s.jobs.jobs.filter(
            (j: { name: string }) => j.name !== "hosted-attach-prod",
          )),
      ),
      /job hosted-attach-prod: missing/,
    ],
    [
      "no prod asset",
      edit(
        (s) =>
          (s.release.assets = [
            { name: "oa-release-staging-0.80.0.tar", state: "uploaded" },
          ]),
      ),
      /no oa-release-prod-\* asset/,
    ],
    [
      "prod asset not uploaded",
      edit((s) => (s.release.assets[1].state = "open")),
      /no oa-release-prod-\* asset/,
    ],
    [
      "unparsable release",
      { ...good(), release: "<html>" },
      /unparsable response/,
    ],
  ];
  it.each(cases)("fails closed on %s, naming the check", (_n, state, msg) => {
    const r = run(state);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^release gate failed: /m);
    expect(r.err).toMatch(msg);
    expect(r.out).not.toContain("passed every check");
  });

  it("staging needs hosted-attach-staging, not prod's", () => {
    const s = good();
    // biome-ignore lint/suspicious/noExplicitAny: test fixtures
    (s as any).jobs.jobs = (s as any).jobs.jobs.map((j: { name: string }) =>
      j.name === "hosted-attach-staging" ? { ...j, conclusion: "failure" } : j,
    );
    expect(run(s, "staging").err).toMatch(/job hosted-attach-staging: failure/);
    expect(run(s, "prod").code).toBe(0);
  });

  it("refuses a bad env or tag before any call", () => {
    for (const [env, tag] of [
      ["dev", TAG],
      ["prod", "v0.80.0-rc.1"],
      ["prod", "main"],
    ] as const) {
      const r = run(good(), env, tag);
      expect(r.code).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });
});
