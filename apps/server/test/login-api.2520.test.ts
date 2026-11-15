// #2520 slice 3: per-address reach, invite changes, and the login settings
// routes (GET, PUT with proof of a domain, first-invite-seen).
import { env } from "cloudflare:workers";
import {
  DomainUnprovenDetailsSchema,
  InviteReachSchema,
  LoginSettingsSchema,
  MemberInviteResultSchema,
  R,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { EffectivePlan } from "../src/billing/plan.js";
import type { Env } from "../src/env.js";
import { loginSettings, soloPlan } from "../src/services/login.js";
import { direct, trial, uniq } from "./auth-helpers.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const OWN = direct();

const call = (
  e: Env,
  path: string,
  cookie: string,
  method = "GET",
  body?: unknown,
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method,
      headers: {
        cookie,
        "x-oa-request": "1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );

const owner = async () => (await login(uniq("own", "x.com"), "owner")).cookie;
const reachOf = (e: Env, cookie: string, email: string) =>
  call(e, `${R.memberReach}?email=${encodeURIComponent(email)}`, cookie);

/**
 * A forced Google login by `userId`: token hd `hd` (the proof, session h) and
 * `tenant` (session t, checked against AUTH_DOMAINS; default none).
 */
async function fresh(
  userId: string,
  hd: string | null,
  tenant: string | null = null,
  authAt?: number,
) {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(userId)
    .first<{ e: number }>();
  const now = Date.now();
  return `${sessionCookieName(env)}=${await signSession(env, userId, now, {
    provider: "google",
    epoch: row?.e ?? 0,
    ...(tenant ? { tenant } : {}),
    ...(hd ? { hd } : {}),
    ...(authAt === undefined ? { authAt: now } : {}),
  })}`;
}

describe("GET members/reach", () => {
  it.each([
    ["a gmail address", "gmail.com", ["google"]],
    ["a googlemail address", "googlemail.com", ["google"]],
    ["an address in the login domains", "a.com", ["google"]],
    ["any other domain", "other.com", ["google_workspace"]],
  ])("%s", async (_, domain, ways) => {
    const r = await reachOf(OWN, await owner(), uniq("r", domain));
    expect(r.status).toBe(200);
    expect(InviteReachSchema.parse(await r.json())).toEqual({ ways });
  });

  it("a login domain with domain codes on adds email_code", async () => {
    const e = trial({ AUTH_PROVIDERS: "google,email" });
    // Codes and Google together: domain codes stay off (Google is on).
    expect(
      InviteReachSchema.parse(
        await (await reachOf(e, await owner(), uniq("r", "a.com"))).json(),
      ).ways,
    ).toEqual(["google"]);
    const codes = trial();
    expect(
      InviteReachSchema.parse(
        await (await reachOf(codes, await owner(), uniq("r", "a.com"))).json(),
      ).ways,
    ).toEqual(["email_code"]);
  });

  it("no way in: ways is empty", async () => {
    const e = direct({ AUTH_PROVIDERS: "email" });
    const r = await reachOf(e, await owner(), uniq("r", "other.com"));
    expect(InviteReachSchema.parse(await r.json()).ways).toEqual([]);
  });

  it("a removed address carries removed.at", async () => {
    const u = await login(uniq("gone", "a.com"), "member");
    const at = Date.UTC(2026, 10, 1);
    await env.DB.prepare(
      "update users set status = 'removed', status_changed_at = ? where id = ?",
    )
      .bind(at, u.userId)
      .run();
    const email = (
      await env.DB.prepare("select email from users where id = ?")
        .bind(u.userId)
        .first<{ email: string }>()
    )?.email as string;
    const r = await reachOf(OWN, await owner(), email);
    expect(InviteReachSchema.parse(await r.json())).toEqual({
      ways: ["google"],
      removed: { at: new Date(at).toISOString() },
    });
  });

  it("owners and admins only; a member is 404; no email is 400", async () => {
    const m = await login(uniq("m", "x.com"), "member");
    expect((await reachOf(OWN, m.cookie, "a@a.com")).status).toBe(404);
    const a = await login(uniq("ad", "x.com"), "admin");
    expect((await reachOf(OWN, a.cookie, "a@a.com")).status).toBe(200);
    expect((await call(OWN, R.memberReach, a.cookie)).status).toBe(400);
  });
});

describe("POST members (invite)", () => {
  const invite = (e: Env, cookie: string, email: string, role: string) =>
    call(e, R.members, cookie, "POST", { email, role });

  it("returns reach", async () => {
    const r = await invite(OWN, await owner(), uniq("i", "a.com"), "member");
    expect(r.status).toBe(201);
    expect(MemberInviteResultSchema.parse(await r.json()).reach).toEqual({
      ways: ["google"],
    });
  });

  it("refuses with 400 invite_unreachable when no way in exists; nothing created", async () => {
    const e = direct({ AUTH_PROVIDERS: "email" });
    const email = uniq("nw", "other.com");
    const r = await invite(e, await owner(), email, "member");
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("invite_unreachable");
    expect(
      await env.DB.prepare("select 1 from users where email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
  });

  it("a guest invite creates a guest row with invited_at set", async () => {
    const email = uniq("g", "other.com");
    const r = await invite(OWN, await owner(), email, "guest");
    expect(r.status).toBe(201);
    expect(
      await env.DB.prepare(
        "select role, invited_at as at from users where email = ?",
      )
        .bind(email)
        .first(),
    ).toMatchObject({ role: "guest", at: expect.any(Number) });
  });

  it("an invite to a removed member restores them as a fresh invite", async () => {
    const u = await login(uniq("back", "a.com"), "member");
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(u.userId)
      .run();
    const email = (
      await env.DB.prepare("select email from users where id = ?")
        .bind(u.userId)
        .first<{ email: string }>()
    )?.email as string;
    const r = await invite(OWN, await owner(), email, "member");
    expect(r.status).toBe(200);
    const body = MemberInviteResultSchema.parse(await r.json());
    expect(body.id).toBe(u.userId);
    expect(body.reach?.ways).toEqual(["google"]);
    expect(
      await env.DB.prepare(
        "select status, invited_at as at from users where id = ?",
      )
        .bind(u.userId)
        .first(),
    ).toMatchObject({ status: "active", at: expect.any(Number) });
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from audit_events where action = 'invite.create' and target_id = ?",
        )
          .bind(u.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("only the owner restores a removed admin: an admin is 403 owner_only, the owner may", async () => {
    const u = await login(uniq("adm", "a.com"), "admin");
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(u.userId)
      .run();
    const email = (
      await env.DB.prepare("select email from users where id = ?")
        .bind(u.userId)
        .first<{ email: string }>()
    )?.email as string;
    const a = await login(uniq("ad2", "x.com"), "admin");
    const denied = await invite(OWN, a.cookie, email, "member");
    expect(denied.status).toBe(403);
    expect((await errOf(denied)).code).toBe("owner_only");
    expect(
      (
        await env.DB.prepare("select status from users where id = ?")
          .bind(u.userId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("removed");
    expect((await invite(OWN, await owner(), email, "member")).status).toBe(
      200,
    );
  });
});

describe("login settings", () => {
  const get = (cookie: string) => call(OWN, R.loginSettings, cookie);

  it("owner and admin read; a member is 404", async () => {
    const o = await get(await owner());
    expect(o.status).toBe(200);
    expect(LoginSettingsSchema.parse(await o.json())).toMatchObject({
      domains: ["a.com"],
      autoJoin: true,
      editable: false,
      provable: null,
      firstInviteSeen: false,
    });
    const a = await login(uniq("ad", "x.com"), "admin");
    expect((await get(a.cookie)).status).toBe(200);
    const m = await login(uniq("m", "x.com"), "member");
    expect((await get(m.cookie)).status).toBe(404);
  });

  it("autoJoin follows AUTH_DOMAIN_JOIN", async () => {
    const e = direct({ AUTH_DOMAIN_JOIN: "invite" });
    const r = await call(e, R.loginSettings, await owner());
    expect(LoginSettingsSchema.parse(await r.json()).autoJoin).toBe(false);
  });

  it("joined counts active members in the login domains only", async () => {
    const o = await owner();
    const joined = async () =>
      LoginSettingsSchema.parse(await (await get(o)).json()).joined;
    const before = await joined();
    await login(uniq("j1", "a.com"), "member");
    await login(uniq("j2", "other.com"), "member");
    const gone = await login(uniq("j3", "a.com"), "member");
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(gone.userId)
      .run();
    expect(await joined()).toBe(before + 1);
  });

  it("provable is the Google login's token hd, even outside the login domains", async () => {
    const u = await login(uniq("pv", "x.com"), "owner");
    const r = await get(await fresh(u.userId, "Acme.com"));
    expect(LoginSettingsSchema.parse(await r.json()).provable).toBe("acme.com");
    // No hd on the login (a Gmail owner, or Access): nothing to prove.
    const g = await get(await fresh(u.userId, null));
    expect(LoginSettingsSchema.parse(await g.json()).provable).toBeNull();
  });

  it("first-invite-seen is 204, per person, and sets the flag", async () => {
    const a = await login(uniq("fs1", "x.com"), "admin");
    const b = await login(uniq("fs2", "x.com"), "admin");
    const seen = async (c: string) =>
      LoginSettingsSchema.parse(await (await get(c)).json()).firstInviteSeen;
    expect(await seen(a.cookie)).toBe(false);
    const r = await call(OWN, R.loginFirstInviteSeen, a.cookie, "POST");
    expect(r.status).toBe(204);
    expect(await seen(a.cookie)).toBe(true);
    expect(await seen(b.cookie)).toBe(false);
    const m = await login(uniq("m", "x.com"), "member");
    expect(
      (await call(OWN, R.loginFirstInviteSeen, m.cookie, "POST")).status,
    ).toBe(404);
  });
});

describe("login settings on the hosted Solo tier", () => {
  const plan = (tier: string) => ({ tier }) as unknown as EffectivePlan;

  it("Solo and free: no domains, no auto-join, not editable", async () => {
    const u = await login(uniq("solo", "x.com"), "owner");
    for (const tier of ["solo", "free"]) {
      expect(soloPlan(plan(tier))).toBe(true);
      expect(
        await loginSettings(OWN, u.userId, null, plan(tier)),
      ).toMatchObject({
        domains: [],
        autoJoin: false,
        editable: false,
      });
    }
  });

  it("other tiers read the install's own settings", async () => {
    const u = await login(uniq("team", "x.com"), "owner");
    expect(soloPlan(plan("team"))).toBe(false);
    expect(soloPlan(null)).toBe(false);
    expect(
      await loginSettings(OWN, u.userId, null, plan("team")),
    ).toMatchObject({
      domains: ["a.com"],
      autoJoin: true,
    });
  });
});

describe("a hosted owner with no domains (#2520)", () => {
  // No login domains yet: the owner's login is email-bound, with no tenant t.
  // The token hd rides in h and proves the domain they add.
  const BARE = direct({ AUTH_DOMAINS: "", AUTH_DOMAIN_JOIN: "invite" });
  const put = (e: Env, cookie: string, domains: string[]) =>
    call(e, R.loginSettings, cookie, "PUT", { autoJoin: true, domains });

  it("provable equals the Workspace hd; PUT with it passes the proof (409 apply_pending)", async () => {
    const u = await login(uniq("ws", "acme.io"), "owner");
    const c = await fresh(u.userId, "acme.io");
    const g = await call(BARE, R.loginSettings, c);
    expect(LoginSettingsSchema.parse(await g.json())).toMatchObject({
      domains: [],
      provable: "acme.io",
    });
    const r = await put(BARE, c, ["acme.io"]);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("apply_pending");
  });

  it("another domain, or a login with no h, fails the proof", async () => {
    const u = await login(uniq("ws2", "acme.io"), "owner");
    const other = await put(BARE, await fresh(u.userId, "acme.io"), [
      "evil.io",
    ]);
    expect((await errOf(other)).code).toBe("domain_unproven");
    const none = await put(BARE, await fresh(u.userId, null), ["acme.io"]);
    expect((await errOf(none)).code).toBe("domain_unproven");
  });

  it("a forged h is refused: the cookie signature no longer matches", async () => {
    const u = await login(uniq("ws3", "acme.io"), "owner");
    const c = await fresh(u.userId, null);
    const [name, val] = c.split("=") as [string, string];
    const [payload, sig] = val.split(".") as [string, string];
    const body = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    body.h = "evil.io";
    const forged = `${name}=${btoa(JSON.stringify(body))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${sig}`;
    const r = await put(BARE, forged, ["evil.io"]);
    expect(r.status).toBe(401);
    expect((await errOf(r)).code).not.toBe("apply_pending");
  });
});

describe("PUT login settings", () => {
  const put = (cookie: string, domains: string[]) =>
    call(OWN, R.loginSettings, cookie, "PUT", { autoJoin: true, domains });

  it("no fresh login: 401 reauth_required", async () => {
    const r = await put(await owner(), ["a.com"]);
    expect(r.status).toBe(401);
    expect((await errOf(r)).code).toBe("reauth_required");
  });

  it("a fresh login whose hd differs: 403 domain_unproven with the domain", async () => {
    const u = await login(uniq("o1", "x.com"), "owner");
    const r = await put(await fresh(u.userId, "a.com"), ["other.com"]);
    expect(r.status).toBe(403);
    const err = await errOf(r);
    expect(err.code).toBe("domain_unproven");
    expect(DomainUnprovenDetailsSchema.parse(err.details)).toEqual({
      domain: "other.com",
    });
  });

  it("a fresh login with no hd (Gmail owner) proves nothing", async () => {
    const u = await login(uniq("o2", "gmail.com"), "owner");
    const r = await put(await fresh(u.userId, null), ["a.com"]);
    expect((await errOf(r)).code).toBe("domain_unproven");
  });

  it("every domain is checked, stored ones included", async () => {
    const u = await login(uniq("o3", "x.com"), "owner");
    const c = await fresh(u.userId, "a.com");
    const r = await put(c, ["a.com", "b.com"]);
    expect(r.status).toBe(403);
    expect((await errOf(r)).details).toEqual({ domain: "b.com" });
  });

  it("proven domains: 409 apply_pending while nothing can apply it", async () => {
    const u = await login(uniq("o4", "x.com"), "owner");
    const r = await put(await fresh(u.userId, "a.com"), ["A.com"]);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("apply_pending");
  });

  it("an invalid body is 400", async () => {
    const u = await login(uniq("o5", "x.com"), "owner");
    const r = await call(
      OWN,
      R.loginSettings,
      await fresh(u.userId, "a.com"),
      "PUT",
      { nope: 1 },
    );
    expect(r.status).toBe(400);
  });

  it("owner only: an admin and a member are 404", async () => {
    const a = await login(uniq("ad", "x.com"), "admin");
    expect((await put(await fresh(a.userId, "a.com"), ["a.com"])).status).toBe(
      404,
    );
    const m = await login(uniq("m", "x.com"), "member");
    expect((await put(m.cookie, ["a.com"])).status).toBe(404);
  });
});
