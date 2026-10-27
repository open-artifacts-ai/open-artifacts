// P5 Task 3b (#655): the three directory surfaces (and the broker check) the cross-install red-line
// suite drops (its installs have no connected directory) get the same
// proof here, in-server. Another install's credential is modelled two ways:
// a session for this install's own user id signed with another
// SESSION_SECRET, and a well-formed PAT this install never issued. Each
// case first proves this install's own credential succeeds on the same
// request, so a server that refuses everything can't pass.
import { env } from "cloudflare:workers";
import { newId, newPat, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { TEST_BROKER_KEY } from "./auth-helpers.js";
import { directEnv } from "./directory-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
/** Spaces on, Google sync running (a mapping can exist). */
const GOOGLE = {
  ...(env as object),
  PLAN: "paid",
  FEATURES: "spaces,sync_google",
} as unknown as Env;
/** Another install's signing key. */
const OTHER_SECRET = "another-install-session-secret-0123456789abcdef";

type U = { cookie: string; userId: string };
let admin: U;
let owner: U;

/** The other install's session for `userId` (same id, its own key). */
const foreignSession = async (userId: string) =>
  `${sessionCookieName(env)}=${await signSession(
    { ...(env as object), SESSION_SECRET: OTHER_SECRET } as Env,
    userId,
    Date.now(),
    { provider: "access", epoch: 0 },
  )}`;

type Cred = { cookie?: string; token?: string };
const call = (e: Env, method: string, path: string, c: Cred) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-oa-request": "1",
        ...(c.cookie ? { cookie: c.cookie } : {}),
        ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
      },
    }),
    e,
  );

const one = <T>(sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .first<T>();
const run = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run();

/** A refusal: 401 or 404, and no session cookie set. */
async function refused(r: Response) {
  await r.body?.cancel();
  expect([401, 404]).toContain(r.status);
  expect(r.headers.getSetCookie().some((c) => /oa_session=[^;]/.test(c))).toBe(
    false,
  );
}

beforeAll(async () => {
  admin = await login(`rl-adm-${tag}@x.com`, "admin");
  owner = await login(`rl-own-${tag}@x.com`, "owner");
});

/** A shared space with one mapping of `role` for a fresh directory group. */
async function mapped(role: "viewer" | "manager") {
  const created = await fetchAndWait(
    app,
    new Request(`http://app.localhost${R.spaces}`, {
      method: "POST",
      headers: {
        "x-oa-request": "1",
        cookie: admin.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: `rl ${newId().slice(0, 6)}` }),
    }),
    GOOGLE,
  );
  expect(created.status).toBe(201);
  const s = (await created.json()) as { id: string };
  const g = `g${newId().slice(0, 10)}`;
  await run(
    "insert into directory_groups (group_id, email) values (?, ?)",
    g,
    `${g.toLowerCase()}@x.com`,
  );
  await run(
    "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, ?)",
    s.id,
    g,
    `${g.toLowerCase()}@x.com`,
    role,
  );
  return { space: s.id, group: g };
}

const mappingExists = async (space: string, group: string) =>
  (
    await one<{ n: number }>(
      "select count(*) n from group_mappings where space_id = ? and group_id = ?",
      space,
      group,
    )
  )?.n === 1;

async function mappingDelete(role: "viewer" | "manager") {
  const { space, group } = await mapped(role);
  const path = R.spaceMapping(space, group);
  for (const c of [
    { cookie: await foreignSession(admin.userId) },
    { token: newPat() },
  ]) {
    await refused(await call(GOOGLE, "DELETE", path, c));
    expect(await mappingExists(space, group)).toBe(true);
  }
  const own = await call(GOOGLE, "DELETE", path, admin);
  await own.body?.cancel();
  expect(own.status).toBe(204);
  expect(await mappingExists(space, group)).toBe(false);
}

describe("red line: another install's credential on the dropped directory surfaces", () => {
  it("DELETE a space viewer mapping: another install's session or PAT is refused and the mapping stays; this install's admin deletes it", () =>
    mappingDelete("viewer"));

  it("DELETE a space manager mapping: another install's session or PAT is refused and the mapping stays; this install's admin deletes it", () =>
    mappingDelete("manager"));

  it("GET directory/callback: another install's session or PAT is refused with no audit row; this install's owner reaches the handler", async () => {
    const e = directEnv();
    const audits = async () =>
      (
        await one<{ n: number }>(
          "select count(*) n from audit_events where action = 'directory.connect'",
        )
      )?.n ?? 0;
    const before = await audits();
    for (const c of [
      { cookie: await foreignSession(owner.userId) },
      { token: newPat() },
    ]) {
      await refused(await call(e, "GET", R.directoryCallback, c));
      expect(await audits()).toBe(before);
    }
    // The owner's own session reaches the handler: no state cookie, so the
    // callback refuses with ?error= and audits it.
    const own = await call(e, "GET", R.directoryCallback, owner);
    await own.body?.cancel();
    expect(own.status).toBe(302);
    expect(own.headers.get("location") ?? "").toMatch(/[?&]error=/);
    expect(await audits()).toBe(before + 1);
  });
});

describe("red line: another install's credential on the broker check", () => {
  it("POST admin/broker-check: another install's owner session or PAT is refused with no audit row and no broker call; this install's owner runs it", async () => {
    const calls: string[] = [];
    const broker = {
      fetch: (req: Request) => {
        calls.push(new URL(req.url).pathname);
        return Promise.resolve(
          Response.json({ error: "unauthorized" }, { status: 401 }),
        );
      },
    } as unknown as Fetcher;
    const e = {
      ...(env as object),
      AUTH_PROVIDERS: "google,email",
      AUTH_DOMAINS: "a.com",
      GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
      INSTALL_ID: "inst-a",
      AUTH_BROKER_URL: "https://auth.hosted.test",
      BROKER_SIGNING_KEY: TEST_BROKER_KEY,
      BROKER: broker,
    } as unknown as Env;
    const audits = async () =>
      (
        await one<{ n: number }>(
          "select count(*) n from audit_events where action = 'auth.broker_check'",
        )
      )?.n ?? 0;
    const before = await audits();
    for (const c of [
      { cookie: await foreignSession(owner.userId) },
      { token: newPat() },
    ]) {
      await refused(await call(e, "POST", R.adminBrokerCheck, c));
      expect(await audits()).toBe(before);
    }
    expect(calls).toEqual([]);
    const own = await call(e, "POST", R.adminBrokerCheck, owner);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { auth: { ok: boolean } }).auth.ok).toBe(
      true,
    );
    expect(calls).toEqual(["/google/redeem"]);
    expect(await audits()).toBe(before + 1);
  });
});
