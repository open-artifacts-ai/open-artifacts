// P3 T14: applying directory state by identity (never by email). Group diffs
// recompute synced space roles and restriction flags; users are matched only
// through identities('google', id); a recycled address never inherits
// anything; sign-in refreshes one user's groups.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGroupDiff } from "../src/directory/apply.js";
import { SignInRefused } from "../src/directory/signin.js";
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { onGoogleSignIn, SYNC_DO_NAME } from "../src/services/directory.js";
import { getUser } from "../src/services/users.js";
import { mailer, seedShare, seedUser, uniq } from "./auth-helpers.js";
import {
  connect,
  directEnv,
  registerInstall,
  resetDirectory,
} from "./directory-helpers.js";
import {
  type FakeDirectory,
  fakeDirectory,
} from "./fixtures/fake-directory.js";
import { login } from "./helpers.js";

const MIN = 60_000;
const SYNC = { kind: "sync", id: null } as const;
let g: FakeDirectory;
let e: Env;
let owner: { cookie: string; userId: string; email: string };
let adminSub: string;

const stub = () => {
  const ns = env.DIRECTORY_SYNC as NonNullable<Env["DIRECTORY_SYNC"]>;
  return ns.get(
    ns.idFromName(SYNC_DO_NAME),
  ) as unknown as DurableObjectStub<DirectorySync>;
};
const inDo = <T>(f: (s: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stub(), (_i, s) => f(s));
async function drain(now: number) {
  for (let i = 0; i < 80; i++) {
    await inDo((s) => new SyncEngine(e, s.storage).alarm(now));
    if (!(await inDo((s) => new SyncEngine(e, s.storage).due(now)))) return;
  }
  throw new Error("run never finished");
}

const one = <T>(q: string, ...a: unknown[]) =>
  env.DB.prepare(q)
    .bind(...a)
    .first<T>();
const all = async <T>(q: string, ...a: unknown[]) =>
  (
    await env.DB.prepare(q)
      .bind(...a)
      .all<T>()
  ).results;

const userByIdentity = async (sub: string) =>
  one<{ id: string; email: string; status: string }>(
    `select u.id, u.email, u.status from identities i join users u on u.id = i.user_id
     where i.provider = 'google' and i.subject = ?`,
    sub,
  );
const sharesFor = (email: string) =>
  all<{ artifact_id: string }>(
    "select artifact_id from shares where email = ?",
    email,
  );
const listMine = (uid: string) =>
  all<{ id: string }>("select id from artifacts where space_id = ?", uid);
const spaceRolesOf = (uid: string) =>
  all<{ space_id: string; role: string; source: string }>(
    "select space_id, role, source from space_members where user_id = ? order by space_id, source",
    uid,
  );
const syncRole = async (space: string, uid: string) =>
  (
    await one<{ role: string }>(
      "select role from space_members where space_id = ? and user_id = ? and source = 'sync'",
      space,
      uid,
    )
  )?.role ?? null;
const restrictedSync = async (uid: string) =>
  (
    await one<{ r: number }>(
      "select restricted_sync r from users where id = ?",
      uid,
    )
  )?.r;
const statusOf = async (uid: string) =>
  (await one<{ status: string }>("select status from users where id = ?", uid))
    ?.status;
/** When the user's UserPresence recorded a revocation (0: never). */
const revokedAt = async (uid: string) => {
  const ns = env.USER_PRESENCE as NonNullable<Env["USER_PRESENCE"]>;
  const v = await runInDurableObject(ns.get(ns.idFromName(uid)), (_i, s) => {
    try {
      return s.storage.sql
        .exec("select revoked_at from state where id = 1")
        .toArray()[0]?.revoked_at;
    } catch {
      return 0;
    }
  });
  return Number(v ?? 0);
};

async function sharedSpace(): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, ?)",
  )
    .bind(id, `s-${id}`, Date.now())
    .run();
  return id;
}
async function group(id = `grp-${crypto.randomUUID()}`) {
  await env.DB.prepare(
    "insert or ignore into directory_groups (group_id, email) values (?, ?)",
  )
    .bind(id, `${id}@a.com`)
    .run();
  return id;
}
const mapSpace = (space: string, gid: string, role: string) =>
  env.DB.prepare(
    "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, ?)",
  )
    .bind(space, gid, `${gid}@a.com`, role)
    .run();
const mapOrg = (gid: string, role: string) =>
  env.DB.prepare(
    "insert into org_group_mappings (group_id, group_email, role) values (?, ?, ?)",
  )
    .bind(gid, `${gid}@a.com`, role)
    .run();
const restrict = (gid: string) =>
  env.DB.prepare(
    "insert into restricted_groups (group_id, group_email, created_at) values (?, ?, ?)",
  )
    .bind(gid, `${gid}@a.com`, Date.now())
    .run();

beforeEach(async () => {
  await resetDirectory();
  await env.DB.batch([
    env.DB.prepare("delete from org_group_mappings"),
    env.DB.prepare("delete from group_mappings"),
    env.DB.prepare("delete from restricted_groups"),
    env.DB.prepare("delete from directory_members"),
    env.DB.prepare("delete from directory_groups"),
  ]);
  await inDo(async (s) => {
    for (const t of ["kv", "seen", "dirty", "held"])
      s.storage.sql.exec(`delete from ${t}`);
    await s.storage.deleteAlarm();
  });
  await registerInstall();
  g = fakeDirectory();
  e = directEnv(mailer().env);
  const email = uniq("apply-owner");
  owner = { ...(await login(email, "owner")), email };
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

async function connected(t0: number) {
  const r = await connect(e, owner.cookie, g, { sub: adminSub });
  expect(r.ok).toBe(true);
  await drain(t0);
}

describe("applyGroupDiff", () => {
  it("two groups → max role; removal from one keeps the other, no revoke", async () => {
    const s = await sharedSpace();
    const [ga, gb] = [await group(), await group()];
    await mapSpace(s, ga, "viewer");
    await mapSpace(s, gb, "editor");
    const u = await seedUser(uniq("two"), "member");
    await applyGroupDiff(env, ga, [u], [], SYNC);
    expect(await syncRole(s, u)).toBe("viewer");
    await applyGroupDiff(env, gb, [u], [], SYNC);
    expect(await syncRole(s, u)).toBe("editor");
    const out = await applyGroupDiff(env, ga, [], [u], SYNC);
    expect(out.narrowed).toEqual([]);
    expect(await syncRole(s, u)).toBe("editor");
    expect(await revokedAt(u)).toBe(0);
    // Then the editor group goes too: the row is gone and the user narrowed.
    const out2 = await applyGroupDiff(env, gb, [], [u], SYNC);
    expect(out2.narrowed).toEqual([u]);
    expect(await syncRole(s, u)).toBeNull();
    expect(await revokedAt(u)).toBeGreaterThan(0);
  });

  it("an Every-space group writes directory_members only, no space_members rows, and nothing for personal spaces", async () => {
    const go = await group();
    await mapOrg(go, "editor");
    const u = await seedUser(uniq("every"), "member");
    await applyGroupDiff(env, go, [u], [], SYNC);
    expect(
      await all(
        "select 1 from directory_members where group_id = ? and user_id = ?",
        go,
        u,
      ),
    ).toHaveLength(1);
    expect(await spaceRolesOf(u)).toEqual([]);
  });

  it("removal from an Every-space group narrows that user", async () => {
    const go = await group();
    await mapOrg(go, "viewer");
    const [u, v] = [
      await seedUser(uniq("everyr"), "member"),
      await seedUser(uniq("everyk"), "member"),
    ];
    await applyGroupDiff(env, go, [u, v], [], SYNC);
    const out = await applyGroupDiff(env, go, [], [u], SYNC);
    expect(out.narrowed).toEqual([u]);
    expect(await revokedAt(u)).toBeGreaterThan(0);
    expect(await revokedAt(v)).toBe(0);
  });

  it("restricted group membership (by groupId) sets users.restricted_sync and caps", async () => {
    const gr = await group();
    await restrict(gr);
    const u = await seedUser(uniq("restr"), "member");
    await applyGroupDiff(env, gr, [u], [], SYNC);
    expect(await restrictedSync(u)).toBe(1);
    expect(await revokedAt(u)).toBeGreaterThan(0);
    await applyGroupDiff(env, gr, [], [u], SYNC);
    expect(await restrictedSync(u)).toBe(0);
  });

  it("an owner or admin in a restricted group is skipped and logged", async () => {
    const gr = await group();
    await restrict(gr);
    const a = await seedUser(uniq("radmin"), "admin");
    await applyGroupDiff(env, gr, [a, owner.userId], [], SYNC);
    expect(await restrictedSync(a)).toBe(0);
    expect(await restrictedSync(owner.userId)).toBe(0);
    const rows = await all<{ target_id: string; detail: string }>(
      "select target_id, detail from audit_events where action = 'directory.sync' and target_type = 'user' and target_id in (?, ?)",
      a,
      owner.userId,
    );
    expect(rows.map((r) => r.target_id).sort()).toEqual(
      [a, owner.userId].sort(),
    );
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toMatchObject({
      skipped: "restrict_admin",
      groupId: gr,
    });
  });
});

describe("users by identity", () => {
  it("recycled email: new Bob gets a new row and an empty personal space, no shares, no memberships", async () => {
    const bob = uniq("bob");
    const oldSub = `g-oldbob-${crypto.randomUUID()}`;
    g.addUser({ id: oldSub, primaryEmail: bob });
    const s = await sharedSpace();
    const gid = `grp-bob-${crypto.randomUUID()}`;
    g.addGroup({ id: gid, email: `${gid}@a.com`, members: [oldSub] });
    await group(gid);
    await mapSpace(s, gid, "editor");
    const t0 = Date.now();
    await connected(t0);
    const oldBob = await userByIdentity(oldSub);
    expect(oldBob?.email).toBe(bob);
    expect(await syncRole(s, oldBob?.id as string)).toBe("editor");
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'manual', ?)",
    )
      .bind(s, oldBob?.id, Date.now())
      .run();
    await seedShare(bob);
    // Old Bob deleted in Google; a new Bob gets the address.
    (g.users.get(oldSub) as { deleted?: boolean }).deleted = true;
    g.removeMember(gid, oldSub);
    g.addUser({ id: "g-new", primaryEmail: bob });
    await drain(t0 + 61 * MIN);
    const nb = await userByIdentity("g-new");
    expect(nb?.id).toBeDefined();
    expect(nb?.id).not.toBe(oldBob?.id);
    expect(nb?.email).toBe(bob);
    expect(await sharesFor(bob)).toEqual([]);
    expect(await listMine(nb?.id as string)).toEqual([]);
    expect(await spaceRolesOf(nb?.id as string)).toEqual([]);
    // The old row got the deletion treatment.
    const ob = await one<{ email: string; status: string }>(
      "select email, status from users where id = ?",
      oldBob?.id,
    );
    expect(ob).toEqual({
      email: `removed+${oldBob?.id}@invalid`,
      status: "removed",
    });
    expect(await spaceRolesOf(oldBob?.id as string)).toEqual([]);
    expect(
      await one(
        "select id from spaces where id = ? and kind = 'personal'",
        nb?.id,
      ),
    ).not.toBeNull();
    await env.DB.prepare(
      "delete from identities where subject = 'g-new'",
    ).run();
  });

  it("recycled email of a renamed user: the old row follows them, the address's shares are cut", async () => {
    const [bob, bob2] = [uniq("rbob"), uniq("rbob2")];
    const oldSub = `g-rbob-${crypto.randomUUID()}`;
    const newSub = `g-rnew-${crypto.randomUUID()}`;
    g.addUser({ id: oldSub, primaryEmail: bob });
    const t0 = Date.now();
    await connected(t0);
    const oldBob = (await userByIdentity(oldSub))?.id as string;
    const s = await sharedSpace();
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'manual', ?)",
    )
      .bind(s, oldBob, Date.now())
      .run();
    await seedShare(bob);
    Object.assign(g.users.get(oldSub) as object, { primaryEmail: bob2 });
    g.addUser({ id: newSub, primaryEmail: bob });
    await drain(t0 + 61 * MIN);
    expect(await userByIdentity(oldSub)).toEqual({
      id: oldBob,
      email: bob2,
      status: "active",
    });
    const nb = await userByIdentity(newSub);
    expect(nb?.email).toBe(bob);
    expect(nb?.id).not.toBe(oldBob);
    expect(await sharesFor(bob)).toEqual([]);
    expect(await spaceRolesOf(nb?.id as string)).toEqual([]);
    expect((await spaceRolesOf(oldBob)).map((r) => r.space_id)).toEqual([s]);
  });

  it("DELETE_USER: removed, placeholder email, shares and memberships gone, never the owner", async () => {
    const del = uniq("deluser");
    const sub = `g-del-${crypto.randomUUID()}`;
    g.addUser({ id: sub, primaryEmail: del });
    const t0 = Date.now();
    await connected(t0);
    const u = (await userByIdentity(sub))?.id as string;
    const s = await sharedSpace();
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', ?)",
    )
      .bind(s, u, Date.now())
      .run();
    await seedShare(del);
    // The owner linked to a directory id that is also deleted: never removed.
    const ownerSub = `g-owner-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(ownerSub, owner.userId, Date.now())
      .run();
    g.addUser({ id: ownerSub, primaryEmail: owner.email, deleted: true });
    (g.users.get(sub) as { deleted?: boolean }).deleted = true;
    g.activity("admin", "DELETE_USER", { USER_EMAIL: del });
    await drain(t0 + 2 * MIN);
    expect(await statusOf(u)).toBe("removed");
    expect(
      (await one<{ email: string }>("select email from users where id = ?", u))
        ?.email,
    ).toBe(`removed+${u}@invalid`);
    expect(await sharesFor(del)).toEqual([]);
    expect(await spaceRolesOf(u)).toEqual([]);
    expect(await revokedAt(u)).toBeGreaterThan(0);
    expect(await statusOf(owner.userId)).toBe("active");
    expect(
      (
        await one<{ email: string }>(
          "select email from users where id = ?",
          owner.userId,
        )
      )?.email,
    ).toBe(owner.email);
  });

  it("directory UNSUSPEND_USER sets status active, never revives a removed row", async () => {
    const [a, b] = [uniq("unsus"), uniq("unrem")];
    const [sa, sb] = [
      `g-us-${crypto.randomUUID()}`,
      `g-ur-${crypto.randomUUID()}`,
    ];
    g.addUser({ id: sa, primaryEmail: a });
    g.addUser({ id: sb, primaryEmail: b });
    const t0 = Date.now();
    await connected(t0);
    const ua = (await userByIdentity(sa))?.id as string;
    const ub = (await userByIdentity(sb))?.id as string;
    // Suspended in Google: the next reconcile applies it.
    (g.users.get(sa) as { suspended?: boolean }).suspended = true;
    await drain(t0 + 61 * MIN);
    expect(await statusOf(ua)).toBe("suspended");
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(ub)
      .run();
    (g.users.get(sa) as { suspended?: boolean }).suspended = false;
    const at = t0 + 62 * MIN;
    g.activity("admin", "UNSUSPEND_USER", { USER_EMAIL: a }, at);
    g.activity("admin", "UNSUSPEND_USER", { USER_EMAIL: b }, at);
    await drain(t0 + 63 * MIN);
    expect(await statusOf(ua)).toBe("active");
    expect(await statusOf(ub)).toBe("removed");
    const why = await one<{ detail: string }>(
      "select detail from audit_events where action = 'user.status' and target_id = ? order by at desc limit 1",
      ua,
    );
    expect(JSON.parse(why?.detail ?? "{}")).toMatchObject({
      status: "active",
      reason: "directory_unsuspend",
    });
  });

  it("RENAME_USER moves the address; shares follow only when the old address is an alias", async () => {
    const [a1, a2, b1, b2] = [
      uniq("ren-a"),
      uniq("ren-a2"),
      uniq("ren-b"),
      uniq("ren-b2"),
    ];
    const [sa, sb] = [
      `g-ra-${crypto.randomUUID()}`,
      `g-rb-${crypto.randomUUID()}`,
    ];
    g.addUser({ id: sa, primaryEmail: a1 });
    g.addUser({ id: sb, primaryEmail: b1 });
    const t0 = Date.now();
    await connected(t0);
    const artA = await seedShare(a1);
    const artB = await seedShare(b1);
    Object.assign(g.users.get(sa) as object, {
      primaryEmail: a2,
      aliases: [a1],
    });
    Object.assign(g.users.get(sb) as object, { primaryEmail: b2 });
    g.activity("admin", "RENAME_USER", { USER_EMAIL: a1, NEW_VALUE: a2 });
    g.activity("admin", "RENAME_USER", { USER_EMAIL: b1, NEW_VALUE: b2 });
    await drain(t0 + 2 * MIN);
    expect((await userByIdentity(sa))?.email).toBe(a2);
    expect((await userByIdentity(sb))?.email).toBe(b2);
    expect(await sharesFor(a2)).toEqual([{ artifact_id: artA }]);
    expect(await sharesFor(a1)).toEqual([]);
    expect(await sharesFor(b1)).toEqual([{ artifact_id: artB }]);
    expect(await sharesFor(b2)).toEqual([]);
  });
});

describe("onGoogleSignIn", () => {
  async function signedUp(tag: string) {
    const email = uniq(tag);
    const sub = `g-${tag}-${crypto.randomUUID()}`;
    g.addUser({ id: sub, primaryEmail: email });
    return { email, sub };
  }
  const member = async (sub: string) => {
    const id = (await userByIdentity(sub))?.id as string;
    const m = await getUser(env, id);
    if (!m) throw new Error("no member");
    return m;
  };

  it("sign-in group diff adds and removes for that user only", async () => {
    const me = await signedUp("si-me");
    const other = await signedUp("si-other");
    const s = await sharedSpace();
    const [gAdd, gDrop, gChild] = [
      `grp-add-${crypto.randomUUID()}`,
      `grp-drop-${crypto.randomUUID()}`,
      `grp-child-${crypto.randomUUID()}`,
    ];
    g.addGroup({ id: gAdd, email: `${gAdd}@a.com`, members: [other.sub] });
    g.addGroup({
      id: gDrop,
      email: `${gDrop}@a.com`,
      members: [me.sub, other.sub],
    });
    g.addGroup({ id: gChild, email: `${gChild}@a.com`, members: [] });
    for (const x of [gAdd, gDrop]) {
      await group(x);
      await mapSpace(s, x, x === gAdd ? "editor" : "viewer");
    }
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    const o = (await userByIdentity(other.sub))?.id as string;
    expect(await syncRole(s, u.id)).toBe("viewer");
    // Google now: me joins gAdd through a nested child group, leaves gDrop.
    g.addMember(gAdd, gChild);
    g.addMember(gChild, me.sub);
    await env.DB.prepare(
      "insert into directory_groups (group_id, email, parent_ids) values (?, ?, json_array(?))",
    )
      .bind(gChild, `${gChild}@a.com`, gAdd)
      .run();
    g.removeMember(gDrop, me.sub);
    g.removeMember(gDrop, other.sub);
    await onGoogleSignIn(e, u);
    expect(
      (
        await all<{ group_id: string }>(
          "select group_id from directory_members where user_id = ?",
          u.id,
        )
      ).map((r) => r.group_id),
    ).toEqual([gAdd]);
    expect(await syncRole(s, u.id)).toBe("editor");
    // The other user's rows are untouched (only the reconcile changes them).
    expect(
      (
        await all<{ group_id: string }>(
          "select group_id from directory_members where user_id = ? order by group_id",
          o,
        )
      ).map((r) => r.group_id),
    ).toEqual([gAdd, gDrop].sort());
  });

  it("asserts Google sub == directory user id; suspended in Google refuses", async () => {
    const me = await signedUp("si-susp");
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    (g.users.get(me.sub) as { suspended?: boolean }).suspended = true;
    await expect(onGoogleSignIn(e, u)).rejects.toBeInstanceOf(SignInRefused);
    expect(await statusOf(u.id)).toBe("suspended");
    expect(g.adminCalls).toContain(`/users/${me.sub}`);
  });

  it("Google unreachable: proceeds (fail static), unless customer_mismatch", async () => {
    const me = await signedUp("si-down");
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    g.fail(new RegExp(`/users/${me.sub}`), 503, { times: 2 });
    await expect(onGoogleSignIn(e, u)).resolves.toBeUndefined();
    await env.DB.prepare(
      "insert or replace into directory_state (key, value) values ('sync.state', 'customer_mismatch')",
    ).run();
    await expect(onGoogleSignIn(e, u)).rejects.toBeInstanceOf(SignInRefused);
  });
});
