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
    expect(m?.text).toContain("yet. Ask ");
    expect(m?.text).toContain("to invite you as a member first.");
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

  it("Google only, outside the domain: outside_domains", async () => {
    const { share } = await setup(direct, {
      ...HOSTED,
      AUTH_PROVIDERS: "google",
    });
    expect((await share(uniq("g", "out.com"))).recipient).toEqual({
      canSignIn: false,
      reason: "outside_domains",
    });
  });

  it("email only, domain codes off, in-domain: no_sign_in_method (an invite wouldn't help)", async () => {
    const { share } = await setup(direct, {
      AUTH_PROVIDERS: "email",
      AUTH_DOMAIN_JOIN: "invite",
    });
    expect((await share(uniq("in", "a.com"))).recipient).toEqual({
      canSignIn: false,
      reason: "no_sign_in_method",
    });
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
