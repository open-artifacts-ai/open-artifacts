import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { INSTRUCTIONS } from "../src/mcp/instructions.js";
import { BANG_RULE } from "../src/mcp/skill-common.js";
import { TOOL_DEFS } from "../src/mcp/tool-defs.js";
import { login } from "./helpers.js";
import { connect } from "./mcp-helpers.js";

const VENDOR = /claude|anthropic|openai|chatgpt/i;

describe("MCP surface is vendor-neutral", () => {
  it("tool defs and instructions", () => {
    for (const t of TOOL_DEFS) {
      expect(t.name).not.toMatch(VENDOR);
      expect(t.description).not.toMatch(VENDOR);
    }
    for (const plan of ["free", "paid"] as const) {
      expect(INSTRUCTIONS(plan, "https://x/skill.md")).not.toMatch(VENDOR);
      // C4: subscribers are told to refetch after a reconnect.
      expect(INSTRUCTIONS(plan)).toContain(
        "refetch your data when resync is true",
      );
    }
  });

  it("everything the server sends: tools, schemas, instructions, resources", async () => {
    const u = await login(`neutral-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const c = await connect((await createPat(env, u.userId, "n")).token);
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(19);
    for (const t of tools) expect(JSON.stringify(t)).not.toMatch(VENDOR);
    const instructions = c.getInstructions() ?? "";
    expect(instructions.split("\n").length).toBeGreaterThanOrEqual(55);
    expect(instructions).not.toMatch(VENDOR);
    const { resources } = await c.listResources();
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(JSON.stringify(r)).not.toMatch(VENDOR);
      const read = await c.readResource({ uri: r.uri });
      // The skill names clients in two places, by user decision: the secrets
      // rule (the client whose `!` prefix runs the hidden-input line) and the
      // per-client "Client setup" section. Nothing else may.
      const text = JSON.stringify(read)
        .replace(BANG_RULE, "")
        .replace(/\\n## Client setup\\n[\s\S]*?(?=\\n## )/, "");
      expect(text).not.toMatch(VENDOR);
    }
    await c.close();
  });
});
