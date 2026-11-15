// #2590 G2: a first Google login refused with needs_code (weak evidence for
// its address) links after an emailed code to that exact address.
import { env } from "cloudflare:workers";
import { AUTH, R, SIGN_IN_PAGE } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { readSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { shareReach } from "../src/services/reach.js";
import { direct, mailer, seedShare, seedUser, uniq } from "./auth-helpers.js";
import { fakeGoogle } from "./fixtures/fake-google.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const get = (e: Env, path: string, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const post = async (e: Env, path: string, body: unknown, cookie?: string) => {
  const waits: Promise<unknown>[] = [];
  const r = await app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": "198.51.100.88",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(waits);
  return r;
};

async function google(e: Env, claims: Record<string, unknown>) {
  const g = await fakeGoogle();
  const start = await get(e, `${AUTH.loginGoogle}?next=/`);
  const u = new URL(start.headers.get("location") ?? "");
  const cookie =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  const code = g.issueCode(
    { nonce: u.searchParams.get("nonce"), ...claims },
    u.searchParams.get("code_challenge") as string,
  );
  return get(
    e,
    `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
    cookie,
  );
}

const cookieOf = (r: Response, name: RegExp) =>
  r.headers
    .getSetCookie()
    .find((c) => name.test(c))
    ?.split(";")[0];
const loc = (r: Response) => r.headers.get("location") ?? "";
const SESSION = /oa_session=[^;]+/;

/** An install that offers Google and codes, with a mailer that records mail. */
function install(over: Partial<Env> = {}) {
  const m = mailer();
  const e = direct({ AUTH_DOMAIN_JOIN: "invite", ...over, ...m.env });
  return { e: e as Env, m };
}
/** A weak Google account: another domain, no hd for it. */
const weak = (email: string) => ({ email, sub: `sub-${email}`, hd: undefined });
const countRows = async (email: string) =>
  (
    await env.DB.prepare("select count(*) n from users where email = ?")
      .bind(email)
      .first<{ n: number }>()
  )?.n;
const subjectOf = async (email: string) =>
  (
    await env.DB.prepare(
      "select i.subject s from identities i join users u on u.id = i.user_id where u.email = ?",
    )
      .bind(email)
      .first<{ s: string }>()
  )?.s ?? null;

/** Weak Google login, then a code to the same address, verified. */
async function linkFlow(e: Env, m: ReturnType<typeof mailer>, email: string) {
  const g = await google(e, weak(email));
  const link = cookieOf(g, /oa_glink=/);
  const req = await post(e, AUTH.codeRequest, { link: true }, link);
  const pending = cookieOf(req, /oa_code=/);
  const code = m.codeFor(email);
  return { g, link, req, pending, code };
}

describe("a weak first Google login links after a code (#2590 G2)", () => {
  it("a weak share recipient: needs_code, a code, a guest row, then straight in", async () => {
    const { e, m } = install();
    const email = uniq("rcpt", "custom.example");
    await seedShare(email);
    const { g, link, req, pending, code } = await linkFlow(e, m, email);
    expect(g.status).toBe(302);
    expect(loc(g)).toContain(`${SIGN_IN_PAGE}?error=needs_code`);
    // The address is never in the URL: the page asks for the masked one.
    expect(loc(g)).toContain("link=1");
    expect(loc(g)).not.toContain(encodeURIComponent(email));
    const who = await get(e, AUTH.codeLink, link);
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({
      maskedEmail: `${email.slice(0, 1)}***${email.slice(email.lastIndexOf("@"))}`,
    });
    expect((await get(e, AUTH.codeLink)).status).toBe(404);
    expect(link).toBeDefined();
    expect(cookieOf(g, SESSION)).toBeUndefined();
    expect(req.status).toBe(202);
    expect(code).toBeTruthy();
    expect(await countRows(email)).toBe(0);
    const ok = await post(e, AUTH.codeVerify, { code }, `${link}; ${pending}`);
    expect(ok.status).toBe(200);
    const sess = await readSession(e, cookieOf(ok, SESSION)?.split("=")[1]);
    expect(sess).toMatchObject({ p: "google" });
    expect(
      await env.DB.prepare("select role from users where email = ?")
        .bind(email)
        .first(),
    ).toEqual({ role: "guest" });
    expect(await subjectOf(email)).toBe(`sub-${email}`);
    // The next login goes straight in by subject: no code.
    const again = await google(e, weak(email));
    expect(loc(again)).toBe("/");
    expect(cookieOf(again, SESSION)).toBeDefined();
  });

  it("a weak invited member: a code, then linked as a member", async () => {
    const { e, m } = install();
    const email = uniq("inv", "custom.example");
    const uid = await seedUser(email, "member");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();
    const { g, link, pending, code } = await linkFlow(e, m, email);
    expect(loc(g)).toContain("error=needs_code");
    const ok = await post(e, AUTH.codeVerify, { code }, `${link}; ${pending}`);
    expect(ok.status).toBe(200);
    expect(await subjectOf(email)).toBe(`sub-${email}`);
    expect(
      await env.DB.prepare("select role from users where email = ?")
        .bind(email)
        .first(),
    ).toEqual({ role: "member" });
  });

  it("codes off: needs_code, no link cookie, no email", async () => {
    const m = mailer();
    const e = direct({
      AUTH_DOMAIN_JOIN: "invite",
      AUTH_PROVIDERS: "google",
      ...m.env,
    }) as Env;
    const email = uniq("off", "custom.example");
    await seedShare(email);
    const g = await google(e, weak(email));
    expect(loc(g)).toBe(`${SIGN_IN_PAGE}?error=needs_code&next=%2F`);
    expect(cookieOf(g, /oa_glink=/)).toBeUndefined();
    const req = await post(e, AUTH.codeRequest, { email });
    expect(req.status).toBe(404);
    expect(m.sent).toHaveLength(0);
  });

  it("a wrong code is refused: no session, nothing linked", async () => {
    const { e, m } = install();
    const email = uniq("bad", "custom.example");
    await seedShare(email);
    const { link, pending } = await linkFlow(e, m, email);
    const r = await post(
      e,
      AUTH.codeVerify,
      { code: "00000000" },
      `${link}; ${pending}`,
    );
    expect(r.status).toBe(401);
    expect(cookieOf(r, SESSION)).toBeUndefined();
    expect(await subjectOf(email)).toBeNull();
    expect(await countRows(email)).toBe(0);
  });

  it("another browser (no link cookie): no code is sent for an invited member; nothing links", async () => {
    const { e, m } = install();
    const email = uniq("other", "custom.example");
    const uid = await seedUser(email, "member");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();
    const req = await post(e, AUTH.codeRequest, { email });
    expect(req.status).toBe(202);
    expect(() => m.codeFor(email)).toThrow();
    expect(await subjectOf(email)).toBeNull();
  });

  it("a link cookie for another address starts no link request", async () => {
    const { e, m } = install();
    const email = uniq("mine", "custom.example");
    const other = uniq("theirs", "custom.example");
    await seedShare(email);
    await seedShare(other);
    const g = await google(e, weak(email));
    const link = cookieOf(g, /oa_glink=/);
    const req = await post(e, AUTH.codeRequest, { email: other }, link);
    const pending = cookieOf(req, /oa_code=/);
    // A guest share by code is the ordinary code flow: it signs in by code,
    // never linking the Google account.
    const code = m.codeFor(other);
    const ok = await post(e, AUTH.codeVerify, { code }, `${link}; ${pending}`);
    expect(ok.status).toBe(200);
    expect(await subjectOf(other)).toBeNull();
    expect(await subjectOf(email)).toBeNull();
  });

  it("the link cookie expires on its own", async () => {
    const { e, m } = install();
    const email = uniq("exp", "custom.example");
    await seedShare(email);
    const g = await google(e, weak(email));
    const link = cookieOf(g, /oa_glink=/) ?? "";
    expect((await get(e, AUTH.codeLink, link)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
    try {
      expect((await get(e, AUTH.codeLink, link)).status).toBe(404);
      const req = await post(e, AUTH.codeRequest, { link: true }, link);
      expect(req.status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
    expect(() => m.codeFor(email)).toThrow();
    expect(await subjectOf(email)).toBeNull();
  });

  it("a forged link cookie is refused", async () => {
    const { e } = install();
    const bogus = "oa_glink=" + "x".repeat(20) + "." + "y".repeat(20);
    expect((await get(e, AUTH.codeLink, bogus)).status).toBe(404);
    expect(
      (await post(e, AUTH.codeRequest, { link: true }, bogus)).status,
    ).toBe(400);
  });

  it("the invite.accept audit row is written on the link path", async () => {
    const { e, m } = install();
    const email = uniq("aud", "custom.example");
    // A real invite, so invite.create exists for this person.
    const owner = await login(uniq("own", "x.com"), "owner");
    const inv = await fetchAndWait(
      app,
      new Request(`${APP}${R.members}`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, role: "member" }),
      }),
      e,
    );
    expect(inv.status).toBe(201);
    const uid = (
      await env.DB.prepare("select id from users where email = ?")
        .bind(email)
        .first<{ id: string }>()
    )?.id;
    const { link, pending, code } = await linkFlow(e, m, email);
    const ok = await post(e, AUTH.codeVerify, { code }, `${link}; ${pending}`);
    expect(ok.status).toBe(200);
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from audit_events where action = 'invite.accept' and target_id = ?",
        )
          .bind(uid)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("a Google account already linked to another person links nothing", async () => {
    const { e, m } = install();
    const email = uniq("dup", "custom.example");
    await seedShare(email);
    const { link, pending, code } = await linkFlow(e, m, email);
    // Between the callback and the code, that Google account got linked elsewhere.
    await seedUser(uniq("someone", "a.com"), "member", {
      googleSub: `sub-${email}`,
    });
    const ok = await post(e, AUTH.codeVerify, { code }, `${link}; ${pending}`);
    expect(ok.status).toBe(401);
    expect(cookieOf(ok, SESSION)).toBeUndefined();
    expect(await subjectOf(email)).toBeNull();
  });
});

describe("who shared it (#2606)", () => {
  const sharedBy = async (e: Env, email: string) => {
    const g = await google(e, weak(email));
    const link = cookieOf(g, /oa_glink=/);
    const r = await get(e, AUTH.codeLink, link);
    expect(r.status).toBe(200);
    return ((await r.json()) as { sharedBy: { name: string } | null }).sharedBy;
  };
  const shareFrom = async (email: string, name: string, at: number) => {
    const owner = await seedUser(uniq("sharer", "a.com"), "member");
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(name, owner)
      .run();
    const art = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.DB.prepare(
      "insert into artifacts (id, owner_id, title, format, created_at, updated_at) values (?, ?, 't', 'markdown', ?, ?)",
    )
      .bind(art, owner, at, at)
      .run();
    await env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
    )
      .bind(art, email, owner, at)
      .run();
    return art;
  };

  it("names the sharer of the newest live share", async () => {
    const { e } = install();
    const email = uniq("who", "custom.example");
    await shareFrom(email, "Older Person", Date.now() - 5000);
    await shareFrom(email, "Newest Person", Date.now());
    expect(await sharedBy(e, email)).toEqual({ name: "Newest Person" });
  });

  it("skips a share on a deleted page", async () => {
    const { e } = install();
    const email = uniq("who2", "custom.example");
    await shareFrom(email, "Kept", Date.now() - 5000);
    const gone = await shareFrom(email, "Deleted Page Sharer", Date.now());
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now(), gone)
      .run();
    expect(await sharedBy(e, email)).toEqual({ name: "Kept" });
  });

  it("is null for an invite", async () => {
    const { e } = install();
    const email = uniq("who3", "custom.example");
    const uid = await seedUser(email, "member");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();
    expect(await sharedBy(e, email)).toBeNull();
  });
});

describe("reach and shares (#2598)", () => {
  it("N2: google_after_code where Google and codes are on; workspace_only only where codes are off", async () => {
    const on = install().e;
    const email = uniq("r", "custom.example");
    expect((await shareReach(on, email)).ways).toEqual([
      "google_workspace",
      "google_after_code",
      "email_code",
    ]);
    expect((await shareReach(on, email)).recipient).toBeUndefined();
    const m = mailer();
    const off = direct({
      AUTH_DOMAIN_JOIN: "invite",
      AUTH_PROVIDERS: "google",
      ...m.env,
    }) as Env;
    const r = await shareReach(off, email);
    expect(r.ways).toEqual(["google_workspace"]);
    expect(r.recipient).toEqual({
      canSignIn: false,
      reason: "workspace_only",
    });
  });

  it("N3: a share on a deleted page admits nothing", async () => {
    const { e } = install();
    const email = uniq("del", "gmail.com");
    const art = await seedShare(email);
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now(), art)
      .run();
    const g = await google(e, { email, sub: `sub-${email}`, hd: undefined });
    expect(loc(g)).toContain("error=no_access");
    expect(cookieOf(g, SESSION)).toBeUndefined();
    expect(await countRows(email)).toBe(0);
  });

  it("N1: an admin raises a guest to member with PATCH", async () => {
    const owner = await login(uniq("own", "x.com"), "owner");
    const g = await login(uniq("g", "x.com"), "guest");
    const r = await fetchAndWait(
      app,
      new Request(`${APP}${R.member(g.userId)}`, {
        method: "PATCH",
        headers: {
          cookie: owner.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "member" }),
      }),
      env as Env,
    );
    expect(
      r.status,
      JSON.stringify(await errOf(r.clone()).catch(() => "")),
    ).toBe(200);
    expect(
      await env.DB.prepare("select role from users where id = ?")
        .bind(g.userId)
        .first(),
    ).toEqual({ role: "member" });
  });
});
