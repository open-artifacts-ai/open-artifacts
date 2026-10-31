import { MintedTokenSchema, TokensSchema } from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import { invokeRoute, type Surface } from "../src/routes/invoke.js";
import { mintAgentToken } from "../src/services/tokens.js";
import { requestId, seedAdmin } from "./admin.js";
import { platformDb } from "./db.js";
import { ctx } from "./fakes.js";

const T = 1_800_000_000_000;
const M = 60_000;
const HTTP: Surface = {
  kind: "http",
  client: { ip: "192.0.2.1", host: "api.hosted.test" },
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

const call = async (
  a: Awaited<ReturnType<typeof seedAdmin>>,
  route: "R19" | "R20" | "R21",
  input: Parameters<typeof invokeRoute>[4] = {},
  p: Principal = a.principal,
) => {
  try {
    return await invokeRoute(a.env, ctx(), p, route, input, HTTP);
  } catch (e) {
    if (e instanceof ApiError) return { status: e.code, body: e.details };
    throw e;
  }
};
const mintBody = (over: Record<string, unknown> = {}) => ({
  requestId: requestId(),
  label: "ci",
  scopes: ["installs:read"],
  ...over,
});
const oauth = (a: Awaited<ReturnType<typeof seedAdmin>>, clientId = "c") =>
  mintAgentToken(a.env, a.principal, {
    kind: "oauth",
    scopes: ["installs:read"],
    clientId,
    clientName: "Claude",
  });
const auditActions = async (db: D1Database, email: string) =>
  (
    await db
      .prepare(
        "SELECT action, token_id, detail FROM admin_audit WHERE actor_label = ?1 ORDER BY id",
      )
      .bind(email)
      .all<{ action: string; token_id: string | null; detail: string }>()
  ).results;

describe("R19 POST /tokens", () => {
  it("201 with the bearer, once; ttl defaults to 15 minutes", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const r = await call(a, "R19", { body: mintBody() });
    expect(r.status).toBe(201);
    const b = MintedTokenSchema.parse(r.body);
    expect(b).toMatchObject({
      kind: "oat",
      label: "ci",
      clientName: null,
      scopes: ["installs:read"],
      createdAt: T,
      expiresAt: T + 15 * M,
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(b.token).toMatch(/^oat_/);
  });

  it("400 invalid_input on a bad body", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    for (const body of [
      undefined,
      {},
      mintBody({ scopes: [] }),
      mintBody({ scopes: ["root"] }),
      mintBody({ label: "<b>" }),
      mintBody({ ttlMinutes: 61 }),
      mintBody({ ttlMinutes: 4 }),
      mintBody({ requestId: "short" }),
    ])
      expect((await call(a, "R19", { body })).status).toBe("invalid_input");
  });

  it("409 token_limit at 5 live", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    for (let i = 0; i < 5; i++)
      expect((await call(a, "R19", { body: mintBody() })).status).toBe(201);
    expect((await call(a, "R19", { body: mintBody() })).status).toBe(
      "token_limit",
    );
  });

  it("a token principal is forbidden (authz)", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const tok: Principal = {
      ...a.principal,
      kind: "token",
      scopes: [
        "installs:read",
        "installs:write",
        "installs:delete",
        "installs:pii",
        "audit:read",
      ],
    };
    expect((await call(a, "R19", { body: mintBody() }, tok)).status).toBe(
      "forbidden",
    );
  });
});

describe("R20 GET /tokens", () => {
  it("lists this admin's tokens of both kinds, newest first, no secrets", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const other = await seedAdmin(db, T);
    await call(other, "R19", { body: mintBody() });
    const t1 = (await call(a, "R19", { body: mintBody({ label: "one" }) }))
      .body as { id: string };
    vi.setSystemTime(T + 1);
    const o = await oauth(a);
    const r = await call(a, "R20");
    expect(r.status).toBe(200);
    const b = TokensSchema.parse(r.body);
    expect(b.items.map((x) => [x.id, x.kind, x.label, x.clientName])).toEqual([
      [o.tokenId, "oauth", "Claude", "Claude"],
      [t1.id, "oat", "one", null],
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/token_hash|oat_|adm_/);
  });

  it("keeps ended tokens for 24 h, then drops them", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    await call(a, "R19", { body: mintBody({ ttlMinutes: 5 }) });
    vi.setSystemTime(T + 5 * M + 24 * 60 * M - 1);
    expect(TokensSchema.parse((await call(a, "R20")).body).items).toHaveLength(
      1,
    );
    vi.setSystemTime(T + 5 * M + 24 * 60 * M);
    expect(TokensSchema.parse((await call(a, "R20")).body).items).toHaveLength(
      0,
    );
  });
});

describe("R21 DELETE /tokens/:id?", () => {
  it("revokes one token: 204, revokedAt set, one token.revoke row", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const t = (await call(a, "R19", { body: mintBody() })).body as {
      id: string;
    };
    vi.setSystemTime(T + M);
    const r = await call(a, "R21", { params: { id: t.id } });
    expect(r).toMatchObject({ status: 204, body: null });
    const items = TokensSchema.parse((await call(a, "R20")).body).items;
    expect(items[0]?.revokedAt).toBe(T + M);
    // Revoking again is a no-op: 204, no second row.
    expect((await call(a, "R21", { params: { id: t.id } })).status).toBe(204);
    const rows = (await auditActions(db, a.session.email)).filter(
      (x) => x.action === "token.revoke",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_id).toBe(t.id);
  });

  it("revokes an oauth grant the same way", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const o = await oauth(a);
    expect((await call(a, "R21", { params: { id: o.tokenId } })).status).toBe(
      204,
    );
    const items = TokensSchema.parse((await call(a, "R20")).body).items;
    expect(items[0]?.revokedAt).toBe(T);
  });

  it("another admin's token, or an unknown id, is 404", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const b = await seedAdmin(db, T);
    const t = (await call(b, "R19", { body: mintBody() })).body as {
      id: string;
    };
    expect((await call(a, "R21", { params: { id: t.id } })).status).toBe(
      "not_found",
    );
    expect(
      (await call(a, "R21", { params: { id: "01J00000000000000000000000" } }))
        .status,
    ).toBe("not_found");
    expect(
      TokensSchema.parse((await call(b, "R20")).body).items[0]?.revokedAt,
    ).toBeNull();
  });

  it("no id revokes all of this admin's live tokens, both kinds, one token.revoke_all row", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const b = await seedAdmin(db, T);
    await call(a, "R19", { body: mintBody() });
    await call(a, "R19", { body: mintBody() });
    await oauth(a);
    await call(b, "R19", { body: mintBody() });
    expect((await call(a, "R21", {})).status).toBe(204);
    expect(
      TokensSchema.parse((await call(a, "R20")).body).items.every(
        (x) => x.revokedAt === T,
      ),
    ).toBe(true);
    expect(
      TokensSchema.parse((await call(b, "R20")).body).items[0]?.revokedAt,
    ).toBeNull();
    const rows = (await auditActions(db, a.session.email)).filter(
      (x) => x.action === "token.revoke_all",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail as string)).toEqual({ count: 3 });
  });
});
