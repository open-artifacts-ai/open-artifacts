// AGENTS.md is agent-facing and nothing else reads it, so a wrong tool name
// there is invisible until an agent acts on it. The retro review of #1334 found
// exactly that: three inbox tools the adapters do not have, plus a rule that
// made a correctly connected agent think it was disconnected.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "../../src/mcp/tool-defs.js";

const md = readFileSync(
  new URL("../../../../AGENTS.md", import.meta.url),
  "utf8",
);

/** The bus client's tools (packages/bus-adapter-claude-code/src/tools.ts). */
const BUS_TOOLS = [
  "list_agents",
  "send_message",
  "fetch",
  "self",
  "set_status",
];

describe("AGENTS.md", () => {
  it("names only tools that exist", () => {
    const known = new Set([...BUS_TOOLS, ...TOOL_DEFS.map((t) => t.name)]);
    const named = [...md.matchAll(/`([^`\n]+)`/g)]
      .map((m) => m[1] ?? "")
      .filter((n) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(n));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !known.has(n))).toEqual([]);
  });

  it("keeps the inbox tools and the stale join script out", () => {
    for (const gone of ["get_inbox", "read_message", "ack_message"])
      expect(md).not.toContain(gone);
    expect(md).not.toContain("agent-bus-join");
    // A missing inbox tool is not evidence of being disconnected.
    expect(md).not.toMatch(/none of them exist/);
    // The connected test is self, so the diff may not forbid that inference.
    expect(md).not.toMatch(/absent tool says nothing/);
  });

  it("has no em dash", () => {
    expect(md).not.toContain("\u2014");
  });
});
