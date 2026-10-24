// P3 T12: the directory transport (broker or direct), resolved once from
// env. HOSTED=1 only tightens: direct variables, or no broker, resolve to
// none (no directory).
import { env } from "cloudflare:workers";
import { R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_PAGES, initialBinding } from "../src/directory/binding.js";
import { directoryClient } from "../src/directory/client.js";
import { seal } from "../src/directory/crypto.js";
import {
  directoryTransport,
  HOSTED_NEEDS_BROKER,
} from "../src/directory/transport.js";
import { seedUser, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import {
  BROKER,
  connect,
  DIR_CID,
  DIR_KEY,
  directEnv,
  get,
  hostedEnv,
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
let adminSub: string;
beforeEach(async () => {
  await resetDirectory();
  await registerInstall();
  g = fakeDirectory();
  owner = await login(uniq("tr-owner"), "owner");
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});
afterEach(() => vi.restoreAllMocks());

describe("directoryTransport", () => {
  it("resolves broker, direct and none", () => {
    expect(directoryTransport(hostedEnv())).toMatchObject({
      kind: "broker",
      brokerUrl: BROKER,
      installId: "inst-a",
    });
    expect(directoryTransport(directEnv())).toEqual({
      kind: "direct",
      clientId: DIR_CID,
      secret: "dir-secret",
    });
    expect(
      directoryTransport(directEnv({ GOOGLE_DIRECTORY_CLIENT_SECRET: "" })),
    ).toMatchObject({ kind: "none" });
    expect(
      directoryTransport(directEnv({ DIRECTORY_TOKEN_KEY: "short" })),
    ).toMatchObject({ kind: "none" });
    expect(directoryTransport(directEnv({ AUTH_DOMAINS: "" }))).toMatchObject({
      kind: "none",
    });
    expect(
      directoryTransport(hostedEnv({ BROKER_SIGNING_KEY: "x" })),
    ).toMatchObject({ kind: "none" });
  });

  it("HOSTED=1 only tightens: direct vars or no broker resolve to none", () => {
    expect(
      directoryTransport(
        hostedEnv({
          GOOGLE_DIRECTORY_CLIENT_ID: DIR_CID,
          GOOGLE_DIRECTORY_CLIENT_SECRET: "tenant-secret",
        }),
      ),
    ).toEqual({ kind: "none", problem: HOSTED_NEEDS_BROKER });
    expect(
      directoryTransport(hostedEnv({ GOOGLE_DIRECTORY_CLIENT_ID: DIR_CID })),
    ).toEqual({ kind: "none", problem: HOSTED_NEEDS_BROKER });
    // The sign-in broker's URL never stands in for the directory broker.
    expect(
      directoryTransport(
        hostedEnv({
          DIRECTORY_BROKER_URL: undefined,
          AUTH_BROKER_URL: "https://auth.hosted.test",
        }),
      ),
    ).toEqual({ kind: "none", problem: HOSTED_NEEDS_BROKER });
    expect(directoryTransport(directEnv({ HOSTED: "1" }))).toEqual({
      kind: "none",
      problem: HOSTED_NEEDS_BROKER,
    });
  });

  it("HOSTED=1 with direct config resolves to none: connect 404, SyncStatus mode off with the problem", async () => {
    const e = directEnv({ HOSTED: "1" });
    expect((await get(e, R.directoryConnect, owner.cookie)).status).toBe(404);
    expect((await get(e, R.directoryCallback, owner.cookie)).status).toBe(404);
    const s = (await (
      await get(e, R.directory, owner.cookie)
    ).json()) as SyncStatus;
    expect(s.mode).toBe("off");
    expect(s.healthy).toBeNull();
    expect(s.lastError?.message).toBe(HOSTED_NEEDS_BROKER);
    // The problem is the owner's; an admin sees mode off only.
    const a = await login(uniq("tr-admin"), "admin");
    const sa = (await (
      await get(e, R.directory, a.cookie)
    ).json()) as SyncStatus;
    expect(sa.mode).toBe("off");
    expect(sa.lastError).toBeNull();
  });

  it("connect is 404 while directory sync is off (FEATURES)", async () => {
    expect(
      (
        await get(
          directEnv({ FEATURES: "spaces" }),
          R.directoryConnect,
          owner.cookie,
        )
      ).status,
    ).toBe(404);
  });
});

describe("direct", () => {
  it("direct: code exchange and refresh against the fake Google; the refresh token is sealed", async () => {
    const e = directEnv();
    const r = await connect(e, owner.cookie, g, { sub: adminSub });
    expect(r.ok).toBe(true);
    const ex = g.tokenCalls.find(
      (t) => t.get("grant_type") === "authorization_code",
    );
    expect(ex?.get("client_id")).toBe(DIR_CID);
    expect(ex?.get("client_secret")).toBe("dir-secret");
    expect(ex?.get("redirect_uri")).toBe(
      `http://app.localhost${R.directoryCallback}`,
    );
    const sealed = (
      await env.DB.prepare(
        "select value from directory_state where key = 'refresh'",
      ).first<{ value: string }>()
    )?.value as string;
    expect(sealed).not.toContain("rt-");
    const at = await directoryClient(e)?.accessToken(sealed);
    expect(at).toBe("at-refreshed");
    const rf = g.tokenCalls.find(
      (t) => t.get("grant_type") === "refresh_token",
    );
    expect(rf?.get("refresh_token")).toBe(`rt-${adminSub}`);
    expect(rf?.get("client_secret")).toBe("dir-secret");
  });

  it("direct: consent URL carries the scopes, offline consent and hd", async () => {
    const res = await get(directEnv(), R.directoryConnect, owner.cookie);
    const u = new URL(res.headers.get("location") ?? "");
    expect(u.searchParams.get("client_id")).toBe(DIR_CID);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("hd")).toBe("a.com");
    expect(u.searchParams.get("scope")).toContain(
      "admin.reports.audit.readonly",
    );
  });

  it("an aud for another client is refused (direct checks aud)", async () => {
    const e = directEnv();
    const r = await connect(e, owner.cookie, g, {
      sub: adminSub,
      aud: "other-client",
    });
    expect(r.q.get("error")).toBe("failed");
    expect(
      await env.DB.prepare(
        "select 1 from directory_state where key = 'binding'",
      ).first(),
    ).toBeNull();
    // The same grant with this install's client id connects.
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
  });
});

describe("broker", () => {
  it("broker: the install signs the token call and never sees a client secret", async () => {
    const e = hostedEnv();
    const r = await connect(e, owner.cookie, g, { sub: adminSub });
    expect(r.ok).toBe(true);
    const ex = g.tokenCalls.find(
      (t) => t.get("grant_type") === "authorization_code",
    );
    // The broker's directory client, from the broker's env.
    expect(ex?.get("client_secret")).toBe("broker-dir-secret");
    expect(ex?.get("redirect_uri")).toBe(`${BROKER}/google/directory/callback`);
    const sealed = (
      await env.DB.prepare(
        "select value from directory_state where key = 'refresh'",
      ).first<{ value: string }>()
    )?.value as string;
    expect(await directoryClient(e)?.accessToken(sealed)).toBe("at-refreshed");
  });

  it("broker: a revoked grant surfaces as invalid_grant; a raw refresh token is refused", async () => {
    const e = hostedEnv();
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    const sealed = (
      await env.DB.prepare(
        "select value from directory_state where key = 'refresh'",
      ).first<{ value: string }>()
    )?.value as string;
    g.setRefreshStatus(400);
    await expect(directoryClient(e)?.accessToken(sealed)).rejects.toMatchObject(
      { stage: "invalid_grant" },
    );
    // Google's own token, not the broker's install-bound wrap: refused.
    await expect(
      directoryClient(e)?.accessToken(await seal(e, `rt-${adminSub}`)),
    ).rejects.toMatchObject({ stage: "refused" });
  });

  it("broker: a request signed with another key is refused", async () => {
    const other = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, 9),
    ]).toString("base64url");
    expect(other).not.toBe(TEST_BROKER_KEY);
    const e = hostedEnv({ BROKER_SIGNING_KEY: other });
    await expect(
      directoryClient(e)?.accessToken(await seal(e, "rt-x")),
    ).rejects.toMatchObject({ stage: "refused" });
  });
});

describe.each(["broker", "direct"] as const)("%s", (kind) => {
  const mk = () => (kind === "broker" ? hostedEnv() : directEnv());
  it(`${kind}: the same callback checks (super admin, customer, domain, scopes) fail closed`, async () => {
    const e = mk();
    const del = g.addUser({
      id: `g-del-${crypto.randomUUID()}`,
      primaryEmail: uniq("del"),
    });
    expect(
      (await connect(e, owner.cookie, g, { sub: del.id })).q.get("error"),
    ).toBe("not_super_admin");
    expect(
      (await connect(e, owner.cookie, g, { sub: adminSub, hd: "b.com" })).q.get(
        "error",
      ),
      // The broker refuses an unlisted hd first, with the generic error.
    ).toBe(kind === "broker" ? "failed" : "domain_mismatch");
    expect(
      (
        await connect(e, owner.cookie, g, {
          sub: adminSub,
          scope: "openid email",
        })
      ).q.get("error"),
    ).toBe("scopes");
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    const foreign = g.addUser({
      id: `g-f-${crypto.randomUUID()}`,
      primaryEmail: uniq("f"),
      isAdmin: true,
      customerId: "C-OTHER",
    });
    g.domains.set("C-OTHER", [{ domainName: "a.com", verified: true }]);
    expect(
      (await connect(e, owner.cookie, g, { sub: foreign.id })).q.get("error"),
    ).toBe("customer_mismatch");
  });
});

describe("initial binding", () => {
  const ident = (gid: string) =>
    env.DB.prepare(
      "select user_id, directory_bound from identities where provider = 'google' and subject = ?",
    )
      .bind(gid)
      .first<{ user_id: string; directory_bound: number }>();

  it("initial binding links existing users by email once, later passes never match by email", async () => {
    const e = directEnv();
    const first = uniq("bob");
    const bobId = await seedUser(first, "member");
    const gBob = g.addUser({
      id: `g-bob-${crypto.randomUUID()}`,
      primaryEmail: first,
    });
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    expect(await ident(gBob.id)).toEqual({
      user_id: bobId,
      directory_bound: 1,
    });

    // A later pass (a reconnect): a pre-existing row with a new directory
    // address is not matched by email, and no duplicate row is created.
    const later = uniq("carol");
    const carolId = await seedUser(later, "member");
    const gCarol = g.addUser({
      id: `g-carol-${crypto.randomUUID()}`,
      primaryEmail: later,
    });
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    expect(await ident(gCarol.id)).toBeNull();
    const rows = await env.DB.prepare("select id from users where email = ?")
      .bind(later)
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual([carolId]);
  });

  it("creates rows (and personal spaces) for unknown in-domain users; skips other domains and suspended users", async () => {
    const e = directEnv();
    const inDomain = g.addUser({
      id: `g-n-${crypto.randomUUID()}`,
      primaryEmail: uniq("new"),
    });
    const outside = g.addUser({
      id: `g-o-${crypto.randomUUID()}`,
      primaryEmail: uniq("out", "elsewhere.com"),
    });
    const susp = g.addUser({
      id: `g-s-${crypto.randomUUID()}`,
      primaryEmail: uniq("susp"),
      suspended: true,
    });
    await connect(e, owner.cookie, g, { sub: adminSub });
    const n = await ident(inDomain.id);
    expect(n?.directory_bound).toBe(1);
    const u = await env.DB.prepare(
      "select role, status, (select kind from spaces where id = users.id) kind from users where id = ?",
    )
      .bind(n?.user_id)
      .first();
    expect(u).toEqual({ role: "member", status: "active", kind: "personal" });
    expect(await ident(outside.id)).toBeNull();
    expect(await ident(susp.id)).toBeNull();
  });

  it("a linked user suspended in Google is suspended at once", async () => {
    const e = directEnv();
    const email = uniq("gone");
    const id = await seedUser(email, "member");
    g.addUser({
      id: `g-g-${crypto.randomUUID()}`,
      primaryEmail: email,
      suspended: true,
    });
    await connect(e, owner.cookie, g, { sub: adminSub });
    const row = await env.DB.prepare("select status from users where id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("suspended");
  });

  it("new rows start restricted while a restricted group exists (fail closed)", async () => {
    const e = directEnv();
    await env.DB.prepare(
      "insert into restricted_groups (group_id, group_email) values ('grp-r', 'r@a.com')",
    ).run();
    const nu = g.addUser({
      id: `g-r-${crypto.randomUUID()}`,
      primaryEmail: uniq("r"),
    });
    await connect(e, owner.cookie, g, { sub: adminSub });
    const row = await env.DB.prepare(
      "select restricted_sync r from users where id = (select user_id from identities where provider = 'google' and subject = ?)",
    )
      .bind(nu.id)
      .first<{ r: number }>();
    expect(row?.r).toBe(1);
    await env.DB.prepare("delete from restricted_groups").run();
  });

  it(`stops after ${INITIAL_PAGES} pages and keeps the cursor for T13`, async () => {
    const e = directEnv();
    g.setPageSize(1);
    for (let i = 0; i < INITIAL_PAGES + 2; i++)
      g.addUser({
        id: `g-p-${i}-${crypto.randomUUID()}`,
        primaryEmail: uniq(`p${i}`),
      });
    const pass = await initialBinding(e, "at", g.customerId, "a.com");
    expect(pass.done).toBe(false);
    expect(pass.cursor).toBe(String(INITIAL_PAGES));
    const next = await initialBinding(e, "at", g.customerId, "a.com");
    expect(next.done).toBe(true);
    expect(next.cursor).toBeNull();
    expect(DIR_KEY.length).toBeGreaterThanOrEqual(32);
  });
});
