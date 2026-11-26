import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./release-commit-changed.ts";

const pkg = (v: string) => JSON.stringify({ name: "x", version: v });
const show = (now: string, before: string) => (rev: string) =>
  rev.endsWith("^1") ? pkg(before) : pkg(now);

describe("release-commit-changed", () => {
  it("passes when the version changed", () => {
    expect(check(show("0.168.0", "0.167.0"))).toBeUndefined();
  });
  it("refuses an empty release commit", () => {
    expect(check(show("0.168.0", "0.168.0"), "7599c83f")).toMatch(
      /version did not change in 7599c83f; not the release commit/,
    );
  });
});

describe("release-commit-changed: real git", () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "release-commit-changed.ts",
  );
  const git = (cwd: string, ...a: string[]) =>
    spawnSync("git", a, { cwd, encoding: "utf8" });
  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), "rcc-"));
    git(d, "init", "-q");
    git(d, "config", "user.email", "t@t");
    git(d, "config", "user.name", "t");
    git(d, "config", "commit.gpgsign", "false");
    writeFileSync(join(d, "package.json"), pkg("1.0.0"));
    git(d, "add", ".");
    git(d, "commit", "-qm", "base");
    return d;
  };
  const run = (d: string) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", script],
      { cwd: d, encoding: "utf8" },
    );
  it("exits 0 on a version bump and 1 on an empty commit", () => {
    const d = repo();
    writeFileSync(join(d, "package.json"), pkg("1.1.0"));
    git(d, "commit", "-qam", "release");
    expect(run(d).status).toBe(0);
    git(d, "commit", "-q", "--allow-empty", "-m", "empty");
    const r = run(d);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::version did not change");
  });
  it("checks the merged PR and committed versions against the preceding tag before publication", () => {
    const d = repo();
    const manifest = (version: string) =>
      writeFileSync(
        join(d, ".release-please-manifest.json"),
        JSON.stringify({ ".": version }),
      );
    manifest("1.0.0");
    git(d, "add", ".");
    git(d, "commit", "-qm", "record release manifest");
    manifest("1.1.0");
    writeFileSync(join(d, "package.json"), pkg("1.1.0"));
    writeFileSync(join(d, "CHANGELOG.md"), "## [1.1.0]\n");
    git(d, "add", ".");
    git(d, "commit", "-qm", "release");
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$*" in
  *repos/o/r/pulls/12*) echo "chore(main): release $CANDIDATE" ;;
  *git/matching-refs/tags/v*) echo "refs/tags/v$PREVIOUS" ;;
  *repos/o/r/contents/*)
    path="\${4#repos/o/r/contents/}"
    git show "\${path##*ref=}:\${path%%[?]*}"
    ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const runTag = (candidate: string, previous: string) =>
      spawnSync(process.execPath, [script, "--before-tag"], {
        cwd: d,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "o/r",
          RELEASE_PR: "12",
          CANDIDATE: candidate,
          PREVIOUS: previous,
        },
      });
    const pass = runTag("1.1.0", "1.0.0");
    expect(pass.status, pass.stdout + pass.stderr).toBe(0);
    expect(runTag("1.2.0", "1.0.0").stdout).toContain("versions disagree");
    expect(runTag("1.1.0", "1.10.0").stdout).toContain(
      "not above the latest tag",
    );
  });
});
