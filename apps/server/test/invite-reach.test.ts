// Review item 11: an invite follows how sign-in is configured. No offered
// method could ever admit the address: 400 invite_unreachable, nothing
// created. Only Google might (outside AUTH_DOMAINS: a Workspace secondary
// domain): the invite stands with signIn { status: "uncertain" }. The email
// names only the methods that admit the address.
import { env } from "cloudflare:workers";
import {
  INVITE_UNREACHABLE_MESSAGE,
  MemberInviteResultSchema,
  R,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import {
  direct,
  mailer,
  TEST_BROKER_KEY,
  trial,
  uniq,
} from "./auth-helpers.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();

const invite = (e: Env, cookie: string, email: string, role = "member") =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.members}`, {
      method: "POST",
      headers: {
        cookie,
        "x-oa-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, role }),
    }),
    e,
  );

const rowOf = (email: string) =>
  env.DB.prepare("select id from users where email = ?").bind(email).first();

/** An install plus a mailer that records what it sent. */
function install(make: (o: Partial<Env>) => Env, over: Partial<Env> = {}) {
  const m = mailer();
  return { e: make({ ...m.env, ...over }), sent: m.sent };
}

const owner = async () => (await login(uniq("own", "x.com"), "owner")).cookie;

describe("invite reachability (review item 11)", () => {
  // #3184: every invited row may sign in by code at its exact address, so
  // with codes on an invite is never unreachable for want of a code.
  it.each([
    ["member", "out.com"],
    ["admin", "out.com"],
    ["member", "a.com"],
  ] as const)(
    "email codes only, domain codes off: a %s at %s is invited and the email promises a code",
    async (role, domain) => {
      const { e, sent } = install(direct, { AUTH_PROVIDERS: "email" });
      const email = uniq("code", domain);
      const r = await invite(e, await owner(), email, role);
      expect(r.status).toBe(201);
      const body = MemberInviteResultSchema.parse(await r.json());
      expect(body.signInMethods).toEqual(["email"]);
      expect(await rowOf(email)).not.toBeNull();
      namesExactly(sent[0]?.text, ["email"]);
    },
  );

  it("the outside-domains message suggests sharing as a guest", () => {
    expect(INVITE_UNREACHABLE_MESSAGE.outside_domains).toBe(
      "This address can't log in to this workspace. Share artifacts with them as a guest instead.",
    );
  });

  it("an existing row is still 409, not 400", async () => {
    const { e } = install(direct, { AUTH_PROVIDERS: "email" });
    const cookie = await owner();
    const email = uniq("dup", "out.com");
    await login(email, "guest");
    const r = await invite(e, cookie, email);
    expect(r.status).toBe(409);
  });

  it("Google off and codes off (Google half configured, no email sending): 400", async () => {
    const { e } = install(direct, {
      GOOGLE_CLIENT_SECRET: "",
      EMAIL: undefined,
    });
    const r = await invite(e, await owner(), uniq("x", "a.com"));
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("invite_unreachable");
  });

  it("domain codes on (trial): in-domain is fine and the email promises a code", async () => {
    const { e, sent } = install(trial);
    const email = uniq("ok", "a.com");
    const r = await invite(e, await owner(), email);
    expect(r.status).toBe(201);
    const body = MemberInviteResultSchema.parse(await r.json());
    expect(body.signIn).toBeUndefined();
    expect(sent[0]?.text).toContain(
      `You'll log in with a one-time code sent to ${email}.`,
    );
  });

  it("Google and email, in-domain: fine, and the email names Google and a code (#3184)", async () => {
    const { e, sent } = install(direct);
    const email = uniq("g", "a.com");
    const r = await invite(e, await owner(), email);
    expect(r.status).toBe(201);
    const body = MemberInviteResultSchema.parse(await r.json());
    expect(body.signIn).toBeUndefined();
    expect(body.signInMethods).toEqual(["google", "email"]);
    namesExactly(sent[0]?.text, ["google", "email"]);
  });

  it.each([
    ["self-hosted direct", {}],
    [
      "hosted",
      {
        HOSTED: "1",
        AUTH_DOMAIN_JOIN: "invite",
        AUTH_BROKER_URL: "https://auth.h.test",
        BROKER_SIGNING_KEY: TEST_BROKER_KEY,
        GOOGLE_CLIENT_SECRET: "",
      },
    ],
  ] as const)(
    "%s, Google with AUTH_DOMAINS, outside the domains: created, signIn uncertain",
    async (_, over) => {
      const { e, sent } = install(direct, {
        ...(over as Partial<Env>),
        AUTH_PROVIDERS: "google",
      });
      const email = uniq("sec", "secondary.com");
      const r = await invite(e, await owner(), email);
      expect(r.status).toBe(201);
      expect(MemberInviteResultSchema.parse(await r.json()).signIn).toEqual({
        status: "uncertain",
        reason: "outside_domains",
      });
      expect(await rowOf(email)).not.toBeNull();
      const m = sent[0];
      expect(m?.text).toContain("You'll log in with your Google account.");
      expect(m?.text).not.toContain("one-time code");
    },
  );

  it("Google and email, outside the domains: no uncertain flag, the email names Google and a code", async () => {
    const { e, sent } = install(direct, {});
    const email = uniq("nog", "secondary.com");
    const r = await invite(e, await owner(), email);
    expect(r.status).toBe(201);
    const body = MemberInviteResultSchema.parse(await r.json());
    expect(body.signIn).toBeUndefined();
    expect(body.signInMethods).toEqual(["google", "email"]);
    namesExactly(sent[0]?.text, ["google", "email"]);
  });

  it("Google with AUTH_DOMAINS: an invited Gmail address is certain (no uncertain flag, #2520)", async () => {
    const { e, sent } = install(direct, {});
    const email = uniq("pal", "gmail.com");
    const r = await invite(e, await owner(), email);
    expect(r.status).toBe(201);
    expect(
      MemberInviteResultSchema.parse(await r.json()).signIn,
    ).toBeUndefined();
    expect(sent[0]?.text).toContain("your Google account");
    expect(sent[0]?.text).toContain("one-time code");
  });

  it("re-inviting an invited, never-signed-in row is a 200 (fresh clock); anything else stays 409", async () => {
    const { e } = install(direct, {});
    const cookie = await owner();
    const email = uniq("again", "gmail.com");
    expect((await invite(e, cookie, email)).status).toBe(201);
    await env.DB.prepare("update users set invited_at = 1 where email = ?")
      .bind(email)
      .run();
    const r = await invite(e, cookie, email);
    expect(r.status).toBe(200);
    const row = await env.DB.prepare(
      "select invited_at a from users where email = ?",
    )
      .bind(email)
      .first<{ a: number }>();
    expect(row?.a).toBeGreaterThan(Date.now() - 60_000);
    await env.DB.prepare("update users set last_seen_at = 5 where email = ?")
      .bind(email)
      .run();
    expect((await invite(e, cookie, email)).status).toBe(409);
  });

  it("re-invite email: at most one per address per 10 minutes; the refresh still happens", async () => {
    const { e, sent } = install(direct, {});
    const cookie = await owner();
    const email = uniq("cool", "gmail.com");
    const invitedAt = async () =>
      (
        await env.DB.prepare("select invited_at a from users where email = ?")
          .bind(email)
          .first<{ a: number }>()
      )?.a as number;
    expect((await invite(e, cookie, email)).status).toBe(201);
    expect(sent).toHaveLength(1);
    // Moments later: refreshed, not mailed.
    await env.DB.prepare("update users set invited_at = ? where email = ?")
      .bind(Date.now() - 5 * 60_000, email)
      .run();
    const soon = await invite(e, cookie, email);
    expect(soon.status).toBe(200);
    expect((await soon.json()) as { emailed: boolean }).toMatchObject({
      emailed: false,
    });
    expect(sent).toHaveLength(1);
    expect(await invitedAt()).toBeGreaterThan(Date.now() - 60_000);
    // After the window it mails again.
    await env.DB.prepare("update users set invited_at = ? where email = ?")
      .bind(Date.now() - 11 * 60_000, email)
      .run();
    const later = await invite(e, cookie, email);
    expect(later.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("Access-only (self-host default): unchanged, any address, no flag", async () => {
    const { e, sent } = install((o) => ({ ...env, ...o }) as Env);
    const email = uniq("acc", "anywhere.com");
    const r = await invite(e, await owner(), email);
    expect(r.status).toBe(201);
    expect(
      MemberInviteResultSchema.parse(await r.json()).signIn,
    ).toBeUndefined();
    expect(sent[0]?.text).toContain(
      "You'll log in with your organization's single sign-on.",
    );
    expect(sent[0]?.text).not.toContain("one-time code");
  });
});

/** The email names exactly `methods` (#799: signInMethods and the email agree). */
function namesExactly(text: string | undefined, methods: readonly string[]) {
  const PHRASE: Record<string, string> = {
    google: "your Google account",
    access: "your organization's single sign-on",
    email: "a one-time code sent to",
  };
  for (const [m, phrase] of Object.entries(PHRASE))
    expect(text ?? "", m).toSatisfy(
      (t: string) => t.includes(phrase) === methods.includes(m),
    );
  expect(text ?? "").toSatisfy(
    (t: string) => t.includes("can't log in") === (methods.length === 0),
  );
}

describe("MemberInviteResult.signInMethods (#799)", () => {
  it.each([
    ["trial, in-domain", trial, {}, "a.com", ["email"]],
    ["Google and email, in-domain", direct, {}, "a.com", ["google", "email"]],
    [
      "Google and email, outside (uncertain Google, a code)",
      direct,
      {},
      "out.com",
      ["google", "email"],
    ],
    [
      "Google only, outside (uncertain)",
      direct,
      { AUTH_PROVIDERS: "google" },
      "out.com",
      ["google"],
    ],
    [
      "Access and Google, in-domain",
      direct,
      { AUTH_PROVIDERS: "access,google,email" },
      "a.com",
      ["google", "access", "email"],
    ],
    [
      "Access only",
      (o: Partial<Env>) => ({ ...env, ...o }) as Env,
      {},
      "any.com",
      ["access"],
    ],
  ] as const)(
    "%s: %j, the list the email names",
    async (_, make, over, domain, want) => {
      const { e, sent } = install(make, over as Partial<Env>);
      const email = uniq("m", domain);
      const r = await invite(e, await owner(), email);
      expect(r.status).toBe(201);
      const body = MemberInviteResultSchema.parse(await r.json());
      expect(body.signInMethods).toEqual(want);
      namesExactly(
        sent.find((x) => x.to === email)?.text,
        body.signInMethods ?? [],
      );
    },
  );
});
