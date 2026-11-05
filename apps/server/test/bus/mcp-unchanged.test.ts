// #1291 (design "MCP surface"): /mcp gains nothing from the bus but one
// tool, #1372's bus_role_propose (it only proposes a role change; the member
// confirms it on a link in a browser). With the bus off (BUS_HUB unbound) or
// hosted, the tool list (names, descriptions, schemas) and the server
// instructions are exactly the bus-less ones. With the bus on, the list adds
// that one tool and nothing else, and the instructions don't change, also
// for a member who has a connected machine.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPat } from "../../src/auth/pat.js";
import { connect, E } from "../mcp-helpers.js";
import { daemon, machine, member } from "./helpers.js";

type Tool = { name: string };

async function surface(token: string, ev: unknown) {
  const client = await connect(token, { env: ev });
  try {
    const { tools } = await client.listTools();
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    return {
      tools: JSON.stringify(sorted),
      without: JSON.stringify(
        sorted.filter((t: Tool) => t.name !== "bus_role_propose"),
      ),
      names: sorted.map((t: Tool) => t.name),
      instructions: client.getInstructions() ?? "",
    };
  } finally {
    await client.close();
  }
}

describe("/mcp is unchanged by the bus", () => {
  it("tool list and instructions are identical with and without a bus, but for the one proposal tool", async () => {
    const u = await member();
    const pat = (await createPat(env, u.userId, "agent")).token;
    const off = await surface(pat, E({ BUS_HUB: undefined }));
    const on = await surface(pat, E());
    const hosted = await surface(pat, E({ HOSTED: "1" }));
    expect(on.without).toBe(off.tools);
    expect(on.names.filter((n) => !off.names.includes(n))).toEqual([
      "bus_role_propose",
    ]);
    expect(on.instructions).toBe(off.instructions);
    expect(hosted.tools).toBe(off.tools);
    expect(hosted.instructions).toBe(off.instructions);
    // A member with a live bus machine sees the same surface.
    const m = await machine("live", u.userId);
    const d = await daemon(m.token);
    const live = await surface(pat, E());
    expect(live.tools).toBe(on.tools);
    expect(live.instructions).toBe(off.instructions);
    expect(off.tools).not.toMatch(/\bbus\b|machine_token|follow/i);
    expect(on.without).not.toMatch(/\bbus\b|machine_token|follow/i);
    d.close();
  });
});
