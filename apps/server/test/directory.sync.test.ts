// P3 T13: DirectorySync polling, reconcile, holds and health. The engine is
// driven alarm by alarm with an explicit clock and this file's env (the DO's
// own env is the pool's, where sync is off and its alarms do nothing).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Me, R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activities,
  listMembers,
  parseUsersPage,
} from "../src/directory/google.js";
import { instanceDirectory, readHealth } from "../src/directory/health.js";
import { directorySignIn } from "../src/directory/signin.js";
import { readPending, readPendingAny } from "../src/directory/store.js";
import {
  FAST_MS,
  RECONCILE_MS,
  SyncEngine,
} from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { SYNC_DO_NAME } from "../src/services/directory.js";
import { mailer, type SentMail, uniq } from "./auth-helpers.js";
import {
  APP,
  app,
  connect,
  directEnv,
  get,
  post,
  registerInstall,
  resetDirectory,
} from "./directory-helpers.js";
import {
  type FakeDirectory,
  fakeDirectory,
} from "./fixtures/fake-directory.js";
import adminEvents from "./fixtures/google/activities-admin.json";
import membersPage from "./fixtures/google/members-page.json";
import usersPage from "./fixtures/google/users-page.json";
import { errOf, fetchAndWait, login } from "./helpers.js";

const MIN = 60_000;
let g: FakeDirectory;
let e: Env;
let sent: SentMail[];
let owner: { cookie: string; userId: string; email: string };
let adminSub: string;

const stub = () => {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) throw new Error("DIRECTORY_SYNC unbound");
  return ns.get(
    ns.idFromName(SYNC_DO_NAME),
  ) as unknown as DurableObjectStub<DirectorySync>;
};
const inDo = <T>(f: (s: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stub(), (_i, s) => f(s));
/** A DirectorySync kv value (JSON), or null. */
const kv = async <T>(k: string): Promise<T | null> => {
  const v = await inDo(
    (s) =>
      s.storage.sql.exec("select v from kv where k = ?", k).toArray()[0]?.v,
  );
  return v === undefined ? null : (JSON.parse(String(v)) as T);
};
/** One alarm at `now` under `en` (default: this test's env). */
const tick = (now: number, en: Env = e) =>
  inDo((s) => new SyncEngine(en, s.storage).alarm(now));
/**
 * Alarms at `now` until no lane may run (done, or backing off). One DO call
 * for the whole loop, a fresh engine per alarm (as the DO builds one): two
 * round-trips per alarm made this file time out under suite load (#617).
 */
async function drain(now: number, en: Env = e) {
  const done = await inDo(async (s) => {
    for (let i = 0; i < 80; i++) {
      await new SyncEngine(en, s.storage).alarm(now);
      if (!new SyncEngine(en, s.storage).due(now)) return true;
    }
    return false;
  });
  if (!done) throw new Error("run never finished");
}

const status = async (): Promise<SyncStatus> =>
  inDo((s) => new SyncEngine(e, s.storage).status());
const membersOf = async (groupId: string) =>
  (
    await env.DB.prepare(
      "select user_id from directory_members where group_id = ? order by user_id",
    )
      .bind(groupId)
      .all<{ user_id: string }>()
  ).results.map((r) => r.user_id);
const uidOf = async (sub: string) =>
  (
    await env.DB.prepare(
      "select user_id from identities where provider = 'google' and subject = ?",
    )
      .bind(sub)
      .first<{ user_id: string }>()
  )?.user_id as string;
const statusOf = async (uid: string) =>
  (
    await env.DB.prepare("select status from users where id = ?")
      .bind(uid)
      .first<{ status: string }>()
  )?.status;
const toOwner = () => sent.filter((m) => m.to === owner.email);

/** Directory users in the fake (in-domain, so connect links them). */
function dirUsers(n: number, tag: string) {
  return Array.from({ length: n }, (_, i) =>
    g.addUser({
      id: `g-${tag}-${i}-${crypto.randomUUID()}`,
      primaryEmail: uniq(`${tag}${i}`),
    }),
  );
}

/** A group in the fake and in directory_groups, mapped Every-space (or restricted). */
async function mappedGroup(
  id: string,
  members: string[],
  kind: "org" | "restricted" = "org",
) {
  const email = `${id}@a.com`;
  g.addGroup({ id, email, members });
  await env.DB.batch([
    env.DB.prepare(
      "insert or ignore into directory_groups (group_id, email) values (?, ?)",
    ).bind(id, email),
    kind === "org"
      ? env.DB.prepare(
          "insert or replace into org_group_mappings (group_id, group_email, role) values (?, ?, 'viewer')",
        ).bind(id, email)
      : env.DB.prepare(
          "insert or replace into restricted_groups (group_id, group_email) values (?, ?)",
        ).bind(id, email),
  ]);
  return email;
}

beforeEach(async () => {
  await resetDirectory();
  await env.DB.batch([
    env.DB.prepare("delete from org_group_mappings"),
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
  const m = mailer();
  sent = m.sent;
  e = directEnv(m.env);
  const email = uniq("sync-owner");
  owner = { ...(await login(email, "owner")), email };
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

/** Connects (direct transport) and runs the first reconcile at `t0`. */
async function connected(t0: number) {
  const r = await connect(e, owner.cookie, g, { sub: adminSub });
  expect(r.ok).toBe(true);
  await drain(t0);
  expect((await status()).state).toBe("ok");
}

describe("DirectorySync", () => {
  it("Reports SUSPEND_USER on the next 2-min tick suspends and closes sockets", async () => {
    const [u] = dirUsers(1, "susp");
    const t0 = Date.now();
    await connected(t0);
    const uid = await uidOf(u?.id as string);
    expect(await statusOf(uid)).toBe("active");
    (g.users.get(u?.id as string) as { suspended?: boolean }).suspended = true;
    g.activity("admin", "SUSPEND_USER", { USER_EMAIL: u?.primaryEmail ?? "" });
    await drain(t0 + 2 * MIN);
    expect(await statusOf(uid)).toBe("suspended");
    // Its UserPresence recorded the revocation (sockets refused and closed).
    const ns = env.USER_PRESENCE as NonNullable<Env["USER_PRESENCE"]>;
    const revoked = await runInDurableObject(
      ns.get(ns.idFromName(uid)),
      (_i, s) =>
        s.storage.sql
          .exec("select revoked_at from state where id = 1")
          .toArray()[0]?.revoked_at,
    );
    expect(Number(revoked)).toBeGreaterThan(0);
    expect(g.adminCalls).toContain("/reports/admin");
  });

  it("5xx on page 2 of 3 removes nobody", async () => {
    const us = dirUsers(6, "p3");
    const gid = `grp-p3-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    g.setMemberPageSize(2);
    const t0 = Date.now();
    await connected(t0);
    const before = await membersOf(gid);
    expect(before).toHaveLength(6);
    g.removeMember(gid, us[5]?.id as string);
    g.fail(new RegExp(`/groups/${gid}/members\\?.*pageToken=2`), 503);
    await drain(t0 + 61 * MIN);
    expect(await membersOf(gid)).toEqual(before);
    expect((await status()).state).toBe("backoff");
    // The retry resumes at page 2 and then removes the one who left.
    await drain(t0 + 70 * MIN);
    expect(await membersOf(gid)).toHaveLength(5);
    expect((await status()).state).toBe("ok");
  });

  it("active listing of 0 holds every sweep", async () => {
    const us = dirUsers(3, "zero");
    const gid = `grp-zero-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    expect(await membersOf(gid)).toHaveLength(3);
    g.setEmptyActive(true);
    g.removeMember(gid, us[0]?.id as string);
    await drain(t0 + 61 * MIN);
    expect(await membersOf(gid)).toHaveLength(3);
    const st = await status();
    expect(st.held.map((h) => h.groupId)).toEqual([gid]);
    expect(st.held[0]).toMatchObject({ wouldRemove: 1, members: 3 });
  });

  it("group 404 without DELETE_GROUP is held; the owner's confirm applies it", async () => {
    const us = dirUsers(2, "gone");
    const gid = `grp-gone-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    g.deleteGroup(gid);
    await drain(t0 + 61 * MIN);
    expect(await membersOf(gid)).toHaveLength(2);
    expect((await status()).held.map((h) => h.groupId)).toEqual([gid]);
    const r = await post(e, R.directoryHeldConfirm(gid), owner.cookie);
    expect(r.status).toBe(202);
    // The confirm re-reads the group, then applies the removals once.
    await drain(t0 + 62 * MIN);
    expect(await membersOf(gid)).toEqual([]);
    expect((await status()).held).toEqual([]);
  });

  it("a confirmed hold keeps anyone re-added since the hold", async () => {
    const us = dirUsers(3, "readd");
    const gid = `grp-readd-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    const [u0, u1] = [
      await uidOf(us[0]?.id ?? ""),
      await uidOf(us[1]?.id ?? ""),
    ];
    g.setEmptyActive(true);
    g.removeMember(gid, us[0]?.id as string);
    await drain(t0 + 61 * MIN);
    expect((await status()).held.map((h) => h.groupId)).toEqual([gid]);
    // Before the owner confirms: u0 is back, u1 left.
    g.addMember(gid, us[0]?.id as string);
    g.removeMember(gid, us[1]?.id as string);
    expect(
      (await post(e, R.directoryHeldConfirm(gid), owner.cookie)).status,
    ).toBe(202);
    await drain(t0 + 62 * MIN);
    const now = await membersOf(gid);
    expect(now).toContain(u0);
    expect(now).not.toContain(u1);
    expect((await status()).held).toEqual([]);
  });

  it("group 404 after DELETE_GROUP is swept on the fast path", async () => {
    const us = dirUsers(2, "del");
    const gid = `grp-del-${crypto.randomUUID()}`;
    const email = await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    g.deleteGroup(gid);
    g.activity("admin", "DELETE_GROUP", { GROUP_EMAIL: email });
    await drain(t0 + 2 * MIN);
    expect(await membersOf(gid)).toEqual([]);
    expect((await status()).held).toEqual([]);
  });

  it("child group change marks ancestor mapped group dirty", async () => {
    const [a, b] = dirUsers(2, "nest");
    const child = `grp-child-${crypto.randomUUID()}`;
    const parent = `grp-parent-${crypto.randomUUID()}`;
    g.addGroup({ id: child, email: `${child}@a.com`, members: [a?.id ?? ""] });
    await mappedGroup(parent, [child]);
    const t0 = Date.now();
    await connected(t0);
    const ua = await uidOf(a?.id as string);
    const ub = await uidOf(b?.id as string);
    // Flattened: the child's user is a member of the mapped parent.
    expect(await membersOf(parent)).toEqual([ua]);
    const row = await env.DB.prepare(
      "select parent_ids from directory_groups where group_id = ?",
    )
      .bind(child)
      .first<{ parent_ids: string }>();
    expect(JSON.parse(row?.parent_ids ?? "[]")).toEqual([parent]);
    g.addMember(child, b?.id as string);
    g.activity("groups", "add_user", { group_email: `${child}@a.com` });
    g.adminCalls.length = 0;
    await drain(t0 + 2 * MIN);
    expect(g.adminCalls).toContain(`/groups/${parent}/members`);
    expect(await membersOf(parent)).toEqual([ua, ub].sort());
  });

  it("groups-app remove_user is picked up", async () => {
    const us = dirUsers(3, "rm");
    const gid = `grp-rm-${crypto.randomUUID()}`;
    const email = await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    const gone = await uidOf(us[0]?.id as string);
    expect(await membersOf(gid)).toContain(gone);
    g.removeMember(gid, us[0]?.id as string);
    g.activity("groups", "remove_user", { group_email: email });
    await drain(t0 + 2 * MIN);
    expect(await membersOf(gid)).not.toContain(gone);
    expect(await membersOf(gid)).toHaveLength(2);
  });

  it("customerId mismatch → state customer_mismatch, synced users denied, owners emailed", async () => {
    dirUsers(1, "cm");
    const t0 = Date.now();
    await connected(t0);
    const u = g.users.get(adminSub) as { customerId?: string };
    u.customerId = "C-OTHER";
    await drain(t0 + 2 * MIN);
    const st = await status();
    expect(st.state).toBe("customer_mismatch");
    expect(st.customerMismatch).toEqual({
      expected: g.customerId,
      actual: "C-OTHER",
    });
    // T18's per-request denial reads this one key (fail closed).
    const key = await env.DB.prepare(
      "select value from directory_state where key = 'sync.state'",
    ).first<{ value: string }>();
    expect(key?.value).toBe("customer_mismatch");
    expect(toOwner()).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from audit_events where action = 'directory.sync.failed' and detail like '%customer_mismatch%'",
        ).first<{ n: number }>()
      )?.n,
    ).toBeGreaterThanOrEqual(1);
    // Retried hourly, emailed once per outage.
    await drain(t0 + 63 * MIN);
    expect(toOwner()).toHaveLength(1);
  });

  it("unhealthy 1 h → me.instance.directory.banner; 24 h → owners emailed exactly once (alertedAt); success resets", async () => {
    const t0 = Date.now() - 26 * 60 * MIN;
    await connected(t0);
    g.fail(/./, 503, { times: 10_000 });
    const since = t0 + 2 * MIN;
    await drain(since);
    let h = await readHealth(e);
    expect(h.unhealthySince).toBe(since);
    expect(instanceDirectory("google", h, true, since + 59 * MIN).banner).toBe(
      false,
    );
    expect(
      instanceDirectory("google", h, true, since + 61 * MIN),
    ).toMatchObject({ banner: true, tokensUnverified: true });
    expect(instanceDirectory("google", h, false, since + 61 * MIN).banner).toBe(
      false,
    );
    await drain(since + 23 * 60 * MIN);
    expect(toOwner()).toHaveLength(0);
    await drain(since + 24 * 60 * MIN + MIN);
    await drain(since + 24 * 60 * MIN + 40 * MIN);
    expect(toOwner()).toHaveLength(1);
    h = await readHealth(e);
    expect(h.alertedAt).not.toBeNull();
    const me = (await (await get(e, R.me, owner.cookie)).json()) as Me;
    expect(me.instance.directory?.banner).toBe(true);
    g.clearFailures();
    await drain(since + 25 * 60 * MIN);
    h = await readHealth(e);
    expect(h).toMatchObject({
      state: "ok",
      unhealthySince: null,
      alertedAt: null,
    });
  });

  it("frozen still applies suspensions", async () => {
    const [u] = dirUsers(1, "frz");
    const gid = `grp-frz-${crypto.randomUUID()}`;
    await mappedGroup(gid, [u?.id ?? ""]);
    const t0 = Date.now();
    await connected(t0);
    const frozen = { ...e, FEATURES: "spaces,sync_frozen" } as Env;
    (g.users.get(u?.id as string) as { suspended?: boolean }).suspended = true;
    g.activity("admin", "SUSPEND_USER", { USER_EMAIL: u?.primaryEmail ?? "" });
    g.adminCalls.length = 0;
    await drain(t0 + 2 * MIN, frozen);
    expect(await statusOf(await uidOf(u?.id as string))).toBe("suspended");
    // Group sync stopped: no members read, no groups-app events.
    expect(g.adminCalls.some((c) => c.includes("/members"))).toBe(false);
    expect(g.adminCalls).not.toContain("/reports/groups");
  });

  it("403 insufficientPermissions → state scope_missing; me.instance.directory.state for admins only", async () => {
    const t0 = Date.now();
    await connected(t0);
    g.fail(/\/reports\/admin/, 403, {
      times: 10,
      reason: "insufficientPermissions",
    });
    await drain(t0 + 2 * MIN);
    expect((await status()).state).toBe("scope_missing");
    expect(toOwner()).toHaveLength(1);
    const asOwner = (await (await get(e, R.me, owner.cookie)).json()) as Me;
    expect(asOwner.instance.directory?.state).toBe("scope_missing");
    const member = await login(uniq("sync-member"), "member");
    const asMember = (await (await get(e, R.me, member.cookie)).json()) as Me;
    expect(asMember.instance.directory).toMatchObject({
      mode: "google",
      state: null,
      staleAt: null,
      heldSweeps: 0,
      banner: false,
    });
  });
});

/**
 * env.DB whose statements matching `fault.match` throw (`fault.times` times),
 * in .all/.first/.run and in a batch: a D1 failure injected at one point.
 */
const fault = { match: /$^/, times: 0, skip: 0 };
const hit = (sql: string) => {
  if (fault.times > 0 && fault.match.test(sql)) {
    if (fault.skip > 0) {
      fault.skip--;
      return;
    }
    fault.times--;
    throw new Error("injected D1 failure");
  }
};
/** The next `skip`+1-th statement matching `match` waits for release(). */
const gates: {
  match: RegExp;
  skip: number;
  arrive: () => void;
  wait: Promise<void>;
  used: boolean;
}[] = [];
function d1Gate(match: RegExp, skip = 0) {
  let arrive = () => {};
  let release = () => {};
  const hit = new Promise<void>((r) => {
    arrive = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  gates.push({ match, skip, arrive, wait, used: false });
  return { hit, release };
}
async function dbGate(sql: string) {
  const gt = gates.find((x) => !x.used && x.match.test(sql));
  if (!gt) return;
  if (gt.skip > 0) {
    gt.skip--;
    return;
  }
  gt.used = true;
  gt.arrive();
  await gt.wait;
}
const sqlOf = new WeakMap<object, string>();
const unwrap = new WeakMap<object, D1PreparedStatement>();
const wrapStmt = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
  const w = new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a), sql);
      if (p === "all" || p === "first" || p === "run" || p === "raw")
        return async (...a: unknown[]) => {
          hit(sql);
          await dbGate(sql);
          return (t[p] as (...x: unknown[]) => unknown).apply(t, a);
        };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  sqlOf.set(w, sql);
  unwrap.set(w, s);
  return w;
};
const flakyDb = new Proxy(env.DB, {
  get(t, p) {
    if (p === "prepare") return (q: string) => wrapStmt(t.prepare(q), q);
    if (p === "batch")
      return async (ss: D1PreparedStatement[]) => {
        for (const s of ss) hit(sqlOf.get(s) ?? "");
        // Batches need the runtime's own statement objects.
        const out = await t.batch(ss.map((s) => realOf(s)));
        // A gated batch has committed; its caller waits for the result.
        for (const s of ss) await dbGate(sqlOf.get(s) ?? "");
        return out;
      };
    const v = Reflect.get(t, p);
    return typeof v === "function" ? v.bind(t) : v;
  },
});
/** The runtime statement behind a wrapper. */
const realOf = (s: D1PreparedStatement): D1PreparedStatement =>
  unwrap.get(s) ?? s;

describe("review fixes (P3 T13)", () => {
  // H1, H2: a D1 failure at any point of a walk or sweep commits nothing, so
  // the retry neither skips a page nor sweeps with an empty seen set.
  it.each([
    [
      "the member id lookup",
      /from identities\s+where provider = 'google' and directory_bound = 1/,
    ],
    ["the nested group write", /insert into directory_groups/],
    ["the stored members read", /^select user_id from directory_members/],
    ["the member count", /count\(\*\) as n from directory_members/],
    ["the diff batch", /insert or ignore into directory_members/],
  ])("a throw at %s removes nobody wrongly", async (_n, match) => {
    const us = dirUsers(6, "inj");
    const child = `grp-injc-${crypto.randomUUID()}`;
    const gid = `grp-inj-${crypto.randomUUID()}`;
    g.addGroup({
      id: child,
      email: `${child}@a.com`,
      members: [us[5]?.id ?? ""],
    });
    await mappedGroup(gid, [...us.slice(0, 5).map((u) => u.id), child]);
    g.setMemberPageSize(2);
    const t0 = Date.now();
    await connected(t0);
    const all = await membersOf(gid);
    expect(all).toHaveLength(6);
    const gone = await uidOf(us[0]?.id as string);
    g.removeMember(gid, us[0]?.id as string);
    const flaky = { ...e, DB: flakyDb } as Env;
    // Fail each matching statement once, at every page in turn.
    for (let k = 0; k < 8; k++) {
      fault.match = match;
      fault.times = 1;
      await drain(t0 + 61 * MIN + k * 31 * MIN, flaky);
      const now = await membersOf(gid);
      // Never anyone but the one who left.
      expect(all.filter((u) => u !== gone).every((u) => now.includes(u))).toBe(
        true,
      );
    }
    fault.times = 0;
    await drain(t0 + 400 * MIN, flaky);
    expect(await membersOf(gid)).toEqual(all.filter((u) => u !== gone));
  });

  it("a persistent 4xx on one group removes nobody there and the run goes on", async () => {
    const [a, b] = dirUsers(2, "4xx");
    const bad = `grp-bad-${crypto.randomUUID()}`;
    const ok = `grp-ok-${crypto.randomUUID()}`;
    await mappedGroup(bad, [a?.id ?? ""]);
    await mappedGroup(ok, [b?.id ?? ""]);
    const t0 = Date.now();
    await connected(t0);
    expect(await membersOf(bad)).toHaveLength(1);
    g.removeMember(bad, a?.id as string);
    g.removeMember(ok, b?.id as string);
    g.fail(new RegExp(`/groups/${bad}/members`), 403, { times: 1000 });
    await drain(t0 + 61 * MIN);
    expect(await membersOf(bad)).toHaveLength(1);
    expect(await membersOf(ok)).toEqual([]);
    expect((await status()).state).toBe("ok");
  });

  it("the fast path runs while a reconcile is stuck backing off", async () => {
    const [u] = dirUsers(1, "stuck");
    const gid = `grp-stuck-${crypto.randomUUID()}`;
    await mappedGroup(gid, [u?.id ?? ""]);
    const t0 = Date.now();
    await connected(t0);
    // The reconcile's group read keeps failing (5xx): it stays in flight.
    g.fail(new RegExp(`/groups/${gid}/members`), 503, { times: 1000 });
    await drain(t0 + 61 * MIN);
    expect(await kv("run.rec")).not.toBeNull();
    (g.users.get(u?.id as string) as { suspended?: boolean }).suspended = true;
    g.activity(
      "admin",
      "SUSPEND_USER",
      { USER_EMAIL: u?.primaryEmail ?? "" },
      t0 + 90 * MIN,
    );
    // Past the backoff, the fast lane goes first.
    await drain(t0 + 95 * MIN);
    expect(await statusOf(await uidOf(u?.id as string))).toBe("suspended");
  });

  it("the alarm is set again even when a step and the failure record throw", async () => {
    const t0 = Date.now();
    await connected(t0);
    const broken = {
      ...e,
      DB: new Proxy(env.DB, {
        get(t, p) {
          if (p === "batch") return () => Promise.reject(new Error("D1 down"));
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    g.fail(/\/reports\/admin/, 503, { times: 5 });
    await inDo((s) => s.storage.deleteAlarm());
    await tick(t0 + 2 * MIN, broken);
    expect(await inDo((s) => s.storage.getAlarm())).not.toBeNull();
  });

  it("a steady fast tick writes no D1 rows", async () => {
    const [u] = dirUsers(1, "steady");
    const gid = `grp-steady-${crypto.randomUUID()}`;
    await mappedGroup(gid, [u?.id ?? ""]);
    const t0 = Date.now();
    await connected(t0);
    await drain(t0 + 2 * MIN);
    const w = { n: 0 };
    const note = (r: D1Result) => {
      w.n += r.meta.rows_written;
      return r;
    };
    const counted = {
      ...e,
      DB: new Proxy(env.DB, {
        get(t, p) {
          if (p === "batch")
            return async (ss: D1PreparedStatement[]) =>
              (await t.batch(ss)).map(note);
          if (p === "prepare")
            return (q: string) => {
              const s = t.prepare(q);
              const bindW = (x: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(x, {
                  get(tt, pp) {
                    if (pp === "bind")
                      return (...a: unknown[]) => bindW(tt.bind(...a));
                    if (pp === "run" || pp === "all")
                      return async () =>
                        note(
                          await (tt[pp] as () => Promise<D1Result>).call(tt),
                        );
                    const v = Reflect.get(tt, pp);
                    return typeof v === "function" ? v.bind(tt) : v;
                  },
                });
              return bindW(s);
            };
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    await drain(t0 + 4 * MIN, counted);
    await drain(t0 + 6 * MIN, counted);
    expect(w.n).toBe(0);
  });

  it("a failure before any success is audited once, not on every retry", async () => {
    g.fail(/\/reports\/admin/, 503, { times: 1000 });
    await connect(e, owner.cookie, g, { sub: adminSub });
    const t0 = Date.now();
    await inDo((s) =>
      s.storage.sql.exec(
        "insert or replace into kv (k, v) values ('next.reconcile', ?)",
        JSON.stringify(t0 + 10 * 60 * MIN),
      ),
    );
    await inDo((s) => s.storage.sql.exec("delete from kv where k = 'reasons'"));
    for (let k = 0; k < 4; k++) await drain(t0 + k * 40 * MIN);
    expect((await status()).state).toBe("never");
    const n = await env.DB.prepare(
      "select count(*) n from audit_events where action = 'directory.sync.failed' and at >= ?",
    )
      .bind(t0)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("a failure in the alarm that held a sweep keeps the held entry", async () => {
    const us = dirUsers(4, "keep");
    const gid = `grp-keep-${crypto.randomUUID()}`;
    const other = `grp-keep2-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.slice(0, 3).map((u) => u.id),
    );
    await mappedGroup(other, [us[3]?.id ?? ""]);
    const t0 = Date.now();
    await connected(t0);
    g.setEmptyActive(true);
    g.removeMember(gid, us[0]?.id as string);
    g.removeMember(other, us[3]?.id as string);
    // The next group's first read fails in the same alarm as the hold.
    fault.match = /count\(\*\) as n from directory_members/;
    fault.times = 1;
    fault.skip = 1;
    await drain(t0 + 61 * MIN, { ...e, DB: flakyDb } as Env);
    fault.times = 0;
    const st = await status();
    expect(st.state).not.toBe("ok");
    expect(st.held.map((h) => h.groupId)).toContain(gid);
  });

  it("a listed user without a customerId counts as a mismatch", async () => {
    const [u] = dirUsers(1, "nocid");
    const t0 = Date.now();
    await connected(t0);
    (g.users.get(u?.id as string) as { customerId?: string }).customerId = "";
    await drain(t0 + 61 * MIN);
    expect((await status()).state).toBe("customer_mismatch");
  });

  it("suspension events past the first 100 on a page carry over", async () => {
    const us = dirUsers(130, "many");
    const t0 = Date.now();
    await connected(t0);
    for (const u of us) {
      (g.users.get(u.id) as { suspended?: boolean }).suspended = true;
      g.activity("admin", "SUSPEND_USER", { USER_EMAIL: u.primaryEmail });
    }
    await drain(t0 + 2 * MIN);
    for (const u of [us[0], us[99], us[100], us[129]])
      expect(await statusOf(await uidOf(u?.id as string))).toBe("suspended");
  });

  it("a new binding clears the old health, holds, active count and cursors", async () => {
    const us = dirUsers(3, "swap");
    const gid = `grp-swap-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    g.setEmptyActive(true);
    g.removeMember(gid, us[0]?.id as string);
    await drain(t0 + 61 * MIN);
    expect((await status()).held).toHaveLength(1);
    expect(await kv("cursor.admin")).not.toBeNull();
    // Reconnect and confirm (T12's swap): DirectorySync forgets it all, on
    // its next alarm.
    const r = await connect(e, owner.cookie, g, { sub: adminSub });
    expect(r.ok).toBe(true);
    g.setEmptyActive(false);
    await inDo((s) =>
      new SyncEngine(env as unknown as Env, s.storage).alarm(Date.now()),
    );
    expect((await status()).held).toEqual([]);
    expect((await readHealth(e)).state).toBe("never");
    for (const k of ["lastActive", "cursor.admin", "cursor.groups"])
      expect(await kv(k)).toBeNull();
  });

  it("during a backoff, Sync now and mapping kicks share one run per 10 min", async () => {
    const t0 = Date.now();
    await connected(t0);
    // The reconcile's user listing keeps failing: the rec lane backs off.
    g.fail(/^\/users\?/, 503, { times: 1000 });
    const lists = () => g.adminCalls.filter((c) => c === "/users").length;
    const kickAt = (r: "manual" | "mapping", at: number) =>
      inDo((s) => new SyncEngine(e, s.storage).kick(r, at));
    await kickAt("manual", t0 + MIN);
    await drain(t0 + MIN);
    expect(await kv<number>("retryAt.rec")).toBeGreaterThan(t0 + MIN);
    let n = lists();
    await kickAt("manual", t0 + 2 * MIN);
    await drain(t0 + 2 * MIN);
    expect(lists()).toBe(n + 1);
    n = lists();
    await kickAt("manual", t0 + 2 * MIN + 30_000);
    await drain(t0 + 2 * MIN + 30_000);
    await kickAt("mapping", t0 + 2 * MIN + 40_000);
    await drain(t0 + 2 * MIN + 40_000);
    expect(lists()).toBe(n);
  });

  it("a loop of mapping kicks during auth_failed gives at most one run per window", async () => {
    const t0 = Date.now();
    await connected(t0);
    g.setRefreshStatus(400);
    // Both lanes fail: the fast tick, and a reconcile asked for by Sync now.
    await inDo((s) =>
      new SyncEngine(e, s.storage).kick("manual", t0 + 2 * MIN),
    );
    await drain(t0 + 2 * MIN);
    expect((await status()).state).toBe("auth_failed");
    expect(await kv<number>("retryAt.rec")).toBeGreaterThan(t0 + 30 * MIN);
    const refreshes = () =>
      g.tokenCalls.filter((c) => c.get("grant_type") === "refresh_token")
        .length;
    const n = refreshes();
    for (let k = 0; k < 9; k++) {
      const at = t0 + 3 * MIN + k * MIN;
      await inDo((s) => new SyncEngine(e, s.storage).kick("mapping", at));
      await drain(at);
    }
    expect(refreshes() - n).toBe(1);
    const at = t0 + 3 * MIN + 11 * MIN;
    await inDo((s) => new SyncEngine(e, s.storage).kick("mapping", at));
    await drain(at);
    expect(refreshes() - n).toBe(2);
  });

  it("a mapping PUT that changes nothing kicks nothing", async () => {
    await connect(e, owner.cookie, g, { sub: adminSub });
    const gid = `grp-same-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "insert into directory_groups (group_id, email) values (?, ?)",
    )
      .bind(gid, `${gid}@a.com`)
      .run();
    const put = () =>
      fetchAndWait(
        app,
        new Request(`${APP}${R.orgMapping(gid)}`, {
          method: "PUT",
          headers: {
            "x-oa-request": "1",
            "content-type": "application/json",
            cookie: owner.cookie,
          },
          body: JSON.stringify({ role: "viewer" }),
        }),
        e,
      );
    await inDo((s) => s.storage.sql.exec("delete from kv where k = 'reasons'"));
    expect((await put()).status).toBe(200);
    expect(await kv<string[]>("reasons")).toContain("mapping");
    await inDo((s) => s.storage.sql.exec("delete from kv where k = 'reasons'"));
    expect((await put()).status).toBe(200);
    expect(await kv("reasons")).toBeNull();
  });

  it("the reconcile never removes a member the fast lane added after its walk began", async () => {
    const us = dirUsers(5, "late");
    const gid = `grp-late-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.slice(0, 4).map((u) => u.id),
    );
    g.setMemberPageSize(1);
    const t0 = Date.now();
    await connected(t0);
    const at = t0 + 61 * MIN;
    // The reconcile reads the group's first page.
    for (let i = 0; i < 40; i++) {
      await tick(at);
      const rec = await kv<{
        queue: { kind: string; target?: string; had?: number | null }[];
      }>("run.rec");
      const head = rec?.queue[0];
      if (head?.kind === "walk" && head.had !== null && head.target === gid)
        break;
    }
    // In Google, us[4] replaces us[0] on the page already read; the fast
    // lane then adds us[4] (its row is newer than the walk).
    const fg = g.groups.get(gid);
    if (fg) fg.members[0] = us[4]?.id as string;
    const late = await uidOf(us[4]?.id as string);
    await env.DB.prepare(
      "insert into directory_members (group_id, user_id, gen) values (?, ?, ?)",
    )
      .bind(gid, late, at + 1)
      .run();
    await drain(at);
    expect(await membersOf(gid)).toContain(late);
  });

  it("a reset during an alarm's Google call commits nothing of that run", async () => {
    const us = dirUsers(6, "rst");
    const gid = `grp-rst-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    g.setMemberPageSize(2);
    const t0 = Date.now();
    await connected(t0);
    const all = await membersOf(gid);
    expect(all).toHaveLength(6);
    const gate = g.gate(new RegExp(`/groups/${gid}/members\\?.*pageToken=2`));
    await inDo(async (s) => {
      const a = new SyncEngine(e, s.storage);
      let stop = false;
      const loop = (async () => {
        for (let i = 0; i < 40 && !stop; i++) await a.alarm(t0 + 61 * MIN);
      })();
      await gate.hit;
      // The reconnect's reset lands while page 2 is in flight.
      await new SyncEngine(e, s.storage).reset();
      gate.release();
      stop = true;
      await loop;
    });
    await drain(t0 + 62 * MIN);
    expect(await membersOf(gid)).toEqual(all);
  });

  it("a confirm applies at most the removals shown; more holds again and the click is spent", async () => {
    const us = dirUsers(6, "cap");
    const gid = `grp-cap-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    for (const u of us.slice(0, 4)) g.removeMember(gid, u.id);
    await drain(t0 + 61 * MIN);
    expect((await status()).held[0]).toMatchObject({ wouldRemove: 4 });
    g.removeMember(gid, us[4]?.id as string);
    await inDo((s) =>
      new SyncEngine(e, s.storage).confirmHeld(gid, undefined, t0 + 62 * MIN),
    );
    await drain(t0 + 62 * MIN);
    expect(await membersOf(gid)).toHaveLength(6);
    expect((await status()).held[0]).toMatchObject({ wouldRemove: 5 });
    const row = await inDo(
      (s) =>
        s.storage.sql
          .exec("select confirmed_at from held where group_id = ?", gid)
          .toArray()[0],
    );
    expect(row?.confirmed_at).toBeNull();
  });

  it("a confirm expires after 24 h", async () => {
    const us = dirUsers(6, "exp");
    const gid = `grp-exp-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    for (const u of us.slice(0, 4)) g.removeMember(gid, u.id);
    await drain(t0 + 61 * MIN);
    // Clicked at +62 min; the first sweep after it runs 25 h later.
    await inDo((s) => {
      s.storage.sql.exec(
        "update held set confirmed_at = ? where group_id = ?",
        t0 + 62 * MIN,
        gid,
      );
    });
    await drain(t0 + 62 * MIN + 25 * 60 * MIN);
    expect(await membersOf(gid)).toHaveLength(6);
    expect((await status()).held.map((h) => h.groupId)).toEqual([gid]);
  });

  it("a failing reconcile keeps sync unhealthy while the fast lane succeeds", async () => {
    const t0 = Date.now() - 3 * 60 * MIN;
    await connected(t0);
    const mark = Date.now();
    g.fail(/^\/users\?/, 503, { times: 10_000 });
    for (let k = 1; k <= 8; k++) await drain(t0 + 61 * MIN + k * 16 * MIN);
    const h = await readHealth(e);
    expect(h.state).not.toBe("ok");
    expect(h.lanes).toMatchObject({ fast: null, rec: "backoff" });
    expect(
      instanceDirectory("google", h, true, t0 + 61 * MIN + 8 * 16 * MIN).banner,
    ).toBe(true);
    const n = await env.DB.prepare(
      "select count(*) n from audit_events where action = 'directory.sync.failed' and detail like '%\"lane\":\"rec\"%' and at >= ?",
    )
      .bind(mark)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("a stuck fast lane doesn't starve the reconcile", async () => {
    const t0 = Date.now();
    await connected(t0);
    g.fail(/\/reports\/admin/, 503, { times: 10_000 });
    await drain(t0 + 61 * MIN);
    expect(await kv<number>("next.reconcile")).toBe(t0 + 61 * MIN + 60 * MIN);
  });

  it("a groups.get refusal on an over-half sweep holds it", async () => {
    const us = dirUsers(6, "gget");
    const gid = `grp-gget-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    for (const u of us.slice(0, 4)) g.removeMember(gid, u.id);
    g.fail(new RegExp(`^/groups/${gid}\\?`), 403, { times: 10 });
    await drain(t0 + 61 * MIN);
    expect(await membersOf(gid)).toHaveLength(6);
    expect((await status()).held.map((h) => h.groupId)).toEqual([gid]);
  });

  it("a group refusing 3 reconciles in a row is surfaced as held and can't be confirmed", async () => {
    const [u] = dirUsers(1, "unr");
    const gid = `grp-unr-${crypto.randomUUID()}`;
    await mappedGroup(gid, [u?.id ?? ""]);
    const t0 = Date.now();
    await connected(t0);
    g.fail(new RegExp(`/groups/${gid}/members`), 403, { times: 10_000 });
    await drain(t0 + 61 * MIN);
    await drain(t0 + 122 * MIN);
    expect((await status()).held).toEqual([]);
    await drain(t0 + 183 * MIN);
    expect((await status()).held[0]).toMatchObject({
      groupId: gid,
      wouldRemove: 0,
    });
    expect(await membersOf(gid)).toHaveLength(1);
    expect(
      (await post(e, R.directoryHeldConfirm(gid), owner.cookie)).status,
    ).toBe(409);
    // Readable again: released.
    g.clearFailures();
    await drain(t0 + 244 * MIN);
    expect((await status()).held).toEqual([]);
  });

  it("confirm while frozen is 409 directory_sync_off; a click during a sweep is kept", async () => {
    const us = dirUsers(6, "click");
    const gid = `grp-click-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    for (const u of us.slice(0, 4)) g.removeMember(gid, u.id);
    await drain(t0 + 61 * MIN);
    const frozen = { ...e, FEATURES: "spaces,sync_frozen" } as Env;
    const r = await post(frozen, R.directoryHeldConfirm(gid), owner.cookie);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("directory_sync_off");
    // The next reconcile's sweep re-holds; the click lands meanwhile.
    const gate = g.gate(new RegExp(`^/groups/${gid}\\?`));
    const at = t0 + 122 * MIN;
    await inDo(async (s) => {
      let stop = false;
      const loop = (async () => {
        for (let i = 0; i < 60 && !stop; i++)
          await new SyncEngine(e, s.storage).alarm(at);
      })();
      await gate.hit;
      await new SyncEngine(e, s.storage).confirmHeld(gid, undefined, at);
      gate.release();
      stop = true;
      await loop;
    });
    const row = await inDo(
      (s) =>
        s.storage.sql
          .exec("select confirmed_at from held where group_id = ?", gid)
          .toArray()[0],
    );
    expect(
      row?.confirmed_at === at || (await membersOf(gid)).length === 2,
    ).toBe(true);
    // Either way the click applies: the removals go through.
    await drain(at);
    expect(await membersOf(gid)).toHaveLength(2);
  });

  it("the fast lane leaves a group the reconcile is walking", async () => {
    const us = dirUsers(10, "walk");
    const gid = `grp-walk-${crypto.randomUUID()}`;
    const email = await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    g.setMemberPageSize(1);
    const t0 = Date.now();
    await connected(t0);
    const at = t0 + 61 * MIN;
    // Run the reconcile until it is mid-walk of the group.
    for (let i = 0; i < 40; i++) {
      await tick(at);
      const rec = await kv<{ queue: { kind: string; had?: number | null }[] }>(
        "run.rec",
      );
      const head = rec?.queue[0];
      if (head?.kind === "walk" && head.had !== null) break;
    }
    g.activity("groups", "add_user", { group_email: email }, at);
    const later = at + 3 * MIN;
    for (let i = 0; i < 8; i++) await tick(later);
    expect(await kv("run.rec")).not.toBeNull();
    const dirty = await inDo((s) =>
      s.storage.sql.exec("select group_id from dirty").toArray(),
    );
    expect(dirty.map((r) => r.group_id)).toContain(gid);
    await drain(later);
    expect(await membersOf(gid)).toHaveLength(10);
  });
  it("a reset during the sweep's group-row read removes nobody (group under 5)", async () => {
    const us = dirUsers(3, "rsw");
    const gid = `grp-rsw-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    const all = await membersOf(gid);
    const flaky = { ...e, DB: flakyDb } as Env;
    const gate = d1Gate(/^select email from directory_groups where group_id/);
    await inDo(async (s) => {
      let stop = false;
      const loop = (async () => {
        for (let i = 0; i < 40 && !stop; i++)
          await new SyncEngine(flaky, s.storage).alarm(t0 + 61 * MIN);
      })();
      await gate.hit;
      await new SyncEngine(e, s.storage).reset(t0 + 61 * MIN);
      gate.release();
      stop = true;
      await loop;
    });
    expect(await membersOf(gid)).toEqual(all);
    await drain(t0 + 62 * MIN);
    expect(await membersOf(gid)).toEqual(all);
  });

  it("a reset during fail()'s health read carries no failure to the new binding", async () => {
    const t0 = Date.now();
    await connected(t0);
    g.fail(/\/reports\/admin/, 503, { times: 1 });
    const flaky = { ...e, DB: flakyDb } as Env;
    // The alarm's second directory_state read (readRetire is its first).
    const gate = d1Gate(
      /^select value from directory_state where key = \?$/,
      1,
    );
    await inDo(async (s) => {
      const a = new SyncEngine(flaky, s.storage);
      const p = a.alarm(t0 + 2 * MIN);
      await gate.hit;
      await new SyncEngine(e, s.storage).reset(t0 + 2 * MIN);
      gate.release();
      await p;
    });
    // The new epoch's first alarm clears; no failure was written.
    await inDo((s) =>
      new SyncEngine(env as unknown as Env, s.storage).alarm(t0 + 2 * MIN),
    );
    const h = await readHealth(e);
    expect(h).toMatchObject({
      state: "never",
      lastError: null,
      lanes: { fast: null, rec: null },
    });
    expect(await kv("retryAt.fast")).toBeNull();
  });

  it("a reset clears the cached access token", async () => {
    const t0 = Date.now();
    await connected(t0);
    const refreshes = () =>
      g.tokenCalls.filter((c) => c.get("grant_type") === "refresh_token")
        .length;
    await inDo(async (s) => {
      const a = new SyncEngine(e, s.storage);
      await a.alarm(t0 + 2 * MIN);
      const n = refreshes();
      await a.alarm(t0 + 2 * MIN);
      expect(refreshes()).toBe(n);
      await a.reset(t0 + 2 * MIN);
      await a.alarm(t0 + 2 * MIN);
      expect(refreshes()).toBe(n + 1);
    });
  });

  it("a reset during the apply batch still closes the removed users' sockets", async () => {
    const us = dirUsers(3, "rsk");
    const gid = `grp-rsk-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    const gone = await uidOf(us[0]?.id as string);
    g.removeMember(gid, us[0]?.id as string);
    const flaky = { ...e, DB: flakyDb } as Env;
    const gate = d1Gate(/^insert or ignore into directory_members/);
    await inDo(async (s) => {
      let stop = false;
      const loop = (async () => {
        for (let i = 0; i < 40 && !stop; i++)
          await new SyncEngine(flaky, s.storage).alarm(t0 + 61 * MIN);
      })();
      await gate.hit;
      await new SyncEngine(e, s.storage).reset(t0 + 61 * MIN);
      gate.release();
      stop = true;
      await loop;
    });
    // The removal committed, so its socket close ran too.
    expect(await membersOf(gid)).not.toContain(gone);
    const ns = env.USER_PRESENCE as NonNullable<Env["USER_PRESENCE"]>;
    const revoked = await runInDurableObject(
      ns.get(ns.idFromName(gone)),
      (_i, st) =>
        st.storage.sql
          .exec("select revoked_at from state where id = 1")
          .toArray()[0]?.revoked_at,
    );
    expect(Number(revoked)).toBeGreaterThan(0);
  });

  it("a held entry isn't re-added after a reset", async () => {
    const us = dirUsers(3, "rha");
    const gid = `grp-rha-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    g.setEmptyActive(true);
    g.removeMember(gid, us[0]?.id as string);
    const flaky = { ...e, DB: flakyDb } as Env;
    const gate = d1Gate(/^select email from directory_groups where group_id/);
    await inDo(async (s) => {
      let stop = false;
      const loop = (async () => {
        for (let i = 0; i < 40 && !stop; i++)
          await new SyncEngine(flaky, s.storage).alarm(t0 + 61 * MIN);
      })();
      await gate.hit;
      await new SyncEngine(e, s.storage).reset(t0 + 61 * MIN);
      gate.release();
      stop = true;
      await loop;
    });
    await inDo((s) =>
      new SyncEngine(env as unknown as Env, s.storage).alarm(t0 + 61 * MIN),
    );
    expect((await status()).held).toEqual([]);
    expect(
      await inDo((s) => s.storage.sql.exec("select * from held").toArray()),
    ).toEqual([]);
  });

  it("the fast lane clears the dirty marks of the groups it did walk", async () => {
    const us = dirUsers(11, "mk");
    const big = `grp-mkbig-${crypto.randomUUID()}`;
    const small = `grp-mksm-${crypto.randomUUID()}`;
    const bigEmail = await mappedGroup(
      big,
      us.slice(0, 10).map((u) => u.id),
    );
    const smallEmail = await mappedGroup(small, [us[10]?.id ?? ""]);
    g.setMemberPageSize(1);
    const t0 = Date.now();
    await connected(t0);
    const at = t0 + 61 * MIN;
    // The reconcile walks `big` first (one member per page).
    for (let i = 0; i < 40; i++) {
      await tick(at);
      const rec = await kv<{
        queue: { kind: string; target?: string; had?: number | null }[];
      }>("run.rec");
      const head = rec?.queue[0];
      if (head?.kind === "walk" && head.had !== null && head.target === big)
        break;
    }
    // Both groups changed; the rec lane is still walking `big`.
    g.activity("groups", "add_user", { group_email: bigEmail }, at);
    g.activity("groups", "add_user", { group_email: smallEmail }, at);
    const later = at + 3 * MIN;
    for (let i = 0; i < 8; i++) await tick(later);
    const rec = await kv<{ queue: { kind: string; target?: string }[] }>(
      "run.rec",
    );
    expect(rec?.queue[0]).toMatchObject({ kind: "walk", target: big });
    const dirty = (
      await inDo((s) =>
        s.storage.sql.exec("select group_id from dirty").toArray(),
      )
    ).map((r) => r.group_id);
    expect(dirty).toContain(big);
    expect(dirty).not.toContain(small);
  });
});

describe("google.ts parsing (fixtures)", () => {
  const answer = (body: unknown, status = 200) =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(body, { status }));

  it("users.list, members.list and Reports pages parse to the internal shapes", async () => {
    vi.restoreAllMocks();
    const p = parseUsersPage(usersPage, true);
    expect(p.nextPageToken).toBe("page-2");
    expect(p.users[1]).toMatchObject({ suspended: true, deleted: true });
    answer(membersPage);
    const m = await listMembers("t", "eng@example.com");
    expect(m.members.map((x) => x.type)).toEqual(["USER", "GROUP", "CUSTOMER"]);
    expect(m.members[1]?.email).toBe("eng-sub@example.com");
    vi.restoreAllMocks();
    answer(adminEvents);
    const a = await activities("t", "C0123", "admin", 0);
    expect(a.events.map((x) => x.name)).toEqual([
      "SUSPEND_USER",
      "REMOVE_GROUP_MEMBER",
    ]);
    expect(a.events[1]?.params.GROUP_EMAIL).toBe("eng@example.com");
    vi.restoreAllMocks();
    answer(
      { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } },
      403,
    );
    await expect(listMembers("t", "x")).rejects.toMatchObject({
      status: 403,
      reason: "insufficientPermissions",
    });
  });
});

describe("kicks and the group lookup", () => {
  const reasons = () =>
    inDo(
      (s) =>
        s.storage.sql.exec("select v from kv where k = 'reasons'").toArray()[0]
          ?.v,
    );

  it("putOrgMapping kicks DirectorySync with mapping", async () => {
    await connect(e, owner.cookie, g, { sub: adminSub });
    const gid = `grp-kick-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "insert into directory_groups (group_id, email) values (?, ?)",
    )
      .bind(gid, `${gid}@a.com`)
      .run();
    await inDo((s) => s.storage.sql.exec("delete from kv"));
    const r = await fetchAndWait(
      app,
      new Request(`${APP}${R.orgMapping(gid)}`, {
        method: "PUT",
        headers: {
          "x-oa-request": "1",
          "content-type": "application/json",
          cookie: owner.cookie,
        },
        body: JSON.stringify({ role: "viewer" }),
      }),
      e,
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(String(await reasons()))).toContain("mapping");
  });

  it("GET R.directoryGroups: live lookup for admins, recorded for mapping, RL_DIRECTORY 429", async () => {
    await connect(e, owner.cookie, g, { sub: adminSub });
    const gid = `grp-look-${crypto.randomUUID()}`;
    g.addGroup({ id: gid, email: `${gid}@a.com`, name: "Look", members: [] });
    const r = await get(e, `${R.directoryGroups}?q=grp-look`, owner.cookie);
    expect(r.status).toBe(200);
    const page = (await r.json()) as { items: { groupId: string }[] };
    expect(page.items.map((x) => x.groupId)).toContain(gid);
    const row = await env.DB.prepare(
      "select email from directory_groups where group_id = ?",
    )
      .bind(gid)
      .first<{ email: string }>();
    expect(row?.email).toBe(`${gid}@a.com`);
    const member = await login(uniq("look-member"), "member");
    expect((await get(e, R.directoryGroups, member.cookie)).status).toBe(404);
    const limited = {
      ...e,
      RL_DIRECTORY: { limit: async () => ({ success: false }) },
    } as unknown as Env;
    expect((await get(limited, R.directoryGroups, owner.cookie)).status).toBe(
      429,
    );
  });

  it("POST R.directorySync (Sync now) is the org owner's: 202 SyncStatus", async () => {
    await connect(e, owner.cookie, g, { sub: adminSub });
    const r = await post(e, R.directorySync, owner.cookie);
    expect(r.status).toBe(202);
    expect(JSON.parse(String(await reasons()))).toContain("manual");
    const member = await login(uniq("sync-now-member"), "member");
    expect((await post(e, R.directorySync, member.cookie)).status).toBe(404);
  });
});

describe("P2.5 #5: restricted_sync is recomputed for everyone on each reconcile", () => {
  const restrictedOf = async (sub: string) =>
    (
      await env.DB.prepare(
        "select u.restricted_sync as r from users u join identities i on i.user_id = u.id where i.provider = 'google' and i.subject = ?",
      )
        .bind(sub)
        .first<{ r: number }>()
    )?.r;
  /** The next reconcile is due (its own interval past t). */
  const nextRec = (t: number) => t + RECONCILE_MS + FAST_MS;

  it("a new hire outside any restricted group is not restricted; one inside is", async () => {
    const [inGroup, outside] = dirUsers(2, "rs");
    const gid = `grp-rs-${crypto.randomUUID()}`;
    await mappedGroup(gid, [inGroup?.id ?? ""], "restricted");
    const t0 = Date.now();
    await connected(t0);
    expect(await restrictedOf(inGroup?.id as string)).toBe(1);
    // Hired later: created by the reconcile's listing (fail closed), lifted
    // by its finish.
    const [later] = dirUsers(1, "rs-later");
    await drain(nextRec(t0));
    expect(await restrictedOf(later?.id as string)).toBe(0);
    expect(await restrictedOf(outside?.id as string)).toBe(0);
    expect(await restrictedOf(inGroup?.id as string)).toBe(1);
  });

  it("a restricted group that could not be read keeps new hires restricted (fail closed)", async () => {
    const [inGroup] = dirUsers(1, "rs-ref");
    const gid = `grp-rs-ref-${crypto.randomUUID()}`;
    await mappedGroup(gid, [inGroup?.id ?? ""], "restricted");
    const t0 = Date.now();
    await connected(t0);
    g.fail(new RegExp(`/groups/${gid}/members`), 403, { times: 1000 });
    const [later] = dirUsers(1, "rs-ref-later");
    await drain(nextRec(t0));
    expect(await uidOf(later?.id as string)).toBeTruthy();
    expect(await restrictedOf(later?.id as string)).toBe(1);
    // Readable again: the next reconcile lifts them.
    g.clearFailures();
    await drain(nextRec(nextRec(t0)));
    expect(await restrictedOf(later?.id as string)).toBe(0);
    expect(await restrictedOf(inGroup?.id as string)).toBe(1);
  });

  it("a user who left every restricted group outside any diff is lifted; one who joined is capped and loses live sockets", async () => {
    const [stays, left] = dirUsers(2, "rs-drift");
    const gid = `grp-rs-drift-${crypto.randomUUID()}`;
    await mappedGroup(gid, [stays?.id ?? "", left?.id ?? ""], "restricted");
    const t0 = Date.now();
    await connected(t0);
    const leftUid = await uidOf(left?.id as string);
    const staysUid = await uidOf(stays?.id as string);
    // Drift no diff touches: flags written behind sync's back.
    await env.DB.batch([
      env.DB.prepare("update users set restricted_sync = 0 where id = ?").bind(
        staysUid,
      ),
      env.DB.prepare(
        "delete from directory_members where group_id = ? and user_id = ?",
      ).bind(gid, leftUid),
    ]);
    g.removeMember(gid, left?.id as string);
    await drain(nextRec(t0));
    expect(await restrictedOf(left?.id as string)).toBe(0);
    expect(await restrictedOf(stays?.id as string)).toBe(1);
    // Newly capped: their UserPresence recorded the revocation.
    const ns = env.USER_PRESENCE as NonNullable<Env["USER_PRESENCE"]>;
    const revoked = await runInDurableObject(
      ns.get(ns.idFromName(staysUid)),
      (_i, s) =>
        s.storage.sql
          .exec("select revoked_at from state where id = 1")
          .toArray()[0]?.revoked_at,
    );
    expect(Number(revoked)).toBeGreaterThan(0);
  });

  /** A synced user row created at `at` (ms), restricted (fail closed). */
  async function hireAt(tag: string, at: number) {
    const sub = `g-${tag}-${crypto.randomUUID()}`;
    const uid = `u${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`;
    await env.DB.batch([
      env.DB.prepare(
        "insert into users (id, email, name, role, created_at, status, restricted_sync) values (?, ?, ?, 'member', ?, 'active', 1)",
      ).bind(uid, uniq(tag), tag, at),
      env.DB.prepare(
        "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
      ).bind(sub, uid, at),
    ]);
    return sub;
  }

  it("review #1a: a hire created after the restricted group's read began is not lifted by that run", async () => {
    const [inGroup] = dirUsers(1, "rs-race");
    const gid = `grp-rs-race-${crypto.randomUUID()}`;
    await mappedGroup(gid, [inGroup?.id ?? ""], "restricted");
    const t0 = Date.now();
    await connected(t0);
    const at = nextRec(t0);
    const gate = g.gate(new RegExp(`/groups/${gid}/members`));
    const run = drain(at);
    await gate.hit;
    // Created by the fast lane or a sign-in while the read is in flight: it
    // may be in the group, and the rows read predate it.
    const late = await hireAt("rs-race-late", at + 1);
    const early = await hireAt("rs-race-early", at - 1);
    gate.release();
    await run;
    expect(await restrictedOf(late)).toBe(1);
    expect(await restrictedOf(early)).toBe(0);
  });

  it("review #1b: a group restricted after the run planned blocks every lift that run", async () => {
    const [inGroup] = dirUsers(1, "rs-new");
    const gid = `grp-rs-new-${crypto.randomUUID()}`;
    await mappedGroup(gid, [inGroup?.id ?? ""], "restricted");
    const t0 = Date.now();
    await connected(t0);
    const gate = g.gate(new RegExp(`/groups/${gid}/members`));
    const run = drain(nextRec(t0));
    await gate.hit;
    // Restricted now, after the targets were planned: no rows, never read.
    const added = `grp-rs-added-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "insert into directory_groups (group_id, email) values (?, ?)",
      ).bind(added, `${added}@a.com`),
      env.DB.prepare(
        "insert into restricted_groups (group_id, group_email) values (?, ?)",
      ).bind(added, `${added}@a.com`),
    ]);
    const hire = await hireAt("rs-new-hire", 1);
    gate.release();
    await run;
    expect(await restrictedOf(hire)).toBe(1);
    // The next reconcile reads it: lifted (not a member).
    await drain(nextRec(nextRec(t0)));
    expect(await restrictedOf(hire)).toBe(0);
  });
});

describe("P2.5 scenarios: admin actions chained with a sync", () => {
  const send = (method: "PUT" | "DELETE", path: string, body?: unknown) =>
    fetchAndWait(
      app,
      new Request(`${APP}${path}`, {
        method,
        headers: {
          "x-oa-request": "1",
          "content-type": "application/json",
          cookie: owner.cookie,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      e,
    );
  const nextRec = (t: number) => t + RECONCILE_MS + FAST_MS;

  it("unmap, remove members in Google, remap: no access from the old rows, no over_half hold", async () => {
    const us = dirUsers(6, "remap");
    const gid = `grp-remap-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    expect(await membersOf(gid)).toHaveLength(6);
    expect((await send("DELETE", R.orgMapping(gid))).status).toBe(204);
    expect(await membersOf(gid)).toEqual([]);
    // Four leave in Google while nothing reads the group.
    for (const u of us.slice(0, 4)) g.removeMember(gid, u.id);
    expect(
      (await send("PUT", R.orgMapping(gid), { role: "viewer" })).status,
    ).toBe(200);
    // Nobody is granted anything before sync reads the group.
    expect(await membersOf(gid)).toEqual([]);
    await drain(nextRec(t0));
    const kept = await Promise.all(us.slice(4).map((u) => uidOf(u.id)));
    expect(await membersOf(gid)).toEqual([...kept].sort());
    expect((await status()).held).toEqual([]);
  });

  it("a walk that outlived an unmapping never brings the rows back", async () => {
    const us = dirUsers(2, "outlive");
    const gid = `grp-outlive-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    // The next reconcile is planned and has its targets; the unmapping lands
    // before its sweep.
    const gate = g.gate(new RegExp(`/groups/${gid}/members`));
    const run = drain(nextRec(t0));
    await gate.hit;
    expect((await send("DELETE", R.orgMapping(gid))).status).toBe(204);
    gate.release();
    await run;
    expect(await membersOf(gid)).toEqual([]);
  });

  it("reset a member's Google link, then sync: the same user is relinked and keeps restriction and group roles; nobody is held", async () => {
    const us = dirUsers(5, "reset");
    const [target] = us;
    const mapped = `grp-reset-map-${crypto.randomUUID()}`;
    const restricted = `grp-reset-rs-${crypto.randomUUID()}`;
    await mappedGroup(
      mapped,
      us.map((u) => u.id),
    );
    await mappedGroup(restricted, [target?.id ?? ""], "restricted");
    const t0 = Date.now();
    await connected(t0);
    const uid = await uidOf(target?.id as string);
    expect((await membersOf(mapped)).includes(uid)).toBe(true);
    expect((await send("DELETE", R.memberIdentity(uid, "google"))).status).toBe(
      204,
    );
    expect(await uidOf(target?.id as string)).toBeUndefined();
    await drain(nextRec(t0));
    // Relinked by email: the same row, still in both groups, still capped.
    expect(await uidOf(target?.id as string)).toBe(uid);
    expect(await statusOf(uid)).toBe("active");
    expect((await membersOf(mapped)).includes(uid)).toBe(true);
    expect(await membersOf(restricted)).toEqual([uid]);
    const r = await env.DB.prepare(
      "select restricted_sync as r from users where id = ?",
    )
      .bind(uid)
      .first<{ r: number }>();
    expect(r?.r).toBe(1);
    expect((await status()).held).toEqual([]);
  });

  it("reconnect (same Workspace) then confirm: one reset, then sync resumes on the new grant and keeps everyone", async () => {
    const us = dirUsers(3, "reconf");
    const gid = `grp-reconf-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    const before = await membersOf(gid);
    expect(before).toHaveLength(3);
    const r = await connect(
      e,
      owner.cookie,
      g,
      { sub: adminSub },
      {
        confirm: false,
      },
    );
    expect(r.consented).toBe(true);
    // Pending: the live binding keeps syncing; a removal in Google applies.
    g.removeMember(gid, us[0]?.id as string);
    await drain(nextRec(t0));
    const removed = await uidOf(us[0]?.id as string);
    expect(await membersOf(gid)).toEqual(before.filter((x) => x !== removed));
    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(200);
    await drain(nextRec(nextRec(t0)));
    expect((await status()).state).toBe("ok");
    expect(await membersOf(gid)).toEqual(before.filter((x) => x !== removed));
    for (const u of us)
      expect(await statusOf(await uidOf(u.id))).toBe("active");
  });
});

describe("P2.5 #15: a pending reconnect keeps the live binding synced and enforced", () => {
  /** Same Workspace, same super admin: a reconnect waiting for confirm. */
  async function reconnectPending() {
    const r = await connect(
      e,
      owner.cookie,
      g,
      { sub: adminSub },
      {
        confirm: false,
      },
    );
    expect(r.consented).toBe(true);
    expect((await status()).state).toBe("pending_confirm");
  }
  const suspendInGoogle = (
    u: { id: string; primaryEmail: string },
    at: number,
  ) => {
    (g.users.get(u.id) as { suspended?: boolean }).suspended = true;
    g.activity("admin", "SUSPEND_USER", { USER_EMAIL: u.primaryEmail }, at);
  };

  it("a Google suspension still applies on the next fast tick", async () => {
    const [u] = dirUsers(1, "pend-susp");
    const t0 = Date.now();
    await connected(t0);
    const uid = await uidOf(u?.id as string);
    await reconnectPending();
    suspendInGoogle(u as { id: string; primaryEmail: string }, t0 + FAST_MS);
    await drain(t0 + FAST_MS);
    expect(await statusOf(uid)).toBe("suspended");
  });

  it("sign-in still checks the directory: a user suspended in Google is refused", async () => {
    const [u] = dirUsers(1, "pend-signin");
    const t0 = Date.now();
    await connected(t0);
    const uid = await uidOf(u?.id as string);
    await reconnectPending();
    (g.users.get(u?.id as string) as { suspended?: boolean }).suspended = true;
    const row = await env.DB.prepare(
      "select id, email, name, role from users where id = ?",
    )
      .bind(uid)
      .first<{ id: string; email: string; name: string; role: string }>();
    await expect(
      directorySignIn(e, { ...row, displayName: null } as never),
    ).rejects.toMatchObject({ why: "suspended" });
    expect(await statusOf(uid)).toBe("suspended");
  });

  it("a first connect waiting for its owner syncs nothing", async () => {
    const [u] = dirUsers(1, "first-pend");
    const r = await connect(
      e,
      owner.cookie,
      g,
      { sub: adminSub },
      {
        confirm: false,
      },
    );
    expect(r.consented).toBe(true);
    const calls = g.adminCalls.length;
    await tick(Date.now());
    expect(g.adminCalls.length).toBe(calls);
    expect(await uidOf(u?.id as string)).toBeUndefined();
  });

  it("readPending ignores a consent past its exp; readPendingAny still returns it", async () => {
    await connect(e, owner.cookie, g, { sub: adminSub }, { confirm: false });
    const p = await readPendingAny(e);
    expect(p).not.toBeNull();
    const exp = p?.exp as number;
    expect(await readPending(e, exp - 1)).toMatchObject({ exp });
    expect(await readPending(e, exp)).toBeNull();
    expect(await readPendingAny(e)).toMatchObject({ exp });
  });
});
