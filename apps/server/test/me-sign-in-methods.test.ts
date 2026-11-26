// #3087 slice 7: Me › Sign-in methods (GET R.meSignInMethods, DELETE R.meSignInMethod).
import { env } from "cloudflare:workers";
import {
  newId,
  R,
  SignInMethodRemovedSchema,
  SignInMethodsSchema,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import {
  type SessionProvider,
  sessionCookieName,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { api, login } from "./helpers.js";

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

const googleEmailEnv = (): Env => ({
  ...E,
  AUTH_PROVIDERS: "google,email",
  AUTH_DOMAINS: "acme.test",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csec",
  EMAIL: { send: async () => {} } as unknown as Env["EMAIL"],
  EMAIL_FROM: "noreply@acme.test",
});

const trialEmailEnv = (): Env => ({
  ...E,
  AUTH_PROVIDERS: "email",
  AUTH_DOMAINS: "acme.test",
  EMAIL_CODE_DOMAIN: "on",
  TURNSTILE_SITE_KEY: "site",
  TURNSTILE_SECRET: "secret",
  EMAIL: { send: async () => {} } as unknown as Env["EMAIL"],
  EMAIL_FROM: "noreply@acme.test",
});

const googleOnlyEnv = (): Env => ({
  ...E,
  AUTH_PROVIDERS: "google",
  AUTH_DOMAINS: "acme.test",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csec",
});

async function cookieFor(
  userId: string,
  provider: SessionProvider,
  extra?: { tenant?: string; invitedMember?: boolean },
): Promise<string> {
  const row = await E.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(userId)
    .first<{ e: number }>();
  const token = await signSession(E, userId, Date.now(), {
    provider,
    epoch: row?.e ?? 0,
    ...(extra?.tenant ? { tenant: extra.tenant } : {}),
    ...(extra?.invitedMember ? { invitedMember: true } : {}),
  });
  return `${sessionCookieName(E)}=${token}`;
}

async function linkIdentity(
  userId: string,
  provider: string,
  subject: string,
  createdAt = 1_700_000_000_000,
): Promise<void> {
  await E.DB.prepare(
    "insert into identities (provider, subject, tenant, user_id, created_at) values (?, ?, '', ?, ?)",
  )
    .bind(provider, subject, userId, createdAt)
    .run();
}

async function epochOf(userId: string): Promise<number> {
  const row = await E.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(userId)
    .first<{ e: number }>();
  return row?.e ?? -1;
}

describe("GET /api/v1/me/sign-in-methods", () => {
  it("lists a Google-linked member's identity with linkedAt and current=true", async () => {
    const u = await login(`g-${tag}@acme.test`, "member");
    const ts = 1_710_000_000_000;
    await linkIdentity(u.userId, "google", `sub-g-${tag}`, ts);
    const cookie = await cookieFor(u.userId, "google", { tenant: "acme.test" });

    const r = await api(app, R.meSignInMethods, cookie, {}, googleEmailEnv());
    expect(r.status).toBe(200);
    const body = SignInMethodsSchema.parse(await r.json());
    expect(body).toEqual({
      methods: [
        {
          provider: "google",
          linkedAt: new Date(ts).toISOString(),
          current: true,
        },
      ],
    });
  });

  it("includes email only when email codes are offered and the user is eligible", async () => {
    // 1. Unlinked guest outside domains with email codes on -> email listed, current=true on code session.
    const g = await login(`guest-${tag}@outside.test`, "guest");
    const gCodeCookie = await cookieFor(g.userId, "code");
    const r1 = await api(
      app,
      R.meSignInMethods,
      gCodeCookie,
      {},
      googleEmailEnv(),
    );
    expect(r1.status).toBe(200);
    expect(SignInMethodsSchema.parse(await r1.json())).toEqual({
      methods: [{ provider: "email", linkedAt: null, current: true }],
    });

    // 2. Same guest when email codes are NOT offered -> email omitted.
    const gAccessCookie = await cookieFor(g.userId, "access");
    const r2 = await api(
      app,
      R.meSignInMethods,
      gAccessCookie,
      {},
      googleOnlyEnv(),
    );
    expect(r2.status).toBe(200);
    expect(SignInMethodsSchema.parse(await r2.json())).toEqual({
      methods: [],
    });

    // 3. Trial domain member (EMAIL_CODE_DOMAIN=on, no Google) -> email listed.
    const m = await login(`trial-${tag}@acme.test`, "member");
    const mCodeCookie = await cookieFor(m.userId, "code", {
      tenant: "acme.test",
    });
    const r3 = await api(
      app,
      R.meSignInMethods,
      mCodeCookie,
      {},
      trialEmailEnv(),
    );
    expect(r3.status).toBe(200);
    expect(SignInMethodsSchema.parse(await r3.json())).toEqual({
      methods: [{ provider: "email", linkedAt: null, current: true }],
    });

    // 4. Domain member on Google+email install (domainCodes is false) -> email NOT listed.
    const mAccessCookie = await cookieFor(m.userId, "access");
    const r4 = await api(
      app,
      R.meSignInMethods,
      mAccessCookie,
      {},
      googleEmailEnv(),
    );
    expect(r4.status).toBe(200);
    expect(SignInMethodsSchema.parse(await r4.json())).toEqual({
      methods: [],
    });
  });

  it("allows PAT reads with current=false and rejects unauthenticated with 401", async () => {
    const u = await login(`pat-${tag}@acme.test`, "member");
    const ts = 1_710_000_000_000;
    await linkIdentity(u.userId, "google", `sub-pat-${tag}`, ts);
    const pat = (await createPat(E, u.userId, "methods-read")).token;

    const rPat = await api(app, R.meSignInMethods, pat, {}, googleEmailEnv());
    expect(rPat.status).toBe(200);
    expect(SignInMethodsSchema.parse(await rPat.json())).toEqual({
      methods: [
        {
          provider: "google",
          linkedAt: new Date(ts).toISOString(),
          current: false,
        },
      ],
    });

    const rAnon = await api(app, R.meSignInMethods, null, {}, googleEmailEnv());
    expect(rAnon.status).toBe(401);
  });
});

describe("DELETE /api/v1/me/sign-in-methods/:provider", () => {
  it("deletes a second method, bumps session_epoch, audits without subject, and signs out", async () => {
    const u = await login(`two-${tag}@acme.test`, "member");
    const secretSub = `secret-github-sub-${tag}`;
    await linkIdentity(
      u.userId,
      "google",
      `sub-two-g-${tag}`,
      1_710_000_000_000,
    );
    await linkIdentity(u.userId, "github", secretSub, 1_710_000_100_000);
    const cookie = await cookieFor(u.userId, "google", { tenant: "acme.test" });
    const epochBefore = await epochOf(u.userId);

    const r = await api(
      app,
      R.meSignInMethod("github"),
      cookie,
      { method: "DELETE" },
      googleEmailEnv(),
    );
    expect(r.status).toBe(200);
    expect(SignInMethodRemovedSchema.parse(await r.json())).toEqual({
      signedOut: true,
    });
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");

    // github row removed, google row kept.
    const rows = (
      await E.DB.prepare(
        "select provider from identities where user_id = ? order by provider",
      )
        .bind(u.userId)
        .all<{ provider: string }>()
    ).results;
    expect(rows).toEqual([{ provider: "google" }]);

    // session_epoch bumped and old cookie is now dead.
    expect(await epochOf(u.userId)).toBe(epochBefore + 1);
    const after = await api(
      app,
      R.meSignInMethods,
      cookie,
      {},
      googleEmailEnv(),
    );
    expect(after.status).toBe(401);

    // Audit row recorded with provider only, never the subject.
    const audits = (
      await E.DB.prepare(
        "select action, target_type, target_id, actor_id, detail from audit_events where actor_id = ? and action = 'auth.method_removed'",
      )
        .bind(u.userId)
        .all<{
          action: string;
          target_type: string;
          target_id: string;
          actor_id: string;
          detail: string;
        }>()
    ).results;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "auth.method_removed",
      target_type: "user",
      target_id: u.userId,
      actor_id: u.userId,
    });
    expect(JSON.parse(audits[0]?.detail ?? "{}")).toEqual({
      provider: "github",
    });
    expect(audits[0]?.detail).not.toContain(secretSub);
  });

  it("refuses deleting the last method with 409 last_method", async () => {
    const u = await login(`last-${tag}@acme.test`, "member");
    await linkIdentity(u.userId, "google", `sub-last-${tag}`);
    const cookie = await cookieFor(u.userId, "google", { tenant: "acme.test" });
    const epochBefore = await epochOf(u.userId);

    const r = await api(
      app,
      R.meSignInMethod("google"),
      cookie,
      { method: "DELETE" },
      googleEmailEnv(),
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as {
      error: { code: string; details?: { reason?: string } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({ reason: "last_method" });

    // Row still exists, epoch unchanged, no audit row written.
    const row = await E.DB.prepare(
      "select provider from identities where user_id = ?",
    )
      .bind(u.userId)
      .first<{ provider: string }>();
    expect(row?.provider).toBe("google");
    expect(await epochOf(u.userId)).toBe(epochBefore);
    const auditRow = await E.DB.prepare(
      "select id from audit_events where actor_id = ? and action = 'auth.method_removed'",
    )
      .bind(u.userId)
      .first();
    expect(auditRow).toBeNull();
  });

  it("allows a guest to remove their only linked identity when email codes remain available, and refuses when off", async () => {
    // Guest with active share (invited_at set so not an unshared share-made guest).
    const g = await login(`gdel-${tag}@outside.test`, "guest");
    await E.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), g.userId)
      .run();
    await linkIdentity(g.userId, "google", `sub-gdel-${tag}`);
    const cookie = await cookieFor(g.userId, "google");

    // With email codes off: 409 last_method.
    const rOff = await api(
      app,
      R.meSignInMethod("google"),
      cookie,
      { method: "DELETE" },
      googleOnlyEnv(),
    );
    expect(rOff.status).toBe(409);
    expect(
      ((await rOff.json()) as { error: { details?: { reason?: string } } })
        .error.details,
    ).toEqual({ reason: "last_method" });

    // With email codes on: succeeds because email code sign-in remains available.
    const rOn = await api(
      app,
      R.meSignInMethod("google"),
      cookie,
      { method: "DELETE" },
      googleEmailEnv(),
    );
    expect(rOn.status).toBe(200);
    expect(SignInMethodRemovedSchema.parse(await rOn.json())).toEqual({
      signedOut: true,
    });
  });

  it("cannot delete another user's identity", async () => {
    const a = await login(`other-a-${tag}@acme.test`, "member");
    const b = await login(`other-b-${tag}@acme.test`, "member");
    await linkIdentity(a.userId, "google", `sub-oa-g-${tag}`);
    await linkIdentity(a.userId, "github", `sub-oa-gh-${tag}`);
    await linkIdentity(b.userId, "google", `sub-ob-g-${tag}`);
    const bCookie = await cookieFor(b.userId, "google", {
      tenant: "acme.test",
    });

    const r = await api(
      app,
      R.meSignInMethod("github"),
      bCookie,
      { method: "DELETE" },
      googleEmailEnv(),
    );
    expect(r.status).toBe(404);

    // User A's github identity is untouched.
    const aGithub = await E.DB.prepare(
      "select provider from identities where user_id = ? and provider = 'github'",
    )
      .bind(a.userId)
      .first<{ provider: string }>();
    expect(aGithub?.provider).toBe("github");
  });

  it("returns 404 for unknown provider, email, or PAT, and 401 when unauthenticated", async () => {
    const u = await login(`unk-${tag}@acme.test`, "member");
    await linkIdentity(u.userId, "google", `sub-unk-g-${tag}`);
    await linkIdentity(u.userId, "github", `sub-unk-gh-${tag}`);
    const cookie = await cookieFor(u.userId, "google", { tenant: "acme.test" });

    expect(
      (
        await api(
          app,
          "/api/v1/me/sign-in-methods/bogus",
          cookie,
          { method: "DELETE" },
          googleEmailEnv(),
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await api(
          app,
          R.meSignInMethod("email"),
          cookie,
          { method: "DELETE" },
          googleEmailEnv(),
        )
      ).status,
    ).toBe(404);

    // PAT cannot remove a sign-in method (interactive cookie session only).
    const pat = (await createPat(E, u.userId, "methods-del")).token;
    expect(
      (
        await api(
          app,
          R.meSignInMethod("github"),
          pat,
          { method: "DELETE" },
          googleEmailEnv(),
        )
      ).status,
    ).toBe(404);

    // Unauthenticated -> 401.
    expect(
      (
        await api(
          app,
          R.meSignInMethod("github"),
          null,
          { method: "DELETE" },
          googleEmailEnv(),
        )
      ).status,
    ).toBe(401);
  });
});
