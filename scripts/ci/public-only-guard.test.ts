// public-only-guard.sh fails when a hosted path listed in private-paths.txt
// exists in the repo. The real list is checked against the real repo too.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, script, write } from "./stubs.ts";

const HERMETIC = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...HERMETIC },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

interface Opts {
  /** Files created and then staged (tracked). */
  files?: Record<string, string>;
  /** Files created but never staged. */
  untracked?: Record<string, string>;
  /** Symlinks (path -> target), staged. */
  links?: Record<string, string>;
  /** Contents of .gitignore, staged. */
  ignore?: string;
  /** Skip `git init`. */
  noGit?: boolean;
}

function guard(list: string | null, o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "public-only-guard-"));
  const repo = join(dir, "repo");
  const listPath = join(dir, "list.txt");
  if (list !== null) write(listPath, list);
  mkdirSync(repo, { recursive: true });
  if (!o.noGit) git(repo, "init", "-q");
  if (o.ignore !== undefined) write(join(repo, ".gitignore"), o.ignore);
  for (const [p, body] of Object.entries(o.files ?? {}))
    write(join(repo, p), body);
  for (const [p, target] of Object.entries(o.links ?? {})) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    symlinkSync(target, join(repo, p));
  }
  if (!o.noGit) git(repo, "add", "-A");
  for (const [p, body] of Object.entries(o.untracked ?? {}))
    write(join(repo, p), body);
  const r = spawnSync("bash", [script("public-only-guard.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...HERMETIC,
      PUBLIC_ONLY_SRC: repo,
      PUBLIC_ONLY_LIST: listPath,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const LIST =
  "# hosted\napps/admin\npackages/provision/  # dir\n\nscripts/hosted.sh\n";

describe("public-only-guard.sh", () => {
  it("passes when none of the listed paths exist", () => {
    const r = guard(LIST, { files: { "apps/server/index.ts": "x\n" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "public-only-guard: 3 hosted paths listed, none present",
    );
  });
  it("fails and names a listed directory", () => {
    const r = guard(LIST, { files: { "apps/admin/package.json": "{}\n" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("hosted path present: apps/admin");
    expect(r.err).not.toContain("packages/provision");
  });
  it("fails and names a listed file, and every offender", () => {
    const r = guard(LIST, {
      files: {
        "scripts/hosted.sh": "true\n",
        "packages/provision/src/a.ts": "x\n",
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("hosted path present: scripts/hosted.sh");
    expect(r.err).toContain("hosted path present: packages/provision");
  });
  it("passes when a listed path holds only untracked files", () => {
    const r = guard(LIST, {
      files: { "apps/server/index.ts": "x\n" },
      untracked: { "apps/admin/node_modules/x/index.js": "x\n" },
    });
    expect(r.code, r.err).toBe(0);
  });
  it("passes when a listed path holds only git-ignored files", () => {
    const r = guard(LIST, {
      ignore: "node_modules/\ndist/\n",
      files: { "apps/server/index.ts": "x\n" },
      untracked: {
        "apps/admin/dist/a.js": "x\n",
        "apps/admin/node_modules/b.js": "x\n",
      },
    });
    expect(r.code, r.err).toBe(0);
  });
  it("fails on a tracked symlink at a listed path", () => {
    const r = guard(LIST, { links: { "scripts/hosted.sh": "nowhere" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("hosted path present: scripts/hosted.sh");
  });
  it("exits 2 when the source is not a git repo", () => {
    const r = guard(LIST, { noGit: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a git work tree");
  });
  it("exits 2 on a missing list", () => {
    expect(guard(null).code).toBe(2);
  });
  it("exits 2 on an empty list", () => {
    const r = guard("# only a comment\n\n");
    expect(r.code).toBe(2);
    expect(r.err).toContain("names no paths");
  });
  it.each(["/etc", "../x", "a/../b", "a/./b", "a b", "$HOME/x"])(
    "exits 2 on the unsafe path %s",
    (p) => {
      const r = guard(`apps/admin\n${p}\n`);
      expect(r.code).toBe(2);
      expect(r.err).toContain("unsafe path");
    },
  );
  it("passes on this repo with the real list", () => {
    const r = spawnSync("bash", [script("public-only-guard.sh")], {
      encoding: "utf8",
      env: { ...process.env, PUBLIC_ONLY_SRC: root, PUBLIC_ONLY_LIST: "" },
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
