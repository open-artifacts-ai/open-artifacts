import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "../src/auth/authenticate.js";
import { STAGING_API_HOST } from "../src/auth/oidc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/session.js";
import { isRefusal } from "../src/principal.js";
import { mintAgentToken } from "../src/services/tokens.js";
import { requestId, seedAdmin } from "./admin.js";
import { platformDb } from "./db.js";
import { ADMIN, API, fakeEnv } from "./fakes.js";

const T = 1_800_000_000_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

const bearer = (token: string, path = "/v1/me", base = API) =>
  new Request(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
const unauth = expect.objectContaining({
  refusal: true,
  code: "unauthenticated",
});

async function minted() {
  const db = await platformDb();
  const a = await seedAdmin(db, T);
  const m = await mintAgentToken(a.env, a.principal, {
    kind: "oat",
    scopes: ["installs:read"],
    label: "ci",
    ttlMinutes: 15,
    requestId: requestId(),
  });
  return { ...a, db, m, token: m.token as string };
}

describe("authenticate: oat_ bearer (api host)", () => {
  it("a live token is its principal", async () => {
    const { env, m, token, session } = await minted();
    expect(await authenticate(bearer(token), env, "api")).toEqual({
      kind: "token",
      actorKey: `token:${m.tokenId}`,
      rateKey: `admin:${session.email}`,
      label: "ci",
      scopes: ["installs:read"],
      email: session.email,
      sub: session.sub,
      tokenId: m.tokenId,
      tokenKind: "oat",
      client: null,
      tokenExpiresAt: m.expiresAt,
      authAt: null,
    });
  });

  it("the auth scheme is case-insensitive (RFC 7235)", async () => {
    const { env, token } = await minted();
    for (const scheme of ["bearer", "BEARER", "bEaReR"]) {
      const r = new Request(`${API}/v1/me`, {
        headers: { authorization: `${scheme} ${token}` },
      });
      expect(await authenticate(r, env, "api")).toMatchObject({
        kind: "token",
      });
    }
  });

  it("checks D1 on every call: revoke, session end, expiry, identity removal", async () => {
    const a = await minted();
    expect(isRefusal(await authenticate(bearer(a.token), a.env, "api"))).toBe(
      false,
    );
    await a.db
      .prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1")
      .bind(a.m.tokenId, T)
      .run();
    expect(await authenticate(bearer(a.token), a.env, "api")).toEqual(unauth);

    const b = await minted();
    await b.db
      .prepare("UPDATE sessions SET revoked_at = ?2 WHERE id_hash = ?1")
      .bind(b.session.id_hash, T)
      .run();
    expect(await authenticate(bearer(b.token), b.env, "api")).toEqual(unauth);

    const c = await minted();
    vi.setSystemTime(c.m.expiresAt);
    expect(await authenticate(bearer(c.token), c.env, "api")).toEqual(unauth);
    vi.setSystemTime(T);

    const d = await minted();
    const env = { ...d.env, ADMIN_IDENTITIES: "other@example.com:9" };
    expect(await authenticate(bearer(d.token), env, "api")).toEqual(unauth);
  });

  it("an oat_ bearer works on /mcp too", async () => {
    const { env, token } = await minted();
    const p = await authenticate(bearer(token, "/mcp"), env, "api");
    expect(p).toMatchObject({ kind: "token" });
  });

  it("unknown, malformed or non-bearer credentials are unauthenticated", async () => {
    const { env, token } = await minted();
    const reqs = [
      new Request(`${API}/v1/me`),
      bearer(`oat_${"a".repeat(43)}`),
      bearer(`${token}x`),
      bearer(token.slice(0, -1)),
      bearer(""),
      new Request(`${API}/v1/me`, { headers: { authorization: token } }),
      new Request(`${API}/v1/me`, {
        headers: { authorization: `Basic ${token}` },
      }),
      new Request(`${API}/v1/me`, { headers: { cookie: "__Host-oa-admin=x" } }),
    ];
    for (const r of reqs)
      expect(await authenticate(r, env, "api")).toEqual(unauth);
  });

  it("an OAuth access token on /v1 is 401 (9A.3)", async () => {
    const { env } = fakeEnv();
    expect(await authenticate(bearer("u:g:s"), env, "api")).toEqual(unauth);
  });
});

describe("authenticate: OIDC JWT", () => {
  // These stop before any JWKS fetch (gh-oidc's verify is covered in
  // test/oidc.test.ts with a fake JWKS).
  const jwtish = "eyJhbGciOiJSUzI1NiJ9.eyJ9.c2ln";

  it("prod refuses a JWT", async () => {
    const { env } = fakeEnv({
      OA_ENV: "prod",
      OIDC_AUDIENCE: "x",
      OIDC_REPOSITORY: "x/y",
      OIDC_REPOSITORY_ID: "1",
      OIDC_JOB_WORKFLOW_REFS: "x",
      OIDC_ENVIRONMENT: "redline-staging",
    });
    const r = bearer(jwtish, "/v1/me", `https://${STAGING_API_HOST}`);
    expect(await authenticate(r, env, "api")).toEqual(unauth);
  });

  it("staging without the OIDC vars, or another host, refuses", async () => {
    const { env } = fakeEnv();
    expect(await authenticate(bearer(jwtish), env, "api")).toEqual(unauth);
    expect(
      await authenticate(
        bearer(jwtish, "/v1/me", `https://${STAGING_API_HOST}`),
        env,
        "api",
      ),
    ).toEqual(unauth);
  });
});

describe("authenticate: admin host (W5a session)", () => {
  it("an unknown session cookie refuses", async () => {
    await platformDb();
    const { env } = fakeEnv();
    const r = new Request(`${ADMIN}/api/v1/me`, {
      headers: { cookie: `${SESSION_COOKIE}=x` },
    });
    expect(await authenticate(r, env, "admin")).toEqual(unauth);
  });

  it("the real session principal mints, and its token authenticates on api", async () => {
    await platformDb();
    const { env } = fakeEnv();
    const s = await createSession(
      env,
      { email: "me@example.com", sub: "123", authAt: T },
      T,
    );
    const admin = await authenticate(
      new Request(`${ADMIN}/api/v1/me`, {
        headers: { cookie: `${SESSION_COOKIE}=${s.sid}` },
      }),
      env,
      "admin",
      T,
    );
    if (isRefusal(admin)) throw new Error("no admin principal");
    const m = await mintAgentToken(env, admin, {
      kind: "oat",
      scopes: ["installs:read"],
      label: "ci",
      ttlMinutes: 15,
      requestId: requestId(),
    });
    expect(await authenticate(bearer(m.token as string), env, "api")).toEqual(
      expect.objectContaining({
        kind: "token",
        tokenId: m.tokenId,
        rateKey: "admin:me@example.com",
      }),
    );
  });
});
