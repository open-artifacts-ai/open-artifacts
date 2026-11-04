import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// staging-smoke-gate.sh (#1406): prod takes a tag only while the newest
// completed deploy-staging.yml run on main is at or after the tag's commit and
// its smoke job succeeded. Lookup errors fail closed.
const SCRIPT = script("staging-smoke-gate.sh");
const REPO = "open-artifacts-ai/open-artifacts";
const TAG = "v0.80.0";
const TSHA = "a".repeat(40);
const HEAD = "b".repeat(40);

// gh api: the tag's commit, the runs listing, two compares, a run's jobs.
const gh = `
p="\${@: -1}"; p="\${p#repos/$GITHUB_REPOSITORY/}"
[ -f "$STATE/fail" ] && { echo "HTTP 502" >&2; exit 1; }
case "$p" in
  commits/*) [ -f "$STATE/fail-commit" ] && exit 1; cat "$STATE/commit.json" ;;
  actions/workflows/deploy-staging.yml/runs\\?*) cat "$STATE/runs.json" ;;
  compare/main...*) [ -f "$STATE/fail-main" ] && exit 1; cat "$STATE/main.json" ;;
  compare/*) [ -f "$STATE/fail-compare" ] && exit 1; cat "$STATE/compare.json" ;;
  actions/runs/*/jobs\\?*) [ -f "$STATE/fail-jobs" ] && exit 1; id="\${p#actions/runs/}"; cat "$STATE/jobs-\${id%%/*}.json" ;;
  *) exit 1 ;;
esac`;
const runOf = (over: Record<string, unknown> = {}) => ({
  id: 9,
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  event: "push",
  head_repository: { full_name: REPO },
  created_at: "2026-11-03T09:00:00Z",
  run_started_at: "2026-11-03T09:00:05Z",
  head_sha: HEAD,
  ...over,
});
type Job = { name: string; conclusion: string | null };
const jobsOf = (smoke: string | null, extra: Job[] = []): Job[] => [
  { name: "deploy", conclusion: "success" },
  { name: "smoke", conclusion: smoke },
  { name: "report", conclusion: "success" },
  ...extra,
];
const gate = (
  runs: unknown,
  opts: {
    fail?: "fail" | "fail-commit" | "fail-compare" | "fail-main" | "fail-jobs";
    /** compare/<tag sha>...<head> (default ahead). */
    compare?: string;
    /** compare/main...<head> (default behind). */
    main?: string;
    commit?: unknown;
    /** run id -> its jobs (default: run 9's smoke green). */
    jobs?: Record<string, Job[] | string>;
    tag?: string;
  } = {},
) => {
  const sb = sandbox({ gh });
  const w = (f: string, v: unknown) =>
    writeFileSync(
      join(sb.dir, f),
      typeof v === "string" ? v : JSON.stringify(v),
    );
  w(
    "runs.json",
    typeof runs === "string" ? runs : JSON.stringify({ workflow_runs: runs }),
  );
  w("commit.json", opts.commit ?? { sha: TSHA });
  w("compare.json", { status: opts.compare ?? "ahead" });
  w("main.json", { status: opts.main ?? "behind" });
  for (const [id, j] of Object.entries(opts.jobs ?? { "9": jobsOf("success") }))
    w(`jobs-${id}.json`, typeof j === "string" ? j : { jobs: j });
  if (opts.fail) w(opts.fail, "");
  const r = sb.run(["bash", SCRIPT, opts.tag ?? TAG], {
    env: { STATE: sb.dir, GH_TOKEN: "t", GITHUB_REPOSITORY: REPO },
  });
  return { ...r, log: sb.log() };
};

describe("staging-smoke-gate.sh", () => {
  it("passes when the newest completed run on main is after the tag and its smoke is green", () => {
    const r = gate([runOf()]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `staging smoke: green in run 9 (head ${HEAD}), at or after ${TAG} (${TSHA})`,
    );
    expect(r.log).toEqual([
      `gh api -X GET repos/${REPO}/commits/${TAG}`,
      `gh api -X GET repos/${REPO}/actions/workflows/deploy-staging.yml/runs?branch=main&event=push&status=completed&per_page=100`,
      `gh api -X GET repos/${REPO}/compare/${TSHA}...${HEAD}`,
      `gh api -X GET repos/${REPO}/compare/main...${HEAD}`,
      `gh api -X GET repos/${REPO}/actions/runs/9/jobs?filter=latest&per_page=100`,
    ]);
  });

  it("the run at the tag's own commit counts (identical)", () => {
    expect(
      gate([runOf({ head_sha: TSHA })], { compare: "identical" }).code,
    ).toBe(0);
  });

  it("refuses a red, cancelled, skipped, missing or duplicated smoke job", () => {
    for (const [label, jobs] of [
      ["failure", jobsOf("failure")],
      ["cancelled", jobsOf("cancelled")],
      ["skipped", jobsOf("skipped")],
      ["null", jobsOf(null)],
      ["missing", jobsOf("success").filter((j) => j.name !== "smoke")],
      ["two", jobsOf("success", [{ name: "smoke", conclusion: "success" }])],
    ] as const) {
      const r = gate([runOf()], { jobs: { "9": [...jobs] } });
      expect(r.code, label).toBe(1);
      expect(r.err, label).toMatch(/run 9's smoke job: \w+/);
    }
    const r = gate([runOf()], { jobs: { "9": jobsOf("failure") } });
    expect(r.err).toContain("run 9's smoke job: failure");
    expect(r.err).toContain(`prod waits until a deploy-staging.yml run`);
  });

  it("only the newest completed run counts: an older green run never vouches for a newer red one", () => {
    const newer = runOf({ id: 10, run_started_at: "2026-11-03T10:00:00Z" });
    const r = gate([newer, runOf()], {
      jobs: { "9": jobsOf("success"), "10": jobsOf("failure") },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("run 10's smoke job: failure");
    // And a newer green run clears an older red one.
    const g = gate([newer, runOf()], {
      jobs: { "9": jobsOf("failure"), "10": jobsOf("success") },
    });
    expect(g.code).toBe(0);
    expect(g.out).toContain("green in run 10");
  });

  it("a cancelled run superseded by a newer completed run doesn't block; a cancelled newest one does", () => {
    const cancelled = runOf({
      id: 8,
      conclusion: "cancelled",
      created_at: "2026-11-03T08:00:00Z",
      run_started_at: "2026-11-03T08:00:00Z",
    });
    const ok = gate([runOf(), cancelled], {
      jobs: { "8": jobsOf("cancelled"), "9": jobsOf("success") },
    });
    expect(ok.code).toBe(0);
    expect(ok.log.some((l) => l.includes("/runs/8/"))).toBe(false);
    const newest = runOf({
      id: 10,
      conclusion: "cancelled",
      run_started_at: "2026-11-03T10:00:00Z",
    });
    const r = gate([newest, runOf()], {
      jobs: { "9": jobsOf("success"), "10": jobsOf(null) },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("run 10's smoke job: none");
  });

  it("a cancelled run whose smoke had already passed still counts (it was cancelled after)", () => {
    const r = gate([runOf({ conclusion: "cancelled" })]);
    expect(r.code).toBe(0);
  });

  it("orders by the latest attempt's start: a re-run of an older run is the newest", () => {
    // Run 7 (an older commit) was re-run after run 9, so staging runs its code.
    const rerun = runOf({
      id: 7,
      head_sha: "c".repeat(40),
      created_at: "2026-11-02T09:00:00Z",
      run_started_at: "2026-11-03T11:00:00Z",
    });
    const r = gate([runOf(), rerun], {
      compare: "behind",
      jobs: { "7": jobsOf("success"), "9": jobsOf("success") },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `the newest completed run 7 (head ${"c".repeat(40)}) is not at or after ${TAG}'s commit ${TSHA} (behind)`,
    );
  });

  it("skips runs that are not completed pushes on main of this repository", () => {
    for (const [label, run] of [
      ["in progress", runOf({ id: 10, status: "in_progress" })],
      ["branch", runOf({ id: 10, head_branch: "feature" })],
      ["dispatch", runOf({ id: 10, event: "workflow_dispatch" })],
      ["fork", runOf({ id: 10, head_repository: { full_name: "evil/x" } })],
      ["no repo", runOf({ id: 10, head_repository: null })],
    ] as const) {
      // Newer than run 9 and red: it would block if it counted.
      const r = gate(
        [{ ...run, run_started_at: "2026-11-03T12:00:00Z" }, runOf()],
        { jobs: { "9": jobsOf("success"), "10": jobsOf("failure") } },
      );
      expect(r.code, label).toBe(0);
      expect(r.out, label).toContain("green in run 9");
    }
  });

  it("refuses when there is no completed run on main", () => {
    for (const runs of [[], [runOf({ status: "in_progress" })]]) {
      const r = gate(runs);
      expect(r.code).toBe(1);
      expect(r.err).toContain("no completed deploy-staging.yml run on main");
    }
  });

  it("refuses a newest run before the tag's commit, or off main", () => {
    for (const compare of ["behind", "diverged", ""]) {
      const r = gate([runOf()], { compare });
      expect(r.code, compare).toBe(1);
      expect(r.err).toContain("is not at or after");
      expect(r.log.some((l) => l.includes("/jobs"))).toBe(false);
    }
    for (const main of ["ahead", "diverged", ""]) {
      const r = gate([runOf()], { main });
      expect(r.code, main).toBe(1);
      expect(r.err).toContain(`run 9's head ${HEAD} is not on main`);
      expect(r.log.some((l) => l.includes("/jobs"))).toBe(false);
    }
    for (const head_sha of [null, "", "main"]) {
      const r = gate([runOf({ head_sha })]);
      expect(r.code, String(head_sha)).toBe(1);
      expect(r.err).toContain("run 9 has no head_sha");
    }
  });

  it("fails closed on an API error or an unparsable answer", () => {
    for (const fail of [
      "fail",
      "fail-commit",
      "fail-compare",
      "fail-main",
      "fail-jobs",
    ] as const) {
      const r = gate([runOf()], { fail });
      expect(r.code, fail).toBe(1);
      expect(r.err, fail).toContain("GitHub API error");
    }
    for (const bad of ["not json", "{}", '{"workflow_runs": 3}']) {
      const r = gate(bad);
      expect(r.code, bad).toBe(1);
    }
    for (const bad of ["not json", "{}", '{"jobs": 3}']) {
      const r = gate([runOf()], { jobs: { "9": bad } });
      expect(r.code, bad).toBe(1);
    }
    for (const commit of [{}, { sha: "main" }, "not json"]) {
      const r = gate([runOf()], { commit });
      expect(r.code, JSON.stringify(commit)).toBe(1);
    }
    expect(gate([runOf({ id: "x" })]).code).toBe(1);
  });

  it("refuses a tag that isn't a stable vX.Y.Z before any call", () => {
    for (const t of ["0.80.0", "v0.80.0-rc.1", "main", ""]) {
      const r = gate([runOf()], { tag: t });
      expect(r.code, t).toBe(2);
      expect(r.log).toEqual([]);
    }
  });
});
