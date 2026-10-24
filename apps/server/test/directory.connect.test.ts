// P3 T12: directory connect. The callback runs every check in order and
// fails closed: each refusal redirects to /settings/directory?error=<code>
// with a directory.connect audit row; success stores the binding and the
// sealed refresh token, then runs the initial binding pass.
import { env } from "cloudflare:workers";
import { R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open, seal } from "../src/directory/crypto.js";
import type { Env } from "../src/env.js";
import { seedUser, uniq } from "./auth-helpers.js";
import {
  begin,
  connect,
  directEnv,
  get,
  hostedEnv,
  loc,
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
] as const)("%s transport", (_kind, mk) => {
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
    expect(a.q.get("error")).toBe("domain_mismatch");
    const none = await connect(e, owner.cookie, g, {
      sub: admin.sub,
      hd: null,
    });
    expect(none.q.get("error")).toBe("domain_mismatch");
    g.domains.set(g.customerId, [{ domainName: "other.com", verified: true }]);
    const b = await connect(e, owner.cookie, g, { sub: admin.sub });
    expect(b.q.get("error")).toBe("domain_mismatch");
    // Listed but unverified is not enough.
    g.domains.set(g.customerId, [{ domainName: "a.com", verified: false }]);
    const c = await connect(e, owner.cookie, g, { sub: admin.sub });
    expect(c.q.get("error")).toBe("domain_mismatch");
    expect(await binding()).toBeNull();
  });

  it("callback refuses missing scopes → ?error=scopes; accepts openid email plus the four → ?connected=1", async () => {
    const r = await connect(e, owner.cookie, g, {
      sub: admin.sub,
      scope:
        "openid email https://www.googleapis.com/auth/admin.directory.user.readonly",
    });
    expect(r.q.get("error")).toBe("scopes");
    expect(await binding()).toBeNull();
    const ok = await connect(e, owner.cookie, g, { sub: admin.sub });
    expect(ok.q.get("connected")).toBe("1");
    expect(JSON.parse((await binding()) as string)).toMatchObject({
      provider: "google",
      customerId: g.customerId,
      domain: "a.com",
      connectedBy: owner.userId,
    });
  });

  it("a reconnect to another customer → ?error=customer_mismatch; the binding stays", async () => {
    expect(
      (await connect(e, owner.cookie, g, { sub: admin.sub })).q.get(
        "connected",
      ),
    ).toBe("1");
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
    expect(await open(e, sealed)).toBe(`rt-${admin.sub}`);
  });

  it("audits each outcome with ids and enums only (no email, code or token)", async () => {
    const del = g.addUser({
      id: `g-del-${crypto.randomUUID()}`,
      primaryEmail: uniq("delegated"),
    });
    await connect(e, owner.cookie, g, { sub: del.id });
    await connect(e, owner.cookie, g, { sub: admin.sub });
    const rows = (await audits()).filter((r) => r.actor === owner.userId);
    expect(rows.map((r) => r.detail.outcome)).toEqual(["refused", "connected"]);
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
    expect(ok.q.get("connected")).toBe("1");
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
