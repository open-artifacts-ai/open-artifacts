// #2590: until "Don't email me again" exists, no email goes to an outside
// address (outside-email.ts). The share still saves.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { OUTSIDE_SHARE_EMAIL_ON } from "../src/services/outside-email.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();

/** A hosted install (the outside rules are hosted's). */
const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

describe("no email to an outside address", () => {
  it("is off by default", () => {
    expect(OUTSIDE_SHARE_EMAIL_ON).toBe(false);
  });

  async function world(over: Partial<Env>) {
    const m = mailer();
    const e = direct({ ...m.env, ...over }) as Env;
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
    return { m, share };
  }

  it("hosted: the share saves, nothing is sent, and the reason is outside_no_unsubscribe; an address at a login domain still gets its email", async () => {
    const { m, share } = await world(HOSTED);
    const outside = uniq("out", "gmail.com");
    const s = await share(outside);
    expect(s).toMatchObject({
      emailed: false,
      notEmailed: "outside_no_unsubscribe",
    });
    expect(
      await env.DB.prepare("select 1 from shares where email = ?")
        .bind(outside)
        .first(),
    ).not.toBeNull();
    expect(m.sent.some((x) => x.to === outside)).toBe(false);
    // Not outside: the email still goes (the limits don't apply to it).
    const team = uniq("team", "a.com");
    expect(await share(team)).toMatchObject({ emailed: true });
    expect(m.sent.some((x) => x.to === team)).toBe(true);
  });

  it("self-host: an outside address still gets the outside email, sent and unlimited; an address at a login domain gets the normal one", async () => {
    const { m, share } = await world({});
    const outside = uniq("out", "gmail.com");
    const s = await share(outside);
    expect(s).toMatchObject({ emailed: true });
    expect(s.notEmailed).toBeUndefined();
    const mail = m.sent.find((x) => x.to === outside);
    // The plain outside template: no role line, a bare title, its own subject.
    expect(mail?.text).toContain("shared a page with you on Open Artifacts");
    expect(mail?.text).not.toContain("Your role");
    expect(mail?.subject).toMatch(/ shared "Plan" with you$/);
    const team = uniq("team", "a.com");
    expect(await share(team)).toMatchObject({ emailed: true });
    const normal = m.sent.find((x) => x.to === team);
    expect(normal?.text).toContain("Your role:");
    expect(normal?.text).not.toContain(
      "shared a page with you on Open Artifacts",
    );
  });
});
