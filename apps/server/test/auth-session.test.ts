import { env } from "cloudflare:workers";
import { AUTH } from "@oa/shared";
import type { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { deriveKey, secretProblems } from "../src/auth/keys.js";
import {
  buildAuthorizeRedirect,
  handleCallback,
  LEGACY_KEY_UNTIL,
  OidcStateError,
  stateCookieName,
} from "../src/auth/oidc.js";
import type { OidcProvider } from "../src/auth/providers/types.js";
import { mw } from "../src/auth/route-policy.js";
import {
  readSession,
  sessionCookie,
  sessionCookieName,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { type AppVariables, session } from "../src/http/middleware.js";
import { b64urlEncode, hmacSign, hmacVerify } from "../src/util/crypto.js";
import { direct, trial } from "./auth-helpers.js";
import { login } from "./helpers.js";

// P2 Task 2: provider interface, derived-key cookies, session epoch and tenant.
const UID = "abcdefghjkmnpqrs";
const now = 1_700_000_000_000;
const WEEK = 7 * 86400_000;
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const SESSION = sessionCookieName(env);

const legacySign = async (payload: object) => {
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${p}.${await hmacSign(env.SESSION_SECRET, p)}`;
};
const derivedSign = async (payload: object) => {
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${p}.${await hmacSign(await deriveKey(env, "oa:session"), p)}`;
};

const probe = createApp(
  (a) => {
    const g = a as unknown as Hono<{ Bindings: Env; Variables: AppVariables }>;
    g.use("/probe", mw(session()));
    g.get("/probe", (c) =>
      c.json({
        user: c.var.user?.id ?? null,
        method: c.var.authMethod,
        exp: c.var.sessionExp,
      }),
    );
  },
  // The route gate (P3 T5) needs a rule for a test-only route.
  { "GET /probe": { public: "test session probe" } },
);
const who = async (value: string, e: Env = env) =>
  (await (
    await probe.fetch(
      new Request("http://app.localhost/probe", {
        headers: { cookie: `${SESSION}=${value}` },
      }),
      e,
      ctx,
    )
  ).json()) as {
    user: string | null;
    method: string | null;
    exp: number | null;
  };

describe("session payload", () => {
  it("signSession keeps positional now and writes iat, p, e", async () => {
    const v = await signSession(env, UID, now, {
      provider: "access",
      epoch: 0,
    });
    expect(await readSession(env, v, now + 1)).toEqual({
      uid: UID,
      exp: now + WEEK,
      iat: now,
      p: "access",
      e: 0,
    });
  });

  it("carries provider, tenant, epoch and a custom max age", async () => {
    const v = await signSession(env, UID, now, {
      provider: "google",
      tenant: "a.com",
      epoch: 3,
      maxAgeS: 86400,
    });
    expect(await readSession(env, v, now + 1)).toEqual({
      uid: UID,
      exp: now + 86400_000,
      iat: now,
      p: "google",
      t: "a.com",
      e: 3,
    });
  });

  it("is signed with the derived key, not the raw secret", async () => {
    const [p, sig] = (
      await signSession(env, UID, now, { provider: "access", epoch: 0 })
    ).split(".") as [string, string];
    expect(await hmacVerify(await deriveKey(env, "oa:session"), p, sig)).toBe(
      true,
    );
    expect(await hmacVerify(env.SESSION_SECRET, p, sig)).toBe(false);
  });

  it("legacy raw-secret cookies read until LEGACY_KEY_UNTIL, then not", async () => {
    const old = await legacySign({ uid: UID, exp: LEGACY_KEY_UNTIL + WEEK });
    expect(await readSession(env, old, LEGACY_KEY_UNTIL - 1)).toEqual({
      uid: UID,
      exp: LEGACY_KEY_UNTIL + WEEK,
      iat: LEGACY_KEY_UNTIL,
      p: "access",
      e: 0,
    });
    expect(await readSession(env, old, LEGACY_KEY_UNTIL)).toBeNull();
  });

  it("rejects validly signed payloads with a bad provider, tenant or epoch", async () => {
    for (const extra of [
      { p: "saml" },
      { t: 5 },
      { e: -1 },
      { e: 1.5 },
      { e: "1" },
    ])
      expect(
        await readSession(
          env,
          await derivedSign({ uid: UID, exp: now + 1000, ...extra }),
          now,
        ),
      ).toBeNull();
  });

  it("sessionCookie takes Max-Age as a parameter", () => {
    expect(sessionCookie("v", env, 86400)).toContain("Max-Age=86400");
    expect(sessionCookie("v", env)).toContain("Max-Age=604800");
  });
});

describe("session middleware", () => {
  const setEpoch = (id: string, e: number) =>
    env.DB.prepare("update users set session_epoch = ? where id = ?")
      .bind(e, id)
      .run();

  it("sets authMethod and sessionExp from the cookie", async () => {
    const { userId } = await login("t2-who@a.com");
    const v = await signSession(env, userId, Date.now(), {
      provider: "dev",
      epoch: 0,
    });
    const r = await who(v);
    expect(r.user).toBe(userId);
    expect(r.method).toBe("dev");
    expect(r.exp).toBe((await readSession(env, v))?.exp);
  });

  it("an epoch bump ends the session", async () => {
    const { userId } = await login("t2-bump@a.com");
    const v = await signSession(env, userId, Date.now(), {
      provider: "access",
      epoch: 0,
    });
    expect((await who(v)).user).toBe(userId);
    await setEpoch(userId, 1);
    expect(await who(v)).toEqual({ user: null, method: null, exp: null });
  });

  it("N2: an epoch-1 session for an epoch-1 user is accepted; epoch 0 is not", async () => {
    const { userId } = await login("t2-n2@a.com");
    await setEpoch(userId, 1);
    const ok = await signSession(env, userId, Date.now(), {
      provider: "access",
      epoch: 1,
    });
    const stale = await signSession(env, userId, Date.now(), {
      provider: "access",
      epoch: 0,
    });
    expect((await who(ok)).user).toBe(userId);
    expect((await who(stale)).user).toBeNull();
  });

  it("a session whose tenant left AUTH_DOMAINS is rejected", async () => {
    const { userId } = await login("t2-tenant@a.com");
    const v = await signSession(env, userId, Date.now(), {
      provider: "google",
      epoch: 0,
      tenant: "a.com",
    });
    expect((await who(v, direct())).user).toBe(userId);
    expect((await who(v, direct({ AUTH_DOMAINS: "b.com" }))).user).toBeNull();
  });

  it("N4: a domain code session ends once Google is enabled", async () => {
    const { userId } = await login("t2-n4@a.com");
    const v = await signSession(env, userId, Date.now(), {
      provider: "code",
      epoch: 0,
      tenant: "a.com",
    });
    expect((await who(v, trial())).user).toBe(userId);
    expect((await who(v, direct())).user).toBeNull();
  });
});

describe("SESSION_SECRET shorter than 32 characters", () => {
  const short = { ...env, SESSION_SECRET: "s".repeat(20) } as Env;

  it("still logs in on the DERIVED key (no raw fallback, no 500)", async () => {
    const { userId } = await login("t2-short@a.com");
    const v = await signSession(short, userId, Date.now(), {
      provider: "access",
      epoch: 0,
    });
    const [p, sig] = v.split(".") as [string, string];
    // HKDF accepts any length; the raw secret no longer signs anything.
    expect(await hmacVerify(short.SESSION_SECRET, p, sig)).toBe(false);
    expect((await who(v, short)).user).toBe(userId);
  });

  it("a pre-upgrade cookie signed with the short raw secret is refused", async () => {
    const { userId } = await login("t2-short-old@a.com");
    const p = b64urlEncode(
      new TextEncoder().encode(
        JSON.stringify({ uid: userId, exp: Date.now() + 60_000 }),
      ),
    );
    const old = `${p}.${await hmacSign(short.SESSION_SECRET, p)}`;
    expect((await who(old, short)).user).toBeNull();
  });

  it("state cookies use the derived key too", async () => {
    const id = "access" as const;
    const r = await buildAuthorizeRedirect(
      short,
      {
        id,
        callbackPath: "/cb",
        authorizeUrl: (_e, a) => `https://idp.test/?state=${a.state}`,
        redeem: async () => ({
          provider: id,
          subject: "s",
          email: "x@a.com",
          name: null,
          tenant: null,
        }),
      },
      "/n",
    );
    const state = new URL(r.location).searchParams.get("state") as string;
    const value = r.stateCookie.split(";")[0]?.split("=").slice(1).join("=");
    const cookie = `${await stateCookieName(short, state)}=${value}`;
    await expect(
      handleCallback(
        short,
        {
          id,
          callbackPath: "/cb",
          authorizeUrl: () => "",
          redeem: async () => ({
            provider: id,
            subject: "s",
            email: "x@a.com",
            name: null,
            tenant: null,
          }),
        },
        new Request(`http://app.localhost/cb?state=${state}&code=c`, {
          headers: { cookie },
        }),
      ),
    ).resolves.toMatchObject({ next: "/n" });
  });

  it("the weak secret is not advertised on public /healthz (setup/admins only)", async () => {
    const app = createApp();
    const h = (e: Env) =>
      app.fetch(new Request("http://app.localhost/healthz"), e, ctx);
    expect(await (await h(short)).json()).not.toHaveProperty("problems");
    // The problem text still exists for setup and the admin surface.
    expect(secretProblems(short)).toEqual([
      "SESSION_SECRET shorter than 32 characters; rotate it",
    ]);
    expect(secretProblems(env)).toEqual([]);
  });
});

describe("provider interface and state", () => {
  const redeem = vi.fn(async () => ({
    provider: "access" as const,
    subject: "sub",
    email: "x@a.com",
    name: null,
    tenant: null,
  }));
  const stub = (id: "access" | "google"): OidcProvider => ({
    id,
    callbackPath: `/cb/${id}`,
    authorizeUrl: (_e, a) => `https://idp.test/auth?state=${a.state}`,
    redeem,
  });
  const start = async (id: "access" | "google") => {
    const r = await buildAuthorizeRedirect(env, stub(id), "/next");
    const state = new URL(r.location).searchParams.get("state") as string;
    const value = r.stateCookie.split(";")[0]?.split("=").slice(1).join("=");
    return { state, cookie: `${await stateCookieName(env, state)}=${value}` };
  };
  const cb = (state: string, cookie: string) =>
    new Request(`http://app.localhost/cb?state=${state}&code=c`, {
      headers: { cookie },
    });
  afterEach(() => {
    redeem.mockClear();
    vi.useRealTimers();
  });

  it("the provider builds the authorize URL; the state cookie names it", async () => {
    const { state, cookie } = await start("google");
    await expect(
      handleCallback(env, stub("google"), cb(state, cookie)),
    ).resolves.toMatchObject({ email: "x@a.com", next: "/next" });
    expect(redeem).toHaveBeenCalledOnce();
  });

  it("mix-up: a google state is refused by the access callback, no redeem", async () => {
    const { state, cookie } = await start("google");
    await expect(
      handleCallback(env, stub("access"), cb(state, cookie)),
    ).rejects.toBeInstanceOf(OidcStateError);
    expect(redeem).not.toHaveBeenCalled();
  });

  it("a state cookie without p (before P2) reads as access", async () => {
    const st = {
      state: "s".repeat(43),
      nonce: "n",
      verifier: "v",
      next: "/old",
      exp: Date.now() + 60_000,
    };
    const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(st)));
    const value = `${p}.${await hmacSign(await deriveKey(env, "oa:oidc-state"), p)}`;
    const cookie = `${await stateCookieName(env, st.state)}=${value}`;
    await expect(
      handleCallback(env, stub("access"), cb(st.state, cookie)),
    ).resolves.toMatchObject({ next: "/old" });
    await expect(
      handleCallback(env, stub("google"), cb(st.state, cookie)),
    ).rejects.toBeInstanceOf(OidcStateError);
  });

  it("legacy raw-secret state cookies are refused after LEGACY_KEY_UNTIL", async () => {
    vi.useFakeTimers({ now: LEGACY_KEY_UNTIL + 1, toFake: ["Date"] });
    const st = {
      state: "t".repeat(43),
      nonce: "n",
      verifier: "v",
      next: "/",
      exp: Date.now() + 60_000,
    };
    const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(st)));
    const value = `${p}.${await hmacSign(env.SESSION_SECRET, p)}`;
    const cookie = `${await stateCookieName(env, st.state)}=${value}`;
    await expect(
      handleCallback(env, stub("access"), cb(st.state, cookie)),
    ).rejects.toBeInstanceOf(OidcStateError);
  });
});

describe("Access callback route", () => {
  const app = createApp();
  let res: Response;
  beforeAll(async () => {
    res = await app.fetch(
      new Request(`http://app.localhost${AUTH.callback}?state=s&code=c`),
      env,
      ctx,
    );
  });

  it("sends Referrer-Policy: no-referrer", () => {
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("is 404 when access is not enabled", async () => {
    const r = await app.fetch(
      new Request(`http://app.localhost${AUTH.callback}?state=s&code=c`),
      direct(),
      ctx,
    );
    expect(r.status).toBe(404);
  });
});
