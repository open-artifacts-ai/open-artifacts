import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AdminToolName } from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app.js";
import { csrfToken } from "../src/auth/csrf.js";
import { ADMIN, API, requestId } from "./fakes.js";
import {
  grant,
  oauthWorld,
  refresh,
  rowOf,
  type Tokens,
  type World,
} from "./oauth-helpers.js";

// Issue #926: MCP OAuth end to end through handle() (design v7 9A.3, 9A.4,
// 9A.6, 9A.8). DCR, an admin's consent, the code exchange, then the bearer
// on POST /mcp: tools run through invokeRoute and their route's authz row,
// every call is audited as the oauth token, and a revoked or ended grant is
// 401 at the next call and refused at refresh.

/** A ctx whose waitUntil work (token.used) the test awaits: no sleeps. */
function waits() {
  const ps: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => ps.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(ps.splice(0)),
  };
}

/** The whole app, as the edge calls it, with the world's IP. */
function app(w: World, ctx: ExecutionContext) {
  return (req: Request) => {
    if (!req.headers.has("cf-connecting-ip"))
      req.headers.set("cf-connecting-ip", w.ip);
    return handle(req, w.env, ctx);
  };
}

async function connect(
  w: World,
  ctx: ExecutionContext,
  bearer: string,
): Promise<Client> {
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  const call = app(w, ctx);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: (url, init) => call(new Request(String(url), init as RequestInit)),
    }),
  );
  return client;
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  // biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON
  structuredContent?: any;
};
const callTool = async (
  client: Client,
  name: AdminToolName,
  args: Record<string, unknown> = {},
) =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
const textOf = (r: ToolResult) => r.content.map((x) => x.text ?? "").join("\n");

/** One raw tools/call with `bearer`, outside any session. */
const rawCall = (w: World, ctx: ExecutionContext, bearer: string) =>
  app(
    w,
    ctx,
  )(
    new Request(`${API}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_world", arguments: {} },
      }),
    }),
  );

const auditOf = async (w: World, tokenId: string) =>
  (
    await w.db
      .prepare(
        "SELECT actor_kind, actor_label, action, outcome, detail FROM admin_audit WHERE token_id = ?1 AND action IN ('token.used', 'authz.refused') ORDER BY id",
      )
      .bind(tokenId)
      .all<{
        actor_kind: string;
        actor_label: string;
        action: string;
        outcome: string;
        detail: string;
      }>()
  ).results.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

/** A live grant of installs:read and audit:read, and a connected client. */
async function granted(w: World) {
  const g = await grant(w, { scope: ["installs:read", "audit:read"] });
  const row = await rowOf(w, g.tokens);
  if (!row) throw new Error("no oauth row");
  return { ...g, row };
}

/** The grant is over: the same bearer is 401 at /mcp, refresh is refused. */
async function expectEnded(
  w: World,
  ctx: ExecutionContext,
  clientId: string,
  t: Tokens,
) {
  const res = await rawCall(w, ctx, t.access_token);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toMatch(
    /^Bearer realm="OAuth", error="invalid_token", resource_metadata="/,
  );
  expect(await res.json()).toMatchObject({
    error: { code: "unauthenticated" },
  });
  const r = await refresh(w, clientId, t);
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error?: string }).error).toBe("invalid_grant");
}

const browser = async (w: World) => ({
  cookie: `__Host-oa-admin=${w.sid}`,
  origin: ADMIN,
  "sec-fetch-site": "same-origin",
  "x-csrf-token": await csrfToken(w.env, w.sid),
  "cf-connecting-ip": w.ip,
});

beforeEach(() => {
  // One instant for the whole case: token.used windows, grant and session
  // ends never move under the test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MCP OAuth end to end (#926)", () => {
  it("DCR, consent, exchange; the bearer's tools run through invokeRoute and its authz; every call audited as the oauth token", async () => {
    const w = await oauthWorld();
    const { ctx, flush } = waits();
    const { tokens, row } = await granted(w);
    expect(tokens.scope.split(" ").sort()).toEqual([
      "audit:read",
      "installs:read",
    ]);
    expect(row).toMatchObject({ kind: "oauth", revoked_at: null });

    const client = await connect(w, ctx, tokens.access_token);
    const world = await callTool(client, "get_world");
    expect(world.isError, textOf(world)).toBeFalsy();
    expect(world.structuredContent).toBeTypeOf("object");
    const list = await callTool(client, "list_installs");
    expect(list.isError, textOf(list)).toBeFalsy();
    expect(Array.isArray(list.structuredContent.items)).toBe(true);

    // R4 needs installs:write, which the grant lacks: the route's authz
    // refuses it, mapped to a tool result (9A.6), not a protocol error.
    const create = await callTool(client, "create_install", {
      requestId: requestId(),
      slug: "e2eoauth",
      ownerEmail: "a@acme.test",
      tier: "team",
      auth: { providers: ["google"], domains: ["acme.test"] },
    });
    expect(create.isError).toBe(true);
    expect(create.structuredContent).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(textOf(create)).toMatch(/^forbidden: /);
    await flush();

    const actor = {
      actor_kind: "token",
      actor_label: row.label,
    };
    const oauth = {
      admin: w.email,
      surface: "mcp",
      via: "oauth",
      client: "Test agent",
    };
    expect(await auditOf(w, row.id)).toEqual(
      expect.arrayContaining([
        {
          ...actor,
          action: "token.used",
          outcome: "ok",
          detail: expect.objectContaining({
            ...oauth,
            route: "R27",
            tool: "get_world",
          }),
        },
        {
          ...actor,
          action: "token.used",
          outcome: "ok",
          detail: expect.objectContaining({
            ...oauth,
            route: "R2",
            tool: "list_installs",
          }),
        },
        {
          ...actor,
          action: "authz.refused",
          outcome: "refused",
          detail: expect.objectContaining({
            ...oauth,
            route: "R4",
            tool: "create_install",
          }),
        },
      ]),
    );
    expect(await auditOf(w, row.id)).toHaveLength(3);
  });

  it("R21 revoke of the oauth row: the same bearer is 401 at the next /mcp call, refresh refused", async () => {
    const w = await oauthWorld();
    const { ctx } = waits();
    const { clientId, tokens, row } = await granted(w);
    const client = await connect(w, ctx, tokens.access_token);
    expect((await callTool(client, "get_world")).isError).toBeFalsy();
    const res = await app(
      w,
      ctx,
    )(
      new Request(`${ADMIN}/api/v1/tokens/${row.id}`, {
        method: "DELETE",
        headers: await browser(w),
      }),
    );
    expect(res.status).toBe(204);
    await expectEnded(w, ctx, clientId, tokens);
  });

  it("logout (R24) ends the admin session and the grant with it", async () => {
    const w = await oauthWorld();
    const { ctx } = waits();
    const { clientId, tokens } = await granted(w);
    const client = await connect(w, ctx, tokens.access_token);
    expect((await callTool(client, "list_installs")).isError).toBeFalsy();
    const res = await handle(
      new Request(`${ADMIN}/auth/logout`, {
        method: "POST",
        headers: await browser(w),
      }),
      w.env,
      ctx,
      { audit: async () => {} },
    );
    expect(res.status).toBe(204);
    await expectEnded(w, ctx, clientId, tokens);
    expect((await rowOf(w, tokens))?.revoked_at).not.toBeNull();
  });

  it("the admin session's end (expiry) ends the grant at the next call", async () => {
    const w = await oauthWorld();
    const { ctx } = waits();
    const { clientId, tokens } = await granted(w);
    await w.db
      .prepare("UPDATE sessions SET expires_at = ?1 WHERE email = ?2")
      .bind(Date.now() - 1, w.email)
      .run();
    await expectEnded(w, ctx, clientId, tokens);
  });
});
