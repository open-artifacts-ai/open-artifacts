import { describe, expect, it } from "vitest";
import { handle } from "../src/app.js";
import { csrfToken } from "../src/auth/csrf.js";
import {
  authServer,
  oauthPrincipal,
  refreshTtlFor,
} from "../src/auth/oauth/index.js";
import { sessionPrincipal } from "../src/auth/session.js";
import { isRefusal } from "../src/principal.js";
import { mintAgentToken } from "../src/services/tokens.js";
import { ADMIN, API, ctx } from "./fakes.js";
import {
  authorized,
  authorizeUrl,
  CLAUDE_AI,
  cookieHeader,
  getConsent,
  grant,
  HOUR,
  kv,
  oauthWorld,
  pkce,
  postConsent,
  REDIRECT,
  RESOURCE,
  randomIp,
  refresh,
  register,
  registerRaw,
  rowOf,
  type Tokens,
  type World,
} from "./oauth-helpers.js";

// W13b: the MCP OAuth authorization server (design v7 9A.3, 9A.7, 9A.8).

const SCOPES = [
  "installs:read",
  "installs:write",
  "installs:delete",
  "installs:pii",
  "audit:read",
];

const bodyOf = async (r: Response) => (await r.json()) as Record<string, any>;

const mcpPrincipal = (w: World, t: Tokens) =>
  oauthPrincipal(w.env, t.access_token);

const v1 = (w: World, t: Tokens) =>
  w.call(
    new Request(`${API}/v1/me`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    }),
  );

async function auditRows(w: World, action: string) {
  return (
    await w.db
      .prepare(
        "SELECT * FROM admin_audit WHERE action = ?1 AND (actor_label = ?2 OR detail LIKE ?3) ORDER BY id",
      )
      .bind(action, w.email, `%${w.email}%`)
      .all<Record<string, any>>()
  ).results;
}

describe("metadata (RFC 8414, RFC 9728)", () => {
  it("issuer on the api host, authorize on the admin host, five scopes, S256 only", async () => {
    const w = await oauthWorld();
    const res = await w.call(
      new Request(`${API}/.well-known/oauth-authorization-server`),
    );
    expect(res.status).toBe(200);
    const m = await bodyOf(res);
    expect(m.issuer).toBe(API);
    expect(m.authorization_endpoint).toBe(`${ADMIN}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${API}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${API}/oauth/register`);
    expect(m.scopes_supported).toEqual(SCOPES);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("RFC 9728 document from our handler", async () => {
    const w = await oauthWorld();
    const res = await w.call(
      new Request(`${API}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [API],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  it("the admin host serves no AS endpoint; the api host no consent", async () => {
    const w = await oauthWorld();
    for (const p of ["/oauth/token", "/oauth/register"])
      expect(
        (await w.call(new Request(`${ADMIN}${p}`, { method: "POST" }))).status,
      ).toBe(404);
    expect(
      (await w.call(new Request(`${API}/oauth/authorize?x=1`))).status,
    ).toBe(404);
  });
});

describe("refreshTtlFor (Q3)", () => {
  it("is the seconds left, capped at 8 h", () => {
    const now = 1_000_000_000_000;
    expect(refreshTtlFor(now + 2 * HOUR, now)).toBe(7200);
    expect(refreshTtlFor(now + 10 * HOUR, now)).toBe(28_800);
    expect(refreshTtlFor(now + 2 * HOUR + 999, now)).toBe(7200);
  });
});

describe("DCR (/oauth/register)", () => {
  it("loopback with a port and the exact MCP_REDIRECT_URIS entry are accepted", async () => {
    const w = await oauthWorld();
    const res = await registerRaw(w, {
      redirect_uris: [
        REDIRECT,
        "http://localhost:9/cb",
        "http://[::1]:7/cb",
        CLAUDE_AI,
      ],
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(201);
    const { client_id } = await bodyOf(res);
    const row = await w.db
      .prepare("SELECT * FROM oauth_clients WHERE client_id = ?1")
      .bind(client_id)
      .first<Record<string, any>>();
    expect(row?.client_name).toBe("Test agent");
    expect(JSON.parse(row?.redirect_hosts)).toEqual(["loopback", "claude.ai"]);
    expect(row?.ip_hmac).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.first_grant_at).toBeNull();
  });

  it.each([
    "https://evil.example/cb",
    "https://claude.ai/api/mcp/other",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "http://127.0.0.1/callback",
    "https://127.0.0.1:33418/callback",
    "http://localhost.evil.example:8/cb",
  ])(
    "refuses %s with invalid_redirect_uri, counted in oauth_register",
    async (uri) => {
      const w = await oauthWorld();
      const res = await registerRaw(w, {
        redirect_uris: [REDIRECT, uri],
        token_endpoint_auth_method: "none",
      });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toBe("invalid_redirect_uri");
      const n = await w.db
        .prepare(
          "SELECT sum(count) AS n FROM audit_refusals WHERE bucket = 'oauth_register' AND code = 'invalid_redirect_uri'",
        )
        .first<{ n: number }>();
      expect(n?.n ?? 0).toBeGreaterThan(0);
    },
  );

  it("10 per ipKey per UTC day; the 11th is refused; another IP is not blocked", async () => {
    const w = await oauthWorld();
    const ip = randomIp();
    const body = {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    };
    for (let i = 0; i < 10; i++)
      expect((await registerRaw(w, body, ip)).status).toBe(201);
    const over = await registerRaw(w, body, ip);
    expect(over.status).toBe(429);
    expect((await registerRaw(w, body, randomIp())).status).toBe(201);
  });

  it("concurrent registrations from one IP: exactly 10 succeed", async () => {
    const w = await oauthWorld();
    const ip = randomIp();
    const body = {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    };
    const all = await Promise.all(
      Array.from({ length: 15 }, () => registerRaw(w, body, ip)),
    );
    expect(all.filter((r) => r.status === 201)).toHaveLength(10);
    expect(all.filter((r) => r.status === 429)).toHaveLength(5);
  });

  it("refused registrations do not spend the IP's day", async () => {
    const w = await oauthWorld();
    const ip = randomIp();
    for (let i = 0; i < 10; i++)
      expect(
        (
          await registerRaw(
            w,
            {
              redirect_uris: ["https://evil.example/cb"],
              token_endpoint_auth_method: "none",
            },
            ip,
          )
        ).status,
      ).toBe(400);
    for (let i = 0; i < 10; i++)
      expect(
        (
          await registerRaw(
            w,
            { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
            ip,
          )
        ).status,
      ).toBe(201);
  });

  it("a failed oauth_clients insert removes the client from KV and refunds the slot", async () => {
    const w = await oauthWorld();
    const ip = randomIp();
    const real = w.env.PLATFORM_DB;
    w.env.PLATFORM_DB = new Proxy(real, {
      get(t, k) {
        if (k === "prepare")
          return (sql: string) => {
            if (sql.includes("INSERT INTO oauth_clients"))
              throw new Error("d1 down");
            return t.prepare(sql);
          };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const clients = async () =>
      (await kv().list({ prefix: "client:" })).keys.map((k) => k.name);
    const before = await clients();
    const res = await registerRaw(
      w,
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
      ip,
    );
    expect(res.status).toBe(500);
    expect(await clients()).toEqual(before);
    w.env.PLATFORM_DB = real;
    for (let i = 0; i < 10; i++)
      expect(
        (
          await registerRaw(
            w,
            { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
            ip,
          )
        ).status,
      ).toBe(201);
  });

  it("RL_PV_OAUTH_IP keyed by ipKey; unbound is 503", async () => {
    const w = await oauthWorld();
    const body = {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    };
    await registerRaw(w, body);
    expect(w.limits.RL_PV_OAUTH_IP.keys).toContain(w.ip);
    w.limits.RL_PV_OAUTH_IP.allow = false;
    expect((await registerRaw(w, body)).status).toBe(429);
    const u = await oauthWorld({ RL_PV_OAUTH_IP: undefined });
    expect((await registerRaw(u, body)).status).toBe(503);
  });

  it("sweeps up to 10 unclaimed clients older than 24 h, KV and D1", async () => {
    const w = await oauthWorld();
    const old = await register(w);
    await w.db
      .prepare(
        "UPDATE oauth_clients SET registered_at = ?2 WHERE client_id = ?1",
      )
      .bind(old, Date.now() - 25 * HOUR)
      .run();
    const oauth = authServer(w.env).getOAuthApi(w.env);
    expect(await oauth.lookupClient(old)).not.toBeNull();
    await register(w);
    expect(await oauth.lookupClient(old)).toBeNull();
    expect(
      await w.db
        .prepare("SELECT 1 FROM oauth_clients WHERE client_id = ?1")
        .bind(old)
        .first(),
    ).toBeNull();
  });

  it("keeps a claimed client", async () => {
    const w = await oauthWorld();
    const { clientId } = await grant(w);
    await w.db
      .prepare(
        "UPDATE oauth_clients SET registered_at = ?2 WHERE client_id = ?1",
      )
      .bind(clientId, Date.now() - 25 * HOUR)
      .run();
    await register(w);
    const oauth = authServer(w.env).getOAuthApi(w.env);
    expect(await oauth.lookupClient(clientId)).not.toBeNull();
  });
});

describe("GET /oauth/authorize: cookie, bounce, session left", () => {
  it("no session, cross-site: 200 bounce page to the same URL plus b=1", async () => {
    const w = await oauthWorld();
    const clientId = await register(w);
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge);
    const res = await w.call(
      new Request(url, { headers: { "sec-fetch-site": "cross-site" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const html = await res.text();
    const next = `${url.pathname}${url.search}&b=1`.replaceAll("&", "&amp;");
    expect(html).toContain(
      `<meta http-equiv="refresh" content="0;url=${next}">`,
    );
    expect(html).toContain(`href="${next}"`);
    expect(html).toContain("Continue");
  });

  it("no session with b=1, or same-origin: 302 to /auth/start with the query, b dropped", async () => {
    const w = await oauthWorld();
    const clientId = await register(w);
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge);
    const bounced = new URL(url);
    bounced.searchParams.set("b", "1");
    for (const [u, site] of [
      [bounced, "cross-site"],
      [url, "same-origin"],
      [url, "none"],
    ] as const) {
      const res = await w.call(
        new Request(u, { headers: { "sec-fetch-site": site } }),
      );
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(`${loc.origin}${loc.pathname}`).toBe(`${ADMIN}/auth/start`);
      expect(loc.searchParams.get("return")).toBe(
        `${url.pathname}${url.search}`,
      );
    }
  });

  it("a session with under 60 min left goes to sign-in first", async () => {
    const w = await oauthWorld({}, 30 * 60_000);
    const clientId = await register(w);
    const { challenge } = await pkce();
    const res = await getConsent(w, authorizeUrl(clientId, challenge));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      new RegExp(`^${ADMIN}/auth/start\\?return=%2Foauth%2Fauthorize%3F`),
    );
  });

  it("an identity removed from ADMIN_IDENTITIES has no session", async () => {
    const w = await oauthWorld();
    const clientId = await register(w);
    const { challenge } = await pkce();
    w.env.ADMIN_IDENTITIES = "other@example.com:9";
    const res = await getConsent(w, authorizeUrl(clientId, challenge));
    expect(res.status).toBe(302);
  });

  it("a request without code_challenge (confidential client) is invalid_request", async () => {
    const w = await oauthWorld();
    const clientId = await register(w, "client_secret_basic");
    const res = await getConsent(w, authorizeUrl(clientId, null));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("PKCE S256 is required");
  });

  it("an unknown client is a 400 page, never a redirect", async () => {
    const w = await oauthWorld();
    const { challenge } = await pkce();
    const res = await getConsent(w, authorizeUrl("nope", challenge));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("the consent page", () => {
  it("renders the 9A.3.2 facts with its own headers", async () => {
    const w = await oauthWorld();
    const clientId = await register(w);
    const { challenge } = await pkce();
    const res = await getConsent(w, authorizeUrl(clientId, challenge));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.getSetCookie().join("\n")).toMatch(/__Host-oauth-/);
    const html = await res.text();
    expect(html).toContain("Connect any AI agent to Open Artifacts admin");
    expect(html).toContain("Staging");
    expect(html).toContain("Calls itself <b>Test agent</b>");
    expect(html).toContain(clientId);
    expect(html).toContain("registered 0 minutes ago");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("Local app");
    expect(html).toContain(
      "Only continue if you just started this from your own agent.",
    );
    expect(html).toContain("Can delete installs and purge failed creates");
    expect(html).toContain("Can read owner email");
    expect(html).toMatch(
      /Ends at \d\d:\d\d UTC, when your admin session ends\./,
    );
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Deny<");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("—");
  });

  it("checks read and audit; never pre-checks write, delete or pii, even when asked", async () => {
    const w = await oauthWorld();
    const clientId = await register(w);
    const { challenge } = await pkce();
    const html = await (
      await getConsent(
        w,
        authorizeUrl(
          clientId,
          challenge,
          "installs:write installs:delete installs:pii",
        ),
      )
    ).text();
    const box = (s: string) =>
      new RegExp(
        `<input type="checkbox" name="scope" value="${s}"( checked)?>`,
      ).exec(html);
    expect(box("installs:read")?.[1]).toBe(" checked");
    expect(box("audit:read")?.[1]).toBe(" checked");
    for (const s of ["installs:write", "installs:delete", "installs:pii"]) {
      expect(box(s)).not.toBeNull();
      expect(box(s)?.[1]).toBeUndefined();
    }
  });

  it("escapes the DCR client name", async () => {
    const w = await oauthWorld();
    const res = await registerRaw(w, {
      client_name: '<img src=x onerror="a()">',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    const { client_id } = await bodyOf(res);
    const { challenge } = await pkce();
    const html = await (
      await getConsent(w, authorizeUrl(client_id, challenge))
    ).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;a()&quot;&gt;");
  });

  it("prod shows the Production badge", async () => {
    const w = await oauthWorld({ OA_ENV: "prod" });
    const clientId = await register(w);
    const { challenge } = await pkce();
    const html = await (
      await getConsent(w, authorizeUrl(clientId, challenge))
    ).text();
    expect(html).toContain("Production");
  });
});

describe("POST /oauth/authorize", () => {
  const page = async (w: World) => {
    const clientId = await register(w);
    const { challenge } = await pkce();
    return {
      clientId,
      page: await getConsent(w, authorizeUrl(clientId, challenge)),
    };
  };

  it("approves with Origin: null, the cookie, the consent token and same-origin", async () => {
    const w = await oauthWorld();
    const { page: p } = await page(w);
    const res = await postConsent(w, p, "approve");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(loc.searchParams.get("iss")).toBe(API);
  });

  it("refuses Sec-Fetch-Site: cross-site", async () => {
    const w = await oauthWorld();
    const { page: p } = await page(w);
    const res = await postConsent(w, p, "approve", undefined, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a bad consent token, and another session's", async () => {
    const w = await oauthWorld();
    const { page: p } = await page(w);
    const res = await postConsent(w, p.clone(), "approve", undefined, {
      consent: "0".repeat(64),
    });
    expect(res.status).toBe(403);
    const other = await oauthWorld();
    const res2 = await postConsent(w, p, "approve", undefined, {
      sid: other.sid,
    });
    expect([401, 403]).toContain(res2.status);
  });

  it("refuses without the session cookie", async () => {
    const w = await oauthWorld();
    const { page: p } = await page(w);
    const res = await postConsent(w, p, "approve", undefined, { sid: "x" });
    expect(res.status).toBe(401);
  });

  it("Allow with no scope is a 400", async () => {
    const w = await oauthWorld();
    const { page: p } = await page(w);
    expect((await postConsent(w, p, "approve", [])).status).toBe(400);
  });

  it("Deny redirects with access_denied and audits oauth.denied", async () => {
    const w = await oauthWorld();
    const { clientId, page: p } = await page(w);
    const res = await postConsent(w, p, "deny");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    const [row] = await auditRows(w, "oauth.denied");
    expect(row?.actor_label).toBe(w.email);
    expect(JSON.parse(row?.detail)).toEqual({
      clientId,
      clientName: "Test agent",
    });
  });

  it("Allow mints one oauth row with the picked scopes and audits oauth.grant", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w, {
      scope: ["installs:read", "installs:write"],
    });
    const row = await rowOf(w, tokens);
    expect(row?.kind).toBe("oauth");
    expect(JSON.parse(row?.scopes ?? "[]")).toEqual([
      "installs:read",
      "installs:write",
    ]);
    expect(row?.label).toBe("Test agent");
    const [g] = await auditRows(w, "oauth.grant");
    expect(JSON.parse(g?.detail)).toMatchObject({
      tokenId: row?.id,
      clientId,
      clientName: "Test agent",
      scopes: ["installs:read", "installs:write"],
      redirectHost: "127.0.0.1",
      grantEnd: row?.expires_at,
    });
    const client = await w.db
      .prepare("SELECT first_grant_at FROM oauth_clients WHERE client_id = ?1")
      .bind(clientId)
      .first<{ first_grant_at: number | null }>();
    expect(client?.first_grant_at).not.toBeNull();
  });

  it("at the 5-live limit the page names /tokens", async () => {
    const w = await oauthWorld();
    for (let i = 0; i < 5; i++) await authorized(w);
    const clientId = await register(w);
    const { challenge } = await pkce();
    const p = await getConsent(w, authorizeUrl(clientId, challenge));
    const res = await postConsent(w, p, "approve");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      "5 agent tokens are live. Revoke one at /tokens.",
    );
  });

  it("the 5-live limit counts both kinds: 3 oat_ (R19's mint) and 2 grants, then 409", async () => {
    const w = await oauthWorld();
    // R19's handler is this call; the adapter's JSON body parse is W4's.
    const p0 = await sessionPrincipal(
      new Request(ADMIN, { headers: { cookie: cookieHeader(w.sid) } }),
      w.env,
      Date.now(),
    );
    if (isRefusal(p0)) throw new Error("no session");
    for (let i = 0; i < 3; i++)
      await mintAgentToken(w.env, p0, {
        kind: "oat",
        label: `ci-${i}`,
        scopes: ["installs:read"],
        ttlMinutes: 15,
        requestId: `req_${crypto.randomUUID().replace(/-/g, "")}`,
      });
    for (let i = 0; i < 2; i++) await authorized(w);
    const clientId = await register(w);
    const { challenge } = await pkce();
    const p = await getConsent(w, authorizeUrl(clientId, challenge));
    const res = await postConsent(w, p, "approve");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      "5 agent tokens are live. Revoke one at /tokens.",
    );
  });

  it("the consent routes charge RL_PV_OAUTH_IP by ipKey", async () => {
    const w = await oauthWorld();
    const { page: p } = await page(w);
    w.limits.RL_PV_OAUTH_IP.allow = false;
    expect((await postConsent(w, p, "approve")).status).toBe(429);
  });
});

describe("code exchange and tokens", () => {
  it("tokens carry the adm_ userId (no ':' in it, no '@'); access 900 s; grant_id recorded", async () => {
    const w = await oauthWorld();
    const { tokens } = await grant(w);
    const row = await rowOf(w, tokens);
    expect(row?.oauth_user).toMatch(/^adm_[0-9a-f]{32}$/);
    expect(tokens.access_token.startsWith(`${row?.oauth_user}:`)).toBe(true);
    for (const t of [tokens.access_token, tokens.refresh_token ?? ""])
      expect(t).not.toContain("@");
    expect(tokens.expires_in).toBe(900);
    expect(tokens.scope.split(" ").sort()).toEqual([
      "audit:read",
      "installs:read",
    ]);
    expect(row?.grant_id).toBe(tokens.access_token.split(":")[1]);
  });

  it("oauth_user is adm_ + HMAC(ADMIN_SESSION_KEY, 'oauth-user\\n' + email), 16 bytes", async () => {
    const w = await oauthWorld();
    const { tokens } = await grant(w);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(w.env.ADMIN_SESSION_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`oauth-user\n${w.email}`),
      ),
    );
    const hex = [...mac.slice(0, 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect((await rowOf(w, tokens))?.oauth_user).toBe(`adm_${hex}`);
  });

  it("refresh TTL is the session's time left (Q3)", async () => {
    const w = await oauthWorld({}, 2 * HOUR);
    const { tokens } = await grant(w);
    const row = await rowOf(w, tokens);
    const { items } = await authServer(w.env)
      .getOAuthApi(w.env)
      .listUserGrants(row?.oauth_user ?? "");
    const g = items.find((i) => i.id === row?.grant_id);
    const sessionEnd = await w.db
      .prepare("SELECT expires_at FROM sessions WHERE email = ?1")
      .bind(w.email)
      .first<number>("expires_at");
    expect(
      Math.abs((g?.expiresAt ?? 0) - Math.floor((sessionEnd ?? 0) / 1000)),
    ).toBeLessThanOrEqual(1);
  });

  it("exchange refused for a revoked row; no grant left", async () => {
    const w = await oauthWorld();
    const { exchange, clientId } = await authorized(w);
    await w.db
      .prepare(
        "UPDATE agent_tokens SET revoked_at = ?1 WHERE admin_email = ?2 AND client_id = ?3",
      )
      .bind(Date.now(), w.email, clientId)
      .run();
    const res = await exchange();
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe("invalid_grant");
  });

  it("exchange refused once the session ended", async () => {
    const w = await oauthWorld();
    const { exchange } = await authorized(w);
    await w.db
      .prepare("UPDATE sessions SET revoked_at = ?1 WHERE email = ?2")
      .bind(Date.now(), w.email)
      .run();
    expect((await exchange()).status).toBe(400);
  });

  it("the token endpoint charges ipKey, then tok:<clientId>; 33 KiB is 413", async () => {
    const w = await oauthWorld();
    const { clientId } = await grant(w);
    const keys = w.limits.RL_PV_OAUTH_IP.keys;
    expect(keys).toContain(w.ip);
    expect(keys).toContain(`tok:${clientId}`);
    const big = await w.call(
      new Request(`${API}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=x&pad=${"a".repeat(33 * 1024)}`,
      }),
    );
    expect(big.status).toBe(413);
  });
});

describe("per-call D1 check (oauthPrincipal, 9A.3.3)", () => {
  it("a live grant is the token principal of its row", async () => {
    const w = await oauthWorld();
    const { tokens } = await grant(w);
    const row = await rowOf(w, tokens);
    const p = await mcpPrincipal(w, tokens);
    expect(isRefusal(p)).toBe(false);
    if (isRefusal(p)) return;
    expect(p).toMatchObject({
      kind: "token",
      actorKey: `token:${row?.id}`,
      rateKey: `admin:${w.email}`,
      label: "Test agent",
      tokenKind: "oauth",
      scopes: ["installs:read", "audit:read"],
      authAt: null,
    });
  });

  it("an OAuth bearer on /v1 is 401", async () => {
    const w = await oauthWorld();
    const { tokens } = await grant(w);
    expect((await v1(w, tokens)).status).toBe(401);
  });

  it("garbage and a staging token on a prod-configured Worker are refused", async () => {
    const w = await oauthWorld();
    const { tokens } = await grant(w);
    expect(isRefusal(await oauthPrincipal(w.env, "adm_x:y:z"))).toBe(true);
    const prod = { ...w.env, APP_DOMAIN: "prod.test", OA_ENV: "prod" as const };
    expect(isRefusal(await oauthPrincipal(prod, tokens.access_token))).toBe(
      true,
    );
  });
});

describe("revocation (D1 first, KV too)", () => {
  async function expectEnded(w: World, clientId: string, t: Tokens) {
    // The access token is refused at once, whatever KV holds.
    expect(isRefusal(await mcpPrincipal(w, t))).toBe(true);
    const r = await refresh(w, clientId, t);
    expect(r.status).toBe(400);
    expect((await bodyOf(r)).error).toBe("invalid_grant");
    expect(
      await authServer(w.env).validateToken(RESOURCE, t.access_token, w.env),
    ).toBeNull();
  }

  it("refresh works while the session lives and keeps the chain end", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w);
    const res = await refresh(w, clientId, tokens);
    expect(res.status).toBe(200);
    const next = (await res.json()) as Tokens;
    expect(isRefusal(await mcpPrincipal(w, next))).toBe(false);
  });

  it("logout (R24) ends it: D1 row, KV grant, refresh", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w);
    const res = await handle(
      new Request(`${ADMIN}/auth/logout`, {
        method: "POST",
        headers: {
          cookie: `__Host-oa-admin=${w.sid}`,
          origin: ADMIN,
          "sec-fetch-site": "same-origin",
          "x-csrf-token": await csrfToken(w.env, w.sid),
          "cf-connecting-ip": w.ip,
        },
      }),
      w.env,
      ctx(),
      { audit: async () => {} },
    );
    expect(res.status).toBe(204);
    // KV first: the grant is gone even before the D1 check runs.
    expect(
      await authServer(w.env).validateToken(
        RESOURCE,
        tokens.access_token,
        w.env,
      ),
    ).toBeNull();
    await expectEnded(w, clientId, tokens);
  });

  it("session expiry ends it at the next call and refresh; refresh_refused audited", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w);
    const row = await rowOf(w, tokens);
    await w.db
      .prepare("UPDATE sessions SET expires_at = ?1 WHERE email = ?2")
      .bind(Date.now() - 1, w.email)
      .run();
    expect(isRefusal(await mcpPrincipal(w, tokens))).toBe(true);
    await expectEnded(w, clientId, tokens);
    const rows = await w.db
      .prepare(
        "SELECT * FROM admin_audit WHERE action = 'oauth.refresh_refused' AND token_id = ?1",
      )
      .bind(row?.id)
      .all<Record<string, any>>();
    expect(rows.results.length).toBe(1);
    expect(JSON.parse(rows.results[0]?.detail)).toMatchObject({
      tokenId: row?.id,
      reason: "session_ended",
    });
  });

  it("identity removal ends it (KV grant still present for the call)", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w);
    const row = await rowOf(w, tokens);
    w.env.ADMIN_IDENTITIES = "other@example.com:9";
    expect(
      await authServer(w.env).validateToken(
        RESOURCE,
        tokens.access_token,
        w.env,
      ),
    ).not.toBeNull();
    expect(isRefusal(await mcpPrincipal(w, tokens))).toBe(true);
    await expectEnded(w, clientId, tokens);
    const r = await w.db
      .prepare(
        "SELECT detail FROM admin_audit WHERE action = 'oauth.refresh_refused' AND token_id = ?1",
      )
      .bind(row?.id)
      .first<string>("detail");
    expect(JSON.parse(r ?? "{}").reason).toBe("identity_removed");
  });

  it("R21 revoke ends it", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w);
    const row = await rowOf(w, tokens);
    const res = await w.call(
      new Request(`${ADMIN}/api/v1/tokens/${row?.id}`, {
        method: "DELETE",
        headers: {
          cookie: `__Host-oa-admin=${w.sid}`,
          origin: ADMIN,
          "sec-fetch-site": "same-origin",
          "x-csrf-token": await csrfToken(w.env, w.sid),
        },
      }),
    );
    expect(res.status).toBe(204);
    await expectEnded(w, clientId, tokens);
  });

  it("a newer consent of the same client supersedes: one live row, old grant gone", async () => {
    const w = await oauthWorld();
    const first = await grant(w);
    const second = await grant(w, { clientId: first.clientId });
    const live = await w.db
      .prepare(
        "SELECT count(*) AS n FROM agent_tokens WHERE admin_email = ?1 AND client_id = ?2 AND revoked_at IS NULL",
      )
      .bind(w.email, first.clientId)
      .first<number>("n");
    expect(live).toBe(1);
    await expectEnded(w, first.clientId, first.tokens);
    expect(isRefusal(await mcpPrincipal(w, second.tokens))).toBe(false);
    const revokes = await auditRows(w, "token.revoke");
    expect(
      revokes.some((r) => JSON.parse(r.detail).reason === "superseded"),
    ).toBe(true);
  });

  const revoke = (w: World, clientId: string, t: string, hint: string) =>
    w.call(
      new Request(`${API}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: t,
          token_type_hint: hint,
          client_id: clientId,
        }),
      }),
    );

  it("RFC 7009 revocation at /oauth/token ends the refresh chain and the D1 row, with token.revoke", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w);
    const r = await revoke(
      w,
      clientId,
      tokens.refresh_token ?? "",
      "refresh_token",
    );
    expect(r.status).toBe(200);
    expect((await refresh(w, clientId, tokens)).status).toBe(400);
    const row = await rowOf(w, tokens);
    expect(row?.revoked_at).not.toBeNull();
    const audit = await w.db
      .prepare(
        "SELECT * FROM admin_audit WHERE action = 'token.revoke' AND token_id = ?1",
      )
      .bind(row?.id)
      .all<Record<string, any>>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.actor_kind).toBe("token");
    expect(JSON.parse(audit.results[0]?.detail)).toMatchObject({
      tokenId: row?.id,
      kind: "oauth",
      via: "oauth_revocation",
    });
  });

  it("RFC 7009 revocation of an access token alone keeps the grant and its row", async () => {
    const w = await oauthWorld();
    const { clientId, tokens } = await grant(w);
    expect(
      (await revoke(w, clientId, tokens.access_token, "access_token")).status,
    ).toBe(200);
    expect((await rowOf(w, tokens))?.revoked_at).toBeNull();
    expect((await refresh(w, clientId, tokens)).status).toBe(200);
  });

  it("RFC 7009 revocation by another client leaves the grant and its row", async () => {
    const w = await oauthWorld();
    const { tokens } = await grant(w);
    const other = await register(w);
    expect(
      (await revoke(w, other, tokens.refresh_token ?? "", "refresh_token"))
        .status,
    ).toBe(200);
    expect((await rowOf(w, tokens))?.revoked_at).toBeNull();
  });
});
