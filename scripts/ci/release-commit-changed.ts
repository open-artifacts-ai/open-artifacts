// Refuse to tag an empty release commit (#2379).
// Usage: node --experimental-strip-types scripts/ci/release-commit-changed.ts
// Run in a checkout with HEAD and its first parent (fetch-depth >= 2). Exits 1
// with an ::error:: line when the root package.json version at HEAD equals the
// one at HEAD^1. With --before-tag, also validate the merged release PR title,
// committed files and highest published stable tag via GitHub.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { realExec, versionProblems } from "./release-cadence.ts";

export type Show = (rev: string) => string;

export function versionAt(show: Show, rev: string): string {
  return String(JSON.parse(show(rev)).version ?? "");
}

/** Returns an error message when the version did not change, else undefined. */
export function check(show: Show, sha = "HEAD"): string | undefined {
  const now = versionAt(show, sha);
  const before = versionAt(show, `${sha}^1`);
  if (now === before)
    return `version did not change in ${sha}; not the release commit (package.json is ${now} in both it and its first parent), so no tag is created.`;
  return undefined;
}

const gitShow: Show = (rev) => {
  const r = spawnSync("git", ["show", `${rev}:package.json`], {
    encoding: "utf8",
  });
  if (r.status !== 0)
    throw new Error(`git show ${rev}:package.json: ${r.stderr.trim()}`);
  return r.stdout;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const err = check(gitShow);
    if (err) {
      console.log(`::error::${err}`);
      process.exit(1);
    }
    if (process.argv.includes("--before-tag")) {
      const repo = process.env.GITHUB_REPOSITORY;
      const pr = process.env.RELEASE_PR ?? "";
      if (!repo || !/^[1-9]\d*$/.test(pr))
        throw new Error("missing release repository or release PR");
      const git = (...args: string[]) =>
        execFileSync("git", args, { encoding: "utf8" }).trim();
      const title = execFileSync(
        "gh",
        ["api", `repos/${repo}/pulls/${pr}`, "--jq", ".title"],
        { encoding: "utf8" },
      ).trim();
      const problems = await versionProblems(
        realExec,
        repo,
        { title, sha: git("rev-parse", "HEAD") },
        git("rev-parse", "HEAD^1"),
      );
      if (problems.length) throw new Error(problems.join(", "));
    }
    console.log("the version changed in this commit");
  } catch (e) {
    console.log(`::error::${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
