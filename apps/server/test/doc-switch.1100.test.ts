import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { SKILL_TEMPLATE } from "../src/mcp/skill.generated.js";
import { DOC_CREATION } from "../src/services/doc-switch.js";
import { api, errOf, login } from "./helpers.js";
import { close, connect, textOf, tool } from "./mcp-helpers.js";

// #1100: creating docs is off until edit_doc and the doc room ship.
const app = createApp();
let client: Client;
let cookie: string;

beforeAll(async () => {
  const owner = await login(`ds-${newId().slice(0, 6).toLowerCase()}@x.com`);
  cookie = owner.cookie;
  client = await connect((await createPat(env, owner.userId, "ds")).token);
});
afterAll(async () => {
  await close(client);
});

describe("doc creation switch (off)", () => {
  it("is off by default", () => {
    expect(DOC_CREATION).toBe(false);
  });

  it("REST: format doc is refused with the next step, nothing created", async () => {
    const r = await api(app, R.artifacts, cookie, {
      method: "POST",
      body: { title: "d", format: "doc" },
    });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.message).toMatch(/Docs aren't available yet/);
  });

  it("MCP: format doc is refused and not advertised", async () => {
    const tools = await client.listTools();
    const pub = tools.tools.find((t) => t.name === "publish_artifact");
    expect(JSON.stringify(pub?.inputSchema)).not.toMatch(/"doc"/);
    const r = await tool(client, "publish_artifact", {
      title: "d",
      format: "doc",
    });
    expect(textOf(r)).toMatch(/Docs aren't available yet/);
    expect(r.isError).toBe(true);
  });

  it("the skill's publish_artifact lists no doc format", () => {
    const line = SKILL_TEMPLATE.split("\n").find(
      (l) => l.includes("`content?`") && l.includes("`format?`"),
    );
    expect(line).toBeDefined();
    expect(line).not.toMatch(/"doc"/);
  });
});
