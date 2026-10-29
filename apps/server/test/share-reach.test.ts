// Review item 37: a share always applies, but when the recipient can't sign
// in on this install (an in-domain non-member on an invite-only install),
// ShareResult.recipient says so and the share email doesn't promise a
// sign-in that can't work.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();

/** A hosted install (invite-only, Google through the broker, codes). */
const HOSTED: Partial<Env> = {
  HOSTED: "1",
  // No BILLING gate: the provisioned TIER is the plan (none: free, solo).
  TIER: "business",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

async function setup(make: (o: Partial<Env>) => Env, over: Partial<Env>) {
  const m = mailer();
  const e = make({ ...m.env, ...over });
  const o = await login(uniq("own", "a.com"), "member");
  const member = await getUser(env, o.userId);
  if (!member) throw new Error("no user");
  const { id } = await publish(
    env,
    member,
    { title: "Plan", format: "markdown", content: "x" } as never,
    null,
    undefined,
    "create",
  );
  const share = async (email: string) => {
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.shares(id)}`, {
        method: "PUT",
        headers: {
          cookie: o.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, role: "viewer" }),
      }),
      e,
    );
    expect(r.status).toBe(200);
    return ShareResultSchema.parse(await r.json());
  };
  return { share, sent: m.sent };
}

describe("share recipient reach (review item 37)", () => {
  it("hosted, in-domain non-member: share applies, recipient needs_invite, honest email", async () => {
    const { share, sent } = await setup(direct, HOSTED);
    const email = uniq("in", "a.com");
    const s = await share(email);
    expect(s).toMatchObject({ email, role: "viewer", emailed: true });
    expect(s.recipient).toEqual({ canSignIn: false, reason: "needs_invite" });
    const m = sent.find((x) => x.to === email);
    expect(m?.text).toMatch(
      /You can't sign in to .+ yet\. Ask an admin there to invite you, then open this link again\./,
    );
    for (const part of [m?.text, m?.html]) {
      expect(part).not.toContain("one-time code");
      expect(part).not.toContain("sign in with");
    }
  });

  it("hosted, in-domain member: no flag", async () => {
    const { share } = await setup(direct, HOSTED);
    const email = uniq("mem", "a.com");
    await login(email, "member");
    expect((await share(email)).recipient).toBeUndefined();
  });

  it("hosted, outside the domain: a guest with codes, no flag, the email offers a code", async () => {
    const { share, sent } = await setup(direct, HOSTED);
    const email = uniq("g", "out.com");
    const s = await share(email);
    expect(s.recipient).toBeUndefined();
    expect(sent.find((x) => x.to === email)?.text).toContain(
      `You'll sign in with a one-time code sent to ${email}.`,
    );
  });

  /** Design's copy for outside_domains and no_sign_in_method (#799). */
  const NO_ADDRESS =
    /This address can't sign in to .+\. Ask .+ to share it with an address that can\./;

  it("Google only, outside the domain: outside_domains, and the email says so", async () => {
    const { share, sent } = await setup(direct, {
      ...HOSTED,
      AUTH_PROVIDERS: "google",
    });
    const email = uniq("g", "out.com");
    expect((await share(email)).recipient).toEqual({
      canSignIn: false,
      reason: "outside_domains",
    });
    const m = sent.find((x) => x.to === email);
    expect(m?.text).toMatch(NO_ADDRESS);
    expect(m?.text).not.toContain("invite you");
  });

  it("email only, domain codes off, in-domain: no_sign_in_method (an invite wouldn't help), and the email says so", async () => {
    const { share, sent } = await setup(direct, {
      AUTH_PROVIDERS: "email",
      AUTH_DOMAIN_JOIN: "invite",
    });
    const email = uniq("in", "a.com");
    expect((await share(email)).recipient).toEqual({
      canSignIn: false,
      reason: "no_sign_in_method",
    });
    const m = sent.find((x) => x.to === email);
    expect(m?.text).toMatch(NO_ADDRESS);
    expect(m?.text).not.toContain("one-time code");
  });

  // #799 nit: a no-row recipient whom only Google might admit (outside
  // AUTH_DOMAINS, domain join on): no flag, and the email names Google
  // rather than saying they can't sign in.
  it("only Google might admit a no-row recipient: no flag, and the email names Google", async () => {
    const { share, sent } = await setup(direct, {
      AUTH_PROVIDERS: "google",
      AUTH_DOMAIN_JOIN: "member",
    });
    const email = uniq("sec", "secondary.com");
    expect((await share(email)).recipient).toBeUndefined();
    const m = sent.find((x) => x.to === email);
    expect(m?.text).toContain("You'll sign in with your Google account.");
    expect(m?.text).not.toContain("can't sign in");
  });

  it("self-hosted direct with domain join: in-domain non-member signs in with Google, no flag", async () => {
    const { share, sent } = await setup(direct, {});
    const email = uniq("in", "a.com");
    expect((await share(email)).recipient).toBeUndefined();
    expect(sent.find((x) => x.to === email)?.text).toContain(
      "You'll sign in with your Google account.",
    );
  });

  it("Access-only (self-host default): no flag", async () => {
    const { share } = await setup((o) => ({ ...env, ...o }) as Env, {});
    expect(
      (await share(uniq("acc", "anywhere.com"))).recipient,
    ).toBeUndefined();
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
    (t: string) => t.includes("can't sign in") === (methods.length === 0),
  );
}

describe("ShareResult.signInMethods (#799)", () => {
  it.each([
    ["hosted, in-domain non-member", direct, HOSTED, "a.com", []],
    ["hosted, outside guest", direct, HOSTED, "out.com", ["email"]],
    [
      "Google only, outside",
      direct,
      { ...HOSTED, AUTH_PROVIDERS: "google" },
      "out.com",
      [],
    ],
    [
      "email only, domain codes off, in-domain",
      direct,
      { AUTH_PROVIDERS: "email", AUTH_DOMAIN_JOIN: "invite" },
      "a.com",
      [],
    ],
    [
      "only Google might admit (no row)",
      direct,
      { AUTH_PROVIDERS: "google", AUTH_DOMAIN_JOIN: "member" },
      "secondary.com",
      ["google"],
    ],
    [
      "self-hosted direct, domain join, in-domain",
      direct,
      {},
      "a.com",
      ["google"],
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
      const { share, sent } = await setup(make, over as Partial<Env>);
      const email = uniq("r", domain);
      const s = await share(email);
      expect(s.signInMethods).toEqual(want);
      namesExactly(
        sent.find((x) => x.to === email)?.text,
        s.signInMethods ?? [],
      );
    },
  );
});
