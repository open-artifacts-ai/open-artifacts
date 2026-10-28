// Parity 1: POST R.memberRestore(id), invite of a removed address, and the
// routes a spaces-off install now serves (Departed transfer, the manual
// restriction, the removed-members list), with their authorization.
import { env } from "cloudflare:workers";
import {
  type Member,
  MemberSchema,
  newId,
  R,
  type TransferSummary,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { SYSTEM_ACTOR, setUserStatus } from "../src/services/members.js";
import { direct, uniq } from "./auth-helpers.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
/** A self-host install without spaces (the default test env). */
const OFF = env as Env;

type U = { cookie: string; userId: string };
let owner: U;
let admin: U;
let member: U;
let guest: U;

const call = (
  e: Env,
  path: string,
  cookie: string | null,
  init: { method?: string; body?: unknown } = {},
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-oa-request": "1",
        ...(cookie ? { cookie } : {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    e,
  );
const restore = (id: string, cookie: string | null, e: Env = OFF) =>
  call(e, R.memberRestore(id), cookie, { method: "POST" });
const remove = (id: string, cookie: string, e: Env = OFF) =>
  call(e, R.member(id), cookie, { method: "DELETE" });
const row = (id: string) =>
  env.DB.prepare(
    "select role, status, guest_lapsed lapsed, restricted_manual rm, session_epoch e, status_changed_at sc from users where id = ?",
  )
    .bind(id)
    .first<{
      role: string;
      status: string;
      lapsed: number;
      rm: number;
      e: number;
      sc: number | null;
    }>();
const statusAudits = (id: string) =>
  env.DB.prepare(
    "select actor_kind, actor_id, detail from audit_events where target_id = ? and action = 'user.status' order by at, id",
  )
    .bind(id)
    .all<{ actor_kind: string; actor_id: string | null; detail: string }>()
    .then((r) => r.results);

/** A fresh removed member (removed by the admin through the route). */
async function removed(role: Member["role"] = "member"): Promise<U> {
  const u = await login(uniq("rs", "a.com"), role);
  const by = role === "admin" ? owner : admin;
  expect((await remove(u.userId, by.cookie)).status).toBe(204);
  return u;
}

beforeAll(async () => {
  owner = await login(uniq("rs-owner"), "owner");
  admin = await login(uniq("rs-admin"), "admin");
  member = await login(uniq("rs-member"), "member");
  guest = await login(uniq("rs-guest", "x.com"), "guest");
});

describe("POST R.memberRestore(id): authorization", () => {
  it("anonymous 401; a member or guest 404 (route hidden), nothing changes", async () => {
    const u = await removed();
    expect((await restore(u.userId, null)).status).toBe(401);
    for (const who of [member, guest])
      expect((await restore(u.userId, who.cookie)).status).toBe(404);
    expect((await row(u.userId))?.status).toBe("removed");
  });

  it("an unknown id → 404 for the owner and an admin", async () => {
    for (const who of [owner, admin])
      expect((await restore(newId(), who.cookie)).status).toBe(404);
  });

  it("an admin restoring a removed admin → 403 owner_only, nothing written or audited; the owner may", async () => {
    const a = await removed("admin");
    const before = await row(a.userId);
    const audits = (await statusAudits(a.userId)).length;
    const r = await restore(a.userId, admin.cookie);
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("owner_only");
    expect(await row(a.userId)).toEqual(before);
    expect(await statusAudits(a.userId)).toHaveLength(audits);
    const ok = await restore(a.userId, owner.cookie);
    expect(ok.status).toBe(200);
    // Comes back as a plain member.
    expect(MemberSchema.parse(await ok.json()).role).toBe("member");
  });

  it("works on a spaces-on install too (same rules)", async () => {
    const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;
    const u = await removed();
    expect((await restore(u.userId, admin.cookie, SPACES)).status).toBe(200);
  });
});

describe("POST R.memberRestore(id): behaviour", () => {
  it("200 Member: active, role member, manual restriction kept, sessions end, audited admin_restore", async () => {
    const u = await login(uniq("rs-full", "a.com"), "member");
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(u.userId)
      .run();
    expect((await remove(u.userId, admin.cookie)).status).toBe(204);
    const gone = await row(u.userId);
    const r = await restore(u.userId, admin.cookie);
    expect(r.status).toBe(200);
    const m = MemberSchema.parse(await r.json());
    expect(m).toMatchObject({
      id: u.userId,
      role: "member",
      status: "active",
      identities: [],
      restriction: { manual: true, groups: [] },
    });
    const now = await row(u.userId);
    expect(now).toMatchObject({ status: "active", role: "member", rm: 1 });
    expect(now?.e).toBe((gone?.e ?? 0) + 1);
    expect(now?.sc).toBeGreaterThanOrEqual(gone?.sc ?? 0);
    const audits = await statusAudits(u.userId);
    expect(audits.at(-1)).toMatchObject({
      actor_kind: "user",
      actor_id: admin.userId,
    });
    expect(JSON.parse(audits.at(-1)?.detail ?? "{}")).toEqual({
      status: "active",
      reason: "admin_restore",
    });
    // A session from before the removal stays refused (the epoch moved).
    expect((await call(OFF, R.me, u.cookie)).status).toBe(401);
    // Listed as active again.
    const list = MemberSchema.array().parse(
      await (await call(OFF, R.members, admin.cookie)).json(),
    );
    expect(list.find((x) => x.id === u.userId)?.status).toBe("active");
  });

  it("a removed guest comes back as a plain member", async () => {
    const g = await login(uniq("rs-g", "x.com"), "guest");
    expect((await remove(g.userId, admin.cookie)).status).toBe(204);
    const r = await restore(g.userId, admin.cookie);
    expect(r.status).toBe(200);
    expect((await row(g.userId))?.role).toBe("member");
  });

  it("not removed → 409 member_active (active, suspended, the owner); nothing audited", async () => {
    const s = await login(uniq("rs-susp", "a.com"), "member");
    await setUserStatus(
      env,
      s.userId,
      "suspended",
      "admin_suspend",
      SYSTEM_ACTOR,
    );
    for (const id of [member.userId, s.userId, owner.userId]) {
      const before = (await statusAudits(id)).length;
      const r = await restore(id, owner.cookie);
      expect(r.status, id).toBe(409);
      expect((await errOf(r)).code).toBe("member_active");
      expect(await statusAudits(id)).toHaveLength(before);
    }
    expect((await row(s.userId))?.status).toBe("suspended");
  });

  it("a lapsed guest → 409 guest_lapsed (a new share brings them back)", async () => {
    const g = await login(uniq("rs-lapsed", "x.com"), "guest");
    await env.DB.prepare(
      "update users set status = 'removed', guest_lapsed = 1 where id = ?",
    )
      .bind(g.userId)
      .run();
    const r = await restore(g.userId, admin.cookie);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("guest_lapsed");
    expect(await row(g.userId)).toMatchObject({
      status: "removed",
      lapsed: 1,
      role: "guest",
    });
    // An admin Remove makes it final (guest_lapsed cleared): restorable then.
    expect((await remove(g.userId, admin.cookie)).status).toBe(204);
    expect((await restore(g.userId, admin.cookie)).status).toBe(200);
  });

  it("removed by directory sync → 409 directory_managed while Google sync is on; allowed when it is off or frozen", async () => {
    const u = await login(uniq("rs-dir", "a.com"), "member");
    await setUserStatus(
      env,
      u.userId,
      "removed",
      "directory_delete",
      SYSTEM_ACTOR,
    );
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    const r = await restore(u.userId, admin.cookie, GOOGLE);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("directory_managed");
    expect((await row(u.userId))?.status).toBe("removed");
    // An admin removal under Google sync is restorable.
    const a = await removed();
    expect((await restore(a.userId, admin.cookie, GOOGLE)).status).toBe(200);
    // Sync frozen (manual edits allowed): the directory removal restores.
    const FROZEN = { ...(env as object), FEATURES: "sync_frozen" } as Env;
    expect((await restore(u.userId, admin.cookie, FROZEN)).status).toBe(200);
  });
});

describe("invite of a removed address", () => {
  it.each([
    ["Access", OFF],
    ["direct", direct()],
  ] as const)(
    "%s: 409 member_removed with { userId }; nothing created",
    async (_, e) => {
      const u = await removed();
      const email = (
        await env.DB.prepare("select email from users where id = ?")
          .bind(u.userId)
          .first<{ email: string }>()
      )?.email;
      const r = await call(e, R.members, admin.cookie, {
        method: "POST",
        body: { email, role: "member" },
      });
      expect(r.status).toBe(409);
      expect(await errOf(r)).toMatchObject({
        code: "member_removed",
        details: { userId: u.userId },
      });
      expect((await row(u.userId))?.status).toBe("removed");
    },
  );

  it("an active address is still 409 conflict", async () => {
    const email = (
      await env.DB.prepare("select email from users where id = ?")
        .bind(member.userId)
        .first<{ email: string }>()
    )?.email;
    const r = await call(OFF, R.members, admin.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("conflict");
  });
});

describe("spaces off: the routes parity 1 ungates", () => {
  it("GET R.members?status=removed lists admin-removed members (L13)", async () => {
    const u = await removed();
    const list = MemberSchema.array().parse(
      await (
        await call(OFF, `${R.members}?status=removed`, admin.cookie)
      ).json(),
    );
    expect(list.find((x) => x.id === u.userId)?.status).toBe("removed");
  });

  it("Departed transfer: org owner and admin only (member, guest 404; anonymous 401)", async () => {
    const u = await removed();
    for (const who of [member, guest])
      expect(
        (await call(OFF, R.memberTransfer(u.userId), who.cookie)).status,
      ).toBe(404);
    expect((await call(OFF, R.memberTransfer(u.userId), null)).status).toBe(
      401,
    );
    for (const who of [owner, admin]) {
      const r = await call(OFF, R.memberTransfer(u.userId), who.cookie);
      expect(r.status).toBe(200);
      expect((await r.json()) as TransferSummary).toEqual({
        live: 0,
        deleted: 0,
      });
    }
    // POST by a member: 404 (CSRF passes, the guard refuses).
    const p = await call(OFF, R.memberTransfer(u.userId), member.cookie, {
      method: "POST",
      body: { to: { kind: "user", userId: member.userId } },
    });
    expect(p.status).toBe(404);
  });

  it("transfer to oneself works; a shared-space target is 404 without spaces; an active member 409", async () => {
    const u = await removed();
    const me = await call(OFF, R.memberTransfer(u.userId), admin.cookie, {
      method: "POST",
      body: { to: { kind: "user", userId: admin.userId } },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      moved: 0,
      remaining: 0,
      nextCursor: null,
    });
    const sp = await call(OFF, R.memberTransfer(u.userId), admin.cookie, {
      method: "POST",
      body: { to: { kind: "space", spaceId: newId() } },
    });
    expect(sp.status).toBe(404);
    const act = await call(OFF, R.memberTransfer(member.userId), admin.cookie, {
      method: "POST",
      body: { to: { kind: "user", userId: admin.userId } },
    });
    expect(act.status).toBe(409);
    expect((await errOf(act)).code).toBe("member_active");
  });

  it("manual restriction (L10): org owner and admin set and clear it; a member 404", async () => {
    const t = await login(uniq("rs-restrict", "a.com"), "member");
    expect(
      (
        await call(OFF, R.memberRestricted(t.userId), member.cookie, {
          method: "PUT",
        })
      ).status,
    ).toBe(404);
    const on = await call(OFF, R.memberRestricted(t.userId), admin.cookie, {
      method: "PUT",
    });
    expect(on.status).toBe(200);
    expect(MemberSchema.parse(await on.json()).restriction).toEqual({
      manual: true,
      groups: [],
    });
    const off = await call(OFF, R.memberRestricted(t.userId), owner.cookie, {
      method: "DELETE",
    });
    expect(off.status).toBe(200);
    expect(MemberSchema.parse(await off.json()).restriction).toBeNull();
    // Owners and admins can't be restricted, as with spaces.
    const adm = await call(
      OFF,
      R.memberRestricted(admin.userId),
      owner.cookie,
      {
        method: "PUT",
      },
    );
    expect(adm.status).toBe(400);
    expect((await errOf(adm)).code).toBe("restrict_admin");
  });
});
