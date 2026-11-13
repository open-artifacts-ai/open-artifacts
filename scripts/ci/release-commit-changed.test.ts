import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
});
