import {
  brokerNonce,
  flowHash,
  keyId,
  pkceChallenge,
  publicFromPkcs8,
  verifyBrokerTicket,
  verifyRedeem,
} from "@oa/auth-core";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handle as appHandle } from "../src/app.js";
import type { AuditEntry } from "../src/audit.js";
import { csrfToken } from "../src/auth/csrf.js";
import { FLOW_COOKIE, readFlow, writeFlow } from "../src/auth/flow.js";
import { BROKER_GOOGLE_CLIENT_ID } from "../src/auth/google.js";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionHash,
} from "../src/auth/session.js";
import type { SigninDeps } from "../src/auth/signin.js";
import type { Env } from "../src/env.js";
import { platformDb } from "./db.js";
import { ADMIN, ADMIN_BROKER_KEY, API, ctx, fakeEnv } from "./fakes.js";
import { authorizeUrl, kv, pkce, randomIp, register } from "./oauth-helpers.js";

// Every edge request carries cf-connecting-ip (the adapter 403s without
// one, 4.7); a test that sets its own keeps it.
const handle = (
  req: Request,
  ...rest: Parameters<typeof appHandle> extends [unknown, ...infer R]
    ? R
    : never
) => {
  if (!req.headers.has("cf-connecting-ip")) {
    req = new Request(req);
    req.headers.set("cf-connecting-ip", "192.0.2.10");
  }
  return appHandle(req, ...rest);
};

// Sign-in through the broker (design v7 4.3), R22 /auth/start and R23
// /auth/callback/google, on the admin host.

const NOW = 1_800_000_000_000;
const BROKER = "https://auth.hosted.test";
const CID = BROKER_GOOGLE_CLIENT_ID.staging;
const EMAIL = "me@example.com";
const SUB = "123";

let key: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  key = kp.privateKey;
  const pub = (await exportJWK(kp.publicKey)) as JWK;
  jwks = createLocalJWKSet({ keys: [{ ...pub, kid: "k1", alg: "RS256" }] });
});

let audits: AuditEntry[];
let redeems: Request[];
let idToken: () => Promise<string>;
let db: D1Database;
beforeEach(async () => {
  db = await platformDb();
  audits = [];
  redeems = [];
});

const deps = (over: Partial<SigninDeps> = {}): Partial<SigninDeps> => ({
  now: () => NOW,
  audit: async (_env, e) => {
    audits.push(e);
  },
  jwks,
  ...over,
});

function env(over: Partial<Env> = {}) {
  return fakeEnv({
    AUTH_BROKER: {
      fetch: async (r: Request) => {
        redeems.push(r);
        return Response.json({ id_token: await idToken() });
      },
    } as unknown as Fetcher,
    ...over,
  });
}

const call = (
  e: ReturnType<typeof fakeEnv>,
  url: string,
  init: RequestInit = {},
  d: Partial<SigninDeps> = deps(),
) => handle(new Request(url, init), e.env, ctx(), d);

const cookieOf = (res: Response, name: string) => {
  for (const c of res.headers.getSetCookie())
    if (c.startsWith(`${name}=`)) return c;
  return null;
};
const cookieValue = (c: string | null) => c?.split(";")[0]?.split("=")[1] ?? "";

const mint = (claims: Record<string, unknown>) =>
  new SignJWT({
    iss: "https://accounts.google.com",
    aud: CID,
    sub: SUB,
    email: EMAIL,
    email_verified: true,
    iat: NOW / 1000,
    exp: NOW / 1000 + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(key);

/** Runs /auth/start; returns the broker URL, the flow cookie and the client nonce. */
async function start(
  e: ReturnType<typeof fakeEnv>,
  q = "",
  d: Partial<SigninDeps> = deps(),
) {
  const res = await call(e, `${ADMIN}/auth/start${q}`, {}, d);
  const loc = new URL(res.headers.get("location") ?? "");
  const flow = cookieOf(res, FLOW_COOKIE);
  return { res, loc, flow, nonce: loc.searchParams.get("nonce") ?? "" };
}

/** start, then the callback the broker would send, with a token for `claims`. */
async function signIn(
  e: ReturnType<typeof fakeEnv>,
  o: {
    q?: string;
    claims?: Record<string, unknown>;
    d?: Partial<SigninDeps>;
    /** A session cookie already in the browser. */
    sid?: string;
  } = {},
) {
  const s = await start(e, o.q ?? "", o.d ?? deps());
  idToken = async () =>
    mint({
      nonce: await brokerNonce("i000000admin", s.nonce),
      ...o.claims,
    });
  const state = s.loc.searchParams.get("state") ?? "";
  const res = await call(
    e,
    `${ADMIN}/auth/callback/google?code=C&state=${state}&bstate=BS`,
    {
      headers: {
        cookie: [
          `${FLOW_COOKIE}=${cookieValue(s.flow)}`,
          ...(o.sid ? [`${SESSION_COOKIE}=${o.sid}`] : []),
        ].join("; "),
      },
    },
    o.d ?? deps(),
  );
  return { start: s, res };
}

/** signIn from one client address. */
async function signInFrom(
  e: ReturnType<typeof fakeEnv>,
  ip: string,
  claims: Record<string, unknown>,
) {
  const hdr = { "cf-connecting-ip": ip };
  const res = await call(e, `${ADMIN}/auth/start`, { headers: hdr });
  const loc = new URL(res.headers.get("location") ?? "");
  const nonce = loc.searchParams.get("nonce") ?? "";
  idToken = async () =>
    mint({ nonce: await brokerNonce("i000000admin", nonce), ...claims });
  return call(
    e,
    `${ADMIN}/auth/callback/google?code=C&state=${loc.searchParams.get("state")}`,
    {
      headers: {
        cookie: `${FLOW_COOKIE}=${cookieValue(cookieOf(res, FLOW_COOKIE))}`,
        ...hdr,
      },
    },
  );
}

describe("R22 /auth/start", () => {
  it("302 to the broker with install, state, nonce, challenge and a ticket", async () => {
    const e = env();
    const { res, loc } = await start(e);
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(`${loc.origin}${loc.pathname}`).toBe(`${BROKER}/google/authorize`);
    const q = loc.searchParams;
    expect(q.get("install")).toBe("i000000admin");
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.has("reauth")).toBe(false);
    const x = await publicFromPkcs8(ADMIN_BROKER_KEY);
    expect(
      await verifyBrokerTicket(
        [{ kid: await keyId(x), x }],
        q.get("ticket") ?? "",
        {
          install: "i000000admin",
          state: q.get("state") ?? "",
          challenge: q.get("code_challenge") ?? "",
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("sets the flow cookie: __Host-, Secure, HttpOnly, Lax, 10 min, no Domain", async () => {
    const { flow } = await start(env());
    const attrs = (flow ?? "")
      .split(";")
      .slice(1)
      .map((a) => a.trim());
    expect(attrs.sort()).toEqual(
      ["HttpOnly", "Max-Age=600", "Path=/", "SameSite=Lax", "Secure"].sort(),
    );
  });

  it("the flow holds state, nonce, verifier (its S256 is the challenge), return, reauth", async () => {
    const e = env();
    const { loc, flow } = await start(e, "?return=/installs/x&reauth=1");
    expect(loc.searchParams.get("reauth")).toBe("1");
    const f = await readFlow(e.env, cookieValue(flow), NOW);
    expect(f).toMatchObject({
      state: loc.searchParams.get("state"),
      nonce: loc.searchParams.get("nonce"),
      return: "/installs/x",
      reauth: true,
      exp: NOW + 600_000,
    });
    expect(await pkceChallenge(f?.verifier ?? "")).toBe(
      loc.searchParams.get("code_challenge"),
    );
  });

  it("charges RL_PV_SIGNIN_IP by ipKey (IPv6 /64); over it 303 to /sign-in?error=rate_limited; unbound 503", async () => {
    const e = env();
    await call(e, `${ADMIN}/auth/start`, {
      headers: { "cf-connecting-ip": "2001:db8:1:2::7" },
    });
    expect(e.limits.RL_PV_SIGNIN_IP.keys).toEqual(["2001:db8:1:2::/64"]);
    e.limits.RL_PV_SIGNIN_IP.allow = false;
    const r = await call(e, `${ADMIN}/auth/start`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=rate_limited`,
    );
    // No flow starts: the cookie, if any, is cleared.
    expect(cookieOf(r, FLOW_COOKIE)).toMatch(
      /^__Host-oa-admin-flow=; Max-Age=0;/,
    );
    const u = env({ RL_PV_SIGNIN_IP: undefined });
    expect((await call(u, `${ADMIN}/auth/start`)).status).toBe(503);
  });
});

describe("return validation (4.3), at start and at the callback", () => {
  const cases: [string, string][] = [
    ["/installs/abc", "/installs/abc"],
    [
      "/oauth/authorize?client_id=c&state=s&code_challenge=x",
      "/oauth/authorize?client_id=c&state=s&code_challenge=x",
    ],
    // Encoded variants stay on the admin origin (a path, never a host).
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    ["/%5Cevil.com", "/%5Cevil.com"],
    ["/%252F%252Fevil.com", "/%252F%252Fevil.com"],
    // Everything else falls back to /installs.
    ["//evil.com", "/installs"],
    ["/\\evil.com", "/installs"],
    ["/\tevil.com", "/installs"],
    ["/\t/evil.com", "/installs"],
    ["/\nevil.com", "/installs"],
    ["/\r\n/evil.com", "/installs"],
    ["https://evil.com/", "/installs"],
    ["evil.com", "/installs"],
    ["/auth/logout", "/installs"],
    ["/auth/start?return=//evil.com", "/installs"],
    ["", "/installs"],
    [`/${"a".repeat(2048)}`, "/installs"],
  ];

  const named = cases.map(
    ([r, w]) => [JSON.stringify(r).slice(0, 40), r, w] as const,
  );

  it.each(named)("start: %s", async (_n, ret, want) => {
    const e = env();
    const { flow } = await start(e, `?return=${encodeURIComponent(ret)}`);
    expect((await readFlow(e.env, cookieValue(flow), NOW))?.return).toBe(want);
  });

  it.each(named)(
    "callback: a flow holding %s lands on its want at the admin origin",
    async (_n, ret, want) => {
      const e = env();
      const s = await start(e);
      idToken = async () =>
        mint({ nonce: await brokerNonce("i000000admin", s.nonce) });
      const f = await readFlow(e.env, cookieValue(s.flow), NOW);
      // A flow cookie that skipped the start check (as if minted by an older build).
      const forged = await writeFlow(e.env, {
        ...(f as NonNullable<typeof f>),
        return: ret,
      });
      const res = await call(
        e,
        `${ADMIN}/auth/callback/google?code=C&state=${f?.state}&bstate=BS`,
        { headers: { cookie: `${FLOW_COOKIE}=${forged}` } },
      );
      expect(res.status).toBe(303);
      const loc = res.headers.get("location") ?? "";
      expect(new URL(loc).origin).toBe(ADMIN);
      expect(loc).toBe(`${ADMIN}${want}`);
    },
  );

  it.each(named)("end to end: return=%s", async (_n, ret, want) => {
    const { res } = await signIn(env(), {
      q: `?return=${encodeURIComponent(ret)}`,
    });
    expect(res.headers.get("location")).toBe(`${ADMIN}${want}`);
  });
});

describe("R23 /auth/callback/google", () => {
  it("redeems over AUTH_BROKER, signed with ADMIN_BROKER_KEY, gate header i000000admin", async () => {
    const { start: s, res } = await signIn(env());
    expect(res.status).toBe(303);
    expect(redeems).toHaveLength(1);
    const r = redeems[0] as Request;
    expect(r.url).toBe(`${BROKER}/google/redeem`);
    expect(r.headers.get("x-oa-gate-install")).toBe("i000000admin");
    const body = await r.text();
    const b = JSON.parse(body);
    expect(b).toMatchObject({
      install: "i000000admin",
      code: "C",
      bstate: "BS",
      ts: NOW,
    });
    expect(b.h).toBe(
      await flowHash(s.nonce, s.loc.searchParams.get("code_challenge") ?? ""),
    );
    const x = await publicFromPkcs8(ADMIN_BROKER_KEY);
    expect(
      await verifyRedeem(
        x,
        r.headers.get("x-oa-kid") ?? "",
        body,
        r.headers.get("x-oa-sig") ?? "",
      ),
    ).toBe(true);
  });

  it("success: session cookie (8 h, Strict), sessions row by sha256(sid) with auth_at, signin.ok, flow cleared", async () => {
    const { res } = await signIn(env(), {
      claims: { auth_time: NOW / 1000 - 30 },
    });
    expect(res.headers.get("location")).toBe(`${ADMIN}/installs`);
    const c = cookieOf(res, SESSION_COOKIE) ?? "";
    const attrs = c
      .split(";")
      .slice(1)
      .map((a) => a.trim());
    expect(attrs.sort()).toEqual(
      [
        "HttpOnly",
        "Max-Age=28800",
        "Path=/",
        "SameSite=Strict",
        "Secure",
      ].sort(),
    );
    const sid = cookieValue(c);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieOf(res, FLOW_COOKIE)).toMatch(/Max-Age=0/);
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sid)),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const row = await db.prepare("SELECT * FROM sessions").first();
    expect(row).toMatchObject({
      id_hash: hash,
      kind: "admin",
      host: "admin.hosted.test",
      email: EMAIL,
      sub: SUB,
      auth_at: NOW - 30_000,
      created_at: NOW,
      expires_at: NOW + SESSION_TTL_MS,
      revoked_at: null,
    });
    expect(SESSION_TTL_MS).toBe(8 * 3600_000);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "signin.ok",
        outcome: "ok",
        actor: { kind: "signin", email: EMAIL, sub: SUB },
      }),
    ]);
  });

  it("without auth_time, auth_at is 0: never a recent sign-in for R11", async () => {
    await signIn(env());
    expect(
      (await db.prepare("SELECT auth_at FROM sessions").first())?.auth_at,
    ).toBe(0);
  });

  it("no hd rule: a consumer account and any Workspace domain both sign in", async () => {
    for (const claims of [{}, { hd: "other.example" }]) {
      const { res } = await signIn(env(), { claims });
      expect(cookieOf(res, SESSION_COOKIE)).not.toBeNull();
    }
  });

  it("the email is normalized before the match", async () => {
    const { res } = await signIn(env(), {
      claims: { email: " ME@Example.com " },
    });
    expect(cookieOf(res, SESSION_COOKIE)).not.toBeNull();
  });

  it("missing, tampered or expired flow cookie, or another state: 303 /sign-in?error=expired, no redeem", async () => {
    const e = env();
    const s = await start(e);
    const state = s.loc.searchParams.get("state");
    const v = cookieValue(s.flow);
    const tries: [string, string, Partial<SigninDeps>][] = [
      [`state=${state}`, "", deps()],
      [`state=${state}`, `${v.slice(0, -2)}xx`, deps()],
      [`state=${state}`, `x${v}`, deps()],
      [`state=other`, v, deps()],
      [`state=${state}`, v, deps({ now: () => NOW + 600_001 })],
    ];
    for (const [q, cookie, d] of tries) {
      const res = await call(
        e,
        `${ADMIN}/auth/callback/google?code=C&${q}`,
        { headers: cookie ? { cookie: `${FLOW_COOKIE}=${cookie}` } : {} },
        d,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `${ADMIN}/sign-in?error=expired`,
      );
    }
    expect(redeems).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("a flow cookie signed with another key is refused", async () => {
    const e = env();
    const s = await start(e);
    const f = await readFlow(e.env, cookieValue(s.flow), NOW);
    const other = fakeEnv({ ADMIN_SESSION_KEY: "z".repeat(32) });
    const forged = await writeFlow(other.env, f as NonNullable<typeof f>);
    const res = await call(
      e,
      `${ADMIN}/auth/callback/google?code=C&state=${f?.state}`,
      {
        headers: { cookie: `${FLOW_COOKIE}=${forged}` },
      },
    );
    expect(res.headers.get("location")).toBe(`${ADMIN}/sign-in?error=expired`);
  });

  it("the broker's error: 303 to /sign-in with expired or denied", async () => {
    const e = env();
    for (const [err, want] of [
      ["expired", "expired"],
      ["access_denied", "denied"],
    ]) {
      const s = await start(e);
      const res = await call(
        e,
        `${ADMIN}/auth/callback/google?error=${err}&state=${s.loc.searchParams.get("state")}`,
        { headers: { cookie: `${FLOW_COOKIE}=${cookieValue(s.flow)}` } },
      );
      expect(res.headers.get("location")).toBe(
        `${ADMIN}/sign-in?error=${want}`,
      );
    }
    expect(redeems).toEqual([]);
  });

  it("a token that fails verification: audit token_invalid, 303 error=denied, no session", async () => {
    for (const claims of [
      { aud: "other" },
      { email_verified: false },
      { nonce: "n" },
    ]) {
      audits = [];
      const { res } = await signIn(env(), { claims });
      expect(res.headers.get("location")).toBe(`${ADMIN}/sign-in?error=denied`);
      expect(audits).toEqual([
        expect.objectContaining({
          action: "signin.refused",
          outcome: "refused",
          code: "token_invalid",
        }),
      ]);
    }
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });

  it("the broker refusing the redeem: 303 error=expired", async () => {
    const e = env({
      AUTH_BROKER: {
        fetch: async () =>
          Response.json({ error: "bad_flow" }, { status: 400 }),
      } as unknown as Fetcher,
    });
    const { res } = await signIn(e);
    expect(res.headers.get("location")).toBe(`${ADMIN}/sign-in?error=expired`);
  });

  it("a failed redeem counts as a refused sign-in: per /64, the 31st within the hour is rate_limited before redeem", async () => {
    const e = env({
      AUTH_BROKER: {
        fetch: async (r: Request) => {
          redeems.push(r);
          return Response.json({ error: "exchange_failed" }, { status: 400 });
        },
      } as unknown as Fetcher,
    });
    for (let i = 0; i < 31; i++) {
      const s = await start(e);
      const before = redeems.length;
      const res = await call(
        e,
        `${ADMIN}/auth/callback/google?code=x&bstate=x&state=${s.loc.searchParams.get("state")}`,
        {
          headers: {
            cookie: `${FLOW_COOKIE}=${cookieValue(s.flow)}`,
            // Rotating inside one /64 is one client.
            "cf-connecting-ip": `2001:db8:7:7::${(i + 1).toString(16)}`,
          },
        },
      );
      if (i < 30) {
        expect(res.headers.get("location")).toBe(
          `${ADMIN}/sign-in?error=expired`,
        );
        expect(redeems.length).toBe(before + 1);
      } else {
        expect(res.headers.get("location")).toBe(
          `${ADMIN}/sign-in?error=rate_limited`,
        );
        expect(redeems.length).toBe(before);
      }
    }
  });

  it("charges RL_PV_SIGNIN_IP", async () => {
    const e = env();
    await signIn(e);
    expect(e.limits.RL_PV_SIGNIN_IP.keys).toHaveLength(2);
  });
});

describe("rate_limited by route kind (3.5)", () => {
  // R22 and R23 are browser navigations: the sign-in screen, never JSON.
  it("R22 over RL_PV_SIGNIN_IP: 303 /sign-in?error=rate_limited", async () => {
    const e = env();
    e.limits.RL_PV_SIGNIN_IP.allow = false;
    const r = await call(e, `${ADMIN}/auth/start`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=rate_limited`,
    );
  });

  it("R23 over RL_PV_SIGNIN_IP: 303 /sign-in?error=rate_limited, no redeem", async () => {
    const e = env();
    const s = await start(e);
    e.limits.RL_PV_SIGNIN_IP.allow = false;
    const r = await call(
      e,
      `${ADMIN}/auth/callback/google?code=C&state=${s.loc.searchParams.get("state")}`,
      { headers: { cookie: `${FLOW_COOKIE}=${cookieValue(s.flow)}` } },
    );
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=rate_limited`,
    );
    expect(redeems).toEqual([]);
  });

  it("API routes: 429 with the rate_limited envelope, on both hosts", async () => {
    for (const url of [`${API}/v1/me`, `${ADMIN}/api/v1/me`]) {
      const e = env();
      e.limits.RL_PV_PRE_IP.allow = false;
      const r = await call(e, url);
      expect(r.status).toBe(429);
      expect(r.headers.get("location")).toBeNull();
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "rate_limited",
      );
    }
  });
});

describe("identity pinning (4.3 step 5)", () => {
  it("email listed, sub differs: 303 /sign-in?error=no_access with the sub, audit unknown_sub", async () => {
    const { res } = await signIn(env(), { claims: { sub: "999" } });
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=no_access&sub=999`,
    );
    expect(cookieOf(res, SESSION_COOKIE)).toBeNull();
    expect(cookieOf(res, FLOW_COOKIE)).toContain("Max-Age=0");
    expect(audits).toEqual([
      expect.objectContaining({
        action: "signin.refused",
        outcome: "refused",
        code: "unknown_sub",
        actor: { kind: "signin", email: EMAIL, sub: "999" },
        detail: { sub: "999" },
      }),
    ]);
  });

  it("email not listed: 303 error=no_access (no sub), audit not_listed with the email HMAC only (no actor email)", async () => {
    const { res } = await signIn(env(), {
      claims: { email: "x@gmail.com", sub: "5" },
    });
    expect(res.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=no_access`,
    );
    const a = audits[0] as AuditEntry;
    expect(a).toMatchObject({
      action: "signin.refused",
      code: "not_listed",
      email: "x@gmail.com",
    });
    expect(a.actor).toEqual({ kind: "signin" });
    expect(JSON.stringify(a.detail ?? {})).not.toContain("x@gmail.com");
  });

  it("the match is the exact (email, sub) pair: another entry's sub is unknown_sub, a listed sub under an unlisted email is not_listed", async () => {
    const two = "me@example.com:123,you@example.com:456";
    const a = await signIn(env({ ADMIN_IDENTITIES: two }), {
      claims: { email: EMAIL, sub: "456" },
    });
    expect(a.res.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=no_access&sub=456`,
    );
    const b = await signIn(env({ ADMIN_IDENTITIES: two }), {
      claims: { email: "them@example.com", sub: "123" },
    });
    expect(b.res.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=no_access`,
    );
    expect(audits.map((x) => x.code)).toEqual(["unknown_sub", "not_listed"]);
    // Each listed pair still signs in as itself.
    const ok = await signIn(env({ ADMIN_IDENTITIES: two }), {
      claims: { email: "you@example.com", sub: "456" },
    });
    expect(cookieOf(ok.res, SESSION_COOKIE)).not.toBeNull();
  });

  it("refusal buckets: unknown_sub and not_listed each add one to the email and ipKey counters; a sign-in adds none", async () => {
    const e = env();
    const counts = async () =>
      (
        await e.env.PLATFORM_DB.prepare(
          "SELECT key, count FROM rate_counters WHERE key LIKE 'signin_refused:%' ORDER BY key",
        ).all<{ key: string; count: number }>()
      ).results.map((r) => [r.key.split(":")[1], r.count]);
    await signIn(e);
    expect(await counts()).toEqual([]);
    await signIn(e, { claims: { sub: "999" } });
    expect(await counts()).toEqual([
      ["email", 1],
      ["ip", 1],
    ]);
    await signIn(e, { claims: { email: "x@gmail.com", sub: "5" } });
    // Another email: its own counter; the same client: one ipKey counter.
    expect((await counts()).sort()).toEqual([
      ["email", 1],
      ["email", 1],
      ["ip", 2],
    ]);
  });

  it("the account id is query-encoded", async () => {
    const { res } = await signIn(env(), { claims: { sub: "<b>&x=1" } });
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.get("sub")).toBe("<b>&x=1");
    expect([...loc.searchParams.keys()]).toEqual(["error", "sub"]);
  });

  it("an email domain or hd never admits: only the exact pair", async () => {
    const e = env({ ADMIN_IDENTITIES: "me@example.com:123" });
    const { res } = await signIn(e, {
      claims: { email: "you@example.com", hd: "example.com" },
    });
    expect(res.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=no_access`,
    );
  });

  it("empty ADMIN_IDENTITIES admits no one", async () => {
    const { res } = await signIn(env({ ADMIN_IDENTITIES: "" }));
    expect(res.headers.get("location")).toBe(
      `${ADMIN}/sign-in?error=no_access`,
    );
  });

  it("refused sign-ins per email HMAC: the 21st within the hour is 303 error=rate_limited, with no audit row", async () => {
    const e = env();
    const noAccess = `${ADMIN}/sign-in?error=no_access&sub=999`;
    for (let i = 0; i < 20; i++) {
      const { res } = await signIn(e, { claims: { sub: "999" } });
      expect(res.headers.get("location")).toBe(noAccess);
    }
    expect(audits.length).toBe(20);
    for (const ip of ["198.51.100.1", "198.51.100.2"]) {
      const res = await signInFrom(e, ip, { sub: "999" });
      expect(res.headers.get("location")).toBe(
        `${ADMIN}/sign-in?error=rate_limited`,
      );
    }
    // Rotating IPs adds no audit rows past the limit.
    expect(audits.length).toBe(20);
    // The next hour's window starts over.
    const later = await signIn(e, {
      claims: { sub: "999", iat: NOW / 1000 + 3600, exp: NOW / 1000 + 7200 },
      d: deps({ now: () => NOW + 3600_000 }),
    });
    expect(later.res.headers.get("location")).toBe(noAccess);
  });

  it("refused sign-ins per ipKey HMAC: the 31st within the hour is rate_limited, before redeem", async () => {
    const e = env();
    const hdr = { "cf-connecting-ip": "2001:db8:9:9::1" };
    for (let i = 0; i < 31; i++) {
      const s = await start(e);
      idToken = async () =>
        mint({
          nonce: await brokerNonce("i000000admin", s.nonce),
          email: `u${i}@x.com`,
        });
      const before = redeems.length;
      const res = await call(
        e,
        `${ADMIN}/auth/callback/google?code=C&state=${s.loc.searchParams.get("state")}`,
        {
          headers: { cookie: `${FLOW_COOKIE}=${cookieValue(s.flow)}`, ...hdr },
        },
      );
      if (i < 30)
        expect(res.headers.get("location")).toBe(
          `${ADMIN}/sign-in?error=no_access`,
        );
      else {
        expect(res.headers.get("location")).toBe(
          `${ADMIN}/sign-in?error=rate_limited`,
        );
        expect(redeems.length).toBe(before);
      }
    }
  });
});

describe("reauth (4.3 step 4, R11)", () => {
  it("with reauth, auth_time within 10 min signs in and auth_at is it", async () => {
    const { res } = await signIn(env(), {
      q: "?reauth=1&return=/installs/x",
      claims: { auth_time: NOW / 1000 - 599 },
    });
    expect(res.headers.get("location")).toBe(`${ADMIN}/installs/x`);
    expect(
      (await db.prepare("SELECT auth_at FROM sessions").first())?.auth_at,
    ).toBe(NOW - 599_000);
  });

  it("with reauth, an older or missing auth_time is refused (303 error=expired, no session, audit token_invalid)", async () => {
    for (const claims of [{ auth_time: NOW / 1000 - 601 }, {}]) {
      const { res } = await signIn(env(), { q: "?reauth=1", claims });
      expect(res.headers.get("location")).toBe(
        `${ADMIN}/sign-in?error=expired`,
      );
    }
    expect(audits).toEqual([
      expect.objectContaining({
        action: "signin.refused",
        code: "token_invalid",
        detail: { stage: "auth_time" },
      }),
      expect.objectContaining({ code: "token_invalid" }),
    ]);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });
});

describe("a session already in the browser (4.5: logout ends every grant)", () => {
  const oat = (id: string, hash: string, email = EMAIL) =>
    db
      .prepare(
        `INSERT INTO agent_tokens (id, kind, token_hash, session_hash, admin_email, label, scopes, created_at, expires_at)
         VALUES (?, 'oat', ?, ?, ?, ?, '["installs:read"]', ?, ?)`,
      )
      .bind(id, `h-${id}`, hash, email, `label-${id}`, NOW, NOW + 3600_000)
      .run();
  const logout = (e: ReturnType<typeof fakeEnv>, sid: string) =>
    csrfToken(e.env, sid).then((csrf) =>
      call(e, `${ADMIN}/auth/logout`, {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sid}`,
          origin: ADMIN,
          "x-csrf-token": csrf,
        },
      }),
    );

  it("a reauth for the same pair keeps the sid and updates auth_at; logout then revokes the tokens minted under it", async () => {
    const e = env();
    const a = await createSession(
      e.env,
      { email: EMAIL, sub: SUB, authAt: NOW - 3600_000 },
      NOW - 60_000,
    );
    await oat("t1", await sessionHash(a.sid));
    const { res } = await signIn(e, {
      q: "?reauth=1",
      claims: { auth_time: NOW / 1000 - 5 },
      sid: a.sid,
    });
    expect(res.status).toBe(303);
    expect(cookieValue(cookieOf(res, SESSION_COOKIE))).toBe(a.sid);
    const rows = await db
      .prepare("SELECT auth_at, expires_at, revoked_at FROM sessions")
      .all();
    expect(rows.results).toEqual([
      {
        auth_at: NOW - 5000,
        expires_at: NOW - 60_000 + SESSION_TTL_MS,
        revoked_at: null,
      },
    ]);
    expect((await logout(e, a.sid)).status).toBe(204);
    expect(
      await db
        .prepare("SELECT revoked_at FROM agent_tokens WHERE id = 't1'")
        .first("revoked_at"),
    ).toBe(NOW);
  });

  it("a reauth for the same pair with under 60 min left still keeps the sid and its tokens (4.5: reauth moves auth_at only)", async () => {
    const e = env();
    const created = NOW - SESSION_TTL_MS + 30 * 60_000;
    const a = await createSession(
      e.env,
      { email: EMAIL, sub: SUB, authAt: created },
      created,
    );
    await oat("t4", await sessionHash(a.sid));
    const { res } = await signIn(e, {
      q: "?reauth=1",
      claims: { auth_time: NOW / 1000 - 5 },
      sid: a.sid,
    });
    expect(res.status).toBe(303);
    expect(cookieValue(cookieOf(res, SESSION_COOKIE))).toBe(a.sid);
    const rows = await db
      .prepare("SELECT auth_at, expires_at, revoked_at FROM sessions")
      .all();
    expect(rows.results).toEqual([
      {
        auth_at: NOW - 5000,
        expires_at: created + SESSION_TTL_MS,
        revoked_at: null,
      },
    ]);
    expect(
      await db
        .prepare("SELECT revoked_at FROM agent_tokens WHERE id = 't4'")
        .first("revoked_at"),
    ).toBeNull();
  });

  it("the same pair with under 60 min left: the old session ends with its tokens, a new 8 h one starts, and consent renders (9A.3.2 step 4)", async () => {
    // showConsent reads the wall clock, so this case runs on it.
    const T = Date.now();
    const d = deps({ now: () => T });
    const e = env({ OAUTH_KV: kv() });
    const a = await createSession(
      e.env,
      { email: EMAIL, sub: SUB, authAt: T - 7.5 * 3600_000 },
      T - 7.5 * 3600_000,
    );
    const ah = await sessionHash(a.sid);
    await oat("t3", ah);
    const ip = randomIp();
    const w = {
      call: (r: Request) => {
        r.headers.set("cf-connecting-ip", ip);
        return handle(r, e.env, ctx(), d);
      },
    };
    const clientId = await register(w);
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge);
    const consent = (sid: string) =>
      w.call(
        new Request(url, {
          headers: {
            cookie: `${SESSION_COOKIE}=${sid}`,
            "sec-fetch-site": "same-origin",
          },
        }),
      );
    const first = await consent(a.sid);
    expect(first.status).toBe(200);
    const href = /href="(\/auth\/start\?[^"]*)">Sign in again</.exec(
      await first.text(),
    )?.[1];
    const ret = new URL(href ?? "", ADMIN).searchParams.get("return");
    const { res } = await signIn(e, {
      q: `?return=${encodeURIComponent(ret ?? "")}`,
      claims: { iat: T / 1000, exp: T / 1000 + 3600 },
      sid: a.sid,
      d,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ADMIN}${ret}`);
    const sid = cookieValue(cookieOf(res, SESSION_COOKIE));
    expect(sid).not.toBe(a.sid);
    expect(
      await db
        .prepare("SELECT revoked_at FROM sessions WHERE id_hash = ?")
        .bind(ah)
        .first("revoked_at"),
    ).toBe(T);
    expect(
      await db
        .prepare("SELECT expires_at FROM sessions WHERE id_hash = ?")
        .bind(await sessionHash(sid))
        .first("expires_at"),
    ).toBe(T + SESSION_TTL_MS);
    expect(
      await db
        .prepare("SELECT revoked_at FROM agent_tokens WHERE id = 't3'")
        .first("revoked_at"),
    ).toBe(T);
    const again = await consent(sid);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain(">Approve<");
  });

  it("a live session of another identity is revoked with its tokens before the new one", async () => {
    const e = env({
      ADMIN_IDENTITIES: `${EMAIL}:${SUB},you@example.com:456`,
    });
    const b = await createSession(
      e.env,
      { email: "you@example.com", sub: "456", authAt: NOW },
      NOW,
    );
    const bh = await sessionHash(b.sid);
    await oat("t2", bh, "you@example.com");
    const { res } = await signIn(e, { sid: b.sid });
    const sid = cookieValue(cookieOf(res, SESSION_COOKIE));
    expect(sid).not.toBe(b.sid);
    expect(
      await db
        .prepare("SELECT revoked_at FROM sessions WHERE id_hash = ?")
        .bind(bh)
        .first("revoked_at"),
    ).toBe(NOW);
    expect(
      await db
        .prepare("SELECT revoked_at FROM agent_tokens WHERE id = 't2'")
        .first("revoked_at"),
    ).toBe(NOW);
    expect(audits.map((a) => [a.action, a.detail?.tokenId ?? null])).toEqual([
      ["token.revoke", "t2"],
      ["signin.ok", null],
    ]);
  });
});

describe("audit failures (W4's audit not yet live)", () => {
  const failing = () =>
    deps({
      audit: async () => {
        throw new Error("audit down");
      },
    });

  it("a failed signin.ok audit leaves no session row and sets no cookie", async () => {
    const d = failing();
    const { res } = await signIn(env(), { d });
    expect(cookieOf(res, SESSION_COOKIE)).toBeNull();
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });

  it("a failed refusal audit still counts the refused sign-in (4.7 limits fail closed)", async () => {
    await signIn(env(), { d: failing(), claims: { email: "no@x.com" } });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM rate_counters").first("n"),
    ).toBe(2);
  });
});
