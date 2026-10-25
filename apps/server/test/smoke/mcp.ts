import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

describe.skipIf(!base || !pat)("staging smoke: mcp", () => {
  it("tools/list over a PAT lists all 18 tools", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    // JSON, or a single SSE "data:" frame.
    const json = text.startsWith("{")
      ? text
      : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
    const body = JSON.parse(json) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain("publish_artifact");
    expect(body.result.tools).toHaveLength(18);
  });

  it("no auth → 401 with a resource-metadata challenge", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});
