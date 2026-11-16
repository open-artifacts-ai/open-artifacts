// #2632 (server): per-person setup on R.members, the invited-by row, the
// "is set up" inbox line, and /me's instanceOwner.
import { env } from "cloudflare:workers";
import { type Inbox, MeSchema, newId, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  askAnsweredKey,
  mentionRepliedKey,
  namedKey,
} from "../src/services/onboarding-firsts.js";
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
