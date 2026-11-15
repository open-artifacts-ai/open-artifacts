// #2590: an outside address gets the outside share email. Hosted sends it
// under daily limits; self-host sends it without them.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { OUTSIDE_EMAILS_PER_MEMBER_PER_DAY } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();

const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

async function world(over: Partial<Env>) {
  const m = mailer();
  const e = direct({ ...m.env, ...over }) as Env;
  const o = await login(uniq("own", "a.com"), "member");
  await env.DB.prepare("update users set display_name = ? where id = ?")
    .bind("Pat Sharer", o.userId)
    .run();
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
  return { m, share, member, id };
}

const FOOTER = (email: string) =>
  `You got this email because Pat Sharer (${email}) shared a page with you on Open Artifacts.`;

describe("the outside share email", () => {
  it("hosted: an outside address gets it, with the plain footer and no link in it", async () => {
    const { m, share, member, id } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    const s = await share(to);
    expect(s).toMatchObject({ emailed: true });
    expect(s.notEmailed).toBeUndefined();
    const mail = m.sent.find((x) => x.to === to);
    expect(mail?.subject).toBe('Pat Sharer shared "Plan" with you');
    expect(mail?.text).toContain(FOOTER(member.email));
    expect(mail?.html).toContain(FOOTER(member.email));
    // No promotion and no link in the footer: the footer is the last text,
    // and the only link in the mail is the button to the page.
    expect(mail?.text?.trim().endsWith(FOOTER(member.email))).toBe(true);
    const links = [...(mail?.html ?? "").matchAll(/href="([^"]+)"/g)].map(
      (x) => x[1],
    );
    expect(links).toEqual([`https://${env.APP_HOST}/a/${id}`]);
  });

  it("hosted: the limits still apply, and a refused email is reported with its number", async () => {
    const { m, share, member } = await world(HOSTED);
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "insert into counters (key, n, day) values (?, ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
    )
      .bind(`email:out:u:${member.id}`, OUTSIDE_EMAILS_PER_MEMBER_PER_DAY, day)
      .run();
    const to = uniq("out", "gmail.com");
    const s = await share(to);
    expect(s).toMatchObject({
      emailed: false,
      notEmailed: "member_limit",
      limit: OUTSIDE_EMAILS_PER_MEMBER_PER_DAY,
    });
    expect(m.sent.some((x) => x.to === to)).toBe(false);
    expect(
      await env.DB.prepare("select 1 from shares where email = ?")
        .bind(to)
        .first(),
    ).not.toBeNull();
  });

  it("self-host: sent as well, without the outside limits", async () => {
    const { m, share, member } = await world({});
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "insert into counters (key, n, day) values (?, ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
    )
      .bind(`email:out:u:${member.id}`, OUTSIDE_EMAILS_PER_MEMBER_PER_DAY, day)
      .run();
    const to = uniq("out", "gmail.com");
    const s = await share(to);
    expect(s).toMatchObject({ emailed: true });
    expect(m.sent.find((x) => x.to === to)?.text).toContain(
      FOOTER(member.email),
    );
  });
});
