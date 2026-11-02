// #412: the owner's snooze of a held directory sweep. Visibility only: the
// hold leaves the Settings dot and shows as snoozed, its removals stay held,
// and the snooze ends when the group's member list changes, after 30 days,
// when the owner applies the hold or cancels, or on a disconnect. The engine
// runs alarm by alarm on an explicit clock (as in directory.sync.test.ts),
// with Date pinned to midday UTC.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HELD_SNOOZE_MS, R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceDirectory, readHealth } from "../src/directory/health.js";
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { userActor } from "../src/services/audit.js";
import { SYNC_DO_NAME } from "../src/services/directory.js";
import { mailer, uniq } from "./auth-helpers.js";
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
import { errOf, fetchAndWait, login } from "./helpers.js";
import { pinMiddayUtc } from "./midday.js";

const MIN = 60_000;
let g: FakeDirectory;
let e: Env;
let owner: { cookie: string; userId: string; email: string };
let adminSub: string;
let t0: number;

const stub = () => {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) throw new Error("DIRECTORY_SYNC unbound");
  return ns.get(
    ns.idFromName(SYNC_DO_NAME),
  ) as unknown as DurableObjectStub<DirectorySync>;
};
const inDo = <T>(f: (s: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stub(), (_i, s) => f(s));
const engine = (s: DurableObjectState) => new SyncEngine(e, s.storage);

/** Alarms at `now` until no lane may run (directory.sync.test.ts drain). */
async function drain(now: number) {
  const done = await inDo(async (s) => {
    for (let i = 0; i < 80; i++) {
      await engine(s).alarm(now);
      if (!engine(s).due(now)) return true;
    }
    return false;
  });
  if (!done) throw new Error("run never finished");
}
const status = (): Promise<SyncStatus> => inDo((s) => engine(s).status());
const heldOf = async (gid: string) =>
  (await status()).held.find((h) => h.groupId === gid);
/** Me.instance.directory.heldSweeps for an owner at `now`. */
const dot = async (now: number) =>
  instanceDirectory("google", await readHealth(e), true, now).heldSweeps;
const membersOf = async (groupId: string) =>
  (
    await env.DB.prepare(
      "select user_id from directory_members where group_id = ? order by user_id",
    )
      .bind(groupId)
      .all<{ user_id: string }>()
  ).results.map((r) => r.user_id);
const snoozeRows = () =>
  inDo((s) => s.storage.sql.exec("select * from snoozed").toArray());
/**
 * This group's snooze audit rows, by action then why (rows written in the
 * same millisecond have no order of their own).
 */
const audits = async (gid: string) =>
  (
    await env.DB.prepare(
      `select action, actor_kind kind, actor_id id, json_extract(detail, '$.why') why
        from audit_events where target_id = ? and action in
        ('directory.sweep.snoozed', 'directory.sweep.unsnoozed')
        order by action, coalesce(why, '')`,
    )
      .bind(gid)
      .all<{
        action: string;
        kind: string;
        id: string | null;
        why: string | null;
      }>()
  ).results;

const send = (
  method: "POST" | "DELETE",
  path: string,
  cookie: string,
  body?: unknown,
  en: Env = e,
) =>
  fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      method,
      headers: {
        "x-oa-request": "1",
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    en,
  );
/** The owner's snooze through the engine, on the test clock. */
const snooze = (gid: string, at: number, reason: string | null = null) =>
  inDo((s) => engine(s).snoozeHeld(gid, userActor(owner.userId), reason, at));

/** Six directory users in a group mapped Every-space. */
async function group(tag: string) {
  const us = Array.from({ length: 6 }, (_, i) =>
    g.addUser({
      id: `g-${tag}-${i}-${crypto.randomUUID()}`,
      primaryEmail: uniq(`${tag}${i}`),
    }),
  );
  const gid = `grp-${tag}-${crypto.randomUUID()}`;
  const email = `${gid}@a.com`;
  g.addGroup({ id: gid, email, members: us.map((u) => u.id) });
  await env.DB.batch([
    env.DB.prepare(
      "insert or ignore into directory_groups (group_id, email) values (?, ?)",
    ).bind(gid, email),
    env.DB.prepare(
      "insert or replace into org_group_mappings (group_id, group_email, role) values (?, ?, 'viewer')",
    ).bind(gid, email),
  ]);
  return { gid, us };
}

/** Connects and runs the first reconcile at t0. */
async function connected() {
  const r = await connect(e, owner.cookie, g, { sub: adminSub });
  expect(r.ok).toBe(true);
  await drain(t0);
  expect((await status()).state).toBe("ok");
}

/** A group whose next reconcile (t0 + 61 min) holds 4 of 6 removals. */
async function heldGroup(tag: string) {
  const x = await group(tag);
  return {
    ...x,
    hold: async () => {
      for (const u of x.us.slice(0, 4)) g.removeMember(x.gid, u.id);
      await drain(t0 + 61 * MIN);
      expect((await heldOf(x.gid))?.wouldRemove).toBe(4);
    },
  };
}

beforeEach(async () => {
  t0 = pinMiddayUtc();
  await resetDirectory();
  await env.DB.batch([
    env.DB.prepare("delete from org_group_mappings"),
    env.DB.prepare("delete from restricted_groups"),
    env.DB.prepare("delete from directory_members"),
    env.DB.prepare("delete from directory_groups"),
    env.DB.prepare("delete from counters where key = 'email:*'"),
  ]);
  await inDo(async (s) => {
    // A fresh engine creates the tables (snoozed included) first.
    engine(s);
    for (const t of ["kv", "seen", "dirty", "held", "refused", "snoozed"])
      s.storage.sql.exec(`delete from ${t}`);
    await s.storage.deleteAlarm();
  });
  await registerInstall();
  g = fakeDirectory();
  e = directEnv(mailer().env);
  const email = uniq("snooze-owner");
  owner = { ...(await login(email, "owner")), email };
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("held sweep snooze (#412)", () => {
  it("POST snoozes: off the dot, shown snoozed with until and the cleaned reason; nothing is applied", async () => {
    const a = await heldGroup("vis");
    await connected();
    await a.hold();
    const before = await membersOf(a.gid);
    expect(before).toHaveLength(6);
    expect(await dot(Date.now())).toBe(1);
    const r = await send("POST", R.directoryHeldSnooze(a.gid), owner.cookie, {
      reason: "  Google is\nwrong​ today  ",
    });
    expect(r.status).toBe(200);
    const h = ((await r.json()) as SyncStatus).held.find(
      (x) => x.groupId === a.gid,
    );
    expect(h).toMatchObject({
      wouldRemove: 4,
      snoozeReason: "Google is wrong today",
    });
    const until = Date.parse(h?.snoozedUntil ?? "");
    expect(until - Date.now()).toBeGreaterThan(HELD_SNOOZE_MS - MIN);
    expect(until - Date.now()).toBeLessThanOrEqual(HELD_SNOOZE_MS);
    expect(await dot(Date.now())).toBe(0);
    // The next reconciles read the same list: still held, still snoozed,
    // nobody removed.
    await drain(t0 + 122 * MIN);
    await drain(t0 + 183 * MIN);
    expect(await membersOf(a.gid)).toEqual(before);
    expect((await heldOf(a.gid))?.snoozedUntil).toBe(h?.snoozedUntil);
    expect(await dot(t0 + 183 * MIN)).toBe(0);
    // A body is optional; a bad one is 400.
    expect(
      (await send("POST", R.directoryHeldSnooze(a.gid), owner.cookie)).status,
    ).toBe(200);
    const bad = await send("POST", R.directoryHeldSnooze(a.gid), owner.cookie, {
      reason: "x",
      extra: 1,
    });
    expect(bad.status).toBe(400);
    expect(await audits(a.gid)).toEqual([
      {
        action: "directory.sweep.snoozed",
        kind: "user",
        id: owner.userId,
        why: null,
      },
      {
        action: "directory.sweep.snoozed",
        kind: "user",
        id: owner.userId,
        why: null,
      },
    ]);
  });

  it("a membership-list change re-raises at once; still over the line, it is held again unsnoozed", async () => {
    const a = await heldGroup("chg");
    await connected();
    await a.hold();
    await snooze(a.gid, t0 + 62 * MIN);
    expect(await dot(t0 + 62 * MIN)).toBe(0);
    // One more leaves in Google: the next sweep sees a different list.
    g.removeMember(a.gid, a.us[4]?.id as string);
    await drain(t0 + 122 * MIN);
    const h = await heldOf(a.gid);
    expect(h).toMatchObject({ wouldRemove: 5, snoozedUntil: null });
    expect(await dot(t0 + 122 * MIN)).toBe(1);
    expect(await membersOf(a.gid)).toHaveLength(6);
    expect(await snoozeRows()).toEqual([]);
    expect((await audits(a.gid)).map((x) => [x.action, x.kind, x.why])).toEqual(
      [
        ["directory.sweep.snoozed", "user", null],
        ["directory.sweep.unsnoozed", "system", "group_changed"],
      ],
    );
  });

  it("Google fixed (members back): the snooze ends group_changed and the hold releases", async () => {
    const a = await heldGroup("fix");
    await connected();
    await a.hold();
    await snooze(a.gid, t0 + 62 * MIN);
    for (const u of a.us.slice(0, 4)) g.addMember(a.gid, u.id);
    await drain(t0 + 122 * MIN);
    expect(await heldOf(a.gid)).toBeUndefined();
    expect(await membersOf(a.gid)).toHaveLength(6);
    expect((await audits(a.gid)).map((x) => x.why)).toEqual([
      null,
      "group_changed",
    ]);
  });

  it("30 days: snoozed 1 ms before, re-raised at exactly 30 d (read and alarm)", async () => {
    const a = await heldGroup("ttl");
    await connected();
    await a.hold();
    const t1 = t0 + 62 * MIN;
    await snooze(a.gid, t1);
    const end = t1 + HELD_SNOOZE_MS;
    expect(HELD_SNOOZE_MS).toBe(30 * 86_400_000);
    await drain(end - 1);
    expect((await heldOf(a.gid))?.snoozedUntil).toBe(
      new Date(end).toISOString(),
    );
    expect(await dot(end - 1)).toBe(0);
    // At exactly `until` readers see it unsnoozed before any alarm runs.
    expect(await dot(end)).toBe(1);
    expect((await audits(a.gid)).map((x) => x.why)).toEqual([null]);
    await drain(end);
    expect(await heldOf(a.gid)).toMatchObject({
      wouldRemove: 4,
      snoozedUntil: null,
    });
    expect(await snoozeRows()).toEqual([]);
    expect(await membersOf(a.gid)).toHaveLength(6);
    expect((await audits(a.gid)).map((x) => [x.action, x.kind, x.why])).toEqual(
      [
        ["directory.sweep.snoozed", "user", null],
        ["directory.sweep.unsnoozed", "system", "expired"],
      ],
    );
  });

  it("other groups' removals apply as usual during the snooze", async () => {
    const a = await heldGroup("oth-a");
    const b = await group("oth-b");
    await connected();
    await a.hold();
    await snooze(a.gid, t0 + 62 * MIN);
    g.removeMember(b.gid, b.us[0]?.id as string);
    g.removeMember(b.gid, b.us[1]?.id as string);
    // The next reconcile sweeps both: B's removals apply, A stays held.
    await drain(t0 + 122 * MIN);
    expect(await membersOf(b.gid)).toHaveLength(4);
    expect(await membersOf(a.gid)).toHaveLength(6);
    expect((await heldOf(a.gid))?.snoozedUntil).not.toBeNull();
    expect(await heldOf(b.gid)).toBeUndefined();
  });

  it("a snooze never applies or reverts a removal", async () => {
    const a = await heldGroup("nev-a");
    const b = await group("nev-b");
    await connected();
    // B loses one (applied), then A is held.
    g.removeMember(b.gid, b.us[0]?.id as string);
    await a.hold();
    const aRows = await membersOf(a.gid);
    const bRows = await membersOf(b.gid);
    expect(bRows).toHaveLength(5);
    const t1 = t0 + 62 * MIN;
    await snooze(a.gid, t1);
    expect(await membersOf(a.gid)).toEqual(aRows);
    expect(await membersOf(b.gid)).toEqual(bRows);
    await drain(t1 + 60 * MIN);
    expect(await membersOf(a.gid)).toEqual(aRows);
    expect(await membersOf(b.gid)).toEqual(bRows);
    // Cancelled, then expired after a fresh snooze: still nothing moves.
    await inDo((s) => engine(s).unsnoozeHeld(a.gid, userActor(owner.userId)));
    await snooze(a.gid, t1 + 61 * MIN);
    await drain(t1 + 61 * MIN + HELD_SNOOZE_MS);
    expect(await membersOf(a.gid)).toEqual(aRows);
    expect(await membersOf(b.gid)).toEqual(bRows);
    expect((await audits(a.gid)).map((x) => x.why)).toEqual([
      null,
      null,
      "expired",
      "owner_cancel",
    ]);
  });

  it("applying a snoozed hold ends the snooze (audited applied) and applies the removals", async () => {
    const a = await heldGroup("app");
    await connected();
    await a.hold();
    const t1 = t0 + 62 * MIN;
    await snooze(a.gid, t1);
    await inDo((s) =>
      engine(s).confirmHeld(a.gid, userActor(owner.userId), t1 + MIN),
    );
    expect(await snoozeRows()).toEqual([]);
    expect((await heldOf(a.gid))?.snoozedUntil).toBeNull();
    await drain(t1 + MIN);
    expect(await membersOf(a.gid)).toHaveLength(2);
    expect(await heldOf(a.gid)).toBeUndefined();
    expect((await audits(a.gid)).map((x) => [x.action, x.kind, x.why])).toEqual(
      [
        ["directory.sweep.snoozed", "user", null],
        ["directory.sweep.unsnoozed", "user", "applied"],
      ],
    );
  });

  it("DELETE cancels (audited owner_cancel); none: no change, no row", async () => {
    const a = await heldGroup("can");
    await connected();
    await a.hold();
    await snooze(a.gid, Date.now());
    expect(await dot(Date.now())).toBe(0);
    const r = await send("DELETE", R.directoryHeldSnooze(a.gid), owner.cookie);
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as SyncStatus).held.find((x) => x.groupId === a.gid)
        ?.snoozedUntil,
    ).toBeNull();
    expect(await dot(Date.now())).toBe(1);
    expect(
      (await send("DELETE", R.directoryHeldSnooze(a.gid), owner.cookie)).status,
    ).toBe(200);
    expect((await audits(a.gid)).map((x) => [x.action, x.kind, x.why])).toEqual(
      [
        ["directory.sweep.snoozed", "user", null],
        ["directory.sweep.unsnoozed", "user", "owner_cancel"],
      ],
    );
  });

  it("disconnect clears every snooze", async () => {
    const a = await heldGroup("dis-a");
    const b = await heldGroup("dis-b");
    await connected();
    for (const u of b.us.slice(0, 4)) g.removeMember(b.gid, u.id);
    await a.hold();
    await snooze(a.gid, t0 + 62 * MIN);
    await snooze(b.gid, t0 + 62 * MIN);
    expect(await snoozeRows()).toHaveLength(2);
    const r = await post(e, R.directoryDisconnect, owner.cookie);
    expect(r.status).toBe(200);
    await inDo((s) => engine(s).alarm(t0 + 63 * MIN));
    expect(await snoozeRows()).toEqual([]);
    expect((await status()).held).toEqual([]);
  });

  it("an admin, a member, a guest and a capped owner get 404; nothing is written", async () => {
    const a = await heldGroup("authz");
    await connected();
    await a.hold();
    const admin = await login(uniq("sz-admin"), "admin");
    const member = await login(uniq("sz-member"), "member");
    const guest = await login(uniq("sz-guest", "x.com"), "guest");
    const capped = await login(uniq("sz-capped"), "owner");
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(capped.userId)
      .run();
    for (const who of [admin, member, guest, capped]) {
      for (const m of ["POST", "DELETE"] as const) {
        const r = await send(m, R.directoryHeldSnooze(a.gid), who.cookie, {});
        expect(r.status).toBe(404);
        expect((await errOf(r)).code).toBe("not_found");
      }
    }
    expect(await snoozeRows()).toEqual([]);
    expect(await audits(a.gid)).toEqual([]);
    // No cookie at all: 401.
    expect(
      (
        await fetchAndWait(
          app,
          new Request(`${APP}${R.directoryHeldSnooze(a.gid)}`, {
            method: "POST",
            headers: { "x-oa-request": "1" },
          }),
          e,
        )
      ).status,
    ).toBe(401);
  });

  it("frozen: 409 directory_sync_off; no hold or an unreadable group: 409 conflict", async () => {
    const a = await heldGroup("frz");
    const u = await group("frz-unr");
    await connected();
    await a.hold();
    const frozen = { ...e, FEATURES: "spaces,sync_frozen" } as Env;
    const f = await send(
      "POST",
      R.directoryHeldSnooze(a.gid),
      owner.cookie,
      {},
      frozen,
    );
    expect(f.status).toBe(409);
    expect((await errOf(f)).code).toBe("directory_sync_off");
    const none = await send(
      "POST",
      R.directoryHeldSnooze(u.gid),
      owner.cookie,
      {},
    );
    expect(none.status).toBe(409);
    expect((await errOf(none)).code).toBe("conflict");
    // Unreadable (3 refused reconciles): surfaced, not snoozable.
    g.fail(new RegExp(`/groups/${u.gid}/members`), 403, { times: 10_000 });
    await drain(t0 + 122 * MIN);
    await drain(t0 + 183 * MIN);
    await drain(t0 + 244 * MIN);
    expect((await heldOf(u.gid))?.wouldRemove).toBe(0);
    expect(await snooze(u.gid, t0 + 245 * MIN)).toBeNull();
    expect(await snoozeRows()).toEqual([]);
  });

  it("a snoozed hold that becomes unreadable ends its snooze (released)", async () => {
    const a = await heldGroup("rel");
    await connected();
    await a.hold();
    await snooze(a.gid, t0 + 62 * MIN);
    g.fail(new RegExp(`/groups/${a.gid}/members`), 403, { times: 10_000 });
    // Partial reads judge nothing: the snooze stays until the third refusal.
    await drain(t0 + 122 * MIN);
    await drain(t0 + 183 * MIN);
    expect(await snoozeRows()).toHaveLength(1);
    await drain(t0 + 244 * MIN);
    expect(await snoozeRows()).toEqual([]);
    expect(await heldOf(a.gid)).toMatchObject({
      wouldRemove: 0,
      snoozedUntil: null,
    });
    expect(await membersOf(a.gid)).toHaveLength(6);
    expect((await audits(a.gid)).map((x) => [x.kind, x.why])).toEqual([
      ["user", null],
      ["system", "released"],
    ]);
  });
});

/** health.ts READ: the health (and bare state) row's read. */
const HEALTH_READ = /^select value from directory_state where key = \?$/;
/** A write of the health row (an upsert, or the snooze's compare-and-set). */
const HEALTH_WRITE =
  /^(insert into directory_state|update directory_state set value)/;
/** sync.ts MEMBERS_OF: a sweep's read of the group's rows. */
const MEMBERS_READ = /^select user_id, gen from directory_members where/;

/**
 * `e` with a D1 binding that runs `f` once, before or after the first query
 * whose SQL matches: a fixed interleaving point for a race.
 */
function raced(
  match: RegExp,
  when: "before" | "after",
  f: () => Promise<void>,
): Env {
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await f();
  };
  const real = new WeakMap<object, { st: D1PreparedStatement; sql: string }>();
  const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(st, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql);
        if (
          (k === "first" || k === "all" || k === "run" || k === "raw") &&
          match.test(sql)
        )
          return async (...a: unknown[]) => {
            if (when === "before") await fire();
            const r = await (
              t[k] as (...x: unknown[]) => Promise<unknown>
            ).apply(t, a);
            if (when === "after") await fire();
            return r;
          };
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    real.set(p, { st, sql });
    return p;
  };
  const DB = new Proxy(e.DB, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === "batch")
        return async (ss: D1PreparedStatement[]) => {
          const hit = ss.some((x) => match.test(real.get(x)?.sql ?? ""));
          if (hit && when === "before") await fire();
          const r = await t.batch(ss.map((x) => real.get(x)?.st ?? x));
          if (hit && when === "after") await fire();
          return r;
        };
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...e, DB };
}

/** Alarms at `now` until no lane may run, inside a DO call. */
async function drainIn(s: DurableObjectState, now: number, en: Env = e) {
  for (let i = 0; i < 80; i++) {
    await new SyncEngine(en, s.storage).alarm(now);
    if (!new SyncEngine(en, s.storage).due(now)) return;
  }
  throw new Error("run never finished");
}

/** Each directory.sweep.snoozed row's detail.renewed (1/0), oldest first. */
const snoozedRenewed = async (gid: string) =>
  (
    await env.DB.prepare(
      `select json_extract(detail, '$.renewed') renewed from audit_events
        where target_id = ? and action = 'directory.sweep.snoozed'
        order by json_extract(detail, '$.until')`,
    )
      .bind(gid)
      .all<{ renewed: number }>()
  ).results.map((r) => r.renewed);

describe("held sweep snooze races and review fixes (#412)", () => {
  it("review 1: an alarm's health write between the snooze's read and write keeps the newly held group", async () => {
    const a = await heldGroup("race-a");
    const b = await group("race-b");
    await connected();
    await a.hold();
    // B's next sweep holds it: the alarm that does so lands mid-snooze.
    for (const u of b.us.slice(0, 4)) g.removeMember(b.gid, u.id);
    const t1 = t0 + 62 * MIN;
    await inDo(async (s) => {
      const en = raced(HEALTH_READ, "after", async () => {
        await drainIn(s, t0 + 122 * MIN);
        const h = await readHealth(e);
        expect(h.held.map((x) => x.groupId).sort()).toEqual(
          [a.gid, b.gid].sort(),
        );
      });
      const st = await new SyncEngine(en, s.storage).snoozeHeld(
        a.gid,
        userActor(owner.userId),
        null,
        t1,
      );
      expect(st?.held.find((x) => x.groupId === b.gid)?.wouldRemove).toBe(4);
    });
    const h = await readHealth(e);
    expect(h.held.find((x) => x.groupId === b.gid)).toMatchObject({
      wouldRemove: 4,
      snoozedUntil: null,
    });
    expect(h.held.find((x) => x.groupId === a.gid)?.snoozedUntil).toBe(
      new Date(t1 + HELD_SNOOZE_MS).toISOString(),
    );
    expect(await dot(t1)).toBe(1);
  });

  it("review 1: a disconnect just before the snooze's health write doesn't bring the held list back", async () => {
    const a = await heldGroup("race-dis");
    await connected();
    await a.hold();
    const t1 = t0 + 62 * MIN;
    let cleared = false;
    await inDo(async (s) => {
      const en = raced(HEALTH_WRITE, "before", async () => {
        const r = await post(e, R.directoryDisconnect, owner.cookie);
        expect(r.status).toBe(200);
        await engine(s).alarm(t1);
        expect((await readHealth(e)).held).toEqual([]);
        cleared = true;
      });
      await new SyncEngine(en, s.storage).snoozeHeld(
        a.gid,
        userActor(owner.userId),
        null,
        t1,
      );
    });
    expect(cleared).toBe(true);
    expect((await readHealth(e)).held).toEqual([]);
    expect(
      await env.DB.prepare(
        "select 1 from directory_state where key = 'sync.health'",
      ).first(),
    ).toBeNull();
    expect((await status()).held).toEqual([]);
  });

  it("review 2: a snooze written while a releasing sweep runs goes with the hold", async () => {
    const a = await heldGroup("orph");
    await connected();
    await a.hold();
    // Google fixed: the next sweep releases. The owner's snooze lands after
    // that sweep read the snoozed table, before its commit.
    for (const u of a.us.slice(0, 4)) g.addMember(a.gid, u.id);
    const at = t0 + 122 * MIN;
    let snoozed = false;
    await inDo(async (s) => {
      const en = raced(MEMBERS_READ, "before", async () => {
        snoozed =
          (await engine(s).snoozeHeld(
            a.gid,
            userActor(owner.userId),
            null,
            at,
          )) !== null;
      });
      await drainIn(s, at, en);
    });
    expect(snoozed).toBe(true);
    expect(await heldOf(a.gid)).toBeUndefined();
    expect(await snoozeRows()).toEqual([]);
    expect(await membersOf(a.gid)).toHaveLength(6);
  });

  it("review 3: the same member list held for another reason (group_404, then over_half) ends the snooze", async () => {
    const a = await group("why");
    await connected();
    g.fail(new RegExp(`/groups/${a.gid}/members`), 404, { times: 1 });
    await drain(t0 + 61 * MIN);
    expect((await heldOf(a.gid))?.wouldRemove).toBe(6);
    await snooze(a.gid, t0 + 62 * MIN);
    // Readable again, but every member resolves to nobody here: the same
    // (empty) list as the 404's, now held over_half.
    for (const u of a.us) g.removeMember(a.gid, u.id);
    for (let i = 0; i < 6; i++)
      g.addMember(a.gid, `g-why-out-${i}-${crypto.randomUUID()}`);
    await drain(t0 + 122 * MIN);
    expect(await heldOf(a.gid)).toMatchObject({
      wouldRemove: 6,
      snoozedUntil: null,
    });
    expect(await snoozeRows()).toEqual([]);
    expect(await membersOf(a.gid)).toHaveLength(6);
    expect((await audits(a.gid)).map((x) => [x.action, x.kind, x.why])).toEqual(
      [
        ["directory.sweep.snoozed", "user", null],
        ["directory.sweep.unsnoozed", "system", "group_changed"],
      ],
    );
  });

  it("review 4: a renewal racing a cancel is a snooze of its own; the cancel ended the one it read", async () => {
    const a = await heldGroup("ren");
    await connected();
    await a.hold();
    const t1 = t0 + 62 * MIN;
    await snooze(a.gid, t1);
    await inDo(async (s) => {
      const en = raced(/^insert into audit_events/, "before", async () => {
        await engine(s).snoozeHeld(
          a.gid,
          userActor(owner.userId),
          "again",
          t1 + MIN,
        );
      });
      await new SyncEngine(en, s.storage).unsnoozeHeld(
        a.gid,
        userActor(owner.userId),
      );
    });
    // The renewal found no snooze (the cancel had ended it): not renewed.
    expect(await snoozedRenewed(a.gid)).toEqual([0, 0]);
    const rows = await snoozeRows();
    expect(rows.map((r) => Number(r.at))).toEqual([t1 + MIN]);
    expect(await heldOf(a.gid)).toMatchObject({
      snoozedUntil: new Date(t1 + MIN + HELD_SNOOZE_MS).toISOString(),
      snoozeReason: "again",
    });
    expect((await audits(a.gid)).map((x) => [x.action, x.why])).toEqual([
      ["directory.sweep.snoozed", null],
      ["directory.sweep.snoozed", null],
      ["directory.sweep.unsnoozed", "owner_cancel"],
    ]);
  });

  it("review 5: GET R.directory shows the snooze reason to the owner only", async () => {
    const a = await heldGroup("rsn");
    await connected();
    await a.hold();
    await snooze(a.gid, Date.now(), "Google is wrong");
    const admin = await login(uniq("rsn-admin"), "admin");
    const read = async (cookie: string) => {
      const r = await get(e, R.directory, cookie);
      expect(r.status).toBe(200);
      return ((await r.json()) as SyncStatus).held.find(
        (x) => x.groupId === a.gid,
      );
    };
    const mine = await read(owner.cookie);
    expect(mine?.snoozeReason).toBe("Google is wrong");
    const theirs = await read(admin.cookie);
    expect(theirs?.snoozedUntil).toBe(mine?.snoozedUntil);
    expect(theirs?.snoozedUntil).not.toBeNull();
    expect(theirs?.snoozeReason).toBeNull();
  });

  it("the Manager's: an install user already in the Google group, once bound, changes the hash and ends the snooze", async () => {
    const a = await heldGroup("bind");
    // In the Google group, but no user on this install yet.
    const late = `g-bind-late-${crypto.randomUUID()}`;
    g.addMember(a.gid, late);
    await connected();
    await a.hold();
    await snooze(a.gid, t0 + 62 * MIN);
    // They join the install: bound to their Google identity.
    const email = uniq("bind-late");
    g.addUser({ id: late, primaryEmail: email });
    const uid = `u${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`;
    await env.DB.batch([
      env.DB.prepare(
        "insert into users (id, email, name, role, created_at, status, restricted_sync) values (?, ?, 'late', 'member', ?, 'active', 0)",
      ).bind(uid, email, t0 + 90 * MIN),
      env.DB.prepare(
        "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
      ).bind(late, uid, t0 + 90 * MIN),
    ]);
    await drain(t0 + 122 * MIN);
    // A different list: the snooze ends; still 4 of 6 gone, held again.
    expect(await heldOf(a.gid)).toMatchObject({
      wouldRemove: 4,
      snoozedUntil: null,
    });
    expect(await snoozeRows()).toEqual([]);
    expect(await dot(t0 + 122 * MIN)).toBe(1);
    expect((await audits(a.gid)).map((x) => [x.action, x.kind, x.why])).toEqual(
      [
        ["directory.sweep.snoozed", "user", null],
        ["directory.sweep.unsnoozed", "system", "group_changed"],
      ],
    );
  });
});
