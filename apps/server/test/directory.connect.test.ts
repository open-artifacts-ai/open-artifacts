// P3 T12: directory connect. The callback runs every check in order and
// fails closed: each refusal redirects to /settings/directory?error=<code>
// with a directory.connect audit row; success stores the binding and the
// sealed refresh token, then runs the initial binding pass.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "../src/cron.js";
import { directoryClient } from "../src/directory/client.js";
import { afterConsent } from "../src/directory/connect.js";
import { open, seal } from "../src/directory/crypto.js";
import { SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { SYNC_DO_NAME } from "../src/services/directory.js";
import { getUser } from "../src/services/users.js";
import { seedUser, uniq } from "./auth-helpers.js";
import {
  begin,
  connect,
  directEnv,
  get,
  hostedEnv,
  loc,
  post,
  registerInstall,
  resetDirectory,
} from "./directory-helpers.js";
import {
  type FakeDirectory,
  fakeDirectory,
} from "./fixtures/fake-directory.js";
import { login } from "./helpers.js";

let g: FakeDirectory;
let owner: { cookie: string; userId: string };
let admin: { sub: string };
beforeEach(async () => {
  await resetDirectory();
  await registerInstall();
  g = fakeDirectory();
  owner = await login(uniq("dir-owner"), "owner");
  admin = { sub: `g-admin-${crypto.randomUUID()}` };
  g.addUser({ id: admin.sub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

const state = async () =>
  (
    await env.DB.prepare("select key, value from directory_state").all<{
      key: string;
      value: string;
    }>()
  ).results;
const binding = async () =>
  (await state()).find((r) => r.key === "binding")?.value ?? null;
const audits = async () =>
  (
    await env.DB.prepare(
      "select actor_id, detail from audit_events where action = 'directory.connect' order by at",
    ).all<{ actor_id: string; detail: string }>()
  ).results.map((r) => ({
    actor: r.actor_id,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  }));

describe.each([
  ["direct", () => directEnv()],
  ["broker", () => hostedEnv()],
] as const)("%s transport", (kind, mk) => {
  let e: Env;
  beforeEach(() => {
    e = mk();
  });

  it("callback refuses a delegated admin → ?error=not_super_admin", async () => {
    const del = g.addUser({
      id: `g-del-${crypto.randomUUID()}`,
      primaryEmail: uniq("delegated"),
      isAdmin: false,
    });
    const r = await connect(e, owner.cookie, g, { sub: del.id });
    expect(r.r.status).toBe(302);
    expect(r.path).toBe("/settings/directory");
    expect(r.q.get("error")).toBe("not_super_admin");
    expect(await binding()).toBeNull();
  });

  it("callback refuses hd mismatch and domains.list without the domain → ?error=domain_mismatch", async () => {
    const a = await connect(e, owner.cookie, g, {
      sub: admin.sub,
      hd: "evil.com",
    });
    // The broker refuses an hd its registry doesn't list (generic: failed)
    // before the install's own check (domain_mismatch) runs.
    const hdRefusal = kind === "broker" ? "failed" : "domain_mismatch";
    expect(a.q.get("error")).toBe(hdRefusal);
    const none = await connect(e, owner.cookie, g, {
      sub: admin.sub,
      hd: null,
    });
    expect(none.q.get("error")).toBe(hdRefusal);
    g.domains.set(g.customerId, [{ domainName: "other.com", verified: true }]);
    const b = await connect(e, owner.cookie, g, { sub: admin.sub });
    expect(b.q.get("error")).toBe("domain_mismatch");
    // Listed but unverified is not enough.
    g.domains.set(g.customerId, [{ domainName: "a.com", verified: false }]);
    const c = await connect(e, owner.cookie, g, { sub: admin.sub });
    expect(c.q.get("error")).toBe("domain_mismatch");
    expect(await binding()).toBeNull();
  });

  it("callback refuses missing scopes → ?error=scopes; accepts openid email plus the four → pending, then confirmed", async () => {
    const r = await connect(e, owner.cookie, g, {
      sub: admin.sub,
      scope:
        "openid email https://www.googleapis.com/auth/admin.directory.user.readonly",
    });
    expect(r.q.get("error")).toBe("scopes");
    expect(await binding()).toBeNull();
    const ok = await connect(e, owner.cookie, g, { sub: admin.sub });
    expect(ok.ok).toBe(true);
    expect(JSON.parse((await binding()) as string)).toMatchObject({
      provider: "google",
      customerId: g.customerId,
      domain: "a.com",
      connectedBy: owner.userId,
    });
  });

  it("a reconnect to another customer → ?error=customer_mismatch; the binding stays", async () => {
    expect((await connect(e, owner.cookie, g, { sub: admin.sub })).ok).toBe(
      true,
    );
    const other = g.addUser({
      id: `g-other-${crypto.randomUUID()}`,
      primaryEmail: uniq("other"),
      isAdmin: true,
      customerId: "C9999",
    });
    g.domains.set("C9999", [{ domainName: "a.com", verified: true }]);
    // users.get reports the user's own customer.
    g.users.set(other.id, { ...other });
    const r = await connect(e, owner.cookie, g, { sub: other.id });
    expect(r.q.get("error")).toBe("customer_mismatch");
    expect(JSON.parse((await binding()) as string).customerId).toBe(
      g.customerId,
    );
  });

  it("stores only the sealed refresh token, never plaintext", async () => {
    await connect(e, owner.cookie, g, { sub: admin.sub });
    const rows = await state();
    const sealed = rows.find((r) => r.key === "refresh")?.value ?? "";
    expect(sealed).toMatch(/^1\./);
    expect(JSON.stringify(rows)).not.toContain(`rt-${admin.sub}`);
    const inner = await open(e, sealed);
    if (kind === "direct") expect(inner).toBe(`rt-${admin.sub}`);
    // Broker: the install only ever holds the broker's install-bound wrap.
    else {
      expect(inner).toMatch(/^v1\./);
      expect(inner).not.toContain(`rt-${admin.sub}`);
    }
  });

  it("audits each outcome with ids and enums only (no email, code or token)", async () => {
    const del = g.addUser({
      id: `g-del-${crypto.randomUUID()}`,
      primaryEmail: uniq("delegated"),
    });
    await connect(e, owner.cookie, g, { sub: del.id });
    await connect(e, owner.cookie, g, { sub: admin.sub });
    const rows = (await audits()).filter((r) => r.actor === owner.userId);
    expect(rows.map((r) => r.detail.outcome)).toEqual([
      "refused",
      "consented",
      "confirmed",
    ]);
    expect(rows[0]?.detail.error).toBe("not_super_admin");
    expect(rows.every((r) => r.actor === owner.userId)).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/@|rt-|at-|code-/);
  });

  it("consent declined at Google → ?error=denied", async () => {
    const r = await connect(
      e,
      owner.cookie,
      g,
      { sub: admin.sub },
      {
        tamper: (u) => {
          u.searchParams.delete("code");
          u.searchParams.set("error", "access_denied");
        },
      },
    );
    expect(r.q.get("error")).toBe("denied");
  });
});

describe("attacks", () => {
  const e = () => hostedEnv();

  it("a forged broker state (assertion) → ?error=failed, nothing stored", async () => {
    const r = await connect(
      e(),
      owner.cookie,
      g,
      { sub: admin.sub },
      { tamper: (u) => u.searchParams.set("bstate", "forged.sig") },
    );
    expect(r.q.get("error")).toBe("failed");
    expect(await binding()).toBeNull();
  });

  it("a replayed callback → ?error=expired (the pending flow is single use)", async () => {
    const env1 = e();
    const ok = await connect(env1, owner.cookie, g, { sub: admin.sub });
    expect(ok.ok).toBe(true);
    const again = await get(
      env1,
      `${ok.back.pathname}${ok.back.search}`,
      ok.cookie,
    );
    expect(new URL(loc(again)).searchParams.get("error")).toBe("expired");
  });

  it("another install's broker state → ?error=failed", async () => {
    const env1 = e();
    // A directory state the broker minted for inst-b.
    const other = await import("../../directory-broker/src/index.js");
    const { brokerEnv } = await import("./directory-helpers.js");
    const toGoogle = await other.default.fetch(
      new Request(
        `https://directory.hosted.test/google/directory/start?install=inst-b&state=x&code_challenge=${"A".repeat(43)}`,
      ) as never,
      brokerEnv,
    );
    const foreign = new URL(loc(toGoogle)).searchParams.get("state") ?? "";
    const r = await connect(
      env1,
      owner.cookie,
      g,
      { sub: admin.sub },
      { tamper: (u) => u.searchParams.set("bstate", foreign) },
    );
    expect(r.q.get("error")).toBe("failed");
  });

  it("a callback without this browser's state cookie, or another user's → ?error=expired", async () => {
    const env1 = directEnv();
    const noCookie = await connect(
      env1,
      owner.cookie,
      g,
      { sub: admin.sub },
      { cookie: "oa_dir=" },
    );
    expect(noCookie.q.get("error")).toBe("expired");
    // A second owner presents the first owner's flow.
    const other = await login(uniq("dir-owner2"), "owner");
    const b = await begin(env1, owner.cookie);
    const back = new URL(R.directoryCallback, "http://app.localhost");
    back.searchParams.set("code", "c");
    back.searchParams.set("state", b.to?.searchParams.get("state") ?? "");
    const r = await get(
      env1,
      `${back.pathname}${back.search}`,
      `${other.cookie}; ${b.dirCookie}`,
    );
    expect(new URL(loc(r)).searchParams.get("error")).toBe("expired");
  });

  it("a non-owner: connect 404, callback refused with an audit row", async () => {
    const env1 = directEnv();
    const a = await login(uniq("dir-admin"), "admin");
    expect((await get(env1, R.directoryConnect, a.cookie)).status).toBe(404);
    const r = await get(
      env1,
      `${R.directoryCallback}?code=c&state=s`,
      a.cookie,
    );
    expect(new URL(loc(r)).searchParams.get("error")).toBe("failed");
    expect((await audits()).at(-1)?.actor).toBe(a.userId);
    expect(await binding()).toBeNull();
  });

  it("anonymous callers get 401", async () => {
    expect((await get(directEnv(), R.directoryConnect)).status).toBe(401);
    expect((await get(directEnv(), R.directoryCallback)).status).toBe(401);
  });

  it("the final redirect never carries a code or token, with no-referrer", async () => {
    const r = await connect(e(), owner.cookie, g, { sub: admin.sub });
    expect(loc(r.r)).not.toMatch(/code|rt-|at-/);
    expect(r.r.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("crypto", () => {
  it("refresh token at rest is AES-GCM with AD install:version; wrong AD fails", async () => {
    const e = directEnv();
    const sealed = await seal(e, "rt-secret");
    expect(sealed).not.toContain("rt-secret");
    expect(await open(e, sealed)).toBe("rt-secret");
    // Another install id: different AD.
    await expect(
      open(directEnv({ INSTALL_ID: "inst-other" }), sealed),
    ).rejects.toThrow();
    // Another key version: different AD (and version tag).
    await expect(
      open(directEnv({ DIRECTORY_TOKEN_KEY_VERSION: "2" }), sealed),
    ).rejects.toThrow();
    // Another key.
    await expect(
      open(directEnv({ DIRECTORY_TOKEN_KEY: "x".repeat(40) }), sealed),
    ).rejects.toThrow();
    // Random IV: two seals differ.
    expect(await seal(e, "rt-secret")).not.toBe(sealed);
  });
});

describe("hosted", () => {
  it("hosted env has no GOOGLE client secret binding", () => {
    const hosted = hostedEnv();
    expect(Object.keys(hosted)).not.toContain("GOOGLE_DIRECTORY_CLIENT_SECRET");
    expect(Object.keys(hosted)).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("GET R.directory: owners and admins; members 404", async () => {
    const e = hostedEnv();
    const a = await login(uniq("dir-admin"), "admin");
    const m = await login(uniq("dir-member"));
    const s = (await (
      await get(e, R.directory, owner.cookie)
    ).json()) as SyncStatus;
    expect(s.mode).toBe("google");
    expect(s.binding).toBeNull();
    expect((await get(e, R.directory, a.cookie)).status).toBe(200);
    expect((await get(e, R.directory, m.cookie)).status).toBe(404);
  });

  it("an existing user is linked by email in the initial pass", async () => {
    const email = uniq("linked");
    const uid = await seedUser(email, "member");
    const gid = `g-${crypto.randomUUID()}`;
    g.addUser({ id: gid, primaryEmail: email });
    await connect(hostedEnv(), owner.cookie, g, { sub: admin.sub });
    const row = await env.DB.prepare(
      "select user_id, directory_bound from identities where provider = 'google' and subject = ?",
    )
      .bind(gid)
      .first<{ user_id: string; directory_bound: number }>();
    expect(row).toEqual({ user_id: uid, directory_bound: 1 });
  });
});

describe("confirm step", () => {
  const status = async (e: Env, cookie = owner.cookie) =>
    (await (await get(e, R.directory, cookie)).json()) as SyncStatus;
  const ident = (gid: string) =>
    env.DB.prepare(
      "select user_id from identities where provider = 'google' and subject = ?",
    )
      .bind(gid)
      .first();
  const keys = async () => (await state()).map((r) => r.key).sort();

  it("nothing is written to users, identities or memberships before confirm; confirm runs the binding pass", async () => {
    const e = directEnv();
    const linkEmail = uniq("pending-link");
    const linkId = await seedUser(linkEmail, "member");
    const gLink = g.addUser({
      id: `g-pl-${crypto.randomUUID()}`,
      primaryEmail: linkEmail,
    });
    const gNew = g.addUser({
      id: `g-pn-${crypto.randomUUID()}`,
      primaryEmail: uniq("pending-new"),
    });
    const count = async () =>
      (
        await env.DB.prepare(
          "select (select count(*) from users) + (select count(*) from identities) + (select count(*) from space_members) n",
        ).first<{ n: number }>()
      )?.n;
    const before = await count();
    const r = await connect(
      e,
      owner.cookie,
      g,
      { sub: admin.sub },
      { confirm: false },
    );
    expect(r.consented).toBe(true);
    expect(r.path).toBe("/settings/directory");
    expect([...r.q.keys()]).toEqual([]);
    expect(await ident(gLink.id)).toBeNull();
    expect(await ident(gNew.id)).toBeNull();
    expect(await count()).toBe(before);
    const s = await status(e);
    expect(s.state).toBe("pending_confirm");
    // The super admin, the linkable user and the new one: active, in domain.
    expect(s.pendingCount).toBe(3);
    expect(s.pendingCountCapped).toBe(false);
    expect(Date.parse(s.pendingExpiresAt ?? "") - Date.now()).toBeGreaterThan(
      23 * 3600_000,
    );
    // A first connect: nothing is live until confirm.
    expect(s.binding).toBeNull();

    const c = await post(e, R.directoryConfirm, owner.cookie);
    expect(c.status).toBe(200);
    const after = (await c.json()) as SyncStatus;
    expect(after.state).not.toBe("pending_confirm");
    expect(after.pendingCount).toBeNull();
    expect(after.binding?.customerId).toBe(g.customerId);
    expect(await ident(gLink.id)).toEqual({ user_id: linkId });
    expect(await ident(gNew.id)).not.toBeNull();
    // Confirmed once: a second confirm finds nothing pending.
    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(404);
  });

  it("a non-starter owner, an admin or a member gets 404 on confirm and cancel", async () => {
    const e = directEnv();
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    const other = await login(uniq("dir-owner-other"), "owner");
    const a = await login(uniq("dir-admin-c"), "admin");
    const m = await login(uniq("dir-member-c"));
    for (const who of [other, a, m])
      for (const path of [R.directoryConfirm, R.directoryCancel])
        expect((await post(e, path, who.cookie)).status, path).toBe(404);
    expect(await keys()).toEqual([
      "connect.confirm",
      "pending.binding",
      "pending.refresh",
    ]);
  });

  it("an owner demoted after connecting can't confirm (still the org owner required)", async () => {
    const e = directEnv();
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    await env.DB.prepare("update users set role = 'admin' where id = ?")
      .bind(owner.userId)
      .run();
    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(404);
  });

  it("cancel deletes the token and binding, with an audit row", async () => {
    const e = directEnv();
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    expect((await post(e, R.directoryCancel, owner.cookie)).status).toBe(204);
    expect(await keys()).toEqual([]);
    const row = await env.DB.prepare(
      "select detail from audit_events where action = 'directory.disconnect' and actor_id = ?",
    )
      .bind(owner.userId)
      .first<{ detail: string }>();
    expect(JSON.parse(row?.detail ?? "{}")).toEqual({ outcome: "cancelled" });
    expect((await status(e)).binding).toBeNull();
  });

  it("expiry (24 h) deletes the token: lazily on read, on confirm (409), and by the cron", async () => {
    const e = directEnv();
    const age = () =>
      env.DB.prepare(
        "update directory_state set value = json_set(value, '$.exp', 1) where key = 'connect.confirm'",
      ).run();
    // On read.
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    await age();
    const s = await status(e);
    expect(s.state).toBe("never");
    expect(s.binding).toBeNull();
    expect(await keys()).toEqual([]);
    // On confirm: 409 conflict, and dropped.
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    await age();
    const c = await post(e, R.directoryConfirm, owner.cookie);
    expect(c.status).toBe(409);
    expect(((await c.json()) as { error: { code: string } }).error.code).toBe(
      "conflict",
    );
    expect(await keys()).toEqual([]);
    // By the daily cron.
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    await age();
    const waits: Promise<unknown>[] = [];
    await scheduled({} as ScheduledController, e, {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never);
    await Promise.all(waits);
    expect(await keys()).toEqual([]);
    const expired = await env.DB.prepare(
      "select count(*) n from audit_events where action = 'directory.connect' and actor_kind = 'system' and json_extract(detail, '$.outcome') = 'expired'",
    ).first<{ n: number }>();
    expect(expired?.n).toBeGreaterThanOrEqual(3);
  });

  it("the count stops at one page and reports 500+", async () => {
    const e = directEnv();
    for (let i = 0; i < 501; i++)
      g.addUser({
        id: `g-cap-${i}-${crypto.randomUUID()}`,
        primaryEmail: uniq(`cap${i}`),
      });
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    const s = await status(e);
    expect(s.pendingCount).toBe(500);
    expect(s.pendingCountCapped).toBe(true);
  });

  // Review item 33: expiry revoked only after deleting the token, so a
  // failed revoke (always, in the DirectorySync DO: no broker capability
  // there) left a live grant at Google with no stored token to retry.
  const age = () =>
    env.DB.prepare(
      "update directory_state set value = json_set(value, '$.exp', 1) where key = 'connect.confirm'",
    ).run();

  const cron = async (e: Env) => {
    const waits: Promise<unknown>[] = [];
    await scheduled({} as ScheduledController, e, {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never);
    await Promise.all(waits);
  };

  // #813 review: a revoke that keeps failing (no transport, a token that
  // won't unseal) was retried, with an outbound call and an audit row, on
  // every status read. After the first failure only the daily cron retries.
  it("after a failed expiry revoke, status reads don't retry; the cron does", async () => {
    const e = directEnv();
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    await age();
    const failedRows = async () =>
      (await audits()).filter((a) => a.detail.outcome === "revoke_failed")
        .length;
    const f0 = await failedRows();
    g.setRevokeStatus(500);
    for (let i = 0; i < 3; i++) await status(e);
    expect(await failedRows()).toBe(f0 + 1);
    g.setRevokeStatus(200);
    await status(e);
    expect(g.revoked).toEqual([]);
    expect(await keys()).toEqual([
      "connect.confirm",
      "pending.binding",
      "pending.refresh",
    ]);
    await cron(e);
    expect(g.revoked).toEqual([`rt-${admin.sub}`]);
    expect(await keys()).toEqual([]);
  });

  it("expiry revokes before it deletes: a failed revoke keeps the token for the next try", async () => {
    const e = directEnv();
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    await age();
    const expiredRows = async () =>
      (await audits()).filter((a) => a.detail.outcome === "expired").length;
    const n0 = await expiredRows();
    g.setRevokeStatus(500);
    expect((await status(e)).state).toBe("never");
    expect(await expiredRows()).toBe(n0);
    expect(await keys()).toEqual([
      "connect.confirm",
      "pending.binding",
      "pending.refresh",
    ]);
    expect(g.revoked).toEqual([]);
    g.setRevokeStatus(200);
    await cron(e);
    expect(await keys()).toEqual([]);
    expect(g.revoked).toEqual([`rt-${admin.sub}`]);
    const details = (await audits()).map((a) => a.detail);
    expect(details).toContainEqual({
      outcome: "revoke_failed",
      token: "pending",
    });
    expect(details).toContainEqual({ outcome: "revoked", token: "pending" });
    expect(await expiredRows()).toBe(n0 + 1);
  });

  it("the DirectorySync status read leaves expiry to the Worker", async () => {
    const e = hostedEnv();
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    await age();
    const ns = env.DIRECTORY_SYNC;
    if (!ns) throw new Error("DIRECTORY_SYNC unbound");
    const doStatus = await runInDurableObject(
      ns.get(
        ns.idFromName(SYNC_DO_NAME),
      ) as unknown as DurableObjectStub<DirectorySync>,
      (_i, s) => new SyncEngine(e, s.storage).status(),
    );
    expect(doStatus.state).toBe("never");
    expect(await keys()).toEqual([
      "connect.confirm",
      "pending.binding",
      "pending.refresh",
    ]);
    expect(g.revoked).toEqual([]);
    expect((await status(e)).state).toBe("never");
    expect(await keys()).toEqual([]);
    expect(g.revoked).toEqual([`rt-${admin.sub}`]);
  });
});

describe("review fixes", () => {
  it("email linking ignores out-of-domain rows: a guest at a secondary domain stays an unlinked guest", async () => {
    const e = directEnv();
    const email = uniq("bob", "secondary.com");
    const id = await seedUser(email, "guest");
    const gid = `g-sec-${crypto.randomUUID()}`;
    g.addUser({ id: gid, primaryEmail: email });
    expect((await connect(e, owner.cookie, g, { sub: admin.sub })).ok).toBe(
      true,
    );
    expect(
      await env.DB.prepare(
        "select 1 from identities where provider = 'google' and subject = ?",
      )
        .bind(gid)
        .first(),
    ).toBeNull();
    const row = await env.DB.prepare("select role from users where id = ?")
      .bind(id)
      .first<{ role: string }>();
    expect(row?.role).toBe("guest");
  });

  it("every suspended linked user on a page is suspended at once (30, past one batch)", async () => {
    const e = directEnv();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const email = uniq(`susp30-${i}`);
      ids.push(await seedUser(email, "member"));
      g.addUser({
        id: `g-s30-${i}-${crypto.randomUUID()}`,
        primaryEmail: email,
        suspended: true,
      });
    }
    expect((await connect(e, owner.cookie, g, { sub: admin.sub })).ok).toBe(
      true,
    );
    const { results } = await env.DB.prepare(
      `select status from users where id in (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ status: string }>();
    expect(results).toHaveLength(30);
    expect(results.every((r) => r.status === "suspended")).toBe(true);
  });
});

describe.each([
  ["direct", () => directEnv()],
  ["broker", () => hostedEnv()],
] as const)("reconnect (%s)", (_kind, mk) => {
  let e: Env;
  let second: string;
  /** The live rows, as stored. */
  const live = async () =>
    Object.fromEntries(
      (await state())
        .filter((r) => ["binding", "refresh", "grant.sub"].includes(r.key))
        .map((r) => [r.key, r.value]),
    );
  const outcomes = async () =>
    (await audits())
      .filter((r) => r.actor === owner.userId || r.actor === null)
      .map((r) => r.detail.outcome);
  beforeEach(async () => {
    e = mk();
    // A confirmed, live connection by the first super admin.
    expect((await connect(e, owner.cookie, g, { sub: admin.sub })).ok).toBe(
      true,
    );
    second = `g-admin2-${crypto.randomUUID()}`;
    g.addUser({ id: second, primaryEmail: uniq("super2"), isAdmin: true });
    g.revoked.length = 0;
  });

  it("reconnect then cancel keeps the old binding, token and sync; the pending grant is revoked", async () => {
    const before = await live();
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    // The live pair is untouched while the reconnect waits.
    expect(await live()).toEqual(before);
    expect((await post(e, R.directoryCancel, owner.cookie)).status).toBe(204);
    expect(await live()).toEqual(before);
    expect(before["grant.sub"]).toBe(admin.sub);
    expect(g.revoked).toEqual([`rt-${second}`]);
  });

  it("reconnect then expiry keeps the old binding and token; the pending grant is revoked", async () => {
    const before = await live();
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    await env.DB.prepare(
      "update directory_state set value = json_set(value, '$.exp', 1) where key = 'connect.confirm'",
    ).run();
    const s = (await (
      await get(e, R.directory, owner.cookie)
    ).json()) as SyncStatus;
    expect(s.state).not.toBe("pending_confirm");
    expect(await live()).toEqual(before);
    expect(g.revoked).toEqual([`rt-${second}`]);
  });

  it("reconnect then confirm swaps atomically and revokes the OLD grant", async () => {
    const before = await live();
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(200);
    const after = await live();
    expect(after["grant.sub"]).toBe(second);
    expect(after.refresh).not.toBe(before.refresh);
    expect(after.binding).not.toBe(before.binding);
    // Nothing pending is left behind: the swap moved every row.
    expect((await state()).map((r) => r.key).sort()).toEqual(
      ["binding", "binding.initial", "grant.sub", "refresh"].sort(),
    );
    expect(g.revoked).toEqual([`rt-${admin.sub}`]);
    expect(await outcomes()).toContain("revoked");
  });

  it("a failed revoke still confirms, and is audited", async () => {
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    g.setRevokeStatus(500);
    const c = await post(e, R.directoryConfirm, owner.cookie);
    expect(c.status).toBe(200);
    expect((await live())["grant.sub"]).toBe(second);
    expect(await outcomes()).toContain("revoke_failed");
  });

  it("a reconnect by the same Google account never revokes (Google would end the new grant too)", async () => {
    await connect(e, owner.cookie, g, { sub: admin.sub }, { confirm: false });
    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(200);
    expect(g.revoked).toEqual([]);
    expect(await outcomes()).toContain("revoke_skipped");
  });

  it("a second callback landing during confirm: 409 conflict, nothing promoted", async () => {
    const before = await live();
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    const member = await getUser(e, owner.userId);
    const real = directoryClient(e);
    if (!member || !real) throw new Error("setup");
    // The newer consent replaces the pending token after confirm read it.
    const racing = {
      ...real,
      accessToken: async (s: string) => {
        await env.DB.prepare(
          "update directory_state set value = 'newer' where key = 'pending.refresh'",
        ).run();
        return real.accessToken(s);
      },
    };
    await expect(afterConsent(e, racing, member)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await live()).toEqual(before);
    expect(
      (await state()).find((r) => r.key === "pending.refresh")?.value,
    ).toBe("newer");
    expect(g.revoked).toEqual([]);
  });

  it("a pending consent without a Google account clears grant.sub on confirm", async () => {
    expect((await live())["grant.sub"]).toBe(admin.sub);
    await connect(e, owner.cookie, g, { sub: second }, { confirm: false });
    await env.DB.prepare(
      "update directory_state set value = json_remove(value, '$.s') where key = 'connect.confirm'",
    ).run();
    expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(200);
    expect((await live())["grant.sub"]).toBeUndefined();
    // Unknown account: the old grant is not revoked (fail safe).
    expect(g.revoked).toEqual([]);
  });
});
