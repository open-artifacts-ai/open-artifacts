// Parity 1: POST R.memberRestore(id), invite of a removed address, and the
// routes a spaces-off install now serves (Departed transfer, the manual
// restriction, the removed-members list), with their authorization.
import { env } from "cloudflare:workers";
import {
  AuditEventSchema,
  type Member,
  MemberSchema,
  newId,
  PageSchema,
  R,
  type TransferSummary,
} from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { callerOf } from "../src/auth/authz.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { deleteUser } from "../src/directory/apply.js";
import type { Env } from "../src/env.js";
import {
  placeholder,
  restoreMember,
  reviveFromSync,
  SYSTEM_ACTOR,
  setUserStatus,
} from "../src/services/members.js";
import { directoryMode, mySharedSpaces } from "../src/services/spaces.js";
import { getUser } from "../src/services/users.js";
import { direct, uniq } from "./auth-helpers.js";
import { directEnv, resetDirectory } from "./directory-helpers.js";
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
    "select role, status, guest_lapsed lapsed, removed_by_sync bySync, restricted_manual rm, session_epoch e, status_changed_at sc from users where id = ?",
  )
    .bind(id)
    .first<{
      role: string;
      status: string;
      lapsed: number;
      bySync: number;
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

/** A connected Workspace: the live binding and token, as confirm leaves them. */
const connectWorkspace = () =>
  env.DB.batch([
    env.DB.prepare(
      "insert or replace into directory_state (key, value) values ('binding', ?)",
    ).bind(
      JSON.stringify({
        provider: "google",
        customerId: "C0123",
        domain: "a.com",
        connectedBy: owner.userId,
        connectedAt: new Date().toISOString(),
      }),
    ),
    env.DB.prepare(
      "insert or replace into directory_state (key, value) values ('refresh', 'sealed')",
    ),
  ]);
afterEach(resetDirectory);

/** A directory removal, as sync records it. */
const removedBySync = (id: string) =>
  setUserStatus(env, id, "removed", "directory_delete", SYSTEM_ACTOR);

/** `id` in a restricted group: the flag stays 0 while they are an admin. */
async function inRestrictedGroup(id: string) {
  const g = `rs-group-${newId()}`;
  await env.DB.batch([
    env.DB.prepare(
      "insert into directory_groups (group_id, email) values (?, ?)",
    ).bind(g, `${g}@a.com`),
    env.DB.prepare(
      "insert into restricted_groups (group_id, group_email) values (?, ?)",
    ).bind(g, `${g}@a.com`),
    env.DB.prepare(
      "insert into directory_members (group_id, user_id, gen) values (?, ?, 1)",
    ).bind(g, id),
  ]);
  return g;
}
const restrictedSync = async (id: string) =>
  (
    await env.DB.prepare("select restricted_sync r from users where id = ?")
      .bind(id)
      .first<{ r: number }>()
  )?.r;

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
    // Comes back as a member, never an admin.
    expect(MemberSchema.parse(await ok.json()).role).toBe("member");
    expect(await row(a.userId)).toMatchObject({
      status: "active",
      role: "member",
    });
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

  it("a removed guest comes back as a guest, a removed member as a member", async () => {
    const g = await login(uniq("rs-g", "x.com"), "guest");
    expect((await remove(g.userId, admin.cookie)).status).toBe(204);
    const r = await restore(g.userId, admin.cookie);
    expect(r.status).toBe(200);
    expect(MemberSchema.parse(await r.json()).role).toBe("guest");
    expect(await row(g.userId)).toMatchObject({
      status: "active",
      role: "guest",
    });
    const m = await removed();
    const rm = await restore(m.userId, admin.cookie);
    expect(rm.status).toBe(200);
    expect(MemberSchema.parse(await rm.json()).role).toBe("member");
    expect((await row(m.userId))?.role).toBe("member");
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
    await connectWorkspace();
    const u = await login(uniq("rs-dir", "a.com"), "member");
    await setUserStatus(
      env,
      u.userId,
      "removed",
      "directory_delete",
      SYSTEM_ACTOR,
    );
    expect(await row(u.userId)).toMatchObject({
      status: "removed",
      bySync: 1,
    });
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    const r = await restore(u.userId, admin.cookie, GOOGLE);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("directory_managed");
    expect((await row(u.userId))?.status).toBe("removed");
    // An admin removal under Google sync is restorable.
    const a = await removed();
    expect((await row(a.userId))?.bySync).toBe(0);
    expect((await restore(a.userId, admin.cookie, GOOGLE)).status).toBe(200);
    // Sync frozen (manual edits allowed): the directory removal restores,
    // and the restore clears the flag.
    const FROZEN = { ...(env as object), FEATURES: "sync_frozen" } as Env;
    expect((await restore(u.userId, admin.cookie, FROZEN)).status).toBe(200);
    expect(await row(u.userId)).toMatchObject({ status: "active", bySync: 0 });
  });

  it("self-host with a working directory transport and no FEATURES entry is Google sync: a directory removal stays 409, restore and invite", async () => {
    await connectWorkspace();
    const email = uniq("rs-transport", "a.com");
    const u = await login(email, "member");
    await setUserStatus(
      env,
      u.userId,
      "removed",
      "directory_delete",
      SYSTEM_ACTOR,
    );
    const CONNECTED = directEnv({ FEATURES: "" });
    expect(directoryMode(CONNECTED)).toBe("google");
    const r = await restore(u.userId, admin.cookie, CONNECTED);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("directory_managed");
    const inv = await call(CONNECTED, R.members, admin.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(inv.status).toBe(409);
    expect((await errOf(inv)).code).toBe("directory_managed");
    expect((await row(u.userId))?.status).toBe("removed");
  });

  it.each([
    ["FEATURES sync_google", { FEATURES: "sync_google" }],
    ["a transport and no FEATURES entry", { FEATURES: "" }],
  ])(
    "%s, no Workspace connected: nothing syncs, so a directory removal is an admin's to restore",
    async (_, over) => {
      const email = uniq("rs-unbound", "a.com");
      const u = await login(email, "member");
      await removedBySync(u.userId);
      const e = directEnv(over);
      expect(directoryMode(e)).toBe("google");
      const inv = await call(e, R.members, admin.cookie, {
        method: "POST",
        body: { email, role: "member" },
      });
      expect(inv.status).toBe(409);
      expect(await errOf(inv)).toMatchObject({
        code: "member_removed",
        details: { userId: u.userId },
      });
      expect((await restore(u.userId, admin.cookie, e)).status).toBe(200);
      expect(await row(u.userId)).toMatchObject({
        status: "active",
        bySync: 0,
      });
    },
  );

  it("a directory removal stays refused after audit retention sweeps its audit row", async () => {
    await connectWorkspace();
    const u = await login(uniq("rs-dir-swept", "a.com"), "member");
    await setUserStatus(
      env,
      u.userId,
      "removed",
      "directory_delete",
      SYSTEM_ACTOR,
    );
    await env.DB.prepare(
      "delete from audit_events where target_type = 'user' and target_id = ?",
    )
      .bind(u.userId)
      .run();
    expect(await statusAudits(u.userId)).toHaveLength(0);
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    const r = await restore(u.userId, admin.cookie, GOOGLE);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("directory_managed");
    expect(await row(u.userId)).toMatchObject({
      status: "removed",
      bySync: 1,
    });
  });

  it("a directory suspension then an admin removal is restorable under Google sync (the admin change clears the flag)", async () => {
    const u = await login(uniq("rs-dir-susp", "a.com"), "member");
    await setUserStatus(
      env,
      u.userId,
      "suspended",
      "directory_suspend",
      SYSTEM_ACTOR,
    );
    expect((await row(u.userId))?.bySync).toBe(0);
    expect((await remove(u.userId, admin.cookie)).status).toBe(204);
    expect((await row(u.userId))?.bySync).toBe(0);
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    expect((await restore(u.userId, admin.cookie, GOOGLE)).status).toBe(200);
  });
});

describe("what a restore brings back", () => {
  it("a restricted admin comes back capped on a restore: the group restriction follows the new role", async () => {
    const u = await login(uniq("rs-r-admin", "a.com"), "admin");
    const g = await inRestrictedGroup(u.userId);
    expect(await restrictedSync(u.userId)).toBe(0);
    expect((await remove(u.userId, owner.cookie)).status).toBe(204);
    // Sync stopped: nothing else would ever raise the flag.
    const FROZEN = { ...(env as object), FEATURES: "sync_frozen" } as Env;
    const r = await restore(u.userId, owner.cookie, FROZEN);
    expect(r.status).toBe(200);
    expect(await restrictedSync(u.userId)).toBe(1);
    const m = MemberSchema.parse(await r.json());
    expect(m.role).toBe("member");
    expect(m.restriction?.groups.map((x) => x.groupId)).toEqual([g]);
  });

  it("a restricted admin comes back capped on a sync revive", async () => {
    const email = uniq("rs-r-sync", "a.com").toLowerCase();
    const u = await login(email, "admin");
    await inRestrictedGroup(u.userId);
    const sub = `g-rs-${newId()}`;
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, 1, 1)",
    )
      .bind(sub, u.userId)
      .run();
    await removedBySync(u.userId);
    expect(await restrictedSync(u.userId)).toBe(0);
    expect(await reviveFromSync(env, u.userId, sub, email)).toBe(true);
    expect(await row(u.userId)).toMatchObject({
      status: "active",
      role: "member",
    });
    expect(await restrictedSync(u.userId)).toBe(1);
  });

  it("a restored member has their space role back", async () => {
    const ON = { ...(env as object), FEATURES: "spaces" } as Env;
    const u = await login(uniq("rs-space", "a.com"), "member");
    const spaceId = newId();
    await env.DB.batch([
      env.DB.prepare(
        "insert into spaces (id, kind, name, created_at) values (?, 'shared', ?, 1)",
      ).bind(spaceId, `Restore ${spaceId}`),
      env.DB.prepare(
        "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', 1)",
      ).bind(spaceId, u.userId),
    ]);
    expect((await remove(u.userId, admin.cookie, ON)).status).toBe(204);
    expect((await restore(u.userId, admin.cookie, ON)).status).toBe(200);
    const m = (await getUser(env, u.userId)) as Member;
    const mine = await mySharedSpaces(ON, callerOf(m));
    expect(mine.find((s) => s.id === spaceId)?.myRole).toBe("editor");
  });

  it("a row a directory deletion released (removed+<id>@invalid) is refused, never an active ghost; while sync manages it, directory_managed", async () => {
    const u = await login(uniq("rs-ghost", "a.com"), "member");
    await deleteUser(env, u.userId, "directory_delete", () => {});
    const email = await env.DB.prepare("select email from users where id = ?")
      .bind(u.userId)
      .first<{ email: string }>();
    expect(email?.email).toBe(placeholder(u.userId));
    const r = await restore(u.userId, admin.cookie);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("conflict");
    expect(await row(u.userId)).toMatchObject({ status: "removed", bySync: 1 });
    expect(await statusAudits(u.userId)).toHaveLength(1);
    await connectWorkspace();
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    const managed = await restore(u.userId, admin.cookie, GOOGLE);
    expect((await errOf(managed)).code).toBe("directory_managed");
  });

  it("an address released between the read and the write is refused in the write", async () => {
    const u = await login(uniq("rs-ghost-race", "a.com"), "member");
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(u.userId)
      .run();
    let raced = false;
    const DB = new Proxy(env.DB, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== "function") return v;
        if (k !== "batch") return v.bind(t);
        return async (s: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await t
              .prepare("update users set email = ? where id = ?")
              .bind(placeholder(u.userId), u.userId)
              .run();
          }
          return t.batch(s);
        };
      },
    });
    const actor = (await getUser(env, admin.userId)) as Member;
    await expect(
      restoreMember({ ...env, DB } as Env, u.userId, actor),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await row(u.userId))?.status).toBe("removed");
  });

  it("a capped admin (a code session) gets 404 and changes nothing", async () => {
    const u = await removed();
    const before = await row(u.userId);
    const cookie = `${sessionCookieName(env)}=${await signSession(
      env,
      admin.userId,
      Date.now(),
      { provider: "code", epoch: 0 },
    )}`;
    expect((await restore(u.userId, cookie)).status).toBe(404);
    expect(await row(u.userId)).toEqual(before);
  });
});

describe("DELETE on a member directory sync removed", () => {
  const managed = (id: string) =>
    env.DB.prepare(
      "select actor_kind, actor_id, target_type, detail from audit_events where target_id = ? and action = 'user.sync_managed'",
    )
      .bind(id)
      .all<{
        actor_kind: string;
        actor_id: string | null;
        target_type: string;
        detail: string;
      }>()
      .then((r) => r.results);
  const stored = (id: string) =>
    env.DB.prepare(
      "select email, status, removed_by_sync, guest_lapsed, session_epoch, status_changed_at from users where id = ?",
    )
      .bind(id)
      .first();

  it("while sync manages the install: 204, audited user.sync_managed, nothing changes", async () => {
    await connectWorkspace();
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    const email = uniq("rs-del-sync", "a.com");
    const u = await login(email, "member");
    await removedBySync(u.userId);
    const before = await stored(u.userId);
    const audits = await statusAudits(u.userId);

    expect((await remove(u.userId, admin.cookie, GOOGLE)).status).toBe(204);

    expect(await stored(u.userId)).toEqual(before);
    expect(await statusAudits(u.userId)).toEqual(audits);
    const rows = await managed(u.userId);
    expect(rows).toEqual([
      {
        actor_kind: "user",
        actor_id: admin.userId,
        target_type: "user",
        detail: JSON.stringify({ status: "removed" }),
      },
    ]);
    expect(rows[0]?.detail).not.toContain("@");
    // Through the log too: a row outside AuditActionSchema reads as nothing.
    const log = PageSchema(AuditEventSchema).parse(
      await (await call(GOOGLE, `${R.audit}?limit=100`, owner.cookie)).json(),
    );
    expect(
      log.items.find(
        (e) => e.action === "user.sync_managed" && e.target.id === u.userId,
      ),
    ).toMatchObject({ detail: { status: "removed" } });
  });

  it("with no Workspace connected, or on an admin's removal: no row, sync manages nothing here", async () => {
    const unbound = await login(uniq("rs-del-unbound", "a.com"), "member");
    await removedBySync(unbound.userId);
    expect(
      (await remove(unbound.userId, admin.cookie, directEnv({ FEATURES: "" })))
        .status,
    ).toBe(204);
    expect(await managed(unbound.userId)).toEqual([]);

    await connectWorkspace();
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    const byAdmin = await removed();
    expect((await remove(byAdmin.userId, admin.cookie, GOOGLE)).status).toBe(
      204,
    );
    expect(await managed(byAdmin.userId)).toEqual([]);
  });
});

describe("migration 0021's backfill", () => {
  const { TEST_MIGRATIONS } = env as unknown as {
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  };
  const backfill = TEST_MIGRATIONS.find(
    (m) => m.name === "0021_removed_by_sync.sql",
  )?.queries.find((q) => q.includes("UPDATE `users`"));
  const run = async () => {
    expect(backfill).toBeTruthy();
    await env.DB.prepare(backfill as string).run();
  };
  const audited = (id: string, at: number, reason: string) =>
    env.DB.prepare(
      "insert into audit_events (id, at, actor_kind, action, target_type, target_id, detail) values (?, ?, 'system', 'user.status', 'user', ?, ?)",
    )
      .bind(newId(), at, id, JSON.stringify({ reason }))
      .run();
  const flag = async (id: string) => (await row(id))?.bySync;
  const mk = async (status: string) => {
    const u = await login(uniq("rs-bf", "a.com"), "member");
    await env.DB.prepare("update users set status = ? where id = ?")
      .bind(status, u.userId)
      .run();
    return u.userId;
  };

  it("sets the flag only for a removed row whose latest user.status reason is directory_*, idempotently", async () => {
    // As setUserStatus writes it, from before the column existed.
    const live = (await login(uniq("rs-bf", "a.com"), "member")).userId;
    await removedBySync(live);
    await env.DB.prepare("update users set removed_by_sync = 0 where id = ?")
      .bind(live)
      .run();
    const directory = await mk("removed");
    await audited(directory, 1, "admin_suspend");
    await audited(directory, 2, "directory_stale");
    const adminLast = await mk("removed");
    await audited(adminLast, 1, "directory_delete");
    await audited(adminLast, 2, "admin_remove");
    const swept = await mk("removed");
    const active = await mk("active");
    await audited(active, 1, "directory_delete");
    // The LIKE escapes `_`: a reason merely starting "directory" isn't one.
    const lookalike = await mk("removed");
    await audited(lookalike, 1, "directoryXdelete");

    for (let i = 0; i < 2; i++) {
      await run();
      expect(await flag(live)).toBe(1);
      expect(await flag(directory)).toBe(1);
      expect(await flag(adminLast)).toBe(0);
      expect(await flag(swept)).toBe(0);
      expect(await flag(active)).toBe(0);
      expect(await flag(lookalike)).toBe(0);
    }
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

  it.each([
    ["Access", OFF],
    ["direct", direct()],
  ] as const)(
    "%s: a lapsed guest's address → 409 guest_lapsed (no Restore offered); nothing created",
    async (_, e) => {
      const g = await login(uniq("rs-inv-lapsed", "x.com"), "guest");
      await env.DB.prepare(
        "update users set status = 'removed', guest_lapsed = 1 where id = ?",
      )
        .bind(g.userId)
        .run();
      const email = (
        await env.DB.prepare("select email from users where id = ?")
          .bind(g.userId)
          .first<{ email: string }>()
      )?.email;
      const r = await call(e, R.members, admin.cookie, {
        method: "POST",
        body: { email, role: "member" },
      });
      expect(r.status).toBe(409);
      const body = await errOf(r);
      expect(body.code).toBe("guest_lapsed");
      expect(body.details).toBeUndefined();
      expect(await row(g.userId)).toMatchObject({
        status: "removed",
        lapsed: 1,
        role: "guest",
      });
    },
  );

  it("a directory removal's address under Google sync → 409 directory_managed (no Restore offered); member_removed when sync is off; nothing created", async () => {
    await connectWorkspace();
    const u = await login(uniq("rs-inv-dir", "a.com"), "member");
    await setUserStatus(
      env,
      u.userId,
      "removed",
      "directory_delete",
      SYSTEM_ACTOR,
    );
    const email = (
      await env.DB.prepare("select email from users where id = ?")
        .bind(u.userId)
        .first<{ email: string }>()
    )?.email;
    const invite = (e: Env) =>
      call(e, R.members, admin.cookie, {
        method: "POST",
        body: { email, role: "member" },
      });
    const GOOGLE = { ...(env as object), FEATURES: "sync_google" } as Env;
    const r = await invite(GOOGLE);
    expect(r.status).toBe(409);
    const body = await errOf(r);
    expect(body.code).toBe("directory_managed");
    expect(body.details).toBeUndefined();
    const off = await invite(OFF);
    expect(off.status).toBe(409);
    expect(await errOf(off)).toMatchObject({
      code: "member_removed",
      details: { userId: u.userId },
    });
    expect(await row(u.userId)).toMatchObject({
      status: "removed",
      bySync: 1,
    });
  });

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
