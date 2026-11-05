// Re-review of the track-review fixes (b30542e).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { purge } from "../src/steps/purge.ts";

describe("review: purge knows every file the daemon writes", () => {
  it("removes the Claude injected-record file (and its temp) and then the home", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-rvp-"));
    writeFileSync(join(home, "machine.json"), "{}");
    writeFileSync(join(home, "claude-held.injected.json"), "{}");
    writeFileSync(join(home, "claude-held.injected.json.123.tmp"), "{}");
    const out = purge(home, { isDefault: false });
    expect(out).toMatchObject({ leftDir: false });
  });
});
