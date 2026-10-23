import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Member } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { authConfig } from "../src/auth/config.js";
import { createPat } from "../src/auth/pat.js";
import type { VerifiedIdentity } from "../src/auth/providers/types.js";
import type { Env } from "../src/env.js";
import { oauthApi } from "../src/mcp/oauth-api.js";
import {
  admit,
  codeEligibility,
  resetIdentity,
} from "../src/services/identity.js";
import { direct, seedShare, seedUser, trial, uniq } from "./auth-helpers.js";

// P2 Task 5: admission, linking and code eligibility.
const one = async <T>(sql: string, ...b: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...b)
    .first<T>()) as T;
const count = async (sql: string, ...b: unknown[]) =>
  (await one<{ n: number }>(`select count(*) n from ${sql}`, ...b)).n;
const subjectOf = async (userId: string) =>
  (
    await one<{ s: string } | null>(
      "select subject s from identities where user_id = ? and provider = 'google'",
      userId,
    )
  )?.s ?? null;
const rowOf = (id: string) =>
  one<{ email: string; role: string; e: number }>(
    "select email, role, session_epoch e from users where id = ?",
    id,
  );
const g = (o: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  provider: "google",
  subject: `sub-${crypto.randomUUID()}`,
  email: uniq("bob"),
  name: "Bob",
  tenant: "a.com",
  ...o,
});
const cfg = (over: Partial<Env> = {}) => authConfig(direct(over));
const admin = { id: "x", role: "admin" } as Member;

describe("admit (Google)", () => {
  it("no user, join member: creates a member and links (google, sub)", async () => {
    const id = g();
    const r = await admit(env, cfg(), id);
    expect(r).toMatchObject({
      ok: true,
      user: { email: id.email, role: "member" },
    });
    if (!r.ok) throw new Error();
    expect(await subjectOf(r.user.id)).toBe(id.subject);
  });

  it("no user, join invite: no_access, nothing written", async () => {
    const id = g();
    expect(await admit(env, cfg({ AUTH_DOMAIN_JOIN: "invite" }), id)).toEqual({
      ok: false,
      reason: "no_access",
    });
    expect(await count("users where email = ?", id.email)).toBe(0);
  });

  it("OWNER_EMAIL is created as owner even with join invite", async () => {
    const email = uniq("boss");
    const e = direct({ AUTH_DOMAIN_JOIN: "invite", OWNER_EMAIL: email });
    const r = await admit(e, authConfig(e), g({ email }));
    expect(r).toMatchObject({ ok: true, user: { role: "owner" } });
  });

  it("an existing (Access or invited) user keeps their id and gets linked", async () => {
    const email = uniq("old");
    const uid = await seedUser(email, "admin");
    const id = g({ email });
    const r = await admit(env, cfg(), id);
    expect(r).toMatchObject({ ok: true, user: { id: uid, role: "admin" } });
    expect(await subjectOf(uid)).toBe(id.subject);
  });

  it("the same sub signs in again as the same user", async () => {
    const id = g();
    const a = await admit(env, cfg(), id);
    const b = await admit(env, cfg(), id);
    expect(a.ok && b.ok && a.user.id === b.user.id).toBe(true);
  });

  it("a different sub with the same email: identity_conflict", async () => {
    const email = uniq("recycled");
    await seedUser(email, "member", { googleSub: `S1-${email}` });
    expect(
      await admit(env, cfg(), g({ email, subject: `S2-${email}` })),
    ).toEqual({
      ok: false,
      reason: "identity_conflict",
    });
  });

  it("a P3-synced identity (subject = Directory user id) signs in as that row", async () => {
    const email = uniq("synced");
    const dir = `1122334455${Math.floor(Math.random() * 1e6)}`;
    const uid = await seedUser(email, "member", { googleSub: dir });
    const r = await admit(env, cfg(), g({ email, subject: dir }));
    expect(r.ok && r.user.id).toBe(uid);
  });

  it("email drift updates users.email when the new address is free", async () => {
    const email = uniq("bob");
    const sub = `drift-${email}`;
    const uid = await seedUser(email, "member", { googleSub: sub });
    const moved = uniq("robert");
    await admit(env, cfg(), g({ subject: sub, email: moved }));
    expect((await rowOf(uid)).email).toBe(moved);
  });

  it("email drift keeps the old email when the new one is taken", async () => {
    const email = uniq("bob");
    const sub = `drift2-${email}`;
    const uid = await seedUser(email, "member", { googleSub: sub });
    const taken = uniq("taken");
    await seedUser(taken, "member");
    const r = await admit(env, cfg(), g({ subject: sub, email: taken }));
    expect(r.ok).toBe(true);
    expect((await rowOf(uid)).email).toBe(email);
  });

  it("email drift never moves a user onto OWNER_EMAIL", async () => {
    const email = uniq("bob");
    const sub = `drift3-${email}`;
    const uid = await seedUser(email, "member", { googleSub: sub });
    const boss = uniq("boss");
    const e = direct({ OWNER_EMAIL: boss });
    const r = await admit(e, authConfig(e), g({ subject: sub, email: boss }));
    expect(r).toMatchObject({ ok: true, user: { role: "member" } });
    expect(await rowOf(uid)).toMatchObject({ email, role: "member" });
  });

  it("OWNER_EMAIL is not promoted to owner while an owner row exists", async () => {
    await seedUser(uniq("owner"), "owner");
    const boss = uniq("boss");
    const uid = await seedUser(boss, "member", { googleSub: `B-${boss}` });
    const e = direct({ OWNER_EMAIL: boss });
    const r = await admit(
      e,
      authConfig(e),
      g({ subject: `B-${boss}`, email: boss }),
    );
    expect(r).toMatchObject({ ok: true, user: { role: "member" } });
    expect((await rowOf(uid)).role).toBe("member");
  });

  it("an OWNER_EMAIL first sign-in is a member while an owner row exists", async () => {
    await seedUser(uniq("owner"), "owner");
    const boss = uniq("boss");
    const e = direct({ OWNER_EMAIL: boss });
    const r = await admit(e, authConfig(e), g({ email: boss }));
    expect(r).toMatchObject({ ok: true, user: { role: "member" } });
    if (!r.ok) throw new Error();
    expect((await rowOf(r.user.id)).role).toBe("member");
  });

  it("OWNER_EMAIL has no special path once an owner exists: join invite → no_access", async () => {
    await seedUser(uniq("owner"), "owner");
    const boss = uniq("boss");
    const e = direct({ AUTH_DOMAIN_JOIN: "invite", OWNER_EMAIL: boss });
    expect(await admit(e, authConfig(e), g({ email: boss }))).toEqual({
      ok: false,
      reason: "no_access",
    });
    expect(await count("users where email = ?", boss)).toBe(0);
  });

  it("a guest row is promoted to member by hd (alias email domain)", async () => {
    const email = uniq("g", "alias.com");
    const uid = await seedUser(email, "guest");
    const r = await admit(env, cfg(), g({ email }));
    expect(r).toMatchObject({ ok: true, user: { id: uid, role: "member" } });
  });

  it("tenant outside the domains: tenant", async () => {
    expect(await admit(env, cfg(), g({ tenant: "b.com" }))).toEqual({
      ok: false,
      reason: "tenant",
    });
    expect(await admit(env, cfg(), g({ tenant: null }))).toEqual({
      ok: false,
      reason: "tenant",
    });
  });

  it("a linked user who is suspended or removed: removed", async () => {
    for (const status of ["suspended", "removed"]) {
      const email = uniq(status);
      const sub = `st-${email}`;
      await seedUser(email, "member", { googleSub: sub, status });
      expect(await admit(env, cfg(), g({ email, subject: sub }))).toEqual({
        ok: false,
        reason: "removed",
      });
    }
  });

  it("recycled email: a removed row is never linked by email or re-created", async () => {
    const email = uniq("gone");
    await seedUser(email, "member", { status: "removed" });
    expect(await admit(env, cfg(), g({ email }))).toEqual({
      ok: false,
      reason: "removed",
    });
    expect(await count("users where email = ?", email)).toBe(1);
    expect(
      await count(
        "identities i join users u on u.id = i.user_id where u.email = ?",
        email,
      ),
    ).toBe(0);
  });

  it("concurrent first sign-ins create one user and one identity", async () => {
    const id = g();
    const rs = await Promise.all([
      admit(env, cfg(), id),
      admit(env, cfg(), id),
    ]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(await count("users where email = ?", id.email)).toBe(1);
    expect(await count("identities where subject = ?", id.subject)).toBe(1);
  });

  it("a non-ASCII email is no_access", async () => {
    expect(await admit(env, cfg(), g({ email: "bøb@a.com" }))).toEqual({
      ok: false,
      reason: "no_access",
    });
  });
});

describe("codeEligibility", () => {
  const kind = async (e: Env, email: string) =>
    (await codeEligibility(env, authConfig(e), email)).kind;

  it("a Google-linked user is ineligible", async () => {
    const email = uniq("linked");
    await seedUser(email, "member", { googleSub: `L-${email}` });
    expect(await kind(trial(), email)).toBe("none");
  });
  it("a domain user is ineligible while Google is on", async () => {
    const email = uniq("dom");
    await seedUser(email, "member");
    expect(await kind(direct(), email)).toBe("none");
  });
  it("outside-domain owner, admin and member rows are ineligible", async () => {
    for (const role of ["owner", "admin", "member"] as const) {
      const email = uniq(role, "x.com");
      await seedUser(email, role);
      expect(await kind(direct(), email)).toBe("none");
    }
  });
  it("an invited guest is a guest", async () => {
    const email = uniq("guest", "x.com");
    const uid = await seedUser(email, "guest");
    expect(await codeEligibility(env, authConfig(direct()), email)).toEqual({
      kind: "guest",
      userId: uid,
    });
  });
  it("a shared address with no row is a guest", async () => {
    const email = uniq("shared", "x.com");
    await seedShare(email);
    expect(await codeEligibility(env, authConfig(direct()), email)).toEqual({
      kind: "guest",
      userId: null,
    });
  });
  it("an uninvited address is ineligible", async () => {
    expect(await kind(direct(), uniq("nobody", "x.com"))).toBe("none");
  });
  it("trial: a domain owner keeps their role", async () => {
    const email = uniq("own");
    const uid = await seedUser(email, "owner");
    expect(await codeEligibility(env, authConfig(trial()), email)).toEqual({
      kind: "member",
      userId: uid,
      role: "owner",
    });
  });
  it("trial: a new domain address joins as member only with join member", async () => {
    const email = uniq("newbie");
    expect(await codeEligibility(env, authConfig(trial()), email)).toEqual({
      kind: "member",
      userId: null,
      role: "member",
    });
    expect(await kind(trial({ AUTH_DOMAIN_JOIN: "invite" }), email)).toBe(
      "none",
    );
  });
  it("a removed or suspended row's address is ineligible", async () => {
    for (const status of ["removed", "suspended"]) {
      const email = uniq(status, "x.com");
      await seedUser(email, "guest", { status });
      expect(await kind(direct(), email)).toBe("none");
    }
  });
  it("garbage is ineligible", async () => {
    expect(await kind(direct(), "not-an-email")).toBe("none");
  });
});

describe("resetIdentity", () => {
  const pats = (uid: string) =>
    count("tokens where user_id = ? and revoked_at is null", uid);
  const grants = async (uid: string) =>
    (await oauthApi(env).listUserGrants(uid)).items.length;
  const grant = async (userId: string) => {
    const o = oauthApi(env);
    const c = await o.createClient({
      redirectUris: ["https://agent.example/cb"],
      tokenEndpointAuthMethod: "none",
    });
    await o.completeAuthorization({
      request: {
        responseType: "code",
        clientId: c.clientId,
        redirectUri: "https://agent.example/cb",
        scope: [],
        state: "s",
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
      },
      userId,
      metadata: {},
      scope: [],
      props: { userId },
    });
  };

  it("removes the Google link, bumps the epoch, revokes PATs and grants", async () => {
    const email = uniq("reset");
    const uid = await seedUser(email, "member", { googleSub: `R-${email}` });
    await createPat(env, uid, "t");
    await grant(uid);
    expect(await pats(uid)).toBe(1);
    expect(await grants(uid)).toBe(1);
    await resetIdentity(env, admin, uid);
    expect(await subjectOf(uid)).toBeNull();
    expect((await rowOf(uid)).e).toBe(1);
    expect(await pats(uid)).toBe(0);
    expect(await grants(uid)).toBe(0);
  });

  it("revokes the user's live sockets (UserPresence revokedAt set, P3 T7)", async () => {
    const email = uniq("live");
    const uid = await seedUser(email, "member", { googleSub: `L-${email}` });
    await resetIdentity(env, admin, uid);
    const ns = env.USER_PRESENCE;
    if (!ns) throw new Error("USER_PRESENCE unbound");
    const at = await runInDurableObject(
      ns.get(ns.idFromName(uid)) as never,
      (p: { revokedAt(): number | null }) => p.revokedAt(),
    );
    expect(at).toEqual(expect.any(Number));
  });

  it("a grant (KV) failure fails the reset before D1 changes; a retry completes it", async () => {
    const email = uniq("kv");
    const uid = await seedUser(email, "member", { googleSub: `K-${email}` });
    await createPat(env, uid, "t");
    const boom = () => {
      throw new Error("kv down");
    };
    const kv = { get: boom, list: boom, put: boom, delete: boom };
    await expect(
      resetIdentity({ ...env, OAUTH_KV: kv } as unknown as Env, admin, uid),
    ).rejects.toThrow("kv down");
    expect(await subjectOf(uid)).toBe(`K-${email}`);
    expect((await rowOf(uid)).e).toBe(0);
    expect(await pats(uid)).toBe(1);
    await resetIdentity(env, admin, uid);
    expect(await subjectOf(uid)).toBeNull();
    expect(await pats(uid)).toBe(0);
  });

  it("an owner may reset; a member or guest may not (404, nothing changed)", async () => {
    const email = uniq("victim");
    const uid = await seedUser(email, "member", { googleSub: `V-${email}` });
    await createPat(env, uid, "t");
    for (const role of ["member", "guest"] as const)
      await expect(
        resetIdentity(env, { id: "m", role } as Member, uid),
      ).rejects.toMatchObject({ code: "not_found" });
    expect(await subjectOf(uid)).toBe(`V-${email}`);
    expect((await rowOf(uid)).e).toBe(0);
    expect(await pats(uid)).toBe(1);
    await resetIdentity(env, { id: "o", role: "owner" } as Member, uid);
    expect(await subjectOf(uid)).toBeNull();
  });

  it("admin → admin: 403 owner_only, nothing changed", async () => {
    const email = uniq("peer");
    const uid = await seedUser(email, "admin", { googleSub: `P-${email}` });
    await createPat(env, uid, "t");
    await grant(uid);
    await expect(resetIdentity(env, admin, uid)).rejects.toMatchObject({
      code: "owner_only",
    });
    expect(await subjectOf(uid)).toBe(`P-${email}`);
    expect((await rowOf(uid)).e).toBe(0);
    expect(await pats(uid)).toBe(1);
    expect(await grants(uid)).toBe(1);
  });

  it("owner → admin: resets", async () => {
    const email = uniq("adm");
    const uid = await seedUser(email, "admin", { googleSub: `A-${email}` });
    await createPat(env, uid, "t");
    await resetIdentity(env, { id: "o", role: "owner" } as Member, uid);
    expect(await subjectOf(uid)).toBeNull();
    expect((await rowOf(uid)).e).toBe(1);
    expect(await pats(uid)).toBe(0);
  });

  it("admin → member: resets", async () => {
    const email = uniq("mem");
    const uid = await seedUser(email, "member", { googleSub: `M-${email}` });
    await resetIdentity(env, admin, uid);
    expect(await subjectOf(uid)).toBeNull();
  });

  it("admin → admin without a link: 404, not owner_only", async () => {
    const uid = await seedUser(uniq("bareadm"), "admin");
    await expect(resetIdentity(env, admin, uid)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("target promoted to admin between the precheck and the batch: 404, D1 unchanged", async () => {
    const email = uniq("race");
    const uid = await seedUser(email, "member", { googleSub: `Q-${email}` });
    await createPat(env, uid, "t");
    // revokeAllGrants (KV) runs between the precheck and the D1 batch.
    const promote = () =>
      env.DB.prepare("update users set role = 'admin' where id = ?")
        .bind(uid)
        .run();
    const kv = new Proxy(env.OAUTH_KV, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k !== "list" || typeof v !== "function") return v;
        return async (...a: unknown[]) => {
          await promote();
          return v.apply(t, a);
        };
      },
    });
    await expect(
      resetIdentity({ ...env, OAUTH_KV: kv } as Env, admin, uid),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await rowOf(uid)).role).toBe("admin");
    expect(await subjectOf(uid)).toBe(`Q-${email}`);
    expect((await rowOf(uid)).e).toBe(0);
    expect(await pats(uid)).toBe(1);
  });

  it("revokes the member's PATs", async () => {
    const email = uniq("resetpat");
    const uid = await seedUser(email, "member", { googleSub: `RP-${email}` });
    await createPat(env, uid, "t");
    await resetIdentity(env, admin, uid);
    expect(
      await count("tokens where user_id = ? and revoked_at is null", uid),
    ).toBe(0);
  });
  it("never the owner's link; 404 when there is no link; no epoch bump or PAT revoke then", async () => {
    const email = uniq("owner");
    const uid = await seedUser(email, "owner", { googleSub: `O-${email}` });
    await createPat(env, uid, "t");
    await grant(uid);
    await expect(resetIdentity(env, admin, uid)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await subjectOf(uid)).toBe(`O-${email}`);
    expect((await rowOf(uid)).e).toBe(0);
    expect(await pats(uid)).toBe(1);
    expect(await grants(uid)).toBe(1);
    const bare = await seedUser(uniq("bare"), "member");
    await createPat(env, bare, "t");
    await expect(resetIdentity(env, admin, bare)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await rowOf(bare)).e).toBe(0);
    expect(await pats(bare)).toBe(1);
  });
});

describe("user inserts", () => {
  it("every user insert in src goes through services/users.ts", () => {
    const src = (
      import.meta as unknown as {
        glob: (p: string, o: object) => Record<string, string>;
      }
    ).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
    const offenders = Object.entries(src)
      .filter(([f]) => !f.endsWith("/services/users.ts"))
      .filter(([, text]) =>
        /\.insert\(users\)|insert\s+into\s+users\b/i.test(text),
      )
      .map(([f]) => f);
    expect(Object.keys(src).length).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
