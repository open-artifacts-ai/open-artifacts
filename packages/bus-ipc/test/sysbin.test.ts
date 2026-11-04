import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { systemTool } from "../src/sysbin.ts";

describe("systemTool (C26j)", () => {
  it("finds a tool in the OS directories, sbin included", () => {
    const has = new Set(["/usr/sbin/fake-lsof"]);
    expect(systemTool("fake-lsof", (p) => has.has(p))).toBe(
      "/usr/sbin/fake-lsof",
    );
  });

  it("falls back to the bare name when no OS directory has it", () => {
    expect(systemTool("fake-missing", () => false)).toBe("fake-missing");
  });

  it("resolves this machine's ps and lsof to absolute paths", () => {
    const ps = systemTool("ps");
    expect(ps).toMatch(/^\/(usr\/)?s?bin\/ps$/);
    expect(existsSync(ps)).toBe(true);
    if (process.platform === "darwin")
      expect(systemTool("lsof")).toBe("/usr/sbin/lsof");
  });
});
