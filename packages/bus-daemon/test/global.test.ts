// C19: global comes only from the user's allowlist, never from a repo's `.oa-bus.json`.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  globalFile,
  isGlobalDir,
  readGlobalDirs,
  writeGlobalDirs,
} from "../src/global.ts";
import { resolveNamespace } from "../src/namespace.ts";

const tmp = (p = "ob-gl-") => realpathSync(mkdtempSync(join(tmpdir(), p)));
const noGit = { gitRemote: () => null, gitRoot: () => null };

/** A temp OA_BUS_HOME whose allowlist holds `dirs`. */
function homeWith(dirs: string[]): string {
  const h = tmp("ob-gh-");
  writeGlobalDirs(dirs, h);
  return h;
}

describe("C19: the global allowlist", () => {
  it("a cloned repo whose .oa-bus.json says global: true stays non-global, logged once", () => {
    const repo = tmp();
    writeFileSync(
      join(repo, ".oa-bus.json"),
      JSON.stringify({ namespace: "cloned", global: true }),
      {
        mode: 0o644,
      },
    );
    const log = vi.fn();
    const deps = { ...noGit, log, globalFile: globalFile(homeWith([])) };
    expect(resolveNamespace(repo, deps)).toEqual({
      namespace: "cloned",
      global: false,
      source: "config",
    });
    resolveNamespace(repo, deps);
    expect(log.mock.calls.filter(([m]) => /global/.test(m))).toHaveLength(1);
  });

  it("an allowlisted dir and its subdir are global; a sibling sharing its prefix is not", () => {
    const root = tmp();
    for (const d of ["ops", "ops/deep", "opsx"]) mkdirSync(join(root, d));
    const deps = {
      ...noGit,
      globalFile: globalFile(homeWith([join(root, "ops")])),
    };
    expect(resolveNamespace(join(root, "ops"), deps).global).toBe(true);
    expect(resolveNamespace(join(root, "ops/deep"), deps).global).toBe(true);
    expect(resolveNamespace(join(root, "opsx"), deps).global).toBe(false);
    expect(resolveNamespace(root, deps).global).toBe(false);
  });

  it("a session started through a symlink matches by realpath", () => {
    const root = tmp();
    mkdirSync(join(root, "ops"));
    symlinkSync(join(root, "ops"), join(root, "link"));
    const deps = {
      ...noGit,
      globalFile: globalFile(homeWith([join(root, "ops")])),
    };
    expect(resolveNamespace(join(root, "link"), deps).global).toBe(true);
  });

  it("matches by identity on path-segment boundaries", () => {
    const root = tmp();
    for (const d of ["a/b/c", "a/bc"])
      mkdirSync(join(root, d), { recursive: true });
    const at = (p: string) => join(root, p);
    expect(isGlobalDir(at("a/b"), [at("a/b")])).toBe(true);
    expect(isGlobalDir(at("a/b/c"), [at("a/b")])).toBe(true);
    expect(isGlobalDir(at("a/bc"), [at("a/b")])).toBe(false);
    expect(isGlobalDir(at("a"), [at("a/b")])).toBe(false);
    expect(isGlobalDir(at("a/bc"), ["/"])).toBe(true);
    // A missing entry covers nothing.
    expect(isGlobalDir(at("a/b"), [at("gone")])).toBe(false);
  });

  it("a malformed or unreadable allowlist means none, logged once, never a crash", () => {
    const dir = tmp();
    for (const body of [
      "{not json",
      '{"dirs":["relative/path"]}',
      '["/x"]',
      '{"dirs":"/x"}',
    ]) {
      const h = tmp("ob-gh-");
      writeFileSync(join(h, "global.json"), body, { mode: 0o600 });
      expect(readGlobalDirs(globalFile(h))).toMatchObject({ dirs: [] });
      expect(readGlobalDirs(globalFile(h)).error).toBeDefined();
      const log = vi.fn();
      const deps = { ...noGit, log, globalFile: globalFile(h) };
      expect(resolveNamespace(dir, deps).global).toBe(false);
      resolveNamespace(dir, deps);
      expect(log).toHaveBeenCalledOnce();
    }
    // A folder where the file should be: unreadable.
    const h = tmp("ob-gh-");
    mkdirSync(join(h, "global.json"));
    expect(readGlobalDirs(globalFile(h))).toMatchObject({ dirs: [] });
    // None at all is simply empty.
    expect(readGlobalDirs(globalFile(tmp("ob-gh-")))).toEqual({ dirs: [] });
  });

  it("writes the allowlist 0600, atomically, replacing a symlink rather than following it", () => {
    const h = tmp("ob-gh-");
    const target = join(tmp(), "elsewhere.json");
    writeFileSync(target, "keep");
    symlinkSync(target, join(h, "global.json"));
    writeGlobalDirs(["/a/b"], h);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(statSync(join(h, "global.json")).mode & 0o777).toBe(0o600);
    expect(readGlobalDirs(globalFile(h))).toEqual({ dirs: ["/a/b"] });
  });
});
