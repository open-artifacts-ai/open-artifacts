// T19's leo specs stay anonymous and read-only (#1251; it was a spec in
// e2e/staging/leo/readonly.spec.ts). leo is the user's install, so a leo
// spec that could sign in or write would break that rule: no import of
// rl-a's helpers or the test hooks, and no hook path.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const LEO = join(__dirname, "../e2e/staging/leo");

it("no leo spec imports rl-a's session or API helpers, or names a hook path", () => {
  const files = readdirSync(LEO).filter((n) => n.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const src = readFileSync(join(LEO, f), "utf8");
    expect(src, f).not.toMatch(/^import[^;]*(rl-a\/|TEST_HOOKS)/m);
    expect(src, f).not.toContain(["/__", "test/"].join(""));
  }
});
