// P2 item 1: GET R.members on hosted and direct-sign-in installs carries
// status, identities and restriction on every row, as MemberSchema says, read
// in a fixed number of queries (no per-member round trip). Access-only
// installs keep today's shape.
import { env } from "cloudflare:workers";
import { type Member, MemberSchema, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const DIRECT = direct();
const run = (sql: string, ...b: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...b)
    .run();

/** Counts the statements the app prepares through `e.DB`. */
function counting(e: Env): { env: Env; n: () => number } {
  let n = 0;
  const DB = new Proxy(e.DB, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (k === "prepare")
        return (q: string) => {
          n++;
          return t.prepare(q);
        };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { env: { ...e, DB } as Env, n: () => n };
}

async function cookieFor(e: Env, userId: string) {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(userId)
    .first<{ e: number }>();
  return `${sessionCookieName(e)}=${await signSession(e, userId, Date.now(), {
    provider: "google",
    tenant: "a.com",
    epoch: row?.e ?? 0,
  })}`;
}

const get = (e: Env, path: string, cookie: string) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      headers: { "x-oa-request": "1", cookie },
    }),
    e,
  );

let owner: string;
let ownerCookie: string;
let linked: string;
let manual: string;
let grouped: string;
let groupedAdmin: string;
let gone: string;
let group: string;

beforeAll(async () => {
  owner = await seedUser(uniq("hf-owner"), "admin", { googleSub: uniq("s") });
  ownerCookie = await cookieFor(DIRECT, owner);
  linked = await seedUser(uniq("hf-linked"), "member", {
    googleSub: uniq("s"),
  });
  manual = await seedUser(uniq("hf-manual"), "member");
  await run("update users set restricted_manual = 1 where id = ?", manual);
  grouped = await seedUser(uniq("hf-grouped"), "member");
  groupedAdmin = await seedUser(uniq("hf-gadmin"), "admin");
  const g = `hfG${crypto.randomUUID().slice(0, 8)}`;
  await run(
    "insert into directory_groups (group_id, email) values (?, ?)",
    g,
    `${g}@a.com`,
  );
  await run(
    "insert into restricted_groups (group_id, group_email) values (?, ?)",
    g,
    `${g}@a.com`,
  );
  for (const u of [grouped, groupedAdmin])
    await run(
      "insert into directory_members (group_id, user_id) values (?, ?)",
      g,
      u,
    );
  // RESTRICTED_SYNC_CASE: the member is capped, the admin never.
  await run("update users set restricted_sync = 1 where id = ?", grouped);
  gone = await seedUser(uniq("hf-gone"), "member", { status: "suspended" });
  group = g;
});

const list = async (e: Env, query = "") => {
  const r = await get(e, `${R.members}${query}`, await cookieFor(e, owner));
  expect(r.status).toBe(200);
  return z.array(MemberSchema).parse(await r.json());
};
const byId = (ms: Member[], id: string) => ms.find((m) => m.id === id);

describe("GET /members on a direct-sign-in install", () => {
  it("every row carries status, identities and restriction", async () => {
    const ms = await list(DIRECT);
    const g = group;
    expect(byId(ms, owner)).toMatchObject({
      status: "active",
      identities: ["google"],
      restriction: null,
    });
    expect(byId(ms, linked)).toMatchObject({
      status: "active",
      identities: ["google"],
      restriction: null,
    });
    expect(byId(ms, manual)).toMatchObject({
      identities: [],
      restriction: { manual: true, groups: [] },
    });
    expect(byId(ms, grouped)?.restriction).toEqual({
      manual: false,
      groups: [{ groupId: g, email: `${g}@a.com`, name: null }],
    });
    // Owners and admins are never restricted, even in a restricted group.
    expect(byId(ms, groupedAdmin)?.restriction).toBeNull();
    for (const m of ms) {
      expect(m).toHaveProperty("status");
      expect(m).toHaveProperty("identities");
      expect(m).toHaveProperty("restriction");
    }
    expect(byId(ms, gone)).toBeUndefined();
    const departed = await list(DIRECT, "?status=suspended");
    expect(byId(departed, gone)).toMatchObject({
      status: "suspended",
      identities: [],
      restriction: null,
    });
  });

  it("reads the fields in a fixed number of statements (no per-member query)", async () => {
    const before = counting(DIRECT);
    const n0 = (await list(before.env)).length;
    const base = before.n();
    for (let i = 0; i < 5; i++)
      await seedUser(uniq("hf-more"), "member", { googleSub: uniq("s") });
    const after = counting(DIRECT);
    expect((await list(after.env)).length).toBe(n0 + 5);
    expect(after.n()).toBe(base);
  });
});

describe("GET /members on an Access-only install", () => {
  it("the same shape as every install: status, identities and restriction on every row (parity 1, A8)", async () => {
    const o = await login(uniq("hf-access-owner"), "owner");
    const r = await get(env as Env, R.members, o.cookie);
    expect(r.status).toBe(200);
    const ms = (await r.json()) as Record<string, unknown>[];
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) {
      expect(m).toHaveProperty("identities");
      expect(m).toHaveProperty("restriction");
      expect(m.status).toBe("active");
    }
  });
});
