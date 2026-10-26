import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const doc = readFileSync(
  fileURLToPath(new URL("../src/content/docs/runtime-api.md", import.meta.url)),
  "utf8",
);

describe("runtime-api docs", () => {
  // packages/runtime delivers { docs: [], deleted: [], resync: true } after a
  // reconnect; pages must refetch on it.
  it("explains resync and refetches on it in the example", () => {
    expect(doc).toContain("{ docs: [], deleted: [], resync: true }");
    expect(doc).toMatch(/if \(e\.resync\) return refetch\(\);/);
  });

  it("explains offline and handles it in the example", () => {
    expect(doc).toContain("{ docs: [], deleted: [], offline: true }");
    expect(doc).toMatch(/if \(e\.offline\) return showPaused\(true\);/);
  });

  // packages/runtime rejects every call with code "no_shell" outside the viewer.
  it("documents the no_shell error", () => {
    expect(doc).toMatch(/\| `no_shell` \|/);
    expect(doc).toContain('e.code === "no_shell"');
  });
});
