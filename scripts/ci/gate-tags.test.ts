// The staging release gate runs only the cases tagged @gate
// (apps/dashboard/e2e/staging, selected by open-artifacts-cloud's
// redline-staging.yml). Removing tags would weaken the gate without any test
// noticing, so this pins a floor and a ceiling. Reads the files; no Playwright.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = "apps/dashboard/e2e/staging/rl-a";
const gated = (file: string): number =>
  [
    ...readFileSync(join(root, dir, file), "utf8").matchAll(
      /\btag:\s*["']@gate["']/g,
    ),
  ].length;
const FILES = [
  "guard.setup.ts",
  "purge.teardown.ts",
  "hosted.spec.ts",
  "joins.spec.ts",
  "spaces.spec.ts",
  "comments.spec.ts",
  "later.spec.ts",
];

describe("the @gate set of the staging release gate", () => {
  it("has between 6 and 12 tagged tests", () => {
    const total = FILES.reduce((n, f) => n + gated(f), 0);
    expect(total).toBeGreaterThanOrEqual(6);
    expect(total).toBeLessThanOrEqual(12);
  });

  it("tags the guard setup and the purge teardown, which bracket the gate's cases", () => {
    expect(gated("guard.setup.ts")).toBeGreaterThanOrEqual(1);
    expect(gated("purge.teardown.ts")).toBeGreaterThanOrEqual(1);
  });

  it("tags at least one test each in joins, spaces and comments", () => {
    for (const f of ["joins.spec.ts", "spaces.spec.ts", "comments.spec.ts"])
      expect(gated(f), f).toBeGreaterThanOrEqual(1);
  });
});
