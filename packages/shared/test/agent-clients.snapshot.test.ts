import { describe, expect, it } from "vitest";
import { agentClients } from "../src/agent-clients.js";

// Design v7 9A.11: `name` and `verifyTool` options. The defaults must keep
// the install output byte for byte; the admin MCP server renders its own.
describe("agentClients snapshots", () => {
  const URL_ = "https://oa.example.com/mcp";
  const FILE = "~/.open-artifacts/oa-example-com-pat-token";

  it("default output is unchanged (dashboard form)", () => {
    expect(agentClients(URL_)).toMatchSnapshot();
  });

  it("default output is unchanged (file form)", () => {
    expect(agentClients(URL_, { tokenFile: FILE })).toMatchSnapshot();
  });

  it("explicit defaults equal the defaults", () => {
    const opts = { name: "open-artifacts", verifyTool: "publish_artifact" };
    expect(agentClients(URL_, opts)).toEqual(agentClients(URL_));
    expect(agentClients(URL_, { ...opts, tokenFile: FILE })).toEqual(
      agentClients(URL_, { tokenFile: FILE }),
    );
  });

  it("admin snippets: oa-admin with get_world", () => {
    const admin = agentClients("https://api.open-artifacts.app/mcp", {
      name: "oa-admin",
      verifyTool: "get_world",
    });
    expect(admin).toMatchSnapshot();
    const text = JSON.stringify(admin);
    expect(text).not.toContain("open-artifacts ");
    expect(text).not.toContain("publish_artifact");
    expect(text).toContain("get_world");
    expect(admin.find((s) => s.agent === "Claude Code")?.code).toBe(
      "claude mcp add --transport http oa-admin https://api.open-artifacts.app/mcp",
    );
  });
});
