// The public runtime doc is the third place the link rule is written down
// (with the skill and the MCP instructions). It taught the old blanket rule,
// "open them with target=_blank", which breaks in-artifact navigation, and it
// presented a refused link as harmless when a target skips the refusal.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(
  new URL("../src/content/docs/runtime-api.md", import.meta.url),
);
const doc = readFileSync(src, "utf8");
const para = (
  doc.split("\n").find((l) => l.startsWith("Links: ")) ?? ""
).replace(/\s+/g, " ");

describe("runtime-api.md link rule", () => {
  it("scopes the target to links that leave the page", () => {
    expect(para).toContain('target="_blank" rel="noopener"');
    expect(para).toContain("opens in a new tab");
    expect(para).toContain("relative and takes no target");
    expect(para).not.toMatch(/open them with .target/);
  });

  it("names the URLs that are refused, and the target that skips the refusal", () => {
    expect(para).toContain("dashboard or settings pages");
    expect(para).toContain("/p/` or `/c/`");
    expect(para).toContain("with a target it opens instead");
    expect(para).not.toMatch(/security|bypass|cookie/i);
  });

  it("does not claim an artifact can navigate the viewer", () => {
    expect(para).not.toContain("can't navigate the viewer page");
  });
});
