// #1204: POST R.memberErase(id). An admin erases a removed person: one
// guarded batch wipes what points at them, keeps the row id (authorship) and
// their Google identity, and writes one user.erased audit row.
import { env } from "cloudflare:workers";
import {
  AUTH,
  AuditEventSchema,
  MemberOwnsArtifactsDetailsSchema,
  MemberSchema,
  newId,
  PageSchema,
  R,
} from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName } from "../src/auth/session.js";
import { getDb } from "../src/db/client.js";
import { artifacts } from "../src/db/schema.js";
import { applyUsers } from "../src/directory/apply.js";
import { bindPage } from "../src/directory/binding.js";
import type { GoogleUser } from "../src/directory/google.js";
import type { Env } from "../src/env.js";
import * as oauthApiModule from "../src/mcp/oauth-api.js";
import {
  eraseMember,
  placeholder,
  reviveFromSync,
  SYSTEM_ACTOR,
  setUserStatus,
} from "../src/services/members.js";
import { getUser } from "../src/services/users.js";
import { direct, uniq } from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";
import { errOf, fetchAndWait, login } from "./helpers.js";
import { oauthToken } from "./mcp-helpers.js";

const app = createApp();
const OFF = env as Env;
const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;

type U = { cookie: string; userId: string };
let owner: U;
let admin: U;
let adminEmail: string;
let member: U;
let guest: U;

beforeAll(async () => {
  owner = await login(uniq("er-owner"), "owner");
  adminEmail = uniq("er-admin");
  admin = await login(adminEmail, "admin");
  member = await login(uniq("er-member"), "member");
  guest = await login(uniq("er-guest", "x.com"), "guest");
});
afterEach(() => vi.restoreAllMocks());

const call = (
  e: Env,
  path: string,
  cookie: string | null,
  init: { method?: string; body?: unknown; bearer?: string } = {},
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-oa-request": "1",
        ...(cookie ? { cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    e,
  );
const erase = (id: string, cookie: string | null, e: Env = OFF) =>
  call(e, R.memberErase(id), cookie, { method: "POST" });
const remove = (id: string, cookie: string, e: Env = OFF) =>
  call(e, R.member(id), cookie, { method: "DELETE" });

const one = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
const count = async (sql: string, ...args: unknown[]) =>
  (await one<{ n: number }>(sql, ...args))?.n ?? -1;
const userRow = (id: string) =>
  one<Record<string, unknown>>(
    `select email, name, display_name, last_seen_at, status, role,
      removed_by_sync, guest_lapsed, google_relink, restricted_manual,
      session_epoch, status_changed_at, erased_at from users where id = ?`,
    id,
  );
const erasedAudits = (id: string) =>
  env.DB.prepare(
    "select actor_kind, actor_id, target_type, detail from audit_events where target_id = ? and action = 'user.erased'",
  )
    .bind(id)
    .all<{
      actor_kind: string;
      actor_id: string | null;
      target_type: string;
      detail: string | null;
    }>()
    .then((r) => r.results);

/** An artifact `ownerId` owns in `spaceId`, live or trashed. */
async function art(ownerId: string, spaceId: string, deleted = false) {
  const id = newId();
  const now = Date.now();
  await getDb(env)
    .insert(artifacts)
    .values({
      id,
      ownerId,
      spaceId,
      title: "er",
      format: "html",
      createdAt: now,
      updatedAt: now,
      deletedAt: deleted ? now : null,
    });
  return id;
}

/** A fresh shared space (no members). */
async function sharedSpace() {
  const id = newId();
  await env.DB.prepare(
    "insert into spaces (id, kind, name, owner_user_id, public_links, created_at) values (?, 'shared', ?, null, 0, ?)",
  )
    .bind(id, `er-space-${id}`, Date.now())
    .run();
  return id;
}

const linkGoogle = (sub: string, uid: string) =>
  env.DB.prepare(
    "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
  )
    .bind(sub, uid, Date.now())
    .run();

/** A fresh removed member (removed by the admin through the route). */
async function removed(
  role: "member" | "admin" | "guest" = "member",
  email = uniq("er", role === "guest" ? "x.com" : "a.com"),
): Promise<U & { email: string }> {
  const u = await login(email, role);
  const by = role === "admin" ? owner : admin;
  expect((await remove(u.userId, by.cookie)).status).toBe(204);
  return { ...u, email: email.toLowerCase() };
}

/**
 * Everything erase touches, seeded on a member then removed by the admin:
 * one row in every per-user table, plus what must stay (a share they
 * created, an artifact they own in a shared space, the Google identity).
 */
async function fullyLoaded() {
  const email = uniq("er-full", "a.com").toLowerCase();
  const u = await login(email, "member");
  const id = u.userId;
  const sub = `g-er-${newId()}`;
  const space = await sharedSpace();
  const group = `er-group-${newId()}`;
  const mine = await art(id, space);
  const theirs = await art(owner.userId, owner.userId);
  const other = await art(owner.userId, owner.userId);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "update users set display_name = 'Erin Erased', last_seen_at = ?, google_relink = 1, restricted_manual = 1 where id = ?",
    ).bind(now, id),
    env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    ).bind(sub, id, now),
    env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('test-idp', ?, 'a.com', ?, ?, 0)",
    ).bind(`t-${sub}`, id, now),
    env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
    ).bind(theirs, email, owner.userId, now),
    // A share they created, to someone else: kept (authorship).
    env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, 'someone-else@a.com', 'viewer', ?, ?)",
    ).bind(other, id, now),
    env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', ?)",
    ).bind(space, id, now),
    env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'sync', ?)",
    ).bind(space, id, now),
    env.DB.prepare(
      "insert into frozen_edits (space_id, user_id, at, manual_role, kind) values (?, ?, ?, 'editor', 'override')",
    ).bind(space, id, now),
    env.DB.prepare(
      "insert into directory_groups (group_id, email) values (?, ?)",
    ).bind(group, `${group}@a.com`),
    env.DB.prepare(
      "insert into directory_members (group_id, user_id, gen) values (?, ?, 1)",
    ).bind(group, id),
    env.DB.prepare(
      "insert into agent_grants (grant_id, user_id, label) values (?, ?, 'My laptop agent')",
    ).bind(`grant-${newId()}`, id),
    env.DB.prepare(
      "insert into reserved_artifacts (id, user_id, created_at) values (?, ?, ?)",
    ).bind(newId(), id, now),
  ]);
  await createPat(env, id, "work laptop");
  expect((await remove(id, admin.cookie)).status).toBe(204);
  return { ...u, email, sub, space, group, mine, theirs, other };
}

/** Per-table counts of everything that points at `id` (or its old address). */
const leftovers = async (id: string, email: string) => ({
  sharesTo: await count("select count(*) n from shares where email = ?", email),
  spaceMembers: await count(
    "select count(*) n from space_members where user_id = ?",
    id,
  ),
  frozenEdits: await count(
    "select count(*) n from frozen_edits where user_id = ?",
    id,
  ),
  directoryMembers: await count(
    "select count(*) n from directory_members where user_id = ?",
    id,
  ),
  tokens: await count("select count(*) n from tokens where user_id = ?", id),
  agentGrants: await count(
    "select count(*) n from agent_grants where user_id = ?",
    id,
  ),
  reserved: await count(
    "select count(*) n from reserved_artifacts where user_id = ?",
    id,
  ),
  otherIdentities: await count(
    "select count(*) n from identities where user_id = ? and provider <> 'google'",
    id,
  ),
  googleIdentity: await count(
    "select count(*) n from identities where user_id = ? and provider = 'google'",
    id,
  ),
});
const NONE = {
  sharesTo: 0,
  spaceMembers: 0,
  frozenEdits: 0,
  directoryMembers: 0,
  tokens: 0,
  agentGrants: 0,
  reserved: 0,
  otherIdentities: 0,
  googleIdentity: 1,
};
const ALL = {
  sharesTo: 1,
  spaceMembers: 2,
  frozenEdits: 1,
  directoryMembers: 1,
  tokens: 1,
  agentGrants: 1,
  reserved: 1,
  otherIdentities: 1,
  googleIdentity: 1,
};
const personalName = async (id: string) =>
  (await one<{ name: string }>("select name from spaces where id = ?", id))
    ?.name;

describe("POST R.memberErase(id): authorization", () => {
  it("anonymous 401; a member or guest 404 (route hidden); nothing changes", async () => {
    const u = await removed();
    const before = await userRow(u.userId);
    expect((await erase(u.userId, null)).status).toBe(401);
    for (const who of [member, guest])
      expect((await erase(u.userId, who.cookie)).status).toBe(404);
    expect(await userRow(u.userId)).toEqual(before);
  });

  it("an unknown id is 404 for the owner and an admin", async () => {
    for (const who of [owner, admin])
      expect((await erase(newId(), who.cookie)).status).toBe(404);
  });

  it("an admin's PAT or an AI agent's OAuth grant never erases (cookie sessions only); nothing changes", async () => {
    const u = await removed();
    const before = await userRow(u.userId);
    const { token: pat } = await createPat(env, admin.userId, "admin pat");
    // The PAT reaches the route as the admin: R.me answers.
    expect((await call(OFF, R.me, null, { bearer: pat })).status).toBe(200);
    const r = await call(OFF, R.memberErase(u.userId), null, {
      method: "POST",
      bearer: pat,
    });
    expect(r.status).toBe(404);
    const { accessToken } = await oauthToken(adminEmail, "Agent", admin);
    const g = await call(OFF, R.memberErase(u.userId), null, {
      method: "POST",
      bearer: accessToken,
    });
    expect([401, 404]).toContain(g.status);
    // A bearer next to the admin's cookie is still a bearer.
    const both = await call(OFF, R.memberErase(u.userId), admin.cookie, {
      method: "POST",
      bearer: pat,
    });
    expect(both.status).toBe(404);
    expect(await userRow(u.userId)).toEqual(before);
    expect(await erasedAudits(u.userId)).toEqual([]);
  });

  it("an admin erasing a removed admin is 403 owner_only, nothing written; the owner may", async () => {
    const a = await removed("admin");
    const before = await userRow(a.userId);
    const r = await erase(a.userId, admin.cookie);
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("owner_only");
    expect(await userRow(a.userId)).toEqual(before);
    expect((await erase(a.userId, owner.cookie)).status).toBe(204);
    expect(await userRow(a.userId)).toMatchObject({
      email: placeholder(a.userId),
    });
  });

  it("the caller themself, the owner and any active or suspended person are 409 member_active", async () => {
    for (const [who, target] of [
      [owner, owner.userId],
      [owner, admin.userId],
      [admin, member.userId],
      [admin, guest.userId],
    ] as const) {
      const r = await erase(target, who.cookie);
      expect(r.status).toBe(409);
      expect((await errOf(r)).code).toBe("member_active");
    }
    // An admin on themself: an admin target is the owner's.
    expect((await errOf(await erase(admin.userId, admin.cookie))).code).toBe(
      "owner_only",
    );
    const s = await login(uniq("er-susp", "a.com"), "member");
    await setUserStatus(
      env,
      s.userId,
      "suspended",
      "admin_suspend",
      SYSTEM_ACTOR,
    );
    const r = await erase(s.userId, admin.cookie);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("member_active");
  });

  it("the row at the configured owner address is 409 member_active, even removed", async () => {
    const u = await removed();
    const OWNED = {
      ...(env as object),
      OWNER_EMAIL: u.email.toUpperCase(),
    } as Env;
    const before = await userRow(u.userId);
    const r = await erase(u.userId, admin.cookie, OWNED);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("member_active");
    expect(await userRow(u.userId)).toEqual(before);
  });

  it("the SQL holds the owner-address rule too: an address move to it before the batch erases nothing", async () => {
    const u = await removed();
    const ownerAddr = uniq("er-owner-addr", "a.com").toLowerCase();
    const E = racing(() =>
      env.DB.prepare("update users set email = ? where id = ?")
        .bind(ownerAddr, u.userId)
        .run(),
    );
    const OWNED = { ...(E as object), OWNER_EMAIL: ownerAddr } as Env;
    await expect(
      eraseMember(OWNED, u.userId, await adminMember()),
    ).rejects.toMatchObject({ code: "member_active" });
    expect(await userRow(u.userId)).toMatchObject({
      email: ownerAddr,
      erased_at: null,
    });
    expect(await erasedAudits(u.userId)).toEqual([]);
  });

  it("works on a spaces-on install too", async () => {
    const u = await removed();
    expect((await erase(u.userId, admin.cookie, SPACES)).status).toBe(204);
  });
});

/** The admin as a Member (for the service calls the race tests make). */
async function adminMember() {
  const m = await getUser(env, admin.userId);
  if (!m) throw new Error("no admin");
  return m;
}

describe("POST R.memberErase(id): what goes and what stays", () => {
  it.each([
    ["spaces off", OFF],
    ["spaces on", SPACES],
  ] as const)(
    "%s: every per-user row goes; the row id, Google link and authorship stay",
    async (_, E) => {
      const u = await fullyLoaded();
      const mineBefore = await one(
        "select * from artifacts where id = ?",
        u.mine,
      );
      const created = await one(
        "select * from shares where artifact_id = ? and created_by = ?",
        u.other,
        u.userId,
      );
      const before = await userRow(u.userId);
      expect(await leftovers(u.userId, u.email)).toEqual(ALL);
      expect(await personalName(u.userId)).toBe(u.email.split("@")[0]);

      const r = await erase(u.userId, admin.cookie, E);
      expect(r.status).toBe(204);

      expect(await leftovers(u.userId, u.email)).toEqual(NONE);
      const after = await userRow(u.userId);
      expect(after).toMatchObject({
        email: placeholder(u.userId),
        name: "",
        display_name: null,
        last_seen_at: null,
        status: "removed",
        role: "member",
        removed_by_sync: 0,
        guest_lapsed: 0,
        google_relink: 0,
        restricted_manual: 0,
        session_epoch: (before?.session_epoch as number) + 1,
      });
      expect(after?.erased_at).toEqual(expect.any(Number));
      expect(after?.status_changed_at).toBe(after?.erased_at);
      expect(await personalName(u.userId)).toBe("");
      // The personal space row itself stays (every user has one).
      expect(
        await count("select count(*) n from spaces where id = ?", u.userId),
      ).toBe(1);
      // Authorship: column for column.
      expect(await one("select * from artifacts where id = ?", u.mine)).toEqual(
        mineBefore,
      );
      expect(
        await one(
          "select * from shares where artifact_id = ? and created_by = ?",
          u.other,
          u.userId,
        ),
      ).toEqual(created);
      // The Google identity: the same subject, still on this row.
      expect(
        await one(
          "select user_id from identities where provider = 'google' and subject = ?",
          u.sub,
        ),
      ).toEqual({ user_id: u.userId });
    },
  );

  it("audited once as user.erased by the admin, with no address or name in the row", async () => {
    const u = await fullyLoaded();
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    const rows = await erasedAudits(u.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "user",
      actor_id: admin.userId,
      target_type: "user",
    });
    const raw = await one<Record<string, unknown>>(
      "select * from audit_events where target_id = ? and action = 'user.erased'",
      u.userId,
    );
    const text = JSON.stringify(raw);
    expect(text).not.toContain("@");
    expect(text).not.toContain("Erin");
    expect(text).not.toContain(u.email.split("@")[0]);
    // Through the log: the schema knows the action.
    const log = PageSchema(AuditEventSchema).parse(
      await (await call(OFF, `${R.audit}?limit=100`, owner.cookie)).json(),
    );
    expect(
      log.items.find(
        (e) => e.action === "user.erased" && e.target.id === u.userId,
      ),
    ).toBeTruthy();
  });

  it("idempotent: a second erase is 204 with no second audit row and no change", async () => {
    const u = await removed();
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    const once = await userRow(u.userId);
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    expect((await erase(u.userId, owner.cookie)).status).toBe(204);
    expect(await userRow(u.userId)).toEqual(once);
    expect(await erasedAudits(u.userId)).toHaveLength(1);
  });

  it("a lapsed guest and a directory-deleted row can be erased; the flags clear", async () => {
    const g = await login(uniq("er-lapsed", "x.com"), "guest");
    await env.DB.prepare(
      "update users set status = 'removed', guest_lapsed = 1 where id = ?",
    )
      .bind(g.userId)
      .run();
    expect((await erase(g.userId, admin.cookie)).status).toBe(204);
    expect(await userRow(g.userId)).toMatchObject({ guest_lapsed: 0 });
    const d = await login(uniq("er-dir", "a.com"), "member");
    await setUserStatus(
      env,
      d.userId,
      "removed",
      "directory_delete",
      SYSTEM_ACTOR,
    );
    expect((await userRow(d.userId))?.removed_by_sync).toBe(1);
    expect((await erase(d.userId, admin.cookie)).status).toBe(204);
    expect(await userRow(d.userId)).toMatchObject({
      removed_by_sync: 0,
      email: placeholder(d.userId),
    });
  });

  it("erased people leave the Departed list; restore is 409 member_erased", async () => {
    const u = await removed();
    const listed = async () =>
      MemberSchema.array()
        .parse(
          await (
            await call(OFF, `${R.members}?status=removed`, admin.cookie)
          ).json(),
        )
        .map((m) => m.id);
    expect(await listed()).toContain(u.userId);
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    expect(await listed()).not.toContain(u.userId);
    const r = await call(OFF, R.memberRestore(u.userId), admin.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("member_erased");
    expect((await userRow(u.userId))?.status).toBe("removed");
  });

  it("grant revocation failing after the batch still leaves the row erased (logged)", async () => {
    const u = await removed();
    vi.spyOn(oauthApiModule, "revokeAllGrants").mockRejectedValue(
      new Error("kv down"),
    );
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    expect((await userRow(u.userId))?.erased_at).toEqual(expect.any(Number));
  });
});

describe("POST R.memberErase(id): artifacts left", () => {
  it.each([
    ["live", false, { live: 1, deleted: 0 }],
    ["in the trash", true, { live: 0, deleted: 1 }],
  ] as const)(
    "%s: 409 member_owns_artifacts with counts, nothing changed",
    async (_, deleted, want) => {
      const u = await fullyLoaded();
      await art(u.userId, u.userId, deleted);
      const before = await userRow(u.userId);
      const r = await erase(u.userId, admin.cookie);
      expect(r.status).toBe(409);
      const e = await errOf(r);
      expect(e.code).toBe("member_owns_artifacts");
      expect(MemberOwnsArtifactsDetailsSchema.parse(e.details)).toEqual(want);
      expect(await userRow(u.userId)).toEqual(before);
      expect(await leftovers(u.userId, u.email)).toEqual(ALL);
      expect(await erasedAudits(u.userId)).toEqual([]);
    },
  );
});

/**
 * `env` whose next DB.batch first runs `race` (on the real env): something
 * that commits between erase's prechecks and its batch.
 */
function racing(race: () => Promise<unknown>): Env {
  let fired = false;
  const db = new Proxy(env.DB, {
    get(t, k) {
      if (k === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await race();
          }
          return t.batch(stmts);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...(env as object), DB: db } as Env;
}

describe("races: each rule is re-checked inside the batch", () => {
  /** A directory-removed member with a Google link, as sync leaves them. */
  async function syncRemoved() {
    const u = await fullyLoaded();
    await env.DB.prepare("update users set removed_by_sync = 1 where id = ?")
      .bind(u.userId)
      .run();
    return u;
  }

  it("a sync revive commits first: 409 member_active, nothing wiped", async () => {
    const u = await syncRemoved();
    const E = racing(() => reviveFromSync(env, u.userId, u.sub, u.email));
    await expect(
      eraseMember(E, u.userId, await adminMember()),
    ).rejects.toMatchObject({ code: "member_active" });
    expect(await userRow(u.userId)).toMatchObject({
      status: "active",
      email: u.email,
      erased_at: null,
    });
    // Their memberships, credentials rows and shares are untouched.
    expect(await leftovers(u.userId, u.email)).toEqual(ALL);
    expect(await personalName(u.userId)).toBe(u.email.split("@")[0]);
    expect(await erasedAudits(u.userId)).toEqual([]);
  });

  it("erase commits first: the revive changes nothing, the row stays erased", async () => {
    const u = await syncRemoved();
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    const erased = await userRow(u.userId);
    expect(await reviveFromSync(env, u.userId, u.sub, u.email)).toBe(false);
    expect(await userRow(u.userId)).toEqual(erased);
  });

  it("an artifact lands in their personal space first: 409 member_owns_artifacts, nothing wiped", async () => {
    const u = await fullyLoaded();
    const before = await userRow(u.userId);
    const E = racing(() => art(u.userId, u.userId, true));
    await expect(
      eraseMember(E, u.userId, await adminMember()),
    ).rejects.toMatchObject({
      code: "member_owns_artifacts",
      details: { live: 0, deleted: 1 },
    });
    expect(await userRow(u.userId)).toEqual(before);
    expect(await leftovers(u.userId, u.email)).toEqual(ALL);
  });

  it("a promotion to admin lands first: 403 owner_only for an admin, nothing wiped", async () => {
    const u = await fullyLoaded();
    const E = racing(() =>
      env.DB.prepare("update users set role = 'admin' where id = ?")
        .bind(u.userId)
        .run(),
    );
    await expect(
      eraseMember(E, u.userId, await adminMember()),
    ).rejects.toMatchObject({ code: "owner_only" });
    expect(await leftovers(u.userId, u.email)).toEqual(ALL);
    expect((await userRow(u.userId))?.erased_at).toBeNull();
  });

  it("another erase lands first: 204, one audit row", async () => {
    const u = await removed();
    const me = await adminMember();
    const E = racing(() => eraseMember(env, u.userId, me));
    await eraseMember(E, u.userId, me);
    expect(await erasedAudits(u.userId)).toHaveLength(1);
  });

  it("an invite of the address before erase is 409 member_removed; after erase it makes a new person with nothing of theirs", async () => {
    const u = await fullyLoaded();
    const invite = () =>
      call(OFF, R.members, admin.cookie, {
        method: "POST",
        body: { email: u.email, role: "member" },
      });
    const first = await invite();
    expect(first.status).toBe(409);
    expect((await errOf(first)).code).toBe("member_removed");
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    const second = await invite();
    expect(second.status).toBe(201);
    const fresh = MemberSchema.parse(await second.json()).id;
    expect(fresh).not.toBe(u.userId);
    expect(await leftovers(fresh, u.email)).toMatchObject({
      sharesTo: 0,
      spaceMembers: 0,
      tokens: 0,
      googleIdentity: 0,
    });
    // The old row is untouched by the invite.
    expect(await userRow(u.userId)).toMatchObject({
      email: placeholder(u.userId),
      status: "removed",
    });
  });
});

describe("directory sync after erase", () => {
  const D = direct();
  const gu = (id: string, primaryEmail: string): GoogleUser => ({
    id,
    primaryEmail,
    suspended: false,
    deleted: false,
    isAdmin: false,
    customerId: "C0123",
  });
  /** Directory sync's listing of one page (bindPage, then applyUsers). */
  const list = async (u: GoogleUser) => {
    await bindPage(D, [u], { tenant: "a.com", allowEmail: false });
    await applyUsers(D, [u], { tenant: "a.com" });
  };
  const idsAt = (email: string) =>
    env.DB.prepare("select id from users where email = ?")
      .bind(email)
      .all<{ id: string }>()
      .then((r) => r.results.map((x) => x.id));

  it.each([
    ["an admin's removal", false],
    ["a directory removal", true],
  ] as const)(
    "%s: the same Google account still listed active is blocked, as a new row or a revive, until the link is reset",
    async (_, bySync) => {
      const email = uniq("er-sync", "a.com").toLowerCase();
      const sub = `g-er-sync-${newId()}`;
      const u = await login(email, "member");
      await linkGoogle(sub, u.userId);
      if (bySync)
        await setUserStatus(
          env,
          u.userId,
          "removed",
          "directory_delete",
          SYSTEM_ACTOR,
        );
      else expect((await remove(u.userId, admin.cookie)).status).toBe(204);
      expect((await erase(u.userId, admin.cookie)).status).toBe(204);
      const erased = await userRow(u.userId);
      await list(gu(sub, email));
      await list(gu(sub, email));
      expect(await idsAt(email)).toEqual([]);
      expect(await userRow(u.userId)).toEqual(erased);
      expect(
        await count(
          "select count(*) n from identities where provider = 'google' and subject = ?",
          sub,
        ),
      ).toBe(1);
    },
  );

  it("a different Google account at the same address gets a fresh row with none of theirs", async () => {
    const u = await fullyLoaded();
    expect((await erase(u.userId, admin.cookie)).status).toBe(204);
    const newSub = `g-er-new-${newId()}`;
    await list(gu(newSub, u.email));
    const ids = await idsAt(u.email);
    expect(ids).toHaveLength(1);
    const fresh = ids[0] ?? "";
    expect(fresh).not.toBe(u.userId);
    expect(await leftovers(fresh, u.email)).toEqual({
      ...NONE,
      googleIdentity: 1,
    });
    expect(
      await one(
        "select user_id from identities where provider = 'google' and subject = ?",
        newSub,
      ),
    ).toEqual({ user_id: fresh });
    // The erased row keeps its own identity and stays erased.
    expect(await userRow(u.userId)).toMatchObject({
      email: placeholder(u.userId),
      status: "removed",
    });
  });
});

describe("Google sign-in after erase, and the way back (reset the Google link)", () => {
  const SESSION = sessionCookieName(env);
  const D = direct();
  const raw = (path: string, cookie: string | null) =>
    fetchAndWait(
      app,
      new Request(`http://app.localhost${path}`, {
        redirect: "manual",
        headers: {
          "x-oa-request": "1",
          "sec-fetch-site": "same-origin",
          ...(cookie ? { cookie } : {}),
        },
      }),
      D,
    );
  /** A full Google sign-in by subject `sub-<email>` (the fake Google). */
  async function googleSignIn(g: FakeGoogle, email: string) {
    const start = await raw(`${AUTH.loginGoogle}?next=/a/x`, null);
    expect(start.status).toBe(302);
    const u = new URL(start.headers.get("location") ?? "");
    const state =
      start.headers
        .getSetCookie()
        .find((c) => /oa_oidc_/.test(c))
        ?.split(";")[0] ?? "";
    const code = g.issueCode(
      { nonce: u.searchParams.get("nonce"), email, sub: `sub-${email}` },
      u.searchParams.get("code_challenge") as string,
    );
    const r = await raw(
      `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
      state,
    );
    const admitted =
      r.headers.get("location") === "/a/x" &&
      r.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${SESSION}=`) && !/Max-Age=0/i.test(c));
    return admitted;
  }
  const idsAt = (email: string) =>
    env.DB.prepare("select id from users where email = ?")
      .bind(email)
      .all<{ id: string }>()
      .then((r) => r.results.map((x) => x.id));
  const resetLink = (id: string, who: U) =>
    call(D, R.memberIdentity(id, "google"), who.cookie, { method: "DELETE" });

  /** A person who signed in with Google, then was removed and erased. */
  async function erasedGoogleUser(g: FakeGoogle) {
    const email = uniq("er-g", "a.com").toLowerCase();
    expect(await googleSignIn(g, email)).toBe(true);
    const [id] = await idsAt(email);
    if (!id) throw new Error("no row");
    expect((await remove(id, admin.cookie, D)).status).toBe(204);
    expect((await erase(id, admin.cookie, D)).status).toBe(204);
    return { email, id };
  }

  it("the kept link refuses that Google account on sign-in; no new row at the address", async () => {
    const g = await fakeGoogle();
    const { email, id } = await erasedGoogleUser(g);
    expect(await googleSignIn(g, email)).toBe(false);
    expect(await idsAt(email)).toEqual([]);
    expect(await userRow(id)).toMatchObject({
      email: placeholder(id),
      status: "removed",
    });
  });

  it("an admin resets the erased row's Google link: the next Google sign-in makes a new, empty row; the erased row stays erased", async () => {
    const g = await fakeGoogle();
    const { email, id } = await erasedGoogleUser(g);
    const before = await userRow(id);
    expect((await resetLink(id, admin)).status).toBe(204);
    const after = await userRow(id);
    // Still erased: placeholder, erased_at, and no relink flag that could
    // ever bind the address back to this row.
    expect(after).toMatchObject({
      email: placeholder(id),
      status: "removed",
      name: "",
      erased_at: before?.erased_at,
      google_relink: 0,
    });
    expect(
      await count("select count(*) n from identities where user_id = ?", id),
    ).toBe(0);
    expect(await googleSignIn(g, email)).toBe(true);
    const ids = await idsAt(email);
    expect(ids).toHaveLength(1);
    const fresh = ids[0] ?? "";
    expect(fresh).not.toBe(id);
    expect(await leftovers(fresh, email)).toEqual({
      ...NONE,
      googleIdentity: 1,
    });
    expect(
      await count(
        "select count(*) n from artifacts where owner_id = ? or space_id = ?",
        fresh,
        fresh,
      ),
    ).toBe(0);
    expect(await userRow(id)).toEqual(after);
  });

  it("after a reset, the next sync listing that Google user makes a new row too", async () => {
    const g = await fakeGoogle();
    const { email, id } = await erasedGoogleUser(g);
    expect((await resetLink(id, owner)).status).toBe(204);
    const gu: GoogleUser = {
      id: `sub-${email}`,
      primaryEmail: email,
      suspended: false,
      deleted: false,
      isAdmin: false,
      customerId: "C0123",
    };
    await bindPage(D, [gu], { tenant: "a.com", allowEmail: false });
    await applyUsers(D, [gu], { tenant: "a.com" });
    const ids = await idsAt(email);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(id);
    expect(
      await one(
        "select user_id from identities where provider = 'google' and subject = ?",
        `sub-${email}`,
      ),
    ).toEqual({ user_id: ids[0] });
    expect(await userRow(id)).toMatchObject({
      email: placeholder(id),
      status: "removed",
      google_relink: 0,
    });
  });
});
