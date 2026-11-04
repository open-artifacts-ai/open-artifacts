// #1291 (design "MCP surface"): /mcp gains nothing from the bus. The tool
// list (names, descriptions, schemas) and the server instructions are
// identical with the bus on (BUS_HUB bound, self-host), off (unbound) and
// hosted, and with a member who has a connected machine.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPat } from "../../src/auth/pat.js";
import { connect, E } from "../mcp-helpers.js";
import { daemon, machine, member } from "./helpers.js";

async function surface(token: string, ev: unknown) {
  const client = await connect(token, { env: ev });
  try {
    const { tools } = await client.listTools();
    return {
      tools: JSON.stringify(
        [...tools].sort((a, b) => a.name.localeCompare(b.name)),
      ),
      instructions: client.getInstructions() ?? "",
    };
  } finally {
    await client.close();
  }
}

describe("/mcp is unchanged by the bus", () => {
  it("tool list and instructions are identical with and without a bus", async () => {
    const u = await member();
    const pat = (await createPat(env, u.userId, "agent")).token;
    const off = await surface(pat, E({ BUS_HUB: undefined }));
    const on = await surface(pat, E());
    const hosted = await surface(pat, E({ HOSTED: "1" }));
    expect(on.tools).toBe(off.tools);
    expect(on.instructions).toBe(off.instructions);
    expect(hosted.tools).toBe(off.tools);
    // A member with a live bus machine sees the same surface.
    const m = await machine("live", u.userId);
    const d = await daemon(m.token);
    const live = await surface(pat, E());
    expect(live.tools).toBe(off.tools);
    expect(live.instructions).toBe(off.instructions);
    expect(off.tools).not.toMatch(/\bbus\b|machine_token|follow/i);
    d.close();
  });
});
