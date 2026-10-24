// Agent identity cards: approval facts on the grant, usage per grant and
// token (last use at most once a minute, client version, versions published)
// and owner labels (PATCH).
import { env } from "cloudflare:workers";
import {
  newId,
  type OAuthClient,
  OAuthClientSchema,
  R,
  type Token,
  TokenSchema,
} from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import {
  redirectInfo,
  resetTouchMemo,
  touchGrant,
  uaFamily,
} from "../src/services/agent-usage.js";
import { api, errOf, login } from "./helpers.js";
import { APP, callWorker, connect, nextIp, tool } from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("redirectInfo: from the redirect URI only", () => {
  it.each([
    ["http://localhost:3333/cb", { redirectKind: "computer" }],
    ["http://127.0.0.1:8080/cb", { redirectKind: "computer" }],
    ["http://[::1]:9000/cb", { redirectKind: "computer" }],
    ["https://localhost/cb", { redirectKind: "computer" }],
    ["http://app.localhost/cb", { redirectKind: "computer" }],
    ["com.example.app:/oauth", { redirectKind: "computer" }],
    ["cursor://anysphere.cursor-mcp/oauth", { redirectKind: "computer" }],
    [
      "https://Claude.AI/api/mcp/auth_callback",
      { redirectKind: "hosted", redirectHost: "claude.ai" },
    ],
  ])("%s", (uri, want) => {
    expect(redirectInfo(uri)).toEqual(want);
  });
});

describe("uaFamily: coarse families only", () => {
  it.each([
    [CHROME_MAC, { browser: "chrome", os: "macos" }],
    [SAFARI_IOS, { browser: "safari", os: "ios" }],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      { browser: "edge", os: "windows" },
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      { browser: "firefox", os: "linux" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      { browser: "chrome", os: "android" },
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      { browser: "chrome", os: "chromeos" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/114.0.0.0",
      { browser: "other", os: "windows" },
    ],
    ["curl/8.7.1", { browser: "other", os: "other" }],
    [null, { browser: "other", os: "other" }],
  ])("%s", (ua, want) => {
    expect(uaFamily(ua)).toEqual(want);
  });
});

// ------------------------------------------------------------------ OAuth

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Register (with `meta`) → consent approve (as `ua`) → token. */
async function grant(
  email: string,
  opts: {
    redirect?: string;
    meta?: Record<string, unknown>;
    ua?: string;
    member?: { cookie: string; userId: string };
  } = {},
) {
  const redirect = opts.redirect ?? "http://localhost:3333/cb";
  const member = opts.member ?? (await login(email));
  const reg = await callWorker(
    new Request(`${APP}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
      },
      body: JSON.stringify({
        client_name: "Card Agent",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...opts.meta,
      }),
    }),
  );
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const ua = opts.ua ?? CHROME_MAC;
  const page = await callWorker(
    new Request(
      `${APP}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s",
        resource: `${APP}/mcp`,
      })}`,
      { headers: { cookie: member.cookie, "user-agent": ua } },
    ),
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const field = (n: string) =>
    new RegExp(`name="${n}" value="([^"]*)"`).exec(html)?.[1] ?? "";
  const cookies = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "");
  const body = new URLSearchParams({
    csrf: field("csrf"),
    request: field("request"),
    decision: "approve",
  }).toString();
  const r = await callWorker(
    new Request(`${APP}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie: [member.cookie, ...cookies].join("; "),
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        "user-agent": ua,
        "cf-connecting-ip": "203.0.113.9",
      },
      body,
    }),
  );
  expect(r.status).toBe(302);
  const code = new URL(r.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const t = await callWorker(
    new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextIp(),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: redirect,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${APP}/mcp`,
      }).toString(),
    }),
  );
  expect(t.status).toBe(200);
  const { access_token } = (await t.json()) as { access_token: string };
  const [card] = await clients(member.cookie);
  return { member, accessToken: access_token, card: card as OAuthClient };
}

const clients = async (cookie: string) =>
  (await (await api(app, R.oauthClients, cookie)).json()) as OAuthClient[];

const usageRow = (grantId: string) =>
  env.DB.prepare(
    "select last_used_at as at, client_version as v, versions_published as n from agent_grants where grant_id = ?",
  )
    .bind(grantId)
    .first<{ at: number | null; v: string | null; n: number }>();

describe("approval facts on the grant", () => {
  it("a loopback redirect is a computer, with the approving browser family", async () => {
    const { card } = await grant(`card-loop-${tag}@x.com`);
    expect(OAuthClientSchema.parse(card)).toEqual({
      grantId: card.grantId,
      clientName: "Card Agent",
      createdAt: card.createdAt,
      redirectKind: "computer",
      approvedFrom: { browser: "chrome", os: "macos" },
      versionsPublished: 0,
    });
  });

  it("an https client_uri never makes a loopback redirect hosted", async () => {
    const { card } = await grant(`card-meta-${tag}@x.com`, {
      meta: {
        client_uri: "https://evil.example",
        logo_uri: "https://evil.example/logo.png",
      },
      ua: SAFARI_IOS,
    });
    expect(card.redirectKind).toBe("computer");
    expect(card).not.toHaveProperty("redirectHost");
    expect(card.approvedFrom).toEqual({ browser: "safari", os: "ios" });
  });

  it("an https redirect is hosted, with its host", async () => {
    const { card } = await grant(`card-https-${tag}@x.com`, {
      redirect: "https://Agent.Example.com/oauth/cb",
    });
    expect(card.redirectKind).toBe("hosted");
    expect(card.redirectHost).toBe("agent.example.com");
  });

  it("no raw User-Agent or IP lands in the grant record", async () => {
    const { member } = await grant(`card-raw-${tag}@x.com`);
    const keys = await env.OAUTH_KV.list({ prefix: `grant:${member.userId}:` });
    expect(keys.keys).toHaveLength(1);
    const raw = await env.OAUTH_KV.get(keys.keys[0]?.name ?? "");
    expect(raw).not.toContain("Mozilla");
    expect(raw).not.toContain("203.0.113.9");
  });

  it("a grant from before identity cards lists without the new fields", async () => {
    const { member, card } = await grant(`card-old-${tag}@x.com`);
    const key = `grant:${member.userId}:${card.grantId}`;
    const rec = JSON.parse((await env.OAUTH_KV.get(key)) ?? "{}");
    rec.metadata = { clientName: "Old Agent" };
    await env.OAUTH_KV.put(key, JSON.stringify(rec));
    const [old] = await clients(member.cookie);
    expect(old).toEqual({
      grantId: card.grantId,
      clientName: "Old Agent",
      createdAt: card.createdAt,
    });
  });
});

describe("grant usage", () => {
  beforeEach(() => resetTouchMemo());

  it("MCP requests record last use and clientInfo.version", async () => {
    const { member, accessToken, card } = await grant(`card-use-${tag}@x.com`);
    expect(await usageRow(card.grantId)).toBeNull();
    const c = await connect(accessToken, {
      clientInfo: { name: "x", version: "2.1.0" },
    });
    await c.listTools();
    await c.close();
    const row = await usageRow(card.grantId);
    expect(row?.v).toBe("2.1.0");
    expect(row?.at).toBeGreaterThan(Date.now() - 60_000);
    const [listed] = await clients(member.cookie);
    expect(listed?.clientVersion).toBe("2.1.0");
    expect(listed?.lastUsedAt).toBe(new Date(row?.at ?? 0).toISOString());
  });

  it("last use is written at most once a minute; a new version always", async () => {
    const { member, card } = await grant(`card-min-${tag}@x.com`);
    const t0 = Date.now();
    const write = async (at: number, v: string | null) => {
      const before = await usageRow(card.grantId);
      resetTouchMemo();
      await touchGrant(env, card.grantId, member.userId, v, at);
      return { before, after: await usageRow(card.grantId) };
    };
    await write(t0, "1.0.0");
    expect((await usageRow(card.grantId))?.at).toBe(t0);
    // Within the minute: the conditional upsert changes nothing.
    expect((await write(t0 + 30_000, "1.0.0")).after?.at).toBe(t0);
    expect((await write(t0 + 30_000, null)).after).toMatchObject({
      at: t0,
      v: "1.0.0",
    });
    // A minute on: written.
    expect((await write(t0 + 60_000, null)).after).toMatchObject({
      at: t0 + 60_000,
      v: "1.0.0",
    });
    // A version change within the minute: written.
    expect((await write(t0 + 70_000, "1.1.0")).after).toMatchObject({
      at: t0 + 70_000,
      v: "1.1.0",
    });
  });

  it("the per-isolate memo skips D1 within the minute", async () => {
    const { member, card } = await grant(`card-memo-${tag}@x.com`);
    const t0 = Date.now();
    let runs = 0;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "prepare")
          return (sql: string) => {
            runs++;
            return t.prepare(sql);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const e = { ...(env as object), DB } as typeof env;
    await touchGrant(e, card.grantId, member.userId, "1", t0);
    const first = runs;
    expect(first).toBe(1);
    for (let i = 1; i <= 5; i++)
      await touchGrant(e, card.grantId, member.userId, "1", t0 + i * 1000);
    await touchGrant(e, card.grantId, member.userId, null, t0 + 6000);
    expect(runs).toBe(first);
  });

  it("someone else's grant id never moves another user's row", async () => {
    const { member, card } = await grant(`card-iso-${tag}@x.com`);
    const t0 = Date.now();
    await touchGrant(env, card.grantId, member.userId, "1", t0);
    resetTouchMemo();
    await touchGrant(env, card.grantId, "someone-else", "9", t0 + 120_000);
    expect(await usageRow(card.grantId)).toMatchObject({ at: t0, v: "1" });
  });
});

// ------------------------------------------------------- versionsPublished

const viaOf = (id: string, v: number) =>
  env.DB.prepare(
    "select agent_via as via from versions where artifact_id = ? and version = ?",
  )
    .bind(id, v)
    .first<{ via: string | null }>();

describe("versions published", () => {
  it("counts publishes and restores through the grant, and attributes each version", async () => {
    const { member, accessToken, card } = await grant(`card-pub-${tag}@x.com`);
    const c = await connect(accessToken);
    const pub = (
      await tool(c, "publish_artifact", {
        title: "p",
        format: "markdown",
        content: "# 1",
      })
    ).structuredContent as { id: string };
    await tool(c, "publish_artifact", {
      id: pub.id,
      format: "markdown",
      content: "# 2",
    });
    await tool(c, "restore_version", { id: pub.id, version: 1 });
    await c.close();
    expect(await viaOf(pub.id, 1)).toEqual({ via: `g:${card.grantId}` });
    expect(await viaOf(pub.id, 3)).toEqual({ via: `g:${card.grantId}` });
    expect((await usageRow(card.grantId))?.n).toBe(3);
    const [listed] = await clients(member.cookie);
    expect(listed?.versionsPublished).toBe(3);
  });

  it("a failed publish through the grant counts nothing", async () => {
    const { accessToken, card } = await grant(`card-fail-${tag}@x.com`);
    const c = await connect(accessToken);
    const r = await tool(c, "publish_artifact", {
      id: "nonexistent00000",
      format: "markdown",
      content: "# x",
    });
    expect(r.isError).toBe(true);
    await c.close();
    expect((await usageRow(card.grantId))?.n ?? 0).toBe(0);
  });

  it("counts publishes with a token, over REST and MCP; a session counts nothing", async () => {
    const u = await login(`card-pat-${tag}@x.com`);
    const { id: tokenId, token } = await createPat(env, u.userId, "ci");
    const r = await api(app, R.artifacts, token, {
      method: "POST",
      body: { title: "t", format: "markdown", content: "# t" },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(await viaOf(id, 1)).toEqual({ via: `t:${tokenId}` });
    const c = await connect(token);
    await tool(c, "publish_artifact", {
      id,
      format: "markdown",
      content: "# t2",
    });
    await c.close();
    await api(app, R.versions(id), u.cookie, {
      method: "POST",
      body: { format: "markdown", content: "# t3" },
    });
    expect(await viaOf(id, 3)).toEqual({ via: null });
    const list = (await (
      await api(app, R.tokens, u.cookie)
    ).json()) as Token[];
    expect(TokenSchema.parse(list[0])).toMatchObject({
      id: tokenId,
      versionsPublished: 2,
    });
  });
});

// ------------------------------------------------------------------ labels

describe("PATCH labels", () => {
  it("grant: owner sets a cleaned label, null clears it, others get 404", async () => {
    const { member, card } = await grant(`card-lbl-${tag}@x.com`);
    const patch = (cookie: string, body: unknown, id = card.grantId) =>
      api(app, R.oauthClient(id), cookie, { method: "PATCH", body });
    const set = await patch(member.cookie, {
      label: " \u202eWork\u200b laptop ",
    });
    expect(set.status).toBe(200);
    expect(OAuthClientSchema.parse(await set.json()).label).toBe(
      "Work laptop",
    );
    expect((await clients(member.cookie))[0]?.label).toBe("Work laptop");
    const other = await login(`card-lbl2-${tag}@x.com`);
    expect((await patch(other.cookie, { label: "mine" })).status).toBe(404);
    expect((await patch(member.cookie, { label: "x" }, "nope")).status).toBe(
      404,
    );
    expect((await clients(member.cookie))[0]?.label).toBe("Work laptop");
    const cleared = await patch(member.cookie, { label: null });
    expect(await cleared.json()).not.toHaveProperty("label");
    expect((await clients(member.cookie))[0]).not.toHaveProperty("label");
    for (const bad of [
      { label: "x".repeat(61) },
      { label: "\u2066" },
      {},
      { label: "a", clientName: "spoof" },
    ]) {
      const r = await patch(member.cookie, bad);
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("bad_request");
    }
  });

  it("grant: revoking drops its usage row", async () => {
    const { member, card } = await grant(`card-rv-${tag}@x.com`);
    await api(app, R.oauthClient(card.grantId), member.cookie, {
      method: "PATCH",
      body: { label: "l" },
    });
    expect(await usageRow(card.grantId)).not.toBeNull();
    const d = await api(app, R.oauthClient(card.grantId), member.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    expect(await usageRow(card.grantId)).toBeNull();
  });

  it("token: owner renames 1-80 characters; others, revoked and null are refused", async () => {
    const u = await login(`card-tl-${tag}@x.com`);
    const { id } = await createPat(env, u.userId, "old");
    const patch = (cookie: string, body: unknown) =>
      api(app, R.token(id), cookie, { method: "PATCH", body });
    const ok = await patch(u.cookie, { label: ` ${"y".repeat(80)}\u0007 ` });
    expect(ok.status).toBe(200);
    expect(TokenSchema.parse(await ok.json())).toMatchObject({
      id,
      label: "y".repeat(80),
      versionsPublished: 0,
    });
    expect((await patch(u.cookie, { label: "y".repeat(81) })).status).toBe(
      400,
    );
    expect((await patch(u.cookie, { label: null })).status).toBe(400);
    const other = await login(`card-tl2-${tag}@x.com`);
    expect((await patch(other.cookie, { label: "z" })).status).toBe(404);
    await api(app, R.token(id), u.cookie, { method: "DELETE" });
    expect((await patch(u.cookie, { label: "z" })).status).toBe(404);
  });
});
