import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTest, scan, scanText, stripComments } from "./no-test-sleeps.ts";

// The shapes the checker must catch (and the forms it must leave alone) are
// data in no-test-sleeps.fixtures/cases.json, not code here: this file is
// scanned like every other test file, with no exemption, so it holds none.
type Case = { name: string; file: string; text: string; why: string[] };
const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
  readFileSync(join(here, "no-test-sleeps.fixtures/cases.json"), "utf8"),
) as Case[];

describe("no-test-sleeps: planted shapes are caught, legitimate forms are not", () => {
  it("has cases for both", () => {
    expect(cases.filter((c) => c.why.length > 0).length).toBeGreaterThan(20);
    expect(cases.filter((c) => c.why.length === 0).length).toBeGreaterThan(5);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(scanText(c.text, c.file).map((h) => h.why)).toEqual(c.why);
  });

  it("reports the line of the wait, not of the statement start", () => {
    const planted = cases.find((c) => c.name === "multi-line executor");
    expect(planted && scanText(planted.text, planted.file)[0]?.line).toBe(1);
    const late = cases.find(
      (c) => c.name === "a wait after a commented-out one",
    );
    expect(late && scanText(late.text, late.file)[0]?.line).toBe(2);
  });
});

describe("no-test-sleeps: which files are tests, anywhere", () => {
  it("any test, tests, e2e, __tests__ or test-browser folder, and the test-named files", () => {
    for (const p of [
      "apps/dashboard/test/a.tsx",
      "apps/dashboard/e2e/a.spec.ts",
      "apps/dashboard/e2e/doc-room.mjs",
      "packages/shared/test/a.test.ts",
      "packages/x/test/fixtures/run.sh",
      "tests/a.js",
      "tools/demo/tests/example.test.ts",
      "tools/demo/tests/helpers.ts",
      "packages/ui/test-browser/harness.ts",
      "apps/x/src/__tests__/a.ts",
      "packages/x/src/a.test.mjs",
      "packages/bus-adapter-hermes/tests/test_delivery.py",
      "packages/bus-adapter-hermes/tests/support.py",
      "pkg/test_thing.py",
      "pkg/thing_test.py",
      "pkg/conftest.py",
    ])
      expect(isTest(p), p).toBe(true);
    for (const p of [
      "apps/dashboard/src/a.tsx",
      "packages/x/src/index.ts",
      "scripts/ci/release.sh",
      "apps/dashboard/test/readme.md",
      "packages/bus-adapter-hermes/assets/oa_bus/plugin.py",
    ])
      expect(isTest(p), p).toBe(false);
  });

  it("scans the whole tree: a test outside the four roots, this checker's own test, skips node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "oa-sleeps-"));
    const planted = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    const wait = cases.find((c) => c.name === "waitForTimeout")?.text ?? "";
    const py = cases.find((c) => c.name === "python time.sleep")?.text ?? "";
    planted("tools/demo/tests/example.test.ts", wait);
    planted("scripts/ci/no-test-sleeps.test.ts", wait);
    planted("pkg/tests/test_delivery.py", py);
    planted("pkg/node_modules/dep/a.test.ts", wait);
    planted("src/not-a-test.ts", wait);
    expect(
      scan(root)
        .map((h) => h.file)
        .sort(),
    ).toEqual([
      "pkg/tests/test_delivery.py",
      "scripts/ci/no-test-sleeps.test.ts",
      "tools/demo/tests/example.test.ts",
    ]);
  });

  it("a tracked test under build/ is scanned; an ignored one is not", () => {
    const root = mkdtempSync(join(tmpdir(), "oa-sleeps-git-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root });
    git("init", "-q");
    const planted = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    const wait = cases.find((c) => c.name === "waitForTimeout")?.text ?? "";
    const sh =
      cases.find((c) => c.name === "shell sleep with a variable")?.text ?? "";
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    planted("build/tests/example.test.ts", wait);
    planted("dist/tests/example.test.ts", wait);
    planted("tests/timing.sh", sh);
    planted("ignored/tests/example.test.ts", wait);
    git("add", "-A");
    // Untracked and not ignored counts too: a new file is a candidate.
    planted("new/tests/example.test.ts", wait);
    expect(
      scan(root)
        .map((h) => h.file)
        .sort(),
    ).toEqual([
      "build/tests/example.test.ts",
      "dist/tests/example.test.ts",
      "new/tests/example.test.ts",
      "tests/timing.sh",
    ]);
  });

  it("this file holds no wait", () => {
    expect(
      scanText(
        readFileSync(fileURLToPath(import.meta.url), "utf8"),
        "scripts/ci/no-test-sleeps.test.ts",
      ),
    ).toEqual([]);
  });
});

describe("no-test-sleeps: stripComments", () => {
  it("blanks comments, keeps line count and strings", () => {
    const src =
      'const a = "// not a comment"; // gone\n/* x\ny */ const b = 1;';
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"// not a comment"');
    expect(out).not.toContain("gone");
    expect(out).toContain("const b = 1;");
  });

  it("a hash starts a comment in python and shell, a slash pair does not", () => {
    const out = stripComments("x = 1  # gone\ny = 4 // 2", true);
    expect(out).toBe(`x = 1  ${" ".repeat(6)}\ny = 4 // 2`);
  });
});
