// agy S1b: Antigravity's mcp_config.json, edited one entry at a time.
import { describe, expect, it } from "vitest";
import { jsoncValue, removeAgyMcp, upsertAgyMcp } from "../src/index.ts";

const ours = { command: "/n", args: ["/e", "mcp", "antigravity"] };
const TEXT = `{
  // mine
  "mcpServers": {
    "fs": { "command": "npx", "args": ["x"], },
  },
}
`;

describe("upsertAgyMcp / removeAgyMcp", () => {
  it("adds our entry and removes it back to the same bytes", () => {
    const out = upsertAgyMcp(TEXT, "oa_bus", ours);
    expect(jsoncValue(out, ["mcpServers", "oa_bus"])).toEqual(ours);
    expect(jsoncValue(out, ["mcpServers", "fs"])).toEqual({
      command: "npx",
      args: ["x"],
    });
    expect(removeAgyMcp(out, "oa_bus")).toBe(TEXT);
  });

  it("returns the text unchanged when the entry is already ours", () => {
    const out = upsertAgyMcp(TEXT, "oa_bus", ours, "/home");
    expect(upsertAgyMcp(out, "oa_bus", ours, "/home")).toBe(out);
    expect(removeAgyMcp(TEXT, "oa_bus")).toBe(TEXT);
  });

  it("turns an http entry under our name into ours", () => {
    const text = '{"mcpServers":{"oa_bus":{"url":"https://x/mcp"}}}';
    expect(
      jsoncValue(upsertAgyMcp(text, "oa_bus", ours), ["mcpServers", "oa_bus"]),
    ).toEqual(ours);
  });

  it("keeps the user's env and drops only our OA_BUS_HOME", () => {
    const text = upsertAgyMcp(
      '{"mcpServers":{"oa_bus":{"command":"/n","args":[],"env":{"A":"1"}}}}',
      "oa_bus",
      ours,
      "/h",
    );
    expect(jsoncValue(text, ["mcpServers", "oa_bus", "env"])).toEqual({
      A: "1",
      OA_BUS_HOME: "/h",
    });
    expect(
      jsoncValue(upsertAgyMcp(text, "oa_bus", ours), [
        "mcpServers",
        "oa_bus",
        "env",
      ]),
    ).toEqual({ A: "1" });
  });

  it("refuses a config whose mcpServers is not an object", () => {
    expect(() => upsertAgyMcp('{"mcpServers":[]}', "oa_bus", ours)).toThrow(
      /mcpServers is not an object/,
    );
    expect(() => upsertAgyMcp("{ nope", "oa_bus", ours)).toThrow(
      /not a JSON object/,
    );
  });

  it("keeps a byte-order mark", () => {
    const out = upsertAgyMcp(`﻿${TEXT}`, "oa_bus", ours);
    expect(out.startsWith("﻿{")).toBe(true);
    expect(removeAgyMcp(out, "oa_bus")).toBe(`﻿${TEXT}`);
  });
});
