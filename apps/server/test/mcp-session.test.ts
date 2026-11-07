// Server-issued Mcp-Session-Id (#539): legacy era only. The 2026-07-28 era
// removed protocol sessions, so nothing is minted or echoed for it.
import { env } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { newId } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import {
  connectionOf,
  issueMcpSession,
  MCP_SESSION_HEADER,
  mcpEra,
  verifyMcpSession,
} from "../src/mcp/session.js";
import { login } from "./helpers.js";
import {
  callWorker,
  connect,
  MCP_URL,
  oauthToken,
  tool,
} from "./mcp-helpers.js";

const tag = newId().slice(0, 6).toLowerCase();
let userId: string;
let otherId: string;
let token: string;
let tokenId: string;

beforeAll(async () => {
  userId = (await login(`mcp-sess-${tag}@x.com`)).userId;
  otherId = (await login(`mcp-sess-b-${tag}@x.com`)).userId;
  const pat = await createPat(env, userId, "sess-agent");
  token = pat.token;
  tokenId = pat.id;
});

const post = (
  body: unknown,
  headers: Record<string, string> = {},
  auth = token,
) =>
  callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${auth}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

const initialize = (protocolVersion: string, headers = {}) =>
  post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    },
    headers,
  );

const listTools = (headers: Record<string, string> = {}) =>
  post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, headers);

/** A client that records every response's Mcp-Session-Id header. */
async function recorded(modern: boolean, extra: Record<string, string> = {}) {
  const seen: (string | null)[] = [];
  const client = new Client(
    { name: "rec", version: "1" },
    modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${token}`, ...extra } },
      fetch: async (url, init) => {
        const r = await callWorker(
          new Request(String(url), init as RequestInit),
        );
        seen.push(r.headers.get(MCP_SESSION_HEADER));
        return r;
      },
    }),
  );
  return { client, seen };
}

describe("Mcp-Session-Id", () => {
  it("a legacy client gets an Mcp-Session-Id at initialize; tools/call does not issue a new one", async () => {
    const { client, seen } = await recorded(false);
    const issued = seen.filter((s) => s !== null);
    expect(issued).toHaveLength(1);
    const before = seen.length;
    const r = await tool(client, "list_artifacts", {});
    expect(r.isError).not.toBe(true);
    expect(seen.slice(before).every((s) => s === null)).toBe(true);
    await client.close();
  });

  it("a 2025-03-26 initialize also gets one; nothing else does", async () => {
    const r = await initialize("2025-03-26");
    expect(r.status).toBe(200);
    expect(r.headers.get(MCP_SESSION_HEADER)).toMatch(
      /^ms_[\w-]{22}\.[\w-]{16}$/,
    );
    const l = await listTools({ "MCP-Protocol-Version": "2025-03-26" });
    expect(l.headers.get(MCP_SESSION_HEADER)).toBeNull();
  });

  it("an initialize of an unknown revision gets none", async () => {
    const r = await initialize("2099-01-01");
    expect(r.headers.get(MCP_SESSION_HEADER)).toBeNull();
  });

  it("a modern-era client (modern: true) gets no Mcp-Session-Id on any response", async () => {
    const { client, seen } = await recorded(true);
    await tool(client, "list_artifacts", {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === null)).toBe(true);
    await client.close();
  });

  it("a modern-era request that sends a valid Mcp-Session-Id is not echoed and runs", async () => {
    const valid = await issueMcpSession(env, userId);
    const { client, seen } = await recorded(true, {
      [MCP_SESSION_HEADER]: valid,
    });
    const r = await tool(client, "list_artifacts", {});
    expect(r.isError).not.toBe(true);
    expect(seen.every((s) => s === null)).toBe(true);
    await client.close();
  });

  it("the era: the 2026-07-28 header or a per-request envelope is modern; else legacy", () => {
    const req = (h: Record<string, string> = {}) =>
      new Request(MCP_URL, { method: "POST", headers: h });
    expect(mcpEra(req({ "MCP-Protocol-Version": "2026-07-28" }), null)).toBe(
      "modern",
    );
    expect(
      mcpEra(req(), {
        method: "tools/call",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    ).toBe("modern");
    expect(mcpEra(req({ "MCP-Protocol-Version": "2025-06-18" }), null)).toBe(
      "legacy",
    );
    expect(mcpEra(req(), { method: "initialize", params: {} })).toBe("legacy");
    expect(mcpEra(req(), [{ method: "x" }])).toBe("legacy");
  });

  it("a session id signed for another user verifies as null", async () => {
    const mine = await issueMcpSession(env, userId);
    expect(await verifyMcpSession(env, userId, mine)).toMatch(/^ms_/);
    expect(await verifyMcpSession(env, otherId, mine)).toBeNull();
  });

  it("a tampered or 129-char session id verifies as null and the call still works", async () => {
    const mine = await issueMcpSession(env, userId);
    const tampered = `${mine.slice(0, -1)}${mine.endsWith("A") ? "B" : "A"}`;
    expect(await verifyMcpSession(env, userId, tampered)).toBeNull();
    expect(
      await verifyMcpSession(env, userId, `ms_${"a".repeat(126)}`),
    ).toBeNull();
    expect(await verifyMcpSession(env, userId, "nonsense")).toBeNull();
    expect(await verifyMcpSession(env, userId, null)).toBeNull();
    for (const bad of [tampered, `ms_${"a".repeat(126)}`]) {
      const r = await listTools({ [MCP_SESSION_HEADER]: bad });
      expect(r.status).toBe(200);
    }
  });

  it("a client that never echoes the header still works", async () => {
    const c = await connect(token);
    expect((await tool(c, "list_artifacts", {})).isError).not.toBe(true);
    await c.close();
  });

  it("connection is t:<tokenId> for a PAT and g:<grantId> for an OAuth grant; c:<userId> without one", async () => {
    expect(tokenId).not.toBe("");
    expect(
      connectionOf(
        { name: "x", version: null, via: { kind: "token", id: tokenId } },
        userId,
      ),
    ).toBe(`t:${tokenId}`);
    expect(
      connectionOf(
        { name: "x", version: null, via: { kind: "grant", id: "G1" } },
        userId,
      ),
    ).toBe("g:G1");
    expect(connectionOf({ name: "x", version: null }, userId)).toBe(
      `c:${userId}`,
    );
    expect(connectionOf(null, userId)).toBe(`c:${userId}`);
  });

  it("an OAuth client gets a session at initialize too", async () => {
    const { accessToken } = await oauthToken(`mcp-sess-o-${tag}@x.com`);
    const r = await initialize("2025-06-18", {});
    expect(r.headers.get(MCP_SESSION_HEADER)).not.toBeNull();
    const o = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "1" },
        },
      },
      {},
      accessToken,
    );
    expect(o.status).toBe(200);
    expect(o.headers.get(MCP_SESSION_HEADER)).not.toBeNull();
  });
});
