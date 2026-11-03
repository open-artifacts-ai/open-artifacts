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
  actions/artifacts\\?*) k=artifacts ;;
  actions/runs/*/jobs\\?*)
    id="\${p#actions/runs/}"; id="\${id%%/*}"
    k=jobs; [ -f "$STATE/jobs-$id.json" ] && k="jobs-$id" ;;
  actions/runs/*) k="run-\${p#actions/runs/}" ;;
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
  jobs: allJobs(),
  // No run built the tag (a release from before the marker): the legacy rule.
  artifacts: { total_count: 0, artifacts: [] },
});

const allJobs = (conclusion = "success") => ({
  jobs: [
    "release-please",
    "verify-release",
    "hosted-check",
    "hosted-attach-staging",
    "hosted-attach-prod",
  ].map((name) => ({ name, conclusion })),
});

// #1282: the run that created and built the tag is another push run (v0.105.0:
// run 41676652301, head 8490e7bf), and the run on the tag's commit skipped
// everything.
const MARKER = `built-from-${TAG}-${SHA}`;
const OTHER = "e".repeat(40);
const pushRun = (id: number, head = OTHER) => ({
  id,
  path: ".github/workflows/release-please.yml",
  head_sha: head,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-30T00:00:00Z",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
});
const artifact = (runId: number, name = MARKER) => ({
  name,
  expired: false,
  workflow_run: { id: runId, head_branch: "main", head_sha: OTHER },
});
// biome-ignore lint/suspicious/noExplicitAny: test fixtures
const raced = (f: (s: any) => void = () => {}) => {
  // biome-ignore lint/suspicious/noExplicitAny: test fixtures
  const s: any = good();
  s.jobs = allJobs("skipped"); // the tag commit's own run did nothing
  s.artifacts = { total_count: 1, artifacts: [artifact(77)] };
  s["run-77"] = pushRun(77);
  s["jobs-77"] = allJobs();
  f(s);
  return s as State;
};

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

  describe("the run that built the tag (#1282)", () => {
    const fails = (state: State, msg: RegExp, env = "prod") => {
      const r = run(state, env);
      expect(r.code, r.out).toBe(1);
      expect(r.err).toMatch(/^release gate failed: /m);
      expect(r.err).toMatch(msg);
      expect(r.out).not.toContain("passed every check");
    };

    it("passes on another push run that built the tag, and checks that run's jobs", () => {
      for (const env of ["staging", "prod"]) {
        const r = run(raced(), env);
        expect(r.code, r.err).toBe(0);
        expect(r.out).toContain(
          `${TAG} passed every check for ${env} (commit ${SHA}, run 77, built from ${TAG})`,
        );
        expect(r.calls).toContain(
          `gh api -X GET repos/${REPO}/actions/artifacts?name=${MARKER}&per_page=100&page=1`,
        );
        expect(r.calls).toContain(
          `gh api -X GET repos/${REPO}/actions/runs/77/jobs?filter=latest&per_page=100`,
        );
        // The marker decides: the tag commit's own run is not read.
        expect(r.calls.some((c) => c.includes("/runs?event=push"))).toBe(false);
        for (const c of r.calls.filter((c) => c.startsWith("gh ")))
          expect(c).toMatch(/^gh api -X GET /);
      }
    });

    it("passes when the marker run is the run on the tag's commit", () => {
      const r = run(
        raced((s) => {
          s["run-77"] = pushRun(77, SHA);
        }),
      );
      expect(r.code, r.err).toBe(0);
    });

    it("counts a run once however many markers it uploaded (a re-run)", () => {
      const r = run(
        raced((s) => {
          s.artifacts.artifacts.push(artifact(77));
        }),
      );
      expect(r.code, r.err).toBe(0);
    });

    it("ignores markers from runs that are not release-please.yml pushes on main", () => {
      const others: [string, (r: Record<string, unknown>) => void][] = [
        ["another workflow", (r) => (r.path = ".github/workflows/ci.yml")],
        ["a dispatch", (r) => (r.event = "workflow_dispatch")],
        ["a pull request", (r) => (r.event = "pull_request")],
        ["another branch", (r) => (r.head_branch = "pl/x")],
        [
          "a fork",
          (r) => (r.head_repository = { full_name: "evil/open-artifacts" }),
        ],
      ];
      for (const [name, f] of others) {
        // With the real run beside it, the stray one doesn't make two.
        const two = raced((s) => {
          s.artifacts.artifacts.push(artifact(88));
          s["run-88"] = pushRun(88);
          f(s["run-88"]);
        });
        expect(run(two).code, name).toBe(0);
        // Alone, it doesn't count: the legacy run (skipped jobs) is read.
        const alone = raced((s) => {
          s.artifacts.artifacts = [artifact(88)];
          s["run-88"] = pushRun(88);
          f(s["run-88"]);
        });
        const r = run(alone);
        expect(r.code, name).toBe(1);
        expect(r.err, name).toMatch(/job verify-release: skipped/);
      }
    });

    it("fails on two push runs that built the tag", () => {
      fails(
        raced((s) => {
          s.artifacts.artifacts.push(artifact(78));
          s["run-78"] = pushRun(78);
          s["jobs-78"] = allJobs();
        }),
        /2 push runs built v0\.80\.0 \(built-from-v0\.80\.0-c{40}\); exactly one must/,
      );
    });

    it("fails on a marker for another commit, with no run on the tag's commit", () => {
      fails(
        raced((s) => {
          s.artifacts.artifacts = [artifact(77, `built-from-${TAG}-${OTHER}`)];
          s.runs.workflow_runs = [];
        }),
        /no run built v0\.80\.0 \(built-from-v0\.80\.0-c{40}\) and no push run for c{40}/,
      );
    });

    it("never takes a marker for another commit or tag as this one", () => {
      for (const name of [
        `built-from-${TAG}-${OTHER}`,
        `built-from-v0.80.1-${SHA}`,
        `built-from-${TAG}`,
        "hosted-release",
      ])
        fails(
          raced((s) => {
            s.artifacts.artifacts = [artifact(77, name)];
          }),
          /job verify-release: skipped/,
        );
    });

    const jobFails = (name: string, conclusion: string | null) =>
      raced((s) => {
        s["jobs-77"].jobs = s["jobs-77"].jobs.map((j: { name: string }) =>
          j.name === name ? { name, conclusion } : j,
        );
      });
    it.each([
      ["verify-release", "failure"],
      ["hosted-check", "skipped"],
      ["hosted-attach-prod", "failure"],
      ["hosted-attach-prod", null],
    ])("fails when the marker run's %s is %s", (name, conclusion) => {
      fails(
        jobFails(name, conclusion),
        new RegExp(`job ${name}: ${conclusion}`),
      );
    });

    it("fails when the marker run's hosted-attach-<env> is missing, per env", () => {
      const s = raced((x) => {
        x["jobs-77"].jobs = x["jobs-77"].jobs.filter(
          (j: { name: string }) => j.name !== "hosted-attach-staging",
        );
      });
      fails(s, /job hosted-attach-staging: missing/, "staging");
      expect(run(s, "prod").code).toBe(0);
    });

    it("fails when the marker run is unfinished or failed", () => {
      fails(
        raced((s) => (s["run-77"].status = "in_progress")),
        /not completed/,
      );
      fails(
        raced((s) => (s["run-77"].conclusion = "failure")),
        /concluded failure/,
      );
    });

    it("fails with no marker and no run on the tag's commit", () => {
      fails(
        edit((s) => (s.runs.workflow_runs = [])),
        /no run built v0\.80\.0 .* and no push run for c{40}/,
      );
    });

    it("passes the legacy run on the tag's commit, with no marker", () => {
      const r = run(good());
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`run 41, legacy: the run on ${SHA}`);
    });

    it("fails closed on every API error and bad response", () => {
      fails(
        raced((s) => delete s.artifacts),
        /build marker: GitHub API error/,
      );
      fails(
        raced((s) => (s.artifacts = "<html>")),
        /build marker: unparsable response/,
      );
      fails(
        raced((s) => (s.artifacts = { message: "Not Found" })),
        /build marker: unparsable response/,
      );
      fails(
        raced((s) => delete s["run-77"]),
        /build marker run 77: GitHub API error/,
      );
      fails(
        raced((s) => delete s["jobs-77"]),
        // Falls back to the stub's shared jobs file: skipped, never a pass.
        /job verify-release: skipped/,
      );
      fails(
        raced((s) => (s.artifacts.artifacts[0].workflow_run.id = "77; rm")),
        /build marker: bad run id/,
      );
      fails(
        raced((s) => (s.artifacts.artifacts[0].workflow_run = null)),
        /build marker: bad run id/,
      );
    });

    it("reads every page of markers, and fails past ten", () => {
      // 100 on a page means read the next; the stub serves the same page.
      const full = raced((s) => {
        s.artifacts.artifacts = Array.from({ length: 100 }, () => artifact(77));
      });
      const r = run(full);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(
        /more than 1000 built-from-v0\.80\.0-c{40} artifacts/,
      );
      expect(
        r.calls.filter((c) => c.includes("/actions/artifacts?")).length,
      ).toBe(10);
    });
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
