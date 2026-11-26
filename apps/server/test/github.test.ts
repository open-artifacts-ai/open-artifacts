import { env } from "cloudflare:workers";
import {
  AUTH,
  AuthProvidersSchema,
  orderSignInMethods,
  SIGN_IN_PAGE,
} from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import {
  buildAuthorizeRedirect,
  handleCallback,
  stateCookieName,
} from "../src/auth/oidc.js";
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_EMAILS_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  githubProvider,
} from "../src/auth/providers/github.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { admit } from "../src/services/identity.js";
import { inviteReach } from "../src/services/reach.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";

const GH_CID = "Iv1.testgithubclient";
const GH_SECRET = "ghs_test_client_secret_never_log";
const GH_TOKEN = "gho_secret_access_token_never_log";
const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const withGithub = (over: Partial<Env> = {}): Env =>
  direct({
    AUTH_PROVIDERS: "google,github,email",
    GITHUB_CLIENT_ID: GH_CID,
    GITHUB_CLIENT_SECRET: GH_SECRET,
    ...over,
  });

const get = (path: string, e: Env, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );

const loc = (r: Response) => r.headers.get("location") ?? "";

const cookieVal = (r: Response, name: string) =>
  r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .split(";")[0];

type FakeGithubUser = {
  id: number;
  login: string;
  name: string | null;
};

type FakeGithubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
};

type CodeEntry = {
  challenge: string;
  user: FakeGithubUser;
  emails: FakeGithubEmail[];
  token?: string;
};

function fakeGithub() {
  const codes = new Map<string, CodeEntry>();
  const tokens = new Map<
    string,
    { user: FakeGithubUser; emails: FakeGithubEmail[] }
  >();
  const tokenCalls: URLSearchParams[] = [];
  const apiHeaders: Record<string, string | null>[] = [];
  let tokenStatus = 200;
  let userStatus = 200;
  let emailsStatus = 200;

  const realFetch = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url === GITHUB_TOKEN_URL && req.method === "POST") {
        expect(req.headers.get("accept")).toBe("application/json");
        const body = new URLSearchParams(await req.text());
        tokenCalls.push(body);
        if (tokenStatus !== 200)
          return Response.json(
            { error: "server_error" },
            { status: tokenStatus },
          );
        const code = body.get("code") ?? "";
        const entry = codes.get(code);
        codes.delete(code);
        if (!entry) return Response.json({ error: "bad_verification_code" });
        const d = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(body.get("code_verifier") ?? ""),
        );
        if (b64urlEncode(new Uint8Array(d)) !== entry.challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const token = entry.token ?? GH_TOKEN;
        tokens.set(token, { user: entry.user, emails: entry.emails });
        return Response.json({
          access_token: token,
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (req.url === GITHUB_USER_URL && req.method === "GET") {
        apiHeaders.push({
          authorization: req.headers.get("authorization"),
          accept: req.headers.get("accept"),
          "user-agent": req.headers.get("user-agent"),
        });
        if (userStatus !== 200)
          return Response.json(
            { message: "upstream error" },
            { status: userStatus },
          );
        const tok = req.headers.get("authorization")?.replace(/^Bearer /, "");
        const hit = tok ? tokens.get(tok) : undefined;
        if (!hit)
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        return Response.json(hit.user);
      }
      if (req.url === GITHUB_EMAILS_URL && req.method === "GET") {
        if (emailsStatus !== 200)
          return Response.json(
            { message: "upstream error" },
            { status: emailsStatus },
          );
        const tok = req.headers.get("authorization")?.replace(/^Bearer /, "");
        const hit = tok ? tokens.get(tok) : undefined;
        if (!hit)
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        return Response.json(hit.emails);
      }
      return realFetch(input, init);
    });

  return {
    tokenCalls,
    apiHeaders,
    issueCode(
      challenge: string,
      over: {
        user?: Partial<FakeGithubUser>;
        emails?: FakeGithubEmail[];
        token?: string;
      } = {},
    ): string {
      const code = `gh-code-${crypto.randomUUID()}`;
      codes.set(code, {
        challenge,
        user: {
          id: 424242,
          login: "octocat",
          name: "Octo Cat",
          ...over.user,
        },
        emails: over.emails ?? [
          { email: "octo@a.com", primary: true, verified: true },
        ],
        token: over.token,
      });
      return code;
    },
    setTokenStatus(s: number) {
      tokenStatus = s;
    },
    setUserStatus(s: number) {
      userStatus = s;
    },
    setEmailsStatus(s: number) {
      emailsStatus = s;
    },
    restore: () => spy.mockRestore(),
  };
}

let gh: ReturnType<typeof fakeGithub>;
beforeEach(() => {
  gh = fakeGithub();
});
afterEach(() => vi.restoreAllMocks());

async function begin(e: Env = withGithub(), next = "/a/x") {
  const r = await buildAuthorizeRedirect(e, githubProvider, next);
  const u = new URL(r.location);
  const state = u.searchParams.get("state") as string;
  const value = r.stateCookie.split(";")[0]?.split("=").slice(1).join("=");
  return {
    loc: u,
    state,
    challenge: u.searchParams.get("code_challenge") as string,
    cookie: `${await stateCookieName(e, state)}=${value}`,
  };
}

const callback = (b: { state: string; cookie: string }, code: string) =>
  new Request(`${APP}${AUTH.callbackGithub}?state=${b.state}&code=${code}`, {
    headers: { cookie: b.cookie },
  });

async function routeRoundTrip(
  e: Env,
  over: Parameters<typeof gh.issueCode>[1] = {},
  next = "/a/x",
) {
  const start = await get(
    `${AUTH.loginGithub}?next=${encodeURIComponent(next)}`,
    e,
  );
  expect(start.status).toBe(302);
  const u = new URL(loc(start));
  const stateCookie =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  const code = gh.issueCode(
    u.searchParams.get("code_challenge") as string,
    over,
  );
  return get(
    `${AUTH.callbackGithub}?state=${u.searchParams.get("state")}&code=${code}`,
    e,
    stateCookie,
  );
}

describe("github provider", () => {
  it("authorize URL: client, redirect, scope, PKCE S256, state, no nonce", async () => {
    const { loc: u } = await begin();
    expect(`${u.origin}${u.pathname}`).toBe(GITHUB_AUTHORIZE_URL);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: GH_CID,
      redirect_uri: `${APP}${AUTH.callbackGithub}`,
      scope: "read:user user:email",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.has("state")).toBe(true);
    expect(u.searchParams.has("code_challenge")).toBe(true);
    expect(u.searchParams.has("nonce")).toBe(false);
  });

  it("round trip: numeric user id as subject, primary verified email, headers sent", async () => {
    const e = withGithub();
    const b = await begin(e);
    const code = gh.issueCode(b.challenge, {
      user: { id: 987654321, login: "renamed-login", name: "Ada Lovelace" },
      emails: [
        { email: "secondary@a.com", primary: false, verified: true },
        { email: "ada@a.com", primary: true, verified: true },
      ],
    });
    const r = await handleCallback(e, githubProvider, callback(b, code));
    expect(r).toEqual({
      provider: "github",
      subject: "987654321",
      email: "ada@a.com",
      emailVerified: true,
      name: "Ada Lovelace",
      tenant: null,
      next: "/a/x",
      reauth: false,
    });
    expect(gh.tokenCalls[0]?.get("client_id")).toBe(GH_CID);
    expect(gh.tokenCalls[0]?.get("client_secret")).toBe(GH_SECRET);
    expect(gh.tokenCalls[0]?.get("redirect_uri")).toBe(
      `${APP}${AUTH.callbackGithub}`,
    );
    expect(gh.apiHeaders[0]).toEqual({
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "open-artifacts",
    });
  });

  it("refuses an unverified primary email with no fallback to verified secondary", async () => {
    const e = withGithub();
    const b = await begin(e);
    const code = gh.issueCode(b.challenge, {
      emails: [
        { email: "primary@a.com", primary: true, verified: false },
        { email: "verified-secondary@a.com", primary: false, verified: true },
      ],
    });
    await expect(
      handleCallback(e, githubProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuses when no primary email exists (no fallback to non-primary verified)", async () => {
    const e = withGithub();
    const b = await begin(e);
    const code = gh.issueCode(b.challenge, {
      emails: [
        { email: "verified-only@a.com", primary: false, verified: true },
      ],
    });
    await expect(
      handleCallback(e, githubProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("no config: authorize redirect throws 404 and routes answer 404", async () => {
    for (const e of [
      direct(),
      withGithub({ GITHUB_CLIENT_ID: "" }),
      withGithub({ GITHUB_CLIENT_SECRET: "" }),
    ]) {
      await expect(
        buildAuthorizeRedirect(e, githubProvider, "/"),
      ).rejects.toMatchObject({ code: "not_found" });
      expect((await get(AUTH.loginGithub, e)).status).toBe(404);
      expect((await get(AUTH.callbackGithub, e)).status).toBe(404);
    }
    expect(gh.tokenCalls).toHaveLength(0);
  });

  it("access token, client secret, and code never appear in logs on failure", async () => {
    const e = withGithub();
    const raw: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((s: unknown) => {
      raw.push(String(s));
    });
    vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      raw.push(String(s));
    });
    vi.spyOn(console, "info").mockImplementation((s: unknown) => {
      raw.push(String(s));
    });

    gh.setEmailsStatus(502);
    const b = await begin(e);
    const code = gh.issueCode(b.challenge);
    await handleCallback(e, githubProvider, callback(b, code)).catch(() => {});

    const text = raw.join("\n");
    expect(text).toContain("emails_http_502");
    for (const secret of [GH_TOKEN, GH_SECRET, code, b.state, "octo@a.com"])
      expect(text).not.toContain(secret);
  });
});

describe("github routes and admission", () => {
  it("happy path: a linked github subject signs in and gets a github session", async () => {
    const e = withGithub();
    const email = uniq("gh-linked");
    const uid = await seedUser(email, "member");
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at) values ('github', ?, '', ?, ?)",
    )
      .bind("777001", uid, Date.now())
      .run();

    const r = await routeRoundTrip(
      e,
      {
        user: { id: 777001, login: "linked-user", name: "Linked User" },
        emails: [{ email, primary: true, verified: true }],
      },
      "/a/abc",
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/a/abc");
    const sessVal = cookieVal(r, SESSION);
    expect(sessVal).toBeTruthy();
    const sess = await readSession(e, sessVal);
    expect(sess).toMatchObject({ uid, p: "github" });
  });

  it("first link on an invited row returns needs_code and sets the link cookie", async () => {
    const e = withGithub();
    const email = uniq("gh-invited");
    await seedUser(email, "member");

    const b = await begin(e, "/a/inv");
    const code = gh.issueCode(b.challenge, {
      user: { id: 888002, login: "invited-user", name: "Invited User" },
      emails: [{ email, primary: true, verified: true }],
    });
    const id = await handleCallback(e, githubProvider, callback(b, code));
    expect(await admit(e, authConfig(e), id)).toEqual({
      ok: false,
      reason: "needs_code",
    });

    const r = await routeRoundTrip(
      e,
      {
        user: { id: 888002, login: "invited-user", name: "Invited User" },
        emails: [{ email, primary: true, verified: true }],
      },
      "/a/inv",
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      `${SIGN_IN_PAGE}?error=needs_code&next=%2Fa%2Finv&link=1`,
    );
    expect(cookieVal(r, "oa_glink")).toBeTruthy();
  });

  it("provider list and signInMethods order github right after google", async () => {
    const e = withGithub();
    const body = AuthProvidersSchema.parse(
      await (await get(AUTH.providers, e)).json(),
    );
    expect(body.providers.map((p) => p.id)).toEqual([
      "google",
      "github",
      "email",
    ]);
    expect(body.providers[1]).toEqual({
      id: "github",
      start: AUTH.loginGithub,
    });
    expect(orderSignInMethods(["email", "access", "github", "google"])).toEqual(
      ["google", "github", "access", "email"],
    );

    const reach = await inviteReach(e, uniq("gh-reach"), "member");
    expect(reach.methods).toEqual(["google", "github"]);
  });
});
