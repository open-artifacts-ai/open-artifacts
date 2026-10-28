import { env } from "cloudflare:workers";
import {
  AUTH,
  CodeRateLimitedDetailsSchema,
  CodeRequestedSchema,
  CodeVerifiedSchema,
  CodeVerifyFailureDetailsSchema,
  R,
  TurnstileRequiredDetailsSchema,
} from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { emailKey } from "../src/auth/codes.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import {
  direct,
  mailer,
  seedShare,
  seedUser,
  trial,
  uniq,
} from "./auth-helpers.js";
import { fetchAndWait } from "./helpers.js";
import { callWorker, nextIp } from "./mcp-helpers.js";

// P2 Task 8: code sign-in routes.
const app = createApp();
const APP = "http://app.localhost";
/** A passing siteverify response for this install (hostname and action are checked). */
const TURNSTILE_OK = {
  success: true,
  hostname: "app.localhost",
  action: "code_request",
};
const SESSION = sessionCookieName(env);
const CODE_COOKIE = "oa_code"; // dev naming in the test env (prod: __Host-oa_code)
afterEach(() => vi.restoreAllMocks());

type Opts = {
  cookie?: string;
  ip?: string;
  headers?: Record<string, string>;
  waits?: Promise<unknown>[];
};
async function post(e: Env, path: string, body: unknown, o: Opts = {}) {
  const waits = o.waits ?? [];
  const r = await app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip":
          o.ip ?? `198.51.100.${Math.floor(Math.random() * 250)}`,
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...o.headers,
      },
      body: JSON.stringify(body),
    }),
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  if (!o.waits) await Promise.all(waits);
  return r;
}
const cookieOf = (r: Response, name: string) => {
  const c = r.headers.getSetCookie().find((s) => s.startsWith(`${name}=`));
  return c ? `${name}=${c.slice(name.length + 1).split(";")[0]}` : undefined;
};
const setCookieLine = (r: Response, name: string) =>
  r.headers.getSetCookie().find((s) => s.startsWith(`${name}=`)) ?? "";
const errOf = async (r: Response) =>
  ((await r.json()) as { error: { code: string; details?: unknown } }).error;
const withMail = (e: Env, m = mailer()) => ({ ...e, ...m.env }) as Env;
const request = (
  e: Env,
  email: string,
  o: Opts & { token?: string; next?: string } = {},
) =>
  post(
    e,
    AUTH.codeRequest,
    {
      email,
      next: o.next ?? "/a/x",
      ...(o.token ? { turnstileToken: o.token } : {}),
    },
    o,
  );
const verify = (
  e: Env,
  code: string,
  cookie: string | undefined,
  o: Opts = {},
) => post(e, AUTH.codeVerify, { code }, { ...o, cookie });

describe("POST AUTH.codeRequest", () => {
  it("the 202 is byte-identical for eligible, ineligible and email-off addresses", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const on = withMail(direct(), m);
    const a = await request(on, guest);
    const b = await request(on, uniq("nobody", "x.com"));
    const c = await request(direct(), guest);
    const aBody = await a.text();
    expect(a.status).toBe(202);
    for (const r of [b, c]) {
      expect(r.status).toBe(a.status);
      const body = JSON.parse(await r.text());
      expect(Object.keys(body)).toEqual(Object.keys(JSON.parse(aBody)));
      expect(body.expiresIn).toBe(600);
    }
    expect(CodeRequestedSchema.parse(JSON.parse(aBody))).toMatchObject({
      expiresIn: 600,
      resendAfter: 60,
      codeLength: 8,
    });
    expect(m.sent.map((x) => x.to)).toEqual([guest]);
  });

  it("masks the address and sets the pending cookie (HttpOnly, Lax, 10 min)", async () => {
    const r = await request(direct(), "someone@x.com");
    expect(CodeRequestedSchema.parse(await r.json()).maskedEmail).toBe(
      "s***@x.com",
    );
    expect(setCookieLine(r, CODE_COOKIE)).toMatch(
      /HttpOnly; SameSite=Lax; Path=\/; Max-Age=600/,
    );
  });

  it("delivery runs after the response (waitUntil)", async () => {
    const guest = uniq("w", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const waits: Promise<unknown>[] = [];
    const r = await request(withMail(direct(), m), guest, { waits });
    expect(r.status).toBe(202);
    expect(m.sent).toHaveLength(0);
    await Promise.all(waits);
    expect(m.sent).toHaveLength(1);
  });

  it("a fourth request from one IP within 10 minutes is 429 scope email, eligible or not", async () => {
    for (const addr of [uniq("g", "x.com"), uniq("nobody", "x.com")]) {
      const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
      for (let i = 0; i < 3; i++)
        expect((await request(direct(), addr, { ip })).status).toBe(202);
      const r = await request(direct(), addr, { ip });
      expect(r.status).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
      const err = await errOf(r);
      expect(err.code).toBe("rate_limited");
      expect(CodeRateLimitedDetailsSchema.parse(err.details).scope).toBe(
        "email",
      );
    }
  });

  it("RL_AUTH keys on the install and the IP; a denial is 429 scope ip", async () => {
    const keys: string[] = [];
    const rl = (success: boolean) =>
      ({
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success };
        },
      }) as unknown as RateLimit;
    await request(direct({ RL_AUTH: rl(true) }), uniq("x", "x.com"), {
      ip: "203.0.113.9",
    });
    expect(keys).toEqual(["inst-a:203.0.113.9"]);
    const r = await request(direct({ RL_AUTH: rl(false) }), uniq("x", "x.com"));
    expect(r.status).toBe(429);
    expect((await errOf(r)).details).toMatchObject({ scope: "ip" });
  });

  it("Turnstile configured: no token 400 turnstile_required; bad token 403 turnstile_failed; before any counter", async () => {
    const e = trial();
    const addr = uniq("t", "x.com");
    const r1 = await request(e, addr);
    expect(r1.status).toBe(400);
    const err = await errOf(r1);
    expect(err.code).toBe("turnstile_required");
    TurnstileRequiredDetailsSchema.parse(err.details);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: false }),
    );
    const r2 = await request(e, addr, { token: "bad" });
    expect(r2.status).toBe(403);
    expect((await errOf(r2)).code).toBe("turnstile_failed");
    const ek = await emailKey(e, addr);
    expect(
      await env.DB.prepare("select 1 from counters where key like ?")
        .bind(`code:%${ek}%`)
        .first(),
    ).toBeNull();
  });

  it("a passing Turnstile token lets a trial domain member through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(TURNSTILE_OK),
    );
    const owner = uniq("own");
    await seedUser(owner, "owner");
    const m = mailer();
    const r = await request(withMail(trial(), m), owner, { token: "ok" });
    expect(r.status).toBe(202);
    expect(m.sent.map((x) => x.to)).toEqual([owner]);
  });

  it("invalid email is 400 field email", async () => {
    const r = await request(direct(), "not-an-email");
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toEqual({ field: "email" });
  });

  it("codes off: both endpoints 404", async () => {
    const e = direct({ AUTH_PROVIDERS: "google" });
    expect((await request(e, "a@x.com")).status).toBe(404);
    expect((await verify(e, "12345678", undefined)).status).toBe(404);
  });

  it("cross-site or missing X-OA-Request or JSON is 403 csrf", async () => {
    for (const headers of <Record<string, string>[]>[
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "x-oa-request": "" },
      { "sec-fetch-site": "", origin: "https://evil.test" },
      { "content-type": "text/plain" },
    ]) {
      const r = await request(direct(), "a@x.com", { headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect((await errOf(r)).code).toBe("csrf");
    }
    // No Sec-Fetch-Site but an exact Origin passes.
    const ok = await request(direct(), uniq("o", "x.com"), {
      headers: { "sec-fetch-site": "", origin: APP },
    });
    expect(ok.status).toBe(202);
  });

  it("the outside-domain owner and a Google-linked user get no email", async () => {
    const owner = uniq("boss", "x.com");
    await seedUser(owner, "owner");
    const linked = uniq("linked");
    await seedUser(linked, "member", { googleSub: `L-${linked}` });
    const m = mailer();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(TURNSTILE_OK),
    );
    await request(withMail(direct(), m), owner);
    await request(withMail(trial(), m), linked, { token: "ok" });
    expect(m.sent).toHaveLength(0);
  });
});

describe("POST AUTH.codeVerify", () => {
  async function start(e: Env, email: string, next = "/a/x") {
    const m = mailer();
    const em = withMail(e, m);
    const r = await request(em, email, { next });
    return {
      e: em,
      cookie: cookieOf(r, CODE_COOKIE),
      code: () => m.codeFor(email),
    };
  }

  it("RL_AUTH is checked first: a denial is 429 scope ip before any D1 call", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    const keys: string[] = [];
    let d1 = 0;
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === "prepare" || k === "batch" || k === "exec") d1++;
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await verify(
      {
        ...s.e,
        DB,
        RL_AUTH: {
          limit: async ({ key }: { key: string }) => {
            keys.push(key);
            return { success: false };
          },
        } as unknown as RateLimit,
      } as Env,
      "00000000",
      s.cookie,
      { ip: "203.0.113.7" },
    );
    expect(r.status).toBe(429);
    expect((await errOf(r)).details).toMatchObject({ scope: "ip" });
    expect(keys).toEqual(["inst-a:203.0.113.7"]);
    expect(d1).toBe(0);
  });

  it("guest round trip: 200 CodeVerified, readOnly, 24 h session p=code, cookie cleared", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    const r = await verify(s.e, s.code(), s.cookie);
    expect(r.status).toBe(200);
    const body = CodeVerifiedSchema.parse(await r.json());
    expect(body).toMatchObject({
      next: "/a/x",
      readOnly: true,
      user: { email: guest, role: "guest" },
    });
    expect(setCookieLine(r, SESSION)).toContain("Max-Age=86400");
    expect(
      await readSession(s.e, cookieOf(r, SESSION)?.split("=")[1]),
    ).toMatchObject({ p: "code" });
    expect(setCookieLine(r, CODE_COOKIE)).toContain("Max-Age=0");
  });

  it("a shared address with no row becomes a guest on verify", async () => {
    const addr = uniq("s", "x.com");
    await seedShare(addr);
    const s = await start(direct(), addr);
    const r = await verify(s.e, s.code(), s.cookie);
    expect(CodeVerifiedSchema.parse(await r.json()).user).toMatchObject({
      email: addr,
      role: "guest",
    });
  });

  it("trial domain member: 7 days, t = domain, not read-only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(TURNSTILE_OK),
    );
    const owner = uniq("own");
    await seedUser(owner, "owner");
    const m = mailer();
    const e = withMail(trial(), m);
    const r1 = await request(e, owner, { token: "ok" });
    const r = await verify(e, m.codeFor(owner), cookieOf(r1, CODE_COOKIE));
    expect(await r.json()).toMatchObject({
      readOnly: false,
      user: { role: "owner" },
    });
    expect(setCookieLine(r, SESSION)).toContain("Max-Age=604800");
    expect(
      await readSession(e, cookieOf(r, SESSION)?.split("=")[1]),
    ).toMatchObject({
      p: "code",
      t: "a.com",
    });
  });

  it("a restricted domain member is readOnly (the member's cap, as GET /me says), with restriction", async () => {
    // A fresh siteverify answer per request (a Response body reads once).
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(TURNSTILE_OK),
    );
    for (const how of ["manual", "group"] as const) {
      const who = uniq(`rst-${how}`);
      const id = await seedUser(who, "member");
      const gid = `g-rst-${crypto.randomUUID()}`;
      if (how === "manual")
        await env.DB.prepare(
          "update users set restricted_manual = 1 where id = ?",
        )
          .bind(id)
          .run();
      else
        await env.DB.batch([
          env.DB.prepare(
            "insert into directory_groups (group_id, email) values (?, ?)",
          ).bind(gid, `${gid}@a.com`),
          env.DB.prepare(
            "insert into restricted_groups (group_id, group_email) values (?, ?)",
          ).bind(gid, `${gid}@a.com`),
          env.DB.prepare(
            "insert into directory_members (group_id, user_id) values (?, ?)",
          ).bind(gid, id),
          env.DB.prepare(
            "update users set restricted_sync = 1 where id = ?",
          ).bind(id),
        ]);
      const m = mailer();
      const e = withMail(trial(), m);
      const r1 = await request(e, who, { token: "ok" });
      const r = await verify(e, m.codeFor(who), cookieOf(r1, CODE_COOKIE));
      expect(r.status).toBe(200);
      const body = CodeVerifiedSchema.parse(await r.json());
      expect(body.readOnly, how).toBe(true);
      expect(body.user.restriction, how).toEqual(
        how === "manual"
          ? { manual: true, groups: [] }
          : {
              manual: false,
              groups: [{ groupId: gid, email: `${gid}@a.com`, name: null }],
            },
      );
      // The domain session itself isn't a guest one (t = domain).
      expect(
        await readSession(e, cookieOf(r, SESSION)?.split("=")[1]),
      ).toMatchObject({ p: "code", t: "a.com" });
      const me = await fetchAndWait(
        app,
        new Request(`${APP}${R.me}`, {
          headers: { cookie: cookieOf(r, SESSION) as string },
        }),
        e,
      );
      expect(((await me.json()) as { auth: unknown }).auth).toMatchObject({
        readOnly: true,
        cap: "restricted",
      });
    }
  });

  it("reasons come from the cookie: invalid_code 4..1, then expired", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    let cookie = s.cookie;
    for (const left of [4, 3, 2, 1]) {
      const r = await verify(s.e, "00000000", cookie);
      expect(r.status).toBe(401);
      expect(
        CodeVerifyFailureDetailsSchema.parse((await errOf(r)).details),
      ).toEqual({
        reason: "invalid_code",
        attemptsLeft: left,
      });
      cookie = cookieOf(r, CODE_COOKIE);
    }
    const last = await verify(s.e, "00000000", cookie);
    expect((await errOf(last)).details).toEqual({ reason: "expired" });
  });

  it('"1234 567" and "1234a5678" are invalid_code and each uses an attempt', async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    const r1 = await verify(s.e, "1234 567", s.cookie);
    expect((await errOf(r1)).details).toEqual({
      reason: "invalid_code",
      attemptsLeft: 4,
    });
    const r2 = await verify(s.e, "1234a5678", cookieOf(r1, CODE_COOKIE));
    expect((await errOf(r2)).details).toEqual({
      reason: "invalid_code",
      attemptsLeft: 3,
    });
  });

  it("an address that never got a code answers exactly like a wrong guess", async () => {
    const seqFor = async (email: string) => {
      const s = await start(direct(), email);
      let cookie = s.cookie;
      const out = [];
      for (let i = 0; i < 5; i++) {
        const r = await verify(s.e, "00000000", cookie);
        out.push([r.status, (await errOf(r)).details]);
        cookie = cookieOf(r, CODE_COOKIE) ?? cookie;
      }
      return out;
    };
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    expect(await seqFor(uniq("nobody", "x.com"))).toEqual(await seqFor(guest));
  });

  it("no cookie or a forged cookie: no_pending", async () => {
    for (const cookie of [undefined, `${CODE_COOKIE}=abc.def`]) {
      const r = await verify(direct(), "12345678", cookie);
      expect(r.status).toBe(401);
      expect((await errOf(r)).details).toEqual({ reason: "no_pending" });
    }
  });

  it("next is safeNext'd", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest, "//evil.com");
    const r = await verify(s.e, s.code(), s.cookie);
    expect(CodeVerifiedSchema.parse(await r.json()).next).toBe("/");
  });

  it("the per-IP failure cap is 429 scope ip", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const ip = "192.0.2.99";
    let s = await start(direct(), guest);
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      if (i % 5 === 0) s = await start(direct(), guest);
      last = await verify(s.e, "00000000", s.cookie, { ip });
    }
    expect(last?.status).toBe(429);
    expect((await errOf(last as Response)).details).toMatchObject({
      scope: "ip",
    });
  });

  it("a guest whose eligibility ended between request and verify is refused", async () => {
    const guest = uniq("g", "x.com");
    const id = await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(id)
      .run();
    const r = await verify(s.e, s.code(), s.cookie);
    expect(r.status).toBe(401);
    expect(cookieOf(r, SESSION)).toBeUndefined();
  });

  it("the code cookie can't be replayed from another install", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    const other = { ...s.e, SESSION_SECRET: "q".repeat(32) } as Env;
    const r = await verify(other, s.code(), s.cookie);
    expect((await errOf(r)).details).toEqual({ reason: "no_pending" });
  });
});

describe("a SESSION_SECRET under 32 characters", () => {
  // No code keys can be derived, so the routes answer 503 code_unavailable
  // instead of a 500 on every request.
  const short = () => direct({ SESSION_SECRET: "s".repeat(20) });

  it("a code request is 503 code_unavailable", async () => {
    const r = await post(short(), AUTH.codeRequest, {
      email: "g@x.com",
      next: "/",
    });
    expect(r.status).toBe(503);
    expect(await errOf(r)).toMatchObject({ code: "code_unavailable" });
  });

  it("a verify that carries a pending cookie is 503 too", async () => {
    const r = await post(
      short(),
      AUTH.codeVerify,
      { code: "12345678" },
      { cookie: `${CODE_COOKIE}=abc.def` },
    );
    expect(r.status).toBe(503);
    expect(await errOf(r)).toMatchObject({ code: "code_unavailable" });
  });

  it("a verify with no pending cookie is still 401 before any key work", async () => {
    const r = await post(short(), AUTH.codeVerify, { code: "12345678" });
    expect(r.status).toBe(401);
    expect((await errOf(r)).details).toMatchObject({ reason: "no_pending" });
  });
});

describe("code routes: review fixes", () => {
  const pendingJson = (cookie: string | undefined) => {
    const v = (cookie ?? "").split("=")[1]?.split(".")[0] ?? "";
    return atob(v.replace(/-/g, "+").replace(/_/g, "/"));
  };

  it("no RL_AUTH binding outside dev: 503 code_unavailable", async () => {
    const r = await request(
      direct({ ENVIRONMENT: "production", RL_AUTH: undefined }),
      uniq("x", "x.com"),
    );
    expect(r.status).toBe(503);
    expect(await errOf(r)).toMatchObject({ code: "code_unavailable" });
  });

  it("hosted without Turnstile: 503 code_unavailable, before any counter or email", async () => {
    const m = mailer();
    const r = await request(
      withMail(
        direct({
          HOSTED: "1",
          TURNSTILE_SITE_KEY: undefined,
          TURNSTILE_SECRET: undefined,
        }),
        m,
      ),
      uniq("h", "x.com"),
    );
    expect(r.status).toBe(503);
    expect(await errOf(r)).toMatchObject({ code: "code_unavailable" });
    expect(cookieOf(r, CODE_COOKIE)).toBeUndefined();
    expect(m.sent).toHaveLength(0);
  });

  it("hosted with Turnstile configured still requires the token", async () => {
    const r = await request(
      direct({ HOSTED: "1", TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" }),
      uniq("h", "x.com"),
    );
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("turnstile_required");
  });

  it("the pending cookie never holds the plaintext address", async () => {
    const addr = uniq("plain", "x.com");
    const r = await request(direct(), addr);
    const json = pendingJson(cookieOf(r, CODE_COOKIE));
    expect(json).not.toContain(addr);
    expect(json).not.toContain("plain-");
    expect(JSON.parse(json)).not.toHaveProperty("email");
  });

  it("a next past 512 bytes becomes / and keeps the cookie small", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const r1 = await request(e, guest, { next: `/a/${"x".repeat(2000)}` });
    expect(setCookieLine(r1, CODE_COOKIE).length).toBeLessThan(1024);
    const r = await verify(e, m.codeFor(guest), cookieOf(r1, CODE_COOKIE));
    expect(CodeVerifiedSchema.parse(await r.json()).next).toBe("/");
    const long = `/a/${"y".repeat(500)}`;
    const ok = await request(e, uniq("g", "x.com"), { next: long });
    expect(JSON.parse(pendingJson(cookieOf(ok, CODE_COOKIE))).next).toBe(long);
  });

  it("carries a non-zero session epoch into the session", async () => {
    const guest = uniq("g", "x.com");
    const id = await seedUser(guest, "guest");
    await env.DB.prepare("update users set session_epoch = 3 where id = ?")
      .bind(id)
      .run();
    const m = mailer();
    const e = withMail(direct(), m);
    const r1 = await request(e, guest);
    const r = await verify(e, m.codeFor(guest), cookieOf(r1, CODE_COOKIE));
    expect(r.status).toBe(200);
    const sess = cookieOf(r, SESSION);
    expect(await readSession(e, sess?.split("=")[1])).toMatchObject({ e: 3 });
    const me = await app.fetch(
      new Request(`${APP}/api/v1/me`, { headers: { cookie: sess ?? "" } }),
      e,
    );
    expect(me.status).toBe(200);
  });

  // A row that appears between the eligibility check and ensureUser (a
  // concurrent sign-in or invite) is what the session would get, so role and
  // link are read again: an admin row outside the domains, or a Google-linked
  // row, is refused.
  for (const kind of ["admin", "linked"] as const) {
    it(`a ${kind} row created during verify is re-checked: 401, no session`, async () => {
      const addr = uniq(`race-${kind}`, "x.com");
      await seedShare(addr);
      const m = mailer();
      const e = withMail(direct(), m);
      const r1 = await request(e, addr);
      const trig = `race_${kind}_${crypto.randomUUID().slice(0, 8)}`;
      const role = kind === "admin" ? "admin" : "guest";
      const link =
        kind === "linked"
          ? "insert into identities (provider, subject, tenant, user_id, created_at) values ('google', 'sub-' || NEW.email, 'x.com', 'race-' || NEW.email, 0);"
          : "";
      await env.DB.prepare(
        `create trigger ${trig} before insert on users when NEW.email = '${addr}' and NEW.id <> 'race-${addr}'
         begin
           insert into users (id, email, name, role, created_at, status) values ('race-' || NEW.email, NEW.email, 'r', '${role}', 0, 'active');
           ${link}
         end`,
      ).run();
      try {
        const r = await verify(e, m.codeFor(addr), cookieOf(r1, CODE_COOKIE));
        expect(r.status).toBe(401);
        expect(cookieOf(r, SESSION)).toBeUndefined();
      } finally {
        await env.DB.prepare(`drop trigger if exists ${trig}`).run();
      }
    });
  }

  it("an MCP OAuth popup signs in by code and completes consent", async () => {
    const W = "https://app.localhost";
    const REDIRECT = "http://localhost:3333/cb";
    const b64 = (b: ArrayBuffer | Uint8Array) =>
      btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const member = uniq("mcp");
    await seedUser(member, "member");
    const m = mailer();
    const e = withMail(trial(), m);
    const call = (req: Request) => callWorker(req, e);
    const reg = await call(
      new Request(`${W}/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": nextIp(),
        },
        body: JSON.stringify({
          client_name: "Popup Agent",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
    );
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const authorize = `${W}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st4te",
      resource: `${W}/mcp`,
    })}`;
    // 1. No session: the popup goes to sign-in, which sends it to the SPA.
    const a1 = await call(new Request(authorize));
    expect(a1.status).toBe(302);
    const login = new URL(a1.headers.get("location") ?? "", W);
    const l1 = await call(new Request(`${W}${login.pathname}${login.search}`));
    const spa = new URL(l1.headers.get("location") ?? "", W);
    const next = spa.searchParams.get("next") ?? "";
    const u = new URL(authorize);
    expect(next).toBe(`${u.pathname}${u.search}`);
    // 2. The SPA requests a code with that next, then verifies it.
    const ts = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(TURNSTILE_OK));
    const rq = await request(e, member, { next, token: "ok" });
    ts.mockRestore();
    expect(rq.status).toBe(202);
    const vr = await verify(e, m.codeFor(member), cookieOf(rq, CODE_COOKIE));
    expect(vr.status).toBe(200);
    const body = CodeVerifiedSchema.parse(await vr.json());
    expect(body.next).toBe(next);
    const session = cookieOf(vr, SESSION) ?? "";
    // 3. Back at the authorize URL: consent, approve, token.
    const page = await call(
      new Request(`${W}${body.next}`, { headers: { cookie: session } }),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("cross-origin-opener-policy")).toBeNull();
    const html = await page.text();
    const field = (n: string) =>
      new RegExp(`name="${n}" value="([^"]*)"`).exec(html)?.[1] ?? "";
    const form = new URLSearchParams({
      csrf: field("csrf"),
      request: field("request"),
      decision: "approve",
    }).toString();
    const bound = page.headers.getSetCookie().map((c) => c.split(";")[0]);
    const d = await call(
      new Request(`${W}/oauth/authorize`, {
        method: "POST",
        headers: {
          cookie: [session, ...bound].join("; "),
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(form.length),
        },
        body: form,
      }),
    );
    expect(d.status).toBe(302);
    const loc = new URL(d.headers.get("location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st4te");
    const t = await call(
      new Request(`${W}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": nextIp(),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: loc.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
          resource: `${W}/mcp`,
        }).toString(),
      }),
    );
    expect(t.status).toBe(200);
    expect(
      ((await t.json()) as { access_token?: string }).access_token,
    ).toBeTruthy();
  });
});

// Review item 13: a re-request that sends nothing (resend_wait, capped,
// pool_full, send_failed) must not orphan the code already in the inbox.
describe("a code re-request keeps the pending request id", () => {
  const ridOf = (cookie: string | undefined) => {
    const v = (cookie ?? "").split("=")[1]?.split(".")[0] ?? "";
    return (
      JSON.parse(atob(v.replace(/-/g, "+").replace(/_/g, "/"))) as {
        rid: string;
      }
    ).rid;
  };

  it("a re-request inside the resend wait leaves the first code usable", async () => {
    const guest = uniq("rs", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const ip = "198.51.100.201";
    const r1 = await request(e, guest, { ip });
    const first = m.codeFor(guest);
    const r2 = await request(e, guest, {
      ip,
      cookie: cookieOf(r1, CODE_COOKIE),
    });
    expect(m.sent).toHaveLength(1);
    // The 202 is the same either way: nothing says whether a code went out.
    expect(await r2.json()).toEqual(await r1.json());
    expect(ridOf(cookieOf(r2, CODE_COOKIE))).toBe(
      ridOf(cookieOf(r1, CODE_COOKIE)),
    );
    const v = await verify(e, first, cookieOf(r2, CODE_COOKIE), { ip });
    expect(v.status).toBe(200);
  });

  it("a resend after the wait replaces the code under the same id", async () => {
    const guest = uniq("rs2", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const ip = "198.51.100.202";
    const r1 = await request(e, guest, { ip });
    const first = m.codeFor(guest);
    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    const r2 = await request(e, guest, {
      ip,
      cookie: cookieOf(r1, CODE_COOKIE),
    });
    expect(m.sent).toHaveLength(2);
    const second = m.codeFor(guest);
    expect(second).not.toBe(first);
    const c2 = cookieOf(r2, CODE_COOKIE);
    const bad = await verify(e, first, c2, { ip });
    expect(bad.status).toBe(401);
    const ok = await verify(e, second, cookieOf(bad, CODE_COOKIE) ?? c2, {
      ip,
    });
    expect(ok.status).toBe(200);
  });

  it("a resend whose email fails leaves the earlier code usable", async () => {
    const guest = uniq("rs3", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const ip = "198.51.100.203";
    const r1 = await request(withMail(direct(), m), guest, { ip });
    const first = m.codeFor(guest);
    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    const r2 = await request(withMail(direct(), mailer(true)), guest, {
      ip,
      cookie: cookieOf(r1, CODE_COOKIE),
    });
    expect(r2.status).toBe(202);
    const v = await verify(
      withMail(direct(), m),
      first,
      cookieOf(r2, CODE_COOKIE),
      { ip },
    );
    expect(v.status).toBe(200);
  });

  it("a cookie for another address, or none, gets a new id", async () => {
    const a = uniq("rsa", "x.com");
    const b = uniq("rsb", "x.com");
    const e = withMail(direct());
    const r1 = await request(e, a);
    const r2 = await request(e, b, { cookie: cookieOf(r1, CODE_COOKIE) });
    const r3 = await request(e, a);
    const rid1 = ridOf(cookieOf(r1, CODE_COOKIE));
    expect(ridOf(cookieOf(r2, CODE_COOKIE))).not.toBe(rid1);
    expect(ridOf(cookieOf(r3, CODE_COOKIE))).not.toBe(rid1);
  });
});
