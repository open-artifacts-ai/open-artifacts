// public-only-guard.sh fails when a hosted path listed in private-paths.txt
// exists in the repo. The real list is checked against the real repo too.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, script, write } from "./stubs.ts";

function guard(list: string | null, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "public-only-guard-"));
  const listPath = join(dir, "list.txt");
  if (list !== null) write(listPath, list);
  for (const [p, body] of Object.entries(files))
    write(join(dir, "repo", p), body);
  mkdirSync(join(dir, "repo"), { recursive: true });
  const r = spawnSync("bash", [script("public-only-guard.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PUBLIC_ONLY_SRC: join(dir, "repo"),
      PUBLIC_ONLY_LIST: listPath,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const LIST =
  "# hosted\napps/admin\npackages/provision/  # dir\n\nscripts/hosted.sh\n";

describe("public-only-guard.sh", () => {
  it("passes when none of the listed paths exist", () => {
    const r = guard(LIST, { "apps/server/index.ts": "x\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "public-only-guard: 3 hosted paths listed, none present",
    );
  });
  it("fails and names a listed directory", () => {
    const r = guard(LIST, { "apps/admin/package.json": "{}\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("hosted path present: apps/admin");
    expect(r.err).not.toContain("packages/provision");
  });
  it("fails and names a listed file, and every offender", () => {
    const r = guard(LIST, {
      "scripts/hosted.sh": "true\n",
      "packages/provision/src/a.ts": "x\n",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("hosted path present: scripts/hosted.sh");
    expect(r.err).toContain("hosted path present: packages/provision");
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
