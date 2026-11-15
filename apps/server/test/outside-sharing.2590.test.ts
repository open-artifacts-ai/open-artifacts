// #2590 G3: the owner's outside-sharing switch, the outside email's own daily
// limits, and what the outside email says.
import { env } from "cloudflare:workers";
import { R, SettingsSchema, ShareResultSchema } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import {
  OUTSIDE_SHARING_KEY,
  outsideDefault,
  outsideSharingOn,
} from "../src/services/outside.js";
import {
  OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY,
  OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL,
  OUTSIDE_EMAILS_PER_MEMBER_PER_DAY,
  putShare,
} from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import {
  direct,
  mailer,
  seedShare,
  seedUser,
  TEST_BROKER_KEY,
  uniq,
} from "./auth-helpers.js";
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

/** A hosted install: the outside email, its limits and its switch are hosted's. */
const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

/** A member with a published page, and a mailer that records mail. */
async function sharer(over: Partial<Env> = {}, name = "Pat Sharer") {
  const m = mailer();
  const e = direct({ ...m.env, ...HOSTED, ...over }) as Env;
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
  it("the default is on, and off on the hosted Business tier", () => {
    expect(outsideDefault(null)).toBe(true);
    for (const tier of ["solo", "free", "trial", "team"])
      expect(outsideDefault({ tier } as never)).toBe(true);
    expect(outsideDefault({ tier: "business" } as never)).toBe(false);
  });

  it("a stored fact: the first read writes the default once, with a system audit row; a later tier change moves nothing", async () => {
    await setSwitch(null);
    const audits = async () =>
      (
        await env.DB.prepare(
          "select count(*) n from audit_events where action = 'settings.change' and actor_kind = 'system'",
        ).first<{ n: number }>()
      )?.n as number;
    const before = await audits();
    // A Team instance (the default is on) with a share-made guest.
    expect(await outsideSharingOn(env)).toBe(true);
    expect(await audits()).toBe(before + 1);
    expect(
      await env.DB.prepare("select value from settings where key = ?")
        .bind(OUTSIDE_SHARING_KEY)
        .first(),
    ).toEqual({ value: "true" });
    expect(await outsideSharingOn(env)).toBe(true);
    expect(await audits()).toBe(before + 1);
    // The instance moves to Business: the stored value stays, and the guest
    // still gets in; the page and enforcement read the same fact.
    const e = direct({ AUTH_DOMAIN_JOIN: "invite", TIER: "business" }) as Env;
    const email = uniq("stay", "gmail.com");
    await seedShare(email);
    expect(
      await admit(e, authConfig(e), {
        provider: "google",
        subject: `sub-${email}`,
        email,
        name: "G",
        tenant: null,
        hd: null,
        bound: "email",
      }),
    ).toMatchObject({ ok: true, user: { role: "guest" } });
    expect((await settingsView(e, false)).outsideSharing).toBe(true);
    // An explicit off still ends them.
    await setSwitch("false");
    expect((await settingsView(e, false)).outsideSharing).toBe(false);
    await setSwitch(null);
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
    // The first read writes the default (a system audit row): not this change.
    await outsideSharingOn(env);
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
    // An address at a login domain is not outside, even with no row yet.
    expect((await s.share(uniq("team", "a.com"))).status).toBe(200);
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

describe("turning the switch off ends outside guests' sessions", () => {
  const me = async (e: Env, cookie: string) =>
    (await call(e, R.me, cookie)).status;

  it("revokes share-made guests outside the login domains, no one else", async () => {
    await setSwitch(null);
    const e = direct({ AUTH_DOMAIN_JOIN: "invite" }) as Env;
    const owner = await login(uniq("own", "a.com"), "owner");
    const shareGuest = await login(uniq("sg", "outside.example"), "guest");
    const inDomainGuest = await login(uniq("dg", "a.com"), "guest");
    const invitedGuest = await login(uniq("ig", "outside.example"), "guest");
    await env.DB.prepare("update users set invited_at = ? where id = ?")
      .bind(Date.now(), invitedGuest.userId)
      .run();
    const member = await login(uniq("mem", "outside.example"), "member");
    for (const u of [shareGuest, inDomainGuest, invitedGuest, member])
      expect(await me(e, u.cookie)).toBe(200);
    const epoch = async (id: string) =>
      (
        await env.DB.prepare("select session_epoch n from users where id = ?")
          .bind(id)
          .first<{ n: number }>()
      )?.n;
    const before = await epoch(shareGuest.userId);
    const r = await call(e, R.settings, owner.cookie, "PATCH", {
      outsideSharing: false,
    });
    expect(r.status).toBe(200);
    expect(await me(e, shareGuest.cookie)).toBe(401);
    expect(await epoch(shareGuest.userId)).toBe((before ?? 0) + 1);
    for (const u of [inDomainGuest, invitedGuest, member])
      expect(await me(e, u.cookie)).toBe(200);
    // Off again is no change: nothing more is revoked.
    const again = await login(uniq("sg2", "outside.example"), "guest");
    await call(e, R.settings, owner.cookie, "PATCH", { outsideSharing: false });
    expect(await me(e, again.cookie)).toBe(200);
    await setSwitch(null);
  });
});

describe("an existing Business instance that already shares outside", () => {
  it("stores on at the first write, and its guest keeps access", async () => {
    // The default for Business is off; with no stored value yet and an outside
    // share on record, the stored value is on. (The test world has no billing
    // gate, so the Business default is exercised through the rule's input.)
    await setSwitch(null);
    const email = uniq("keep", "gmail.com");
    await seedShare(email);
    const e = direct({ AUTH_DOMAIN_JOIN: "invite" }) as Env;
    // Business, as the plan the first read sees.
    const plan = await import("../src/billing/plan.js");
    const spy = vi.spyOn(plan, "readPlan").mockResolvedValue({
      tier: "business",
    } as never);
    try {
      expect(await outsideSharingOn(env)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(
      await env.DB.prepare("select value from settings where key = ?")
        .bind(OUTSIDE_SHARING_KEY)
        .first(),
    ).toEqual({ value: "true" });
    expect(
      await admit(e, authConfig(e), {
        provider: "google",
        subject: `sub-${email}`,
        email,
        name: "G",
        tenant: null,
        hd: null,
        bound: "email",
      }),
    ).toMatchObject({ ok: true, user: { role: "guest" } });
    await setSwitch(null);
    // With no outside share, Business stores off.
    await env.DB.prepare("delete from shares").run();
    const spy2 = vi.spyOn(plan, "readPlan").mockResolvedValue({
      tier: "business",
    } as never);
    try {
      expect(await outsideSharingOn(env)).toBe(false);
    } finally {
      spy2.mockRestore();
    }
    await setSwitch(null);
  });
});

describe("past the fan-out cap", () => {
  it("every share-made guest's session ends, also those the socket revoke didn't reach", async () => {
    await setSwitch(null);
    const e = direct({ AUTH_DOMAIN_JOIN: "invite" }) as Env;
    const owner = await login(uniq("own", "a.com"), "owner");
    const guests = [];
    // The free-plan cap is 20: 22 guests, two past it.
    for (let i = 0; i < 22; i++)
      guests.push(await login(uniq(`cap${i}`, "outside.example"), "guest"));
    const last = guests[guests.length - 1];
    if (!last) throw new Error("no guests");
    expect((await call(e, R.me, last.cookie)).status).toBe(200);
    const r = await call(e, R.settings, owner.cookie, "PATCH", {
      outsideSharing: false,
    });
    expect(r.status).toBe(200);
    const statuses = await Promise.all(
      guests.map(async (g) => (await call(e, R.me, g.cookie)).status),
    );
    expect(statuses.every((s) => s === 401)).toBe(true);
    await setSwitch(null);
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
    expect(last?.limit).toBe(OUTSIDE_EMAILS_PER_MEMBER_PER_DAY);
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
      limit: OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY,
    });
    // 20 used: fine on a normal plan, full in a trial (the member's plan).
    await fill(OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL);
    expect((await outsiders(1, s.share))[0]?.emailed).toBe(true);
    await fill(OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL);
    const trialUser = withPlan(s.member, { tier: "trial" } as never);
    const email = uniq("trial", "outside.example");
    const r = await putShare(s.e, trialUser, s.id, { email, role: "viewer" });
    expect(r).toMatchObject({
      emailed: false,
      notEmailed: "instance_limit",
      limit: OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL,
    });
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
    expect(r.limit).toBeUndefined();
    await clear();
  });
});

describe("the outside share email", () => {
  it("names the sender and address, cuts the title, and never links the title", async () => {
    const long = "T".repeat(150);
    const m = mailer();
    const e = direct({ ...m.env, ...HOSTED }) as Env;
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

  it("a title or name that looks like a URL is dropped: A page, and the bare address", async () => {
    const m = mailer();
    const e = direct({ ...m.env, ...HOSTED }) as Env;
    // [title, display name, title shown, name shown (null: the bare address)]
    const cases: [string, string, string, string | null][] = [
      ["see https://evil.example/x", "Pat", "A page", "Pat"],
      ["www.evil.example plan", "Pat", "A page", "Pat"],
      ["open evil.example now", "Pat", "A page", "Pat"],
      ["Q3 plan", "http://evil.example", "Q3 plan", null],
      ["Q3 plan", "evil.example Support", "Q3 plan", null],
      ["Q3 plan", "Pat Sharer", "Q3 plan", "Pat Sharer"],
    ];
    for (const [title, name, shown, nameShown] of cases) {
      const o = await login(uniq("own", "a.com"), "member");
      await env.DB.prepare("update users set display_name = ? where id = ?")
        .bind(name, o.userId)
        .run();
      const member = await getUser(env, o.userId);
      if (!member) throw new Error("no user");
      const { id } = await publish(
        env,
        member,
        { title, format: "markdown", content: "x" } as never,
        null,
        undefined,
        "create",
      );
      const email = uniq("to", "gmail.com");
      expect(
        (
          await call(e, R.shares(id), o.cookie, "PUT", {
            email,
            role: "viewer",
          })
        ).status,
      ).toBe(200);
      const mail = m.sent.find((x) => x.to === email);
      const sender = nameShown ?? member.email;
      expect(mail?.subject, title + name).toBe(
        `${sender} shared "${shown}" with you`,
      );
      expect(mail?.text).not.toContain("evil.example");
      expect(mail?.html).not.toContain("evil.example");
    }
  });

  it("no other sender text: a hostile title is plain, escaped text", async () => {
    const m = mailer();
    const e = direct({ ...m.env, ...HOSTED }) as Env;
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
