import { describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

const seen: { home?: string } = {};
// The real entry would start a stdio server: record what it would read instead.
vi.mock("@oa/bus-adapter-claude-code/main", () => {
  seen.home = process.env.OA_BUS_HOME;
  return {};
});

describe("mcp --home", () => {
  it("points the MCP server at that home's daemon", async () => {
    const prev = process.env.OA_BUS_HOME;
    delete process.env.OA_BUS_HOME;
    try {
      await main(["mcp", "claude", "--home", "/tmp/ob-mcp-home"], () =>
        fakeCtx(),
      );
      expect(seen.home).toBe("/tmp/ob-mcp-home");
    } finally {
      if (prev === undefined) delete process.env.OA_BUS_HOME;
      else process.env.OA_BUS_HOME = prev;
    }
  });
});
