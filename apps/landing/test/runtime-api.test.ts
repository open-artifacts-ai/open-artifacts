import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STATUS_FOR } from "@oa/shared";
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

  // packages/runtime rejects every call with code "no_shell" outside the viewer.
  it("documents the no_shell error", () => {
    expect(doc).toMatch(/\| `no_shell` \|/);
    expect(doc).toContain('e.code === "no_shell"');
  });

  // #681: the server refuses an anonymous write the artifact doesn't allow
  // with 403 anon_writes_disabled (STATUS_FOR in @oa/shared).
  it("documents anon_writes_disabled with the server's status", () => {
    const row = doc
      .split("\n")
      .find((l) => l.startsWith("| `anon_writes_disabled`"));
    expect(row).toBeDefined();
    expect(row).toContain(`(${STATUS_FOR.anon_writes_disabled})`);
    expect(STATUS_FOR.anon_writes_disabled).toBe(403);
    // capability_denied no longer claims anonymous writes.
    expect(doc).not.toMatch(/`capability_denied`.*anonymous write/);
  });
});
