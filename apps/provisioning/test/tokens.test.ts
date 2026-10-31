import { ULID_RE } from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmac16, sha256Hex } from "../src/auth/crypto.js";
import { ApiError } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import {
  type AgentTokenRow,
  mintAgentToken,
  OAUTH_ACCESS_TTL_S,
  OAUTH_GRANT_MAX_MS,
  oauthLabel,
  principalByBearer,
  principalByTokenId,
  revokeAllTokens,
  revokeToken,
  type SessionRow,
  TOKEN_LIVE_LIMIT,
  tokenPrincipal,
} from "../src/services/tokens.js";
import { requestId, seedAdmin } from "./admin.js";
import { platformDb } from "./db.js";
import { fakeEnv } from "./fakes.js";

const T = 1_800_000_000_000;
const M = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

const rowOf = (db: D1Database, id: string) =>
  db
    .prepare("SELECT * FROM agent_tokens WHERE id = ?1")
    .bind(id)
    .first<AgentTokenRow>();
const auditOf = (db: D1Database, tokenId: string) =>
  db
    .prepare(
      "SELECT action, actor_kind, actor_label, token_id, request_id, outcome, detail FROM admin_audit WHERE token_id = ?1 ORDER BY id",
    )
    .bind(tokenId)
    .all<{
      action: string;
      actor_kind: string;
      actor_label: string;
      token_id: string;
      request_id: string | null;
      outcome: string;
      detail: string;
    }>()
    .then((r) => r.results);
const apiCode = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
};
const oat = (over: Partial<{ ttlMinutes: number; requestId: string }> = {}) =>
  ({
    kind: "oat",
    scopes: ["installs:read", "audit:read"],
    label: "ci bot",
    ttlMinutes: 15,
    requestId: requestId(),
    ...over,
  }) as const;
const oauth = (clientId = "client-a", clientName: string | null = "Claude") =>
  ({
    kind: "oauth",
    scopes: ["installs:read"],
    clientId,
    clientName,
  }) as const;

describe("mintAgentToken: oat (R19)", () => {
  it("mints an oat_ bearer shown once, stored by hash only", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const m = await mintAgentToken(env, principal, oat());
    expect(m.token).toMatch(/^oat_[A-Za-z0-9_-]{43}$/);
    expect(m.tokenId).toMatch(ULID_RE);
    expect(m.expiresAt).toBe(T + 15 * M);
    expect(m.oauthUser).toBeUndefined();
    const r = await rowOf(db, m.tokenId);
    expect(r).toMatchObject({
      kind: "oat",
      token_hash: await sha256Hex(m.token as string),
      session_hash: session.id_hash,
      admin_email: session.email,
      label: "ci bot",
      scopes: '["installs:read","audit:read"]',
      client_id: null,
      oauth_user: null,
      created_at: T,
      expires_at: T + 15 * M,
      revoked_at: null,
    });
    const all = await db.prepare("SELECT * FROM agent_tokens").all();
    expect(JSON.stringify(all.results)).not.toContain(m.token);
  });

  it("writes one token.mint audit row, never the bearer", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const o = oat();
    const m = await mintAgentToken(env, principal, o);
    const a = await auditOf(db, m.tokenId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action: "token.mint",
      actor_kind: "admin",
      actor_label: session.email,
      request_id: o.requestId,
      outcome: "ok",
    });
    expect(JSON.parse(a[0]?.detail as string)).toEqual({
      tokenId: m.tokenId,
      kind: "oat",
      label: "ci bot",
      scopes: ["installs:read", "audit:read"],
      expiresAt: T + 15 * M,
    });
    expect(a[0]?.detail).not.toContain(m.token);
  });

  it("an oauth consent writes oauth.grant with the 9A.8 fields, not token.mint", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const m = await mintAgentToken(env, principal, oauth("c1", "Claude"));
    const a = await auditOf(db, m.tokenId);
    expect(a.map((x) => x.action)).toEqual(["oauth.grant"]);
    expect(a[0]).toMatchObject({ actor_label: session.email, outcome: "ok" });
    expect(JSON.parse(a[0]?.detail as string)).toEqual({
      tokenId: m.tokenId,
      clientId: "c1",
      clientName: "Claude",
      scopes: ["installs:read"],
      redirectHost: null,
      grantEnd: m.expiresAt,
    });
  });

  it("never outlives the minting session", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T, {
      expires_at: T + 10 * M,
    });
    const m = await mintAgentToken(env, principal, oat({ ttlMinutes: 60 }));
    expect(m.expiresAt).toBe(T + 10 * M);
  });

  it("caps the ttl at 60 minutes and floors it at 5 (4.1)", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    expect(
      (await mintAgentToken(env, principal, oat({ ttlMinutes: 600 })))
        .expiresAt,
    ).toBe(T + 60 * M);
    expect(
      (await mintAgentToken(env, principal, oat({ ttlMinutes: 1 }))).expiresAt,
    ).toBe(T + 5 * M);
  });

  it("a replayed requestId never mints or shows a bearer again", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const o = oat();
    const first = await mintAgentToken(env, principal, o);
    const e = await apiCode(mintAgentToken(env, principal, o));
    expect(e.code).toBe("idempotency_conflict");
    expect(e.details).toEqual({ tokenId: first.tokenId });
    const n = await db
      .prepare("SELECT count(*) AS n FROM agent_tokens WHERE admin_email = ?1")
      .bind(session.email)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("two concurrent retries of one requestId mint once", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const o = oat();
    const r = await Promise.allSettled([
      mintAgentToken(env, principal, o),
      mintAgentToken(env, principal, o),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const n = await db
      .prepare("SELECT count(*) AS n FROM agent_tokens WHERE admin_email = ?1")
      .bind(session.email)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("a requestId this admin already used on a job route is idempotency_conflict (3.1)", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const o = oat();
    await db
      .prepare(
        `INSERT INTO jobs (id, kind, workflow, install_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
         VALUES (?1, 'suspend', 'manage_install', 'iaaaaaaaaaaa', 'admin', ?2, ?3, ?4, 'h', '{}', 'done', ?5, ?5)`,
      )
      .bind(
        `J${crypto.randomUUID()}`,
        principal.actorKey,
        session.email,
        o.requestId,
        T,
      )
      .run();
    const e = await apiCode(mintAgentToken(env, principal, o));
    expect(e.code).toBe("idempotency_conflict");
    const n = await db
      .prepare("SELECT count(*) AS n FROM agent_tokens WHERE admin_email = ?1")
      .bind(session.email)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("the same requestId from another admin is not a replay", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const b = await seedAdmin(db, T);
    const o = oat();
    await mintAgentToken(a.env, a.principal, o);
    await expect(mintAgentToken(b.env, b.principal, o)).resolves.toBeTruthy();
  });
});

describe("mintAgentToken: limits (4.1, 4.7)", () => {
  it(`at most ${5} live per admin across both kinds: token_limit`, async () => {
    expect(TOKEN_LIVE_LIMIT).toBe(5);
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    for (let i = 0; i < 3; i++) await mintAgentToken(env, principal, oat());
    await mintAgentToken(env, principal, oauth("c1"));
    await mintAgentToken(env, principal, oauth("c2"));
    expect((await apiCode(mintAgentToken(env, principal, oat()))).code).toBe(
      "token_limit",
    );
    expect(
      (await apiCode(mintAgentToken(env, principal, oauth("c3")))).code,
    ).toBe("token_limit");
    const n = await db
      .prepare("SELECT count(*) AS n FROM agent_tokens WHERE admin_email = ?1")
      .bind(session.email)
      .first<{ n: number }>();
    expect(n?.n).toBe(5);
  });

  it("revoked and expired tokens do not count", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        (await mintAgentToken(env, principal, oat({ ttlMinutes: 5 + i })))
          .tokenId,
      );
    await db
      .prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1")
      .bind(ids[4], T)
      .run();
    await expect(mintAgentToken(env, principal, oat())).resolves.toBeTruthy();
    // The 5-minute token expires; another slot opens.
    vi.setSystemTime(T + 5 * M);
    await expect(mintAgentToken(env, principal, oat())).resolves.toBeTruthy();
  });

  it("a newer consent of the same client supersedes the older grant, even at the limit", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    const old = await mintAgentToken(env, principal, oauth("same"));
    const other = await mintAgentToken(env, principal, oauth("other"));
    for (let i = 0; i < 3; i++) await mintAgentToken(env, principal, oat());
    vi.setSystemTime(T + M);
    const next = await mintAgentToken(env, principal, oauth("same"));
    expect((await rowOf(db, old.tokenId))?.revoked_at).toBe(T + M);
    expect((await rowOf(db, other.tokenId))?.revoked_at).toBeNull();
    expect((await rowOf(db, next.tokenId))?.revoked_at).toBeNull();
    const a = await auditOf(db, old.tokenId);
    expect(a.map((x) => x.action)).toEqual(["oauth.grant", "token.revoke"]);
    expect(JSON.parse(a[1]?.detail as string)).toEqual({
      tokenId: old.tokenId,
      label: "Claude",
      scopes: ["installs:read"],
      reason: "superseded",
      supersededBy: next.tokenId,
    });
  });

  it("replays and token_limit refusals do not spend the mint budget", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    const o = oat();
    const ids = [(await mintAgentToken(env, principal, o)).tokenId];
    for (let i = 0; i < 25; i++)
      expect((await apiCode(mintAgentToken(env, principal, o))).code).toBe(
        "idempotency_conflict",
      );
    for (let i = 0; i < 4; i++)
      ids.push((await mintAgentToken(env, principal, oat())).tokenId);
    for (let i = 0; i < 25; i++)
      expect((await apiCode(mintAgentToken(env, principal, oat()))).code).toBe(
        "token_limit",
      );
    // 5 mints charged so far: 15 more fit in the hour.
    for (let i = 0; i < 15; i++) {
      await db
        .prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1")
        .bind(ids.shift(), T)
        .run();
      ids.push((await mintAgentToken(env, principal, oat())).tokenId);
    }
    await db
      .prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1")
      .bind(ids.shift(), T)
      .run();
    expect((await apiCode(mintAgentToken(env, principal, oat()))).code).toBe(
      "rate_limited",
    );
  });

  it("a mint over the counter is counted in audit_refusals (4.9)", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    for (let i = 0; i < 20; i++) {
      const m = await mintAgentToken(env, principal, oat());
      await db
        .prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1")
        .bind(m.tokenId, T)
        .run();
    }
    await apiCode(mintAgentToken(env, principal, oat()));
    await apiCode(mintAgentToken(env, principal, oat()));
    const r = await db
      .prepare(
        "SELECT bucket, code, count FROM audit_refusals WHERE ip_hmac = ?1",
      )
      .bind(await hmac16(env.ADMIN_SESSION_KEY, principal.rateKey))
      .all();
    expect(r.results).toEqual([
      { bucket: "auth", code: "rate_limited", count: 2 },
    ]);
  });

  it("20 mints per admin per hour, both kinds together: rate_limited", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    for (let i = 0; i < 20; i++) {
      const m = await mintAgentToken(
        env,
        principal,
        i % 2 ? oat() : oauth(`c${i}`),
      );
      await db
        .prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1")
        .bind(m.tokenId, T)
        .run();
    }
    expect((await apiCode(mintAgentToken(env, principal, oat()))).code).toBe(
      "rate_limited",
    );
    vi.setSystemTime(T + 60 * M);
    await expect(mintAgentToken(env, principal, oat())).resolves.toBeTruthy();
  });
});

describe("mintAgentToken: who may mint", () => {
  it("only an admin session principal; a token cannot mint a token", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    const tok: Principal = {
      ...principal,
      kind: "token",
      actorKey: "token:x",
      tokenId: "x",
    };
    expect((await apiCode(mintAgentToken(env, tok, oat()))).code).toBe(
      "forbidden",
    );
    const oidc: Principal = { ...principal, kind: "oidc" };
    expect((await apiCode(mintAgentToken(env, oidc, oat()))).code).toBe(
      "forbidden",
    );
  });

  it("refuses without a live session row", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const { session: _drop, ...noHash } = a.principal;
    expect((await apiCode(mintAgentToken(a.env, noHash, oat()))).code).toBe(
      "unauthenticated",
    );
    const b = await seedAdmin(db, T, { revoked_at: T - 1 });
    expect(
      (await apiCode(mintAgentToken(b.env, b.principal, oat()))).code,
    ).toBe("unauthenticated");
    const c = await seedAdmin(db, T, { expires_at: T });
    expect(
      (await apiCode(mintAgentToken(c.env, c.principal, oat()))).code,
    ).toBe("unauthenticated");
  });

  it("refuses an admin no longer in ADMIN_IDENTITIES", async () => {
    const db = await platformDb();
    const a = await seedAdmin(db, T);
    const env = { ...a.env, ADMIN_IDENTITIES: "other@example.com:9" };
    expect((await apiCode(mintAgentToken(env, a.principal, oat()))).code).toBe(
      "unauthenticated",
    );
  });
});

describe("mintAgentToken: oauth (MCP consent)", () => {
  it("returns the grant row id, chain end and oauthUser; no bearer", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const m = await mintAgentToken(env, principal, oauth());
    expect(m.token).toBeUndefined();
    expect(m.oauthUser).toMatch(/^adm_[0-9a-f]{32}$/);
    expect(m.oauthUser).not.toContain(session.email);
    // The chain ends with the session (8 h here) and never later than 8 h.
    expect(m.expiresAt).toBe(T + OAUTH_GRANT_MAX_MS);
    expect(OAUTH_GRANT_MAX_MS).toBe(8 * 3_600_000);
    expect(OAUTH_ACCESS_TTL_S).toBe(15 * 60);
    expect(await rowOf(db, m.tokenId)).toMatchObject({
      kind: "oauth",
      token_hash: null,
      client_id: "client-a",
      client_name: "Claude",
      label: "Claude",
      oauth_user: m.oauthUser,
      session_hash: session.id_hash,
      grant_id: null,
    });
    const again = await mintAgentToken(env, principal, oauth("client-b"));
    expect(again.oauthUser).toBe(m.oauthUser);
  });

  it("ends with a shorter session", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T, {
      expires_at: T + 30 * M,
    });
    expect((await mintAgentToken(env, principal, oauth())).expiresAt).toBe(
      T + 30 * M,
    );
  });

  it("labels: the DCR client_name if it fits [A-Za-z0-9 ._-]{1,40}, else unnamed", () => {
    expect(oauthLabel("Claude")).toBe("Claude");
    expect(oauthLabel("Claude Code 2.1")).toBe("Claude Code 2.1");
    expect(oauthLabel(null)).toBe("unnamed");
    expect(oauthLabel("")).toBe("unnamed");
    expect(oauthLabel("<script>")).toBe("unnamed");
    expect(oauthLabel("Clauдe")).toBe("unnamed");
    expect(oauthLabel("x".repeat(41))).toBe("unnamed");
  });

  it("stores an unfit client_name as unnamed", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    const m = await mintAgentToken(env, principal, oauth("c", "<b>evil</b>"));
    expect(await rowOf(db, m.tokenId)).toMatchObject({
      label: "unnamed",
      client_name: "unnamed",
    });
    const n = await mintAgentToken(env, principal, oauth("d", null));
    expect(await rowOf(db, n.tokenId)).toMatchObject({
      label: "unnamed",
      client_name: null,
    });
  });
});

describe("oauth grants to end in KV (3.4 R21, 4.6)", () => {
  const withGrant = async (db: D1Database, id: string, grant: string) =>
    db
      .prepare("UPDATE agent_tokens SET grant_id = ?2 WHERE id = ?1")
      .bind(id, grant)
      .run();

  it("revokeToken returns an oauth row's grant; an oat row has none; unknown is null", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const o = await mintAgentToken(env, principal, oauth("c1"));
    await withGrant(db, o.tokenId, "g1");
    const t = await mintAgentToken(env, principal, oat());
    expect(await revokeToken(env, session.email, o.tokenId)).toEqual([
      { grantId: "g1", oauthUser: o.oauthUser },
    ]);
    // Already revoked: no grant to end twice.
    expect(await revokeToken(env, session.email, o.tokenId)).toEqual([]);
    expect(await revokeToken(env, session.email, t.tokenId)).toEqual([]);
    expect(
      await revokeToken(env, session.email, "01J00000000000000000000000"),
    ).toBeNull();
  });

  it("a superseding consent returns the older grant; an oat mint returns none", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    const first = await mintAgentToken(env, principal, oauth("same"));
    expect(first.superseded).toEqual([]);
    await withGrant(db, first.tokenId, "g-old");
    const next = await mintAgentToken(env, principal, oauth("same"));
    expect(next.superseded).toEqual([
      { grantId: "g-old", oauthUser: first.oauthUser },
    ]);
    expect((await mintAgentToken(env, principal, oat())).superseded).toBe(
      undefined,
    );
  });

  it("revokeToken audits the token's id, kind, label and scopes", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const t = await mintAgentToken(env, principal, oat());
    await revokeToken(env, session.email, t.tokenId);
    const a = await auditOf(db, t.tokenId);
    expect(JSON.parse(a[1]?.detail as string)).toEqual({
      tokenId: t.tokenId,
      kind: "oat",
      label: "ci bot",
      scopes: ["installs:read", "audit:read"],
    });
  });

  it("revokeAllTokens returns every live oauth grant", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const a = await mintAgentToken(env, principal, oauth("c1"));
    const b = await mintAgentToken(env, principal, oauth("c2"));
    await mintAgentToken(env, principal, oauth("c3")); // no grant yet
    await mintAgentToken(env, principal, oat());
    await withGrant(db, a.tokenId, "ga");
    await withGrant(db, b.tokenId, "gb");
    const g = await revokeAllTokens(env, session.email);
    expect([...g].sort((x, y) => x.grantId.localeCompare(y.grantId))).toEqual([
      { grantId: "ga", oauthUser: a.oauthUser },
      { grantId: "gb", oauthUser: b.oauthUser },
    ]);
  });

  it("a consent that loses the limit to concurrent mints keeps the older grant", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const old = await mintAgentToken(env, principal, oauth("same"));
    for (let i = 0; i < 3; i++) await mintAgentToken(env, principal, oat());
    // Between the pre-check (3 others live) and the batch, two concurrent
    // mints (both past their own pre-checks) land; 5 others are now live.
    const raced = (n: number) =>
      db
        .prepare(
          `INSERT INTO agent_tokens (id, kind, token_hash, session_hash, admin_email, label, scopes, client_id, client_name, oauth_user, grant_id, created_at, expires_at)
           VALUES (?1, 'oat', ?2, ?3, ?4, 'raced', '[]', NULL, NULL, NULL, NULL, ?5, ?6)`,
        )
        .bind(
          `race${n}`,
          `h${n}`,
          session.id_hash,
          session.email,
          T,
          T + 60 * M,
        );
    const racing = {
      prepare: (q: string) => db.prepare(q),
      batch: async (stmts: D1PreparedStatement[]) => {
        await db.batch([raced(1), raced(2)]);
        return db.batch(stmts);
      },
    } as unknown as D1Database;
    vi.setSystemTime(T + M);
    expect(
      (
        await apiCode(
          mintAgentToken(
            { ...env, PLATFORM_DB: racing },
            principal,
            oauth("same"),
          ),
        )
      ).code,
    ).toBe("token_limit");
    expect((await rowOf(db, old.tokenId))?.revoked_at).toBeNull();
    expect((await auditOf(db, old.tokenId)).map((x) => x.action)).toEqual([
      "oauth.grant",
    ]);
  });
});

describe("tokenPrincipal (9A.3.3)", () => {
  const S: SessionRow = {
    id_hash: "s",
    kind: "admin",
    host: "admin.hosted.test",
    email: "me@example.com",
    sub: "123",
    auth_at: T - M,
    created_at: T - M,
    expires_at: T + 60 * M,
    revoked_at: null,
    last_seen_at: null,
  };
  const R: AgentTokenRow = {
    id: "01J00000000000000000000000",
    kind: "oat",
    token_hash: "h",
    session_hash: "s",
    admin_email: "me@example.com",
    label: "ci",
    scopes: '["installs:read","installs:pii"]',
    client_id: null,
    client_name: null,
    oauth_user: null,
    grant_id: null,
    created_at: T - M,
    expires_at: T + 15 * M,
    revoked_at: null,
    last_used_at: null,
  };
  const O: AgentTokenRow = {
    ...R,
    kind: "oauth",
    token_hash: null,
    client_id: "c",
    client_name: "Claude",
    label: "Claude",
    oauth_user: "adm_00",
  };
  const env = fakeEnv().env;
  const no = (reason: string) => ({
    refusal: true,
    code: "unauthenticated",
    reason,
  });

  it("the principal: actorKey token:<id>, the admin's rate key, scopes from the row", () => {
    expect(tokenPrincipal(R, S, env, "oat")).toEqual({
      kind: "token",
      actorKey: `token:${R.id}`,
      rateKey: "admin:me@example.com",
      label: "ci",
      scopes: ["installs:read", "installs:pii"],
      email: "me@example.com",
      sub: "123",
      tokenId: R.id,
      tokenKind: "oat",
      client: null,
      tokenExpiresAt: R.expires_at,
      authAt: null,
    });
    expect(tokenPrincipal(O, S, env, "oauth")).toMatchObject({
      kind: "token",
      label: "Claude",
      tokenId: R.id,
      tokenKind: "oauth",
      client: "Claude",
    });
  });

  it("drops a scope the row holds but the enum does not know", () => {
    const p = tokenPrincipal(
      { ...R, scopes: '["installs:read","root"]' },
      S,
      env,
      "oat",
    );
    expect(p).toMatchObject({ scopes: ["installs:read"] });
    expect(
      tokenPrincipal({ ...R, scopes: "not json" }, S, env, "oat"),
    ).toMatchObject({ scopes: [] });
  });

  it("refuses with the reason, wrong_kind first", () => {
    expect(tokenPrincipal({ ...R, revoked_at: T }, S, env, "oauth")).toEqual(
      no("wrong_kind"),
    );
    expect(tokenPrincipal(O, S, env, "oat")).toEqual(no("wrong_kind"));
    expect(tokenPrincipal({ ...R, revoked_at: T - 1 }, S, env, "oat")).toEqual(
      no("revoked"),
    );
    expect(tokenPrincipal({ ...R, expires_at: T }, S, env, "oat")).toEqual(
      no("expired"),
    );
    expect(tokenPrincipal(R, null, env, "oat")).toEqual(no("session_ended"));
    expect(tokenPrincipal(R, { ...S, revoked_at: T - 1 }, env, "oat")).toEqual(
      no("session_ended"),
    );
    expect(tokenPrincipal(R, { ...S, expires_at: T }, env, "oat")).toEqual(
      no("session_ended"),
    );
    expect(tokenPrincipal(R, { ...S, id_hash: "other" }, env, "oat")).toEqual(
      no("session_ended"),
    );
    expect(tokenPrincipal(R, { ...S, kind: "user" }, env, "oat")).toEqual(
      no("session_ended"),
    );
    expect(
      tokenPrincipal(R, { ...S, email: "x@example.com" }, env, "oat"),
    ).toEqual(no("session_ended"));
    expect(
      tokenPrincipal(R, S, { ADMIN_IDENTITIES: "me@example.com:999" }, "oat"),
    ).toEqual(no("identity_removed"));
    expect(tokenPrincipal(R, S, { ADMIN_IDENTITIES: "" }, "oat")).toEqual(
      no("identity_removed"),
    );
  });
});

describe("principalByTokenId (the oauth path's D1 check per call)", () => {
  it("loads the row and its session from D1 on every call", async () => {
    const db = await platformDb();
    const { env, principal, session } = await seedAdmin(db, T);
    const m = await mintAgentToken(env, principal, oauth());
    expect(await principalByTokenId(env, m.tokenId, "oauth")).toMatchObject({
      kind: "token",
      tokenId: m.tokenId,
      rateKey: `admin:${session.email}`,
    });
    expect(await principalByTokenId(env, m.tokenId, "oat")).toMatchObject({
      reason: "wrong_kind",
    });
    await db
      .prepare("UPDATE sessions SET revoked_at = ?2 WHERE id_hash = ?1")
      .bind(session.id_hash, T)
      .run();
    expect(await principalByTokenId(env, m.tokenId, "oauth")).toMatchObject({
      reason: "session_ended",
    });
  });

  it("an unknown id is revoked", async () => {
    const db = await platformDb();
    const { env } = await seedAdmin(db, T);
    expect(
      await principalByTokenId(env, "01J00000000000000000000000", "oauth"),
    ).toEqual({ refusal: true, code: "unauthenticated", reason: "revoked" });
  });
});

describe("principalByBearer: token hashes compared in constant time (4.1)", () => {
  it("the row's token_hash must equal the bearer's hash, checked after the lookup", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T);
    const m = await mintAgentToken(env, principal, oat());
    const bearer = m.token as string;
    expect(await principalByBearer(env, bearer)).toMatchObject({
      kind: "token",
      tokenId: m.tokenId,
    });
    // A lookup that hands back a row for another hash (case-folding, a bad
    // index) is refused by the explicit compare, not trusted.
    const row = await rowOf(db, m.tokenId);
    const lying = {
      ...env,
      PLATFORM_DB: new Proxy(db, {
        get: (t, k) =>
          k === "prepare"
            ? (sql: string) => {
                const st = t.prepare(sql);
                if (!sql.includes("WHERE token_hash")) return st;
                return {
                  bind: () => ({
                    first: async () => ({
                      ...row,
                      token_hash: `${row?.token_hash?.slice(0, -1)}0`,
                    }),
                  }),
                };
              }
            : Reflect.get(t, k),
      }),
    } as typeof env;
    expect(await principalByBearer(lying, bearer)).toEqual({
      refusal: true,
      code: "unauthenticated",
      reason: "revoked",
    });
  });
});
