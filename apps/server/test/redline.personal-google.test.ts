// Red-line, in-server: personal Google accounts (no hd) for invited people.
// Every case runs the real routes: /auth/login/google, a Google ID token
// signed by the fake Google's test JWKS (fixtures/fake-google.ts), and
// /auth/callback/google, so the verifier (@oa/auth-core) and admission
// (services/identity.ts) both run. The admitted case comes first in each
// group's setup terms, so a server that refuses everyone can't pass.
import { env } from "cloudflare:workers";
import { AUTH, type Me, R, SIGN_IN_PAGE } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { CONFLICT_KEY, PERSONAL_TENANT } from "../src/services/identity.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);
// Pinned at midday UTC: tokens, state cookies and the conflict flag agree.
const NOON = Date.UTC(2026, 9, 29, 12, 0, 0);

const get = (path: string, e: Env, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const loc = (r: Response) => r.headers.get("location") ?? "";
const refused = (error: string) =>
  `${SIGN_IN_PAGE}?error=${error}&next=%2Fa%2Fx${
    error === "no_access" ? "&via=google" : ""
  }`;

/** A Workspace install (a.com) and a Gmail-only one (no AUTH_DOMAINS). */
const workspace = () => direct({ AUTH_DOMAIN_JOIN: "member" });
const gmailOnly = () =>
  direct({ AUTH_DOMAINS: "", AUTH_DOMAIN_JOIN: "invite" });

let g: FakeGoogle;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOON });
  g = await fakeGoogle();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** /auth/login/google → fake Google (these claims) → /auth/callback/google. */
async function signIn(e: Env, claims: Record<string, unknown>) {
  const start = await get(`${AUTH.loginGoogle}?next=%2Fa%2Fx`, e);
  expect(start.status).toBe(302);
  const u = new URL(loc(start));
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
    `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
    e,
    cookie,
  );
}
/** A personal account's claims: no hd. */
const gmail = (
  email: string,
  sub: string,
  o: Record<string, unknown> = {},
) => ({
  email,
  sub,
  hd: undefined,
  ...o,
});
const sessionOf = async (e: Env, r: Response) =>
  readSession(
    e,
    r.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`))
      ?.slice(SESSION.length + 1)
      .split(";")[0],
  );
const count = async (sql: string, ...b: unknown[]) =>
  (
    await env.DB.prepare(`select count(*) n from ${sql}`)
      .bind(...b)
      .first<{ n: number }>()
  )?.n;
const pinned = async (uid: string) =>
  (
    await env.DB.prepare(
      "select subject s from identities where provider = 'google' and user_id = ?",
    )
      .bind(uid)
      .first<{ s: string }>()
  )?.s ?? null;

describe("red-line: personal Google accounts (no hd)", () => {
  it("the invited Gmail owner of a Gmail-only install: admitted and pinned", async () => {
    const e = gmailOnly();
    const email = uniq("own", "gmail.com");
    const sub = `own-${email}`;
    const uid = await seedUser(email, "owner");
    // No Workspace hint on Google's account chooser.
    const start = await get(AUTH.loginGoogle, e);
    expect(new URL(loc(start)).searchParams.has("hd")).toBe(false);
    const r = await signIn(e, gmail(email, sub));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/a/x");
    const s = await sessionOf(e, r);
    expect(s).toMatchObject({ uid, p: "google" });
    expect(s).not.toHaveProperty("t");
    expect(await pinned(uid)).toBe(sub);
    expect(
      await count(
        "identities where user_id = ? and tenant = ?",
        uid,
        PERSONAL_TENANT,
      ),
    ).toBe(1);
  });

  it("an AUTH_DOMAINS address with no hd: refused (tenant), even when invited", async () => {
    const e = workspace();
    const email = uniq("co");
    const uid = await seedUser(email, "member");
    // Its Workspace sign-in (hd a.com) is admitted: the refusal is the rule.
    const ok = await signIn(e, { email, sub: `ws-${email}`, hd: "a.com" });
    expect(loc(ok)).toBe("/a/x");
    await env.DB.prepare("delete from identities where user_id = ?")
      .bind(uid)
      .run();
    const r = await signIn(e, gmail(email, `p-${email}`));
    expect(loc(r)).toBe(refused("tenant"));
    expect(await pinned(uid)).toBeNull();
  });

  it("an unverified email: refused", async () => {
    const e = gmailOnly();
    const email = uniq("unv", "gmail.com");
    const uid = await seedUser(email, "member");
    for (const email_verified of [false, undefined, "true"]) {
      const r = await signIn(e, gmail(email, `u-${email}`, { email_verified }));
      expect(loc(r)).toBe(refused("failed"));
    }
    expect(await pinned(uid)).toBeNull();
  });

  it("a sub mismatch: refused, with the audit row and the owner's sign-in problem (no address)", async () => {
    const e = gmailOnly();
    const owner = await login(uniq("boss", "gmail.com"), "owner");
    const member = await login(uniq("mem", "gmail.com"), "member");
    const me = async (cookie: string) =>
      ((await (await get(R.me, e, cookie)).json()) as Me).instance.signIn;
    await env.DB.prepare("delete from settings where key = ?")
      .bind(CONFLICT_KEY)
      .run();
    expect((await me(owner.cookie))?.problems).toEqual([]);
    const email = uniq("pin", "gmail.com");
    const uid = await seedUser(email, "member");
    expect(loc(await signIn(e, gmail(email, `first-${email}`)))).toBe("/a/x");
    const r = await signIn(e, gmail(email, `second-${email}`));
    expect(loc(r)).toBe(refused("identity_conflict"));
    expect(
      r.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=`)),
    ).toBe(false);
    expect(await pinned(uid)).toBe(`first-${email}`);
    const rows = (
      await env.DB.prepare(
        "select actor_kind k, actor_id a, detail d from audit_events where action = 'auth.refused' and target_id = ?",
      )
        .bind(uid)
        .all<{ k: string; a: string | null; d: string }>()
    ).results;
    expect(rows).toEqual([
      {
        k: "system",
        a: null,
        d: JSON.stringify({ provider: "google", reason: "identity_conflict" }),
      },
    ]);
    const problems = (await me(owner.cookie))?.problems ?? [];
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^A Google sign-in was refused because/);
    expect(problems[0]).not.toMatch(/@/);
    expect(JSON.stringify(problems)).not.toContain(email);
    // Owners only.
    expect(await me(member.cookie)).not.toHaveProperty("problems");
  });

  it("an uninvited Gmail: refused, no user created", async () => {
    for (const e of [gmailOnly(), workspace()]) {
      const email = uniq("stranger", "gmail.com");
      const r = await signIn(e, gmail(email, `s-${email}`));
      expect(loc(r)).toBe(refused("no_access"));
      expect(await count("users where email = ?", email)).toBe(0);
      expect(await count("identities where subject = ?", `s-${email}`)).toBe(0);
    }
  });

  it("another install's invitee: refused (its token, and its address here)", async () => {
    const e = gmailOnly();
    const email = uniq("theirs", "gmail.com");
    // A token Google minted for another install's client.
    const other = await signIn(
      e,
      gmail(email, `t-${email}`, {
        aud: "other.apps.googleusercontent.com",
        azp: "other.apps.googleusercontent.com",
      }),
    );
    expect(loc(other)).toBe(refused("failed"));
    // A valid token for this install, but the invite is the other install's.
    const r = await signIn(e, gmail(email, `t-${email}`));
    expect(loc(r)).toBe(refused("no_access"));
    expect(await count("users where email = ?", email)).toBe(0);
  });

  it("a Workspace hd not in the domains: refused, as today", async () => {
    for (const e of [workspace(), gmailOnly()]) {
      const email = uniq("eve", "b.com");
      await seedUser(email, "member");
      const r = await signIn(e, { email, sub: `b-${email}`, hd: "b.com" });
      expect(loc(r)).toBe(refused("tenant"));
      expect(await count("identities where subject = ?", `b-${email}`)).toBe(0);
    }
  });
  it("R1: an invited googlemail.com address is admitted; an invited bob@partner.com with no hd is refused (tenant)", async () => {
    const e = workspace();
    const gm = uniq("gm", "googlemail.com");
    const gmUid = await seedUser(gm, "member");
    const ok = await signIn(e, gmail(gm, `gm-${gm}`));
    expect(loc(ok)).toBe("/a/x");
    expect(await pinned(gmUid)).toBe(`gm-${gm}`);
    for (const env of [workspace(), gmailOnly()]) {
      const bob = uniq("bob", "partner.com");
      const uid = await seedUser(bob, "member");
      const r = await signIn(env, gmail(bob, `pb-${bob}`));
      expect(loc(r)).toBe(refused("tenant"));
      expect(
        r.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=`)),
      ).toBe(false);
      expect(await pinned(uid)).toBeNull();
    }
  });

  it("R2: a personal session dies once AUTH_DOMAINS covers its domain; Workspace (hd) then admits the person", async () => {
    const before = workspace();
    const email = uniq("pd", "gmail.com");
    const sub = `pd-${email}`;
    const uid = await seedUser(email, "member");
    const r = await signIn(before, gmail(email, sub));
    expect(loc(r)).toBe("/a/x");
    const s = await sessionOf(before, r);
    expect(s).toMatchObject({ uid, p: "google", pd: "gmail.com" });
    expect(s).not.toHaveProperty("t");
    const cookie = `${SESSION}=${
      r.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${SESSION}=`))
        ?.slice(SESSION.length + 1)
        .split(";")[0]
    }`;
    // Admitted case first: the session works while gmail.com isn't verified.
    expect((await get(R.me, before, cookie)).status).toBe(200);
    const after = direct({
      AUTH_DOMAINS: "a.com,gmail.com",
      AUTH_DOMAIN_JOIN: "member",
    });
    expect((await get(R.me, after, cookie)).status).toBe(401);
    // A personal sign-in is now refused; the Workspace one (hd) admits them,
    // and the identity becomes that tenant's (R3).
    expect(loc(await signIn(after, gmail(email, sub)))).toBe(refused("tenant"));
    const ws = await signIn(after, { email, sub, hd: "gmail.com" });
    expect(loc(ws)).toBe("/a/x");
    expect(await sessionOf(after, ws)).toMatchObject({ uid, t: "gmail.com" });
    expect(
      await count(
        "identities where user_id = ? and tenant = ?",
        uid,
        "gmail.com",
      ),
    ).toBe(1);
  });
});
