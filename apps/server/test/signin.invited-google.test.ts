import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authConfig } from "../src/auth/config.js";
import type { VerifiedIdentity } from "../src/auth/providers/types.js";
import type { Env } from "../src/env.js";
import { admit } from "../src/services/identity.js";
import { removeMember, SYSTEM_ACTOR } from "../src/services/members.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";

// #2520 slice 1: invited people log in with their own Google account on strong
// evidence, bound to the exact address, an existing active row only.
const DAY = 86_400_000;
const one = async <T>(sql: string, ...b: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...b)
    .first<T>()) as T;
const count = async (sql: string, ...b: unknown[]) =>
  (await one<{ n: number }>(`select count(*) n from ${sql}`, ...b)).n;
const rowOf = (id: string) =>
  one<{ email: string; role: string }>(
    "select email, role from users where id = ?",
    id,
  );
const subjectOf = async (userId: string) =>
  (
    await one<{ s: string } | null>(
      "select subject s from identities where user_id = ? and provider = 'google'",
      userId,
    )
  )?.s ?? null;
const age = (id: string, ms: number) =>
  env.DB.prepare("update users set created_at = ? where id = ?")
    .bind(Date.now() - ms, id)
    .run();

const sub = () => `sub-${crypto.randomUUID()}`;
/** A Gmail login: no hd, no tenant, bound to its address. */
const gmail = (o: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  provider: "google",
  subject: sub(),
  email: uniq("inv", "gmail.com"),
  name: "Inv",
  tenant: null,
  hd: null,
  bound: "email",
  ...o,
});
/** An in-domain login: hd a.com is the tenant. */
const inDom = (o: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  provider: "google",
  subject: sub(),
  email: uniq("m"),
  name: "M",
  tenant: "a.com",
  hd: "a.com",
  ...o,
});
const cfgOf = (over: Partial<Env> = {}) => {
  const e = direct(over);
  return { e, c: authConfig(e) };
};

describe("bound identity (domains set)", () => {
  it("an invited Gmail member links on first login; the next login is by subject", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "member");
    const { e, c } = cfgOf();
    expect(await admit(e, c, id)).toMatchObject({
      ok: true,
      user: { id: uid, role: "member" },
    });
    expect(await subjectOf(uid)).toBe(id.subject);
    expect(await admit(e, c, id)).toMatchObject({ ok: true });
  });

  it("an invited Workspace address on another domain (hd = its domain) links", async () => {
    const id = gmail({ email: uniq("w", "acme.com"), hd: "acme.com" });
    const uid = await seedUser(id.email, "member");
    const { e, c } = cfgOf();
    expect(await admit(e, c, id)).toMatchObject({
      ok: true,
      user: { id: uid },
    });
  });

  it("never creates a row, even with AUTH_DOMAIN_JOIN=member", async () => {
    const id = gmail();
    const { e, c } = cfgOf({ AUTH_DOMAIN_JOIN: "member" });
    expect(await admit(e, c, id)).toEqual({ ok: false, reason: "no_access" });
    expect(await count("users where email = ?", id.email)).toBe(0);
    expect(await count("identities where subject = ?", id.subject)).toBe(0);
  });

  it("never creates the OWNER_EMAIL owner, even with join member", async () => {
    const id = gmail();
    const { e, c } = cfgOf({
      AUTH_DOMAIN_JOIN: "member",
      OWNER_EMAIL: id.email,
    });
    await env.DB.exec("update users set role = 'admin' where role = 'owner'");
    expect(await admit(e, c, id)).toEqual({ ok: false, reason: "no_access" });
    expect(await count("users where email = ?", id.email)).toBe(0);
  });

  it("an existing row at OWNER_EMAIL is not promoted to owner by a bound login", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "member");
    const { e, c } = cfgOf({ OWNER_EMAIL: id.email });
    await env.DB.exec("update users set role = 'admin' where role = 'owner'");
    expect(await admit(e, c, id)).toMatchObject({
      ok: true,
      user: { role: "member" },
    });
    expect((await rowOf(uid)).role).toBe("member");
  });

  it("a guest stays a guest (no promotion without a tenant)", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "guest");
    const { e, c } = cfgOf();
    expect(await admit(e, c, id)).toMatchObject({
      ok: true,
      user: { role: "guest" },
    });
    expect((await rowOf(uid)).role).toBe("guest");
  });

  it("removed and suspended rows are refused", async () => {
    const { e, c } = cfgOf();
    for (const status of ["removed", "suspended"]) {
      const id = gmail();
      const uid = await seedUser(id.email, "member", { status });
      expect(await admit(e, c, id)).toEqual({ ok: false, reason: "removed" });
      expect(await subjectOf(uid)).toBeNull();
    }
  });

  it("a second Google account on the same address: identity_conflict", async () => {
    const id = gmail();
    await seedUser(id.email, "member", { googleSub: sub() });
    const { e, c } = cfgOf();
    expect(await admit(e, c, id)).toEqual({
      ok: false,
      reason: "identity_conflict",
    });
  });

  it("a cancelled invite (member removed): a Google login is refused and creates nothing", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "member");
    const { e, c } = cfgOf({ AUTH_DOMAIN_JOIN: "member" });
    await removeMember(e, uid, SYSTEM_ACTOR);
    expect(await admit(e, c, id)).toEqual({ ok: false, reason: "removed" });
    expect(await subjectOf(uid)).toBeNull();
    expect(await count("users where email = ?", id.email)).toBe(1);
  });

  it("drift: a bound identity never moves its row, in-domain address included", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "member", { googleSub: id.subject });
    const { e, c } = cfgOf();
    const to = uniq("moved");
    expect(await admit(e, c, { ...id, email: to })).toMatchObject({
      ok: true,
      user: { id: uid },
    });
    expect((await rowOf(uid)).email).toBe(id.email);
  });
});

describe("M1: first link needs strong evidence", () => {
  it("a weak address linking an existing code-only admin is refused (needs_code)", async () => {
    // hd a.com is a listed tenant, but the address is on another domain.
    const email = uniq("adm", "alias.com");
    const uid = await seedUser(email, "admin");
    const { e, c } = cfgOf();
    expect(await admit(e, c, inDom({ email }))).toEqual({
      ok: false,
      reason: "needs_code",
    });
    expect(await subjectOf(uid)).toBeNull();
  });

  it("a consumer account on a Workspace-domain address (no hd) never links", async () => {
    const email = uniq("ex", "acme.com");
    const uid = await seedUser(email, "member");
    // Domains empty: refused at the provider; here admit still says needs_code.
    const { e, c } = cfgOf({ AUTH_DOMAINS: "" });
    expect(
      await admit(e, c, {
        provider: "google",
        subject: sub(),
        email,
        name: null,
        tenant: null,
        hd: null,
      }),
    ).toEqual({ ok: false, reason: "needs_code" });
    expect(await subjectOf(uid)).toBeNull();
  });

  it("hd mismatch: hd differs from the address domain, no link", async () => {
    const email = uniq("x", "acme.com");
    const uid = await seedUser(email, "member");
    const { e, c } = cfgOf();
    expect(await admit(e, c, gmail({ email, hd: "other.com" }))).toEqual({
      ok: false,
      reason: "needs_code",
    });
    expect(await subjectOf(uid)).toBeNull();
  });

  it("in-domain strong evidence (hd = address domain) links directly", async () => {
    const id = inDom();
    const uid = await seedUser(id.email, "member");
    const { e, c } = cfgOf();
    expect(await admit(e, c, id)).toMatchObject({
      ok: true,
      user: { id: uid },
    });
  });
});

describe("M3: auto-join on the token's hd only", () => {
  it("a listed hd with join member creates a member", async () => {
    const id = inDom();
    const { e, c } = cfgOf({ AUTH_DOMAIN_JOIN: "member" });
    expect(await admit(e, c, id)).toMatchObject({
      ok: true,
      user: { email: id.email, role: "member" },
    });
  });

  it("no hd on an in-domain address: refused for auto-join, nothing created", async () => {
    // The provider refuses a token with no listed hd and weak evidence; a
    // bound one (e.g. Gmail) can never create a row.
    const id = gmail({ email: uniq("c", "a.com"), hd: null });
    const { e, c } = cfgOf({ AUTH_DOMAIN_JOIN: "member" });
    expect(await admit(e, c, id)).toEqual({ ok: false, reason: "no_access" });
    expect(await count("users where email = ?", id.email)).toBe(0);
    const unbound = inDom({ tenant: null, hd: null, email: id.email });
    expect(await admit(e, c, unbound)).toEqual({
      ok: false,
      reason: "tenant",
    });
    expect(await count("users where email = ?", id.email)).toBe(0);
  });

  it("a removed colleague with auto-join on stays refused and is not recreated", async () => {
    const id = inDom();
    const uid = await seedUser(id.email, "member", { status: "removed" });
    const { e, c } = cfgOf({ AUTH_DOMAIN_JOIN: "member" });
    expect(await admit(e, c, id)).toEqual({ ok: false, reason: "removed" });
    expect(
      (
        await one<{ status: string }>(
          "select status from users where id = ?",
          uid,
        )
      ).status,
    ).toBe("removed");
    expect(await count("users where email = ?", id.email)).toBe(1);
  });
});

describe("drift needs strong evidence for the new address", () => {
  it("a linked in-domain user whose Google email moves onto another in-domain address: kept", async () => {
    const from = uniq("old");
    const sb = sub();
    const uid = await seedUser(from, "member", { googleSub: sb });
    const { e, c } = cfgOf();
    // Weak: an alias address on another domain, hd a.com.
    const alias = uniq("new", "alias.com");
    await admit(e, c, inDom({ subject: sb, email: alias }));
    expect((await rowOf(uid)).email).toBe(from);
  });

  it("strong evidence for the new address still follows drift", async () => {
    const from = uniq("old");
    const sb = sub();
    const uid = await seedUser(from, "member", { googleSub: sb });
    const { e, c } = cfgOf();
    const to = uniq("new");
    await admit(e, c, inDom({ subject: sb, email: to }));
    expect((await rowOf(uid)).email).toBe(to);
  });

  it("a bound identity never moves a row onto an in-domain address", async () => {
    const from = uniq("old", "gmail.com");
    const sb = sub();
    const uid = await seedUser(from, "member", { googleSub: sb });
    const { e, c } = cfgOf();
    await admit(e, c, gmail({ subject: sb, email: uniq("new") }));
    expect((await rowOf(uid)).email).toBe(from);
  });
});

describe("invite expiry", () => {
  it("a never-signed-in member invite lapses after 30 days, an admin's after 7", async () => {
    const { e, c } = cfgOf();
    const cases: [string, "member" | "admin", number, boolean][] = [
      ["member", "member", 29 * DAY, true],
      ["member", "member", 31 * DAY, false],
      ["admin", "admin", 6 * DAY, true],
      ["admin", "admin", 8 * DAY, false],
      ["member at 8d", "member", 8 * DAY, true],
    ];
    for (const [, role, ms, ok] of cases) {
      const id = gmail();
      const uid = await seedUser(id.email, role);
      await age(uid, ms);
      const r = await admit(e, c, id);
      if (ok) expect(r).toMatchObject({ ok: true });
      else expect(r).toEqual({ ok: false, reason: "invite_expired" });
      if (!ok) expect(await subjectOf(uid)).toBeNull();
    }
  });

  it("a row that has signed in never lapses", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "admin");
    await age(uid, 400 * DAY);
    await env.DB.prepare("update users set last_seen_at = ? where id = ?")
      .bind(Date.now() - 100 * DAY, uid)
      .run();
    const { e, c } = cfgOf();
    expect(await admit(e, c, id)).toMatchObject({ ok: true });
  });

  it("a restore restarts the clock (status_changed_at)", async () => {
    const id = gmail();
    const uid = await seedUser(id.email, "member");
    await age(uid, 60 * DAY);
    await env.DB.prepare("update users set status_changed_at = ? where id = ?")
      .bind(Date.now() - DAY, uid)
      .run();
    const { e, c } = cfgOf();
    expect(await admit(e, c, id)).toMatchObject({ ok: true });
  });
});
