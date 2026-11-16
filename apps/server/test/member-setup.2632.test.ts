// #2632 (server): per-person setup on R.members, the invited-by row, the
// "is set up" inbox line, and /me's instanceOwner.
import { env } from "cloudflare:workers";
import { type Inbox, MeSchema, newId, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { seedWelcome } from "../src/services/onboarding.js";
import {
  askAnsweredKey,
  mentionRepliedKey,
  namedKey,
} from "../src/services/onboarding-firsts.js";
import { getUser } from "../src/services/users.js";
import { TEST_BROKER_KEY } from "./auth-helpers.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = () => newId().slice(0, 6).toLowerCase();
const one = (sql: string, ...b: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...b)
    .first<{ value: string }>();
const set = (key: string) =>
  env.DB.prepare("insert or ignore into settings (key, value) values (?1, ?2)")
    .bind(key, String(Date.now()))
    .run();
type Row = {
  id: string;
  setup?: { state: string; done: number; stalled?: string };
};
const list = async (cookie: string) =>
  (await (await api(app, R.members, cookie)).json()) as Row[];
const seen = (id: string) =>
  env.DB.prepare("update users set last_seen_at = ?2 where id = ?1")
    .bind(id, Date.now())
    .run();

describe("GET R.members setup", () => {
  it("is on every row but a guest's, the owner's included, for an admin; a plain member can't list", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    const a = await login(`adm-${tag()}@example.com`, "admin");
    const m = await login(`mem-${tag()}@example.com`, "member");
    const g = await login(`gst-${tag()}@example.com`, "guest");
    await seen(m.userId);
    await set(namedKey(m.userId));
    const rows = await list(a.cookie);
    const by = (id: string) => rows.find((r) => r.id === id);
    expect(by(g.userId)?.setup).toBeUndefined();
    expect(by(o.userId)?.setup).toBeDefined();
    // Added, never signed in.
    expect(by(a.userId)?.setup).toMatchObject({ state: "invited", done: 0 });
    expect(by(m.userId)?.setup).toEqual({
      state: "partial",
      done: 1,
      stalled: "agent",
    });
    expect((await api(app, R.members, m.cookie)).status).toBe(404);
    expect((await api(app, R.members, g.cookie)).status).toBe(404);
    expect(
      (await list(o.cookie)).find((r) => r.id === m.userId)?.setup,
    ).toBeDefined();
  });

  it("set is sticky from the per-person completed, and counts come from the shared function", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    const m = await login(`mem-${tag()}@example.com`, "member");
    await seen(m.userId);
    for (const k of [namedKey, mentionRepliedKey, askAnsweredKey])
      await set(k(m.userId));
    let s = (await list(o.cookie)).find((r) => r.id === m.userId)?.setup;
    expect(s).toMatchObject({ done: 3, stalled: "agent", state: "partial" });
    expect(
      (
        await api(app, R.onboarding, m.cookie, {
          method: "PUT",
          body: { completed: true },
        })
      ).status,
    ).toBe(200);
    s = (await list(o.cookie)).find((r) => r.id === m.userId)?.setup;
    expect(s?.state).toBe("set");
  });
});

describe("invited-by and the inbox line", () => {
  it("an invite writes invited-by; R.onboarding names the inviter; completing tells the inviter exactly once", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    const a = await login(`adm-${tag()}@example.com`, "admin");
    await env.DB.prepare(
      "update users set display_name = 'Ada Admin' where id = ?1",
    )
      .bind(a.userId)
      .run();
    const email = `new-${tag()}@example.com`;
    const r = await api(app, R.members, a.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(
      (
        await one(
          "select value from settings where key = ?1",
          `onboarding:invited-by:${id}`,
        )
      )?.value,
    ).toBe(a.userId);
    const row = await env.DB.prepare(
      "select session_epoch e from users where id = ?1",
    )
      .bind(id)
      .first<{ e: number }>();
    expect(row).not.toBeNull();
    // Sign in as the invitee through the test login helper's cookie format.
    const { signSession, sessionCookieName } = await import(
      "../src/auth/session.js"
    );
    const cookie = `${sessionCookieName(env)}=${await signSession(
      env,
      id,
      Date.now(),
      {
        provider: "access",
        epoch: row?.e ?? 0,
      },
    )}`;
    const mine = (await (await api(app, R.onboarding, cookie)).json()) as {
      invitedBy: { name: string | null } | null;
    };
    expect(mine.invitedBy).toEqual({ name: "Ada Admin" });
    const put = () =>
      api(app, R.onboarding, cookie, {
        method: "PUT",
        body: { completed: true },
      });
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    const inbox = async (c: string) =>
      (await (await api(app, R.meInbox, c)).json()) as Inbox;
    const mine2 = await inbox(a.cookie);
    const lines = mine2.updates.filter((u) => u.kind === "member_set_up");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "update",
      artifact: null,
      actor: { kind: "user", id },
    });
    expect(lines[0]?.text).toMatch(/ is set up in /);
    expect(mine2.counts.unreadUpdates).toBe(1);
    // Not the owner's: the inviter's alone.
    expect(
      (await inbox(o.cookie)).updates.filter((u) => u.kind === "member_set_up"),
    ).toHaveLength(0);
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from settings where key like 'inbox:member_set_up:%' and key like ?1",
        )
          .bind(`%:${id}`)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("with no inviter it goes to the owner", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    // Only one active owner row matters: the oldest. Make this one the oldest.
    await env.DB.prepare("update users set created_at = 1 where id = ?1")
      .bind(o.userId)
      .run();
    const m = await login(`mem-${tag()}@example.com`, "member");
    await api(app, R.onboarding, m.cookie, {
      method: "PUT",
      body: { completed: true },
    });
    const inbox = (await (await api(app, R.meInbox, o.cookie)).json()) as Inbox;
    expect(
      inbox.updates.filter(
        (u) => u.kind === "member_set_up" && u.actor?.id === m.userId,
      ),
    ).toHaveLength(1);
  });
});

describe("GET R.me instanceOwner", () => {
  it("names the owner, for a guest too; null when no name can be read", async () => {
    await env.DB.prepare(
      "update users set role = 'member' where role = 'owner'",
    ).run();
    const g = await login(`gst-${tag()}@example.com`, "guest");
    const none = MeSchema.parse(await (await api(app, R.me, g.cookie)).json());
    expect(none.instanceOwner).toBeNull();
    const o = await login(`own-${tag()}@example.com`, "owner");
    await env.DB.prepare(
      "update users set display_name = 'Olive Owner' where id = ?1",
    )
      .bind(o.userId)
      .run();
    const me = MeSchema.parse(await (await api(app, R.me, g.cookie)).json());
    expect(me.instanceOwner).toEqual({ name: "Olive Owner" });
  });
});

const HB = {
  ...(env as object),
  HOSTED: "1",
  INSTALL_ID: "ibilltest2632",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  TIER: undefined,
} as unknown as Env;
const creatorRows = (id: string) =>
  env.DB.prepare("select count(*) n from creator_months where user_id = ?1")
    .bind(id)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);
const seededRows = (id: string) =>
  env.DB.prepare(
    "select count(*) n from artifacts where owner_id = ?1 and title = 'Welcome'",
  )
    .bind(id)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);
const signins = (id: string, n: number) =>
  Promise.all(
    Array.from({ length: n }, () =>
      env.DB.prepare(
        "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id) values (?1, ?2, 'user', ?3, 'auth.signin', 'user', ?3)",
      )
        .bind(newId(), Date.now(), id)
        .run(),
    ),
  );

describe("seeding is for a person's first sign-in only", () => {
  it("the seeded Welcome records no creator row; their next real publish does", async () => {
    const m = await login(`mem-${tag()}@example.com`, "member");
    await signins(m.userId, 1);
    const u = await getUser(HB, m.userId);
    if (!u) throw new Error("no user");
    // Billing is on (the gate is bound): a real publish counts, the Welcome doesn't.
    const gate = {
      BILLING: { fetch: async () => new Response("nf", { status: 404 }) },
    };
    await withBrokerProps({ props: gate }, async () => {
      await seedWelcome(HB, u);
      expect(await seededRows(m.userId)).toBe(1);
      expect(await creatorRows(m.userId)).toBe(0);
      await publish(
        HB,
        u,
        { title: "mine", format: "html", content: "<p>x</p>" },
        null,
      );
      expect(await creatorRows(m.userId)).toBe(1);
    });
  });

  it("an existing member with artifacts, or with earlier sign-ins, is never seeded", async () => {
    const a = await login(`old-${tag()}@example.com`, "member");
    await api(app, R.artifacts, a.cookie, {
      method: "POST",
      body: { title: "old", format: "html", content: "<p>x</p>" },
    });
    await signins(a.userId, 1);
    const b = await login(`back-${tag()}@example.com`, "member");
    await signins(b.userId, 3);
    for (const x of [a, b]) {
      const u = await getUser(env, x.userId);
      if (!u) throw new Error("no user");
      await seedWelcome(env, u);
    }
    expect(await seededRows(a.userId)).toBe(0);
    expect(await seededRows(b.userId)).toBe(0);
    // The next newly invited member still gets theirs.
    const c = await login(`new-${tag()}@example.com`, "member");
    await signins(c.userId, 1);
    const cu = await getUser(env, c.userId);
    if (!cu) throw new Error("no user");
    await seedWelcome(env, cu);
    expect(await seededRows(c.userId)).toBe(1);
  });
});

describe("erasing a removed member whose only artifact is their seeded Welcome", () => {
  it("works and takes the Welcome with them", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    const m = await login(`mem-${tag()}@example.com`, "member");
    await signins(m.userId, 1);
    const u = await getUser(env, m.userId);
    if (!u) throw new Error("no user");
    await seedWelcome(env, u);
    expect(await seededRows(m.userId)).toBe(1);
    expect(
      (await api(app, R.member(m.userId), o.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    const r = await api(app, R.memberErase(m.userId), o.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(204);
    expect(await seededRows(m.userId)).toBe(0);
  });

  it("a page of their own still blocks it", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    const m = await login(`mem-${tag()}@example.com`, "member");
    await api(app, R.artifacts, m.cookie, {
      method: "POST",
      body: { title: "mine", format: "html", content: "<p>x</p>" },
    });
    await api(app, R.member(m.userId), o.cookie, { method: "DELETE" });
    const r = await api(app, R.memberErase(m.userId), o.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(409);
  });
});
