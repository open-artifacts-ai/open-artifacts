import { env } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { newId } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import type { McpContext } from "../src/mcp/server.js";
import * as serverModule from "../src/mcp/server.js";
import {
  issueMcpSession,
  MCP_SESSION_HEADER,
  mcpEra,
  verifyMcpSession,
} from "../src/mcp/session.js";
import { login } from "./helpers.js";
import { callWorker, MCP_URL, oauthToken, tool } from "./mcp-helpers.js";

const tag = newId().slice(0, 6).toLowerCase();
const H = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Records the McpContext of every server the Worker builds. */
function captureCtx(): McpContext[] {
  const seen: McpContext[] = [];
  const real = serverModule.createServer;
  vi.spyOn(serverModule, "createServer").mockImplementation((ctx) => {
    seen.push(ctx);
    return real(ctx);
  });
  return seen;
}

/** An SDK client whose every response (and request) is recorded. */
async function recordingClient(
  token: string,
  opts: { modern?: boolean; extraHeaders?: Record<string, string> } = {},
) {
  const responses: { method: string; res: Response }[] = [];
  const client = new Client(
    { name: "test-client", version: "9.9.9" },
    opts.modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const req = new Request(String(url), init as RequestInit);
      for (const [k, v] of Object.entries(opts.extraHeaders ?? {}))
        req.headers.set(k, v);
      let method = req.method;
      try {
        const b = (await req.clone().json()) as { method?: string };
        method = b.method ?? method;
      } catch {}
      const res = await callWorker(req);
      responses.push({ method, res });
      return res;
    },
  });
  await client.connect(transport);
  return { client, responses };
}

const rpc = (method: string, params: Record<string, unknown>, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

const post = (
  token: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: { ...H, authorization: `Bearer ${token}`, ...headers },
      body,
    }),
  );

const initBody = (protocolVersion: string) =>
  rpc("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  });

const listCall = rpc("tools/call", { name: "list_artifacts", arguments: {} });

async function pat(name: string) {
  const u = await login(`mcps-${name}-${tag}@x.com`);
  const p = await createPat(env, u.userId, `pat-${name}`);
  return { userId: u.userId, ...p };
}

describe("MCP session id (legacy era)", () => {
  it("a legacy client gets an Mcp-Session-Id at initialize; tools/call does not issue a new one", async () => {
    const p = await pat("legacy");
    const seen = captureCtx();
    const { client, responses } = await recordingClient(p.token);
    const init = responses.find((r) => r.method === "initialize");
    const sid = init?.res.headers.get(MCP_SESSION_HEADER) ?? "";
    expect(sid).toMatch(/^ms_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16}$/);
    responses.length = 0;
    seen.length = 0;
    const r = await tool(client, "list_artifacts", {});
    expect(r.isError).toBeFalsy();
    const call = responses.find((x) => x.method === "tools/call");
    expect(call?.res.headers.get(MCP_SESSION_HEADER)).toBeNull();
    // The SDK client echoed it; the tool context sees the verified random part.
    expect(seen.at(-1)?.session).toBe(sid.slice(3, 25));
    await client.close();
  });

  it("a 2025-03-26 initialize also gets one", async () => {
    const p = await pat("0326");
    const r = await post(p.token, initBody("2025-03-26"));
    expect(r.status).toBe(200);
    expect(r.headers.get(MCP_SESSION_HEADER)).toMatch(/^ms_/);
    await r.body?.cancel();
  });

  it("only a single-object legacy initialize issues one (batch, unknown version, other methods do not)", async () => {
    const p = await pat("batch");
    const batch = await post(p.token, `[${initBody("2025-06-18")}]`);
    expect(batch.headers.get(MCP_SESSION_HEADER)).toBeNull();
    await batch.body?.cancel();
    const odd = await post(p.token, initBody("2024-11-05"));
    expect(odd.headers.get(MCP_SESSION_HEADER)).toBeNull();
    await odd.body?.cancel();
    const call = await post(p.token, listCall);
    expect(call.headers.get(MCP_SESSION_HEADER)).toBeNull();
    await call.body?.cancel();
  });

  it("a modern-era client (modern: true) gets no Mcp-Session-Id header on any response", async () => {
    const p = await pat("modern");
    const { client, responses } = await recordingClient(p.token, {
      modern: true,
    });
    await tool(client, "list_artifacts", {});
    expect(responses.length).toBeGreaterThan(0);
    for (const { res } of responses)
      expect(res.headers.get(MCP_SESSION_HEADER)).toBeNull();
    await client.close();
  });

  it("a modern initialize-shaped body never mints one", async () => {
    const p = await pat("modinit");
    const withHeader = await post(p.token, initBody("2025-06-18"), {
      "mcp-protocol-version": "2026-07-28",
    });
    expect(withHeader.headers.get(MCP_SESSION_HEADER)).toBeNull();
    await withHeader.body?.cancel();
    const modernVersion = await post(p.token, initBody("2026-07-28"));
    expect(modernVersion.headers.get(MCP_SESSION_HEADER)).toBeNull();
    await modernVersion.body?.cancel();
  });

  it("a modern-era request that sends a valid Mcp-Session-Id is not echoed and runs with session null", async () => {
    const p = await pat("modecho");
    const sid = await issueMcpSession(env, p.userId);
    const seen = captureCtx();
    const { client, responses } = await recordingClient(p.token, {
      modern: true,
      extraHeaders: { [MCP_SESSION_HEADER]: sid },
    });
    const r = await tool(client, "list_artifacts", {});
    expect(r.isError).toBeFalsy();
    for (const { res } of responses)
      expect(res.headers.get(MCP_SESSION_HEADER)).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    for (const ctx of seen) expect(ctx.session).toBeNull();
    await client.close();
  });

  it("a session id signed for another user verifies as null", async () => {
    const a = await pat("usera");
    const b = await pat("userb");
    const sid = await issueMcpSession(env, a.userId);
    expect(await verifyMcpSession(env, a.userId, sid)).toBe(sid.slice(3, 25));
    expect(await verifyMcpSession(env, b.userId, sid)).toBeNull();
    const seen = captureCtx();
    const r = await post(b.token, listCall, { [MCP_SESSION_HEADER]: sid });
    expect(r.status).toBe(200);
    await r.body?.cancel();
    expect(seen.at(-1)?.session).toBeNull();
  });

  it("a tampered or 129-char session id verifies as null and the call still works", async () => {
    const p = await pat("tamper");
    const sid = await issueMcpSession(env, p.userId);
    const last = sid.at(-1) === "A" ? "B" : "A";
    const tampered = `${sid.slice(0, -1)}${last}`;
    const long = `${sid}${"x".repeat(129 - sid.length)}`;
    expect(long).toHaveLength(129);
    for (const bad of [tampered, long, "ms_forged.sig", ""]) {
      expect(await verifyMcpSession(env, p.userId, bad)).toBeNull();
    }
    expect(await verifyMcpSession(env, p.userId, null)).toBeNull();
    const seen = captureCtx();
    for (const bad of [tampered, long]) {
      const r = await post(p.token, listCall, { [MCP_SESSION_HEADER]: bad });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("result");
      expect(seen.at(-1)?.session).toBeNull();
    }
  });

  it("a client that never echoes the header still works (session null)", async () => {
    const p = await pat("noecho");
    const init = await post(p.token, initBody("2025-06-18"));
    expect(init.headers.get(MCP_SESSION_HEADER)).toMatch(/^ms_/);
    await init.body?.cancel();
    const seen = captureCtx();
    const r = await post(p.token, listCall);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("result");
    expect(seen.at(-1)?.session).toBeNull();
  });

  it("connection is t:<tokenId> for a PAT and g:<grantId> for an OAuth grant", async () => {
    const p = await pat("conn");
    const seen = captureCtx();
    const r = await post(p.token, listCall);
    await r.body?.cancel();
    expect(seen.at(-1)?.connection).toBe(`t:${p.id}`);
    const o = await oauthToken(`mcps-oauth-${tag}@x.com`);
    const grantId = o.accessToken.split(":")[1];
    const r2 = await post(o.accessToken, listCall);
    expect(r2.status).toBe(200);
    await r2.body?.cancel();
    expect(seen.at(-1)?.connection).toBe(`g:${grantId}`);
    expect(seen.at(-1)?.user.id).toBe(o.member.userId);
  });

  it("an OAuth legacy initialize also gets one, bound to the grant's user", async () => {
    const o = await oauthToken(`mcps-oinit-${tag}@x.com`);
    const r = await post(o.accessToken, initBody("2025-11-25"));
    const sid = r.headers.get(MCP_SESSION_HEADER) ?? "";
    await r.body?.cancel();
    expect(await verifyMcpSession(env, o.member.userId, sid)).toBe(
      sid.slice(3, 25),
    );
  });
});

describe("mcpEra", () => {
  const req = (h: Record<string, string> = {}) =>
    new Request(MCP_URL, { method: "POST", headers: h });
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    },
  };
  it("modern by header or envelope (single or batch), legacy otherwise", () => {
    expect(mcpEra(req({ "mcp-protocol-version": "2026-07-28" }), {})).toBe(
      "modern",
    );
    expect(mcpEra(req(), envelope)).toBe("modern");
    expect(mcpEra(req(), [{ jsonrpc: "2.0", method: "x" }, envelope])).toBe(
      "modern",
    );
    expect(mcpEra(req({ "mcp-protocol-version": "2025-06-18" }), {})).toBe(
      "legacy",
    );
    expect(mcpEra(req(), undefined)).toBe("legacy");
  });
});
