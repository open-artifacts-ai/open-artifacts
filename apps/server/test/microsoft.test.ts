import { env } from "cloudflare:workers";
import {
  AUTH,
  AuthProvidersSchema,
  MeSchema,
  orderSignInMethods,
  R,
  SIGN_IN_PAGE,
} from "@oa/shared";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  buildAuthorizeRedirect,
  handleCallback,
  stateCookieName,
} from "../src/auth/oidc.js";
import {
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_JWKS_URL,
  MICROSOFT_TOKEN_URL,
  microsoftProvider,
  resetMicrosoftJwksCache,
} from "../src/auth/providers/microsoft.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { reachOf } from "../src/services/reach.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";

const MS_CID = "ms-client-id-1234";
const MS_SECRET = "ms-client-secret-top-secret";
const TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const OID = "00000000-0000-0000-1111-222222222222";
const OTHER_TID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const APP = "http://app.localhost";
const TPL_ISSUER = "https://login.microsoftonline.com/{tenantid}/v2.0";
// Extra JWKS entries (same key pair) varying Microsoft's `issuer` and the
// key's own signing constraints. m1 (the default) has the template issuer.
const EXTRA_KEYS: Record<string, Record<string, unknown>> = {
  "m-tpl": { issuer: TPL_ISSUER },
  "m-own": { issuer: `https://login.microsoftonline.com/${TID}/v2.0` },
  "m-other": { issuer: `https://login.microsoftonline.com/${OTHER_TID}/v2.0` },
  "m-sts": { issuer: "https://sts.windows.net/{tenantid}/" },
  "m-noiss": {},
  "m-sig": { issuer: TPL_ISSUER, use: "sig", key_ops: ["verify"] },
  "m-noalg": { issuer: TPL_ISSUER, alg: undefined },
  "m-rs384": { issuer: TPL_ISSUER, alg: "RS384" },
  "m-enc": { issuer: TPL_ISSUER, use: "enc" },
  "m-ops": { issuer: TPL_ISSUER, key_ops: ["encrypt"] },
};
const SESSION = sessionCookieName(env);
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const msEnv = (over: Partial<Env> = {}): Env =>
  direct({
    AUTH_PROVIDERS: "google,microsoft,email",
    MICROSOFT_CLIENT_ID: MS_CID,
    MICROSOFT_CLIENT_SECRET: MS_SECRET,
    ...over,
  });

const get = (path: string, e: Env, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );

const post = async (path: string, e: Env, body: unknown, cookie?: string) => {
  const pending: Promise<unknown>[] = [];
  const res = await app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    e,
    {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(pending);
  return res;
};

const loc = (r: Response) => r.headers.get("location") ?? "";
const cookieVal = (r: Response, name: string) =>
  r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .split(";")[0];

// One signing key per test isolate: the verifier caches Microsoft's JWKS at
// module scope (as in production).
// Plus one RS384 and one PS256 pair, published with a matching JWK alg.
const OTHER_ALGS = ["RS384", "PS256"] as const;
type Pair = { kp: CryptoKeyPair; jwk: Record<string, unknown> };
let signing: Promise<Pair & { others: Record<string, Pair> }> | undefined;
const pair = async (alg: string, kid: string): Promise<Pair> => {
  const kp = await generateKeyPair(alg, { extractable: true });
  return { kp, jwk: { ...(await exportJWK(kp.publicKey)), kid, alg } };
};
const signingKey = () =>
  (signing ??= (async () => {
    const main = await pair("RS256", "m1");
    const others: Record<string, Pair> = {};
    for (const alg of OTHER_ALGS)
      others[alg] = await pair(alg, `m-pair-${alg}`);
    return { ...main, others };
  })());

type CodeEntry = {
  challenge: string;
  claims: Record<string, unknown>;
  key?: CryptoKey;
  kid?: string;
  alg?: string;
};

async function fakeMicrosoft() {
  const { kp, jwk, others } = await signingKey();
  const codes = new Map<string, CodeEntry>();
  const tokenCalls: URLSearchParams[] = [];
  let tokenStatus = 200;

  const mint = (
    claims: Record<string, unknown>,
    o: { key?: CryptoKey; alg?: string; kid?: string } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const tid = (claims.tid as string | undefined) ?? TID;
    const body = Object.fromEntries(
      Object.entries({
        iss: `https://login.microsoftonline.com/${tid}/v2.0`,
        aud: MS_CID,
        sub: "pairwise-sub-ignored",
        tid,
        oid: OID,
        email: "alice@contoso.com",
        name: "Alice Smith",
        iat: now,
        nbf: now,
        exp: now + 3600,
        ...claims,
      }).filter(([, v]) => v !== undefined),
    ) as JWTPayload;
    return new SignJWT(body)
      .setProtectedHeader({ alg: o.alg ?? "RS256", kid: o.kid ?? "m1" })
      .sign(o.key ?? kp.privateKey);
  };

  const realFetch = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url === MICROSOFT_JWKS_URL)
        return Response.json({
          keys: [
            { ...jwk, issuer: TPL_ISSUER },
            ...Object.entries(EXTRA_KEYS).map(([kid, over]) => ({
              ...jwk,
              kid,
              ...over,
            })),
            ...Object.values(others).map((o) => ({
              ...o.jwk,
              issuer: TPL_ISSUER,
            })),
          ],
        });
      if (req.url === MICROSOFT_TOKEN_URL && req.method === "POST") {
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
        if (!entry)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const d = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(body.get("code_verifier") ?? ""),
        );
        if (b64urlEncode(new Uint8Array(d)) !== entry.challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          id_token: await mint(entry.claims, {
            key: entry.key,
            kid: entry.kid,
            alg: entry.alg,
          }),
          access_token: "ms-access-token-secret",
          token_type: "Bearer",
        });
      }
      return realFetch(input, init);
    });

  return {
    tokenCalls,
    issueCode(
      claims: Record<string, unknown>,
      challenge: string,
      key?: CryptoKey,
      kid?: string,
      alg?: string,
    ): string {
      const code = `ms-code-${crypto.randomUUID()}`;
      codes.set(code, { challenge, claims, key, kid, alg });
      return code;
    },
    setTokenStatus(s: number) {
      tokenStatus = s;
    },
    others,
    restore: () => spy.mockRestore(),
  };
}

let ms: Awaited<ReturnType<typeof fakeMicrosoft>>;
beforeEach(async () => {
  resetMicrosoftJwksCache();
  ms = await fakeMicrosoft();
});
afterEach(() => vi.restoreAllMocks());

async function begin(e: Env = msEnv(), next = "/a/x") {
  const r = await buildAuthorizeRedirect(e, microsoftProvider, next);
  const u = new URL(r.location);
  const state = u.searchParams.get("state") as string;
  const value = r.stateCookie.split(";")[0]?.split("=").slice(1).join("=");
  return {
    loc: u,
    state,
    nonce: u.searchParams.get("nonce") as string,
    challenge: u.searchParams.get("code_challenge") as string,
    cookie: `${await stateCookieName(e, state)}=${value}`,
  };
}

const callbackReq = (b: { state: string; cookie: string }, code: string) =>
  new Request(`${APP}${AUTH.callbackMicrosoft}?state=${b.state}&code=${code}`, {
    headers: { cookie: b.cookie },
  });

async function msRoundTrip(
  e: Env,
  claims: Record<string, unknown> = {},
  next = "/a/x",
) {
  const start = await get(
    `${AUTH.loginMicrosoft}?next=${encodeURIComponent(next)}`,
    e,
  );
  expect(start.status).toBe(302);
  const u = new URL(loc(start));
  const stateCookie = (
    start.headers.getSetCookie().find((c) => /oa_oidc_/.test(c)) ?? ""
  ).split(";")[0];
  const code = ms.issueCode(
    { nonce: u.searchParams.get("nonce"), ...claims },
    u.searchParams.get("code_challenge") as string,
  );
  return get(
    `${AUTH.callbackMicrosoft}?state=${u.searchParams.get("state")}&code=${code}`,
    e,
    stateCookie,
  );
}

describe("microsoft provider (self-hosted)", () => {
  it("authorize URL: common endpoint, query mode, scope, PKCE S256", async () => {
    const { loc: u } = await begin();
    expect(`${u.origin}${u.pathname}`).toBe(MICROSOFT_AUTHORIZE_URL);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: MS_CID,
      redirect_uri: `${APP}${AUTH.callbackMicrosoft}`,
      response_type: "code",
      response_mode: "query",
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
  });

  it("redeem: subject is tid:oid, emailVerified is always false, tenant is null", async () => {
    const e = msEnv();
    const b = await begin(e);
    const code = ms.issueCode(
      { nonce: b.nonce, email: "Alice@Contoso.com", name: "Alice Smith" },
      b.challenge,
    );
    const r = await handleCallback(e, microsoftProvider, callbackReq(b, code));
    expect(r).toEqual({
      provider: "microsoft",
      subject: `${TID}:${OID}`,
      email: "alice@contoso.com",
      emailVerified: false,
      name: "Alice Smith",
      tenant: null,
      next: "/a/x",
      reauth: false,
    });
    expect(ms.tokenCalls[0]?.get("client_secret")).toBe(MS_SECRET);
    expect(ms.tokenCalls[0]?.get("redirect_uri")).toBe(
      `${APP}${AUTH.callbackMicrosoft}`,
    );
  });

  it("falls back to preferred_username when email is absent, refuses non-address", async () => {
    const e = msEnv();
    const b1 = await begin(e);
    const code1 = ms.issueCode(
      {
        nonce: b1.nonce,
        email: undefined,
        preferred_username: "bob@contoso.com",
        name: undefined,
      },
      b1.challenge,
    );
    expect(
      await handleCallback(e, microsoftProvider, callbackReq(b1, code1)),
    ).toMatchObject({
      email: "bob@contoso.com",
      emailVerified: false,
      name: null,
    });

    const b2 = await begin(e);
    const code2 = ms.issueCode(
      {
        nonce: b2.nonce,
        email: undefined,
        preferred_username: "not-an-email",
      },
      b2.challenge,
    );
    await expect(
      handleCallback(e, microsoftProvider, callbackReq(b2, code2)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuses wrong issuer for tid", async () => {
    const e = msEnv();
    const b = await begin(e);
    const code = ms.issueCode(
      {
        nonce: b.nonce,
        tid: TID,
        iss: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
      },
      b.challenge,
    );
    await expect(
      handleCallback(e, microsoftProvider, callbackReq(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("tid must be a GUID (any case); other tids are refused", async () => {
    const e = msEnv();
    for (const tid of [TID, TID.toUpperCase()]) {
      const b = await begin(e);
      const code = ms.issueCode({ nonce: b.nonce, tid }, b.challenge);
      expect(
        await handleCallback(e, microsoftProvider, callbackReq(b, code)),
      ).toMatchObject({ subject: `${tid}:${OID}` });
    }
    for (const tid of [
      "contoso",
      "common",
      "9188040d6c674c5bb11236a304b66dad",
      `${TID}-x`,
      "9188040d-6c67-4c5b-b112-36a304b66dag",
    ]) {
      const b = await begin(e);
      const code = ms.issueCode({ nonce: b.nonce, tid }, b.challenge);
      await expect(
        handleCallback(e, microsoftProvider, callbackReq(b, code)),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("signing key issuer: template and own tenant pass; other tenant, mismatch and missing issuer are refused", async () => {
    const e = msEnv();
    const run = async (kid: string) => {
      const b = await begin(e);
      const code = ms.issueCode(
        { nonce: b.nonce },
        b.challenge,
        undefined,
        kid,
      );
      return handleCallback(e, microsoftProvider, callbackReq(b, code));
    };
    for (const kid of ["m-tpl", "m-own", "m1", "m-sig", "m-noalg"])
      expect(await run(kid)).toMatchObject({ subject: `${TID}:${OID}` });
    for (const kid of ["m-other", "m-sts", "m-noiss", "no-such-kid"])
      await expect(run(kid)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("signing key constraints: alg mismatch, use enc and key_ops without verify are refused", async () => {
    const e = msEnv();
    for (const kid of ["m-rs384", "m-enc", "m-ops"]) {
      const b = await begin(e);
      const code = ms.issueCode(
        { nonce: b.nonce },
        b.challenge,
        undefined,
        kid,
      );
      await expect(
        handleCallback(e, microsoftProvider, callbackReq(b, code)),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("only RS256: a matching RS384 or PS256 key and token pair is refused", async () => {
    const e = msEnv();
    for (const alg of OTHER_ALGS) {
      const o = ms.others[alg];
      if (!o) throw new Error(alg);
      const b = await begin(e);
      const code = ms.issueCode(
        { nonce: b.nonce },
        b.challenge,
        o.kp.privateKey,
        o.jwk.kid as string,
        alg,
      );
      await expect(
        handleCallback(e, microsoftProvider, callbackReq(b, code)),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("template key issuer passes for another tenant's matching tid", async () => {
    const e = msEnv();
    const b = await begin(e);
    const code = ms.issueCode(
      { nonce: b.nonce, tid: OTHER_TID },
      b.challenge,
      undefined,
      "m-tpl",
    );
    expect(
      await handleCallback(e, microsoftProvider, callbackReq(b, code)),
    ).toMatchObject({ subject: `${OTHER_TID}:${OID}` });
  });

  it("refuses wrong aud and multi-audience tokens", async () => {
    const e = msEnv();
    for (const aud of ["other-client", [MS_CID, "other-client"]]) {
      const b = await begin(e);
      const code = ms.issueCode({ nonce: b.nonce, aud }, b.challenge);
      await expect(
        handleCallback(e, microsoftProvider, callbackReq(b, code)),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("refuses bad nonce", async () => {
    const e = msEnv();
    const b = await begin(e);
    const code = ms.issueCode({ nonce: "wrong-nonce" }, b.challenge);
    await expect(
      handleCallback(e, microsoftProvider, callbackReq(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuses expired token and future nbf token", async () => {
    const e = msEnv();
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { exp: now - 300 },
      { nbf: now + 300, exp: now + 3600 },
    ]) {
      const b = await begin(e);
      const code = ms.issueCode({ nonce: b.nonce, ...claims }, b.challenge);
      await expect(
        handleCallback(e, microsoftProvider, callbackReq(b, code)),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("refuses token signed by an unknown key", async () => {
    const e = msEnv();
    const b = await begin(e);
    const other = (await generateKeyPair("RS256")).privateKey;
    const code = ms.issueCode({ nonce: b.nonce }, b.challenge, other);
    await expect(
      handleCallback(e, microsoftProvider, callbackReq(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("tokens, codes, nonces, emails and secrets are never logged", async () => {
    const e = msEnv();
    const raw: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((s: unknown) => {
      raw.push(String(s));
    });
    vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      raw.push(String(s));
    });
    const b = await begin(e);
    const code = ms.issueCode(
      { nonce: "wrong-nonce", email: "secret-user@contoso.com" },
      b.challenge,
    );
    await handleCallback(e, microsoftProvider, callbackReq(b, code)).catch(
      () => {},
    );
    const text = raw.join("\n");
    for (const s of [
      code,
      b.nonce,
      b.state,
      "secret-user@contoso.com",
      "eyJ",
      MS_SECRET,
      "ms-access-token-secret",
      env.SESSION_SECRET,
    ])
      expect(text).not.toContain(s);
  });
});

describe("microsoft routes and sign-in flow", () => {
  it("no config returns 404 on login and callback", async () => {
    for (const e of [
      env,
      direct(),
      msEnv({ MICROSOFT_CLIENT_ID: "" }),
      msEnv({ MICROSOFT_CLIENT_SECRET: "" }),
    ]) {
      expect((await get(AUTH.loginMicrosoft, e)).status).toBe(404);
      expect(
        (await get(`${AUTH.callbackMicrosoft}?state=s&code=c`, e)).status,
      ).toBe(404);
    }
  });

  it("linked subject signs in with p=microsoft and /api/v1/me reports method microsoft", async () => {
    const e = msEnv();
    const email = uniq("ms-linked", "contoso.com");
    const oid = crypto.randomUUID();
    const uid = await seedUser(email, "member");
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at) values ('microsoft', ?, '', ?, ?)",
    )
      .bind(`${TID}:${oid}`, uid, Date.now())
      .run();

    const r = await msRoundTrip(e, { email, oid, tid: TID });
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/a/x");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cross-origin-opener-policy")).toBeNull();
    const sessVal = cookieVal(r, SESSION);
    expect(sessVal).toBeDefined();
    expect(await readSession(e, sessVal)).toMatchObject({
      uid,
      p: "microsoft",
      e: 0,
    });

    const meRes = await get(R.me, e, `${SESSION}=${sessVal}`);
    expect(meRes.status).toBe(200);
    const me = MeSchema.parse(await meRes.json());
    expect(me.auth?.method).toBe("microsoft");
  });

  it("first link on an invited row returns needs_code and links after code verification", async () => {
    const m = mailer();
    const e = msEnv({ ...m.env });
    const email = uniq("ms-invite", "contoso.com");
    const oid = crypto.randomUUID();
    const uid = await seedUser(email, "member");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();

    const r = await msRoundTrip(e, { email, oid, tid: TID });
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      `${SIGN_IN_PAGE}?error=needs_code&next=%2Fa%2Fx&link=1`,
    );
    expect(cookieVal(r, SESSION)).toBeUndefined();

    // Complete the link flow with an emailed code.
    const linkCookie = (
      r.headers.getSetCookie().find((c) => /oa_glink=/.test(c)) ?? ""
    ).split(";")[0];
    expect(linkCookie).toBeTruthy();

    const req = await post(AUTH.codeRequest, e, { link: true }, linkCookie);
    expect(req.status).toBe(202);
    const pendingCookie = (
      req.headers.getSetCookie().find((c) => /oa_code=/.test(c)) ?? ""
    ).split(";")[0];
    const ver = await post(
      AUTH.codeVerify,
      e,
      { code: m.codeFor(email) },
      `${linkCookie}; ${pendingCookie}`,
    );
    expect(ver.status).toBe(200);
    const sessVal = cookieVal(ver, SESSION);
    expect(await readSession(e, sessVal)).toMatchObject({
      uid,
      p: "microsoft",
    });
    expect(
      await env.DB.prepare(
        "select provider, subject from identities where user_id = ?",
      )
        .bind(uid)
        .first(),
    ).toEqual({ provider: "microsoft", subject: `${TID}:${oid}` });
  });

  it("GET /auth/providers and orderSignInMethods list microsoft after google", async () => {
    const e = msEnv();
    const body = AuthProvidersSchema.parse(
      await (await get(AUTH.providers, e)).json(),
    );
    expect(body).toEqual({
      mode: "direct",
      providers: [
        { id: "google", start: AUTH.loginGoogle, domains: ["a.com"] },
        { id: "microsoft", start: AUTH.loginMicrosoft },
        { id: "email", domainCodes: false, guests: true },
      ],
      hosted: false,
    });
    expect(
      orderSignInMethods(["email", "microsoft", "access", "google"]),
    ).toEqual(["google", "microsoft", "access", "email"]);

    // reachOf lists microsoft for an active row when codes are on, after google.
    const activeRow = {
      id: "u1",
      role: "member" as const,
      status: "active",
      linked: false,
    };
    expect(
      (await reachOf(e, "a@a.com", activeRow, async () => false)).methods,
    ).toEqual(["google", "microsoft"]);
    // No row: microsoft is link-only, so not included.
    expect(
      (await reachOf(e, "a@contoso.com", null, async () => false)).methods,
    ).toEqual([]);
  });
});
