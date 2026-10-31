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
    } = {},
  ) => {
    const sb = sandbox({ gh });
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
  const run = { EVENT: "workflow_run", HEAD_BRANCH: "main", CONCLUSION: "success", HEAD_SHA: SHA };

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
      ["no release", run, { releases: [release("v0.80.0")], commits: { "v0.80.0": OTHER } }],
      ["draft", run, { releases: [release("v0.80.0", { draft: true })], commits: { "v0.80.0": SHA } }],
      ["prerelease", run, { releases: [release("v0.80.0-rc.1", { prerelease: true })], commits: { "v0.80.0-rc.1": SHA } }],
      ["failed", { ...run, CONCLUSION: "failure" }, {}],
      ["branch", { ...run, HEAD_BRANCH: "feature" }, {}],
    ] as const) {
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
    expect(resolve({ ...d, TAG: "v0.80.0" }).o).toMatchObject({ kind: "release", tag: "v0.80.0", staging: "true", prod: "true" });
    expect(resolve({ ...d, TAG: "v0.80.0", DEPLOY_ENV: "staging" }).o).toMatchObject({ staging: "true", prod: "false" });
    expect(resolve({ ...d, TAG: "v0.80.0", DEPLOY_ENV: "prod" }).o).toMatchObject({ staging: "false", prod: "true" });
  });
  it("dispatch with a floor run: its env only, which it needs", () => {
    const d = { EVENT: "workflow_dispatch" };
    expect(resolve({ ...d, FLOOR_RUN_ID: "123", DEPLOY_ENV: "prod" }).o).toEqual({
      kind: "floor",
      tag: "",
      floor_run_id: "123",
      staging: "false",
      prod: "true",
    });
    for (const env of [
      { FLOOR_RUN_ID: "123" },
      { FLOOR_RUN_ID: "12a", DEPLOY_ENV: "prod" },
      { TAG: "v0.80.0", FLOOR_RUN_ID: "123", DEPLOY_ENV: "prod" },
      { TAG: "0.80.0" },
      { TAG: "v0.80.0-rc.1" },
      { TAG: "v0.80.0", DEPLOY_ENV: "dev" },
      {},
    ]) {
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
    if (runJson) writeFileSync(join(sb.dir, "run.json"), JSON.stringify(runJson));
    mkdirSync(join(sb.dir, "files"));
    for (const [f, v] of Object.entries(files)) {
      mkdirSync(join(sb.dir, "files", f.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(sb.dir, "files", f), v);
    }
    if (opts.fail) writeFileSync(join(sb.dir, "fail-download"), "");
    const dir = join(sb.dir, "floor");
    const r = sb.run(["bash", script("hosted-floor-fetch.sh"), opts.env ?? "prod", "42", dir], {
      env: { STATE: sb.dir, GH_TOKEN: "t", GITHUB_REPOSITORY: REPO },
    });
    return { ...r, dir, log: sb.log() };
  };
  it("the one signed floor of the env, from a successful hosted-floor.yml dispatch on main", () => {
    const r = fetch(goodRun, { "floor-prod-3/floor-prod-3.sig.json": "{}" });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(join(r.dir, "floor-prod-3/floor-prod-3.sig.json"));
    expect(r.log).toContain(`gh run download 42 --repo ${REPO} --pattern floor-prod-* --dir ${r.dir}`);
  });
  it("refuses a run that isn't hosted-floor.yml, dispatched on main, successful", () => {
    for (const over of [
      { path: ".github/workflows/hosted-publish.yml" },
      { event: "push" },
      { head_branch: "feature" },
      { conclusion: "failure" },
      { status: "in_progress" },
    ]) {
      const r = fetch({ ...goodRun, ...over }, { "floor-prod-3.sig.json": "{}" });
      expect(r.code, JSON.stringify(over)).toBe(1);
      expect(r.log.some((l) => l.startsWith("gh run download"))).toBe(false);
    }
    expect(fetch(null, {}).code).toBe(1);
  });
  it("refuses none, two, or another env's floor; a failed download fails", () => {
    expect(fetch(goodRun, {}).code).toBe(1);
    expect(fetch(goodRun, { "a/floor-prod-3.sig.json": "{}", "b/floor-prod-4.sig.json": "{}" }).code).toBe(1);
    expect(fetch(goodRun, { "floor-staging-3.sig.json": "{}" }).code).toBe(1);
    expect(fetch(goodRun, { "floor-prod-3.sig.json": "{}" }, { fail: true }).code).toBe(1);
    expect(fetch(goodRun, {}, { env: "dev" }).code).toBe(2);
  });
});
