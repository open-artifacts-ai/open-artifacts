// Directory disconnect (R.directoryDisconnect, DELETE R.directory): the org
// owner in an interactive cookie session only (no PAT, no grant, no admin).
// The platform's install delete runs the same operation through scheduled()
// (DIRECTORY_DISCONNECT_CRON). Revokes the live grant (best effort), deletes
// every directory_state key (a customer_mismatch tombstone excepted), resets
// DirectorySync, audits directory.disconnect and emails every owner.
// Synced memberships stay exactly as they were (frozen).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { GOOGLE_REVOKE_URL } from "@oa/auth-core";
import { newId, R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegistryCache } from "../../../packages/broker-core/src/index.js";
import { authConfig } from "../src/auth/config.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { DIRECTORY_DISCONNECT_CRON, scheduled } from "../src/cron.js";
import { applyGroupDiff } from "../src/directory/apply.js";
import { retireTenant } from "../src/directory/binding.js";
import { seal } from "../src/directory/crypto.js";
import { clearHealth, HK, NEVER } from "../src/directory/health.js";
import { K, UPSERT } from "../src/directory/store.js";
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { oauthApi } from "../src/mcp/oauth-api.js";
import { revokeFanoutCap } from "../src/runtime/revoke.js";
import { resetSync, SYNC_DO_NAME } from "../src/services/directory.js";
import { admit } from "../src/services/identity.js";
import { mailer, type SentMail, seedUser, uniq } from "./auth-helpers.js";
import {
  APP,
  app,
  connect,
  directEnv,
  hostedEnv,
  hostedProps,
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

// The scheduler's props: a hosted job reaches the broker through them.
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: hostedProps(),
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
    e.HOSTED === "1" ? hostedProps() : undefined,
  );
/** A Google sign-in's admission (P2) for this subject and address. */
const admitGoogle = (e: Env, subject: string, email: string) =>
  admit(e, authConfig(e), {
    provider: "google",
    subject,
    email,
    name: null,
    tenant: "a.com",
  });
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

  it("the interactive disconnect (POST and DELETE) on a Google 5xx still wipes and audits revoke_failed", async () => {
    g.setRevokeStatus(503);
    expect((await call(e, "DELETE", { cookie: owner.cookie })).status).toBe(
      204,
    );
    expect(await keys()).toEqual([]);
    expect(await disconnects()).toEqual([
      {
        actor: owner.userId,
        detail: {
          outcome: "disconnected",
          revoke: "revoke_failed",
          notified: 1,
        },
      },
    ]);
  });

  it.each([500, 503, 429])(
    "the system job on a Google %i rejects and keeps every key, audited revoke_failed; a retry with Google OK wipes",
    async (status) => {
      const before = await keys();
      const ep = await epoch();
      g.setRevokeStatus(status);
      await expect(
        scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx),
      ).rejects.toThrow("revoke failed");
      expect(await keys()).toEqual(before);
      expect(await epoch()).toBe(ep);
      expect(disconnectMails()).toEqual([]);
      expect(await disconnects()).toEqual([
        {
          actor: null,
          detail: { outcome: "revoke_failed", revoke: "revoke_failed" },
        },
      ]);
      g.setRevokeStatus(200);
      await scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx);
      expect(g.revoked).toEqual([`rt-${adminSub}`]);
      expect(await keys()).toEqual([]);
      expect((await disconnects())[1]).toEqual({
        actor: null,
        detail: { outcome: "disconnected", revoke: "revoked", notified: 1 },
      });
    },
  );

  it("the system job on a transport error (fetch throws) rejects and keeps every key", async () => {
    const fake = vi.mocked(globalThis.fetch);
    const impl = fake.getMockImplementation() as typeof fetch;
    fake.mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes("/revoke")) throw new TypeError("network down");
      return impl(req);
    });
    const before = await keys();
    await expect(
      scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx),
    ).rejects.toThrow("revoke failed");
    expect(await keys()).toEqual(before);
    expect((await disconnects())[0]?.detail).toEqual({
      outcome: "revoke_failed",
      revoke: "revoke_failed",
    });
  });

  it("the system job: Google's already-invalid answer (400 invalid_token) counts as revoked and wipes", async () => {
    g.setRevokeStatus(400, "invalid_token");
    await scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx);
    expect(await keys()).toEqual([]);
    expect(await disconnects()).toEqual([
      {
        actor: null,
        detail: { outcome: "disconnected", revoke: "revoked", notified: 1 },
      },
    ]);
  });

  it("the system job: any other 400 from Google is a failure", async () => {
    g.setRevokeStatus(400, "invalid_request");
    await expect(
      scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx),
    ).rejects.toThrow("revoke failed");
    expect(await keys()).toContain("refresh");
  });

  it("the system job with nothing connected resolves with no audit and no Google call", async () => {
    await env.DB.prepare("delete from directory_state").run();
    await scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx);
    expect(g.revoked).toEqual([]);
    expect(await disconnects()).toEqual([]);
  });

  it("the system job: a pending grant on another account whose revoke fails is kept with the live one, and rejects", async () => {
    const second = `g-second-${crypto.randomUUID()}`;
    g.addUser({ id: second, primaryEmail: uniq("super2"), isAdmin: true });
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    const before = await keys();
    expect(before).toEqual(expect.arrayContaining(["pending.refresh"]));
    const fake = vi.mocked(globalThis.fetch);
    const impl = fake.getMockImplementation() as typeof fetch;
    // Google is unreachable for the pending token only (either transport).
    fake.mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (
        req.url === GOOGLE_REVOKE_URL &&
        new URLSearchParams(await req.clone().text()).get("token") ===
          `rt-${second}`
      )
        throw new TypeError("down");
      return impl(req);
    });
    await expect(
      scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctx),
    ).rejects.toThrow("revoke failed");
    expect(await keys()).toEqual(before);
    expect((await disconnects())[0]?.detail).toEqual({
      outcome: "revoke_failed",
      revoke: "revoked",
      pendingRevoke: "revoke_failed",
    });
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
    expect((await disconnects()).map((r) => r.detail)).toEqual([
      expect.objectContaining({ outcome: "disconnected" }),
      { outcome: "revoke_late", token: "pending", revoke: "revoked" },
    ]);
  });

  it("a live token swapped in between the reads and the wipe is revoked and labelled live", async () => {
    const fake = vi.mocked(globalThis.fetch);
    const impl = fake.getMockImplementation() as typeof fetch;
    const swapped = await seal(e, "rt-swapped");
    fake.mockImplementationOnce(async (input, init) => {
      await env.DB.prepare(UPSERT).bind(K.refresh, swapped).run();
      return impl(input, init);
    });
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(g.revoked.sort()).toEqual([`rt-${adminSub}`, "rt-swapped"].sort());
    expect((await disconnects())[1]?.detail).toEqual({
      outcome: "revoke_late",
      token: "live",
      revoke: "revoked",
    });
  });

  it("an owner signed in through Cloudflare Access (self-host) or Google disconnects; a bearer beside it is still refused", async () => {
    // login() issues a real Access session cookie (p "access").
    const { token: pat } = await createPat(env, owner.userId, "pat");
    expect(
      (await call(e, "POST", { cookie: owner.cookie, bearer: pat })).status,
    ).toBe(404);
    expect(await keys()).toContain("binding");
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(await keys()).toEqual([]);
    // A Google session (another owner) is interactive too.
    const o2 = await login(uniq("disc-google"), "owner");
    const ep = await env.DB.prepare(
      "select session_epoch e from users where id = ?",
    )
      .bind(o2.userId)
      .first<{ e: number }>();
    const google = `${sessionCookieName(env)}=${await signSession(
      env,
      o2.userId,
      Date.now(),
      { provider: "google", epoch: ep?.e ?? 0, tenant: "a.com" },
    )}`;
    expect((await call(e, "DELETE", { cookie: google })).status).toBe(204);
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

describe("the system job: late consents and permanent failures", () => {
  let e: Env;
  let m: ReturnType<typeof mailer>;
  const job = (x: Env = e) =>
    scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, x, ctx);
  const outcomes = async () =>
    (await disconnects()).map((r) => r.detail.outcome).sort();
  /** The first Google revoke runs `f` (a racing callback) first. */
  const onFirstRevoke = (f: () => Promise<unknown>) => {
    const fake = vi.mocked(globalThis.fetch);
    const impl = fake.getMockImplementation() as typeof fetch;
    fake.mockImplementationOnce(async (input, init) => {
      await f();
      return impl(input, init);
    });
  };
  beforeEach(async () => {
    m = mailer();
    sent = m.sent;
    e = directEnv(m.env);
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
  });

  it("a consent landing between the reads and the batch (a new key) blocks the batch: rejects, nothing deleted; the next tick revokes it and resolves", async () => {
    const lateSealed = await seal(e, "rt-late");
    onFirstRevoke(() =>
      env.DB.batch([
        env.DB.prepare(UPSERT).bind(K.pendingRefresh, lateSealed),
        env.DB.prepare(UPSERT).bind(
          K.pendingBinding,
          JSON.stringify({ provider: "google" }),
        ),
      ]),
    );
    const ep = await epoch();
    await expect(job()).rejects.toThrow("revoke failed");
    expect(await keys()).toEqual(
      expect.arrayContaining([
        "binding",
        "refresh",
        "pending.refresh",
        "pending.binding",
      ]),
    );
    expect(await epoch()).toBe(ep);
    expect(disconnectMails()).toEqual([]);
    expect(await disconnects()).toEqual([
      { actor: null, detail: { outcome: "late_consent_kept" } },
    ]);
    expect(g.revoked).toEqual([`rt-${adminSub}`]);
    await job();
    expect(g.revoked).toContain("rt-late");
    expect(await keys()).toEqual([]);
    expect(await outcomes()).toEqual(["disconnected", "late_consent_kept"]);
  });

  it("a late consent replacing the read token (same key, new value) blocks the batch; the next tick revokes the new one and resolves", async () => {
    const swapped = await seal(e, "rt-swapped");
    onFirstRevoke(() => env.DB.prepare(UPSERT).bind(K.refresh, swapped).run());
    await expect(job()).rejects.toThrow("revoke failed");
    const row = await env.DB.prepare(
      "select value from directory_state where key = ?",
    )
      .bind(K.refresh)
      .first<{ value: string }>();
    expect(row?.value).toBe(swapped);
    expect(await keys()).toContain("binding");
    expect(await outcomes()).toEqual(["late_consent_kept"]);
    await job();
    expect(g.revoked).toEqual([`rt-${adminSub}`, "rt-swapped"]);
    expect(await keys()).toEqual([]);
    expect(await outcomes()).toEqual(["disconnected", "late_consent_kept"]);
  });

  it("the interactive disconnect keeps revoke_late for the same race", async () => {
    const swapped = await seal(e, "rt-swapped");
    onFirstRevoke(() => env.DB.prepare(UPSERT).bind(K.refresh, swapped).run());
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect(await outcomes()).toEqual(["disconnected", "revoke_late"]);
  });

  it("no transport configured rejects and keeps every key", async () => {
    const none = directEnv({
      ...m.env,
      GOOGLE_DIRECTORY_CLIENT_ID: undefined,
      GOOGLE_DIRECTORY_CLIENT_SECRET: undefined,
    });
    const before = await keys();
    await expect(job(none)).rejects.toThrow("revoke failed");
    expect(await keys()).toEqual(before);
    expect(g.revoked).toEqual([]);
    expect((await disconnects())[0]?.detail).toEqual({
      outcome: "revoke_failed",
      revoke: "revoke_failed",
    });
  });

  it("the broker's own 401 (an install no longer in DIRECTORY_REGISTRY) rejects and keeps every key", async () => {
    const h = hostedEnv(m.env);
    await resetDirectory();
    expect((await connect(h, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    await env.OAUTH_KV.delete("install:inst-a");
    clearRegistryCache();
    const before = await keys();
    await expect(job(h)).rejects.toThrow("revoke failed");
    expect(await keys()).toEqual(before);
    expect(g.revoked).toEqual([]);
    expect(await outcomes()).toEqual(["revoke_failed"]);
  });

  it("customer_mismatch: a failed pending revoke rejects; the second tick finishes and the tombstone stays", async () => {
    const second = `g-second-${crypto.randomUUID()}`;
    g.addUser({ id: second, primaryEmail: uniq("super2"), isAdmin: true });
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    await env.DB.prepare(UPSERT).bind(HK.state, "customer_mismatch").run();
    const fake = vi.mocked(globalThis.fetch);
    const impl = fake.getMockImplementation() as typeof fetch;
    fake.mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (
        req.url === GOOGLE_REVOKE_URL &&
        new URLSearchParams(await req.clone().text()).get("token") ===
          `rt-${second}`
      )
        throw new TypeError("down");
      return impl(req);
    });
    const before = await keys();
    await expect(job()).rejects.toThrow("revoke failed");
    expect(await keys()).toEqual(before);
    fake.mockImplementation(impl);
    await job();
    expect(g.revoked).toContain(`rt-${second}`);
    expect(await keys()).toEqual(expect.arrayContaining([HK.state, K.prior]));
    expect(await keys()).not.toContain("refresh");
    expect(await keys()).not.toContain("pending.refresh");
    const done = (await disconnects()).find(
      (r) => r.detail.outcome === "disconnected",
    );
    expect(done?.detail).toMatchObject({ mismatchKept: true });
  });

  it("customer_mismatch: a 5xx retry keeps the tombstone, and so does the tick that resolves", async () => {
    await env.DB.prepare(UPSERT).bind(HK.state, "customer_mismatch").run();
    g.setRevokeStatus(503);
    await expect(job()).rejects.toThrow("revoke failed");
    expect(await keys()).toEqual(
      expect.arrayContaining([HK.state, "binding", "refresh"]),
    );
    g.setRevokeStatus(200);
    await job();
    expect(await keys()).toContain(HK.state);
    expect(await keys()).not.toContain("refresh");
    expect(await outcomes()).toEqual(["disconnected", "revoke_failed"]);
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
    expect(await keys()).toEqual(["binding.prior", "sync.state"]);
    expect((await disconnects())[0]?.detail).toMatchObject({
      mismatchKept: true,
    });
    // The DO applies its reset: the tombstone stays.
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).toEqual(["binding.prior", "sync.state"]);

    expect((await me({ cookie: u.cookie })).status).toBe(401);
    expect((await me({ bearer: token })).status).toBe(401);
    await expect(mcpConnect(accessToken, { env: e })).rejects.toThrow();
    // A manual user keeps access.
    expect((await me({ cookie: owner.cookie })).status).toBe(200);
    // A second disconnect is a no-op that keeps it too.
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(await keys()).toEqual(["binding.prior", "sync.state"]);

    // Only an owner's reconnect and confirm lifts it. The same Workspace:
    // no customer change to announce.
    await connect(e, owner.cookie, g, { sub: adminSub }, { confirm: false });
    const st = (await (
      await fetchAndWait(
        app,
        new Request(`${APP}${R.directory}`, {
          headers: { cookie: owner.cookie },
        }),
        e,
      )
    ).json()) as SyncStatus;
    expect(st.state).toBe("pending_confirm");
    expect(st.pendingCustomerChange).toBeNull();
    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(200);
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).not.toContain("sync.state");
    expect(await keys()).not.toContain("binding.prior");
    expect((await me({ cookie: u.cookie })).status).toBe(200);
  });

  it("a tenant change: the pending status names both Workspaces, confirm audits both ids, old users stay refused at sign-in", async () => {
    // A directory user of the first Workspace, bound to it.
    const oldSub = `g-old-${crypto.randomUUID()}`;
    const oldEmail = uniq("old-ws");
    g.addUser({ id: oldSub, primaryEmail: oldEmail });
    const oldUid = await seedUser(oldEmail, "member", { googleSub: oldSub });
    await env.DB.prepare(
      "update identities set directory_bound = 1 where provider = 'google' and subject = ?",
    )
      .bind(oldSub)
      .run();
    const first = g.customerId;
    await env.DB.prepare(UPSERT).bind(HK.state, "customer_mismatch").run();
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
    expect(await keys()).toEqual(["binding.prior", "sync.state"]);

    // Consent from a super admin of another Workspace (same domain).
    const other = g.addUser({
      id: `g-other-${crypto.randomUUID()}`,
      primaryEmail: uniq("other-ws"),
      isAdmin: true,
      customerId: "C9999",
    });
    g.users.set(other.id, { ...other });
    g.domains.set("C9999", [{ domainName: "a.com", verified: true }]);
    const r = await connect(
      e,
      owner.cookie,
      g,
      { sub: other.id },
      {
        confirm: false,
      },
    );
    expect(r.consented).toBe(true);
    const st = (await (
      await fetchAndWait(
        app,
        new Request(`${APP}${R.directory}`, {
          headers: { cookie: owner.cookie },
        }),
        e,
      )
    ).json()) as SyncStatus;
    expect(st.state).toBe("pending_confirm");
    expect(st.pendingCustomerChange).toEqual({
      previous: { customerId: first, domain: "a.com" },
      next: { customerId: "C9999", domain: "a.com" },
    });

    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(200);
    const confirmed = (
      await env.DB.prepare(
        "select detail from audit_events where action = 'directory.connect' and json_extract(detail, '$.outcome') = 'confirmed' order by at desc limit 1",
      ).first<{ detail: string }>()
    )?.detail;
    expect(JSON.parse(confirmed ?? "{}")).toMatchObject({
      customerId: "C9999",
      previousCustomerId: first,
    });
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).not.toContain("binding.prior");

    // Users bound to the old Workspace don't carry over: refused at sign-in.
    expect(await statusOf(oldUid)).toBe("suspended");
    expect(await admitGoogle(e, oldSub, oldEmail)).toEqual({
      ok: false,
      reason: "removed",
    });
  });

  /** A user bound to the current Workspace, with a session, a PAT and a grant. */
  async function boundUser(tag: string) {
    const sub = `g-${tag}-${crypto.randomUUID()}`;
    const email = uniq(tag);
    g.addUser({ id: sub, primaryEmail: email });
    const u = await login(email);
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(sub, u.userId, Date.now())
      .run();
    const { token } = await createPat(env, u.userId, tag);
    const { accessToken } = await oauthToken(email, `${tag} Agent`, u);
    return { ...u, sub, email, token, accessToken };
  }
  const meAs = (e: Env, auth: { cookie?: string; bearer?: string }) =>
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
  const statusOf = async (id: string) =>
    (
      await env.DB.prepare("select status from users where id = ?")
        .bind(id)
        .first<{ status: string }>()
    )?.status;
  const boundOf = async (sub: string) =>
    (
      await env.DB.prepare(
        "select directory_bound as b from identities where provider = 'google' and subject = ?",
      )
        .bind(sub)
        .first<{ b: number }>()
    )?.b;
  const syncState = async () =>
    (
      await env.DB.prepare(
        "select value from directory_state where key = 'sync.state'",
      ).first<{ value: string }>()
    )?.value ?? null;
  /** Another Workspace's super admin (same domain) consents (and confirms). */
  async function reconnectElsewhere(e: Env, confirm = true) {
    const other = g.addUser({
      id: `g-other-${crypto.randomUUID()}`,
      primaryEmail: uniq("other-ws"),
      isAdmin: true,
      customerId: "C9999",
    });
    g.users.set(other.id, { ...other });
    g.domains.set("C9999", [{ domainName: "a.com", verified: true }]);
    const r = await connect(e, owner.cookie, g, { sub: other.id }, { confirm });
    expect(r.consented).toBe(true);
    return r;
  }
  /** Customer A in customer_mismatch, then disconnected (the tombstone). */
  async function mismatchAndDisconnect(e: Env) {
    await env.DB.prepare(UPSERT).bind(HK.state, "customer_mismatch").run();
    expect((await call(e, "POST", { cookie: owner.cookie })).status).toBe(200);
  }

  it("P2.5 #16: reconnect to customer B and confirm: A's users' sessions, PATs and grants stay dead once the tombstone lifts; sign-in refused", async () => {
    const a = await boundUser("ws-a");
    const first = g.customerId;
    expect((await meAs(e, { cookie: a.cookie })).status).toBe(200);
    await mismatchAndDisconnect(e);
    expect((await meAs(e, { cookie: a.cookie })).status).toBe(401);

    const r = await reconnectElsewhere(e);
    expect(r.confirmed?.status).toBe(200);
    // The DO applies the reset and syncs B: the tombstone is gone.
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).not.toContain("tenant.retire");
    expect(await syncState()).not.toBe("customer_mismatch");

    // A's user: suspended, unbound, and every credential refused.
    expect(await statusOf(a.userId)).toBe("suspended");
    expect(await boundOf(a.sub)).toBe(0);
    expect((await meAs(e, { cookie: a.cookie })).status).toBe(401);
    expect((await meAs(e, { bearer: a.token })).status).toBe(401);
    await expect(mcpConnect(a.accessToken, { env: e })).rejects.toThrow();
    expect(await admitGoogle(e, a.sub, a.email)).toEqual({
      ok: false,
      reason: "removed",
    });
    // Audited once per user, as directory sync.
    const rows = (
      await env.DB.prepare(
        "select actor_kind as k, detail from audit_events where action = 'user.status' and target_id = ?",
      )
        .bind(a.userId)
        .all<{ k: string; detail: string }>()
    ).results;
    expect(rows.map((x) => [x.k, JSON.parse(x.detail)])).toEqual([
      [
        "sync",
        {
          status: "suspended",
          previousCustomerId: first,
          reason: "directory_suspend",
        },
      ],
    ]);
    // The org owner is exempt (break-glass) and keeps access.
    expect((await meAs(e, { cookie: owner.cookie })).status).toBe(200);
    // Later syncs of B never rebind or restore A's user.
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now() + 2 * MIN));
    expect(await statusOf(a.userId)).toBe("suspended");
    expect(await boundOf(a.sub)).toBe(0);
  });

  it("P2.5 #16: confirming the same Workspace again retires nobody", async () => {
    const a = await boundUser("ws-same");
    await mismatchAndDisconnect(e);
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await statusOf(a.userId)).toBe("active");
    expect(await boundOf(a.sub)).toBe(1);
    expect((await meAs(e, { cookie: a.cookie })).status).toBe(200);
  });

  it("P2.5 #16: a confirm that fails before retiring leaves it owed: the tombstone survives a reset, and DirectorySync retires them before syncing", async () => {
    const a = await boundUser("ws-owed");
    await mismatchAndDisconnect(e);
    await reconnectElsewhere(e, false);
    // The batch after the swap (the first retire batch) fails, as a D1
    // outage right after the swap would.
    let batches = 0;
    const db = env.DB;
    const failing = {
      ...e,
      DB: new Proxy(db, {
        get(t, k) {
          if (k === "batch")
            return (xs: D1PreparedStatement[]) =>
              ++batches === 2
                ? Promise.reject(new Error("d1 down"))
                : t.batch(xs);
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    // The connection stands; the binding pass waits for the retire.
    expect((await post(failing, R.directoryConfirm, owner.cookie)).status).toBe(
      200,
    );
    expect(batches).toBeGreaterThanOrEqual(2);
    // The connection stands, with the retire owed: whichever alarm runs
    // next (the confirm kicked one) retires them before syncing anything.
    expect(await keys()).toEqual(expect.arrayContaining(["binding"]));
    expect((await meAs(e, { cookie: a.cookie })).status).toBe(401);
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).not.toContain("tenant.retire");
    expect(await statusOf(a.userId)).toBe("suspended");
    expect(await boundOf(a.sub)).toBe(0);
    expect((await meAs(e, { cookie: a.cookie })).status).toBe(401);
  });

  it("review #4: a retry still revokes the grants and closes the sockets of users an interrupted attempt suspended", async () => {
    const a = await boundUser("ws-retry");
    await mismatchAndDisconnect(e);
    await reconnectElsewhere(e, false);
    // The first attempt dies after suspending a, before its cleanup.
    let tripped = 0;
    const db = env.DB;
    const failing = {
      ...e,
      DB: new Proxy(db, {
        get(t, k) {
          if (k === "prepare")
            return (sql: string) => {
              // Its first step after the D1 loop, before any cleanup.
              if (
                (sql.startsWith(
                  "delete from directory_state where key = ? and value = ?",
                ) ||
                  sql.startsWith("select value as ids from directory_state")) &&
                tripped++ === 0
              )
                throw new Error("d1 down");
              return t.prepare(sql);
            };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    expect((await post(failing, R.directoryConfirm, owner.cookie)).status).toBe(
      200,
    );
    expect(tripped).toBeGreaterThan(0);
    expect(await statusOf(a.userId)).toBe("suspended");
    // The retry (DirectorySync) finds nobody bound, yet still cleans up a.
    await inDo((s) => new SyncEngine(e, s.storage).alarm(Date.now()));
    expect(await keys()).not.toContain("tenant.retire");
    expect(await keys()).not.toContain("tenant.retired");
    const ns = env.USER_PRESENCE as NonNullable<Env["USER_PRESENCE"]>;
    const revoked = await runInDurableObject(
      ns.get(ns.idFromName(a.userId)),
      (_i, s) =>
        s.storage.sql
          .exec("select revoked_at from state where id = 1")
          .toArray()[0]?.revoked_at,
    );
    expect(Number(revoked)).toBeGreaterThan(0);
    const { items } = await oauthApi(e).listUserGrants(a.userId, {
      limit: 10,
    });
    expect(items).toEqual([]);
  });
  it("review N2: tenant.retired keeps at most revokeFanoutCap ids", async () => {
    const free = { ...e, PLAN: "free" } as Env;
    const cap = revokeFanoutCap(free);
    for (let i = 0; i < cap + 5; i++) await boundUser(`ws-cap${i}`);
    // Stop it right after the D1 loop, with the list still stored.
    const db = env.DB;
    const stop = {
      ...free,
      DB: new Proxy(db, {
        get(t, k) {
          if (k === "prepare")
            return (sql: string) => {
              if (sql.startsWith("select value as ids from directory_state"))
                throw new Error("stop");
              return t.prepare(sql);
            };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    await expect(retireTenant(stop, "C-old")).rejects.toThrow("stop");
    const row = await env.DB.prepare(
      "select value from directory_state where key = 'tenant.retired'",
    ).first<{ value: string }>();
    expect((JSON.parse(row?.value ?? "[]") as string[]).length).toBe(cap);
    // A clean retry finishes and drops the list.
    await retireTenant(free, "C-old");
    expect(await keys()).not.toContain("tenant.retired");
  });

  it("P2.5 #16: a reset keeps the customer_mismatch tombstone while a retire is owed, even with a live binding", async () => {
    await env.DB.batch([
      env.DB.prepare(UPSERT).bind(HK.state, "customer_mismatch"),
      env.DB.prepare(UPSERT).bind(K.retire, "C-old"),
    ]);
    expect(await keys()).toContain("binding");
    await clearHealth(env).run();
    expect(await syncState()).toBe("customer_mismatch");
    await env.DB.prepare("delete from directory_state where key = ?")
      .bind(K.retire)
      .run();
    await clearHealth(env).run();
    expect(await syncState()).toBeNull();
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
