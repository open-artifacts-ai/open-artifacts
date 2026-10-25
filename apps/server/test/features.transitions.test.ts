// P3 T15: tier transitions. A downgrade (trial or Business to Team) swaps
// sync_google for sync_frozen and must never widen access (spec 4.5);
// frozen keeps polling user status; the first reconcile after sync returns
// replaces every frozen edit with the synced role.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type AccessLevel,
  newId,
  R,
  type SpaceMember,
  TIER_FEATURES,
  type Tier,
} from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessLevel, callerOf } from "../src/auth/authz.js";
import { BACKOFF_MIN_MS, SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import {
  THAW_CHUNK,
  thawFrozenEdits,
  validEdit,
} from "../src/directory/thaw.js";
import type { Env } from "../src/env.js";
import type { UserPresence } from "../src/runtime/presence.js";
import { SYNC_DO_NAME } from "../src/services/directory.js";
import { getUser } from "../src/services/users.js";
import { mailer, seedUser, uniq } from "./auth-helpers.js";
import {
  app,
  connect,
  directEnv,
  registerInstall,
  resetDirectory,
} from "./directory-helpers.js";
import {
  type FakeDirectory,
  fakeDirectory,
} from "./fixtures/fake-directory.js";
import { fetchAndWait, login } from "./helpers.js";

const MIN = 60_000;
let g: FakeDirectory;
let base: Env;
let owner: { cookie: string; userId: string };
let adminSub: string;

/** This test's env with the tier's FEATURES. */
const tierEnv = (t: Tier): Env =>
  ({ ...base, FEATURES: TIER_FEATURES[t].join(",") }) as Env;
/** Every downgrade the tiers allow (spec 4.5: the trial is Business). */
const DOWNGRADES: [Tier, Tier][] = [
  ["trial", "team"],
  ["business", "team"],
];

const stub = () => {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) throw new Error("DIRECTORY_SYNC unbound");
  return ns.get(
    ns.idFromName(SYNC_DO_NAME),
  ) as unknown as DurableObjectStub<DirectorySync>;
};
const inDo = <T>(f: (s: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stub(), (_i, s) => f(s));
const kv = async <T>(k: string): Promise<T | null> => {
  const v = await inDo(
    (s) =>
      s.storage.sql.exec("select v from kv where k = ?", k).toArray()[0]?.v,
  );
  return v === undefined ? null : (JSON.parse(String(v)) as T);
};
const tick = (now: number, en: Env) =>
  inDo((s) => new SyncEngine(en, s.storage).alarm(now));
async function drain(now: number, en: Env) {
  for (let i = 0; i < 80; i++) {
    await tick(now, en);
    if (!(await inDo((s) => new SyncEngine(en, s.storage).due(now)))) return;
  }
  throw new Error("run never finished");
}

const one = <T>(sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .first<T>();
const uidOf = async (sub: string) =>
  (
    await one<{ user_id: string }>(
      "select user_id from identities where provider = 'google' and subject = ?",
      sub,
    )
  )?.user_id as string;
const revokedAt = (userId: string) => {
  const ns = env.USER_PRESENCE as NonNullable<Env["USER_PRESENCE"]>;
  return runInDurableObject(
    ns.get(ns.idFromName(userId)) as unknown as DurableObjectStub<UserPresence>,
    (p) => p.revokedAt(),
  );
};
const call = (
  e: Env,
  path: string,
  cookie: string,
  method: string,
  body?: unknown,
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method,
      headers: {
        "x-oa-request": "1",
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );

const RANK: Record<AccessLevel, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
  owner: 4,
};
/** Every (user, artifact, level) granted, each level implying the lower ones. */
async function accessSet(
  e: Env,
  users: string[],
  artifacts: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const uid of users) {
    const u = await getUser(e, uid);
    if (!u) continue;
    for (const aid of artifacts) {
      const lv = (await accessLevel(e, callerOf(u), aid))?.level;
      if (!lv) continue;
      for (const [l, r] of Object.entries(RANK))
        if (r <= RANK[lv]) out.add(`${uid}|${aid}|${l}`);
    }
  }
  return out;
}
const isSubset = (a: Set<string>, b: Set<string>) =>
  [...a].every((x) => b.has(x));

/** A shared space, one artifact in it, and group `gid` mapped there (editor). */
async function world(gid: string, members: string[], role = "editor") {
  const space = `s-${newId()}`;
  const artifact = newId();
  const email = `${gid}@a.com`;
  g.addGroup({ id: gid, email, members });
  await env.DB.batch([
    env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, 1)",
    ).bind(space, space),
    env.DB.prepare(
      "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at) values (?, ?, ?, 't', 'html', 'private', 1, 1)",
    ).bind(artifact, owner.userId, space),
    env.DB.prepare(
      "insert or ignore into directory_groups (group_id, email) values (?, ?)",
    ).bind(gid, email),
    env.DB.prepare(
      "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, ?)",
    ).bind(space, gid, email, role),
  ]);
  return { space, artifact };
}
const dirUsers = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) =>
    g.addUser({
      id: `g-${tag}-${i}-${crypto.randomUUID()}`,
      primaryEmail: uniq(`${tag}${i}`),
    }),
  );
const rowsOf = async (space: string, uid: string) =>
  (
    await env.DB.prepare(
      "select source, role from space_members where space_id = ? and user_id = ? order by source",
    )
      .bind(space, uid)
      .all<{ source: string; role: string }>()
  ).results;

/** The sync actor's audit rows on (space, user), oldest first. */
const syncAuditRows = async (space: string, uid: string) =>
  (
    await env.DB.prepare(
      "select action, detail from audit_events where actor_kind = 'sync' and space_id = ? and target_id = ? order by at, id",
    )
      .bind(space, uid)
      .all<{ action: string; detail: string }>()
  ).results.map((r) => ({
    action: r.action,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  }));
/** The thaw's outcome audits (not its synced-row ones). */
const thawAudits = async (space: string, uid: string) =>
  (await syncAuditRows(space, uid)).filter((r) => r.detail.thaw !== "sync");
/** The thaw's synced-row audits. */
const syncRowAudits = async (space: string, uid: string) =>
  (await syncAuditRows(space, uid))
    .filter((r) => r.detail.thaw === "sync")
    .map((r) => r.detail);

beforeEach(async () => {
  await resetDirectory();
  await env.DB.batch([
    env.DB.prepare("delete from group_mappings"),
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
  base = directEnv(mailer().env);
  owner = await login(uniq("tier-owner"), "owner");
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

/** Connects under `from` and runs the first reconcile at `t0`. */
async function connected(from: Env, t0: number) {
  const r = await connect(from, owner.cookie, g, { sub: adminSub });
  expect(r.ok).toBe(true);
  await drain(t0, from);
}

describe("tier transitions", () => {
  it.each(DOWNGRADES)(
    "every downgrade A→B gives accessSet(B) ⊆ accessSet(A): %s → %s, a group walk in flight",
    async (a, b) => {
      const from = tierEnv(a);
      const to = tierEnv(b);
      const us = dirUsers(3, `dg${a}`);
      const gid = `grp-dg-${crypto.randomUUID()}`;
      const { artifact } = await world(gid, [
        us[0]?.id as string,
        us[1]?.id as string,
      ]);
      const t0 = Date.now();
      await connected(from, t0);
      const uids = await Promise.all(us.map((u) => uidOf(u.id)));
      const before = await accessSet(from, uids, [artifact]);
      expect(before.size).toBe(4);
      // Joins in Google; the hourly reconcile starts its walk, then the
      // tier changes before the walk reaches the joiner.
      g.addMember(gid, us[2]?.id as string);
      g.setMemberPageSize(1);
      const at = t0 + 61 * MIN;
      for (let i = 0; i < 40; i++) {
        await tick(at, from);
        const run = await kv<{ queue: { kind: string; had?: unknown }[] }>(
          "run.rec",
        );
        const w = run?.queue[0];
        if (w?.kind === "walk" && w.had !== null) break;
      }
      await drain(at, to);
      await drain(at + 2 * MIN, to);
      const after = await accessSet(to, uids, [artifact]);
      expect(isSubset(after, before)).toBe(true);
      // The same rows read under either tier's flags: flags never widen.
      expect(isSubset(after, await accessSet(from, uids, [artifact]))).toBe(
        true,
      );
    },
  );

  it("frozen edits are replaced when sync returns", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const us = dirUsers(4, "thaw");
    const gid = `grp-thaw-${crypto.randomUUID()}`;
    const { space, artifact } = await world(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(business, t0);
    const [lowered, raised, removed, kept] = await Promise.all(
      us.map((u) => uidOf(u.id)),
    );
    const ids = [lowered, raised, removed, kept] as string[];
    for (const uid of ids)
      expect(await rowsOf(space, uid)).toEqual([
        { source: "sync", role: "editor" },
      ]);

    // Team: an admin edits the frozen list by hand.
    const put = (uid: string, role: string) =>
      call(team, R.spaceMember(space, uid), owner.cookie, "PUT", { role });
    const r1 = await put(lowered as string, "viewer");
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as SpaceMember).source).toBe("manual");
    expect((await put(raised as string, "manager")).status).toBe(200);
    const d = await call(
      team,
      R.spaceMember(space, removed as string),
      owner.cookie,
      "DELETE",
    );
    expect(d.status).toBe(204);
    await drain(t0 + 2 * MIN, team);
    expect(await rowsOf(space, removed as string)).toEqual([]);
    expect(await rowsOf(space, raised as string)).toEqual([
      { source: "manual", role: "manager" },
    ]);

    // Back to Business: the next reconcile replaces every frozen edit.
    const thawAt = t0 + 61 * MIN;
    await drain(thawAt, business);
    for (const uid of ids)
      expect(await rowsOf(space, uid)).toEqual([
        { source: "sync", role: "editor" },
      ]);
    const lv = async (uid: string) => {
      const u = await getUser(business, uid);
      return u
        ? (await accessLevel(business, callerOf(u), artifact))?.level
        : null;
    };
    for (const uid of ids) expect(await lv(uid)).toBe("editor");
    // The manager override was lowered: its sockets closed.
    expect(Number(await revokedAt(raised as string))).toBeGreaterThan(0);
    // Once replaced, nothing is left to replace.
    expect(await one("select count(*) as n from frozen_edits")).toEqual({
      n: 0,
    });
    // No manual row before the freeze: each one a frozen edit left is
    // removed, audited as sync.
    for (const uid of [lowered, raised] as string[])
      expect(await thawAudits(space, uid)).toEqual([
        { action: "space.member.remove", detail: { thaw: true } },
      ]);
    // The frozen delete is final; fresh membership (still in the group)
    // re-adds the synced row only.
    expect(await thawAudits(space, removed as string)).toEqual([
      { action: "directory.sync", detail: { thaw: "removal_kept" } },
    ]);
    // Each synced row the thaw derived again is audited too; kept had no
    // frozen edit, so no thaw audit at all.
    for (const uid of [lowered, raised, removed] as string[])
      expect(await syncRowAudits(space, uid)).toEqual([
        { thaw: "sync", to: "editor" },
      ]);
    expect(await syncAuditRows(space, kept as string)).toEqual([]);
  });

  it("thaw restores the manual rows from before the freeze, never more", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const us = dirUsers(4, "rest");
    const gid = `grp-rest-${crypto.randomUUID()}`;
    const { space, artifact } = await world(
      gid,
      us.map((u) => u.id),
      "viewer",
    );
    const t0 = Date.now();
    await connected(business, t0);
    const [a, b, c, d] = (await Promise.all(
      us.map((u) => uidOf(u.id)),
    )) as string[];
    const put = (e: Env, uid: string, role: string) =>
      call(e, R.spaceMember(space, uid), owner.cookie, "PUT", { role });
    const del = (e: Env, uid: string) =>
      call(e, R.spaceMember(space, uid), owner.cookie, "DELETE");
    // Before the freeze: manual rows next to the synced viewer rows.
    expect((await put(business, a, "editor")).status).toBe(200);
    expect((await put(business, b, "viewer")).status).toBe(200);
    expect((await put(business, c, "editor")).status).toBe(200);
    // Team: a lowered, b raised, c removed, d (no manual row) made manager.
    expect((await put(team, a, "viewer")).status).toBe(200);
    expect((await put(team, b, "manager")).status).toBe(200);
    expect((await del(team, c)).status).toBe(204);
    expect((await put(team, d, "manager")).status).toBe(200);
    // Later frozen edits keep the first one's record.
    expect((await put(team, a, "manager")).status).toBe(200);
    expect((await put(team, a, "viewer")).status).toBe(200);
    const pre = {
      b: Number((await revokedAt(b)) ?? 0),
      d: Number((await revokedAt(d)) ?? 0),
    };

    await drain(t0 + 61 * MIN, business);
    const sync = { source: "sync", role: "viewer" };
    expect(await rowsOf(space, a)).toEqual([
      { source: "manual", role: "editor" },
      sync,
    ]);
    expect(await rowsOf(space, b)).toEqual([
      { source: "manual", role: "viewer" },
      sync,
    ]);
    // c's frozen delete is final: the pre-freeze manual editor stays gone;
    // c is still in the group, so sync re-adds the synced viewer row.
    expect(await rowsOf(space, c)).toEqual([sync]);
    expect(await rowsOf(space, d)).toEqual([sync]);
    const lv = async (uid: string) => {
      const u = await getUser(business, uid);
      return u
        ? (await accessLevel(business, callerOf(u), artifact))?.level
        : null;
    };
    expect(await lv(a)).toBe("editor");
    expect(await lv(b)).toBe("viewer");
    expect(await lv(c)).toBe("viewer");
    expect(await lv(d)).toBe("viewer");
    // The narrowed (b and d were managers) had their sockets closed.
    expect(Number(await revokedAt(b))).toBeGreaterThan(pre.b);
    expect(Number(await revokedAt(d))).toBeGreaterThan(pre.d);
    expect(await thawAudits(space, a)).toEqual([
      { action: "space.member.role", detail: { thaw: true, role: "editor" } },
    ]);
    expect(await thawAudits(space, b)).toEqual([
      { action: "space.member.role", detail: { thaw: true, role: "viewer" } },
    ]);
    expect(await thawAudits(space, c)).toEqual([
      { action: "directory.sync", detail: { thaw: "removal_kept" } },
    ]);
    expect(await thawAudits(space, d)).toEqual([
      { action: "space.member.remove", detail: { thaw: true } },
    ]);
    // The next reconcile has nothing to undo and audits nothing more.
    await drain(t0 + 122 * MIN, business);
    expect(await thawAudits(space, a)).toHaveLength(1);
  });

  it("left the group while frozen, then thaw: the frozen delete stays removed, at every alarm", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const us = dirUsers(3, "left");
    const gid = `grp-left-${crypto.randomUUID()}`;
    const { space } = await world(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(business, t0);
    const x = await uidOf(us[0]?.id as string);
    // Frozen: x leaves the group in Google, and an admin removes x by hand.
    g.removeMember(gid, us[0]?.id as string);
    const d = await call(team, R.spaceMember(space, x), owner.cookie, "DELETE");
    expect(d.status).toBe(204);
    g.setMemberPageSize(1);
    // Back to Business: alarm by alarm, x never regains a row (the thaw
    // runs after the walks, on fresh membership).
    const at = t0 + 61 * MIN;
    for (let i = 0; i < 80; i++) {
      await tick(at, business);
      expect(await rowsOf(space, x)).toEqual([]);
      if (!(await inDo((s) => new SyncEngine(business, s.storage).due(at))))
        break;
    }
    expect(await one("select count(*) as n from frozen_edits")).toEqual({
      n: 0,
    });
    expect(await thawAudits(space, x)).toEqual([
      { action: "directory.sync", detail: { thaw: "removal_kept" } },
    ]);
  });

  it("a frozen manual add survives the thaw, audited", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const us = dirUsers(2, "add");
    const gid = `grp-add-${crypto.randomUUID()}`;
    const { space, artifact } = await world(gid, [us[0]?.id as string]);
    const t0 = Date.now();
    await connected(business, t0);
    const outsider = await uidOf(us[1]?.id as string);
    const r = await call(
      team,
      R.spaceMember(space, outsider),
      owner.cookie,
      "PUT",
      { role: "editor" },
    );
    expect(r.status).toBe(200);
    await drain(t0 + 61 * MIN, business);
    expect(await rowsOf(space, outsider)).toEqual([
      { source: "manual", role: "editor" },
    ]);
    const u = await getUser(business, outsider);
    expect(
      u ? (await accessLevel(business, callerOf(u), artifact))?.level : null,
    ).toBe("editor");
    expect(await thawAudits(space, outsider)).toEqual([
      {
        action: "directory.sync",
        detail: { thaw: "manual_kept", role: "editor" },
      },
    ]);
  });

  it("first edit wins across a repeated freeze with the thaw unfinished", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const us = dirUsers(1, "again");
    const gid = `grp-again-${crypto.randomUUID()}`;
    const { space } = await world(gid, [us[0]?.id as string], "viewer");
    const t0 = Date.now();
    await connected(business, t0);
    const x = await uidOf(us[0]?.id as string);
    const put = (e: Env, role: string) =>
      call(e, R.spaceMember(space, x), owner.cookie, "PUT", { role });
    expect((await put(business, "editor")).status).toBe(200);
    expect((await put(team, "viewer")).status).toBe(200);
    const rec = () =>
      one(
        "select at, manual_role, kind from frozen_edits where user_id = ?",
        x,
      );
    const first = await rec();
    expect(first).toMatchObject({ manual_role: "editor", kind: "override" });
    // Sync back on but no reconcile yet (the thaw hasn't run), then frozen
    // again and edited again: the record is the first one, unchanged.
    await drain(t0 + 2 * MIN, business);
    expect((await put(business, "viewer")).status).toBe(200);
    expect((await put(team, "manager")).status).toBe(200);
    expect(await rec()).toEqual(first);
    await drain(t0 + 61 * MIN, business);
    expect(await rowsOf(space, x)).toEqual([
      { source: "manual", role: "editor" },
      { source: "sync", role: "viewer" },
    ]);
  });

  it("the thaw applies one chunk per alarm", async () => {
    const business = tierEnv("business");
    const t0 = Date.now();
    await connected(business, t0);
    const space = `s-${newId()}`;
    await env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, 1)",
    )
      .bind(space, space)
      .run();
    for (let i = 0; i <= THAW_CHUNK; i++) {
      const uid = await seedUser(uniq(`chunk${i}`), "member");
      await env.DB.prepare(
        "insert into frozen_edits (space_id, user_id, at, manual_role, kind) values (?, ?, ?, null, 'manual')",
      )
        .bind(space, uid, i)
        .run();
    }
    const left = async () =>
      (await one<{ n: number }>("select count(*) as n from frozen_edits"))?.n;
    const at = t0 + 61 * MIN;
    let n = THAW_CHUNK + 1;
    for (let i = 0; i < 40 && n === THAW_CHUNK + 1; i++) {
      await tick(at, business);
      n = (await left()) as number;
    }
    // The alarm that ran the thaw did one chunk only.
    expect(n).toBe(1);
    await tick(at, business);
    expect(await left()).toBe(0);
  });

  it("stored values outside the enums never grant", () => {
    expect(
      validEdit({ s: "s", u: "u", t: 1, m: "owner", k: "override" }),
    ).toMatchObject({ m: null, k: "override" });
    expect(
      validEdit({ s: "s", u: "u", t: 1, m: "editor", k: "x" }),
    ).toMatchObject({ m: "editor", k: "delete" });
  });

  it("frozen runs keep lastSuccessAt (no group read is reported fresh)", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const t0 = Date.now();
    await connected(business, t0);
    const st = (en: Env) => inDo((s) => new SyncEngine(en, s.storage).status());
    const before = await st(business);
    expect(before.state).toBe("ok");
    await drain(t0 + 61 * MIN, team);
    await drain(t0 + 122 * MIN, team);
    const after = await st(team);
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
    expect(after.staleAt).toBe(before.staleAt);
    // The next run still moves on while frozen.
    expect(Date.parse(after.nextRunAt ?? "")).toBeGreaterThan(
      Date.parse(before.nextRunAt ?? ""),
    );
    // Back on: the next reconcile that reads groups stamps it.
    await drain(t0 + 183 * MIN, business);
    expect((await st(business)).lastSuccessAt).not.toBe(before.lastSuccessAt);
  });

  it.each([
    ["DELETE", null],
    ["downgrade", "viewer"],
  ] as const)(
    "a live admin %s after sync returns, before the thaw, is not undone",
    async (_what, role) => {
      const business = tierEnv("business");
      const team = tierEnv("team");
      const us = dirUsers(1, "live");
      const gid = `grp-live-${crypto.randomUUID()}`;
      const { space } = await world(gid, [us[0]?.id as string], "viewer");
      const t0 = Date.now();
      await connected(business, t0);
      const x = await uidOf(us[0]?.id as string);
      const path = R.spaceMember(space, x);
      // Pre-freeze manual editor; frozen override to manager.
      expect(
        (await call(business, path, owner.cookie, "PUT", { role: "editor" }))
          .status,
      ).toBe(200);
      expect(
        (await call(team, path, owner.cookie, "PUT", { role: "manager" }))
          .status,
      ).toBe(200);
      // Sync back on; before the thaw, an admin removes or lowers by hand.
      const r =
        role === null
          ? await call(business, path, owner.cookie, "DELETE")
          : await call(business, path, owner.cookie, "PUT", { role });
      expect(r.ok).toBe(true);
      await drain(t0 + 61 * MIN, business);
      const sync = { source: "sync", role: "viewer" };
      expect(await rowsOf(space, x)).toEqual(
        role === null ? [sync] : [{ source: "manual", role }, sync],
      );
      expect(await one("select count(*) as n from frozen_edits")).toEqual({
        n: 0,
      });
    },
  );

  it.each([
    ["DELETE", null],
    ["demotion", "viewer"],
  ] as const)(
    "race: a live admin %s between the thaw's page read and its batch writes nothing back",
    async (_what, role) => {
      const business = tierEnv("business");
      const team = tierEnv("team");
      const us = dirUsers(1, "race");
      const gid = `grp-race-${crypto.randomUUID()}`;
      const { space } = await world(gid, [us[0]?.id as string], "viewer");
      const t0 = Date.now();
      await connected(business, t0);
      const x = await uidOf(us[0]?.id as string);
      const path = R.spaceMember(space, x);
      const put = (e: Env, r: string) =>
        call(e, path, owner.cookie, "PUT", { role: r });
      // Pre-freeze manual manager; frozen override to editor.
      expect((await put(business, "manager")).status).toBe(200);
      expect((await put(team, "editor")).status).toBe(200);
      // The live edit lands right before the thaw's batch (after its read).
      let fired = false;
      const DB = new Proxy(env.DB, {
        get(t, p) {
          if (p === "batch")
            return async (ss: D1PreparedStatement[]) => {
              if (!fired) {
                fired = true;
                const r =
                  role === null
                    ? await call(business, path, owner.cookie, "DELETE")
                    : await put(business, role);
                expect(r.ok).toBe(true);
              }
              return t.batch(ss);
            };
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      await thawFrozenEdits({ ...business, DB } as Env);
      expect(fired).toBe(true);
      const manual =
        role === null ? [] : [{ source: "manual", role: role as string }];
      // Nothing written back: no manager restored over the live edit.
      expect(await rowsOf(space, x)).toEqual(manual);
      expect(await thawAudits(space, x)).toEqual([]);
      // The superseded record waits; the next thaw applies it as it is now.
      expect(
        await one("select kind from frozen_edits where user_id = ?", x),
      ).toEqual({ kind: role === null ? "delete" : "manual" });
      await thawFrozenEdits(business);
      expect(await rowsOf(space, x)).toEqual([
        ...manual,
        { source: "sync", role: "viewer" },
      ]);
    },
  );

  it("an owed socket close that throws is retried on the next alarm", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const us = dirUsers(1, "owed");
    const gid = `grp-owed-${crypto.randomUUID()}`;
    const { space } = await world(gid, [us[0]?.id as string], "viewer");
    const t0 = Date.now();
    await connected(business, t0);
    const x = await uidOf(us[0]?.id as string);
    expect(
      (
        await call(team, R.spaceMember(space, x), owner.cookie, "PUT", {
          role: "manager",
        })
      ).status,
    ).toBe(200);
    const pre = Number((await revokedAt(x)) ?? 0);
    // The thaw lowers x (manager override gone), but its close throws.
    const at = t0 + 61 * MIN;
    for (let i = 0; i < 80; i++) {
      await inDo((s) => {
        const en = new SyncEngine(business, s.storage);
        en.revokeLive = async () => {
          throw new Error("presence down");
        };
        return en.alarm(at);
      });
      if (!(await inDo((s) => new SyncEngine(business, s.storage).due(at))))
        break;
    }
    expect(await rowsOf(space, x)).toEqual([
      { source: "sync", role: "viewer" },
    ]);
    expect(await kv<string[]>("revoke.pending")).toEqual([x]);
    expect(Number((await revokedAt(x)) ?? 0)).toBe(pre);
    // The next alarm retries it, then clears it.
    await tick(at + 2 * MIN, business);
    expect(Number(await revokedAt(x))).toBeGreaterThan(pre);
    expect(await kv("revoke.pending")).toBeNull();
  });

  it("sync off: an owed close re-arms the alarm until it is done, then stops", async () => {
    const off = { ...base, FEATURES: "spaces" } as Env;
    const x = await seedUser(uniq("owed-off"), "member");
    await inDo((s) =>
      s.storage.sql.exec(
        "insert into kv (k, v) values ('revoke.pending', ?)",
        JSON.stringify([x]),
      ),
    );
    const pre = Number((await revokedAt(x)) ?? 0);
    const t = Date.now();
    // Fails once: still owed, and the alarm re-arms (sync off or not).
    await inDo(async (s) => {
      const en = new SyncEngine(off, s.storage);
      en.revokeLive = async () => {
        throw new Error("presence down");
      };
      await en.alarm(t);
    });
    expect(await kv<string[]>("revoke.pending")).toEqual([x]);
    expect(await inDo((s) => s.storage.getAlarm())).toBe(t + BACKOFF_MIN_MS);
    // The next alarm revokes and clears it; nothing re-arms after.
    await inDo((s) => s.storage.deleteAlarm());
    await tick(t + BACKOFF_MIN_MS, off);
    expect(Number(await revokedAt(x))).toBeGreaterThan(pre);
    expect(await kv("revoke.pending")).toBeNull();
    expect(await kv("revoke.tries")).toBeNull();
    expect(await inDo((s) => s.storage.getAlarm())).toBeNull();
  });

  it("frozen still suspends departed users", async () => {
    const business = tierEnv("business");
    const team = tierEnv("team");
    const us = dirUsers(2, "gone");
    const gid = `grp-gone-${crypto.randomUUID()}`;
    const { artifact } = await world(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(business, t0);
    const [left, suspended] = await Promise.all(us.map((u) => uidOf(u.id)));
    (g.users.get(us[0]?.id as string) as { deleted?: boolean }).deleted = true;
    (g.users.get(us[1]?.id as string) as { suspended?: boolean }).suspended =
      true;
    g.adminCalls.length = 0;
    await drain(t0 + 61 * MIN, team);
    const status = async (uid: string) =>
      (
        await one<{ status: string }>(
          "select status from users where id = ?",
          uid,
        )
      )?.status;
    expect(await status(left as string)).toBe("removed");
    expect(await status(suspended as string)).toBe("suspended");
    expect(
      await accessSet(team, [left, suspended] as string[], [artifact]),
    ).toEqual(new Set());
    // No group reads while frozen.
    expect(g.adminCalls.some((c) => c.includes("/members"))).toBe(false);
  });
});
