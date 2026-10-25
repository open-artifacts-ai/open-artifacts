// Directory disconnect (R.directoryDisconnect, DELETE R.directory): the org
// owner in an interactive cookie session only (no PAT, no grant, no admin).
// The platform's install delete runs the same operation through scheduled()
// (DIRECTORY_DISCONNECT_CRON). Revokes the live grant (best effort), deletes
// every directory_state key (a customer_mismatch tombstone excepted), resets
// DirectorySync, audits directory.disconnect and emails every owner.
// Synced memberships stay exactly as they were (frozen).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { DIRECTORY_DISCONNECT_CRON, scheduled } from "../src/cron.js";
import { applyGroupDiff } from "../src/directory/apply.js";
import { seal } from "../src/directory/crypto.js";
import { HK, NEVER } from "../src/directory/health.js";
import { K, UPSERT } from "../src/directory/store.js";
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { resetSync, SYNC_DO_NAME } from "../src/services/directory.js";
import { mailer, type SentMail, seedUser, uniq } from "./auth-helpers.js";
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
import { connect as mcpConnect, oauthToken } from "./mcp-helpers.js";

const MIN = 60_000;
const SYNC = { kind: "sync", id: null } as const;
let g: FakeDirectory;
let owner: { cookie: string; userId: string; email: string };
let adminSub: string;
let sent: SentMail[];

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
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
      "select actor_id, detail from audit_events where action = 'directory.disconnect' order by at, json_extract(detail, '$.outcome')",
    ).all<{ actor_id: string | null; detail: string }>()
  ).results.map((r) => ({
    actor: r.actor_id,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  }));
/** A request with `auth` (a cookie, or a Bearer token) and the CSRF header. */
const call = (
  e: Env,
  method: "POST" | "DELETE",
  auth: { cookie?: string; bearer?: string },
  path: string = method === "POST" ? R.directoryDisconnect : R.directory,
) =>
  fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      method,
      headers: {
        "x-oa-request": "1",
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      },
    }),
    e,
  );
const disconnectMails = () =>
  sent.filter((m) => m.text.includes("Google Workspace was disconnected"));

beforeEach(async () => {
  await resetDirectory();
  await env.DB.batch([
    env.DB.prepare("delete from org_group_mappings"),
    env.DB.prepare("delete from group_mappings"),
    env.DB.prepare("delete from restricted_groups"),
    env.DB.prepare("delete from directory_members"),
    env.DB.prepare("delete from directory_groups"),
    env.DB.prepare("delete from audit_events"),
    // Owners from earlier tests would be emailed too.
    env.DB.prepare("update users set role = 'member' where role = 'owner'"),
  ]);
  await inDo(async (s) => {
    for (const t of ["kv", "seen", "dirty", "held"])
      s.storage.sql.exec(`delete from ${t}`);
    await s.storage.deleteAlarm();
  });
  await registerInstall();
  g = fakeDirectory();
  const email = uniq("disc-owner");
  owner = { ...(await login(email, "owner")), email };
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  ["direct", directEnv],
  ["broker", hostedEnv],
] as const)("%s transport", (_kind, mk) => {
  let e: Env;
  beforeEach(async () => {
    const m = mailer();
    sent = m.sent;
    e = mk(m.env);
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    expect(await keys()).toEqual(
      expect.arrayContaining(["binding", "grant.sub", "refresh"]),
    );
  });

  it("an owner cookie with CSRF disconnects: revoked with the live blob, every key gone, the DO reset, audited", async () => {
    const before = await epoch();
    const r = await call(e, "POST", { cookie: owner.cookie });
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
        detail: { outcome: "disconnected", revoke: "revoked", notified: 1 },
      },
    ]);
  });

  it("a failed revoke still wipes and audits revoke_failed", async () => {
    g.setRevokeStatus(500);
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect((await disconnects())[0]?.detail).toMatchObject({
      outcome: "disconnected",
      revoke: "revoke_failed",
    });
  });

  it("a pending reconnect on another account is revoked too", async () => {
    const second = `g-second-${crypto.randomUUID()}`;
    g.addUser({ id: second, primaryEmail: uniq("super2"), isAdmin: true });
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect([...g.revoked].sort()).toEqual(
      [`rt-${adminSub}`, `rt-${second}`].sort(),
    );
    expect(await keys()).toEqual([]);
    expect((await disconnects())[0]?.detail).toMatchObject({
      revoke: "revoked",
      pendingRevoke: "revoked",
    });
  });

  it("refused (404, nothing changes): a member or admin cookie, the owner's PAT, the owner's MCP grant", async () => {
    const m = await login(uniq("disc-member"));
    const a = await login(uniq("disc-admin"), "admin");
    const { token: pat } = await createPat(env, owner.userId, "pat");
    const { accessToken } = await oauthToken(owner.email, "Agent", owner);
    for (const method of ["POST", "DELETE"] as const) {
      expect((await call(e, method, { cookie: m.cookie })).status).toBe(404);
      expect((await call(e, method, { cookie: a.cookie })).status).toBe(404);
      expect((await call(e, method, { bearer: pat })).status).toBe(404);
      // An MCP grant is no /api/v1 credential at all: 401.
      expect((await call(e, method, { bearer: accessToken })).status).toBe(401);
      // A bearer next to the owner's own cookie is refused too.
      expect(
        (await call(e, method, { cookie: owner.cookie, bearer: pat })).status,
      ).toBe(404);
    }
    expect(await keys()).toContain("binding");
    expect(g.revoked).toEqual([]);
    expect(await disconnects()).toEqual([]);
  });

  it("is idempotent: a second disconnect is 200 and changes nothing", async () => {
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    const ep = await epoch();
    const r = await call(e, "POST", { cookie: owner.cookie });
    expect(r.status).toBe(200);
    expect(((await r.json()) as SyncStatus).state).toBe("never");
    expect(g.revoked).toHaveLength(1);
    expect(await disconnects()).toHaveLength(1);
    expect(await epoch()).toBe(ep);
    expect(disconnectMails()).toHaveLength(1);
    // DELETE R.directory is the same operation (204).
    expect((await call(e, "DELETE", { cookie: owner.cookie })).status).toBe(
      204,
    );
    expect(await disconnects()).toHaveLength(1);
  });

  it("every active owner is emailed once (no em dash); others are not", async () => {
    const o2 = uniq("disc-owner2");
    await login(o2, "owner");
    const adm = uniq("disc-admin2");
    await login(adm, "admin");
    expect((await call(e, "DELETE", { cookie: owner.cookie })).status).toBe(
      204,
    );
    const to = disconnectMails().map((x) => x.to);
    expect(to.sort()).toEqual([owner.email, o2].sort());
    for (const x of disconnectMails()) expect(x.text).not.toContain("—");
    expect((await disconnects())[0]?.detail.notified).toBe(2);
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

  it("the platform system job (scheduled, DIRECTORY_DISCONNECT_CRON) disconnects, as system, idempotently", async () => {
    await scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx);
    expect(await keys()).toEqual([]);
    expect(g.revoked).toEqual([`rt-${adminSub}`]);
    await scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx);
    expect(g.revoked).toHaveLength(1);
    expect(await disconnects()).toEqual([
      {
        actor: null,
        detail: { outcome: "disconnected", revoke: "revoked", notified: 1 },
      },
    ]);
  });

  it("no other way in: an unknown system job is refused, the nightly cron and an unauthenticated HTTP call do nothing", async () => {
    await expect(
      scheduled({ cron: "oa:directory-disconnect-now" }, e, ctx),
    ).rejects.toThrow("unknown system job");
    await scheduled({ cron: "17 3 * * *" }, e, ctx);
    for (const path of [
      R.directoryDisconnect,
      "/api/v1/internal/directory/disconnect",
    ])
      expect([401, 404]).toContain((await call(e, "POST", {}, path)).status);
    expect(await keys()).toContain("binding");
    expect(g.revoked).toEqual([]);
  });
});

describe("races and retries", () => {
  let e: Env;
  beforeEach(async () => {
    const m = mailer();
    sent = m.sent;
    e = directEnv(m.env);
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
  });

  it("a consent committed between the reads and the wipe is revoked too (revoke_late)", async () => {
    const fake = vi.mocked(globalThis.fetch);
    const impl = fake.getMockImplementation() as typeof fetch;
    const lateSealed = await seal(e, "rt-late");
    // The first Google call (the live revoke) lands a racing callback's rows.
    fake.mockImplementationOnce(async (input, init) => {
      await env.DB.batch([
        env.DB.prepare(UPSERT).bind(K.pendingRefresh, lateSealed),
        env.DB.prepare(UPSERT).bind(
          K.pendingBinding,
          JSON.stringify({ provider: "google" }),
        ),
      ]);
      return impl(input, init);
    });
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect(g.revoked.sort()).toEqual([`rt-${adminSub}`, "rt-late"].sort());
    expect((await disconnects()).map((r) => r.detail.outcome)).toEqual([
      "disconnected",
      "revoke_late",
    ]);
  });

  it("resetSync retries a failed reset once, and never throws", async () => {
    let n = 0;
    const fakeNs = (fails: number) =>
      ({
        idFromName: () => ({}),
        get: () => ({
          reset: async () => {
            n++;
            if (n <= fails) throw new Error("reset failed");
          },
        }),
      }) as unknown as Env["DIRECTORY_SYNC"];
    await resetSync({ DIRECTORY_SYNC: fakeNs(1) });
    expect(n).toBe(2);
    n = 0;
    await expect(
      resetSync({ DIRECTORY_SYNC: fakeNs(5) }),
    ).resolves.toBeUndefined();
    expect(n).toBe(2);
  });
});

describe("during customer_mismatch", () => {
  let e: Env;
  beforeEach(async () => {
    const m = mailer();
    sent = m.sent;
    e = directEnv(m.env);
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
  });

  it("keeps the tombstone: synced users stay denied on cookie, PAT and grant; the grant is revoked and the binding gone", async () => {
    const email = uniq("mm-synced");
    const u = await login(email);
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(`g-${crypto.randomUUID()}`, u.userId, Date.now())
      .run();
    const { token } = await createPat(env, u.userId, "mm");
    const { accessToken } = await oauthToken(email, "MM Agent", u);
    await env.DB.batch([
      env.DB.prepare(UPSERT).bind(
        HK.health,
        JSON.stringify({
          ...NEVER,
          state: "customer_mismatch",
          unhealthySince: Date.now() - MIN,
        }),
      ),
      env.DB.prepare(UPSERT).bind(HK.state, "customer_mismatch"),
    ]);
    const me = (auth: { cookie?: string; bearer?: string }) =>
      fetchAndWait(
        app,
        new Request(`${APP}${R.me}`, {
          headers: {
            ...(auth.cookie ? { cookie: auth.cookie } : {}),
            ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
          },
        }),
        e,
      );
    expect((await me({ cookie: u.cookie })).status).toBe(401);

    // The owner (not directory-bound) disconnects.
    const r = await call(e, "POST", { cookie: owner.cookie });
    expect(r.status).toBe(200);
    expect(((await r.json()) as SyncStatus).state).toBe("customer_mismatch");
    expect(g.revoked).toEqual([`rt-${adminSub}`]);
    expect(await keys()).toEqual(["sync.state"]);
    expect((await disconnects())[0]?.detail).toMatchObject({
      mismatchKept: true,
    });
    // The DO applies its reset: the tombstone stays.
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).toEqual(["sync.state"]);

    expect((await me({ cookie: u.cookie })).status).toBe(401);
    expect((await me({ bearer: token })).status).toBe(401);
    await expect(mcpConnect(accessToken, { env: e })).rejects.toThrow();
    // A manual user keeps access.
    expect((await me({ cookie: owner.cookie })).status).toBe(200);
    // A second disconnect is a no-op that keeps it too.
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(await keys()).toEqual(["sync.state"]);

    // Only an owner's reconnect and confirm lifts it.
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).not.toContain("sync.state");
    expect((await me({ cookie: u.cookie })).status).toBe(200);
  });
});

describe("after a disconnect", () => {
  let e: Env;
  beforeEach(async () => {
    const m = mailer();
    sent = m.sent;
    e = directEnv(m.env);
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
