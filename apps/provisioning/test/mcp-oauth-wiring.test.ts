import { describe, expect, it, vi } from "vitest";
import { isRefusal } from "../src/principal.js";
import { API } from "./fakes.js";
import { grant, oauthWorld, rowOf, type World } from "./oauth-helpers.js";

// W13b's /mcp seam through handle(): app.ts must hand the production
// oauthPrincipal to handleMcp (W13a's adapter defaults to 401 without it).
// The adapter is stood in by one that asks deps.oauthPrincipal and answers
// 200 or 401, so this checks the wiring, not W13a's transport.
vi.mock("../src/mcp/index.js", () => ({
  handleMcp: async (
    req: Request,
    env: unknown,
    _ctx: unknown,
    deps: {
      oauthPrincipal?: (r: Request, e: unknown, t: string) => Promise<unknown>;
    } = {},
  ) => {
    const token = /^Bearer (\S+)$/i.exec(
      req.headers.get("authorization") ?? "",
    )?.[1];
    if (!token || !deps.oauthPrincipal)
      return new Response(null, { status: 401 });
    const p = await deps.oauthPrincipal(req, env, token);
    return isRefusal(p as never)
      ? new Response(null, { status: 401 })
      : Response.json(p);
  },
}));

const mcp = (w: World, bearer: string) =>
  w.call(
    new Request(`${API}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

describe("POST /mcp through handle() with an OAuth bearer", () => {
  it("the production oauthPrincipal answers it, then refuses it after a D1 revoke", async () => {
    const w = await oauthWorld();
    const { tokens } = await grant(w);
    const row = await rowOf(w, tokens);
    const ok = await mcp(w, tokens.access_token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      kind: "token",
      tokenKind: "oauth",
      actorKey: `token:${row?.id}`,
    });
    await w.db
      .prepare("UPDATE agent_tokens SET revoked_at = ?1 WHERE id = ?2")
      .bind(Date.now(), row?.id)
      .run();
    expect((await mcp(w, tokens.access_token)).status).toBe(401);
  });
});
