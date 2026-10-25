// Directory disconnect (R.directoryDisconnect, DELETE R.directory): org owner
// or admin. Revokes the live grant (best effort), deletes every
// directory_state key, resets DirectorySync and audits directory.disconnect.
// Synced memberships stay exactly as they were (frozen).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { applyGroupDiff } from "../src/directory/apply.js";
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { SYNC_DO_NAME } from "../src/services/directory.js";
import { mailer, seedUser, uniq } from "./auth-helpers.js";
import {
  APP,
  app,
  connect,
  directEnv,
  hostedEnv,
  post,
  registerInstall,
  resetDirectory,
} from "./directory-helpers.js";
import {
  type FakeDirectory,
  fakeDirectory,
} from "./fixtures/fake-directory.js";
import { fetchAndWait, login } from "./helpers.js";

const MIN = 60_000;
const SYNC = { kind: "sync", id: null } as const;
let g: FakeDirectory;
let owner: { cookie: string; userId: string };
let adminSub: string;

const stub = () => {
  const ns = env.DIRECTORY_SYNC as NonNullable<Env["DIRECTORY_SYNC"]>;
  return ns.get(
    ns.idFromName(SYNC_DO_NAME),
  ) as unknown as DurableObjectStub<DirectorySync>;
};
const inDo = <T>(f: (s: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stub(), (_i, s) => f(s));
const epoch = () =>
  inDo((s) => {
    const v = s.storage.sql
      .exec("select v from kv where k = 'epoch'")
      .toArray()[0]?.v;
    return v === undefined ? 0 : Number(JSON.parse(String(v)));
  });
const keys = async () =>
  (
    await env.DB.prepare("select key from directory_state order by key").all<{
      key: string;
    }>()
  ).results.map((r) => r.key);
const disconnects = async () =>
  (
    await env.DB.prepare(
      "select actor_id, detail from audit_events where action = 'directory.disconnect' order by at",
    ).all<{ actor_id: string; detail: string }>()
  ).results.map((r) => ({
    actor: r.actor_id,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  }));
const del = (e: Env, cookie: string) =>
  fetchAndWait(
    app,
    new Request(`${APP}${R.directory}`, {
      method: "DELETE",
      headers: { "x-oa-request": "1", cookie },
    }),
    e,
  );

beforeEach(async () => {
  await resetDirectory();
  await env.DB.batch([
    env.DB.prepare("delete from org_group_mappings"),
    env.DB.prepare("delete from group_mappings"),
    env.DB.prepare("delete from restricted_groups"),
    env.DB.prepare("delete from directory_members"),
    env.DB.prepare("delete from directory_groups"),
    env.DB.prepare("delete from audit_events"),
  ]);
  await inDo(async (s) => {
    for (const t of ["kv", "seen", "dirty", "held"])
      s.storage.sql.exec(`delete from ${t}`);
    await s.storage.deleteAlarm();
  });
  await registerInstall();
  g = fakeDirectory();
  owner = await login(uniq("disc-owner"), "owner");
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  ["direct", () => directEnv(mailer().env)],
  ["broker", () => hostedEnv(mailer().env)],
] as const)("%s transport", (_kind, mk) => {
  let e: Env;
  beforeEach(async () => {
    e = mk();
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    expect(await keys()).toEqual(
      expect.arrayContaining(["binding", "grant.sub", "refresh"]),
    );
  });

  it("an owner disconnects: the live grant is revoked, every key goes, the DO resets, audited", async () => {
    const before = await epoch();
    const r = await post(e, R.directoryDisconnect, owner.cookie);
    expect(r.status).toBe(200);
    const s = (await r.json()) as SyncStatus;
    expect(s.state).toBe("never");
    expect(s.binding).toBeNull();
    expect(g.revoked).toEqual([`rt-${adminSub}`]);
    expect(await keys()).toEqual([]);
    expect(await epoch()).toBe(before + 1);
    expect(await disconnects()).toEqual([
      {
        actor: owner.userId,
        detail: { outcome: "disconnected", revoke: "revoked" },
      },
    ]);
  });

  it("a failed revoke still wipes and audits revoke_failed", async () => {
    g.setRevokeStatus(500);
    const r = await post(e, R.directoryDisconnect, owner.cookie);
    expect(r.status).toBe(200);
    expect(await keys()).toEqual([]);
    expect(await disconnects()).toEqual([
      {
        actor: owner.userId,
        detail: { outcome: "disconnected", revoke: "revoke_failed" },
      },
    ]);
  });

  it("a pending reconnect on another account is revoked too", async () => {
    const second = `g-second-${crypto.randomUUID()}`;
    g.addUser({ id: second, primaryEmail: uniq("super2"), isAdmin: true });
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    expect((await post(e, R.directoryDisconnect, owner.cookie)).status).toBe(
      200,
    );
    expect([...g.revoked].sort()).toEqual(
      [`rt-${adminSub}`, `rt-${second}`].sort(),
    );
    expect(await keys()).toEqual([]);
    expect((await disconnects())[0]?.detail).toEqual({
      outcome: "disconnected",
      revoke: "revoked",
      pendingRevoke: "revoked",
    });
  });

  it("a member gets 404; an admin may disconnect", async () => {
    const m = await login(uniq("disc-member"));
    expect((await post(e, R.directoryDisconnect, m.cookie)).status).toBe(404);
    expect((await del(e, m.cookie)).status).toBe(404);
    expect(await keys()).toContain("binding");
    expect(g.revoked).toEqual([]);
    const a = await login(uniq("disc-admin"), "admin");
    expect((await post(e, R.directoryDisconnect, a.cookie)).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect((await disconnects())[0]?.actor).toBe(a.userId);
  });

  it("is idempotent: a second disconnect is 200 and changes nothing", async () => {
    expect((await post(e, R.directoryDisconnect, owner.cookie)).status).toBe(
      200,
    );
    const ep = await epoch();
    const r = await post(e, R.directoryDisconnect, owner.cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as SyncStatus).state).toBe("never");
    expect(g.revoked).toHaveLength(1);
    expect(await disconnects()).toHaveLength(1);
    expect(await epoch()).toBe(ep);
    // DELETE R.directory is the same operation (204).
    expect((await del(e, owner.cookie)).status).toBe(204);
    expect(await disconnects()).toHaveLength(1);
  });

  it("provision's call: the owner PAT, no CSRF header, twice (idempotent)", async () => {
    const { token } = await createPat(env, owner.userId, "provision");
    const call = () =>
      fetchAndWait(
        app,
        new Request(`${APP}${R.directoryDisconnect}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
        e,
      );
    expect((await call()).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect(g.revoked).toEqual([`rt-${adminSub}`]);
    expect((await call()).status).toBe(200);
    expect(await disconnects()).toHaveLength(1);
  });

  it("needs the CSRF header on a cookie session", async () => {
    const r = await fetchAndWait(
      app,
      new Request(`${APP}${R.directoryDisconnect}`, {
        method: "POST",
        headers: { cookie: owner.cookie },
      }),
      e,
    );
    expect(r.status).toBe(403);
    expect(await keys()).toContain("binding");
  });
});

describe("after a disconnect", () => {
  let e: Env;
  beforeEach(async () => {
    e = directEnv(mailer().env);
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
  });

  it("sync stops: the next alarms call Google no more", async () => {
    const t0 = Date.now();
    const fetches = vi.mocked(globalThis.fetch);
    // Control: while connected, an alarm calls Google.
    fetches.mockClear();
    await inDo((s) => new SyncEngine(e, s.storage).alarm(t0));
    expect(fetches).toHaveBeenCalled();
    expect((await post(e, R.directoryDisconnect, owner.cookie)).status).toBe(
      200,
    );
    fetches.mockClear();
    for (const at of [t0 + 2 * MIN, t0 + 4 * MIN, t0 + 61 * MIN])
      await inDo((s) => new SyncEngine(e, s.storage).alarm(at));
    expect(fetches).not.toHaveBeenCalled();
    // The reset was applied: no runs, cursors or health remain.
    expect(
      await inDo(
        (s) =>
          s.storage.sql
            .exec(
              "select count(*) n from kv where k like 'run.%' or k like 'cursor.%'",
            )
            .toArray()[0]?.n,
      ),
    ).toBe(0);
    expect(await keys()).toEqual([]);
  });

  it("every synced row and role stays as it was (frozen)", async () => {
    const space = newId();
    await env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, ?)",
    )
      .bind(space, `s-${space}`, Date.now())
      .run();
    const [gm, go, gr] = ["map", "org", "res"].map(
      (t) => `grp-${t}-${crypto.randomUUID()}`,
    ) as [string, string, string];
    await env.DB.batch([
      ...[gm, go, gr].map((id) =>
        env.DB.prepare(
          "insert into directory_groups (group_id, email) values (?, ?)",
        ).bind(id, `${id}@a.com`),
      ),
      env.DB.prepare(
        "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'editor')",
      ).bind(space, gm, `${gm}@a.com`),
      env.DB.prepare(
        "insert into org_group_mappings (group_id, group_email, role) values (?, ?, 'viewer')",
      ).bind(go, `${go}@a.com`),
      env.DB.prepare(
        "insert into restricted_groups (group_id, group_email, created_at) values (?, ?, ?)",
      ).bind(gr, `${gr}@a.com`, Date.now()),
    ]);
    const [u1, u2] = [
      await seedUser(uniq("frozen1"), "member"),
      await seedUser(uniq("frozen2"), "member"),
    ];
    await applyGroupDiff(env, gm, [u1, u2], [], SYNC);
    await applyGroupDiff(env, go, [u1], [], SYNC);
    await applyGroupDiff(env, gr, [u2], [], SYNC);
    await env.DB.prepare(
      "insert or ignore into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(`g-${u1}`, u1, Date.now())
      .run();

    const snapshot = async () => ({
      dm: (
        await env.DB.prepare(
          "select group_id, user_id from directory_members order by group_id, user_id",
        ).all()
      ).results,
      sm: (
        await env.DB.prepare(
          "select space_id, user_id, role, source from space_members where user_id in (?, ?) order by space_id, user_id, source",
        )
          .bind(u1, u2)
          .all()
      ).results,
      users: (
        await env.DB.prepare(
          "select id, role, status, restricted_sync, restricted_manual from users where id in (?, ?) order by id",
        )
          .bind(u1, u2)
          .all()
      ).results,
      maps: (
        await env.DB.prepare(
          "select 'space' k, group_id, role from group_mappings union all select 'org', group_id, role from org_group_mappings union all select 'restricted', group_id, null from restricted_groups order by 1, 2",
        ).all()
      ).results,
      ids: (
        await env.DB.prepare(
          "select user_id, subject, directory_bound from identities where user_id in (?, ?) order by user_id",
        )
          .bind(u1, u2)
          .all()
      ).results,
    });
    const before = await snapshot();
    // Non-trivial: synced rows for both users, u2 restricted by its group.
    expect(before.dm).toHaveLength(4);
    expect(before.sm.filter((r) => r.source === "sync").length).toBeGreaterThan(
      1,
    );
    expect(before.users.find((r) => r.id === u2)?.restricted_sync).toBe(1);

    expect((await post(e, R.directoryDisconnect, owner.cookie)).status).toBe(
      200,
    );
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await snapshot()).toEqual(before);
  });
});
