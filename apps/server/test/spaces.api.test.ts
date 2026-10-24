// P3 T9: the spaces API (spaces, members, mappings, Every-space mappings,
// restrictions, the spaceManagerMappings setting) and space-wide narrowing:
// every narrowing closes the affected users' live sockets (revokeUserLive)
// in the same request, and every mutation is audited in its own batch.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type AccessLevel,
  type GroupMapping,
  newId,
  type Page,
  R,
  type Space,
  type SpaceMember,
  type SpaceMembersPage,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { accessLevel, callerOf } from "../src/auth/authz.js";
import type { Env } from "../src/env.js";
import type { UserPresence } from "../src/runtime/presence.js";
import { revokeUsersLive } from "../src/runtime/revoke.js";
import { getUser } from "../src/services/users.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

const sent: { to: string; subject: string }[] = [];
const MAIL = {
  EMAIL: {
    send: async (m: { to: string; subject: string }) => {
      sent.push({ to: m.to, subject: m.subject });
      return { messageId: "m" };
    },
  },
  EMAIL_FROM: "oa@example.com",
};
const base = env as object;
/** Spaces on, Google sync running. */
const GOOGLE = {
  ...base,
  ...MAIL,
  FEATURES: "spaces,sync_google",
} as unknown as Env;
/** Spaces on, sync frozen (Team after trial). */
const FROZEN = {
  ...base,
  ...MAIL,
  FEATURES: "spaces,sync_frozen",
} as unknown as Env;
/** Spaces on, no directory. */
const OFF = { ...base, ...MAIL, FEATURES: "spaces" } as unknown as Env;
/** Self-hosted default: no spaces. */
const NONE = { ...base, FEATURES: "" } as Env;

type Init = { method?: string; body?: unknown };
const call = (e: Env, path: string, cookie: string | null, init: Init = {}) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-oa-request": "1",
        ...(cookie ? { cookie } : {}),
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    e,
  );
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const code = async (r: Response) => (await errOf(r)).code;

const one = <T>(sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .first<T>();
const run = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run();

type AuditRow = {
  action: string;
  actor_id: string | null;
  target_type: string;
  target_id: string;
  space_id: string | null;
  detail: string;
};
const audits = async (action: string, targetId: string) =>
  (
    await env.DB.prepare(
      "select * from audit_events where action = ? and target_id = ? order by at, id",
    )
      .bind(action, targetId)
      .all<AuditRow>()
  ).results;

const presence = (userId: string) => {
  const ns = env.USER_PRESENCE;
  if (!ns) throw new Error("USER_PRESENCE unbound");
  return ns.get(
    ns.idFromName(userId),
  ) as unknown as DurableObjectStub<UserPresence>;
};
/** When the user's live access was last revoked (null = never). */
const revokedAt = (userId: string) =>
  runInDurableObject(presence(userId), (p) => p.revokedAt());

type U = { cookie: string; userId: string };
const mk = (
  p: string,
  role: "member" | "admin" | "guest" | "owner" = "member",
) => login(`${p}-${newId().slice(0, 4).toLowerCase()}-${tag}@x.com`, role);

const level = async (
  e: Env,
  userId: string,
  artifactId: string,
): Promise<AccessLevel | null> => {
  const u = await getUser(e, userId);
  if (!u) return null;
  return (await accessLevel(e, callerOf(u), artifactId))?.level ?? null;
};
const insertArtifact = async (
  owner: string,
  spaceId: string,
  visibility = "private",
  deletedAt: number | null = null,
) => {
  const id = newId();
  await run(
    "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at, deleted_at) values (?, ?, ?, 't', 'html', ?, 1, 1, ?)",
    id,
    owner,
    spaceId,
    visibility,
    deletedAt,
  );
  return id;
};
/** A directory group (as sync would write it) with these members. */
const group = async (members: string[]) => {
  const id = `g${newId().slice(0, 10)}`;
  await run(
    "insert into directory_groups (group_id, email) values (?, ?)",
    id,
    `${id.toLowerCase()}@x.com`,
  );
  for (const m of members)
    await run(
      "insert into directory_members (group_id, user_id) values (?, ?)",
      id,
      m,
    );
  return id;
};

let owner: U;
let admin: U;

const createSpace = async (
  body: Record<string, unknown> = {},
  e: Env = GOOGLE,
): Promise<Space> => {
  const r = await call(e, R.spaces, admin.cookie, {
    method: "POST",
    body: { name: `S ${newId().slice(0, 6)}`, ...body },
  });
  expect(r.status).toBe(201);
  return json<Space>(r);
};
const putMember = (e: Env, who: U, sid: string, userId: string, role: string) =>
  call(e, R.spaceMember(sid, userId), who.cookie, {
    method: "PUT",
    body: { role },
  });
/** A space with a manager, an editor and a viewer (manual rows). */
const staffed = async (body: Record<string, unknown> = {}) => {
  const s = await createSpace(body);
  const mgr = await mk("mgr");
  const ed = await mk("ed");
  const vw = await mk("vw");
  for (const [u, role] of [
    [mgr, "manager"],
    [ed, "editor"],
    [vw, "viewer"],
  ] as const)
    expect((await putMember(GOOGLE, admin, s.id, u.userId, role)).status).toBe(
      200,
    );
  return { s, mgr, ed, vw };
};

beforeAll(async () => {
  owner = await mk("own", "owner");
  admin = await mk("adm", "admin");
});

describe("the spaces flag", () => {
  it("spaces flag off → POST /spaces 404, authz unchanged", async () => {
    const r = await call(NONE, R.spaces, admin.cookie, {
      method: "POST",
      body: { name: "Nope" },
    });
    expect(r.status).toBe(404);
    expect((await call(NONE, R.spaces, admin.cookie)).status).toBe(404);
    // Authz is the same either way: a member of a space still has its role.
    const { s, ed } = await staffed();
    const art = await insertArtifact(ed.userId, s.id);
    expect(await level(NONE, ed.userId, art)).toBe("editor");
    expect((await call(NONE, R.spaceMembers(s.id), admin.cookie)).status).toBe(
      404,
    );
  });
});

describe("spaces", () => {
  it("POST /spaces: org admin 201, audited space.create; a member 404", async () => {
    const s = await createSpace({ allMembersRole: "viewer" });
    expect(s).toMatchObject({
      kind: "shared",
      allMembersRole: "viewer",
      publicLinks: true,
      myRole: "viewer",
      memberCount: 0,
      artifactCount: 0,
      owner: null,
      can: { manageMappings: true },
    });
    expect(await audits("space.create", s.id)).toHaveLength(1);
    const m = await mk("cr");
    const r = await call(GOOGLE, R.spaces, m.cookie, {
      method: "POST",
      body: { name: "x" },
    });
    expect(r.status).toBe(404);
  });

  it("GET /spaces pages with nextCursor; personal first; org admins see every shared space", async () => {
    const m = await mk("pg");
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await createSpace();
      expect(
        (await putMember(GOOGLE, admin, s.id, m.userId, "viewer")).status,
      ).toBe(200);
      made.push(s.id);
    }
    const seen: Space[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const r = await call(GOOGLE, `${R.spaces}?limit=2${q}`, m.cookie);
      expect(r.status).toBe(200);
      const p = await json<Page<Space>>(r);
      expect(p.items.length).toBeLessThanOrEqual(2);
      if (pages === 0) {
        expect(p.items).toHaveLength(2);
        expect(p.nextCursor).not.toBeNull();
      }
      seen.push(...p.items);
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen[0]).toMatchObject({
      id: m.userId,
      kind: "personal",
      myRole: "manager",
    });
    const ids = seen.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([m.userId, ...made]));
    // Every id once, and only the caller's own personal space.
    expect(new Set(ids).size).toBe(ids.length);
    expect(seen.filter((s) => s.kind === "personal")).toHaveLength(1);
    // kind filter
    const shared = await json<Page<Space>>(
      await call(GOOGLE, `${R.spaces}?kind=shared&limit=200`, m.cookie),
    );
    expect(shared.items.every((s) => s.kind === "shared")).toBe(true);
    // An org admin sees a space they hold no role in, myRole null.
    const other = await createSpace();
    await run("delete from space_members where space_id = ?", other.id);
    const all: Space[] = [];
    let c2: string | null = null;
    do {
      const q: string = c2 ? `&cursor=${encodeURIComponent(c2)}` : "";
      const p = await json<Page<Space>>(
        await call(
          GOOGLE,
          `${R.spaces}?kind=shared&limit=200${q}`,
          admin.cookie,
        ),
      );
      all.push(...p.items);
      c2 = p.nextCursor;
    } while (c2);
    expect(all.find((s) => s.id === other.id)).toMatchObject({ myRole: null });
    expect(
      (await call(GOOGLE, `${R.spaces}?cursor=garbage`, m.cookie)).status,
    ).toBe(400);
  });

  it("GET /spaces/:id: member 200; non-member, another user's personal space and unknown ids 404", async () => {
    const { s, vw } = await staffed();
    const r = await call(GOOGLE, R.space(s.id), vw.cookie);
    expect(r.status).toBe(200);
    expect(await json<Space>(r)).toMatchObject({
      id: s.id,
      myRole: "viewer",
      memberCount: 3,
      can: { manageMappings: false },
    });
    const stranger = await mk("str");
    expect((await call(GOOGLE, R.space(s.id), stranger.cookie)).status).toBe(
      404,
    );
    expect(
      (await call(GOOGLE, R.space(vw.userId), stranger.cookie)).status,
    ).toBe(404);
    expect((await call(GOOGLE, R.space(newId()), stranger.cookie)).status).toBe(
      404,
    );
    const own = await call(GOOGLE, R.space(stranger.userId), stranger.cookie);
    expect(await json<Space>(own)).toMatchObject({
      kind: "personal",
      myRole: "manager",
      owner: { id: stranger.userId },
    });
  });

  it("PATCH: a manager renames (audited space.update); allMembersRole is org admin only; editors 404", async () => {
    const { s, mgr, ed } = await staffed();
    const r = await call(GOOGLE, R.space(s.id), mgr.cookie, {
      method: "PATCH",
      body: { name: "Renamed" },
    });
    expect(r.status).toBe(200);
    expect((await json<Space>(r)).name).toBe("Renamed");
    expect(await audits("space.update", s.id)).toHaveLength(1);
    // A no-op writes no audit row.
    await call(GOOGLE, R.space(s.id), mgr.cookie, {
      method: "PATCH",
      body: { name: "Renamed" },
    });
    expect(await audits("space.update", s.id)).toHaveLength(1);
    expect(
      (
        await call(GOOGLE, R.space(s.id), mgr.cookie, {
          method: "PATCH",
          body: { allMembersRole: "editor" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(GOOGLE, R.space(s.id), ed.cookie, {
          method: "PATCH",
          body: { name: "x" },
        })
      ).status,
    ).toBe(404);
    // Personal spaces are never patched here.
    expect(
      await code(
        await call(GOOGLE, R.space(ed.userId), ed.cookie, {
          method: "PATCH",
          body: { name: "x" },
        }),
      ),
    ).toBe("space_personal");
  });

  it("space manager may turn public links off; audited space.public_links", async () => {
    const { s, mgr } = await staffed();
    const r = await call(GOOGLE, R.space(s.id), mgr.cookie, {
      method: "PATCH",
      body: { publicLinks: false },
    });
    expect(r.status).toBe(200);
    expect((await json<Space>(r)).publicLinks).toBe(false);
    const rows = await audits("space.public_links", s.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({ publicLinks: false });
    // No change, no row.
    await call(GOOGLE, R.space(s.id), mgr.cookie, {
      method: "PATCH",
      body: { publicLinks: false },
    });
    expect(await audits("space.public_links", s.id)).toHaveLength(1);
  });

  it("public links off leaves existing public artifacts and /p/ links working (no rewrite, no revocation)", async () => {
    const { s, mgr, vw } = await staffed();
    const pub = await insertArtifact(mgr.userId, s.id, "public");
    const before = await revokedAt(vw.userId);
    await call(GOOGLE, R.space(s.id), mgr.cookie, {
      method: "PATCH",
      body: { publicLinks: false },
    });
    expect(
      (
        await one<{ visibility: string }>(
          "select visibility from artifacts where id = ?",
          pub,
        )
      )?.visibility,
    ).toBe("public");
    expect(await level(GOOGLE, vw.userId, pub)).toBe("viewer");
    expect(await revokedAt(vw.userId)).toBe(before);
  });

  it("PATCH visibility=public on a no-public-links space → 403 public_links_off", async () => {
    const { s, mgr } = await staffed({ publicLinks: false });
    const art = await insertArtifact(mgr.userId, s.id, "team");
    const r = await call(GOOGLE, R.artifact(art), mgr.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("public_links_off");
  });

  it("lowering allMembersRole revokes the members it reached, in the same request", async () => {
    const s = await createSpace({ allMembersRole: "editor" });
    const m = await mk("am");
    const art = await insertArtifact(admin.userId, s.id);
    expect(await level(GOOGLE, m.userId, art)).toBe("editor");
    const r = await call(GOOGLE, R.space(s.id), admin.cookie, {
      method: "PATCH",
      body: { allMembersRole: null },
    });
    expect(r.status).toBe(200);
    expect(await level(GOOGLE, m.userId, art)).toBeNull();
    expect(await revokedAt(m.userId)).not.toBeNull();
    const rows = await audits("space.update", s.id);
    expect(JSON.parse(rows.at(-1)?.detail ?? "{}")).toMatchObject({
      fields: ["allMembersRole"],
    });
  });

  it("DELETE: trash counts (409 space_not_empty); empty 204 audited; personal 400; managers 404", async () => {
    const { s, mgr } = await staffed();
    const art = await insertArtifact(mgr.userId, s.id, "private", Date.now());
    let r = await call(GOOGLE, R.space(s.id), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("space_not_empty");
    expect(await audits("space.delete", s.id)).toHaveLength(0);
    expect(
      (await call(GOOGLE, R.space(s.id), mgr.cookie, { method: "DELETE" }))
        .status,
    ).toBe(404);
    await run("delete from artifacts where id = ?", art);
    r = await call(GOOGLE, R.space(s.id), admin.cookie, { method: "DELETE" });
    expect(r.status).toBe(204);
    expect(await audits("space.delete", s.id)).toHaveLength(1);
    expect((await call(GOOGLE, R.space(s.id), admin.cookie)).status).toBe(404);
    expect(
      await code(
        await call(GOOGLE, R.space(mgr.userId), mgr.cookie, {
          method: "DELETE",
        }),
      ),
    ).toBe("space_personal");
  });
});

describe("space members", () => {
  it("PUT: add and role change audited (no row on a no-op); no email in detail", async () => {
    const { s, mgr } = await staffed();
    const m = await mk("mem");
    expect(
      (await putMember(GOOGLE, mgr, s.id, m.userId, "viewer")).status,
    ).toBe(200);
    const add = await audits("space.member.add", m.userId);
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({
      space_id: s.id,
      actor_id: mgr.userId,
      target_type: "user",
    });
    const r = await putMember(GOOGLE, mgr, s.id, m.userId, "editor");
    expect(await json<SpaceMember>(r)).toMatchObject({
      userId: m.userId,
      role: "editor",
      manualRole: "editor",
      source: "manual",
    });
    await putMember(GOOGLE, mgr, s.id, m.userId, "editor");
    expect(await audits("space.member.role", m.userId)).toHaveLength(1);
    for (const row of [
      ...add,
      ...(await audits("space.member.role", m.userId)),
    ])
      expect(row.detail).not.toContain("@");
    // Unknown user: 404.
    expect((await putMember(GOOGLE, mgr, s.id, newId(), "viewer")).status).toBe(
      404,
    );
  });

  it("a space manager can't grant manager or change a manager (403 space_forbidden, target member)", async () => {
    const { s, mgr, ed } = await staffed();
    let r = await putMember(GOOGLE, mgr, s.id, ed.userId, "manager");
    expect(r.status).toBe(403);
    expect(await errOf(r)).toMatchObject({
      code: "space_forbidden",
      details: { target: "member" },
    });
    const mgr2 = await mk("mgr2");
    await putMember(GOOGLE, admin, s.id, mgr2.userId, "manager");
    r = await putMember(GOOGLE, mgr, s.id, mgr2.userId, "viewer");
    expect(r.status).toBe(403);
    // Org admins may.
    expect(
      (await putMember(GOOGLE, admin, s.id, ed.userId, "manager")).status,
    ).toBe(200);
  });

  it("a demotion revokes the member's live access", async () => {
    const { s, mgr, ed } = await staffed();
    const before = await revokedAt(ed.userId);
    await putMember(GOOGLE, mgr, s.id, ed.userId, "viewer");
    expect(await revokedAt(ed.userId)).not.toBe(before);
    expect(await revokedAt(ed.userId)).not.toBeNull();
  });

  it("DELETE: removes the manual row, audited, revoked; 404 when absent", async () => {
    const { s, mgr, vw } = await staffed();
    const art = await insertArtifact(mgr.userId, s.id);
    expect(await level(GOOGLE, vw.userId, art)).toBe("viewer");
    const r = await call(GOOGLE, R.spaceMember(s.id, vw.userId), mgr.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);
    expect(await level(GOOGLE, vw.userId, art)).toBeNull();
    expect(await audits("space.member.remove", vw.userId)).toHaveLength(1);
    expect(await revokedAt(vw.userId)).not.toBeNull();
    expect(
      (
        await call(GOOGLE, R.spaceMember(s.id, vw.userId), mgr.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
  });

  it("a synced-only row: 409 member_synced while sync is live; frozen removes it", async () => {
    const s = await createSpace();
    const m = await mk("syn");
    await run(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'sync', 1)",
      s.id,
      m.userId,
    );
    let r = await call(GOOGLE, R.spaceMember(s.id, m.userId), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("member_synced");
    r = await call(FROZEN, R.spaceMember(s.id, m.userId), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);
    const rows = await audits("space.member.remove", m.userId);
    expect(JSON.parse(rows.at(-1)?.detail ?? "{}")).toEqual({
      syncFrozen: true,
    });
    expect(
      await one(
        "select 1 from space_members where space_id = ? and user_id = ?",
        s.id,
        m.userId,
      ),
    ).toBeNull();
  });

  it("frozen: PUT on a synced row becomes a manual override (syncRole null), audited", async () => {
    const s = await createSpace();
    const m = await mk("ovr");
    await run(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'sync', 1)",
      s.id,
      m.userId,
    );
    const r = await putMember(FROZEN, admin, s.id, m.userId, "viewer");
    expect(await json<SpaceMember>(r)).toMatchObject({
      role: "viewer",
      manualRole: "viewer",
      syncRole: null,
      source: "manual",
      groups: [],
    });
    const rows = await audits("space.member.role", m.userId);
    expect(JSON.parse(rows.at(-1)?.detail ?? "{}")).toEqual({
      syncFrozen: true,
      role: "viewer",
    });
    // A lowered effective role revokes.
    expect(await revokedAt(m.userId)).not.toBeNull();
  });

  it("GET members: Page plus total; q and group filters; groups via space and every", async () => {
    const { s, mgr, ed, vw } = await staffed();
    const g = await group([ed.userId]);
    const every = await group([vw.userId]);
    await run(
      "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'editor')",
      s.id,
      g,
      `${g.toLowerCase()}@x.com`,
    );
    await run(
      "insert into org_group_mappings (group_id, group_email, role) values (?, ?, 'editor')",
      every,
      `${every.toLowerCase()}@x.com`,
    );
    try {
      const r = await call(
        GOOGLE,
        `${R.spaceMembers(s.id)}?limit=2`,
        vw.cookie,
      );
      expect(r.status).toBe(200);
      const p = await json<SpaceMembersPage>(r);
      expect(p.items).toHaveLength(2);
      expect(p.nextCursor).not.toBeNull();
      expect(p.total).toBeGreaterThanOrEqual(3);
      const byQ = await json<SpaceMembersPage>(
        await call(GOOGLE, `${R.spaceMembers(s.id)}?q=mgr-`, vw.cookie),
      );
      expect(byQ.items.map((m) => m.userId)).toEqual([mgr.userId]);
      expect(byQ.total).toBe(1);
      const byG = await json<SpaceMembersPage>(
        await call(GOOGLE, `${R.spaceMembers(s.id)}?group=${g}`, vw.cookie),
      );
      expect(byG.items.map((m) => m.userId)).toEqual([ed.userId]);
      expect(byG.items[0]?.groups).toEqual([
        {
          groupId: g,
          email: `${g.toLowerCase()}@x.com`,
          name: null,
          role: "editor",
          via: "space",
        },
      ]);
      const vwRow = (
        await json<SpaceMembersPage>(
          await call(
            GOOGLE,
            `${R.spaceMembers(s.id)}?group=${every}`,
            vw.cookie,
          ),
        )
      ).items[0];
      expect(vwRow).toMatchObject({
        userId: vw.userId,
        manualRole: "viewer",
        syncRole: "editor",
        role: "editor",
        source: "sync",
        cap: null,
        allMembers: null,
      });
      expect(vwRow?.groups[0]).toMatchObject({ via: "every", role: "editor" });
      const stranger = await mk("str");
      expect(
        (await call(GOOGLE, R.spaceMembers(s.id), stranger.cookie)).status,
      ).toBe(404);
    } finally {
      await run("delete from org_group_mappings where group_id = ?", every);
    }
  });

  it("admin self-add: 201, audited space.admin_self_add, managers emailed; personal 400; members 404", async () => {
    const { s, mgr, ed } = await staffed();
    sent.length = 0;
    const r = await call(GOOGLE, R.spaceMemberSelf(s.id), owner.cookie, {
      method: "POST",
      body: { role: "manager" },
    });
    expect(r.status).toBe(201);
    expect(await json<SpaceMember>(r)).toMatchObject({
      userId: owner.userId,
      role: "manager",
    });
    const rows = await audits("space.admin_self_add", owner.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ space_id: s.id });
    const mgrEmail = (
      await one<{ email: string }>(
        "select email from users where id = ?",
        mgr.userId,
      )
    )?.email;
    expect(sent.map((m) => m.to)).toEqual([mgrEmail]);
    for (const m of sent) expect(m.subject).not.toContain("—");
    expect(
      await code(
        await call(GOOGLE, R.spaceMemberSelf(ed.userId), owner.cookie, {
          method: "POST",
          body: { role: "viewer" },
        }),
      ),
    ).toBe("space_personal");
    expect(
      (
        await call(GOOGLE, R.spaceMemberSelf(s.id), ed.cookie, {
          method: "POST",
          body: { role: "manager" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("space mappings", () => {
  const putMap = (e: Env, who: U, sid: string, gid: string, role: string) =>
    call(e, R.spaceMapping(sid, gid), who.cookie, {
      method: "PUT",
      body: { role },
    });
  const delMap = (e: Env, who: U, sid: string, gid: string) =>
    call(e, R.spaceMapping(sid, gid), who.cookie, { method: "DELETE" });
  const setSmm = (on: boolean) =>
    call(GOOGLE, R.settings, owner.cookie, {
      method: "PATCH",
      body: { spaceManagerMappings: on },
    });

  it("mapping PUT while sync is off or frozen → 409 directory_sync_off", async () => {
    const s = await createSpace({}, OFF);
    const g = await group([]);
    for (const e of [OFF, FROZEN]) {
      const r = await putMap(e, admin, s.id, g, "viewer");
      expect(r.status).toBe(409);
      expect(await code(r)).toBe("directory_sync_off");
    }
  });

  it("space manager maps a group as viewer → 200, audited mapping.set; its members get the role", async () => {
    const { s, mgr } = await staffed();
    const m = await mk("gm");
    const g = await group([m.userId]);
    const art = await insertArtifact(mgr.userId, s.id);
    const r = await putMap(GOOGLE, mgr, s.id, g, "viewer");
    expect(r.status).toBe(200);
    expect(await json<GroupMapping>(r)).toMatchObject({
      groupId: g,
      role: "viewer",
      memberCount: 1,
    });
    const rows = await audits("mapping.set", g);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ space_id: s.id, target_type: "mapping" });
    expect(await level(GOOGLE, m.userId, art)).toBe("viewer");
    const list = await json<GroupMapping[]>(
      await call(GOOGLE, R.spaceMappings(s.id), mgr.cookie),
    );
    expect(list.map((x) => x.groupId)).toEqual([g]);
    // Unknown group: 404.
    expect((await putMap(GOOGLE, mgr, s.id, "gNOPE", "viewer")).status).toBe(
      404,
    );
  });

  it("space manager maps a group as manager → 403 space_forbidden (target mapping)", async () => {
    const { s, mgr } = await staffed();
    const g = await group([]);
    const r = await putMap(GOOGLE, mgr, s.id, g, "manager");
    expect(r.status).toBe(403);
    expect(await errOf(r)).toMatchObject({
      code: "space_forbidden",
      details: { target: "mapping" },
    });
  });

  it("space manager PUT or DELETE over an existing manager-role row → 403 space_forbidden", async () => {
    const { s, mgr } = await staffed();
    const g = await group([]);
    expect((await putMap(GOOGLE, admin, s.id, g, "manager")).status).toBe(200);
    expect(await code(await putMap(GOOGLE, mgr, s.id, g, "viewer"))).toBe(
      "space_forbidden",
    );
    expect(await code(await delMap(GOOGLE, mgr, s.id, g))).toBe(
      "space_forbidden",
    );
  });

  it("spaceManagerMappings off: manager PUT → 403 directory_mapping_off; GET and DELETE of a viewer row still work", async () => {
    const { s, mgr } = await staffed();
    const g = await group([]);
    const g2 = await group([]);
    expect((await putMap(GOOGLE, mgr, s.id, g, "viewer")).status).toBe(200);
    expect((await setSmm(false)).status).toBe(200);
    try {
      const r = await putMap(GOOGLE, mgr, s.id, g2, "viewer");
      expect(r.status).toBe(403);
      expect(await code(r)).toBe("directory_mapping_off");
      const space = await json<Space>(
        await call(GOOGLE, R.space(s.id), mgr.cookie),
      );
      expect(space.can).toEqual({ manageMappings: false });
      expect(
        (await call(GOOGLE, R.spaceMappings(s.id), mgr.cookie)).status,
      ).toBe(200);
      expect((await delMap(GOOGLE, mgr, s.id, g)).status).toBe(204);
      // Org admins may still map any role.
      expect((await putMap(GOOGLE, admin, s.id, g2, "manager")).status).toBe(
        200,
      );
    } finally {
      await setSmm(true);
    }
    const rows = (
      await env.DB.prepare(
        "select detail from audit_events where action = 'settings.space_manager_mappings' order by at desc, id desc limit 2",
      ).all<{ detail: string }>()
    ).results;
    expect(rows.map((x) => JSON.parse(x.detail))).toEqual([
      { spaceManagerMappings: true },
      { spaceManagerMappings: false },
    ]);
  });

  it("org admin may still map any role, setting on or off", async () => {
    const s = await createSpace();
    const g = await group([]);
    expect((await putMap(GOOGLE, admin, s.id, g, "manager")).status).toBe(200);
  });

  it("mapping GET on a personal space → 400 space_personal", async () => {
    const m = await mk("pers");
    const r = await call(GOOGLE, R.spaceMappings(m.userId), m.cookie);
    expect(r.status).toBe(400);
    expect(await code(r)).toBe("space_personal");
    expect(await code(await putMap(GOOGLE, m, m.userId, "gx", "viewer"))).toBe(
      "space_personal",
    );
  });

  it("removing or lowering a mapping cuts and revokes the group's members", async () => {
    const { s, mgr } = await staffed();
    const a = await mk("ga");
    const b = await mk("gb");
    const g = await group([a.userId, b.userId]);
    const art = await insertArtifact(mgr.userId, s.id);
    await putMap(GOOGLE, mgr, s.id, g, "editor");
    expect(await level(GOOGLE, a.userId, art)).toBe("editor");
    await putMap(GOOGLE, mgr, s.id, g, "viewer");
    expect(await level(GOOGLE, a.userId, art)).toBe("viewer");
    const first = await revokedAt(a.userId);
    expect(first).not.toBeNull();
    expect((await delMap(GOOGLE, mgr, s.id, g)).status).toBe(204);
    expect(await level(GOOGLE, a.userId, art)).toBeNull();
    expect(await level(GOOGLE, b.userId, art)).toBeNull();
    expect(await revokedAt(b.userId)).not.toBeNull();
    expect(await audits("mapping.remove", g)).toHaveLength(1);
    expect((await delMap(GOOGLE, mgr, s.id, g)).status).toBe(404);
  });
});

describe("Every-space mappings", () => {
  const put = (e: Env, who: U, gid: string, role: string) =>
    call(e, R.orgMapping(gid), who.cookie, { method: "PUT", body: { role } });

  it("PUT R.orgMapping writes one org row and no space_members rows; a space created later grants the role; personal spaces never do", async () => {
    const m = await mk("ev");
    const g = await group([m.userId]);
    const r = await put(GOOGLE, admin, g, "editor");
    try {
      expect(r.status).toBe(200);
      expect(await json<GroupMapping>(r)).toMatchObject({
        groupId: g,
        role: "editor",
      });
      expect(
        (
          await one<{ n: number }>(
            "select count(*) n from org_group_mappings where group_id = ?",
            g,
          )
        )?.n,
      ).toBe(1);
      expect(
        (
          await one<{ n: number }>(
            "select count(*) n from space_members where user_id = ?",
            m.userId,
          )
        )?.n,
      ).toBe(0);
      const later = await createSpace();
      const art = await insertArtifact(admin.userId, later.id);
      expect(await level(GOOGLE, m.userId, art)).toBe("editor");
      const personal = await insertArtifact(admin.userId, admin.userId);
      expect(await level(GOOGLE, m.userId, personal)).toBeNull();
      const rows = await audits("mapping.set", g);
      expect(rows[0]).toMatchObject({ space_id: null });
      expect(JSON.parse(rows[0]?.detail ?? "{}")).toMatchObject({
        scope: "org",
        role: "editor",
      });
    } finally {
      await run("delete from org_group_mappings where group_id = ?", g);
    }
  });

  it("GET /api/v1/directory/org-mappings returns Page<GroupMapping>", async () => {
    const g = await group([]);
    await put(GOOGLE, admin, g, "viewer");
    try {
      const r = await call(GOOGLE, `${R.orgMappings}?limit=200`, admin.cookie);
      expect(r.status).toBe(200);
      const p = await json<Page<GroupMapping>>(r);
      expect(p.items.some((x) => x.groupId === g)).toBe(true);
      expect(p).toHaveProperty("nextCursor");
      const m = await mk("evm");
      expect((await call(GOOGLE, R.orgMappings, m.cookie)).status).toBe(404);
    } finally {
      await run("delete from org_group_mappings where group_id = ?", g);
    }
  });

  it("DELETE R.orgMapping revokes the group's members' live access", async () => {
    const m = await mk("evd");
    const g = await group([m.userId]);
    await put(GOOGLE, admin, g, "viewer");
    const s = await createSpace();
    const art = await insertArtifact(admin.userId, s.id);
    expect(await level(GOOGLE, m.userId, art)).toBe("viewer");
    const r = await call(GOOGLE, R.orgMapping(g), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);
    expect(await level(GOOGLE, m.userId, art)).toBeNull();
    expect(await revokedAt(m.userId)).not.toBeNull();
    const rows = await audits("mapping.remove", g);
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({ scope: "org" });
  });

  it("sync off → 409; a space manager → 404", async () => {
    const g = await group([]);
    expect(await code(await put(OFF, admin, g, "viewer"))).toBe(
      "directory_sync_off",
    );
    const { mgr } = await staffed();
    expect((await put(GOOGLE, mgr, g, "viewer")).status).toBe(404);
  });
});

describe("restrictions", () => {
  it("per-user restricted flag caps a member and audits restricted.set; revoked", async () => {
    const { s, ed } = await staffed();
    const art = await insertArtifact(admin.userId, s.id);
    const r = await call(GOOGLE, R.memberRestricted(ed.userId), admin.cookie, {
      method: "PUT",
    });
    expect(r.status).toBe(200);
    expect(await json<{ restriction: unknown }>(r)).toMatchObject({
      id: ed.userId,
      restriction: { manual: true, groups: [] },
    });
    expect(await level(GOOGLE, ed.userId, art)).toBe("viewer");
    expect(await audits("restricted.set", ed.userId)).toHaveLength(1);
    expect(await revokedAt(ed.userId)).not.toBeNull();
    const d = await call(GOOGLE, R.memberRestricted(ed.userId), admin.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(200);
    expect(await level(GOOGLE, ed.userId, art)).toBe("editor");
    expect(await audits("restricted.remove", ed.userId)).toHaveLength(1);
  });

  it("restricting an owner or admin → 400 restrict_admin", async () => {
    for (const t of [owner, admin]) {
      const r = await call(GOOGLE, R.memberRestricted(t.userId), owner.cookie, {
        method: "PUT",
      });
      expect(r.status).toBe(400);
      expect(await code(r)).toBe("restrict_admin");
    }
  });

  it("restricted group PUT while sync is frozen → 409 directory_sync_off; existing frozen restrictions still cap", async () => {
    const { s, ed } = await staffed();
    const g = await group([ed.userId]);
    const art = await insertArtifact(admin.userId, s.id);
    expect(
      (
        await call(GOOGLE, R.restrictedGroup(g), admin.cookie, {
          method: "PUT",
        })
      ).status,
    ).toBe(200);
    expect(await level(FROZEN, ed.userId, art)).toBe("viewer");
    expect(await audits("restricted.set", g)).toHaveLength(1);
    expect(await revokedAt(ed.userId)).not.toBeNull();
    const g2 = await group([]);
    const r = await call(FROZEN, R.restrictedGroup(g2), admin.cookie, {
      method: "PUT",
    });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("directory_sync_off");
    expect(await level(FROZEN, ed.userId, art)).toBe("viewer");
    const list = await json<{ groupId: string }[]>(
      await call(FROZEN, R.restrictedGroups, admin.cookie),
    );
    expect(list.some((x) => x.groupId === g)).toBe(true);
  });

  it("restricted group DELETE while frozen lifts the restriction", async () => {
    const { s, ed } = await staffed();
    const g = await group([ed.userId]);
    const art = await insertArtifact(admin.userId, s.id);
    await call(GOOGLE, R.restrictedGroup(g), admin.cookie, { method: "PUT" });
    expect(await level(FROZEN, ed.userId, art)).toBe("viewer");
    const r = await call(FROZEN, R.restrictedGroup(g), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);
    expect(await level(FROZEN, ed.userId, art)).toBe("editor");
    expect(await audits("restricted.remove", g)).toHaveLength(1);
  });

  it("manual restricted DELETE never lifts a group restriction", async () => {
    const { s, ed } = await staffed();
    const g = await group([ed.userId]);
    const art = await insertArtifact(admin.userId, s.id);
    await call(GOOGLE, R.restrictedGroup(g), admin.cookie, { method: "PUT" });
    await call(GOOGLE, R.memberRestricted(ed.userId), admin.cookie, {
      method: "PUT",
    });
    const r = await call(GOOGLE, R.memberRestricted(ed.userId), admin.cookie, {
      method: "DELETE",
    });
    expect(
      await json<{
        restriction: { manual: boolean; groups: { groupId: string }[] };
      }>(r),
    ).toMatchObject({
      restriction: { manual: false, groups: [{ groupId: g }] },
    });
    expect(await level(GOOGLE, ed.userId, art)).toBe("viewer");
    await call(GOOGLE, R.restrictedGroup(g), admin.cookie, {
      method: "DELETE",
    });
  });

  it("a restricted group never restricts an owner or admin", async () => {
    const a2 = await mk("a2", "admin");
    const g = await group([a2.userId]);
    await call(GOOGLE, R.restrictedGroup(g), admin.cookie, { method: "PUT" });
    expect(
      (
        await one<{ r: number }>(
          "select restricted_sync r from users where id = ?",
          a2.userId,
        )
      )?.r,
    ).toBe(0);
    await call(GOOGLE, R.restrictedGroup(g), admin.cookie, {
      method: "DELETE",
    });
  });
});

describe("settings", () => {
  it("spaceManagerMappings: reported with spaces on (default true), absent without; no-op PATCH writes no audit", async () => {
    const on = await json<{ spaceManagerMappings?: boolean }>(
      await call(GOOGLE, R.settings, owner.cookie),
    );
    expect(on.spaceManagerMappings).toBe(true);
    const off = await json<{ spaceManagerMappings?: boolean }>(
      await call(NONE, R.settings, owner.cookie),
    );
    expect(off).not.toHaveProperty("spaceManagerMappings");
    const n = async () =>
      (
        await one<{ n: number }>(
          "select count(*) n from audit_events where action = 'settings.space_manager_mappings'",
        )
      )?.n;
    const before = await n();
    await call(GOOGLE, R.settings, owner.cookie, {
      method: "PATCH",
      body: { spaceManagerMappings: true },
    });
    expect(await n()).toBe(before);
  });
});

describe("attacks", () => {
  it("a non-member probing space ids gets 404 everywhere, the same as an unknown id", async () => {
    const { s, vw } = await staffed();
    const g = await group([]);
    await run(
      "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, 'x@x.com', 'viewer')",
      s.id,
      g,
    );
    const stranger = await mk("probe");
    for (const id of [s.id, newId()]) {
      const reqs: [string, Init][] = [
        [R.space(id), {}],
        [R.space(id), { method: "PATCH", body: { name: "x" } }],
        [R.space(id), { method: "DELETE" }],
        [R.spaceMembers(id), {}],
        [
          R.spaceMember(id, vw.userId),
          { method: "PUT", body: { role: "viewer" } },
        ],
        [R.spaceMember(id, vw.userId), { method: "DELETE" }],
        [R.spaceMemberSelf(id), { method: "POST", body: { role: "manager" } }],
        [R.spaceMappings(id), {}],
        [R.spaceMapping(id, g), { method: "PUT", body: { role: "viewer" } }],
        [R.spaceMapping(id, g), { method: "DELETE" }],
      ];
      for (const [path, init] of reqs) {
        const r = await call(GOOGLE, path, stranger.cookie, init);
        expect([path, init.method ?? "GET", r.status]).toEqual([
          path,
          init.method ?? "GET",
          404,
        ]);
      }
    }
    // Viewers and editors are members, but not managers: 404 on writes.
    for (const [path, init] of [
      [R.spaceMember(s.id, vw.userId), { method: "DELETE" }],
      [R.spaceMappings(s.id), {}],
      [R.spaceMapping(s.id, g), { method: "DELETE" }],
    ] as [string, Init][])
      expect((await call(GOOGLE, path, vw.cookie, init)).status).toBe(404);
  });

  it("a manager can't escalate to manager through mappings, Every-space mappings, allMembersRole or self-add", async () => {
    const { s, mgr, ed } = await staffed();
    const g = await group([ed.userId]);
    expect(
      (
        await call(GOOGLE, R.spaceMapping(s.id, g), mgr.cookie, {
          method: "PUT",
          body: { role: "manager" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(GOOGLE, R.orgMapping(g), mgr.cookie, {
          method: "PUT",
          body: { role: "manager" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(GOOGLE, R.space(s.id), mgr.cookie, {
          method: "PATCH",
          body: { allMembersRole: "manager" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(GOOGLE, R.spaceMemberSelf(s.id), mgr.cookie, {
          method: "POST",
          body: { role: "manager" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(GOOGLE, R.restrictedGroup(g), mgr.cookie, { method: "PUT" }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(GOOGLE, R.memberRestricted(ed.userId), mgr.cookie, {
          method: "PUT",
        })
      ).status,
    ).toBe(404);
    expect(
      await one(
        "select 1 from group_mappings where space_id = ? and group_id = ?",
        s.id,
        g,
      ),
    ).toBeNull();
    const art = await insertArtifact(admin.userId, s.id);
    expect(await level(GOOGLE, ed.userId, art)).toBe("editor");
  });

  it("a capped (restricted) manager can't manage their space", async () => {
    const { s, mgr, vw } = await staffed();
    await call(GOOGLE, R.memberRestricted(mgr.userId), admin.cookie, {
      method: "PUT",
    });
    expect(
      (await putMember(GOOGLE, mgr, s.id, vw.userId, "editor")).status,
    ).toBe(404);
    expect(
      (
        await call(GOOGLE, R.space(s.id), mgr.cookie, {
          method: "PATCH",
          body: { name: "x" },
        })
      ).status,
    ).toBe(404);
    // Reads still work: they are a member.
    const r = await call(GOOGLE, R.space(s.id), mgr.cookie);
    expect(r.status).toBe(200);
    expect((await json<Space>(r)).can).toEqual({ manageMappings: false });
    const g = await group([]);
    expect((await call(GOOGLE, R.spaceMappings(s.id), mgr.cookie)).status).toBe(
      404,
    );
    expect(
      (
        await call(GOOGLE, R.spaceMapping(s.id, g), mgr.cookie, {
          method: "PUT",
          body: { role: "viewer" },
        })
      ).status,
    ).toBe(404);
  });

  it("cross-space id swaps: a manager of one space can't touch another's members or mappings", async () => {
    const a = await staffed();
    const b = await staffed();
    const g = await group([]);
    await call(GOOGLE, R.spaceMapping(b.s.id, g), admin.cookie, {
      method: "PUT",
      body: { role: "viewer" },
    });
    // b's member, through a's path: not a's member, so nothing to remove.
    expect(
      (
        await call(GOOGLE, R.spaceMember(a.s.id, b.vw.userId), a.mgr.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(GOOGLE, R.spaceMember(b.s.id, b.vw.userId), a.mgr.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (await putMember(GOOGLE, a.mgr, b.s.id, b.vw.userId, "editor")).status,
    ).toBe(404);
    // b's mapping, through a's path: a has none.
    expect(
      (
        await call(GOOGLE, R.spaceMapping(a.s.id, g), a.mgr.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      await one(
        "select 1 from group_mappings where space_id = ? and group_id = ?",
        b.s.id,
        g,
      ),
    ).not.toBeNull();
    expect(
      await one(
        "select 1 from space_members where space_id = ? and user_id = ?",
        b.s.id,
        b.vw.userId,
      ),
    ).not.toBeNull();
  });
});

describe("fan-out", () => {
  it("revokeUsersLive covers every user, in pages of 50", async () => {
    const ids = Array.from({ length: 120 }, () => newId());
    await revokeUsersLive(env, ids, "test");
    const at = await Promise.all(
      [ids[0], ids[60], ids[119]].map((id) => revokedAt(id as string)),
    );
    for (const t of at) expect(t).not.toBeNull();
  });
});
