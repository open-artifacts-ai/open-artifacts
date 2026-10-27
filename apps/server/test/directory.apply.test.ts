// P3 T14: applying directory state by identity (never by email). Group diffs
// recompute synced space roles and restriction flags; users are matched only
// through identities('google', id); a recycled address never inherits
// anything; sign-in refreshes one user's groups.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Member, newId } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCap } from "../src/auth/authz.js";
import { authConfig } from "../src/auth/config.js";
import {
  applyGroupDiff,
  applyUsers,
  DIFF_CHUNK,
} from "../src/directory/apply.js";
import type { GoogleUser } from "../src/directory/google.js";
import { SignInRefused } from "../src/directory/signin.js";
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { onGoogleSignIn, SYNC_DO_NAME } from "../src/services/directory.js";
import { admit, resetIdentity } from "../src/services/identity.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, seedShare, seedUser, uniq } from "./auth-helpers.js";
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
/**
 * Alarms at `now` until no lane may run (done, or backing off). One DO call
 * for the whole loop, a fresh engine per alarm (as the DO builds one): two
 * round-trips per alarm made directory.sync time out under suite load (#617).
 */
async function drain(now: number) {
  const done = await inDo(async (s) => {
    for (let i = 0; i < 80; i++) {
      await new SyncEngine(e, s.storage).alarm(now);
      if (!new SyncEngine(e, s.storage).due(now)) return true;
    }
    return false;
  });
  if (!done) throw new Error("run never finished");
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

  it("RENAME_USER: shares follow the person, alias or not (the higher role on a conflict); a later user at the old address gets none", async () => {
    const [a1, a2] = [uniq("ren-a"), uniq("ren-a2")];
    const sa = `g-ra-${crypto.randomUUID()}`;
    g.addUser({ id: sa, primaryEmail: a1 });
    const t0 = Date.now();
    await connected(t0);
    const ua = (await userByIdentity(sa))?.id as string;
    const artA = await seedShare(a1);
    // One artifact shared to both addresses: editor on the old, viewer on the new.
    const artX = await seedShare(a2);
    await env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) select artifact_id, ?, 'editor', created_by, created_at from shares where artifact_id = ?",
    )
      .bind(a1, artX)
      .run();
    // Renamed without keeping the old address as an alias.
    Object.assign(g.users.get(sa) as object, { primaryEmail: a2 });
    g.activity("admin", "RENAME_USER", { USER_EMAIL: a1, NEW_VALUE: a2 });
    await drain(t0 + 2 * MIN);
    expect((await userByIdentity(sa))?.email).toBe(a2);
    expect(await sharesFor(a1)).toEqual([]);
    expect((await sharesFor(a2)).map((r) => r.artifact_id).sort()).toEqual(
      [artA, artX].sort(),
    );
    expect(
      (
        await one<{ role: string }>(
          "select role from shares where artifact_id = ? and email = ?",
          artX,
          a2,
        )
      )?.role,
    ).toBe("editor");
    // A later pass: someone new gets the old address.
    const nsub = `g-ren-new-${crypto.randomUUID()}`;
    g.addUser({ id: nsub, primaryEmail: a1 });
    await drain(t0 + 61 * MIN);
    const nu = await userByIdentity(nsub);
    expect(nu?.email).toBe(a1);
    expect(nu?.id).not.toBe(ua);
    expect(await sharesFor(a1)).toEqual([]);
    expect(await sharesFor(a2)).toHaveLength(2);
  });

  it("a recycled address held by a removed row whose user was renamed: deletion treatment, then the new row", async () => {
    const [x, x2] = [uniq("rmx"), uniq("rmx2")];
    const oldSub = `g-rmx-${crypto.randomUUID()}`;
    g.addUser({ id: oldSub, primaryEmail: x });
    const t0 = Date.now();
    await connected(t0);
    const old = (await userByIdentity(oldSub))?.id as string;
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(old)
      .run();
    await seedShare(x);
    Object.assign(g.users.get(oldSub) as object, { primaryEmail: x2 });
    const nsub = `g-rmx-new-${crypto.randomUUID()}`;
    g.addUser({ id: nsub, primaryEmail: x });
    await drain(t0 + 61 * MIN);
    expect(await userByIdentity(oldSub)).toEqual({
      id: old,
      email: `removed+${old}@invalid`,
      status: "removed",
    });
    expect((await userByIdentity(nsub))?.email).toBe(x);
    expect(await sharesFor(x)).toEqual([]);
  });

  it("same page, new holder listed before the renamed old user: the new holder's shares stay on the address", async () => {
    const [bob, bob2] = [uniq("pg-bob"), uniq("pg-bob2")];
    const oldSub = `g-pg-old-${crypto.randomUUID()}`;
    const newSub = `g-pg-new-${crypto.randomUUID()}`;
    const old = await seedUser(bob, "member", { googleSub: oldSub });
    const oldArt = await seedShare(bob);
    let newArt: string | null = null;
    // Someone shares with the new holder once their row exists (mid-page).
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return async (ss: D1PreparedStatement[]) => {
            const out = await t.batch(ss);
            if (!newArt && (await userByIdentity(newSub)))
              newArt = await seedShare(bob);
            return out;
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const en = { ...e, DB } as Env;
    const gu = (id: string, primaryEmail: string): GoogleUser => ({
      id,
      primaryEmail,
      suspended: false,
      deleted: false,
      isAdmin: false,
      customerId: "C0123",
    });
    const renamed = gu(oldSub, bob2);
    // One page, read once: new Bob first, then old Bob (stale address).
    await applyUsers(en, [gu(newSub, bob), renamed], {
      tenant: "a.com",
      lookup: async () => renamed,
    });
    expect((await userByIdentity(oldSub))?.email).toBe(bob2);
    expect((await userByIdentity(newSub))?.email).toBe(bob);
    expect(newArt).not.toBeNull();
    expect(await sharesFor(bob)).toEqual([{ artifact_id: newArt }]);
    expect(await sharesFor(bob2)).toEqual([{ artifact_id: oldArt }]);
    expect(old).toBe((await userByIdentity(oldSub))?.id);
  });

  it("the recycled-address lookup checks the customer: another customer's user fails closed", async () => {
    const y = uniq("cust");
    const oldSub = `g-cust-${crypto.randomUUID()}`;
    g.addUser({ id: oldSub, primaryEmail: y });
    const t0 = Date.now();
    await connected(t0);
    const old = (await userByIdentity(oldSub))?.id as string;
    // users.get on the old id now answers for another customer.
    Object.assign(g.users.get(oldSub) as object, {
      primaryEmail: uniq("cust2"),
      customerId: "C-other",
    });
    const nsub = `g-cust-new-${crypto.randomUUID()}`;
    g.addUser({ id: nsub, primaryEmail: y });
    await drain(t0 + 61 * MIN);
    expect(
      (
        await one<{ value: string }>(
          "select value from directory_state where key = 'sync.state'",
        )
      )?.value,
    ).toBe("customer_mismatch");
    expect(await userByIdentity(oldSub)).toEqual({
      id: old,
      email: y,
      status: "active",
    });
    expect(await userByIdentity(nsub)).toBeNull();
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
  const setMismatch = () =>
    env.DB.prepare(
      "insert or replace into directory_state (key, value) values ('sync.state', 'customer_mismatch')",
    ).run();
  /** `e` with a DB whose batch, or prepare of matching SQL, throws. */
  const brokenDb = (o: { batch?: boolean; sql?: RegExp }): Env => {
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch" && o.batch)
          return async () => {
            throw new Error("D1 down");
          };
        if (p === "prepare" && o.sql) {
          const re = o.sql;
          return (q: string) => {
            if (re.test(q)) throw new Error("D1 down");
            return t.prepare(q);
          };
        }
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { ...e, DB } as Env;
  };
  /** The owner, bound to a directory user in a mapped group they aren't synced into. */
  async function boundOwner(customerId?: string) {
    const ownerSub = `g-owner-${crypto.randomUUID()}`;
    g.addUser({
      id: ownerSub,
      primaryEmail: owner.email,
      ...(customerId ? { customerId } : {}),
    });
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(ownerSub, owner.userId, Date.now())
      .run();
    const gid = `grp-own-${crypto.randomUUID()}`;
    g.addGroup({ id: gid, email: `${gid}@a.com`, members: [ownerSub] });
    await group(gid);
    await mapOrg(gid, "viewer");
    const m = await getUser(env, owner.userId);
    if (!m) throw new Error("no owner");
    return m;
  }
  const groupsOf = async (uid: string) =>
    (
      await all<{ group_id: string }>(
        "select group_id from directory_members where user_id = ?",
        uid,
      )
    ).map((r) => r.group_id);

  it("the owner gets in during customer_mismatch with Google reachable, without a group diff", async () => {
    const t0 = Date.now();
    await connected(t0);
    const m = await boundOwner();
    await env.DB.prepare("delete from directory_members").run();
    await setMismatch();
    await expect(onGoogleSignIn(e, m)).resolves.toBeUndefined();
    expect(await groupsOf(owner.userId)).toEqual([]);
  });

  it("the owner gets in when Google answers for another customer, without a group diff", async () => {
    const t0 = Date.now();
    await connected(t0);
    const m = await boundOwner("C-other");
    await env.DB.prepare("delete from directory_members").run();
    await expect(onGoogleSignIn(e, m)).resolves.toBeUndefined();
    expect(await groupsOf(owner.userId)).toEqual([]);
  });

  it("suspended in Google: refused even when the suspension write fails", async () => {
    const me = await signedUp("si-suspfail");
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    (g.users.get(me.sub) as { suspended?: boolean }).suspended = true;
    await expect(
      onGoogleSignIn(brokenDb({ batch: true }), u),
    ).rejects.toBeInstanceOf(SignInRefused);
    expect(await statusOf(u.id)).toBe("active");
  });

  it("during customer_mismatch any later failure refuses a non-owner", async () => {
    const me = await signedUp("si-mmfail");
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    await setMismatch();
    g.fail(/\/groups\?userKey/, 503);
    await expect(onGoogleSignIn(e, u)).rejects.toBeInstanceOf(SignInRefused);
  });

  it("a D1 error reading the binding or state refuses a non-owner; the owner proceeds", async () => {
    const me = await signedUp("si-d1");
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    const m = await boundOwner();
    const bad = brokenDb({ sql: /directory_state/ });
    await expect(onGoogleSignIn(bad, u)).rejects.toBeInstanceOf(SignInRefused);
    await expect(onGoogleSignIn(bad, m)).resolves.toBeUndefined();
    // Reading who this is fails too: refused.
    await expect(
      onGoogleSignIn(brokenDb({ sql: /from identities/ }), u),
    ).rejects.toBeInstanceOf(SignInRefused);
  });

  it("another customer's user in Google is refused even when userGroups would fail", async () => {
    const me = await signedUp("si-cust");
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    Object.assign(g.users.get(me.sub) as object, { customerId: "C-other" });
    g.fail(/\/groups\?userKey/, 503);
    await expect(onGoogleSignIn(e, u)).rejects.toBeInstanceOf(SignInRefused);
    expect(g.adminCalls).not.toContain("/groups");
  });

  it("hasMember failing writes no drops", async () => {
    const me = await signedUp("si-hm");
    const s = await sharedSpace();
    const gid = `grp-hm-${crypto.randomUUID()}`;
    g.addGroup({ id: gid, email: `${gid}@a.com`, members: [me.sub] });
    await group(gid);
    await mapSpace(s, gid, "editor");
    const t0 = Date.now();
    await connected(t0);
    const u = await member(me.sub);
    expect(await groupsOf(u.id)).toEqual([gid]);
    g.removeMember(gid, me.sub);
    g.fail(/\/hasMember\//, 503);
    await expect(onGoogleSignIn(e, u)).resolves.toBeUndefined();
    expect(await groupsOf(u.id)).toEqual([gid]);
    expect(await syncRole(s, u.id)).toBe("editor");
  });
});

describe("T14 security review", () => {
  const gu = (
    id: string,
    primaryEmail: string,
    o: Partial<GoogleUser> = {},
  ): GoogleUser => ({
    id,
    primaryEmail,
    suspended: false,
    deleted: false,
    isAdmin: false,
    customerId: "C0123",
    ...o,
  });

  it("sign-in drift moves the shares: A drifts, then C gets A's old address with zero shares", async () => {
    const [a1, a2] = [uniq("drift-a"), uniq("drift-a2")];
    const sa = `g-drift-a-${crypto.randomUUID()}`;
    const a = await seedUser(a1, "member", { googleSub: sa });
    const art = await seedShare(a1);
    const cfg = authConfig(direct());
    const r = await admit(env, cfg, {
      provider: "google",
      subject: sa,
      email: a2,
      name: null,
      tenant: "a.com",
    });
    expect(r.ok && r.user.id).toBe(a);
    expect(r.ok && r.user.email).toBe(a2);
    expect(await sharesFor(a2)).toEqual([{ artifact_id: art }]);
    const c = await admit(env, cfg, {
      provider: "google",
      subject: `g-drift-c-${crypto.randomUUID()}`,
      email: a1,
      name: null,
      tenant: "a.com",
    });
    expect(c.ok).toBe(true);
    expect(c.ok && c.user.id).not.toBe(a);
    expect(await sharesFor(a1)).toEqual([]);
    expect(await sharesFor(a2)).toEqual([{ artifact_id: art }]);
  });

  it("a group diff above the chunk size applies in several batches, removals included", async () => {
    const s = await sharedSpace();
    const gid = await group();
    await mapSpace(s, gid, "viewer");
    const n = DIFF_CHUNK + 5;
    const ids = Array.from({ length: n }, () => newId());
    await env.DB.prepare(
      `insert into users (id, email, name, role, created_at)
       select value, value || '@chunk.a.com', 'c', 'member', 0 from json_each(?)`,
    )
      .bind(JSON.stringify(ids))
      .run();
    let batches = 0;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return (ss: D1PreparedStatement[]) => {
            batches++;
            return t.batch(ss);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const en = { ...env, DB } as Env;
    const count = async (q: string) =>
      (await one<{ n: number }>(q, gid))?.n ?? 0;
    const add = await applyGroupDiff(en, gid, ids, [], SYNC);
    expect(add.narrowed).toEqual([]);
    expect(batches).toBe(2);
    expect(
      await count(
        "select count(*) n from directory_members where group_id = ?",
      ),
    ).toBe(n);
    expect(
      await count(
        "select count(*) n from space_members sm join group_mappings gm on gm.space_id = sm.space_id where gm.group_id = ? and sm.source = 'sync'",
      ),
    ).toBe(n);
    batches = 0;
    const rem = await applyGroupDiff(en, gid, [], ids, SYNC);
    expect(batches).toBe(2);
    expect(rem.narrowed.sort()).toEqual([...ids].sort());
    expect(
      await count(
        "select count(*) n from directory_members where group_id = ?",
      ),
    ).toBe(0);
  });

  it("deleted and suspended users apply by id even when their listed address is unusable", async () => {
    const [sd, ss] = [
      `g-bad-d-${crypto.randomUUID()}`,
      `g-bad-s-${crypto.randomUUID()}`,
    ];
    const d = await seedUser(uniq("bad-d"), "member", { googleSub: sd });
    const su = await seedUser(uniq("bad-s"), "member", { googleSub: ss });
    await applyUsers(
      e,
      [
        gu(sd, "not an address", { deleted: true }),
        gu(ss, "", { suspended: true }),
      ],
      { tenant: "a.com" },
    );
    expect(await statusOf(d)).toBe("removed");
    expect(await statusOf(su)).toBe("suspended");
  });

  it("an unlinked row at a new directory id's address: a pure invite is linked, a row with sign-in history is recycled", async () => {
    const [inv, used] = [uniq("inv"), uniq("used")];
    const invite = await seedUser(inv, "member");
    const signedIn = await seedUser(used, "member");
    await env.DB.prepare("update users set last_seen_at = ? where id = ?")
      .bind(Date.now(), signedIn)
      .run();
    const usedArt = await seedShare(used);
    const invArt = await seedShare(inv);
    const [si, su] = [
      `g-inv-${crypto.randomUUID()}`,
      `g-used-${crypto.randomUUID()}`,
    ];
    await applyUsers(e, [gu(si, inv), gu(su, used)], { tenant: "a.com" });
    // The invite became the directory user's row, with its invite.
    expect((await userByIdentity(si))?.id).toBe(invite);
    expect(await sharesFor(inv)).toEqual([{ artifact_id: invArt }]);
    // The used row got the deletion treatment; a new row took the address.
    expect(
      await one<{ email: string; status: string }>(
        "select email, status from users where id = ?",
        signedIn,
      ),
    ).toEqual({ email: `removed+${signedIn}@invalid`, status: "removed" });
    const nu = await userByIdentity(su);
    expect(nu?.email).toBe(used);
    expect(nu?.id).not.toBe(signedIn);
    expect(await sharesFor(used)).toEqual([]);
    expect(usedArt).toBeDefined();
  });
});

describe("P2 item 4: an admin's link reset is never a recycled address", () => {
  const gu = (id: string, primaryEmail: string): GoogleUser => ({
    id,
    primaryEmail,
    suspended: false,
    deleted: false,
    isAdmin: false,
    customerId: "C0123",
  });
  const actor = async () =>
    withCap((await getUser(e, owner.userId)) as Member, null);
  const relinkFlag = async (uid: string) =>
    (
      await one<{ f: number }>(
        "select google_relink f from users where id = ?",
        uid,
      )
    )?.f;

  it("reset, then sync: the same user is relinked by email and keeps their id, shares, spaces and artifacts", async () => {
    const bob = uniq("rsbob");
    const sub = `g-rsbob-${crypto.randomUUID()}`;
    g.addUser({ id: sub, primaryEmail: bob });
    const s = await sharedSpace();
    const gid = `grp-rs-${crypto.randomUUID()}`;
    g.addGroup({ id: gid, email: `${gid}@a.com`, members: [sub] });
    await group(gid);
    await mapSpace(s, gid, "editor");
    const t0 = Date.now();
    await connected(t0);
    const before = await userByIdentity(sub);
    const uid = before?.id as string;
    expect(uid).toBeDefined();
    // Signed in before (sign-in history: a recycled address without the fix).
    await env.DB.prepare("update users set last_seen_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();
    const manual = await sharedSpace();
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'manual', ?)",
    )
      .bind(manual, uid, Date.now())
      .run();
    const art = await seedShare(bob);
    const mine = newId();
    await env.DB.prepare(
      "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at) values (?, ?, ?, 't', 'html', 'private', 1, 1)",
    )
      .bind(mine, uid, uid)
      .run();
    const roles = await spaceRolesOf(uid);
    expect(roles).toHaveLength(2);

    await resetIdentity(e, await actor(), uid);
    expect(await userByIdentity(sub)).toBeNull();
    expect(await relinkFlag(uid)).toBe(1);

    // The next listing (Google still has the same person at the address).
    await drain(t0 + 61 * MIN);
    const after = await userByIdentity(sub);
    expect(after).toEqual({ id: uid, email: bob, status: "active" });
    expect(await relinkFlag(uid)).toBe(0);
    expect(await sharesFor(bob)).toEqual([{ artifact_id: art }]);
    expect(await spaceRolesOf(uid)).toEqual(roles);
    expect(await listMine(uid)).toEqual([{ id: mine }]);
    expect(
      await one<{ n: number }>(
        "select count(*) n from users where email = ?",
        bob,
      ),
    ).toEqual({ n: 1 });
  });

  it("a reset row is relinked to a new directory id at its address too (applyUsers), once", async () => {
    const addr = uniq("rsnew");
    const uid = await seedUser(addr, "member", { googleSub: `old-${newId()}` });
    await env.DB.prepare("update users set last_seen_at = ? where id = ?")
      .bind(Date.now(), uid)
      .run();
    const art = await seedShare(addr);
    await resetIdentity(e, await actor(), uid);
    const sub = `g-rsnew-${crypto.randomUUID()}`;
    await applyUsers(e, [gu(sub, addr)], { tenant: "a.com" });
    expect(await userByIdentity(sub)).toEqual({
      id: uid,
      email: addr,
      status: "active",
    });
    expect(await sharesFor(addr)).toEqual([{ artifact_id: art }]);
    expect(await relinkFlag(uid)).toBe(0);
  });

  it("never onto a row that has a Google identity again, nor a removed row", async () => {
    // Re-linked by a Google sign-in after the reset: another subject now.
    const addr = uniq("rsheld");
    const uid = await seedUser(addr, "member", { googleSub: `old-${newId()}` });
    await resetIdentity(e, await actor(), uid);
    const signedIn = `g-signin-${newId()}`;
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at) values ('google', ?, 'a.com', ?, ?)",
    )
      .bind(signedIn, uid, Date.now())
      .run();
    const other = `g-other-${crypto.randomUUID()}`;
    // No lookup: the new-id signal on a Google-linked row changes nothing.
    await applyUsers(e, [gu(other, addr)], { tenant: "a.com" });
    expect(await userByIdentity(other)).toBeNull();
    expect((await userByIdentity(signedIn))?.id).toBe(uid);

    // A removed row is never relinked (nor revived).
    const gone = uniq("rsgone");
    const gid = await seedUser(gone, "member", { googleSub: `old-${newId()}` });
    await resetIdentity(e, await actor(), gid);
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(gid)
      .run();
    const fresh = `g-fresh-${crypto.randomUUID()}`;
    await applyUsers(e, [gu(fresh, gone)], { tenant: "a.com" });
    expect((await userByIdentity(fresh))?.id).not.toBe(gid);
    expect(await statusOf(gid)).toBe("removed");
  });
});
