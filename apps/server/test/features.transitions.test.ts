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
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import type { UserPresence } from "../src/runtime/presence.js";
import { SYNC_DO_NAME } from "../src/services/directory.js";
import { getUser } from "../src/services/users.js";
import { mailer, uniq } from "./auth-helpers.js";
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

/** A shared space, one artifact in it, and group `gid` mapped there as editor. */
async function world(gid: string, members: string[]) {
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
      "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'editor')",
    ).bind(space, gid, email),
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
