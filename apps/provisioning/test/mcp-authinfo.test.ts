import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcp } from "../src/mcp/index.js";
import { mintAgentToken } from "../src/services/tokens.js";
import { requestId, seedAdmin } from "./admin.js";
import { platformDb } from "./db.js";
import { API, db, resetDb } from "./fakes.js";

// 9A.3.3 step 4: the bearer never reaches the SDK. The handler's fetch is
// wrapped to record the authInfo the adapter passes it.

const seen = vi.hoisted(() => ({
  authInfo: [] as unknown[],
  authorization: [] as (string | null)[],
}));
vi.mock("agents/mcp/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("agents/mcp/server")>();
  return {
    ...real,
    createMcpHandler: ((...a: Parameters<typeof real.createMcpHandler>) => {
      const h = real.createMcpHandler(...a);
      return {
        ...h,
        fetch: (req: Request, o?: { authInfo?: unknown }) => {
          seen.authInfo.push(o?.authInfo);
          seen.authorization.push(req.headers.get("authorization"));
          return h.fetch(req, o as never);
        },
      };
    }) as typeof real.createMcpHandler,
  };
});

beforeEach(async () => {
  await resetDb();
  await platformDb();
  seen.authInfo.length = 0;
  seen.authorization.length = 0;
});

describe("authInfo (9A.3.3)", () => {
  it("carries an empty token and the actor key; the request has no bearer", async () => {
    const a = await seedAdmin(db, Date.now());
    const m = await mintAgentToken(a.env, a.principal, {
      kind: "oat",
      scopes: ["installs:read"],
      label: "ci bot",
      ttlMinutes: 15,
      requestId: requestId(),
    });
    const res = await handleMcp(
      new Request(`${API}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${m.token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      a.env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    expect(res.status).toBe(200);
    expect(seen.authInfo).toEqual([
      { token: "", clientId: `token:${m.tokenId}`, scopes: [] },
    ]);
    expect(JSON.stringify(seen.authInfo)).not.toContain(String(m.token));
    // Nor the request the SDK hands its handlers (extra.requestInfo).
    expect(seen.authorization).toEqual([null]);
  });
});
