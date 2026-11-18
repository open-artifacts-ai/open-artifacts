import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import setup, { RUN_ROOT_PREFIX, STALE_MS, sweepStale } from "./tmp-root.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["TMPDIR", "TMP", "TEMP"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the per-run temp root", () => {
  it("this run already has one: os.tmpdir() is inside a vt- root", () => {
    expect(basename(tmpdir())).toMatch(/^vt-[A-Za-z0-9]{6}$/);
  });

  it("points TMPDIR, TMP and TEMP at a new root, and teardown removes it with everything in it", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "base-")));
    process.env.TMPDIR = base;
    const teardown = setup();
    const root = process.env.TMPDIR as string;
    expect(dirname(root)).toBe(base);
    expect(basename(root).startsWith(RUN_ROOT_PREFIX)).toBe(true);
    expect(process.env.TMP).toBe(root);
    expect(process.env.TEMP).toBe(root);
    // What a test leaves behind, and what a child process leaves behind.
    const left = mkdtempSync(join(tmpdir(), "ob-d-"));
    writeFileSync(join(left, "d.sock"), "");
    const child = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    expect(child.startsWith(root)).toBe(true);
    teardown();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(left)).toBe(false);
    expect(process.env.TMPDIR).toBe(base);
  });

  it("sweeps only stale run roots: not a fresh one, not other folders", () => {
    const base = mkdtempSync(join(tmpdir(), "base-"));
    const mk = (name: string, ageMs: number) => {
      const d = join(base, name);
      mkdirSync(d);
      writeFileSync(join(d, "f"), "x");
      const t = new Date(Date.now() - ageMs);
      utimesSync(d, t, t);
      return d;
    };
    const stale = mk("vt-AAAAAA", STALE_MS + 60_000);
    const fresh = mk("vt-BBBBBB", 60_000);
    const other = mk("ob-d-CCCCCC", STALE_MS + 60_000);
    const near = mk("vt-toolongname", STALE_MS + 60_000);
    expect(sweepStale(base)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(near)).toBe(true);
    expect(sweepStale(join(base, "missing"))).toBe(0);
  });

  it("every vitest config that wires the CLI guard also wires the temp root", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) =>
        /(^|\/)(vitest\.[\w.]*config\.ts|vite\.config\.ts)$/.test(f),
      );
    const guarded = files.filter((f) =>
      readFileSync(join(root, f), "utf8").includes("agent-cli-guard"),
    );
    expect(guarded.length).toBeGreaterThan(20);
    // One globalSetup per setupFiles block (a projects config has several).
    const unwired = guarded.filter((f) => {
      const src = readFileSync(join(root, f), "utf8");
      const setups = (src.match(/\bsetupFiles:/g) ?? []).length;
      const roots = (
        src.match(
          /globalSetup:\s*\[\s*["'][./]*(?:scripts\/)?test\/tmp-root\.ts["']/g,
        ) ?? []
      ).length;
      return roots < setups;
    });
    expect(unwired).toEqual([]);
  });
});
