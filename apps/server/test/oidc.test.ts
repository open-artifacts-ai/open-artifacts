import { env } from "cloudflare:workers";
import {
  AUTH,
  AuthProvidersSchema,
  newId,
  PAGES,
  SIGN_IN_PAGE,
} from "@oa/shared";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.js";
import { accessIssuer, safeNext } from "../src/auth/oidc.js";
import { createPat } from "../src/auth/pat.js";
import { mw } from "../src/auth/route-policy.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { FAVICON_TAGS } from "../src/http/head.js";
import { type AppVariables, session } from "../src/http/middleware.js";
import { patchMember, SYSTEM_ACTOR } from "../src/services/members.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { login } from "./helpers.js";

const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);
const ISS = accessIssuer(env);
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

// ---------- fake Access OIDC issuer (served through a global fetch spy) ----------
let priv: CryptoKey;
let jwk: Record<string, unknown>;
type CodeEntry = { challenge: string; claims: JWTPayload; key?: CryptoKey };
const codes = new Map<string, CodeEntry>();
let tokenStatus = 200;
let tokenRaw: string | null = null;
let tokenResp: (() => Response) | null = null;
let tokenCalls: { body: URLSearchParams }[] = [];

const issuer = new Hono();
issuer.get("/jwks", (c) => c.json({ keys: [jwk] }));
issuer.post("/token", async (c) => {
  const body = new URLSearchParams(await c.req.text());
  tokenCalls.push({ body });
  if (tokenResp) return tokenResp();
  if (tokenStatus !== 200)
    return c.text("upstream-secret-detail", tokenStatus as 500);
  if (tokenRaw !== null)
    return new Response(tokenRaw, {
      headers: { "content-type": "application/json" },
    });
  const entry = codes.get(body.get("code") ?? "");
  if (!entry) return c.json({ error: "invalid_grant" }, 400);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body.get("code_verifier") ?? ""),
  );
  if (b64urlEncode(new Uint8Array(digest)) !== entry.challenge)
    return c.json({ error: "invalid_grant" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const id_token = await new SignJWT({
    iss: ISS,
    aud: env.ACCESS_CLIENT_ID,
    iat: now,
    exp: now + 300,
    sub: "sub-1",
    ...entry.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(entry.key ?? priv);
  return c.json({ id_token, access_token: "at", token_type: "Bearer" });
});

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
});

beforeEach(() => {
  tokenStatus = 200;
  tokenRaw = null;
  tokenResp = null;
  tokenCalls = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith(`${ISS}/`)) {
      const u = new URL(req.url);
      u.pathname = u.pathname.slice(new URL(ISS).pathname.length);
      return issuer.fetch(new Request(u, req));
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

// ---------- helpers ----------
const app = createApp();
const call = (path: string, init?: RequestInit, e: Env = env) =>
  app.fetch(new Request(`${APP}${path}`, init), e, ctx);

const setCookies = (r: Response) => r.headers.getSetCookie();
const OIDC_NAME = /^(__Host-)?oa_oidc_[A-Za-z0-9_-]{10}$/;
async function kOf(state: string) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state),
  );
  return b64urlEncode(new Uint8Array(d)).slice(0, 10);
}
const oidcSet = (r: Response) =>
  setCookies(r).find(
    (c) => OIDC_NAME.test(c.split("=")[0] ?? "") && !/Max-Age=0/.test(c),
  );
const clearedNames = (r: Response) =>
  setCookies(r)
    .filter((c) => /Max-Age=0/.test(c) && /^(__Host-)?oa_oidc/.test(c))
    .map((c) => c.split("=")[0]);
const cookieVal = (r: Response, name: string) => {
  const c = setCookies(r).find((s) => s.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(";")[0] : undefined;
};

/** Runs /auth/login, registers a code at the fake issuer, returns callback inputs. */
async function begin(
  claims: JWTPayload,
  next = "/a/xyz",
  e: Env = env,
  key?: CryptoKey,
  extra: { retry?: boolean; cookie?: string; via?: boolean } = {},
) {
  const r = await call(
    `/auth/login?next=${encodeURIComponent(next)}${extra.retry ? "&retry=1" : ""}${extra.via ? "&via=access" : ""}`,
    extra.cookie ? { headers: { cookie: extra.cookie } } : {},
    e,
  );
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location") ?? "");
  const set = oidcSet(r) ?? "";
  const cname = set.split("=")[0] ?? "";
  const oidc = set ? set.slice(cname.length + 1).split(";")[0] : undefined;
  const state = loc.searchParams.get("state") ?? "";
  const nonce = loc.searchParams.get("nonce") ?? "";
  const code = newId();
  codes.set(code, {
    challenge: loc.searchParams.get("code_challenge") ?? "",
    claims: { nonce, ...claims },
    key,
  });
  return { code, state, nonce, oidc, cname, loc, res: r };
}

/** Sends `oidc` under the per-attempt name derived from q.state (or `name`). */
const callback = async (
  q: { code: string; state: string },
  oidc: string | undefined,
  e: Env = env,
  name?: string,
  extraCookie?: string,
) => {
  const n =
    name ??
    `${e.ENVIRONMENT === "dev" ? "" : "__Host-"}oa_oidc_${await kOf(q.state)}`;
  const parts = [oidc === undefined ? undefined : `${n}=${oidc}`, extraCookie]
    .filter(Boolean)
    .join("; ");
  return call(
    `/auth/callback?code=${q.code}&state=${encodeURIComponent(q.state)}`,
    { headers: parts ? { cookie: parts } : {} },
    e,
  );
};

const later = async <T>(ms: number, f: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
  try {
    return await f();
  } finally {
    vi.useRealTimers();
  }
};

function expectRetry(r: Response, next = "/") {
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe(
    `/auth/login?next=${encodeURIComponent(next)}&retry=1`,
  );
  expect(cookieVal(r, SESSION)).toBeUndefined();
}

const userByEmail = (email: string) =>
  env.DB.prepare("select * from users where email = ?")
    .bind(email)
    .first<{ id: string; role: string; name: string }>();

async function expect401(r: Response) {
  expect(r.status).toBe(401);
  const text = await r.text();
  expect(JSON.parse(text).error.code).toBe("unauthorized");
  expect(text).not.toContain("upstream-secret-detail");
  expect(clearedNames(r).length).toBe(1);
  expect(cookieVal(r, SESSION)).toBeUndefined();
}

// ---------- tests ----------
describe("GET /auth/login", () => {
  it("redirects to the Access authorize endpoint with PKCE S256", async () => {
    const { loc, res } = await begin({});
    expect(loc.origin).toBe(`https://${env.ACCESS_TEAM_DOMAIN}`);
    expect(loc.pathname).toBe(
      `/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}/authorization`,
    );
    const p = loc.searchParams;
    expect(p.get("client_id")).toBe(env.ACCESS_CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(`${APP}/auth/callback`);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["openid", "email"]),
    );
    expect(p.get("state")?.length).toBeGreaterThanOrEqual(32);
    expect(p.get("nonce")?.length).toBeGreaterThanOrEqual(32);
    const c = oidcSet(res);
    expect(c).toMatch(/; HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\/auth(;|$)/);
    expect(c).toMatch(/Max-Age=900/);
    // dev env → no Secure; production → Secure
    expect(c).not.toMatch(/Secure/);
    const prod = await call(
      "/auth/login",
      {},
      { ...env, ENVIRONMENT: "production" },
    );
    expect(oidcSet(prod)).toMatch(/; Secure/);
    // verifier never leaks in the URL
    expect(loc.href).not.toContain("verifier");
  });

  it("never starts Access when access isn't an enabled provider", async () => {
    // No provider at all: 404.
    const none = await call("/auth/login", {}, { ...env, AUTH_PROVIDERS: "" });
    expect(none.status).toBe(404);
    expect(oidcSet(none)).toBeUndefined();
    for (const AUTH_PROVIDERS of ["email", "google,email"]) {
      const e = { ...env, AUTH_PROVIDERS };
      // Direct sign-in: the SPA chooser (P2 T6), no OIDC state.
      const r = await call("/auth/login", {}, e);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toMatch(/^\/sign-in\?next=/);
      expect(oidcSet(r)).toBeUndefined();
      // ?via=access without access is ignored: the chooser again.
      const via = await call("/auth/login?via=access", {}, e);
      expect(via.status).toBe(302);
      expect(via.headers.get("location")).toMatch(/^\/sign-in\?next=/);
      expect(oidcSet(via)).toBeUndefined();
    }
  });
});

describe("safeNext", () => {
  it("keeps same-origin paths only", () => {
    expect(safeNext(env, "/a/xyz?v=2#h")).toBe("/a/xyz?v=2#h");
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "evil.com",
      "",
      "/\t/evil.com",
      "javascript:alert(1)",
      undefined,
      "/..//evil.com",
      "/.//evil.com",
      "/a/..//evil.com",
      "/a/..\\/evil.com",
      "/%2e%2e//evil.com",
      "/a/../\\evil.com",
    ])
      expect(safeNext(env, bad)).toBe("/");
  });
  it("caps the serialized length", () => {
    expect(safeNext(env, `/${"é".repeat(2000)}`)).toBe("/");
    expect(safeNext(env, `/${"a".repeat(2000)}`)).toBe(`/${"a".repeat(2000)}`);
  });
  it("oa_oidc cookie stays under 4096 chars for long next", async () => {
    const r = await call(
      `/auth/login?next=${encodeURIComponent(`/${"é".repeat(2000)}`)}`,
    );
    const c = oidcSet(r) ?? "";
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThan(4096);
    const r2 = await call(
      `/auth/login?next=${encodeURIComponent(`/${"a".repeat(2040)}`)}`,
    );
    const c2 = oidcSet(r2) ?? "";
    expect(c2.length).toBeLessThan(4096);
  });
});

describe("GET /auth/callback", () => {
  it("valid code flow logs in OWNER_EMAIL as owner", async () => {
    const e = { ...env, OWNER_EMAIL: "Owner@X.com" };
    const b = await begin({ email: "owner@x.com", name: "Olive" }, "/a/xyz", e);
    const r = await callback(b, b.oidc, e);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/a/xyz");
    const sess = await readSession(env, cookieVal(r, SESSION));
    const row = await userByEmail("owner@x.com");
    expect(row?.role).toBe("owner");
    expect(row?.name).toBe("Olive");
    expect(sess?.uid).toBe(row?.id);
    expect(clearedNames(r)).toEqual([b.cname]);
    // token exchange carried PKCE verifier + client creds
    const body = tokenCalls[0]?.body;
    expect(body?.get("grant_type")).toBe("authorization_code");
    expect(body?.get("client_secret")).toBe(env.ACCESS_CLIENT_SECRET);
    expect(body?.get("redirect_uri")).toBe(`${APP}/auth/callback`);
  });

  it("promotes an existing member to owner", async () => {
    await login("promote@x.com", "member");
    const e = { ...env, OWNER_EMAIL: "promote@x.com" };
    const b = await begin({ email: "PROMOTE@x.com" }, "/", e);
    expect((await callback(b, b.oidc, e)).status).toBe(302);
    expect((await userByEmail("promote@x.com"))?.role).toBe("owner");
  });

  it("existing invited member keeps role, gets name updated", async () => {
    await login("mem@x.com", "admin");
    const b = await begin({ email: "Mem@X.com", name: "New Name" });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    const row = await userByEmail("mem@x.com");
    expect(row?.role).toBe("admin");
    expect(row?.name).toBe("New Name");
  });

  it("rejects wrong nonce", async () => {
    const b = await begin({ email: "n@x.com", nonce: "wrong" });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects wrong aud", async () => {
    const b = await begin({ email: "n@x.com", aud: "other-client" });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects wrong iss", async () => {
    const b = await begin({ email: "n@x.com", iss: "https://evil.example" });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects expired token (beyond 60s tolerance)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const b = await begin({ email: "n@x.com", exp: now - 120, iat: now - 600 });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects token signed by an unknown key", async () => {
    const other = await generateKeyPair("RS256");
    const b = await begin({ email: "n@x.com" }, "/", env, other.privateKey);
    await expect401(await callback(b, b.oidc));
  });
  it("rejects email_verified=false and missing email", async () => {
    const b1 = await begin({ email: "n@x.com", email_verified: false });
    await expect401(await callback(b1, b1.oidc));
    const b2 = await begin({});
    await expect401(await callback(b2, b2.oidc));
  });
  it("missing state cookie → retry", async () => {
    const b = await begin({ email: "n@x.com" });
    expectRetry(await callback(b, undefined));
  });
  it("rejects forged state cookie", async () => {
    const b = await begin({ email: "n@x.com" });
    const [p, sig] = (b.oidc ?? "").split(".");
    const payload = JSON.parse(
      atob((p ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    );
    const forged = b64urlEncode(
      new TextEncoder().encode(JSON.stringify({ ...payload, state: "x" })),
    );
    expectRetry(await callback({ ...b, state: "x" }, `${forged}.${sig}`));
  });
  it("state mismatch → retry", async () => {
    const b = await begin({ email: "n@x.com" });
    expectRetry(await callback({ ...b, state: `${b.state}x` }, b.oidc));
  });
  it("expired state cookie → retry with its next", async () => {
    const b = await begin({ email: "n@x.com" }, "/a/q");
    expectRetry(await later(16 * 60_000, () => callback(b, b.oidc)), "/a/q");
  });
  it("token endpoint error → 401 without upstream body", async () => {
    const b = await begin({ email: "n@x.com" });
    tokenStatus = 500;
    await expect401(await callback(b, b.oidc));
  });
  it("Access error param → 401", async () => {
    const b = await begin({ email: "n@x.com" });
    const r = await call(
      `/auth/callback?error=access_denied&state=${b.state}`,
      { headers: { cookie: `${b.cname}=${b.oidc}` } },
    );
    await expect401(r);
  });

  it("next=https://evil.com redirects to /", async () => {
    await login("evil@x.com");
    const b = await begin({ email: "evil@x.com" }, "https://evil.com");
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
  });

  it("unknown email with no shares → /no-access, no row", async () => {
    const b = await begin({ email: "nobody@x.com" });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/no-access");
    expect(cookieVal(r, SESSION)).toBeUndefined();
    expect(await userByEmail("nobody@x.com")).toBeNull();
  });

  it("unknown email with a share → guest row", async () => {
    const { userId } = await login("sharer@x.com");
    const aid = newId();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into artifacts (id, owner_id, space_id, title, format, created_at, updated_at) values (?, ?, ?, 't', 'html', ?, ?)",
      ).bind(aid, userId, userId, now, now),
      env.DB.prepare(
        "insert into shares (artifact_id, email, role, created_by, created_at) values (?, 'guest@x.com', 'viewer', ?, ?)",
      ).bind(aid, userId, now),
    ]);
    const b = await begin({ email: "Guest@X.com" });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/a/xyz");
    const row = await userByEmail("guest@x.com");
    expect(row?.role).toBe("guest");
    expect((await readSession(env, cookieVal(r, SESSION)))?.uid).toBe(row?.id);
  });
});

describe("email folding", () => {
  it("Kelvin-sign email is no-access, no row (no fold onto owner)", async () => {
    const e = { ...env, OWNER_EMAIL: "kim@x.com" };
    const b = await begin({ email: "\u212Aim@x.com" }, "/", e);
    const r = await callback(b, b.oidc, e);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/no-access");
    expect(cookieVal(r, SESSION)).toBeUndefined();
    expect(await userByEmail("kim@x.com")).toBeNull();
    const n = await env.DB.prepare(
      "select count(*) as n from users where email like '%im@x.com'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("id_token claims", () => {
  it("accepts a token without iat", async () => {
    const b = await begin({ email: "noiat@x.com", iat: undefined });
    await login("noiat@x.com");
    expect((await callback(b, b.oidc)).status).toBe(302);
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie with 204; GET is not allowed", async () => {
    const r = await call("/auth/logout", { method: "POST" });
    expect(r.status).toBe(204);
    const c = setCookies(r).find((s) => s.startsWith(`${SESSION}=`));
    expect(c).toBe(`${SESSION}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    const prod = await call(
      "/auth/logout",
      { method: "POST" },
      { ...env, ENVIRONMENT: "production" },
    );
    expect(setCookies(prod)).toContain(
      `${sessionCookieName({ ENVIRONMENT: "production" })}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    );
    expect((await call("/auth/logout")).status).toBe(404);
  });
});

describe("session middleware", () => {
  const probe = createApp(
    (a) => {
      const g = a as unknown as Hono<{
        Bindings: Env;
        Variables: AppVariables;
      }>;
      g.use("/probe", mw(session()));
      g.get("/probe", (c) =>
        c.json({ user: c.var.user, tokenLabel: c.var.tokenLabel }),
      );
    },
    { "GET /probe": { public: "test probe" } },
  );
  const get = async (headers: Record<string, string>) =>
    (await (
      await probe.fetch(new Request(`${APP}/probe`, { headers }), env, ctx)
    ).json()) as {
      user: { id: string; email: string; role: string } | null;
      tokenLabel: string | null;
    };

  it("cookie → user", async () => {
    const { cookie, userId } = await login("Sess@X.com", "admin");
    const r = await get({ cookie });
    expect(r.user).toMatchObject({
      id: userId,
      email: "sess@x.com",
      role: "admin",
    });
    expect(r.tokenLabel).toBeNull();
  });
  it("bearer PAT → user + tokenLabel", async () => {
    const { userId } = await login("pat-sess@x.com");
    const { token } = await createPat(env, userId, "my-agent");
    const r = await get({ authorization: `Bearer ${token}` });
    expect(r.user?.id).toBe(userId);
    expect(r.tokenLabel).toBe("my-agent");
  });
  it("bearer wins over cookie (invalid bearer → null, no fallback)", async () => {
    const { cookie } = await login("both@x.com");
    const r = await get({ cookie, authorization: "Bearer oa_pat_nope" });
    expect(r.user).toBeNull();
  });
  it("non-Bearer Authorization falls through to the cookie", async () => {
    const { cookie, userId } = await login("basic@x.com");
    const r = await get({ cookie, authorization: "Basic dXNlcjpwYXNz" });
    expect(r.user?.id).toBe(userId);
  });
  it("non-PAT Bearer shadows the cookie (null)", async () => {
    const { cookie } = await login("jwtb@x.com");
    expect(
      (await get({ cookie, authorization: "Bearer eyJhbGciOi.x.y" })).user,
    ).toBeNull();
  });
  it("no/garbage cookie → null; deleted user → null", async () => {
    expect((await get({})).user).toBeNull();
    expect((await get({ cookie: `${SESSION}=garbage` })).user).toBeNull();
    const { cookie, userId } = await login("gone@x.com");
    await env.DB.prepare("delete from users where id = ?").bind(userId).run();
    expect((await get({ cookie })).user).toBeNull();
  });
});

describe("callback failure logging", () => {
  type Log = { evt: string; stage: string; [k: string]: unknown };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  const logs = (): Log[] =>
    warn.mock.calls.map((a: unknown[]) => JSON.parse(String(a[0])) as Log);
  const raw = () =>
    warn.mock.calls.map((a: unknown[]) => a.join(" ")).join("\n");

  const EMAIL = "secret-person@leak.example";
  async function run(
    expectStage: string,
    setup: (
      b: Awaited<ReturnType<typeof begin>>,
    ) => Promise<Response> | Response,
    claims: JWTPayload = { email: EMAIL },
  ) {
    const b = await begin(claims);
    warn.mockClear();
    const r = await setup(b);
    const l = logs().filter((x) => x.evt === "oidc_fail");
    expect(l.map((x) => x.stage)).toEqual([expectStage]);
    const text = raw();
    for (const secret of [
      EMAIL,
      "leak.example",
      b.code,
      b.state,
      b.nonce,
      b.oidc ?? "",
      env.ACCESS_CLIENT_SECRET,
      env.SESSION_SECRET,
      "upstream-secret-detail",
      "eyJ",
    ])
      expect(text).not.toContain(secret);
    return { r, l: l[0] as Log };
  }

  it("no_state_cookie", async () => {
    await run("no_state_cookie", (b) => callback(b, undefined));
  });
  it("state_bad_sig", async () => {
    await run("state_bad_sig", (b) => callback(b, `${b.oidc}x`));
  });
  it("state_expired", async () => {
    await run("state_expired", async (b) => {
      return later(16 * 60_000, () => callback(b, b.oidc));
    });
  });
  it("state_mismatch", async () => {
    await run("state_mismatch", (b) =>
      callback({ ...b, state: `${b.state}x` }, b.oidc),
    );
  });
  it("idp_error with sanitized error", async () => {
    const { l } = await run("idp_error", (b) =>
      call(
        `/auth/callback?error=${encodeURIComponent("Access_Denied<script>")}&state=${encodeURIComponent(b.state)}`,
        { headers: { cookie: `${b.cname}=${b.oidc}` } },
      ),
    );
    expect(l.error).toMatch(/^access_denied[a-z_]{0,51}$/);
  });
  it("token_http_<status>", async () => {
    tokenStatus = 502;
    const { r } = await run("token_http_502", (b) => callback(b, b.oidc));
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("upstream");
  });
  it("token 302 (Access error redirect) logs error + description", async () => {
    tokenResp = () =>
      new Response(null, {
        status: 302,
        headers: {
          location: `${APP}/auth/callback?error=invalid_client&error_description=${encodeURIComponent(`Client auth failed\u0000\n${"x".repeat(300)}`)}`,
        },
      });
    const { l, r } = await run("token_http_302", (b) => callback(b, b.oidc));
    expect(r.status).toBe(401);
    expect(l.error).toBe("invalid_client");
    // Capped at 200 chars, then redacted: the x-run reads as a token.
    expect(l.description).toBe("Client auth <token>");
    expect(await r.text()).not.toContain("invalid_client");
  });
  it("token 4xx JSON body logs error + description", async () => {
    tokenResp = () =>
      Response.json(
        { error: "invalid_grant", error_description: "Code expired" },
        { status: 400 },
      );
    const { l } = await run("token_http_400", (b) => callback(b, b.oidc));
    expect(l.error).toBe("invalid_grant");
    expect(l.description).toBe("Code expired");
  });
  it("token_bad_json", async () => {
    tokenRaw = "not json";
    await run("token_bad_json", (b) => callback(b, b.oidc));
  });
  it("no_id_token", async () => {
    tokenRaw = JSON.stringify({ access_token: "at" });
    await run("no_id_token", (b) => callback(b, b.oidc));
  });
  it("jwt_verify with code and claim", async () => {
    const { l } = await run("jwt_verify", (b) => callback(b, b.oidc), {
      email: EMAIL,
      aud: "other-client",
    });
    expect(l.code).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED");
    expect(l.claim).toBe("aud");
    const { l: l2 } = await run("jwt_verify", (b) => callback(b, b.oidc), {
      email: EMAIL,
      exp: Math.floor(Date.now() / 1000) - 600,
    });
    expect(l2.code).toBe("ERR_JWT_EXPIRED");
    expect(l2.claim).toBe("exp");
  });
  it("aud (multi-audience)", async () => {
    await run("aud", (b) => callback(b, b.oidc), {
      email: EMAIL,
      aud: [env.ACCESS_CLIENT_ID, "other"],
    });
  });
  it("nonce", async () => {
    await run("nonce", (b) => callback(b, b.oidc), {
      email: EMAIL,
      nonce: "wrong",
    });
  });
  it("email", async () => {
    await run("email", (b) => callback(b, b.oidc), {});
  });
  it("email_unverified", async () => {
    await run("email_unverified", (b) => callback(b, b.oidc), {
      email: EMAIL,
      email_verified: false,
    });
  });
  it("no_access", async () => {
    const { r } = await run("no_access", (b) => callback(b, b.oidc));
    expect(r.headers.get("location")).toBe("/no-access");
  });
});

describe("resilient OIDC state", () => {
  const decode = (v: string) =>
    JSON.parse(
      atob((v.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp: number; retry?: boolean; next: string };

  it("TTL is 900s (signed exp and Max-Age); still valid at 14 min", async () => {
    const t0 = Date.now();
    const b = await begin({ email: "ttl@x.com" });
    expect(oidcSet(b.res)).toMatch(/Max-Age=900(;|$)/);
    const exp = decode(b.oidc ?? "").exp;
    expect(exp).toBeGreaterThanOrEqual(t0 + 900_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 900_000);
    await login("ttl@x.com");
    const r = await later(14 * 60_000, () => callback(b, b.oidc));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/a/xyz");
    expect(cookieVal(r, SESSION)).toBeDefined();
  });

  it("cookie name is oa_oidc_<first 10 b64url of sha256(state)>", async () => {
    const b = await begin({});
    expect(b.cname).toBe(`oa_oidc_${await kOf(b.state)}`);
  });

  it("older tab completes after a newer one starts; only its cookie is cleared", async () => {
    await login("tabs@x.com");
    const a = await begin({ email: "tabs@x.com" }, "/a/old");
    const n = await begin({ email: "tabs@x.com" }, "/a/new", env, undefined, {
      cookie: `${a.cname}=${a.oidc}`,
    });
    expect(clearedNames(n.res)).toEqual([]);
    const both = `${a.cname}=${a.oidc}; ${n.cname}=${n.oidc}`;
    const r = await call(
      `/auth/callback?code=${a.code}&state=${encodeURIComponent(a.state)}`,
      { headers: { cookie: both } },
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/a/old");
    expect(clearedNames(r)).toEqual([a.cname]);
    const r2 = await call(
      `/auth/callback?code=${n.code}&state=${encodeURIComponent(n.state)}`,
      { headers: { cookie: `${n.cname}=${n.oidc}` } },
    );
    expect(r2.headers.get("location")).toBe("/a/new");
    expect(clearedNames(r2)).toEqual([n.cname]);
  });

  it("4 attempts evict the oldest, keeping at most 3", async () => {
    const jar: string[] = [];
    const names: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      const b = await later(i * 1000, () =>
        begin({}, "/", env, undefined, { cookie: jar.join("; ") || undefined }),
      );
      expect(clearedNames(b.res)).toEqual([]);
      jar.push(`${b.cname}=${b.oidc}`);
      names.push(b.cname);
    }
    // send them newest-first so eviction must use exp, not header order
    const b4 = await later(Date.now() - t0 + 5000, () =>
      begin({}, "/", env, undefined, { cookie: [...jar].reverse().join("; ") }),
    );
    expect(clearedNames(b4.res)).toEqual([names[0]]);
    expect(oidcSet(b4.res)).toBeDefined();
  });

  it("unparseable oa_oidc_* cookies are evicted first", async () => {
    const a = await begin({});
    const b = await begin({}, "/", env, undefined, {
      cookie: `${a.cname}=${a.oidc}`,
    });
    const junk = "oa_oidc_AAAAAAAAAA=garbage";
    const r = await begin({}, "/", env, undefined, {
      cookie: `${a.cname}=${a.oidc}; ${junk}; ${b.cname}=${b.oidc}`,
    });
    expect(clearedNames(r.res)).toEqual(["oa_oidc_AAAAAAAAAA"]);
  });

  it("expired state → retry once, then the static page", async () => {
    const b = await begin({ email: "slow@x.com" }, "/a/q");
    const r1 = await later(16 * 60_000, () => callback(b, b.oidc));
    expectRetry(r1, "/a/q");
    expect(clearedNames(r1)).toEqual([b.cname]);
    // follow the retry login
    const b2 = await begin({ email: "slow@x.com" }, "/a/q", env, undefined, {
      retry: true,
    });
    expect(decode(b2.oidc ?? "").retry).toBe(true);
    const r2 = await later(16 * 60_000, () => callback(b2, b2.oidc));
    expect(r2.status).toBe(400);
    expect(r2.headers.get("content-type")).toMatch(/^text\/html/);
    expect(r2.headers.get("content-security-policy")).toMatch(
      /default-src 'none'/,
    );
    expect(r2.headers.get("x-frame-options")).toBe("DENY");
    expect(r2.headers.get("location")).toBeNull();
    const html = await r2.text();
    expect(html).toContain(
      "Sign-in took too long or was opened in another tab. Try again.",
    );
    expect(html).toContain('href="/auth/login?next=%2Fa%2Fq"');
    expect(html).toContain(`${FAVICON_TAGS}\n</head>`);
    expect(r2.headers.get("content-security-policy")).toContain(
      "img-src 'self'",
    );
    expect(clearedNames(r2)).toEqual([b2.cname]);
  });

  it("mismatch goes to retry, and on a retry attempt to the page", async () => {
    const b = await begin({ email: "m@x.com" });
    expectRetry(await callback({ ...b, state: `${b.state}x` }, b.oidc));
    const b2 = await begin({}, "/", env, undefined, { retry: true });
    const r = await callback({ ...b2, state: `${b2.state}x` }, b2.oidc);
    expect(r.status).toBe(400);
  });

  it("retry loop can't happen even when no state cookie comes back", async () => {
    const b = await begin({}, "/a/z", env, undefined, { retry: true });
    const r = await callback(b, undefined);
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    // bad signature on a retry attempt → page too
    const b2 = await begin({}, "/", env, undefined, { retry: true });
    expect((await callback(b2, `${b2.oidc}x`)).status).toBe(400);
  });

  it("the page escapes next and contains no other user input", async () => {
    const next = `/a?x='"><img src=x onerror=alert(1)>`;
    const b = await begin({}, next, env, undefined, { retry: true });
    const r = await later(16 * 60_000, () => callback(b, b.oidc));
    const html = await r.text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain(b.state);
    expect(html).not.toMatch(/onerror=alert/i);
  });

  it("legacy oa_oidc cookie is no longer accepted", async () => {
    await login("legacy@x.com");
    const b = await begin({ email: "legacy@x.com" }, "/a/l");
    const r = await call(
      `/auth/callback?code=${b.code}&state=${encodeURIComponent(b.state)}`,
      { headers: { cookie: `oa_oidc=${b.oidc}` } },
    );
    expectRetry(r, "/");
  });

  it("token/JWT failures keep the generic 401", async () => {
    const b = await begin({ email: "n@x.com", nonce: "wrong" });
    await expect401(await callback(b, b.oidc));
  });
});

describe("state cookie hardening (size cap, cookie tossing)", () => {
  const prod = { ...env, ENVIRONMENT: "production" as const };
  it("backslash-heavy next: final Set-Cookie stays ≤3800 chars (falls back to next=/)", async () => {
    const next = `/?${"\\".repeat(2000)}`;
    expect(safeNext(env, next).length).toBeLessThanOrEqual(2048);
    const r = await call(`/auth/login?next=${encodeURIComponent(next)}`);
    const c = oidcSet(r) ?? "";
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThan(4096);
    expect(c.length).toBeLessThanOrEqual(3800);
  });
  it("prod: a tossed un-prefixed state cookie is ignored (no login CSRF)", async () => {
    const e = { ...prod, OWNER_EMAIL: "attacker@x.com" };
    const atk = await begin({ email: "attacker@x.com" }, "/", e);
    // victim's browser: a sibling host can only plant the un-prefixed name
    const r = await callback(
      atk,
      atk.oidc,
      e,
      `oa_oidc_${await kOf(atk.state)}`,
    );
    expect(cookieVal(r, sessionCookieName(e))).toBeUndefined();
  });
  it("legacy oa_oidc state cookie is never read (dev and prod)", async () => {
    for (const e of [
      { ...env, OWNER_EMAIL: "attacker@x.com" },
      { ...prod, OWNER_EMAIL: "attacker@x.com" },
    ]) {
      const atk = await begin({ email: "attacker@x.com" }, "/", e);
      const r = await callback(atk, atk.oidc, e, "oa_oidc");
      expect(cookieVal(r, sessionCookieName(e))).toBeUndefined();
    }
  });
  it("prod: issued state cookie is __Host- prefixed, Secure, Path=/, no Domain", async () => {
    const r = await call("/auth/login?next=/", {}, prod);
    const c = oidcSet(r) ?? "";
    expect(c).toMatch(/^__Host-oa_oidc_[A-Za-z0-9_-]{10}=/);
    expect(c).toMatch(/; Secure/);
    expect(c).toMatch(/; Path=\/(;|$)/);
    expect(c).not.toMatch(/Domain=/i);
  });
  it("prod: full flow with __Host- cookie works and clears it with the same attributes", async () => {
    await login("hostp@x.com");
    const b = await begin({ email: "hostp@x.com" }, "/a/h", prod);
    expect(b.cname).toBe(`__Host-oa_oidc_${await kOf(b.state)}`);
    const r = await callback(b, b.oidc, prod);
    expect(r.headers.get("location")).toBe("/a/h");
    const sess = setCookies(r).find((c) =>
      c.startsWith(`${sessionCookieName(prod)}=`),
    );
    expect(sess).toMatch(
      /^__Host-[^=]+=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800$/,
    );
    expect(sess).not.toMatch(/domain=/i);
    expect(cookieVal(r, SESSION)).toBeUndefined();
    const cleared = setCookies(r).find((c) => c.startsWith(`${b.cname}=;`));
    expect(cleared).toBe(
      `${b.cname}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    );
  });
  it("dev: plain oa_oidc_<k> name with Path=/auth", async () => {
    const r = await call("/auth/login?next=/");
    const c = oidcSet(r) ?? "";
    expect(c).toMatch(/^oa_oidc_[A-Za-z0-9_-]{10}=/);
    expect(c).toMatch(/; Path=\/auth(;|$)/);
  });
});

describe("session epoch on the Access callback (#369)", () => {
  const epochOf = (email: string) =>
    env.DB.prepare("select id, session_epoch e from users where email = ?")
      .bind(email)
      .first<{ id: string; e: number }>();
  const sessOf = (r: Response) => readSession(env, cookieVal(r, SESSION));

  it("a reactivated guest gets a live session at the new epoch", async () => {
    const email = `rein-${newId().slice(0, 6)}@x.com`;
    await login(email, "guest");
    // The last share going deactivates (status removed, epoch + 1); a new
    // share reactivates. Sign-in must use the bumped epoch, not 0.
    await env.DB.prepare(
      "update users set status = 'removed', session_epoch = session_epoch + 1 where email = ?",
    )
      .bind(email)
      .run();
    await env.DB.prepare("update users set status = 'active' where email = ?")
      .bind(email)
      .run();
    const b = await begin({ email });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    const row = await epochOf(email);
    const s = await sessOf(r);
    expect(s?.uid).toBe(row?.id);
    expect(s?.e).toBe(row?.e);
  });

  it("a role change (epoch bump) does not lock the user out", async () => {
    const email = `role-${newId().slice(0, 6)}@x.com`;
    const { userId } = await login(email, "member");
    const first = await begin({ email });
    expect((await callback(first, first.oidc)).status).toBe(302);
    const before = (await epochOf(email))?.e ?? 0;
    await patchMember(env, userId, { role: "admin" }, SYSTEM_ACTOR);
    const bumped = (await epochOf(email))?.e ?? 0;
    // The role change must have bumped the epoch, or this test proves nothing.
    expect(bumped).toBeGreaterThan(before);
    const second = await begin({ email });
    const r = await callback(second, second.oidc);
    expect(r.status).toBe(302);
    expect((await sessOf(r))?.e).toBe(bumped);
  });

  it("a non-active user lands on noAccess with no session", async () => {
    const email = `sus-${newId().slice(0, 6)}@x.com`;
    const { userId } = await login(email, "member");
    await env.DB.prepare("update users set status = 'suspended' where id = ?")
      .bind(userId)
      .run();
    const b = await begin({ email });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(PAGES.noAccess);
    expect(cookieVal(r, SESSION)).toBeUndefined();
  });
});

// Review item 12: in direct mode (access plus google or email) an Access
// refusal lands on the SPA sign-in page with the reason and `next`, like
// every other direct-mode refusal; Access-only keeps /no-access (above).
describe("Access refusals in direct mode", () => {
  const direct = { ...env, AUTH_PROVIDERS: "access,email" } as Env;
  const want = (next: string) =>
    `${SIGN_IN_PAGE}?error=no_access&next=${encodeURIComponent(next)}`;

  it("the providers list carries access with its start URL (the SPA's button)", async () => {
    const r = await call(AUTH.providers, {}, direct);
    const p = AuthProvidersSchema.parse(await r.json());
    expect(p.mode).toBe("direct");
    expect(p.providers).toContainEqual({
      id: "access",
      start: `${AUTH.login}?via=access`,
    });
    // That start URL goes to Access, not back to the chooser.
    const go = await call(`${AUTH.login}?via=access&next=%2Fa%2Fz`, {}, direct);
    expect(new URL(go.headers.get("location") ?? "").hostname).toBe(
      env.ACCESS_TEAM_DOMAIN,
    );
  });

  it("unknown email: sign-in page with error and next, no session, no row", async () => {
    const email = `dn-${newId().slice(0, 6)}@x.com`;
    const b = await begin({ email }, "/a/keep", direct, undefined, {
      via: true,
    });
    const r = await callback(b, b.oidc, direct);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(want("/a/keep"));
    expect(cookieVal(r, SESSION)).toBeUndefined();
    expect(await userByEmail(email)).toBeNull();
    // The state cookie is still cleared.
    expect(setCookies(r).some((c) => c.startsWith(b.cname))).toBe(true);
  });

  it("a suspended member: sign-in page with error and next, no session", async () => {
    const email = `ds-${newId().slice(0, 6)}@x.com`;
    const { userId } = await login(email, "member");
    await env.DB.prepare("update users set status = 'suspended' where id = ?")
      .bind(userId)
      .run();
    const b = await begin({ email }, "/a/s", direct, undefined, { via: true });
    const r = await callback(b, b.oidc, direct);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(want("/a/s"));
    expect(cookieVal(r, SESSION)).toBeUndefined();
  });
});
