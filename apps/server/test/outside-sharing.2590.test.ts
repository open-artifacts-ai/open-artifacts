// #2590 G3: the owner's outside-sharing switch, the outside email's own daily
// limits, and what the outside email says.
import { env } from "cloudflare:workers";
import { R, SettingsSchema, ShareResultSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { withPlan } from "../src/auth/authz.js";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  admit,
  codeEligibility,
  linkEligibility,
} from "../src/services/identity.js";
import { settingsView } from "../src/services/members.js";
import { OUTSIDE_SHARING_KEY, outsideFrom } from "../src/services/outside.js";
import {
  OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY,
  OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL,
  OUTSIDE_EMAILS_PER_MEMBER_PER_DAY,
  putShare,
} from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, seedShare, seedUser, uniq } from "./auth-helpers.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";

const call = (
  e: Env,
  path: string,
  cookie: string,
  method = "GET",
  body?: unknown,
) =>
  fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
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

const setSwitch = (v: "true" | "false" | null) =>
  v === null
    ? env.DB.prepare("delete from settings where key = ?")
        .bind(OUTSIDE_SHARING_KEY)
        .run()
    : env.DB.prepare(
        "insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
      )
        .bind(OUTSIDE_SHARING_KEY, v)
        .run();

/** A member with a published page, and a mailer that records mail. */
async function sharer(over: Partial<Env> = {}, name = "Pat Sharer") {
  const m = mailer();
  const e = direct({ ...m.env, ...over }) as Env;
  const o = await login(uniq("own", "a.com"), "member");
  await env.DB.prepare("update users set display_name = ? where id = ?")
    .bind(name, o.userId)
    .run();
  const member = await getUser(env, o.userId);
  if (!member) throw new Error("no user");
  const { id } = await publish(
    env,
    member,
    {
      title: "Q3 plan",
      format: "markdown",
      content: "x",
    } as never,
    null,
    undefined,
    "create",
  );
  const share = (email: string, as: Env = e) =>
    call(as, R.shares(id), o.cookie, "PUT", { email, role: "viewer" });
  return { e, m, o, member, id, share };
}

describe("the owner's switch", () => {
  it("defaults on, and off on the hosted Business tier", async () => {
    await setSwitch(null);
    expect(outsideFrom(undefined, null)).toBe(true);
    for (const tier of ["solo", "free", "trial", "team"])
      expect(outsideFrom(undefined, { tier } as never)).toBe(true);
    expect(outsideFrom(undefined, { tier: "business" } as never)).toBe(false);
    // A stored choice wins over the tier.
    expect(outsideFrom("true", { tier: "business" } as never)).toBe(true);
    expect(outsideFrom("false", null)).toBe(false);
    expect(
      (await settingsView(env, false, { tier: "business" } as never))
        .outsideSharing,
    ).toBe(false);
    expect((await settingsView(env, false)).outsideSharing).toBe(true);
  });

  it("only the owner changes it, and the change is audited as settings.change", async () => {
    await setSwitch(null);
    const owner = await login(uniq("own", "x.com"), "owner");
    const admin = await login(uniq("adm", "x.com"), "admin");
    const e = direct() as Env;
    const denied = await call(e, R.settings, admin.cookie, "PATCH", {
      outsideSharing: false,
    });
    expect(denied.status).toBe(403);
    expect((await errOf(denied)).code).toBe("owner_only");
    const before = (
      await env.DB.prepare(
        "select count(*) n from audit_events where action = 'settings.change'",
      ).first<{ n: number }>()
    )?.n as number;
    const ok = await call(e, R.settings, owner.cookie, "PATCH", {
      outsideSharing: false,
    });
    expect(ok.status).toBe(200);
    expect(SettingsSchema.parse(await ok.json()).outsideSharing).toBe(false);
    const row = await env.DB.prepare(
      "select detail from audit_events where action = 'settings.change' order by at desc limit 1",
    ).first<{ detail: string }>();
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({
      changes: { outsideSharing: { from: true, to: false } },
    });
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from audit_events where action = 'settings.change'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(before + 1);
    // Other settings are still the admin's.
    const name = await call(e, R.settings, admin.cookie, "PATCH", {
      name: "Acme",
    });
    expect(name.status).toBe(200);
    await setSwitch(null);
  });

  it("off: a share to an outside address is 403 outside_sharing_off, nothing written; a member is still shareable", async () => {
    const s = await sharer();
    await setSwitch("false");
    const email = uniq("out", "outside.example");
    const r = await s.share(email);
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("outside_sharing_off");
    expect(
      await env.DB.prepare("select 1 from shares where email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
    const colleague = await login(uniq("col", "a.com"), "member");
    const mem = await env.DB.prepare("select email from users where id = ?")
      .bind(colleague.userId)
      .first<{ email: string }>();
    expect((await s.share(mem?.email as string)).status).toBe(200);
    await setSwitch("true");
    expect((await s.share(email)).status).toBe(200);
    await setSwitch(null);
  });

  it("off: share-made guests can't log in on any path; invited guests can", async () => {
    const e = direct({ AUTH_DOMAIN_JOIN: "invite" }) as Env;
    const cfg = authConfig(e);
    const gmail = (email: string) => ({
      provider: "google" as const,
      subject: `sub-${crypto.randomUUID()}`,
      email,
      name: "G",
      tenant: null,
      hd: null,
      bound: "email" as const,
    });
    const newRecipient = uniq("new", "gmail.com");
    await seedShare(newRecipient);
    const made = uniq("made", "gmail.com");
    await seedUser(made, "guest");
    await seedShare(made);
    const invited = uniq("inv", "gmail.com");
    const invId = await seedUser(invited, "guest");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), invId)
      .run();
    await setSwitch("false");
    try {
      // Google: a new recipient and an existing share-made guest.
      expect(await admit(e, cfg, gmail(newRecipient))).toEqual({
        ok: false,
        reason: "no_access",
      });
      expect(await admit(e, cfg, gmail(made))).toEqual({
        ok: false,
        reason: "no_access",
      });
      // Codes and the Google link.
      expect((await codeEligibility(e, cfg, made)).kind).toBe("none");
      expect((await codeEligibility(e, cfg, newRecipient)).kind).toBe("none");
      expect((await linkEligibility(e, made)).kind).toBe("none");
      expect((await linkEligibility(e, newRecipient)).kind).toBe("none");
      // An invited guest is not affected.
      expect(await admit(e, cfg, gmail(invited))).toMatchObject({
        ok: true,
        user: { role: "guest" },
      });
      // On again: the share-made guest is back.
      await setSwitch("true");
      expect((await admit(e, cfg, gmail(newRecipient))).ok).toBe(true);
    } finally {
      await setSwitch(null);
    }
  });
});

describe("outside share email limits", () => {
  const outsiders = async (
    n: number,
    share: (e: string) => Promise<Response>,
  ) => {
    const out = [];
    for (let i = 0; i < n; i++)
      out.push(
        ShareResultSchema.parse(
          await (await share(uniq(`o${i}`, "outside.example"))).json(),
        ),
      );
    return out;
  };
  const clear = () =>
    env.DB.prepare("delete from counters where key like 'email:%'").run();

  it("20 outside addresses a day per member: the 21st is saved, not emailed, with a reason", async () => {
    await clear();
    const s = await sharer();
    const all = await outsiders(OUTSIDE_EMAILS_PER_MEMBER_PER_DAY + 1, s.share);
    expect(all.slice(0, -1).every((r) => r.emailed)).toBe(true);
    const last = all[all.length - 1];
    expect(last?.emailed).toBe(false);
    expect(last?.notEmailed).toBe("member_limit");
    expect(
      await env.DB.prepare("select 1 from shares where email = ?")
        .bind(last?.email)
        .first(),
    ).not.toBeNull();
    expect(s.m.sent.some((x) => x.to === last?.email)).toBe(false);
    // Another member is not affected.
    const t = await sharer();
    expect((await outsiders(1, t.share))[0]?.emailed).toBe(true);
  });

  it("the instance has a daily limit, lower during a trial", async () => {
    expect(OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY).toBe(100);
    expect(OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL).toBe(20);
    const day = new Date().toISOString().slice(0, 10);
    await clear();
    const s = await sharer();
    const fill = (n: number) =>
      env.DB.prepare(
        "insert into counters (key, n, day) values ('email:out:*', ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
      )
        .bind(n, day)
        .run();
    await fill(OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY);
    const full = (await outsiders(1, s.share))[0];
    expect(full).toMatchObject({
      emailed: false,
      notEmailed: "instance_limit",
    });
    // 20 used: fine on a normal plan, full in a trial (the member's plan).
    await fill(OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL);
    expect((await outsiders(1, s.share))[0]?.emailed).toBe(true);
    await fill(OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL);
    const trialUser = withPlan(s.member, { tier: "trial" } as never);
    const email = uniq("trial", "outside.example");
    const r = await putShare(s.e, trialUser, s.id, { email, role: "viewer" });
    expect(r).toMatchObject({ emailed: false, notEmailed: "instance_limit" });
    await clear();
  });

  it("the existing per-recipient limit stays: a limit it hits is reported as limit", async () => {
    await clear();
    const s = await sharer();
    const email = uniq("rcpt", "outside.example");
    const key = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(email.toLowerCase()),
    );
    const hex = [...new Uint8Array(key)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await env.DB.prepare("insert into counters (key, n, day) values (?, 5, ?)")
      .bind(`email:to:${hex}`, new Date().toISOString().slice(0, 10))
      .run();
    const r = ShareResultSchema.parse(await (await s.share(email)).json());
    expect(r).toMatchObject({ emailed: false, notEmailed: "limit" });
    await clear();
  });
});

describe("the outside share email", () => {
  it("names the sender and address, cuts the title, and never links the title", async () => {
    const long = "T".repeat(150);
    const m = mailer();
    const e = direct({ ...m.env }) as Env;
    const o = await login(uniq("own", "a.com"), "member");
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind("Pat Sharer", o.userId)
      .run();
    const member = await getUser(env, o.userId);
    if (!member) throw new Error("no user");
    const { id } = await publish(
      env,
      member,
      { title: long, format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    const email = uniq("to", "gmail.com");
    const r = await call(e, R.shares(id), o.cookie, "PUT", {
      email,
      role: "viewer",
    });
    expect(r.status).toBe(200);
    const mail = m.sent.find((x) => x.to === email);
    expect(mail?.subject).toBe(
      `Pat Sharer shared "${"T".repeat(79)}…" with you`,
    );
    expect(mail?.text).toContain(
      `Pat Sharer (${member.email}) shared a page with you on Open Artifacts.`,
    );
    expect(mail?.text).toContain("Open it with your Google account");
    // 80 characters: 79 and an ellipsis.
    expect(mail?.text).toContain(`${"T".repeat(79)}…`);
    expect(mail?.text).not.toContain("T".repeat(80));
    // The title is plain text: the only link is the button to the page.
    const links = [...(mail?.html ?? "").matchAll(/href="([^"]+)"/g)].map(
      (x) => x[1] ?? "",
    );
    expect(links).toEqual([`https://${env.APP_HOST}/a/${id}`]);
    expect(mail?.html).toContain(">Open the page<");
  });

  it("no other sender text: a hostile title is plain, escaped text", async () => {
    const m = mailer();
    const e = direct({ ...m.env }) as Env;
    const o = await login(uniq("own", "a.com"), "member");
    const member = await getUser(env, o.userId);
    if (!member) throw new Error("no user");
    const { id } = await publish(
      env,
      member,
      {
        title: 'x<img src=1 onerror=alert(1)> https://evil.example/ "q"',
        format: "markdown",
        content: "x",
      } as never,
      null,
      undefined,
      "create",
    );
    const email = uniq("to", "gmail.com");
    await call(e, R.shares(id), o.cookie, "PUT", { email, role: "viewer" });
    const mail = m.sent.find((x) => x.to === email);
    expect(mail?.html).not.toContain("<img");
    const links = [...(mail?.html ?? "").matchAll(/href="([^"]+)"/g)];
    expect(links).toHaveLength(1);
  });
});
