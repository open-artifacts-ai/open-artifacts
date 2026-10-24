import { env } from "cloudflare:workers";
import { newId, type OAuthClient, OAuthClientSchema, R } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import designConsent from "../../../design/screens/oauth-consent.html?raw";
import { createApp } from "../src/app.js";
import { createPat, verifyPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { FAVICON_TAGS } from "../src/http/head.js";
import { CONSENT_TEMPLATE } from "../src/mcp/consent-template.js";
import { clientNameOf, oauthApi, oauthProvider } from "../src/mcp/oauth.js";
import * as oauthApiModule from "../src/mcp/oauth-api.js";
import { oauthApi as helpers } from "../src/mcp/oauth-api.js";
import {
  MAX_REGISTRATIONS_PER_DAY,
  sweepUngrantedClients,
} from "../src/mcp/registrations.js";
import { stripTemplateComment } from "../src/mcp/template.js";
import {
  patchMember,
  removeMember,
  setUserStatus,
} from "../src/services/members.js";
import { api, login } from "./helpers.js";
import {
  APP,
  callWorker,
  connect,
  E,
  limiter,
  MCP_URL,
  nextIp,
  tool,
} from "./mcp-helpers.js";

const app = createApp();

const tag = newId().slice(0, 6).toLowerCase();

const listTools = (auth?: string) =>
  callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

describe("MCP auth: PAT", () => {
  it("a revoked PAT → 401 with a resource-metadata challenge", async () => {
    const u = await login(`auth-rev-${tag}@x.com`);
    const { id, token } = await createPat(env, u.userId, "rev");
    const c = await connect(token);
    expect((await c.listTools()).tools.length).toBe(17);
    await c.close();
    await env.DB.prepare("update tokens set revoked_at = ? where id = ?")
      .bind(Date.now(), id)
      .run();
    const r = await listTools(`Bearer ${token}`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
    expect(r.headers.get("www-authenticate")).toContain(
      `resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("an unknown PAT → 401; a deleted PAT → 401", async () => {
    const r = await listTools(`Bearer oa_pat_${"1".repeat(32)}`);
    expect(r.status).toBe(401);
    const u = await login(`auth-del-${tag}@x.com`);
    const { token } = await createPat(env, u.userId, "del");
    await env.DB.prepare("delete from tokens where user_id = ?")
      .bind(u.userId)
      .run();
    expect((await listTools(`Bearer ${token}`)).status).toBe(401);
  });

  it("a browser Origin other than the app host is rejected", async () => {
    const u = await login(`auth-origin-${tag}@x.com`);
    const { token } = await createPat(env, u.userId, "o");
    const r = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          origin: "https://evil.example",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ------------------------------------------------------------------- OAuth

const REDIRECT = "http://localhost:3333/cb";
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function register(name = "Test Agent"): Promise<string> {
  const r = await callWorker(
    new Request(`${APP}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
      },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(r.status).toBe(201);
  expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  return ((await r.json()) as { client_id: string }).client_id;
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

const authorizeUrl = (clientId: string, challenge: string) =>
  `${APP}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    resource: `${APP}/mcp`,
  })}`;

const cookiePairs = (r: Response) =>
  r.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");

/** GET the consent page as `cookie`; returns its form fields and binding cookies. */
async function consentPage(url: string, cookie: string) {
  const r = await callWorker(new Request(url, { headers: { cookie } }));
  const body = await r.text();
  const field = (n: string) =>
    new RegExp(`name="${n}" value="([^"]*)"`).exec(body)?.[1] ?? "";
  return {
    r,
    body,
    csrf: field("csrf"),
    request: field("request"),
    cookies: cookiePairs(r),
  };
}

const decide = (
  cookie: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) => {
  const body = new URLSearchParams(fields).toString();
  return callWorker(
    new Request(`${APP}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        ...headers,
      },
      body,
    }),
  );
};

/** Full flow for `email` (member): register → consent approve → token. */
async function oauthToken(
  email: string,
  clientName = "Test Agent",
  existing?: { cookie: string; userId: string },
) {
  const member = existing ?? (await login(email));
  const clientId = await register(clientName);
  const { verifier, challenge } = await pkce();
  const page = await consentPage(
    authorizeUrl(clientId, challenge),
    member.cookie,
  );
  expect(page.r.status).toBe(200);
  expect(page.body).toContain(clientName);
  expect(page.body).toContain(email);
  const r = await decide([member.cookie, ...page.cookies].join("; "), {
    csrf: page.csrf,
    request: page.request,
    decision: "approve",
  });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location") ?? "");
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st4te");
  const code = loc.searchParams.get("code") ?? "";
  const t = await callWorker(
    new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextIp(),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${APP}/mcp`,
      }).toString(),
    }),
  );
  expect(t.status).toBe(200);
  expect(t.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  const { access_token } = (await t.json()) as { access_token: string };
  return { member, accessToken: access_token, clientId };
}

describe("MCP auth: OAuth", () => {
  it("no auth → 401 with WWW-Authenticate pointing at the resource metadata", async () => {
    const r = await listTools();
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(
      `resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  describe("401s explain a missing or empty token", () => {
    const META = `resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`;
    const HINT =
      /^No token sent\. Check that your MCP client actually sends the token/;
    const expect401 = async (
      r: Response,
      error: string,
      description: RegExp,
    ) => {
      expect(r.status).toBe(401);
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(r.headers.get("www-authenticate")).toContain(META);
      expect(r.headers.get("www-authenticate")).toMatch(
        /^Bearer realm="OAuth"/,
      );
      expect(r.headers.get("cache-control")).toBe("no-store");
      const body = (await r.json()) as Record<string, string>;
      expect(body.error).toBe(error);
      expect(body.error_description).toMatch(description);
      expect(body.error_description).not.toContain("\u2014");
    };

    it("missing → invalid_token, discovery challenge unchanged", async () => {
      const r = await listTools();
      // The challenge carries no error (RFC 6750 §3.1), so clients start OAuth.
      expect(r.headers.get("www-authenticate")).not.toContain("error=");
      await expect401(r, "invalid_token", HINT);
    });

    it("empty and whitespace-only bearer → invalid_request", async () => {
      for (const auth of ["Bearer ", "Bearer   ", "bearer\t", "   "])
        await expect401(await listTools(auth), "invalid_request", HINT);
    });

    it("malformed header → invalid_request", async () => {
      await expect401(
        await listTools("Basic abc"),
        "invalid_request",
        /malformed/,
      );
    });

    it("an invalid OAuth token → JSON invalid_token", async () => {
      await expect401(
        await listTools("Bearer u:g:nope"),
        "invalid_token",
        /Invalid access token/,
      );
    });

    it("a valid OAuth token is unaffected", async () => {
      const { accessToken } = await oauthToken(`oauth-401-${tag}@x.com`);
      expect((await listTools(`Bearer ${accessToken}`)).status).toBe(200);
    });

    it("suspended user → 401 via OAuth (P3 T6)", async () => {
      const { member, accessToken } = await oauthToken(
        `oauth-susp-${tag}@x.com`,
      );
      expect((await listTools(`Bearer ${accessToken}`)).status).toBe(200);
      await setUserStatus(env, member.userId, "suspended", "admin_suspend");
      expect((await listTools(`Bearer ${accessToken}`)).status).toBe(401);
    });

    /** A fresh session cookie at the user's current epoch. */
    const freshCookie = async (userId: string) => {
      const row = await env.DB.prepare(
        "select session_epoch e from users where id = ?",
      )
        .bind(userId)
        .first<{ e: number }>();
      return `${sessionCookieName(env)}=${await signSession(env, userId, Date.now(), { provider: "access", epoch: row?.e ?? 0 })}`;
    };

    it("a grant the KV revocation missed is refused after an unsuspend; a new one works", async () => {
      const email = `oauth-miss-${tag}@x.com`;
      const { member, accessToken } = await oauthToken(email);
      expect((await listTools(`Bearer ${accessToken}`)).status).toBe(200);
      // listUserGrants lagged: setUserStatus's D1 writes landed (a suspend,
      // then an unsuspend), the KV revocation missed this grant.
      await new Promise((r) => setTimeout(r, 5));
      await env.DB.prepare(
        "update users set status = 'active', status_changed_at = ? where id = ?",
      )
        .bind(Date.now(), member.userId)
        .run();
      expect(
        (await helpers(env).listUserGrants(member.userId)).items,
      ).toHaveLength(1);
      expect((await listTools(`Bearer ${accessToken}`)).status).toBe(401);
      // Past the status change: a grant approved now is honoured.
      await new Promise((r) => setTimeout(r, 5));
      const again = await oauthToken(email, "Again", {
        userId: member.userId,
        cookie: await freshCookie(member.userId),
      });
      expect((await listTools(`Bearer ${again.accessToken}`)).status).toBe(200);
    });

    it("consent approved while the user is suspended writes no grant", async () => {
      const email = `oauth-late-${tag}@x.com`;
      const m = await login(email);
      // The suspension commits after the session read, before the grant.
      const real = oauthApiModule.oauthApi;
      const spy = vi
        .spyOn(oauthApiModule, "oauthApi")
        .mockImplementation((e) => {
          const api = real(e);
          return new Proxy(api, {
            get(t, k) {
              if (k === "approveConsent")
                return async (...a: Parameters<typeof api.approveConsent>) => {
                  await setUserStatus(
                    env,
                    m.userId,
                    "suspended",
                    "admin_suspend",
                  );
                  return t.approveConsent(...a);
                };
              const v = Reflect.get(t, k);
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        });
      try {
        const clientId = await register("Late");
        const page = await consentPage(
          authorizeUrl(clientId, (await pkce()).challenge),
          m.cookie,
        );
        expect(page.r.status).toBe(200);
        const r = await decide([m.cookie, ...page.cookies].join("; "), {
          csrf: page.csrf,
          request: page.request,
          decision: "approve",
        });
        expect(r.status).toBe(401);
      } finally {
        spy.mockRestore();
      }
      expect((await helpers(env).listUserGrants(m.userId)).items).toEqual([]);
    });
  });

  it("metadata endpoints are served with the security headers", async () => {
    for (const p of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const r = await callWorker(new Request(`${APP}${p}`));
      expect(r.status, p).toBe(200);
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const as = (await (
      await callWorker(
        new Request(`${APP}/.well-known/oauth-authorization-server`),
      )
    ).json()) as Record<string, string>;
    expect(as.authorization_endpoint).toBe(`${APP}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${APP}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${APP}/oauth/register`);
  });

  it("full flow: register, consent as a member, token, tools/list; agent = client_name + clientInfo.version", async () => {
    const { accessToken } = await oauthToken(`oauth-m-${tag}@x.com`);
    const c = await connect(accessToken, {
      modern: true,
      clientInfo: { name: "self-reported", version: "4.5.6" },
    });
    expect((await c.listTools()).tools).toHaveLength(17);
    const pub = (
      await tool(c, "publish_artifact", {
        title: "oauth",
        format: "markdown",
        content: "# oauth",
      })
    ).structuredContent as { id: string };
    const v = await env.DB.prepare(
      "select agent_name, agent_version from versions where artifact_id = ?",
    )
      .bind(pub.id)
      .first<{ agent_name: string; agent_version: string | null }>();
    expect(v).toEqual({ agent_name: "Test Agent", agent_version: "4.5.6" });
    await c.close();
    // 2025-era clients send clientInfo only at initialize: version unknown.
    const legacy = await connect(accessToken);
    const r = await tool(legacy, "publish_artifact", {
      id: pub.id,
      format: "markdown",
      content: "# v2",
    });
    expect(r.isError).toBeFalsy();
    const v2 = await env.DB.prepare(
      "select agent_name, agent_version from versions where artifact_id = ? and version = 2",
    )
      .bind(pub.id)
      .first();
    expect(v2).toEqual({ agent_name: "Test Agent", agent_version: null });
    await legacy.close();
  });

  it("oauth-clients lists the grant; revoking it makes the token fail", async () => {
    const email = `oauth-rv-${tag}@x.com`;
    const { member, accessToken } = await oauthToken(email, "Revokable");
    const l = await api(app, R.oauthClients, member.cookie);
    expect(l.status).toBe(200);
    const clients = (await l.json()) as OAuthClient[];
    expect(clients).toHaveLength(1);
    expect(OAuthClientSchema.parse(clients[0])).toMatchObject({
      clientName: "Revokable",
    });
    const grantId = clients[0]?.grantId ?? "";
    // Someone else can't see or revoke it.
    const other = await login(`oauth-other-${tag}@x.com`);
    expect(
      (
        await api(app, R.oauthClient(grantId), other.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    // CSRF header required for the cookie DELETE.
    expect(
      (
        await api(app, R.oauthClient(grantId), member.cookie, {
          method: "DELETE",
          headers: { "x-oa-request": "0" },
        })
      ).status,
    ).toBe(403);
    const d = await api(app, R.oauthClient(grantId), member.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    expect((await listTools(`Bearer ${accessToken}`)).status).toBe(401);
    expect(
      (await (await api(app, R.oauthClients, member.cookie)).json()) as [],
    ).toEqual([]);
  });

  it("deny → redirect with access_denied", async () => {
    const m = await login(`oauth-deny-${tag}@x.com`);
    const clientId = await register();
    const page = await consentPage(
      authorizeUrl(clientId, (await pkce()).challenge),
      m.cookie,
    );
    const r = await decide([m.cookie, ...page.cookies].join("; "), {
      csrf: page.csrf,
      request: page.request,
      decision: "deny",
    });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location") ?? "");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st4te");
  });

  it("consent POST needs the signed CSRF token, bound to the session, single use", async () => {
    const m = await login(`oauth-csrf-${tag}@x.com`);
    const other = await login(`oauth-csrf2-${tag}@x.com`);
    const clientId = await register();
    const page = await consentPage(
      authorizeUrl(clientId, (await pkce()).challenge),
      m.cookie,
    );
    const cookie = [m.cookie, ...page.cookies].join("; ");
    const ok = { csrf: page.csrf, request: page.request, decision: "approve" };
    expect((await decide(cookie, { ...ok, csrf: "1.x" })).status).toBe(403);
    // Another user's session can't use this token.
    expect(
      (await decide([other.cookie, ...page.cookies].join("; "), ok)).status,
    ).toBe(403);
    expect(
      (await decide(cookie, ok, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect((await decide(cookie, ok)).status).toBe(302);
    // The handle is consumed: a replay fails.
    const replay = await decide(cookie, ok);
    expect(replay.status).toBe(400);
  });

  it("consent page escapes the client name and sets anti-framing headers", async () => {
    const m = await login(`oauth-xss-${tag}@x.com`);
    const clientId = await register('<img src=x onerror="alert(1)">');
    const page = await consentPage(
      authorizeUrl(clientId, (await pkce()).challenge),
      m.cookie,
    );
    expect(page.r.status).toBe(200);
    expect(page.body).not.toContain("<img src=x");
    expect(page.body).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(page.body).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(page.r.headers.get("x-frame-options")).toBe("DENY");
    expect(page.r.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.r.headers.get("content-security-policy")).toContain(
      "img-src 'self'",
    );
    expect(page.r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("no session → redirect to sign-in, back to the authorize URL", async () => {
    const clientId = await register();
    const url = authorizeUrl(clientId, (await pkce()).challenge);
    const r = await callWorker(new Request(url));
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location") ?? "", APP);
    expect(loc.pathname).toBe("/auth/login");
    const u = new URL(url);
    expect(loc.searchParams.get("next")).toBe(`${u.pathname}${u.search}`);
  });

  it("a guest at the consent page gets the members-only message", async () => {
    const g = await login(`oauth-guest-${tag}@x.com`, "guest");
    const clientId = await register();
    const page = await consentPage(
      authorizeUrl(clientId, (await pkce()).challenge),
      g.cookie,
    );
    expect(page.r.status).toBe(403);
    expect(page.body).toContain("Only members can connect agents");
    expect(page.body).toContain(`${FAVICON_TAGS}\n</head>`);
    expect(page.r.headers.get("content-security-policy")).toContain(
      "img-src 'self'",
    );
    expect(page.body).not.toContain('name="csrf"');
  });

  it("consent page has every FAVICON_TAGS tag and the connect title", async () => {
    const m = await login(`oauth-fav-${tag}@x.com`);
    const clientId = await register("Fav Agent");
    const page = await consentPage(
      authorizeUrl(clientId, (await pkce()).challenge),
      m.cookie,
    );
    expect(page.r.status).toBe(200);
    const head = page.body.slice(0, page.body.indexOf("</head>"));
    // Design's file has one tag per line; each must be in <head>.
    for (const t of FAVICON_TAGS.split(/(?=<)/)) expect(head).toContain(t);
    expect(head).toContain(
      "<title>Connect Fav Agent to Open Artifacts</title>",
    );
  });

  it("the consent template is Design's file, comment stripped", () => {
    expect(CONSENT_TEMPLATE).toBe(stripTemplateComment(designConsent));
  });
});

describe("MCP auth: capped callers (P2 T9 review)", () => {
  /** A code session outside the verified domains: capped whatever the role. */
  const codeCookie = async (userId: string) =>
    `${sessionCookieName(env)}=${await signSession(env, userId, Date.now(), { provider: "code", epoch: 0 })}`;

  it("a capped member at the consent page gets the members-only message", async () => {
    const m = await login(`oauth-capped-${tag}@x.com`);
    const clientId = await register();
    const page = await consentPage(
      authorizeUrl(clientId, (await pkce()).challenge),
      await codeCookie(m.userId),
    );
    expect(page.r.status).toBe(403);
    expect(page.body).toContain("Only members can connect agents");
  });

  it("a capped caller can still revoke their own grant", async () => {
    const { member } = await oauthToken(`oauth-caprv-${tag}@x.com`);
    const capped = await codeCookie(member.userId);
    const [g] = (await (
      await api(app, R.oauthClients, capped)
    ).json()) as OAuthClient[];
    expect(g).toBeDefined();
    const d = await api(app, R.oauthClient(g?.grantId ?? ""), capped, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
  });
});

describe("MCP auth: fix round 1", () => {
  const grantsOf = async (userId: string) =>
    (await oauthApi(env).listUserGrants(userId)).items;

  it("consent POST with Origin: null (no-referrer page) is accepted", async () => {
    const m = await login(`oauth-onull-${tag}@x.com`);
    const clientId = await register();
    const page = await consentPage(
      authorizeUrl(clientId, (await pkce()).challenge),
      m.cookie,
    );
    const r = await decide(
      [m.cookie, ...page.cookies].join("; "),
      { csrf: page.csrf, request: page.request, decision: "approve" },
      { origin: "null", "sec-fetch-site": "same-origin" },
    );
    expect(r.status).toBe(302);
    expect(
      new URL(r.headers.get("location") ?? "").searchParams.get("code"),
    ).toBeTruthy();
  });

  it("a guest's PAT verifies but is refused at /mcp (members only)", async () => {
    const g = await login(`pat-guest-${tag}@x.com`, "guest");
    const { token } = await createPat(env, g.userId, "g");
    expect(await verifyPat(env, token)).not.toBeNull();
    const r = await listTools(`Bearer ${token}`);
    expect(r.status).toBe(401);
    expect(
      ((await r.json()) as { error: { message: string } }).error.message,
    ).toBe("Only members can connect agents");
  });

  it("demotion to guest revokes the user's OAuth grants and PATs", async () => {
    const { member, accessToken } = await oauthToken(`oauth-dem-${tag}@x.com`);
    const { token } = await createPat(env, member.userId, "p");
    expect(await grantsOf(member.userId)).toHaveLength(1);
    // MemberPatch allows admin|member only; exercise the guard directly.
    await patchMember(env, member.userId, { role: "guest" } as never);
    expect(await grantsOf(member.userId)).toEqual([]);
    expect(await verifyPat(env, token)).toBeNull();
    expect((await listTools(`Bearer ${accessToken}`)).status).toBe(401);
  });

  it("removing a member revokes their OAuth grants", async () => {
    await login(`oauth-rmv-owner-${tag}@x.com`, "owner");
    const { member } = await oauthToken(`oauth-rmv-${tag}@x.com`);
    expect(await grantsOf(member.userId)).toHaveLength(1);
    await removeMember(env, member.userId);
    expect(await grantsOf(member.userId)).toEqual([]);
  });

  it("/oauth/register fails closed without RL_ANON outside dev", async () => {
    const body = JSON.stringify({
      client_name: "x",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    const req = () =>
      new Request(`${APP}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    const prod = await callWorker(
      req(),
      E({ RL_ANON: undefined, ENVIRONMENT: "production" }),
    );
    expect(prod.status).toBe(503);
    expect(prod.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await callWorker(req(), E({ RL_ANON: undefined }))).status).toBe(
      201,
    );
  });

  it("registration is limited per IP (reg:ip:<ipKey>, IPv6 per /64)", async () => {
    const e = E({ RL_ANON: limiter().RL_ANON });
    const reg = (ip: string) =>
      callWorker(
        new Request(`${APP}/oauth/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": ip,
          },
          body: JSON.stringify({
            client_name: "rl",
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "none",
          }),
        }),
        e,
      );
    const net = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:7`;
    let limitedAt = 0;
    for (let i = 1; i <= 40 && !limitedAt; i++)
      if ((await reg(`${net}::${i.toString(16)}`)).status === 429)
        limitedAt = i;
    // Different hosts in one /64 share the key; another IP is unaffected.
    expect(limitedAt).toBe(31);
    expect((await reg(nextIp())).status).toBe(201);
  });

  it("instance-wide daily cap: over it → 429 'registration limit reached; try tomorrow'", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "insert into counters (key, n, day) values ('oauth_register', ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
    )
      .bind(MAX_REGISTRATIONS_PER_DAY, today)
      .run();
    try {
      const r = await callWorker(
        new Request(`${APP}/oauth/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": nextIp(),
          },
          body: JSON.stringify({
            client_name: "cap",
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "none",
          }),
        }),
      );
      expect(r.status).toBe(429);
      expect(
        ((await r.json()) as { error: { message: string } }).error.message,
      ).toBe("registration limit reached; try tomorrow");
      // Yesterday's count doesn't carry over.
      await env.DB.prepare(
        "update counters set day = '2000-01-01' where key = 'oauth_register'",
      ).run();
      expect(await register()).toBeTruthy();
    } finally {
      await env.DB.prepare(
        "delete from counters where key = 'oauth_register'",
      ).run();
    }
  });

  it("cron deletes clients that never completed a grant within a day", async () => {
    const stale = await register("never granted");
    const fresh = await register("registered today");
    const { clientId: granted } = await oauthToken(`oauth-sweep-${tag}@x.com`);
    await env.DB.prepare(
      "update counters set day = '2000-01-01' where key in (?, ?)",
    )
      .bind(`client:${stale}`, `client:${granted}`)
      .run();
    expect(await sweepUngrantedClients(env)).toBeGreaterThanOrEqual(1);
    const api = helpers(env);
    expect(await api.lookupClient(stale)).toBeNull();
    expect(await api.lookupClient(fresh)).not.toBeNull();
    expect(await api.lookupClient(granted)).not.toBeNull();
  });

  it("client names lose bidi/zero-width characters and are capped at 64", () => {
    expect(clientNameOf("Good‮LIVE​⁦x﻿", "id")).toBe("GoodLIVEx");
    expect(clientNameOf("a".repeat(100), "id")).toHaveLength(64);
    expect(clientNameOf("​‏", "fallback-id")).toBe("fallback-id");
  });

  it("the provider is cached per app instance and resource", () => {
    const a = { fetch: () => new Response("a") };
    const b = { fetch: () => new Response("b") };
    expect(oauthProvider(env, a)).toBe(oauthProvider(env, a));
    expect(oauthProvider(env, a)).not.toBe(oauthProvider(env, b));
    expect(oauthProvider(env, a)).not.toBe(
      oauthProvider(E({ APP_HOST: "other.localhost" }) as typeof env, a),
    );
  });
});
