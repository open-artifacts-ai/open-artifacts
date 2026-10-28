import { env } from "cloudflare:workers";
import {
  AUTH,
  AuthProvidersSchema,
  MeSchema,
  R,
  SIGN_IN_PAGE,
} from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import { createPat } from "../src/auth/pat.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import * as oauthApi from "../src/mcp/oauth-api.js";
import * as directory from "../src/services/directory.js";
import * as identity from "../src/services/identity.js";
import {
  direct,
  seedUser,
  TEST_BROKER_KEY,
  trial,
  uniq,
} from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";
import { login } from "./helpers.js";

// P2 Task 6: providers endpoint, Google routes, Me sign-in fields.
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);
const get = (path: string, e: Env = env, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const del = (path: string, e: Env, cookie: string) =>
  app.fetch(
    new Request(`${APP}${path}`, {
      method: "DELETE",
      headers: { cookie, "x-oa-request": "1" },
    }),
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

let g: FakeGoogle;
beforeEach(async () => {
  g = await fakeGoogle();
});
afterEach(() => vi.restoreAllMocks());

/** Starts a Google sign-in and mints a code; returns the callback path and cookie. */
async function googleCallback(
  e: Env,
  claims: Record<string, unknown> = {},
  next = "/a/x",
) {
  const start = await get(
    `${AUTH.loginGoogle}?next=${encodeURIComponent(next)}`,
    e,
  );
  expect(start.status).toBe(302);
  const u = new URL(loc(start));
  const set =
    start.headers.getSetCookie().find((c) => /oa_oidc_/.test(c)) ?? "";
  const stateCookie = set.split(";")[0] ?? "";
  /** A callback path with a freshly minted Google code for this state. */
  const fresh = () => {
    const code = g.issueCode(
      { nonce: u.searchParams.get("nonce"), ...claims },
      u.searchParams.get("code_challenge") as string,
    );
    return `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`;
  };
  return { path: fresh(), fresh, stateCookie };
}

/** Runs /auth/login/google → fake Google → /auth/callback/google. */
async function googleRoundTrip(
  e: Env,
  claims: Record<string, unknown> = {},
  next = "/a/x",
) {
  const cb = await googleCallback(e, claims, next);
  return get(cb.path, e, cb.stateCookie);
}

/** Whether the response clears an oa_oidc_ state cookie. */
const clearsState = (r: Response) =>
  r.headers
    .getSetCookie()
    .some((c) => /^oa_oidc_[^=]*=;/.test(c) && /Max-Age=0/i.test(c));

describe("GET /auth/providers", () => {
  it("email without email sending: no email provider listed, and never the problems", async () => {
    const off = direct({ EMAIL: undefined, EMAIL_FROM: undefined });
    const ids = (
      (await (await get(AUTH.providers, off)).json()) as {
        providers: { id: string }[];
      }
    ).providers.map((p) => p.id);
    expect(ids).toEqual(["google"]);
    expect(
      JSON.stringify(await (await get(AUTH.providers, off)).json()),
    ).not.toContain("problems");
  });
  it("access-only: just access, and /auth/login still goes to Access", async () => {
    const r = await get(AUTH.providers);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      mode: "access",
      providers: [{ id: "access", start: AUTH.login }],
    });
    expect(new URL(loc(await get(`${AUTH.login}?next=/`))).hostname).toBe(
      env.ACCESS_TEAM_DOMAIN,
    );
  });

  it("direct: google and email, parsed by the contract schema", async () => {
    const body = AuthProvidersSchema.parse(
      await (await get(AUTH.providers, direct())).json(),
    );
    expect(body).toEqual({
      mode: "direct",
      providers: [
        { id: "google", start: AUTH.loginGoogle, domains: ["a.com"] },
        { id: "email", domainCodes: false, guests: true },
      ],
    });
  });

  it("trial: domain codes on and the Turnstile site key", async () => {
    expect(await (await get(AUTH.providers, trial())).json()).toEqual({
      mode: "direct",
      providers: [
        { id: "email", domainCodes: true, guests: true, turnstileSiteKey: "k" },
      ],
    });
  });

  it("only fully configured providers; never secrets or problems", async () => {
    const r = await get(AUTH.providers, direct({ GOOGLE_CLIENT_SECRET: "" }));
    const text = await r.text();
    expect(JSON.parse(text).providers.map((p: { id: string }) => p.id)).toEqual(
      ["email"],
    );
    expect(text).not.toContain("problem");
  });

  const ids = async (e: Env) =>
    (
      (await (await get(AUTH.providers, e)).json()) as {
        providers: { id: string }[];
      }
    ).providers.map((p) => p.id);
  const broker = (over: Partial<Env> = {}) =>
    direct({
      AUTH_BROKER_URL: "https://auth.h.test",
      BROKER_SIGNING_KEY: TEST_BROKER_KEY,
      GOOGLE_CLIENT_SECRET: "",
      ...over,
    });

  it.each([
    ["no INSTALL_ID", { INSTALL_ID: "" }],
    ["no signing key", { BROKER_SIGNING_KEY: "" }],
    ["a bad signing key", { BROKER_SIGNING_KEY: "nope" }],
    ["a non-https broker", { AUTH_BROKER_URL: "http://auth.h.test" }],
  ])("a half-configured broker (%s) never lists Google", async (_, over) => {
    expect(await ids(broker(over))).toEqual(["email"]);
  });

  it("a fully configured broker lists Google", async () => {
    expect(await ids(broker())).toEqual(["google", "email"]);
  });

  it("does no D1 work, even with a session cookie", async () => {
    const { cookie } = await login(uniq("prov"));
    const spy = vi.spyOn(env.DB, "prepare");
    await get(AUTH.providers, env, cookie);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("direct-mode sign-in routes", () => {
  it("/auth/login goes to the SPA sign-in page with a safe next", async () => {
    expect(loc(await get(`${AUTH.login}?next=/a/x`, direct()))).toBe(
      `${SIGN_IN_PAGE}?next=%2Fa%2Fx`,
    );
    expect(loc(await get(`${AUTH.login}?next=//evil.com`, direct()))).toBe(
      `${SIGN_IN_PAGE}?next=%2F`,
    );
  });

  it("Google is 404 when it isn't configured", async () => {
    expect(
      (await get(AUTH.loginGoogle, direct({ AUTH_DOMAINS: "" }))).status,
    ).toBe(404);
    expect((await get(AUTH.loginGoogle, env)).status).toBe(404);
  });

  it("round trip: session p=google t=a.com, 7 days, redirect to next", async () => {
    const e = direct();
    const email = uniq("bob");
    const r = await googleRoundTrip(e, { email, sub: `rt-${email}` });
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/a/x");
    const set = r.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`));
    expect(set).toContain("Max-Age=604800");
    expect(await readSession(e, cookieVal(r, SESSION))).toMatchObject({
      p: "google",
      t: "a.com",
      e: 0,
    });
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it.each([
    ["tenant", { hd: "b.com" }],
    ["failed", { aud: "other" }],
  ])(
    "refusal %s lands on the sign-in page with next, no session",
    async (reason, claims) => {
      const r = await googleRoundTrip(direct(), {
        email: uniq("x"),
        ...claims,
      });
      expect(loc(r)).toBe(`${SIGN_IN_PAGE}?error=${reason}&next=%2Fa%2Fx`);
      expect(cookieVal(r, SESSION)).toBeUndefined();
    },
  );

  it("identity_conflict, removed and no_access land on the sign-in page too", async () => {
    const a = uniq("conf");
    await seedUser(a, "member", { googleSub: `old-${a}` });
    expect(
      loc(await googleRoundTrip(direct(), { email: a, sub: `new-${a}` })),
    ).toBe(`${SIGN_IN_PAGE}?error=identity_conflict&next=%2Fa%2Fx`);
    const b = uniq("gone");
    await seedUser(b, "member", { status: "removed" });
    expect(
      loc(await googleRoundTrip(direct(), { email: b, sub: `s-${b}` })),
    ).toBe(`${SIGN_IN_PAGE}?error=removed&next=%2Fa%2Fx`);
    const c = uniq("nope");
    expect(
      loc(
        await googleRoundTrip(direct({ AUTH_DOMAIN_JOIN: "invite" }), {
          email: c,
          sub: `s-${c}`,
        }),
      ),
    ).toBe(`${SIGN_IN_PAGE}?error=no_access&next=%2Fa%2Fx`);
  });

  it("a stale state retries once, then expired on the sign-in page", async () => {
    const first = await get(`${AUTH.callbackGoogle}?state=s&code=c`, direct());
    expect(loc(first)).toBe(`${AUTH.loginGoogle}?next=%2F&retry=1`);
    const second = await get(
      `${AUTH.callbackGoogle}?state=r1.s&code=c`,
      direct(),
    );
    expect(loc(second)).toBe(`${SIGN_IN_PAGE}?error=expired&next=%2F`);
  });

  it("no COOP on the sign-in page and the Google routes", async () => {
    for (const p of [SIGN_IN_PAGE, AUTH.loginGoogle, AUTH.callbackGoogle])
      expect(
        (await get(p, direct())).headers.get("cross-origin-opener-policy"),
      ).toBeNull();
  });

  it("MCP connector: authorize → login → sign-in page → Google → back to authorize", async () => {
    const authorize = "/oauth/authorize?client_id=c&response_type=code";
    const toSignIn = loc(
      await get(
        `${AUTH.login}?next=${encodeURIComponent(authorize)}`,
        direct(),
      ),
    );
    const next = new URL(toSignIn, APP).searchParams.get("next") as string;
    expect(next).toBe(authorize);
    const email = uniq("mcp");
    expect(
      loc(await googleRoundTrip(direct(), { email, sub: `m-${email}` }, next)),
    ).toBe(authorize);
  });

  it("onGoogleSignIn runs once after admission, never on refusal; a failure doesn't block", async () => {
    const spy = vi.spyOn(directory, "onGoogleSignIn").mockResolvedValue();
    const email = uniq("dir");
    await googleRoundTrip(direct(), { email, sub: `d-${email}` });
    expect(spy).toHaveBeenCalledOnce();
    await googleRoundTrip(direct(), { email: uniq("t"), hd: "b.com" });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRejectedValue(new Error("down"));
    const e2 = uniq("dir2");
    expect(
      loc(await googleRoundTrip(direct(), { email: e2, sub: `d-${e2}` })),
    ).toBe("/a/x");
  });

  it("a non-ApiError in the callback lands on failed and clears the state cookie", async () => {
    vi.spyOn(identity, "admit").mockRejectedValue(new Error("d1 down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await googleRoundTrip(direct(), { email: uniq("boom") });
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(`${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`);
    expect(clearsState(r)).toBe(true);
    expect(cookieVal(r, SESSION)).toBeUndefined();
  });

  it("a non-zero epoch round trips: the session carries it and is accepted", async () => {
    const e = direct();
    const email = uniq("ep");
    const uid = await seedUser(email, "member", { googleSub: `ep-${email}` });
    await env.DB.prepare("update users set session_epoch = 3 where id = ?")
      .bind(uid)
      .run();
    const r = await googleRoundTrip(e, { email, sub: `ep-${email}` });
    expect(loc(r)).toBe("/a/x");
    expect(await readSession(e, cookieVal(r, SESSION))).toMatchObject({
      uid,
      e: 3,
    });
    expect(
      (await get(R.me, e, `${SESSION}=${cookieVal(r, SESSION)}`)).status,
    ).toBe(200);
  });

  it("a replayed callback is refused: no second session", async () => {
    const e = direct();
    const email = uniq("replay");
    const cb = await googleCallback(e, { email, sub: `rp-${email}` });
    const first = await get(cb.path, e, cb.stateCookie);
    expect(cookieVal(first, SESSION)).toBeDefined();
    const again = await get(cb.path, e, cb.stateCookie);
    expect(loc(again)).toBe(`${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`);
    expect(cookieVal(again, SESSION)).toBeUndefined();
    expect(clearsState(again)).toBe(true);
  });

  it("the same state cookie with a fresh Google code is refused (single use server-side)", async () => {
    const e = direct();
    const email = uniq("replay2");
    const cb = await googleCallback(e, { email, sub: `rp2-${email}` });
    const first = await get(cb.path, e, cb.stateCookie);
    expect(cookieVal(first, SESSION)).toBeDefined();
    const calls = g.tokenCalls.length;
    const again = await get(cb.fresh(), e, cb.stateCookie);
    expect(loc(again)).toBe(`${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`);
    expect(cookieVal(again, SESSION)).toBeUndefined();
    expect(clearsState(again)).toBe(true);
    // Refused before the code is redeemed at Google.
    expect(g.tokenCalls.length).toBe(calls);
  });

  it.each(["removed", "suspended"])(
    "a %s user's Google sign-in lands on error=removed (linked or not)",
    async (status) => {
      const a = uniq(`na-${status}`);
      await seedUser(a, "member", { status, googleSub: `na-${a}` });
      expect(
        loc(await googleRoundTrip(direct(), { email: a, sub: `na-${a}` })),
      ).toBe(`${SIGN_IN_PAGE}?error=removed&next=%2Fa%2Fx`);
      const b = uniq(`nb-${status}`);
      await seedUser(b, "member", { status });
      const r = await googleRoundTrip(direct(), { email: b, sub: `nb-${b}` });
      expect(loc(r)).toBe(`${SIGN_IN_PAGE}?error=removed&next=%2Fa%2Fx`);
      expect(cookieVal(r, SESSION)).toBeUndefined();
    },
  );

  it("broker transport: login goes to the broker with this install's id", async () => {
    const e = direct({
      AUTH_BROKER_URL: "https://auth.h.test",
      BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    });
    const u = new URL(loc(await get(AUTH.loginGoogle, e)));
    expect(`${u.origin}${u.pathname}`).toBe(
      "https://auth.h.test/google/authorize",
    );
    expect(u.searchParams.get("install")).toBe("inst-a");
    expect(u.searchParams.get("client_id")).toBeNull();
  });
});

describe("Me sign-in fields", () => {
  const me = async (e: Env, auth: string) => {
    const headers: Record<string, string> = auth.startsWith("oa_pat_")
      ? { authorization: `Bearer ${auth}` }
      : { cookie: auth };
    return MeSchema.parse(
      await (
        await app.fetch(new Request(`${APP}${R.me}`, { headers }), e, ctx)
      ).json(),
    );
  };

  it("access-only installs omit them (shape unchanged)", async () => {
    const { cookie } = await login(uniq("plain"));
    const m = await me(env, cookie);
    expect(m.auth).toBeUndefined();
    expect(m.instance.hosted).toBeUndefined();
    expect(m.instance.signIn).toBeUndefined();
  });

  it("direct: auth for a session and a PAT, signIn, features, hosted", async () => {
    const e = direct({
      HOSTED: "1",
      FEATURES: "spaces",
      AUTH_BROKER_URL: "https://auth.h.test",
      BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    });
    const { cookie, userId } = await login(uniq("me"));
    const m = await me(e, cookie);
    expect(m.auth).toMatchObject({
      method: "access",
      readOnly: false,
      cap: null,
    });
    expect(typeof m.auth?.expiresAt).toBe("string");
    expect(m.instance).toMatchObject({
      hosted: true,
      signIn: { mode: "direct", providers: ["google", "email"] },
      features: ["spaces", "guests_read_only"],
    });
    const pat = await createPat(e, userId, "t");
    expect((await me(e, pat.token)).auth).toEqual({
      method: "pat",
      readOnly: false,
      cap: null,
      expiresAt: null,
    });
  });

  // Review item 35: owners see why configured sign-in is off; nobody else does.
  it("signIn.problems: owners only, verbatim; empty when nothing is wrong", async () => {
    const owner = await login(uniq("own"), "owner");
    const member = await login(uniq("mem"));
    const off = direct({ EMAIL: undefined, EMAIL_FROM: undefined });
    const o = await me(off, owner.cookie);
    expect(o.instance.signIn?.problems).toEqual(authConfig(off).problems);
    expect(o.instance.signIn?.problems?.[0]).toMatch(
      /^Email sign-in is on, but sending email isn't set up/,
    );
    // Codes aren't offered when the install can't send email.
    expect(o.instance.signIn?.providers).toEqual(["google"]);
    expect((await me(off, member.cookie)).instance.signIn).not.toHaveProperty(
      "problems",
    );
    expect(
      (await me(direct(), owner.cookie)).instance.signIn?.problems,
    ).toEqual([]);
  });

  it("tier: the hosted install's TIER; null off hosted, or for an unknown value; absent access-only", async () => {
    const { cookie } = await login(uniq("tier"));
    const hosted = (TIER?: string) =>
      direct({
        HOSTED: "1",
        AUTH_BROKER_URL: "https://auth.h.test",
        BROKER_SIGNING_KEY: TEST_BROKER_KEY,
        ...(TIER === undefined ? {} : { TIER }),
      });
    for (const t of ["trial", "team", "business"] as const)
      expect((await me(hosted(t), cookie)).instance.tier).toBe(t);
    expect((await me(hosted(), cookie)).instance.tier).toBeNull();
    // An unknown value is null and logged (the value is ours, never secret,
    // but the line carries only the event).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await me(hosted("enterprise"), cookie)).instance.tier).toBeNull();
      expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
        { evt: "tier_unknown" },
      ]);
      warn.mockClear();
      // Unset is not a misconfiguration: no line.
      await me(hosted(), cookie);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    // Self-hosted direct sign-in: never a tier, whatever TIER says.
    expect(
      (await me(direct({ TIER: "team" }), cookie)).instance.tier,
    ).toBeNull();
    // Reported only: features still follow FEATURES (provisioning derives them).
    expect((await me(hosted("team"), cookie)).instance.features).not.toContain(
      "sync_frozen",
    );
    // Access-only installs keep today's shape.
    expect((await me(env, cookie)).instance.tier).toBeUndefined();
  });

  it("a guest under direct sign-in is read-only with cap guest", async () => {
    const { cookie } = await login(uniq("guest", "x.com"), "guest");
    expect((await me(direct(), cookie)).auth).toMatchObject({
      readOnly: true,
      cap: "guest",
    });
  });

  // #792 (A): item 34 refuses restricted members' PATs only; a guest's PAT
  // keeps main's REST behaviour (capped, read-only) until #609 decides.
  it("a guest's PAT is capped too (REST behaviour unchanged by item 34)", async () => {
    const e = direct();
    const { userId } = await login(uniq("gpat", "x.com"), "guest");
    const pat = await createPat(e, userId, "t");
    expect((await me(e, pat.token)).auth).toEqual({
      method: "pat",
      readOnly: true,
      cap: "guest",
      expiresAt: null,
    });
  });
});

describe("DELETE R.memberIdentity", () => {
  it("owner or admin resets a member's link; members get 404; never the owner's", async () => {
    const e = direct();
    const admin = await login(uniq("adm"), "admin");
    const mem = await login(uniq("mem"), "member");
    const target = await seedUser(uniq("tgt"), "member", {
      googleSub: `t-${crypto.randomUUID()}`,
    });
    expect(
      (await del(R.memberIdentity(target, "google"), e, mem.cookie)).status,
    ).toBe(404);
    expect(
      (await del(R.memberIdentity(target, "google"), e, admin.cookie)).status,
    ).toBe(204);
    expect(
      (await del(R.memberIdentity(target, "google"), e, admin.cookie)).status,
    ).toBe(404);
    const owner = await seedUser(uniq("own"), "owner", {
      googleSub: `o-${crypto.randomUUID()}`,
    });
    // An admin acting on the owner: 403 owner_only (#475).
    expect(
      (await del(R.memberIdentity(owner, "google"), e, admin.cookie)).status,
    ).toBe(403);
  });

  it("ends the target's sessions (epoch bump) and revokes their PATs and OAuth grants", async () => {
    const e = direct();
    const admin = await login(uniq("adm2"), "admin");
    const email = uniq("tgt2");
    const target = await seedUser(email, "member", {
      googleSub: `t2-${email}`,
    });
    const signedIn = await googleRoundTrip(e, { email, sub: `t2-${email}` });
    const cookie = `${SESSION}=${cookieVal(signedIn, SESSION)}`;
    const pat = await createPat(e, target, "t");
    const bearer = (t: string) =>
      app.fetch(
        new Request(`${APP}${R.me}`, {
          headers: { authorization: `Bearer ${t}` },
        }),
        e,
        ctx,
      );
    expect((await get(R.me, e, cookie)).status).toBe(200);
    expect((await bearer(pat.token)).status).toBe(200);
    const grants = vi.spyOn(oauthApi, "revokeAllGrants");
    expect(
      (await del(R.memberIdentity(target, "google"), e, admin.cookie)).status,
    ).toBe(204);
    const row = await env.DB.prepare(
      "select session_epoch e from users where id = ?",
    )
      .bind(target)
      .first<{ e: number }>();
    expect(row?.e).toBe(1);
    expect((await get(R.me, e, cookie)).status).toBe(401);
    expect((await bearer(pat.token)).status).toBe(401);
    expect(grants).toHaveBeenCalledWith(expect.anything(), target);
  });
});
