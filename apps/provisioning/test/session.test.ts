import { beforeEach, describe, expect, it } from "vitest";
import { handle as appHandle } from "../src/app.js";
import type { AuditEntry } from "../src/audit.js";
import { authenticate } from "../src/auth/authenticate.js";
import { hmacB64 } from "../src/auth/crypto.js";
import { checkCsrf, checkOrigin, csrfToken } from "../src/auth/csrf.js";
import { matchIdentity, parseIdentities } from "../src/auth/identities.js";
import { hasRecentAuth, REAUTH_MAX_AGE_MS } from "../src/auth/reauth.js";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionHash,
} from "../src/auth/session.js";
import type { SigninDeps } from "../src/auth/signin.js";
import { isRefusal, type Principal } from "../src/principal.js";
import { platformDb } from "./db.js";
import { ADMIN, API, ctx, fakeEnv } from "./fakes.js";
import {
  otherHash,
  PROP_CASES,
  PROP_SEED,
  PROP_TIMEOUT_MS,
  rng,
  secret43,
} from "./prop.js";

// Every edge request carries cf-connecting-ip (the adapter 403s without
// one, 4.7); a test that sets its own keeps it.
const handle = (
  req: Request,
  ...rest: Parameters<typeof appHandle> extends [unknown, ...infer R]
    ? R
    : never
) => {
  if (!req.headers.has("cf-connecting-ip")) {
    req = new Request(req);
    req.headers.set("cf-connecting-ip", "192.0.2.10");
  }
  return appHandle(req, ...rest);
};

// Sessions, cookies, CSRF and Origin (design v7 4.5), and R24 logout.

const NOW = 1_800_000_000_000;
let db: D1Database;
beforeEach(async () => {
  db = await platformDb();
});

const session = async (
  e = fakeEnv(),
  o: { email?: string; sub?: string; authAt?: number; now?: number } = {},
) =>
  createSession(
    e.env,
    {
      email: o.email ?? "me@example.com",
      sub: o.sub ?? "123",
      authAt: o.authAt ?? NOW,
    },
    o.now ?? NOW,
  );

const withCookie = (url: string, sid: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: {
      cookie: `a=b; ${SESSION_COOKIE}=${sid}; c=d`,
      ...(init.headers ?? {}),
    },
  });

describe("ADMIN_IDENTITIES", () => {
  it("parses email:sub pairs, normalizing the email, skipping malformed ones", () => {
    expect(
      parseIdentities(" Me@Example.com:123 ,bad, :x, y@z.com: ,a@b.c:4:5"),
    ).toEqual([
      { email: "me@example.com", sub: "123" },
      { email: "a@b.c", sub: "4:5" },
    ]);
  });

  it("matches the exact pair only", () => {
    const raw = "me@example.com:123";
    expect(matchIdentity(raw, "me@example.com", "123")).toBe("ok");
    expect(matchIdentity(raw, "me@example.com", "1234")).toBe("unknown_sub");
    expect(matchIdentity(raw, "you@example.com", "123")).toBe("not_listed");
  });
});

describe("authenticate on the admin host (4.5)", () => {
  it("a live session is the admin principal, with authAt and the session's CSRF token", async () => {
    const e = fakeEnv();
    const s = await session(e, { authAt: NOW - 5000 });
    const p = await authenticate(
      withCookie(`${ADMIN}/api/v1/me`, s.sid),
      e.env,
      "admin",
      NOW + 1000,
    );
    expect(isRefusal(p)).toBe(false);
    expect(p).toEqual({
      kind: "admin",
      actorKey: "admin:me@example.com",
      rateKey: "admin:me@example.com",
      label: "me@example.com",
      scopes: [],
      email: "me@example.com",
      sub: "123",
      authAt: NOW - 5000,
      session: {
        hash: await sessionHash(s.sid),
        csrf: await csrfToken(e.env, s.sid),
        expiresAt: NOW + SESSION_TTL_MS,
        authAt: NOW - 5000,
      },
    });
  });

  it("no cookie, junk, unknown, expired, revoked or a removed identity: unauthenticated", async () => {
    const e = fakeEnv();
    const s = await session(e);
    const un = { refusal: true, code: "unauthenticated" };
    const at = (sid: string | null, env = e.env, now = NOW) =>
      authenticate(
        sid === null
          ? new Request(`${ADMIN}/api/v1/me`)
          : withCookie(`${ADMIN}/api/v1/me`, sid),
        env,
        "admin",
        now,
      );
    expect(await at(null)).toEqual(un);
    expect(await at("junk")).toEqual(un);
    expect(await at("A".repeat(43))).toEqual(un);
    expect(await at(s.sid, e.env, NOW + SESSION_TTL_MS)).toEqual(un);
    expect(
      await at(s.sid, fakeEnv({ ADMIN_IDENTITIES: "me@example.com:999" }).env),
    ).toEqual(un);
    await db.prepare("UPDATE sessions SET revoked_at = ?").bind(NOW).run();
    expect(await at(s.sid)).toEqual(un);
  });

  it("the api host ignores the cookie", async () => {
    const e = fakeEnv();
    const s = await session(e);
    const p = await authenticate(
      withCookie(`${API}/v1/me`, s.sid),
      e.env,
      "api",
      NOW,
    );
    expect(p).toEqual({ refusal: true, code: "unauthenticated" });
  });
});

describe("session lookup: sha256(sid) compared in constant time (4.1)", () => {
  // Seeded property (seed PROP_SEED, PROP_CASES cases): whatever row the
  // lookup hands back, the session is accepted only when its id_hash equals
  // sha256(sid).
  it(
    `property: a differing id_hash is refused, the exact one accepted (seed ${PROP_SEED.toString(16)}, ${PROP_CASES} cases)`,
    async () => {
      const e = fakeEnv();
      const s = await session(e);
      const real = (await db
        .prepare("SELECT * FROM sessions WHERE id_hash = ?1")
        .bind(await sessionHash(s.sid))
        .first()) as Record<string, unknown>;
      let stored = "";
      const lying = {
        ...e.env,
        PLATFORM_DB: new Proxy(db, {
          get: (t, k) =>
            k === "prepare"
              ? (sql: string) =>
                  sql.includes("FROM sessions WHERE id_hash = ? AND kind")
                    ? {
                        bind: () => ({
                          first: async () => ({ ...real, id_hash: stored }),
                        }),
                      }
                    : t.prepare(sql)
              : Reflect.get(t, k),
        }),
      } as typeof e.env;
      const at = (sid: string, env = lying) =>
        authenticate(withCookie(`${ADMIN}/api/v1/me`, sid), env, "admin", NOW);
      const un = { refusal: true, code: "unauthenticated" };
      const r = rng(PROP_SEED + 2);
      const h0 = real.id_hash as string;
      for (let i = 0; i < PROP_CASES; i++) {
        // A random sid against the real row.
        const sid = secret43(r);
        const h = await sessionHash(sid);
        expect(h, `case ${i}`).not.toBe(h0);
        stored = h0;
        expect(await at(sid), `case ${i}`).toEqual(un);
        expect(await at(sid, e.env), `case ${i}`).toEqual(un);
        // A row whose stored hash differs from the real sid's.
        stored = otherHash(r, h0);
        expect(stored, `case ${i}`).not.toBe(h0);
        expect(await at(s.sid), `case ${i}`).toEqual(un);
        // The exact pair.
        stored = h;
        expect(await at(sid), `case ${i}`).toMatchObject({
          kind: "admin",
          session: { hash: h },
        });
      }
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Origin and Sec-Fetch-Site (before authn)", () => {
  const { env } = fakeEnv();
  const req = (method: string, h: Record<string, string>) =>
    new Request(`${ADMIN}/api/v1/installs`, { method, headers: h });

  it("GET and HEAD pass", () => {
    expect(checkOrigin(req("GET", {}), env)).toBeNull();
    expect(
      checkOrigin(req("HEAD", { origin: "https://evil.test" }), env),
    ).toBeNull();
  });

  it("a write needs the exact admin origin; Sec-Fetch-Site, when sent, same-origin", () => {
    expect(checkOrigin(req("POST", { origin: ADMIN }), env)).toBeNull();
    expect(
      checkOrigin(
        req("POST", { origin: ADMIN, "sec-fetch-site": "same-origin" }),
        env,
      ),
    ).toBeNull();
    const bad: Record<string, string>[] = [
      {},
      { origin: "null" },
      { origin: `${ADMIN}.evil.test` },
      { origin: "https://evil.hosted.test" },
      { origin: "http://admin.hosted.test" },
      { origin: `${ADMIN}/` },
      { origin: ADMIN, "sec-fetch-site": "same-site" },
      { origin: ADMIN, "sec-fetch-site": "cross-site" },
      { origin: ADMIN, "sec-fetch-site": "none" },
    ];
    for (const h of bad)
      expect(checkOrigin(req("POST", h), env), JSON.stringify(h)).toEqual({
        refusal: true,
        code: "csrf_failed",
      });
  });
});

describe("CSRF (after authn)", () => {
  it("the token is base64url(HMAC-SHA256(ADMIN_SESSION_KEY, 'csrf\\n' + sid))", async () => {
    const { env } = fakeEnv();
    expect(await csrfToken(env, "sid1")).toBe(
      await hmacB64(env.ADMIN_SESSION_KEY, "csrf\nsid1"),
    );
  });

  it("a write needs x-csrf-token equal to the session's", async () => {
    const e = fakeEnv();
    const s = await session(e);
    const p = (await authenticate(
      withCookie(`${ADMIN}/`, s.sid),
      e.env,
      "admin",
      NOW,
    )) as Principal;
    const tok = await csrfToken(e.env, s.sid);
    const r = (h: Record<string, string>, method = "POST") =>
      new Request(`${ADMIN}/api/v1/installs`, { method, headers: h });
    expect(checkCsrf(r({ "x-csrf-token": tok }), e.env, p)).toBeNull();
    expect(checkCsrf(r({}, "GET"), e.env, p)).toBeNull();
    const bad: Record<string, string>[] = [
      {},
      { "x-csrf-token": "" },
      { "x-csrf-token": `${tok}x` },
      { "x-csrf-token": await csrfToken(e.env, "other") },
    ];
    for (const h of bad)
      expect(checkCsrf(r(h), e.env, p)).toEqual({
        refusal: true,
        code: "csrf_failed",
      });
    // A principal without a session (a token) never passes a browser write.
    expect(
      checkCsrf(r({ "x-csrf-token": tok }), e.env, {
        ...p,
        session: undefined,
      }),
    ).toEqual({
      refusal: true,
      code: "csrf_failed",
    });
  });
});

describe("reauth for purge (R11)", () => {
  it("authAt within 10 min", () => {
    const p = (authAt: number | null) => ({ authAt }) as Principal;
    expect(REAUTH_MAX_AGE_MS).toBe(600_000);
    expect(hasRecentAuth(p(NOW - 600_000), NOW)).toBe(true);
    expect(hasRecentAuth(p(NOW - 600_001), NOW)).toBe(false);
    expect(hasRecentAuth(p(null), NOW)).toBe(false);
    expect(hasRecentAuth({} as Principal, NOW)).toBe(false);
  });
});

describe("R24 POST /auth/logout", () => {
  let audits: AuditEntry[];
  let grants: { grantId: string; oauthUser: string }[];
  const deps = (): Partial<SigninDeps> => ({
    now: () => NOW,
    audit: async (_e, a) => {
      audits.push(a);
    },
    revokeGrant: async (_e, g) => {
      grants.push(g);
    },
  });
  beforeEach(() => {
    audits = [];
    grants = [];
  });

  const token = (id: string, sessionHash: string, kind: "oat" | "oauth") =>
    db
      .prepare(
        `INSERT INTO agent_tokens (id, kind, token_hash, session_hash, admin_email, label, scopes, client_id, client_name, oauth_user, grant_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'me@example.com', ?, '["installs:read"]', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        kind,
        kind === "oat" ? `h-${id}` : null,
        sessionHash,
        `label-${id}`,
        kind === "oauth" ? "client-1" : null,
        kind === "oauth" ? "Claude" : null,
        kind === "oauth" ? "adm_0123" : null,
        kind === "oauth" ? `grant-${id}` : null,
        NOW,
        NOW + 3600_000,
      )
      .run();

  const logout = (
    e: ReturnType<typeof fakeEnv>,
    sid: string | null,
    h: Record<string, string>,
  ) =>
    handle(
      new Request(`${ADMIN}/auth/logout`, {
        method: "POST",
        headers: {
          ...(sid ? { cookie: `${SESSION_COOKIE}=${sid}` } : {}),
          ...h,
        },
      }),
      e.env,
      ctx(),
      deps(),
    );

  it("revokes the session, its oat_ tokens and OAuth grants; clears the cookie; 204", async () => {
    const e = fakeEnv();
    const s = await session(e);
    const other = await session(e);
    const h = await sessionHash(s.sid);
    await token("t1", h, "oat");
    await token("t2", h, "oauth");
    await token("t3", await sessionHash(other.sid), "oat");
    const res = await logout(e, s.sid, {
      origin: ADMIN,
      "x-csrf-token": await csrfToken(e.env, s.sid),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const c =
      res.headers
        .getSetCookie()
        .find((x) => x.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(c).toMatch(/^__Host-oa-admin=; /);
    expect(c).toMatch(/Max-Age=0/);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Secure/);
    const rows = await db
      .prepare("SELECT id_hash, revoked_at FROM sessions")
      .all<{ id_hash: string; revoked_at: number | null }>();
    expect(rows.results.find((r) => r.id_hash === h)?.revoked_at).toBe(NOW);
    expect(rows.results.find((r) => r.id_hash !== h)?.revoked_at).toBeNull();
    const toks = await db
      .prepare("SELECT id, revoked_at FROM agent_tokens ORDER BY id")
      .all();
    expect(toks.results).toEqual([
      { id: "t1", revoked_at: NOW },
      { id: "t2", revoked_at: NOW },
      { id: "t3", revoked_at: null },
    ]);
    expect(grants).toEqual([{ grantId: "grant-t2", oauthUser: "adm_0123" }]);
    expect(
      audits.map((a) => [a.action, a.outcome, a.detail?.tokenId ?? null]),
    ).toEqual([
      ["token.revoke", "ok", "t1"],
      ["token.revoke", "ok", "t2"],
      ["session.logout", "ok", null],
    ]);
    // The cookie no longer authenticates.
    expect(
      await authenticate(withCookie(`${ADMIN}/`, s.sid), e.env, "admin", NOW),
    ).toEqual({
      refusal: true,
      code: "unauthenticated",
    });
  });

  it("charges the admin's escape bucket, never RL_PV_WRITE, after CSRF; over it 429, nothing revoked", async () => {
    const e = fakeEnv();
    const s = await session(e);
    const ok = { origin: ADMIN, "x-csrf-token": await csrfToken(e.env, s.sid) };
    // A failed CSRF check spends no write charge.
    await logout(e, s.sid, { origin: ADMIN });
    expect(e.limits.RL_PV_ADMIN_ESCAPE.keys).toEqual([]);
    e.limits.RL_PV_WRITE.allow = false;
    e.limits.RL_PV_ADMIN_ESCAPE.allow = false;
    expect((await logout(e, s.sid, ok)).status).toBe(429);
    expect(e.limits.RL_PV_ADMIN_ESCAPE.keys).toEqual([
      "admin-escape:me@example.com",
    ]);
    expect(e.limits.RL_PV_WRITE.keys).toEqual([]);
    expect(
      await db.prepare("SELECT revoked_at FROM sessions").first("revoked_at"),
    ).toBeNull();
    e.limits.RL_PV_ADMIN_ESCAPE.allow = true;
    expect((await logout(e, s.sid, ok)).status).toBe(204);
  });

  it("no session: 401; no CSRF token: 403; no Origin: 403; nothing revoked", async () => {
    const e = fakeEnv();
    const s = await session(e);
    expect((await logout(e, null, { origin: ADMIN })).status).toBe(401);
    expect((await logout(e, s.sid, { origin: ADMIN })).status).toBe(403);
    expect(
      (
        await logout(e, s.sid, {
          "x-csrf-token": await csrfToken(e.env, s.sid),
        })
      ).status,
    ).toBe(403);
    expect(
      await db.prepare("SELECT revoked_at FROM sessions").first("revoked_at"),
    ).toBeNull();
    expect(audits).toEqual([]);
  });
});

describe("app wiring", () => {
  it("an /api/v1 read with a session reaches invokeRoute as the admin (200, not 401)", async () => {
    const e = fakeEnv();
    const s = await session(e, { now: Date.now() });
    const res = await handle(
      withCookie(`${ADMIN}/api/v1/installs`, s.sid),
      e.env,
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(e.limits.RL_PV_READ.keys).toEqual(["admin:me@example.com"]);
  });

  it("an /api/v1 write needs Origin and x-csrf-token, then reaches invokeRoute", async () => {
    const e = fakeEnv();
    const s = await session(e, { now: Date.now() });
    const post = (h: Record<string, string>) =>
      handle(
        withCookie(`${ADMIN}/api/v1/installs`, s.sid, {
          method: "POST",
          headers: h,
        }),
        e.env,
        ctx(),
      );
    expect((await post({ origin: ADMIN })).status).toBe(403);
    expect(
      (
        await post({
          origin: ADMIN,
          "x-csrf-token": await csrfToken(e.env, s.sid),
        })
      ).status,
      // Past CSRF: invokeRoute's body step (no JSON content type) answers.
    ).toBe(415);
  });
});
