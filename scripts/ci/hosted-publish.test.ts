import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// hosted-publish.yml's scripts (design v7 6.4): resolve what to publish
// (hosted-publish-resolve.sh) and fetch a signed floor from a hosted-floor.yml
// run (hosted-floor-fetch.sh). Both read only and fail closed.
const REPO = "open-artifacts-ai/open-artifacts";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("hosted-publish-resolve.sh", () => {
  // gh api -X GET <path>: releases.json, or commit-<tag> holding its sha.
  const gh = `
p="\${@: -1}"; p="\${p#repos/$GITHUB_REPOSITORY/}"
[ -f "$STATE/fail" ] && exit 1
case "$p" in
  releases\\?*) cat "$STATE/releases.json" ;;
  actions/workflows/hosted-publish.yml/runs\\?*) cat "$STATE/runs.json" 2> /dev/null || echo '{"workflow_runs":[]}' ;;
  compare/main...*) [ -f "$STATE/fail-compare" ] && exit 1; echo "{\\"status\\":\\"$(cat "$STATE/compare" 2> /dev/null || echo behind)\\"}" ;;
  actions/runs/*/jobs\\?*) id="\${p#actions/runs/}"; id="\${id%%/*}"; cat "$STATE/jobs-$id.json" ;;
  commits/*) t="\${p#commits/}"; [ -f "$STATE/commit-$t" ] || exit 1; echo "{\\"sha\\":\\"$(cat "$STATE/commit-$t")\\"}" ;;
  *) exit 1 ;;
esac`;
  const release = (tag: string, over: Record<string, unknown> = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    ...over,
  });
  const resolve = (
    env: Record<string, string>,
    state: {
      releases?: unknown[];
      commits?: Record<string, string>;
      fail?: boolean;
      /** hosted-publish.yml runs: id -> its jobs (name, conclusion). */
      runs?: Record<string, { name: string; conclusion: string }[]>;
      runsRaw?: string;
      /** compare/main...<head_sha>'s status (default behind); null: the API fails. */
      compare?: string | null;
    } = {},
  ) => {
    const sb = sandbox({ gh });
    if (state.runs || state.runsRaw)
      writeFileSync(
        join(sb.dir, "runs.json"),
        state.runsRaw ??
          JSON.stringify({
            workflow_runs: Object.keys(state.runs ?? {}).map((id) => ({
              id: Number(id),
              head_branch: "main",
              status: "completed",
              head_repository: { full_name: REPO },
              head_sha: "d".repeat(40),
            })),
          }),
      );
    if (state.compare === null) writeFileSync(join(sb.dir, "fail-compare"), "");
    else if (state.compare !== undefined)
      writeFileSync(join(sb.dir, "compare"), state.compare);
    for (const [id, jobs] of Object.entries(state.runs ?? {}))
      writeFileSync(join(sb.dir, `jobs-${id}.json`), JSON.stringify({ jobs }));
    writeFileSync(
      join(sb.dir, "releases.json"),
      JSON.stringify(state.releases ?? []),
    );
    for (const [t, s] of Object.entries(state.commits ?? {}))
      writeFileSync(join(sb.dir, `commit-${t}`), s);
    if (state.fail) writeFileSync(join(sb.dir, "fail"), "");
    const ghOut = join(sb.dir, "out");
    writeFileSync(ghOut, "");
    const r = sb.run(["bash", script("hosted-publish-resolve.sh")], {
      env: {
        STATE: sb.dir,
        GH_TOKEN: "t",
        GITHUB_REPOSITORY: REPO,
        GITHUB_OUTPUT: ghOut,
        ...env,
      },
    });
    const o = Object.fromEntries(
      readFileSync(ghOut, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("=") as [string, string]),
    );
    return { ...r, o, log: sb.log() };
  };
  const run = {
    EVENT: "workflow_run",
    HEAD_BRANCH: "main",
    CONCLUSION: "success",
    HEAD_SHA: SHA,
  };

  it("after release-please: the release at the run's head commit, to both envs", () => {
    const r = resolve(run, {
      releases: [release("v0.81.0"), release("v0.80.0")],
      commits: { "v0.81.0": OTHER, "v0.80.0": SHA },
    });
    expect(r.code, r.err).toBe(0);
    expect(r.o).toEqual({
      kind: "release",
      tag: "v0.80.0",
      floor_run_id: "",
      staging: "true",
      prod: "true",
    });
  });
  it("no release at that commit (most pushes), a failed run or another branch: nothing", () => {
    for (const [label, env, state] of [
      [
        "no release",
        run,
        { releases: [release("v0.80.0")], commits: { "v0.80.0": OTHER } },
      ],
      [
        "draft",
        run,
        {
          releases: [release("v0.80.0", { draft: true })],
          commits: { "v0.80.0": SHA },
        },
      ],
      [
        "prerelease",
        run,
        {
          releases: [release("v0.80.0-rc.1", { prerelease: true })],
          commits: { "v0.80.0-rc.1": SHA },
        },
      ],
      ["failed", { ...run, CONCLUSION: "failure" }, {}],
      ["branch", { ...run, HEAD_BRANCH: "feature" }, {}],
    ] as [string, Record<string, string>, Parameters<typeof resolve>[1]][]) {
      const r = resolve(env, state);
      expect(r.code, label).toBe(0);
      expect(r.o.kind, label).toBe("none");
      expect(r.o.staging, label).toBe("false");
      expect(r.o.prod, label).toBe("false");
    }
  });
  it("an API error fails, never reads as no release", () => {
    expect(resolve(run, { fail: true }).code).toBe(1);
    // A tag whose commit can't be read.
    expect(resolve(run, { releases: [release("v0.80.0")] }).code).toBe(1);
  });
  it("dispatch with a tag: both envs, or the one named", () => {
    const d = { EVENT: "workflow_dispatch" };
    expect(resolve({ ...d, TAG: "v0.80.0" }).o).toMatchObject({
      kind: "release",
      tag: "v0.80.0",
      staging: "true",
      prod: "true",
    });
    expect(
      resolve({ ...d, TAG: "v0.80.0", DEPLOY_ENV: "staging" }).o,
    ).toMatchObject({ staging: "true", prod: "false" });
    // Prod alone: only once the tag's staging publish succeeded.
    const staged = {
      runs: {
        "41": [
          { name: "publish-staging release v0.80.0", conclusion: "success" },
        ],
      },
    };
    const r = resolve({ ...d, TAG: "v0.80.0", DEPLOY_ENV: "prod" }, staged);
    expect(r.code, r.err).toBe(0);
    expect(r.o).toMatchObject({ staging: "false", prod: "true" });
    expect(r.out).toContain("v0.80.0 was published to staging (run 41)");
  });
  it("dispatch to prod alone: the staging record's run must be on main (identical or behind pass; ahead, diverged, an API error or no head_sha refuse)", () => {
    const d = {
      EVENT: "workflow_dispatch",
      TAG: "v0.80.0",
      DEPLOY_ENV: "prod",
    };
    const runs = {
      "41": [
        { name: "publish-staging release v0.80.0", conclusion: "success" },
      ],
    };
    for (const compare of ["identical", "behind"]) {
      const r = resolve(d, { runs, compare });
      expect(r.code, compare).toBe(0);
      expect(r.log).toContain(
        `gh api -X GET repos/${REPO}/compare/main...${"d".repeat(40)}`,
      );
    }
    for (const compare of ["ahead", "diverged", null]) {
      const r = resolve(d, { runs, compare });
      expect(r.code, String(compare)).toBe(1);
      expect(r.o).toEqual({});
      expect(r.err).toContain(
        compare === null ? "comparing" : "is not on main",
      );
    }
    const noSha = resolve(d, {
      runs,
      runsRaw: JSON.stringify({
        workflow_runs: [
          {
            id: 41,
            head_branch: "main",
            status: "completed",
            head_repository: { full_name: REPO },
          },
        ],
      }),
    });
    expect(noSha.code).toBe(1);
    expect(noSha.err).toContain("hosted-publish.yml run 41 has no head_sha");
    expect(noSha.log.some((l) => l.includes("/compare/"))).toBe(false);
  });
  it("dispatch to prod alone refuses a tag with no successful staging publish, writing no output", () => {
    const d = {
      EVENT: "workflow_dispatch",
      TAG: "v0.80.0",
      DEPLOY_ENV: "prod",
    };
    const job = (name: string, conclusion = "success") => ({
      name,
      conclusion,
    });
    for (const [label, state] of [
      ["no runs", {}],
      ["no staging job", { runs: { "1": [job("resolve")] } }],
      [
        "another tag",
        { runs: { "1": [job("publish-staging release v0.79.0")] } },
      ],
      [
        "a longer tag",
        { runs: { "1": [job("publish-staging release v0.80.01")] } },
      ],
      [
        "failed",
        { runs: { "1": [job("publish-staging release v0.80.0", "failure")] } },
      ],
      ["a floor", { runs: { "1": [job("publish-staging floor ")] } }],
      ["only prod's", { runs: { "1": [job("publish-prod")] } }],
    ] as [string, Parameters<typeof resolve>[1]][]) {
      const r = resolve(d, state);
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain(
        "v0.80.0 has no successful staging publish",
      );
      expect(r.o, label).toEqual({});
    }
    // Runs of another branch or a fork don't count.
    const other = resolve(d, {
      runsRaw: JSON.stringify({
        workflow_runs: [
          {
            id: 1,
            head_branch: "feature",
            status: "completed",
            head_repository: { full_name: REPO },
          },
          {
            id: 2,
            head_branch: "main",
            status: "completed",
            head_repository: { full_name: "evil/x" },
          },
        ],
      }),
    });
    expect(other.code).toBe(1);
    expect(other.log.filter((l) => l.includes("/jobs"))).toEqual([]);
    // API errors fail closed.
    expect(resolve(d, { fail: true }).code).toBe(1);
    expect(resolve(d, { runsRaw: "not json" }).code).toBe(1);
    expect(resolve(d, { runsRaw: "{}" }).code).toBe(1);
    // Staging, or both envs, need no record.
    expect(resolve({ ...d, DEPLOY_ENV: "staging" }).code).toBe(0);
    expect(resolve({ ...d, DEPLOY_ENV: "both" }).code).toBe(0);
  });
  it("dispatch with a floor run: its env only, which it needs", () => {
    const d = { EVENT: "workflow_dispatch" };
    expect(
      resolve({ ...d, FLOOR_RUN_ID: "123", DEPLOY_ENV: "prod" }).o,
    ).toEqual({
      kind: "floor",
      tag: "",
      floor_run_id: "123",
      staging: "false",
      prod: "true",
    });
    for (const env of [
      { FLOOR_RUN_ID: "123" },
      { FLOOR_RUN_ID: "123", DEPLOY_ENV: "both" },
      { FLOOR_RUN_ID: "12a", DEPLOY_ENV: "prod" },
      { TAG: "v0.80.0", FLOOR_RUN_ID: "123", DEPLOY_ENV: "prod" },
      { TAG: "0.80.0" },
      { TAG: "v0.80.0-rc.1" },
      { TAG: "v0.80.0", DEPLOY_ENV: "dev" },
      {},
    ] as Record<string, string>[]) {
      const r = resolve({ ...d, ...env });
      expect(r.code, JSON.stringify(env)).toBe(2);
      expect(r.o).toEqual({});
    }
    expect(resolve({ EVENT: "push" }).code).toBe(2);
  });
});

describe("hosted-floor-fetch.sh", () => {
  // gh api: the run; gh run download: writes $STATE/files/* into --dir.
  const gh = `
case "$1" in
  api) [ -f "$STATE/run.json" ] || exit 1; cat "$STATE/run.json" ;;
  run) for ((i = 1; i <= $#; i++)); do [ "\${!i}" = --dir ] && { j=$((i + 1)); d="\${!j}"; }; done
       [ -f "$STATE/fail-download" ] && exit 1
       mkdir -p "$d"; cp -R "$STATE/files/." "$d/" ;;
esac`;
  const goodRun = {
    path: ".github/workflows/hosted-floor.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const fetch = (
    runJson: unknown,
    files: Record<string, string>,
    opts: { env?: string; fail?: boolean } = {},
  ) => {
    const sb = sandbox({ gh });
    if (runJson)
      writeFileSync(join(sb.dir, "run.json"), JSON.stringify(runJson));
    mkdirSync(join(sb.dir, "files"));
    for (const [f, v] of Object.entries(files)) {
      mkdirSync(join(sb.dir, "files", f.split("/").slice(0, -1).join("/")), {
        recursive: true,
      });
      writeFileSync(join(sb.dir, "files", f), v);
    }
    if (opts.fail) writeFileSync(join(sb.dir, "fail-download"), "");
    const dir = join(sb.dir, "floor");
    const r = sb.run(
      ["bash", script("hosted-floor-fetch.sh"), opts.env ?? "prod", "42", dir],
      {
        env: { STATE: sb.dir, GH_TOKEN: "t", GITHUB_REPOSITORY: REPO },
      },
    );
    return { ...r, dir, log: sb.log() };
  };
  it("the one signed floor of the env, from a successful hosted-floor.yml dispatch on main", () => {
    const r = fetch(goodRun, { "floor-prod-3/floor-prod-3.sig.json": "{}" });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(
      join(r.dir, "floor-prod-3/floor-prod-3.sig.json"),
    );
    expect(r.log).toContain(
      `gh run download 42 --repo ${REPO} --pattern floor-prod-* --dir ${r.dir}`,
    );
  });
  it("refuses a run that isn't hosted-floor.yml, dispatched on main, successful", () => {
    for (const over of [
      { path: ".github/workflows/hosted-publish.yml" },
      { event: "push" },
      { head_branch: "feature" },
      { conclusion: "failure" },
      { status: "in_progress" },
    ]) {
      const r = fetch(
        { ...goodRun, ...over },
        { "floor-prod-3.sig.json": "{}" },
      );
      expect(r.code, JSON.stringify(over)).toBe(1);
      expect(r.log.some((l) => l.startsWith("gh run download"))).toBe(false);
    }
    expect(fetch(null, {}).code).toBe(1);
  });
  it("refuses none, two, or another env's floor; a failed download fails", () => {
    expect(fetch(goodRun, {}).code).toBe(1);
    expect(
      fetch(goodRun, {
        "a/floor-prod-3.sig.json": "{}",
        "b/floor-prod-4.sig.json": "{}",
      }).code,
    ).toBe(1);
    expect(fetch(goodRun, { "floor-staging-3.sig.json": "{}" }).code).toBe(1);
    expect(
      fetch(goodRun, { "floor-prod-3.sig.json": "{}" }, { fail: true }).code,
    ).toBe(1);
    expect(fetch(goodRun, {}, { env: "dev" }).code).toBe(2);
  });
});
