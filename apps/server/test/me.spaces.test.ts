// GET /me personalSpaceId and spaces (hosted M1 item 2): the shared spaces
// where the caller has a role (rank >= 1), by name, at most LIST_SPACES_MAX.
// Only where /me shows its hosted fields, and only with the spaces feature.
import { env } from "cloudflare:workers";
import {
  LIST_SPACES_MAX,
  type Me,
  MeSchema,
  newId,
  R,
  type SpaceRole,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { showsSignInFields } from "../src/auth/sign-in.js";
import type { Env } from "../src/env.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

const base = { ...(env as object), PLAN: "paid" };
/** Hosted, spaces on. */
const ON = { ...base, HOSTED: "1", FEATURES: "spaces" } as unknown as Env;
/** Hosted, spaces on, sync frozen (manual restriction allowed). */
const FROZEN = {
  ...base,
  HOSTED: "1",
  FEATURES: "spaces,sync_frozen",
} as unknown as Env;
/** Hosted, spaces off. */
const OFF = { ...base, HOSTED: "1", FEATURES: "" } as unknown as Env;
/** Access-only self-host with spaces: /me keeps today's shape. */
const ACCESS = { ...base, FEATURES: "spaces" } as unknown as Env;

const call = (e: Env, path: string, cookie: string, method = "GET") =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method,
      headers: { "x-oa-request": "1", cookie },
    }),
    e,
  );
const getMe = async (e: Env, cookie: string): Promise<Me> => {
  const r = await call(e, R.me, cookie);
  expect(r.status).toBe(200);
  return MeSchema.parse(await r.json());
};
const run = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run();

/** A shared space row; names carry the file's tag so other rows sort apart. */
const space = async (
  name: string,
  o: { all?: SpaceRole; deleted?: boolean; publicLinks?: boolean } = {},
) => {
  const id = newId();
  await run(
    "insert into spaces (id, kind, name, all_members_role, public_links, created_at, deleted_at) values (?, 'shared', ?, ?, ?, 1, ?)",
    id,
    `${name} ${tag}`,
    o.all ?? null,
    o.publicLinks === false ? 0 : 1,
    o.deleted ? 2 : null,
  );
  return id;
};
const grant = (spaceId: string, userId: string, role: SpaceRole) =>
  run(
    "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, 'manual', 1)",
    spaceId,
    userId,
    role,
  );
const mine = (me: Me) =>
  (me.spaces ?? [])
    .filter((s) => s.name.endsWith(` ${tag}`))
    .map((s) => [s.name.replace(` ${tag}`, ""), s.myRole]);

type U = { cookie: string; userId: string };
let member: U;
let guest: U;
let admin: U;
const ids: Record<string, string> = {};

beforeAll(async () => {
  member = await login(`me-sp-m-${tag}@x.com`, "member");
  guest = await login(`me-sp-g-${tag}@x.com`, "guest");
  admin = await login(`me-sp-a-${tag}@x.com`, "admin");
  ids.zeta = await space("Zeta");
  ids.alpha = await space("Alpha", { all: "viewer", publicLinks: false });
  ids.mid = await space("Mid");
  ids.none = await space("Nobody");
  ids.gone = await space("Gone", { all: "editor", deleted: true });
  await grant(ids.zeta, member.userId, "manager");
  await grant(ids.mid, member.userId, "editor");
  await grant(ids.mid, guest.userId, "viewer");
  await grant(ids.gone, member.userId, "manager");
});

describe("GET /me spaces", () => {
  it("lists the shared spaces the caller has a role in, by name, with personalSpaceId", async () => {
    expect(showsSignInFields(ON)).toBe(true);
    const me = await getMe(ON, member.cookie);
    expect(me.personalSpaceId).toBe(member.userId);
    // Alpha via allMembersRole; Mid and Zeta manual; Nobody (no role) and
    // Gone (deleted) are left out.
    expect(mine(me)).toEqual([
      ["Alpha", "viewer"],
      ["Mid", "editor"],
      ["Zeta", "manager"],
    ]);
    expect(me.spaces?.find((s) => s.id === ids.alpha)).toEqual({
      id: ids.alpha,
      kind: "shared",
      name: `Alpha ${tag}`,
      publicLinks: false,
      myRole: "viewer",
    });
    expect(me.spaces?.find((s) => s.id === ids.zeta)?.publicLinks).toBe(true);
  });

  it("an org admin gets only the spaces they hold a role in", async () => {
    const me = await getMe(ON, admin.cookie);
    expect(me.personalSpaceId).toBe(admin.userId);
    expect(mine(me)).toEqual([["Alpha", "viewer"]]);
  });

  it("allMembersRole never reaches a guest or a restricted member", async () => {
    expect(mine(await getMe(ON, guest.cookie))).toEqual([["Mid", "viewer"]]);
    const r = await login(`me-sp-r-${tag}@x.com`, "member");
    await grant(ids.zeta, r.userId, "editor");
    expect(mine(await getMe(FROZEN, r.cookie))).toEqual([
      ["Alpha", "viewer"],
      ["Zeta", "editor"],
    ]);
    const set = await call(
      FROZEN,
      R.memberRestricted(r.userId),
      admin.cookie,
      "PUT",
    );
    expect(set.status).toBe(200);
    expect(mine(await getMe(FROZEN, r.cookie))).toEqual([["Zeta", "editor"]]);
  });

  it(`stops at LIST_SPACES_MAX (${LIST_SPACES_MAX})`, async () => {
    const u = await login(`me-sp-max-${tag}@x.com`, "member");
    const stmts = [];
    for (let i = 0; i <= LIST_SPACES_MAX; i++) {
      const id = newId();
      const name = `Many ${String(i).padStart(3, "0")} ${tag}`;
      stmts.push(
        env.DB.prepare(
          "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 1, 1)",
        ).bind(id, name),
        env.DB.prepare(
          "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'manual', 1)",
        ).bind(id, u.userId),
      );
    }
    await env.DB.batch(stmts);
    const me = await getMe(ON, u.cookie);
    expect(me.spaces).toHaveLength(LIST_SPACES_MAX);
    const names = (me.spaces ?? []).map((s) => s.name);
    expect(names).toEqual([...names].sort());
    // Alpha (allMembersRole) sorts first; the last Many row is cut.
    expect(names[0]).toBe(`Alpha ${tag}`);
    expect(names).not.toContain(`Many ${LIST_SPACES_MAX} ${tag}`);
  });

  it("spaces off: no personalSpaceId and no spaces (today's shape)", async () => {
    const me = await getMe(OFF, member.cookie);
    expect(me.instance.hosted).toBe(true);
    expect(me).not.toHaveProperty("personalSpaceId");
    expect(me).not.toHaveProperty("spaces");
  });

  it("Access-only installs keep today's shape even with spaces on", async () => {
    expect(showsSignInFields(ACCESS)).toBe(false);
    const me = await getMe(ACCESS, member.cookie);
    expect(me).not.toHaveProperty("auth");
    expect(me).not.toHaveProperty("personalSpaceId");
    expect(me).not.toHaveProperty("spaces");
  });
});
