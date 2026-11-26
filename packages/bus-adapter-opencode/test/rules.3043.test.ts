import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_RULES, BRIEF_RULES_MAX_BYTES } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { serverOptions } from "../src/rules.ts";

const dirs: string[] = [];
const makeHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-opencode-rules-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenCode oa_bus serverOptions (#3043)", () => {
  it("passes BRIEF_RULES first and within the byte budget when install.json is absent", () => {
    const home = makeHome();
    const opts = serverOptions(home);
    const leadLine = BRIEF_RULES.split("\n")[0] ?? "";
    expect(opts.instructions).toBe(BRIEF_RULES);
    expect(opts.instructions?.startsWith(leadLine)).toBe(true);
    expect(
      Buffer.byteLength(opts.instructions ?? "", "utf8"),
    ).toBeLessThanOrEqual(BRIEF_RULES_MAX_BYTES);
  });

  it("omits instructions when install.json opts out", () => {
    const home = makeHome();
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({ habits: { optedOut: true } }),
      { mode: 0o600 },
    );
    const opts = serverOptions(home);
    expect("instructions" in opts).toBe(false);
    expect(opts.instructions).toBeUndefined();
  });

  it("reads BRIEF_RULES live from @oa/bus-protocol rather than a local copy", () => {
    const home = makeHome();
    const opts = serverOptions(home);
    expect(opts.instructions).toBe(BRIEF_RULES);
  });
});
