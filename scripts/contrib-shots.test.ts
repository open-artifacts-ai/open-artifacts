import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const source = join(
  dirname(fileURLToPath(import.meta.url)),
  "contrib-shots.sh",
);

// A stub pnpm: records its args and env, writes one PNG under --output, and
// exits with $STUB_STATUS (read from a file, since the script scrubs env).
const STUB = `#!/bin/bash
here=$(dirname "$0")
printf '%s\\n' "$@" > "$here/args"
env > "$here/env"
out=""; prev=""
for a in "$@"; do [[ "$prev" == "--output" ]] && out="$a"; prev="$a"; done
if [[ ! -f "$here/no-png" ]]; then mkdir -p "$out/t"; : > "$out/t/a.png"; fi
exit "$(cat "$here/status" 2>/dev/null || echo 0)"
`;

let root = "";
let bin = "";
let dash = "";
beforeEach(() => {
  // A fake checkout: the script finds the repo from its own location.
  root = realpathSync(mkdtempSync(join(tmpdir(), "contrib-shots-")));
  dash = join(root, "apps/dashboard");
  bin = join(root, "bin");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(dash, "e2e"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(source, join(root, "scripts/contrib-shots.sh"));
  writeFileSync(join(dash, "e2e/pr-1660-shots.spec.ts"), "");
  writeFileSync(join(bin, "pnpm"), STUB);
  chmodSync(join(bin, "pnpm"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [join(root, "scripts/contrib-shots.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OA_SHOTS_DRY_RUN: "",
      ...env,
    },
  });
const out = () => join(dash, "test-results/contrib-shots/pr-1660");

it("runs the named shots spec on the mock API at the fixed port", () => {
  const r = run(["pr-1660"], { OA_TEST_SECRET: "s3cret" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(readFileSync(join(bin, "args"), "utf8").split("\n")).toEqual([
    "--dir",
    dash,
    "exec",
    "playwright",
    "test",
    "e2e/pr-1660-shots\\.spec\\.ts$",
    "--output",
    out(),
    "--reporter",
    "line",
    "",
  ]);
  const env = readFileSync(join(bin, "env"), "utf8");
  expect(env).toContain("VITE_MOCK=1\n");
  expect(env).toContain("OA_E2E_PORT=5299\n");
  // The Node side never sees the session's env.
  expect(env).not.toContain("s3cret");
  expect(r.stdout).toBe(`${out()}/t/a.png\n`);
});

it("clears old output before a run", () => {
  mkdirSync(out(), { recursive: true });
  writeFileSync(join(out(), "stale.png"), "");
  const r = run(["pr-1660"]);
  expect(r.status).toBe(0);
  expect(existsSync(join(out(), "stale.png"))).toBe(false);
});

it("lists shots from a failing run, then exits with its status", () => {
  writeFileSync(join(bin, "status"), "3");
  const r = run(["pr-1660"]);
  expect(r.status).toBe(3);
  expect(r.stdout).toBe(`${out()}/t/a.png\n`);
});

it("passes when the spec wrote nothing", () => {
  writeFileSync(join(bin, "no-png"), "");
  const r = run(["pr-1660"]);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
});

it("refuses an output dir that resolves outside the checkout", () => {
  const outside = join(root, "outside");
  mkdirSync(join(outside, "pr-1660"), { recursive: true });
  writeFileSync(join(outside, "pr-1660/keep"), "");
  mkdirSync(join(dash, "test-results"));
  symlinkSync(outside, join(dash, "test-results/contrib-shots"));
  const r = run(["pr-1660"]);
  expect(r.status).toBe(73);
  expect(existsSync(join(outside, "pr-1660/keep"))).toBe(true);
  expect(existsSync(join(bin, "args"))).toBe(false);
});

it("creates nothing through a symlinked test-results", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(dash, "test-results"));
  const r = run(["pr-1660"]);
  expect(r.status).toBe(73);
  expect(existsSync(join(outside, "contrib-shots"))).toBe(false);
});

it("refuses a symlinked output dir", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "");
  mkdirSync(join(dash, "test-results/contrib-shots"), { recursive: true });
  symlinkSync(outside, out());
  const r = run(["pr-1660"]);
  expect(r.status).toBe(73);
  expect(existsSync(join(outside, "keep"))).toBe(true);
});

it("dry run prints the command and runs nothing", () => {
  const r = run(["pr-1660"], { OA_SHOTS_DRY_RUN: "1" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("VITE_MOCK=1 OA_E2E_PORT=5299 pnpm --dir ");
  expect(existsSync(join(bin, "args"))).toBe(false);
});

it.each([
  [[]],
  [["a", "b"]],
  [["../x"]],
  [["Pr-1660"]],
  [["pr_1660"]],
  [["-x"]],
  [["x-"]],
  [["x--y"]],
  [["x;rm"]],
  [["x y"]],
  [["pr-1660\n"]],
  [["x.y"]],
  [[""]],
])("refuses %j with usage", (args) => {
  const r = run(args);
  expect(r.status).toBe(64);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/^usage: /);
  expect(existsSync(join(bin, "args"))).toBe(false);
});

it("refuses a name with no shots spec", () => {
  const r = run(["pr-9999"]);
  expect(r.status).toBe(66);
  expect(r.stderr).toContain("apps/dashboard/e2e/pr-9999-shots.spec.ts");
});

it("asks for an install before running", () => {
  rmSync(join(root, "node_modules"), { recursive: true });
  const r = run(["pr-1660"]);
  expect(r.status).toBe(69);
  expect(r.stderr).toContain("pnpm install --frozen-lockfile");
});
