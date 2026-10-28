// Review item 11: an invite follows how sign-in is configured. No offered
// method could ever admit the address: 400 invite_unreachable, nothing
// created. Only Google might (outside AUTH_DOMAINS: a Workspace secondary
// domain): the invite stands with signIn { status: "uncertain" }. The email
// names only the methods that admit the address.
import { env } from "cloudflare:workers";
import {
  INVITE_UNREACHABLE_MESSAGE,
  InviteUnreachableDetailsSchema,
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
  it.each([
    ["member", "outside_domains", "out.com"],
    ["admin", "outside_domains", "out.com"],
    ["member", "no_sign_in_method", "a.com"],
  ] as const)(
    "email codes only, domain codes off: a %s at %s is 400 invite_unreachable (%s), nothing created",
    async (role, reason, domain) => {
      const { e, sent } = install(direct, { AUTH_PROVIDERS: "email" });
      const cookie = await owner();
      const email = uniq("nope", domain);
      const r = await invite(e, cookie, email, role);
      expect(r.status).toBe(400);
      const err = await errOf(r);
      expect(err.code).toBe("invite_unreachable");
      expect(InviteUnreachableDetailsSchema.parse(err.details)).toEqual({
        field: "email",
        reason,
      });
      expect(err.message).toBe(INVITE_UNREACHABLE_MESSAGE[reason]);
      expect(err.message).not.toContain("—");
      expect(await rowOf(email)).toBeNull();
      expect(sent).toHaveLength(0);
    },
  );

  it("the outside-domains message suggests sharing as a guest", () => {
    expect(INVITE_UNREACHABLE_MESSAGE.outside_domains).toBe(
      "This address can't sign in to this workspace. Share artifacts with them as a guest instead.",
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
      `You'll sign in with a one-time code sent to ${email}.`,
    );
  });

  it("Google and email, in-domain: fine, and the email names Google, never a code", async () => {
    const { e, sent } = install(direct);
    const email = uniq("g", "a.com");
    const r = await invite(e, await owner(), email);
    expect(r.status).toBe(201);
    expect(
      MemberInviteResultSchema.parse(await r.json()).signIn,
    ).toBeUndefined();
    const m = sent[0];
    expect(m?.text).toContain("You'll sign in with your Google account.");
    for (const part of [m?.subject, m?.text, m?.html])
      expect(part).not.toContain("one-time code");
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
      const { e, sent } = install(direct, over as Partial<Env>);
      const email = uniq("sec", "secondary.com");
      const r = await invite(e, await owner(), email);
      expect(r.status).toBe(201);
      expect(MemberInviteResultSchema.parse(await r.json()).signIn).toEqual({
        status: "uncertain",
        reason: "outside_domains",
      });
      expect(await rowOf(email)).not.toBeNull();
      const m = sent[0];
      expect(m?.text).toContain("You'll sign in with your Google account.");
      expect(m?.text).not.toContain("one-time code");
    },
  );

  it("Access-only (self-host default): unchanged, any address, no flag", async () => {
    const { e, sent } = install((o) => ({ ...env, ...o }) as Env);
    const email = uniq("acc", "anywhere.com");
    const r = await invite(e, await owner(), email);
    expect(r.status).toBe(201);
    expect(
      MemberInviteResultSchema.parse(await r.json()).signIn,
    ).toBeUndefined();
    expect(sent[0]?.text).toContain(
      "You'll sign in with your organization's single sign-on.",
    );
    expect(sent[0]?.text).not.toContain("one-time code");
  });
});
