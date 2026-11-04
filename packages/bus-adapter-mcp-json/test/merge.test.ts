import { describe, expect, it } from "vitest";
import { removeMcpServer, upsertMcpServer } from "../src/index.ts";

describe("claude mcpServers", () => {
  it("adds a server without disturbing other keys", () => {
    const before = { theme: "dark", mcpServers: { other: { command: "x" } } };
    const after = upsertMcpServer(before, "oa_bus", {
      command: "oa-bus",
      args: ["mcp", "claude"],
    });
    expect(after.theme).toBe("dark");
    expect(after.mcpServers).toEqual({
      other: { command: "x" },
      oa-bus: { command: "oa-bus", args: ["mcp", "claude"] },
    });
    expect(before.mcpServers).toEqual({ other: { command: "x" } });
  });

  it("replaces our entry instead of duplicating it, and removes it cleanly", () => {
    const once = upsertMcpServer({}, "oa_bus", { command: "a" });
    const twice = upsertMcpServer(once, "oa_bus", { command: "b" });
    expect(twice.mcpServers).toEqual({ oa-bus: { command: "b" } });
    expect(removeMcpServer(twice, "oa_bus").mcpServers).toEqual({});
  });

  it("removing from a doc without servers adds nothing", () => {
    expect(removeMcpServer({ theme: "x" }, "oa_bus")).toEqual({ theme: "x" });
  });

  it("refuses a non-object mcpServers instead of clobbering it", () => {
    expect(() =>
      upsertMcpServer({ mcpServers: ["x"] }, "oa_bus", { command: "a" }),
    ).toThrow(/mcpServers/);
  });
});
