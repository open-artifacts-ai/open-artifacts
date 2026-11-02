import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../src/principal.js";
import { invokeRoute, type Surface } from "../src/routes/invoke.js";
import {
  mintAgentToken,
  principalByTokenId,
  recordTokenUse,
  TOKEN_USED_WINDOW_MS,
} from "../src/services/tokens.js";
import { requestId, seedAdmin } from "./admin.js";
import { platformDb } from "./db.js";

const T = 1_800_000_000_000; // a whole 10-minute window
const HTTP: Surface = {
  kind: "http",
  client: { ip: "192.0.2.1", host: "api.hosted.test" },
};
const MCP: Surface = {
  kind: "mcp",
  tool: "list_installs",
  clientVersion: "1.2.3",
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

async function tokenCaller() {
  const db = await platformDb();
  const a = await seedAdmin(db, T);
  const m = await mintAgentToken(a.env, a.principal, {
    kind: "oat",
    scopes: ["installs:read"],
    label: "ci",
    ttlMinutes: 60,
    requestId: requestId(),
  });
  const p = (await principalByTokenId(a.env, m.tokenId, "oat")) as Principal;
  return { ...a, db, m, p };
}
const used = async (db: D1Database, tokenId: string) =>
  (
    await db
      .prepare(
        "SELECT at, actor_kind, actor_label, detail FROM admin_audit WHERE token_id = ?1 AND action = 'token.used' ORDER BY id",
      )
      .bind(tokenId)
      .all<{
        at: number;
        actor_kind: string;
        actor_label: string;
        detail: string;
      }>()
  ).results;

describe("token.used (4.1, 4.9): one row per token per route per 10 minutes", () => {
  it("writes the first use, with the minting admin and the surface", async () => {
    const { env, db, m, p, session } = await tokenCaller();
    await recordTokenUse(env, p, "R2", HTTP);
    const rows = await used(db, m.tokenId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: T,
      actor_kind: "token",
      actor_label: "ci",
    });
    expect(JSON.parse(rows[0]?.detail as string)).toEqual({
      admin: session.email,
      route: "R2",
      surface: "http",
      via: "oat",
      client: null,
    });
    const r = await db
      .prepare("SELECT last_used_at FROM agent_tokens WHERE id = ?1")
      .bind(m.tokenId)
      .first<{ last_used_at: number }>();
    expect(r?.last_used_at).toBe(T);
  });

  it("MCP adds tool and clientVersion", async () => {
    const { env, db, m, p } = await tokenCaller();
    await recordTokenUse(env, p, "R2", MCP);
    expect(
      JSON.parse((await used(db, m.tokenId))[0]?.detail as string),
    ).toMatchObject({
      surface: "mcp",
      tool: "list_installs",
      via: "oat",
      clientVersion: "1.2.3",
    });
  });

  it("an oauth token records via oauth and its sanitized client name (9A.8)", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const m = await mintAgentToken(a.env, a.principal, {
      kind: "oauth",
      scopes: ["installs:read"],
      clientId: "client-a",
      clientName: "Claude",
    });
    const p = (await principalByTokenId(
      a.env,
      m.tokenId,
      "oauth",
    )) as Principal;
    await recordTokenUse(a.env, p, "R2", MCP);
    expect(
      JSON.parse((await used(db, m.tokenId))[0]?.detail as string),
    ).toMatchObject({ via: "oauth", client: "Claude" });
  });

  it("repeats inside the window add nothing; another route or window does", async () => {
    const { env, db, m, p } = await tokenCaller();
    await recordTokenUse(env, p, "R2", HTTP);
    vi.setSystemTime(T + TOKEN_USED_WINDOW_MS - 1);
    await recordTokenUse(env, p, "R2", MCP);
    expect(await used(db, m.tokenId)).toHaveLength(1);
    await recordTokenUse(env, p, "R3", HTTP);
    expect(await used(db, m.tokenId)).toHaveLength(2);
    vi.setSystemTime(T + TOKEN_USED_WINDOW_MS);
    await recordTokenUse(env, p, "R2", HTTP);
    expect(await used(db, m.tokenId)).toHaveLength(3);
  });

  it("concurrent first uses write one row", async () => {
    const { env, db, m, p } = await tokenCaller();
    await Promise.all(
      Array.from({ length: 5 }, () => recordTokenUse(env, p, "R2", HTTP)),
    );
    expect(await used(db, m.tokenId)).toHaveLength(1);
  });

  it("does nothing for any other principal", async () => {
    const { env, db, principal } = await tokenCaller();
    await recordTokenUse(env, principal, "R2", HTTP);
    const n = await db
      .prepare(
        "SELECT count(*) AS n FROM admin_audit WHERE action = 'token.used' AND actor_label = ?1",
      )
      .bind(principal.email)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("invokeRoute records it after authz passes, off the response path", async () => {
    const { env, db, m, p } = await tokenCaller();
    const waits: Promise<unknown>[] = [];
    const c = {
      waitUntil: (x: Promise<unknown>) => waits.push(x),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    await invokeRoute(env, c, p, "R2", {}, HTTP);
    await Promise.all(waits);
    expect(await used(db, m.tokenId)).toHaveLength(1);
    // A refused call (no installs:write) records nothing.
    await invokeRoute(env, c, p, "R7", {}, HTTP).catch(() => {});
    await Promise.all(waits);
    expect(await used(db, m.tokenId)).toHaveLength(1);
  });

  it("a failed token.used write never fails the call", async () => {
    const { env, p } = await tokenCaller();
    const waits: Promise<unknown>[] = [];
    const c = {
      waitUntil: (x: Promise<unknown>) => waits.push(x),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const broken = {
      ...env,
      PLATFORM_DB: new Proxy(env.PLATFORM_DB, {
        get: (t, k) =>
          k === "batch"
            ? () => Promise.reject(new Error("d1 down"))
            : Reflect.get(t, k).bind(t),
      }),
    };
    const r = await invokeRoute(broken, c, p, "R2", {}, HTTP);
    expect(r.status).toBe(200);
    await expect(Promise.all(waits)).resolves.toBeDefined();
  });
});
