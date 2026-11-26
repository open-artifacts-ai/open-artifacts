import { env } from "cloudflare:workers";
import {
  AUTH,
  AuthProvidersSchema,
  orderSignInMethods,
  SIGN_IN_PAGE,
} from "@oa/shared";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import {
  APPLE_AUTHORIZE_URL,
  APPLE_ISSUER,
  APPLE_JWKS_URL,
  APPLE_TOKEN_URL,
  appleProvider,
} from "../src/auth/providers/apple.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { reachOf } from "../src/services/reach.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);

const SERVICES_ID = "com.example.oa.web";
const TEAM_ID = "TEAM123456";
const KEY_ID = "KEY1234567";

const get = (path: string, e: Env = env, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );

const postForm = (
  path: string,
  form: Record<string, string>,
  e: Env = env,
  cookie?: string,
) =>
  app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(form).toString(),
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

// One set of keys per isolate: appleProvider caches Apple's JWKS at module
// scope, just like production.
let keysPromise:
  | Promise<{
      clientKp: CryptoKeyPair;
      clientPem: string;
      rsKp: CryptoKeyPair;
      rsJwk: Record<string, unknown>;
      esKp: CryptoKeyPair;
      esJwk: Record<string, unknown>;
    }>
  | undefined;

const testKeys = () =>
  (keysPromise ??= (async () => {
    const [clientKp, rsKp, esKp] = await Promise.all([
      generateKeyPair("ES256", { extractable: true }),
      generateKeyPair("RS256", { extractable: true }),
      generateKeyPair("ES256", { extractable: true }),
    ]);
    return {
      clientKp,
      clientPem: await exportPKCS8(clientKp.privateKey),
      rsKp,
      rsJwk: {
        ...(await exportJWK(rsKp.publicKey)),
        kid: "apple-rs1",
        alg: "RS256",
      },
      esKp,
      esJwk: {
        ...(await exportJWK(esKp.publicKey)),
        kid: "apple-es1",
        alg: "ES256",
      },
    };
  })());

type FakeAppleCode = {
  claims: Record<string, unknown>;
  alg?: "RS256" | "ES256";
};

async function fakeApple() {
  const { clientKp, clientPem, rsKp, rsJwk, esKp, esJwk } = await testKeys();
  const codes = new Map<string, FakeAppleCode>();
  const tokenCalls: {
    body: URLSearchParams;
    clientSecret: string;
    idToken: string;
  }[] = [];

  const mint = async (
    claims: Record<string, unknown>,
    alg: "RS256" | "ES256" = "RS256",
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const body = Object.fromEntries(
      Object.entries({
        iss: APPLE_ISSUER,
        aud: SERVICES_ID,
        sub: "apple-sub-1",
        email: "alice@example.com",
        email_verified: "true",
        iat: now,
        exp: now + 3600,
        ...claims,
      }).filter(([, v]) => v !== undefined),
    ) as JWTPayload;
    const key = alg === "ES256" ? esKp.privateKey : rsKp.privateKey;
    const kid = alg === "ES256" ? "apple-es1" : "apple-rs1";
    return new SignJWT(body).setProtectedHeader({ alg, kid }).sign(key);
  };

  const realFetch = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url === APPLE_JWKS_URL) {
        return Response.json({ keys: [rsJwk, esJwk] });
      }
      if (req.url === APPLE_TOKEN_URL && req.method === "POST") {
        const body = new URLSearchParams();
        for (const [k, v] of (await req.formData()).entries()) {
          if (typeof v === "string") body.append(k, v);
        }
        const clientSecret = body.get("client_secret") ?? "";
        // Verify the ES256 client_secret JWT Apple requires.
        const { payload, protectedHeader } = await jwtVerify(
          clientSecret,
          clientKp.publicKey,
          {
            algorithms: ["ES256"],
            issuer: TEAM_ID,
            audience: APPLE_ISSUER,
            subject: SERVICES_ID,
          },
        );
        if (
          protectedHeader.kid !== KEY_ID ||
          typeof payload.iat !== "number" ||
          typeof payload.exp !== "number" ||
          payload.exp - payload.iat !== 300
        ) {
          return Response.json({ error: "invalid_client" }, { status: 400 });
        }
        const code = body.get("code") ?? "";
        const entry = codes.get(code);
        codes.delete(code);
        if (!entry) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const idToken = await mint(entry.claims, entry.alg ?? "RS256");
        tokenCalls.push({ body, clientSecret, idToken });
        return Response.json({
          id_token: idToken,
          access_token: "apple-at",
          token_type: "Bearer",
        });
      }
      return realFetch(input, init);
    });

  return {
    clientPem,
    tokenCalls,
    issueCode(
      claims: Record<string, unknown>,
      alg: "RS256" | "ES256" = "RS256",
    ) {
      const code = `apple-code-${crypto.randomUUID()}`;
      codes.set(code, { claims, alg });
      return code;
    },
    restore: () => spy.mockRestore(),
  };
}

type FakeApple = Awaited<ReturnType<typeof fakeApple>>;

function appleEnv(clientPem: string, over: Partial<Env> = {}): Env {
  return {
    ...env,
    ...mailer().env,
    AUTH_PROVIDERS: "apple,email",
    APPLE_SERVICES_ID: SERVICES_ID,
    APPLE_TEAM_ID: TEAM_ID,
    APPLE_KEY_ID: KEY_ID,
    APPLE_PRIVATE_KEY: clientPem,
    ...over,
  } as Env;
}

async function linkApple(userId: string, subject: string) {
  await env.DB.prepare(
    "insert into identities (provider, subject, tenant, user_id, created_at) values ('apple', ?, '', ?, ?)",
  )
    .bind(subject, userId, Date.now())
    .run();
}

let apple: FakeApple;
beforeEach(async () => {
  apple = await fakeApple();
});
afterEach(() => vi.restoreAllMocks());

async function startApple(e: Env, next = "/a/x") {
  const start = await get(
    `${AUTH.loginApple}?next=${encodeURIComponent(next)}`,
    e,
  );
  expect(start.status).toBe(302);
  const url = new URL(loc(start));
  const rawSetCookie =
    start.headers.getSetCookie().find((c) => /oa_oidc_apple_/.test(c)) ?? "";
  const stateCookie = rawSetCookie.split(";")[0] ?? "";
  return {
    url,
    rawSetCookie,
    stateCookie,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
  };
}

describe("Sign in with Apple config and ordering", () => {
  it("fails closed with a problem string when any Apple var is missing or invalid", () => {
    const ok = authConfig(appleEnv(apple.clientPem));
    expect(ok.apple).toEqual({
      servicesId: SERVICES_ID,
      teamId: TEAM_ID,
      keyId: KEY_ID,
      privateKey: apple.clientPem.trim(),
    });

    for (const over of [
      { APPLE_SERVICES_ID: undefined },
      { APPLE_TEAM_ID: "" },
      { APPLE_KEY_ID: "   " },
      { APPLE_PRIVATE_KEY: undefined },
      { APPLE_PRIVATE_KEY: "not-a-pem-secret-value-123" },
    ]) {
      const c = authConfig(appleEnv(apple.clientPem, over));
      expect(c.apple).toBeNull();
      expect(c.problems.some((p) => p.includes("Apple login is on"))).toBe(
        true,
      );
      expect(c.problems.join(" ")).not.toContain("not-a-pem-secret-value-123");
    }
  });

  it("lists apple last in /auth/providers, orderSignInMethods, and reachOf", async () => {
    expect(orderSignInMethods(["apple", "email", "google", "access"])).toEqual([
      "google",
      "access",
      "email",
      "apple",
    ]);

    const e = appleEnv(apple.clientPem, {
      AUTH_PROVIDERS: "apple,google,email",
      AUTH_DOMAINS: "a.com",
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: "sec",
    });
    const body = AuthProvidersSchema.parse(
      await (await get(AUTH.providers, e)).json(),
    );
    expect(body.providers.map((p) => p.id)).toEqual([
      "google",
      "email",
      "apple",
    ]);
    expect(body.providers.at(-1)).toEqual({
      id: "apple",
      start: AUTH.loginApple,
    });

    const reach = await reachOf(
      e,
      "alice@a.com",
      { id: "u1", role: "member", status: "active", linked: false },
      async () => false,
    );
    expect(reach.methods.at(-1)).toBe("apple");
  });

  it("returns 404 on login and callback when Apple is not configured", async () => {
    const off = direct();
    expect((await get(AUTH.loginApple, off)).status).toBe(404);
    expect(
      (await postForm(AUTH.callbackApple, { code: "c", state: "s" }, off))
        .status,
    ).toBe(404);
  });
});

describe("Sign in with Apple OIDC form_post flow", () => {
  it("builds authorize URL with form_post and sets SameSite=None Secure HttpOnly path-scoped state cookie", async () => {
    const e = appleEnv(apple.clientPem);
    const { url, rawSetCookie } = await startApple(e, "/a/doc");
    expect(`${url.origin}${url.pathname}`).toBe(APPLE_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(SERVICES_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${APP}${AUTH.callbackApple}`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(url.searchParams.get("scope")).toBe("name email");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();

    expect(rawSetCookie).toContain("HttpOnly");
    expect(rawSetCookie).toContain("Secure");
    expect(rawSetCookie).toContain("SameSite=None");
    expect(rawSetCookie).toContain(`Path=${AUTH.callbackApple}`);
  });

  it.each(["RS256", "ES256"] as const)(
    "linked subject signs in via POST callback (%s id_token) and verifies ES256 client_secret",
    async (alg) => {
      const e = appleEnv(apple.clientPem);
      const email = uniq("apple-linked", "example.com");
      const sub = `apple-sub-${crypto.randomUUID()}`;
      const uid = await seedUser(email, "member");
      await linkApple(uid, sub);

      const { state, nonce, stateCookie } = await startApple(e, "/a/hello");
      const code = apple.issueCode({ sub, email, nonce }, alg);
      const res = await postForm(
        AUTH.callbackApple,
        { code, state },
        e,
        stateCookie,
      );

      expect(res.status).toBe(302);
      expect(loc(res)).toBe("/a/hello");
      const sessCookie = cookieVal(res, SESSION);
      expect(sessCookie).toBeTruthy();
      const sess = await readSession(e, sessCookie);
      expect(sess?.uid).toBe(uid);
      expect(sess?.p).toBe("apple");
      expect(
        res.headers
          .getSetCookie()
          .some(
            (c) =>
              /oa_oidc_apple_[^=]*=;/.test(c) &&
              c.includes(`Path=${AUTH.callbackApple}`) &&
              /Max-Age=0/i.test(c),
          ),
      ).toBe(true);
      expect(apple.tokenCalls).toHaveLength(1);
      expect(apple.tokenCalls[0]?.body.get("client_id")).toBe(SERVICES_ID);
    },
  );

  it("first link on an invited row returns needs_code and sets link cookie", async () => {
    const e = appleEnv(apple.clientPem);
    const email = uniq("apple-invited", "example.com");
    await seedUser(email, "member");

    const { state, nonce, stateCookie } = await startApple(e, "/a/inv");
    const code = apple.issueCode({
      sub: `sub-${crypto.randomUUID()}`,
      email,
      nonce,
    });
    const res = await postForm(
      AUTH.callbackApple,
      {
        code,
        state,
        user: JSON.stringify({
          name: { firstName: "Jane", lastName: "Doe" },
          email,
        }),
      },
      e,
      stateCookie,
    );

    expect(res.status).toBe(302);
    const dest = new URL(loc(res), APP);
    expect(dest.pathname).toBe(SIGN_IN_PAGE);
    expect(dest.searchParams.get("error")).toBe("needs_code");
    expect(dest.searchParams.get("link")).toBe("1");
    expect(cookieVal(res, SESSION)).toBeUndefined();
    expect(res.headers.getSetCookie().some((c) => /oa_glink=/.test(c))).toBe(
      true,
    );
  });

  it("refuses wrong aud, wrong iss, wrong nonce, and expired id_token", async () => {
    const e = appleEnv(apple.clientPem);
    const email = uniq("apple-bad", "example.com");
    const sub = `sub-${crypto.randomUUID()}`;
    const uid = await seedUser(email, "member");
    await linkApple(uid, sub);

    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, unknown>[] = [
      { aud: "com.evil.other" },
      { iss: "https://evil.example.com" },
      { nonce: "wrong-nonce" },
      { iat: now - 7200, exp: now - 3600 },
    ];

    for (const bad of cases) {
      const { state, nonce, stateCookie } = await startApple(e, "/a/x");
      const code = apple.issueCode({ sub, email, nonce, ...bad });
      const res = await postForm(
        AUTH.callbackApple,
        { code, state },
        e,
        stateCookie,
      );
      expect(res.status).toBe(302);
      const dest = new URL(loc(res), APP);
      expect(dest.pathname).toBe(SIGN_IN_PAGE);
      expect(dest.searchParams.get("error")).toBe("failed");
      expect(cookieVal(res, SESSION)).toBeUndefined();
    }
  });

  it("marks private relay emails as emailVerified false and extracts name only from user JSON", async () => {
    const e = appleEnv(apple.clientPem);

    const code1 = apple.issueCode({
      sub: "relay-1",
      email: "abc123@privaterelay.appleid.com",
      email_verified: "true",
      is_private_email: "true",
      nonce: "n1",
    });
    const id1 = await appleProvider.redeem(e, {
      code: code1,
      verifier: "v",
      nonce: "n1",
      user: JSON.stringify({
        name: { firstName: "Ada", lastName: "Lovelace" },
      }),
    });
    expect(id1.emailVerified).toBe(false);
    expect(id1.name).toBe("Ada Lovelace");
    expect(id1.tenant).toBeNull();

    const code2 = apple.issueCode({
      sub: "relay-2",
      email: "hidden@example.com",
      email_verified: true,
      is_private_email: true,
      nonce: "n2",
    });
    const id2 = await appleProvider.redeem(e, {
      code: code2,
      verifier: "v",
      nonce: "n2",
    });
    expect(id2.emailVerified).toBe(false);
    expect(id2.name).toBeNull();

    // Unlinked relay address never matches an invited row -> no_access.
    const { state, nonce, stateCookie } = await startApple(e, "/a/relay");
    const code3 = apple.issueCode({
      sub: `relay-sub-${crypto.randomUUID()}`,
      email: "xyz999@privaterelay.appleid.com",
      email_verified: "true",
      is_private_email: "true",
      nonce,
    });
    const res = await postForm(
      AUTH.callbackApple,
      { code: code3, state },
      e,
      stateCookie,
    );
    expect(res.status).toBe(302);
    const dest = new URL(loc(res), APP);
    expect(dest.pathname).toBe(SIGN_IN_PAGE);
    expect(dest.searchParams.get("error")).toBe("no_access");
    expect(dest.searchParams.get("via")).toBe("apple");
    expect(cookieVal(res, SESSION)).toBeUndefined();
  });

  it("refuses POST callback when state cookie is missing", async () => {
    const e = appleEnv(apple.clientPem);
    const { state, nonce } = await startApple(e, "/a/x");
    const code = apple.issueCode({ nonce });

    // No Cookie header at all: first failure redirects to retry, never sets session.
    const res = await postForm(AUTH.callbackApple, { code, state }, e);
    expect(res.status).toBe(302);
    expect(loc(res)).toContain(`${AUTH.loginApple}?next=`);
    expect(loc(res)).toContain("retry=1");
    expect(cookieVal(res, SESSION)).toBeUndefined();
    expect(apple.tokenCalls).toHaveLength(0);
  });

  it("never logs secrets, client_secret, codes, id_tokens, state, or nonce", async () => {
    const logs: string[] = [];
    const cap = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(cap);
    vi.spyOn(console, "warn").mockImplementation(cap);
    vi.spyOn(console, "error").mockImplementation(cap);

    const e = appleEnv(apple.clientPem);
    const email = uniq("apple-nolog", "example.com");
    const sub = `sub-${crypto.randomUUID()}`;
    const uid = await seedUser(email, "member");
    await linkApple(uid, sub);

    // Success path
    const s1 = await startApple(e, "/a/ok");
    const c1 = apple.issueCode({ sub, email, nonce: s1.nonce });
    await postForm(
      AUTH.callbackApple,
      { code: c1, state: s1.state },
      e,
      s1.stateCookie,
    );

    // Failure path (bad nonce)
    const s2 = await startApple(e, "/a/fail");
    const c2 = apple.issueCode({ sub, email, nonce: "mismatch-nonce" });
    await postForm(
      AUTH.callbackApple,
      { code: c2, state: s2.state },
      e,
      s2.stateCookie,
    );

    const combined = logs.join("\n");
    const pemSnippet = apple.clientPem.split("\n")[1] ?? "";
    expect(pemSnippet.length).toBeGreaterThan(10);
    expect(combined).not.toContain(pemSnippet);
    expect(combined).not.toContain(c1);
    expect(combined).not.toContain(c2);
    expect(combined).not.toContain(s1.state);
    expect(combined).not.toContain(s1.nonce);
    expect(combined).not.toContain(s2.state);
    expect(combined).not.toContain(s2.nonce);
    for (const call of apple.tokenCalls) {
      expect(combined).not.toContain(call.clientSecret);
      expect(combined).not.toContain(call.idToken);
    }
  });
});
