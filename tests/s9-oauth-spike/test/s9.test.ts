import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker, {
  ACCESS_TTL_S,
  ADMIN,
  API,
  authServer,
  type Env,
  grantIds,
  oauthUserId,
  REFRESH_CAP_S,
  RESOURCE,
  refreshTtlFor,
  SCOPES,
  sessions,
} from "../src/index.js";

// Spike S9 (design v7, 13.1 and 9A.3.1): workers-oauth-provider 1.2.3's
// OAuthAuthorizationServer with the issuer on the api host and the
// authorization endpoint on the admin host, driven end to end in workerd.

const e = env as unknown as Env;
const REDIRECT = "http://127.0.0.1:33418/callback";
const EMAIL = "admin@example.com";
const HOUR = 3600_000;

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

async function register(): Promise<string> {
  const res = await call(
    new Request(`${API}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Spike agent",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function newSession(msLeft: number): string {
  const sid = crypto.randomUUID();
  sessions.set(sid, { email: EMAIL, expiresAt: Date.now() + msLeft });
  return sid;
}

const cookieOf = (setCookie: string[]) =>
  setCookie.map((c) => c.split(";")[0]).join("; ");

function authorizeUrl(clientId: string, challenge: string) {
  const u = new URL(`${ADMIN}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("scope", "installs:read audit:read installs:delete");
  u.searchParams.set("state", "st-1");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", RESOURCE);
  return u;
}

type Consent = {
  handle: string;
  clientName: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scope: string[];
};

/** GET the consent page on the admin host, then POST a decision. */
async function consent(
  clientId: string,
  sid: string,
  challenge: string,
  decision: "approve" | "deny",
  scope: string[] = ["installs:read", "audit:read"],
) {
  const get = await call(
    new Request(authorizeUrl(clientId, challenge), {
      headers: { cookie: `__Host-oa-admin=${sid}` },
    }),
  );
  expect(get.status).toBe(200);
  const page = (await get.json()) as Consent;
  const binding = cookieOf(get.headers.getSetCookie());
  const form = new URLSearchParams({ request: page.handle, decision });
  for (const s of scope) form.append("scope", s);
  const post = await call(
    new Request(`${ADMIN}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie: `__Host-oa-admin=${sid}; ${binding}`,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: form,
    }),
  );
  return { page, post };
}

type Tokens = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

async function token(body: Record<string, string>) {
  return call(
    new Request(`${API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
  );
}

/** Register, consent with Allow, exchange the code: a live grant. */
async function grant(sessionMsLeft: number) {
  const clientId = await register();
  const sid = newSession(sessionMsLeft);
  const { verifier, challenge } = await pkce();
  const { post } = await consent(clientId, sid, challenge, "approve");
  expect(post.status).toBe(302);
  const loc = new URL(post.headers.get("location") ?? "");
  const code = loc.searchParams.get("code") ?? "";
  const res = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as Tokens;
  return { clientId, sid, tokens, loc };
}

/** The grant's expiresAt (s), from listUserGrants (KV is shared across tests). */
async function grantExpiry(tokens: Tokens): Promise<number> {
  const [userId, grantId] = tokens.access_token.split(":");
  const { items } = await authServer
    .getOAuthApi(e)
    .listUserGrants(userId ?? "");
  const g = items.find((i) => i.id === grantId);
  expect(g).toBeDefined();
  return g?.expiresAt ?? 0;
}

beforeEach(() => {
  sessions.clear();
  grantIds.clear();
});

describe("S9: metadata", () => {
  it("RFC 8414 on the api host: issuer api, authorize on admin, token and register on api", async () => {
    const res = await call(
      new Request(`${API}/.well-known/oauth-authorization-server`),
    );
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.issuer).toBe(API);
    expect(m.authorization_endpoint).toBe(`${ADMIN}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${API}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${API}/oauth/register`);
    expect(m.revocation_endpoint).toBe(`${API}/oauth/token`);
    expect(m.scopes_supported).toEqual([...SCOPES]);
    expect(m.code_challenge_methods_supported).toContain("S256");
  });

  it("RFC 9728 protected-resource metadata on the api host names the api issuer", async () => {
    const res = await call(
      new Request(`${API}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [API],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
    });
  });
});

describe("S9: adm_ userId", () => {
  it("is adm_ + 32 hex, stable per email, distinct across emails, with no ':' or email", async () => {
    const a = await oauthUserId(e.ADMIN_SESSION_KEY, EMAIL);
    expect(a).toMatch(/^adm_[0-9a-f]{32}$/);
    expect(await oauthUserId(e.ADMIN_SESSION_KEY, EMAIL)).toBe(a);
    expect(
      await oauthUserId(e.ADMIN_SESSION_KEY, "other@example.com"),
    ).not.toBe(a);
    expect(a).not.toContain(":");
    expect(a).not.toContain("admin");
  });
});

describe("S9: refreshTtlFor (Q3)", () => {
  it("is the session's seconds left, capped at 8 h", () => {
    const now = 1_000_000_000_000;
    expect(refreshTtlFor(now + 2 * HOUR, now)).toBe(7200);
    expect(refreshTtlFor(now + 10 * HOUR, now)).toBe(REFRESH_CAP_S);
    expect(refreshTtlFor(now + 2 * HOUR + 999, now)).toBe(7200);
  });
});

describe("S9: parseAuthRequest and consent on the admin origin", () => {
  it("parses on the admin host and describes the consent", async () => {
    const clientId = await register();
    const sid = newSession(2 * HOUR);
    const { challenge } = await pkce();
    const res = await call(
      new Request(authorizeUrl(clientId, challenge), {
        headers: { cookie: `__Host-oa-admin=${sid}` },
      }),
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as Consent;
    expect(page.handle).toBeTruthy();
    expect(page.clientName).toBe("Spike agent");
    expect(page.redirectHost).toBe("127.0.0.1");
    expect(page.redirectIsLoopback).toBe(true);
    expect(page.scope).toEqual([
      "installs:read",
      "audit:read",
      "installs:delete",
    ]);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/__Host-oauth-/);
  });

  it("parseAuthRequest refuses the same request on the issuer (api) origin", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const onApi = new URL(authorizeUrl(clientId, challenge));
    onApi.host = new URL(API).host;
    await expect(
      authServer.getOAuthApi(e).parseAuthRequest(new Request(onApi)),
    ).rejects.toThrow(/unconfigured endpoint/);
  });

  it("Deny redirects to the client with access_denied, state and iss", async () => {
    const clientId = await register();
    const sid = newSession(2 * HOUR);
    const { challenge } = await pkce();
    const { post } = await consent(clientId, sid, challenge, "deny");
    expect(post.status).toBe(302);
    const loc = new URL(post.headers.get("location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(loc.searchParams.get("iss")).toBe(API);
  });

  it("approveConsent refuses a reused handle", async () => {
    const clientId = await register();
    const sid = newSession(2 * HOUR);
    const { challenge } = await pkce();
    const get = await call(
      new Request(authorizeUrl(clientId, challenge), {
        headers: { cookie: `__Host-oa-admin=${sid}` },
      }),
    );
    const page = (await get.json()) as Consent;
    const binding = cookieOf(get.headers.getSetCookie());
    const post = () =>
      call(
        new Request(`${ADMIN}/oauth/authorize`, {
          method: "POST",
          headers: {
            cookie: `__Host-oa-admin=${sid}; ${binding}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            request: page.handle,
            decision: "approve",
            scope: "installs:read",
          }),
        }),
      );
    expect((await post()).status).toBe(302);
    expect((await post()).status).toBe(400);
  });
});

describe("S9: completeAuthorization, code exchange, tokens", () => {
  it("Allow issues a code with state and iss = api; tokens carry the adm_ userId", async () => {
    const { tokens, loc } = await grant(2 * HOUR);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(loc.searchParams.get("iss")).toBe(API);
    const userId = await oauthUserId(e.ADMIN_SESSION_KEY, EMAIL);
    expect(tokens.access_token.startsWith(`${userId}:`)).toBe(true);
    expect(tokens.refresh_token?.startsWith(`${userId}:`)).toBe(true);
    expect(tokens.expires_in).toBe(ACCESS_TTL_S);
    // The admin's pick, not the client's ask (installs:delete dropped).
    expect(tokens.scope.split(" ").sort()).toEqual([
      "audit:read",
      "installs:read",
    ]);
  });

  it("tokenExchangeCallback learns the grantId at code exchange", async () => {
    const { tokens } = await grant(2 * HOUR);
    const grantId = tokens.access_token.split(":")[1];
    expect([...grantIds.values()]).toEqual([grantId]);
  });

  it("validateToken accepts the access token for the mcp resource, with props", async () => {
    const { tokens } = await grant(2 * HOUR);
    const v = await authServer.validateToken<{ tokenId: string }>(
      RESOURCE,
      tokens.access_token,
      e,
    );
    expect(v?.audience).toBe(RESOURCE);
    expect(v?.userId).toBe(await oauthUserId(e.ADMIN_SESSION_KEY, EMAIL));
    expect(grantIds.has(v?.props.tokenId ?? "")).toBe(true);
    const mcp = await call(
      new Request(`${API}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(mcp.status).toBe(200);
  });
});

describe("S9: per-grant refreshTokenTTL (Q3)", () => {
  it("a session with 2 h left gives a grant that ends with the session", async () => {
    const { sid, tokens } = await grant(2 * HOUR);
    const end = Math.floor((sessions.get(sid)?.expiresAt ?? 0) / 1000);
    expect(Math.abs((await grantExpiry(tokens)) - end)).toBeLessThanOrEqual(1);
  });

  it("a session with 10 h left is capped at 8 h", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { tokens } = await grant(10 * HOUR);
    const after = Math.floor(Date.now() / 1000);
    const exp = await grantExpiry(tokens);
    expect(exp).toBeGreaterThanOrEqual(before + REFRESH_CAP_S);
    expect(exp).toBeLessThanOrEqual(after + REFRESH_CAP_S);
  });

  it("refresh works while the session lives", async () => {
    const { clientId, tokens } = await grant(2 * HOUR);
    const res = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    const next = (await res.json()) as Tokens;
    expect(next.access_token).not.toBe(tokens.access_token);
  });

  it("refresh after the session is revoked is invalid_grant and the grant is gone", async () => {
    const { clientId, sid, tokens } = await grant(2 * HOUR);
    sessions.delete(sid);
    const res = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    expect(
      await authServer.validateToken(RESOURCE, tokens.access_token, e),
    ).toBeNull();
  });
});

describe("S9: revokeGrant", () => {
  it("ends the access token and the refresh chain", async () => {
    const { clientId, tokens } = await grant(2 * HOUR);
    const [userId, grantId] = tokens.access_token.split(":");
    await authServer.getOAuthApi(e).revokeGrant(grantId ?? "", userId ?? "");
    expect(
      await authServer.validateToken(RESOURCE, tokens.access_token, e),
    ).toBeNull();
    const res = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    const mcp = await call(
      new Request(`${API}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(mcp.status).toBe(401);
  });
});

describe("S9: host split", () => {
  it("the admin host serves no token endpoint; the api host serves no consent", async () => {
    expect(
      (await call(new Request(`${ADMIN}/oauth/token`, { method: "POST" })))
        .status,
    ).toBe(404);
    const clientId = await register();
    const { challenge } = await pkce();
    const onApi = new URL(authorizeUrl(clientId, challenge));
    onApi.host = new URL(API).host;
    expect((await call(new Request(onApi))).status).toBe(404);
  });

  it("no admin session: 302 to /auth/start with the authorize return", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const res = await call(new Request(authorizeUrl(clientId, challenge)));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /^\/auth\/start\?return=%2Foauth%2Fauthorize%3F/,
    );
  });
});
