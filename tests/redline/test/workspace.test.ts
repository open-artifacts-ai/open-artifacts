// Moved from scripts/check-workspace.test.ts: tests/redline is a hosted path,
// so the public workspace test can't expect it once it leaves the repo (#1056).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);

describe("workspace", () => {
  it("tests/redline is @oa/redline, an ES module", () => {
    expect(pkg.name).toBe("@oa/redline");
    expect(pkg.type).toBe("module");
  });
});
