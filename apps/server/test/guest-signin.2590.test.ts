// #2590 G1: a share recipient logs in with Google as a guest, stays a guest,
// loses access with their last share, and the reach tells the truth.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authConfig } from "../src/auth/config.js";
import type { VerifiedIdentity } from "../src/auth/providers/types.js";
import type { Env } from "../src/env.js";
import { admit } from "../src/services/identity.js";
import { shareReach } from "../src/services/reach.js";
import { removeGuestIfUnshared } from "../src/services/shares.js";
import { direct, seedShare, seedUser, trial, uniq } from "./auth-helpers.js";

const one = async <T>(sql: string, ...b: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...b)
    .first<T>()) as T;
const sub = () => `sub-${crypto.randomUUID()}`;
const run = (e: Env, id: VerifiedIdentity) => admit(e, authConfig(e), id);

/** A Gmail login: no hd, no tenant, bound to its address. */
const gmail = (email = uniq("gm", "gmail.com")): VerifiedIdentity => ({
  provider: "google",
  subject: sub(),
  email,
  name: "G",
  tenant: null,
  hd: null,
  bound: "email",
});
/** A Workspace login on a login domain: hd is the tenant. */
const onLogin = (email = uniq("ws", "a.com")): VerifiedIdentity => ({
  provider: "google",
  subject: sub(),
  email,
  name: "W",
  tenant: "a.com",
  hd: "a.com",
});
/** A weak login: another domain, no hd for it. */
const weak = (email = uniq("wk", "other.com")): VerifiedIdentity => ({
  provider: "google",
  subject: sub(),
  email,
  name: "K",
  tenant: null,
  hd: null,
  bound: "email",
});
const INVITE = () => direct({ AUTH_DOMAIN_JOIN: "invite" });
const roleOf = async (email: string) =>
  (
    await one<{ role: string } | null>(
      "select role from users where email = ?",
      email,
    )
  )?.role;

describe("a share recipient logs in with Google as a guest", () => {
  it("a Gmail recipient with no row gets a guest row bound to the address", async () => {
    const id = gmail();
    await seedShare(id.email);
    const out = await run(INVITE(), id);
    expect(out).toMatchObject({ ok: true, user: { role: "guest" } });
    expect(
      await one<{ n: number; inv: number | null }>(
        "select count(*) n, max(invited_at) inv from users u join identities i on i.user_id = u.id where u.email = ?",
        id.email,
      ),
    ).toEqual({ n: 1, inv: null });
  });

  it("works with no login domains at all", async () => {
    const id = gmail();
    await seedShare(id.email);
    const e = direct({ AUTH_DOMAINS: "", AUTH_DOMAIN_JOIN: "invite" });
    expect(await run(e, id)).toMatchObject({
      ok: true,
      user: { role: "guest" },
    });
  });

  it("a Workspace recipient on a login domain stays a guest, even with join = member", async () => {
    const id = onLogin();
    await seedShare(id.email);
    // The domain would join a stranger as a member; a share-created guest
    // row is never promoted, on first and later logins.
    await seedUser(id.email, "guest");
    const e = direct({ AUTH_DOMAIN_JOIN: "member" });
    expect(await run(e, id)).toMatchObject({
      ok: true,
      user: { role: "guest" },
    });
    expect(await run(e, { ...id })).toMatchObject({ ok: true });
    expect(await roleOf(id.email)).toBe("guest");
  });

  it("a Workspace recipient with no row on an invite-only install gets a guest row", async () => {
    const id = onLogin();
    await seedShare(id.email);
    expect(await run(INVITE(), id)).toMatchObject({
      ok: true,
      user: { role: "guest" },
    });
  });

  it("weak evidence: needs_code, nothing created", async () => {
    const id = weak();
    await seedShare(id.email);
    expect(await run(INVITE(), id)).toEqual({
      ok: false,
      reason: "needs_code",
    });
    expect(await roleOf(id.email)).toBeUndefined();
    // Without domains too.
    expect(
      await run(direct({ AUTH_DOMAINS: "" }), {
        ...weak(id.email),
        subject: sub(),
      }),
    ).toEqual({ ok: false, reason: "needs_code" });
  });

  it("with no share: no_access, nothing created", async () => {
    for (const id of [gmail(), onLogin(), weak()]) {
      expect(await run(INVITE(), id)).toEqual({
        ok: false,
        reason: "no_access",
      });
      expect(await roleOf(id.email)).toBeUndefined();
    }
  });

  it("a bound login never makes the owner, even at OWNER_EMAIL", async () => {
    const id = weak();
    const e = direct({ OWNER_EMAIL: id.email, AUTH_DOMAINS: "" });
    expect(await run(e, id)).toEqual({ ok: false, reason: "no_access" });
  });

  it("an invited member is unaffected", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "member");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();
    expect(await run(INVITE(), id)).toMatchObject({
      ok: true,
      user: { id: uid, role: "member" },
    });
  });

  it("an invited guest (no share) still logs in and stays a guest", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "guest");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();
    expect(await run(INVITE(), id)).toMatchObject({
      ok: true,
      user: { id: uid, role: "guest" },
    });
  });
});

describe("removing the last share ends access", () => {
  it("the guest is removed, sessions are revoked, and they can't log in", async () => {
    const id = gmail();
    const art = await seedShare(id.email);
    const first = await run(INVITE(), id);
    expect(first.ok).toBe(true);
    const uid = first.ok ? first.user.id : "";
    const epoch = () =>
      one<{ e: number }>("select session_epoch e from users where id = ?", uid);
    const before = (await epoch()).e;
    await env.DB.prepare("delete from shares where email = ?")
      .bind(id.email)
      .run();
    await removeGuestIfUnshared(env, id.email, {
      artifactId: art,
      actorId: uid,
    });
    expect((await epoch()).e).toBeGreaterThan(before);
    expect(await run(INVITE(), id)).toEqual({ ok: false, reason: "removed" });
    expect(await run(INVITE(), { ...id, subject: sub() })).toEqual({
      ok: false,
      reason: "removed",
    });
  });

  it("a share-created guest with no share, still active, can't log in (no_access)", async () => {
    const id = gmail();
    await seedUser(id.email, "guest");
    expect(await run(INVITE(), id)).toEqual({ ok: false, reason: "no_access" });
    // Linked by subject too.
    const linked = gmail();
    await seedUser(linked.email, "guest", { googleSub: linked.subject });
    expect(await run(INVITE(), linked)).toEqual({
      ok: false,
      reason: "no_access",
    });
  });
});

describe("reach for a share recipient", () => {
  const ways = async (e: Env, email: string) =>
    (await shareReach(e, email)).ways;

  // The default test install offers Google and codes: a share recipient
  // outside the domains may use a code as a guest too.
  const GOOGLE = () =>
    direct({ AUTH_DOMAIN_JOIN: "invite", AUTH_PROVIDERS: "google" });
  it("Gmail: google (and email_code where codes are on)", async () => {
    expect(await ways(GOOGLE(), uniq("r", "gmail.com"))).toEqual(["google"]);
    expect(await ways(INVITE(), uniq("r", "gmail.com"))).toEqual([
      "google",
      "email_code",
    ]);
  });
  it("an address on a login domain: google", async () => {
    expect(await ways(INVITE(), uniq("r", "a.com"))).toEqual(["google"]);
  });
  it("another domain: google_workspace (and email_code where codes are on)", async () => {
    expect(await ways(GOOGLE(), uniq("r", "other.com"))).toEqual([
      "google_workspace",
    ]);
    // Codes on: a consumer account is let in after a code (#2590 G2).
    expect(await ways(INVITE(), uniq("r", "other.com"))).toEqual([
      "google_workspace",
      "google_after_code",
      "email_code",
    ]);
  });
  it("codes only: email_code", async () => {
    expect(await ways(trial(), uniq("r", "other.com"))).toEqual(["email_code"]);
  });
  it("Gmail with Google and codes: google and email_code", async () => {
    const e = direct({
      AUTH_PROVIDERS: "google,email",
      TURNSTILE_SITE_KEY: "k",
      TURNSTILE_SECRET: "s",
    });
    const w = await ways(e, uniq("r", "gmail.com"));
    expect(w).toContain("google");
  });
  it("nothing admits them: []", async () => {
    const e = direct({ AUTH_PROVIDERS: "email", EMAIL: undefined });
    expect(await ways(e, uniq("r", "other.com"))).toEqual([]);
  });
});
