import { env } from "cloudflare:workers";
import {
  type AccessLevel,
  type ArtifactSummary,
  type ListQueryInput,
  ListQuerySchema,
  type Member,
  newId,
  type Page,
  R,
  type Role,
  type SpaceRole,
  type Visibility,
} from "@oa/shared";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  authorize,
  type Caller,
  callerOf,
  capOfCaller,
  withCap,
} from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import { isTeamRole } from "../src/auth/policy.js";
import { publicPrefix } from "../src/content/signing.js";
import { getDb } from "../src/db/client.js";
import {
  artifacts,
  directoryGroups,
  directoryMembers,
  orgGroupMappings,
  shares,
  spaceMembers,
  spaces,
  users,
} from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import { ApiError } from "../src/http/errors.js";
import { getSummary, list, publish } from "../src/services/artifacts.js";
import { search } from "../src/services/search.js";
import { getUser } from "../src/services/users.js";
import { contentCall } from "./assets-stub.js";
import { api, errOf, fetchAndWait, login, runIndex } from "./helpers.js";
import { connect, tool } from "./mcp-helpers.js";

// P3 T4: list and search read the level from SQL (levelSql), and it must be
// decide()'s. The matrix seeds every input decide reads (space kind, per-space
// roles, allMembersRole, Every-space mappings, shares, visibility, publicLinks,
// deletion, the cap) and compares list(all), list(all, includeDeleted) and
// search with authorize() per artifact.

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

type Who =
  | "owner"
  | "admin"
  | "memberA"
  | "memberB"
  | "guest"
  | "restricted"
  | "everyEditor"
  | "everyViewerMgr"
  | "s1Viewer"
  | "guestCapped"
  | "guestEvery";
const ROLES: Record<Who, Role> = {
  owner: "owner",
  admin: "admin",
  memberA: "member",
  memberB: "member",
  guest: "guest",
  restricted: "member",
  everyEditor: "member",
  everyViewerMgr: "member",
  s1Viewer: "member",
  guestCapped: "guest",
  guestEvery: "guest",
};
const CALLERS = Object.keys(ROLES) as Who[];

type SpaceName = "pA" | "pOwner" | "s1" | "s2" | "s3" | "s4" | "s5";
/** The spaces the older explicit tests were written against (s5 is newer). */
const S1_S4 = (id: string) => arts[id]?.space !== "s5";
type Seed = {
  space: SpaceName;
  visibility: Visibility;
  deleted?: boolean;
};

const who = {} as Record<Who, { caller: Caller; cookie: string; id: string }>;
const spaceIds = {} as Record<SpaceName, string>;
const arts: Record<string, Seed & { id: string }> = {};
/** In every seeded artifact's search body. */
const word = `matrixword${tag}`.replace(/\d/g, "z");

const listAll = async (w: Who, q: ListQueryInput = {}) => {
  const out: Record<string, AccessLevel> = {};
  let cursor: string | undefined;
  do {
    const page = await list(
      env,
      who[w].caller,
      ListQuerySchema.parse({ limit: 100, ...q, cursor }),
    );
    for (const a of page.items) if (arts[a.id]) out[a.id] = a.access;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
};

const searchAll = async (w: Who) => {
  const out: Record<string, AccessLevel> = {};
  let cursor: string | undefined;
  do {
    const page = await search(env, who[w].caller, word, cursor, 100);
    for (const a of page.items) if (arts[a.id]) out[a.id] = a.access;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
};

const authorizeAll = async (w: Who, allowDeleted = false) => {
  const out: Record<string, AccessLevel | null> = {};
  for (const id of Object.keys(arts))
    out[id] = await authorize(env, who[w].caller, id, "view", {
      allowDeleted,
    }).then(
      (r) => r.level,
      (e) => {
        if (e instanceof ApiError && e.code === "not_found") return null;
        throw e;
      },
    );
  return out;
};

/** Uncapped owners, admins and members: the callers the team branch lists. */
const teamListed = (w: Who) => {
  const c = who[w].caller;
  return c.kind === "user" && isTeamRole(c.user.role) && !capOfCaller(c);
};

/**
 * Documented exception (as before spaces): a public artifact reachable only
 * by its link is not listed to guests or capped callers (they see what is
 * shared with them or in their spaces). Read from the rows: the caller's
 * share, or a role in the artifact's shared space (space_members or an
 * Every-space mapping).
 */
async function linkOnly(w: Who, id: string): Promise<boolean> {
  if (teamListed(w) || arts[id]?.visibility !== "public") return false;
  const r = await env.DB.prepare(
    `select exists (select 1 from shares where artifact_id = ?1 and email = ?2)
       or exists (select 1 from artifacts a join spaces s on s.id = a.space_id
         where a.id = ?1 and s.kind = 'shared' and (
           exists (select 1 from space_members sm
             where sm.space_id = a.space_id and sm.user_id = ?3)
           or exists (select 1 from org_group_mappings o
             join directory_members dm on dm.group_id = o.group_id
             where dm.user_id = ?3))) as path`,
  )
    .bind(id, `${w}-${tag}@x.com`, who[w].id)
    .first<{ path: number }>();
  return r?.path !== 1;
}

/** authorize()'s non-null levels, less the documented exceptions. */
async function expected(w: Who, allowDeleted = false) {
  const want: Record<string, AccessLevel> = {};
  for (const [id, level] of Object.entries(await authorizeAll(w, allowDeleted)))
    if (
      level &&
      !(await linkOnly(w, id)) &&
      // Follow-up: a shared space's trash waits for its own index.
      !(arts[id]?.deleted && level === "manager")
    )
      want[id] = level;
  return want;
}

beforeAll(async () => {
  const db = getDb(env);
  for (const w of CALLERS) {
    const { cookie, userId } = await login(`${w}-${tag}@x.com`, ROLES[w]);
    // A restricted group's member (sync keeps the flag; getUser reads it).
    if (w === "restricted")
      await db
        .update(users)
        .set({ restrictedSync: 1 })
        .where(eq(users.id, userId));
    const m = (await getUser(env, userId)) as Member;
    // A guest under P2's guestsReadOnly, whatever this env's authConfig.
    who[w] = {
      cookie,
      id: userId,
      caller: callerOf(w === "guestCapped" ? withCap(m, "guest") : m),
    };
  }
  spaceIds.pA = who.memberA.id;
  spaceIds.pOwner = who.owner.id;
  const now = Date.now();
  const shared = async (
    name: SpaceName,
    allMembersRole: SpaceRole | null,
    publicLinks: 0 | 1,
  ) => {
    spaceIds[name] = newId();
    await db.insert(spaces).values({
      id: spaceIds[name],
      kind: "shared",
      name: `${name}-${tag}`,
      allMembersRole,
      publicLinks,
      createdAt: now,
    });
  };
  await shared("s1", null, 1);
  await shared("s2", "editor", 0);
  await shared("s3", "viewer", 1);
  const role = async (
    space: SpaceName,
    w: Who,
    r: SpaceRole,
    source: "manual" | "sync" = "manual",
  ) => {
    await db.insert(spaceMembers).values({
      spaceId: spaceIds[space],
      userId: who[w].id,
      role: r,
      source,
      createdAt: now,
    });
  };
  await role("s1", "memberA", "editor");
  await role("s1", "memberB", "viewer", "sync");
  await role("s1", "memberB", "editor");
  await role("s1", "restricted", "editor");
  await role("s1", "guest", "viewer");
  await role("s1", "everyViewerMgr", "manager", "sync");
  await role("s2", "memberA", "manager");
  await role("s1", "s1Viewer", "viewer");
  // Every-space mappings: g1 editor (everyEditor, restricted), g2 viewer.
  const group = async (g: string, r: SpaceRole, members: Who[]) => {
    const groupId = `${g}-${tag}`;
    await db.insert(directoryGroups).values({ groupId, email: `${groupId}@x` });
    await db
      .insert(orgGroupMappings)
      .values({ groupId, groupEmail: `${groupId}@x`, role: r });
    for (const w of members)
      await db.insert(directoryMembers).values({ groupId, userId: who[w].id });
  };
  await group("g1", "editor", ["everyEditor", "restricted", "guestEvery"]);
  await group("g2", "viewer", ["everyViewerMgr"]);
  // A shared space created after the mappings: they apply at read time.
  await shared("s4", null, 0);
  // Every uncapped member manages s5.
  await shared("s5", "manager", 1);

  const mk = async (s: Seed) => {
    const id = newId();
    arts[id] = { ...s, id };
    await db.insert(artifacts).values({
      id,
      ownerId: s.space === "pOwner" ? who.owner.id : who.memberA.id,
      spaceId: spaceIds[s.space],
      title: `${s.space}-${s.visibility}`,
      format: "html",
      visibility: s.visibility,
      createdAt: now,
      updatedAt: now,
      deletedAt: s.deleted ? now : null,
    });
    await env.DB.prepare(
      "insert into artifact_search (rowid, artifact_id, title, description, body) select rowid, id, title, description, ? from artifacts where id = ?",
    )
      .bind(word, id)
      .run();
    return id;
  };
  const share = async (id: string, w: Who, r: "viewer" | "editor") => {
    await db.insert(shares).values({
      artifactId: id,
      email: `${w}-${tag}@x.com`,
      role: r,
      createdBy: who.memberA.id,
      createdAt: now,
    });
  };
  const byVis: Partial<Record<SpaceName, Record<Visibility, string>>> = {};
  for (const space of Object.keys(spaceIds) as SpaceName[]) {
    const row = {} as Record<Visibility, string>;
    for (const visibility of ["private", "team", "public"] as const)
      row[visibility] = await mk({ space, visibility });
    byVis[space] = row;
    for (const visibility of ["private", "team", "public"] as const)
      await mk({ space, visibility, deleted: true });
  }
  const at = (s: SpaceName, v: Visibility) => byVis[s]?.[v] as string;
  await share(at("pA", "private"), "memberB", "editor");
  await share(at("pA", "public"), "guest", "viewer");
  await share(at("pOwner", "private"), "admin", "viewer");
  await share(at("s2", "private"), "guest", "viewer");
  await share(at("s4", "private"), "restricted", "editor");
  await share(at("s1", "private"), "memberB", "viewer");
  await share(at("s3", "private"), "everyEditor", "viewer");
  // A space viewer whose editor share wins: max(spaceRole, shareRole).
  await share(at("s1", "private"), "s1Viewer", "editor");
  await share(at("s5", "private"), "guestCapped", "editor");
});

/** Read from the rows: does `w` have a role in shared space `sid`? */
async function hasRole(w: Who, sid: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `select exists (select 1 from space_members where space_id = ?1 and user_id = ?2)
       or exists (select 1 from org_group_mappings o
         join directory_members dm on dm.group_id = o.group_id where dm.user_id = ?2)
       or (?3 and exists (select 1 from spaces where id = ?1 and all_members_role is not null))
       as r`,
  )
    .bind(sid, who[w].id, teamListed(w) ? 1 : 0)
    .first<{ r: number }>();
  return r?.r === 1;
}

const errCode = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => (e instanceof ApiError ? e.code : String(e)),
  );

describe("list levels come from SQL and equal authorize()", () => {
  it("list(all) ids and levels equal authorize() for every seeded artifact", async () => {
    for (const w of CALLERS) {
      const want = await expected(w);
      expect({ w, listed: await listAll(w) }).toEqual({ w, listed: want });
      expect({ w, searched: await searchAll(w) }).toEqual({
        w,
        searched: want,
      });
    }
  });

  it("list(all, includeDeleted) equals authorize(allowDeleted)", async () => {
    for (const w of CALLERS)
      expect({
        w,
        listed: await listAll(w, { includeDeleted: true }),
      }).toEqual({ w, listed: await expected(w, true) });
  });

  it("a space viewer with an editor share is editor", async () => {
    const id = Object.values(arts).find(
      (a) => a.space === "s1" && a.visibility === "private",
    )?.id as string;
    expect((await authorize(env, who.s1Viewer.caller, id, "view")).level).toBe(
      "editor",
    );
    expect((await listAll("s1Viewer"))[id]).toBe("editor");
    expect((await searchAll("s1Viewer"))[id]).toBe("editor");
  });

  it("a restricted Every-space editor is viewer in a space created after the mapping, and can't create there", async () => {
    const got = await listAll("restricted", {
      scope: "space",
      spaceId: spaceIds.s4,
    });
    expect(Object.keys(got)).toHaveLength(3);
    expect(new Set(Object.values(got))).toEqual(new Set(["viewer"]));
    const r = await api(app, R.artifacts, who.restricted.cookie, {
      method: "POST",
      body: {
        title: "t",
        format: "html",
        content: "<p>x",
        spaceId: spaceIds.s4,
      },
    });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("space_forbidden");
  });

  it("public artifacts in spaces with public links off are listed per decide (no exception)", async () => {
    // memberB has no role in s4 (public links off): the link alone lists it.
    const got = await listAll("memberB");
    for (const s of ["s2", "s4"] as const) {
      const id = Object.values(arts).find(
        (a) => a.space === s && a.visibility === "public" && !a.deleted,
      )?.id as string;
      expect(got[id]).toBe(s === "s2" ? "editor" : "viewer");
    }
  });

  it("the matrix covers every level and both kinds of space", async () => {
    const seen = new Set<string>();
    for (const w of CALLERS)
      for (const [id, l] of Object.entries(await listAll(w)))
        seen.add(`${l}:${arts[id]?.space.startsWith("p") ? "p" : "s"}`);
    expect([...seen].sort()).toEqual(
      [
        "owner:p",
        "editor:p",
        "viewer:p",
        "manager:s",
        "editor:s",
        "viewer:s",
      ].sort(),
    );
  });

  it("scope=space with another user's personal space id returns 400 space_personal and lists nothing", async () => {
    const r = await api(
      app,
      `${R.artifacts}?scope=space&spaceId=${who.owner.id}`,
      who.admin.cookie,
    );
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("space_personal");
    // spaceId narrows any scope, with the same refusal.
    const all = await api(
      app,
      `${R.artifacts}?scope=all&spaceId=${who.owner.id}`,
      who.admin.cookie,
    );
    expect(all.status).toBe(400);
  });

  it("scope=space needs spaceId; an unknown space is 404", async () => {
    const r = await api(app, `${R.artifacts}?scope=space`, who.admin.cookie);
    expect(r.status).toBe(400);
    const u = await api(
      app,
      `${R.artifacts}?scope=space&spaceId=${newId()}`,
      who.admin.cookie,
    );
    expect(u.status).toBe(404);
  });

  it("scope=space lists one shared space, at the same levels", async () => {
    const got = await listAll("memberA", {
      scope: "space",
      spaceId: spaceIds.s2,
    });
    const all = await listAll("memberA");
    const want = Object.fromEntries(
      Object.entries(all).filter(([id]) => arts[id]?.space === "s2"),
    );
    expect(got).toEqual(want);
    expect(Object.values(got)).toEqual(["manager", "manager", "manager"]);
    // The caller's own personal space is allowed (as scope=mine).
    const mine = await listAll("memberA", {
      scope: "space",
      spaceId: who.memberA.id,
    });
    expect(mine).toEqual(await listAll("memberA", { scope: "mine" }));
  });

  it("scope=spaces lists shared spaces only: roles, allMembersRole, Every space", async () => {
    const spacesOf = async (w: Who) =>
      [
        ...new Set(
          Object.keys(await listAll(w, { scope: "spaces" })).map(
            (id) => arts[id]?.space,
          ),
        ),
      ].sort();
    // memberA: s1 (editor), s2 (manager), s3 and s5 (allMembersRole).
    expect(await spacesOf("memberA")).toEqual(["s1", "s2", "s3", "s5"]);
    // Org admins get nothing from their org role.
    expect(await spacesOf("admin")).toEqual(["s2", "s3", "s5"]);
    // Guests and capped callers never get allMembersRole.
    expect(await spacesOf("guest")).toEqual(["s1"]);
    expect(await spacesOf("guestCapped")).toEqual([]);
    // A guest's Every-space mapping is a role (decide): every shared space.
    expect(await spacesOf("guestEvery")).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
    ]);
    expect(await spacesOf("restricted")).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
    ]);
  });

  it("an Every-space editor mapping lists every shared space (including one created after the mapping) at editor, and no personal space", async () => {
    const got = Object.fromEntries(
      Object.entries(await listAll("everyEditor", { scope: "spaces" })).filter(
        ([id]) => S1_S4(id),
      ),
    );
    const bySpace: Record<string, Set<AccessLevel>> = {};
    for (const [id, l] of Object.entries(got)) {
      const s = arts[id]?.space as string;
      bySpace[s] = (bySpace[s] ?? new Set()).add(l);
    }
    // s2's allMembersRole is editor too; s3's viewer loses to the mapping.
    expect(Object.keys(bySpace).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    for (const levels of Object.values(bySpace))
      expect([...levels]).toEqual(["editor"]);
    expect(Object.keys(got)).toHaveLength(12);
    const all = await listAll("everyEditor");
    for (const id of Object.keys(all))
      if (arts[id]?.space.startsWith("p"))
        expect(arts[id]?.visibility).not.toBe("private");
  });

  it("Every-space viewer and per-space manager resolve to manager (max at read time)", async () => {
    const got = Object.fromEntries(
      Object.entries(
        await listAll("everyViewerMgr", { scope: "spaces" }),
      ).filter(([id]) => S1_S4(id)),
    );
    // s2's allMembersRole (editor) beats the Every-space viewer too.
    const want = { s1: "manager", s2: "editor", s3: "viewer", s4: "viewer" };
    for (const [id, l] of Object.entries(got))
      expect(l).toBe(want[arts[id]?.space as keyof typeof want]);
    expect(Object.keys(got)).toHaveLength(12);
  });

  it("hand-written levels (not derived from spaceRankSql)", async () => {
    const id = (s: SpaceName, v: Visibility = "private") =>
      Object.values(arts).find(
        (a) => a.space === s && a.visibility === v && !a.deleted,
      )?.id as string;
    const guestEvery = capOfCaller(who.guestEvery.caller) ? "viewer" : "editor";
    const HAND: [Who, string, AccessLevel | null][] = [
      ["memberA", id("s2"), "manager"], // space_members manager
      ["memberB", id("s2"), "editor"], // allMembersRole editor
      ["memberB", id("s3"), "viewer"], // allMembersRole viewer
      ["memberB", id("s5"), "manager"], // allMembersRole manager
      ["memberB", id("s1"), "editor"], // sync viewer + manual editor rows
      ["everyEditor", id("s4"), "editor"], // Every space, space created later
      ["everyEditor", id("s5"), "manager"], // allMembersRole beats the mapping
      ["everyViewerMgr", id("s1"), "manager"],
      ["everyViewerMgr", id("s4"), "viewer"],
      ["s1Viewer", id("s1"), "editor"], // viewer role + editor share
      ["restricted", id("s1"), "viewer"], // editor role, capped
      ["restricted", id("s5"), "viewer"], // Every space, capped; no allMembers
      ["guestEvery", id("s4"), guestEvery],
      ["guestCapped", id("s5"), "viewer"], // editor share, capped
      ["guestCapped", id("s5", "team"), null], // no allMembersRole for guests
      ["guest", id("s5", "public"), "viewer"], // the link
      ["admin", id("s1"), null],
      ["owner", id("pA"), null],
    ];
    for (const [w, a, want] of HAND) {
      const got = await authorize(env, who[w].caller, a, "view").then(
        (r) => r.level,
        () => null,
      );
      expect({ w, a, got }).toEqual({ w, a, got: want });
      if (want && !(await linkOnly(w, a)))
        expect({ w, a, listed: (await listAll(w))[a] }).toEqual({
          w,
          a,
          listed: want,
        });
    }
  });

  it("spaceId narrows list and search to the space, or is 404 without a role", async () => {
    for (const w of CALLERS) {
      const want = await expected(w);
      for (const s of ["s1", "s2", "s3", "s4", "s5"] as const) {
        const sid = spaceIds[s];
        const inSpace = Object.fromEntries(
          Object.entries(want).filter(([id]) => arts[id]?.space === s),
        );
        if (await hasRole(w, sid)) {
          for (const scope of ["space", "all"] as const)
            expect({
              w,
              s,
              scope,
              got: await listAll(w, { scope, spaceId: sid }),
            }).toEqual({ w, s, scope, got: inSpace });
          const hits = await search(
            env,
            who[w].caller,
            word,
            undefined,
            100,
            sid,
          );
          expect({
            w,
            s,
            hits: Object.fromEntries(
              hits.items.filter((h) => arts[h.id]).map((h) => [h.id, h.access]),
            ),
          }).toEqual({ w, s, hits: inSpace });
        } else {
          expect({
            w,
            s,
            list: await errCode(listAll(w, { scope: "space", spaceId: sid })),
            search: await errCode(
              search(env, who[w].caller, word, undefined, 100, sid),
            ),
          }).toEqual({ w, s, list: "not_found", search: "not_found" });
        }
      }
    }
  });

  it("a non-member's real shared spaceId is 404 on list and search, exactly as an unknown id", async () => {
    // admin has no role in s1; memberB none in s4 (public artifacts there).
    for (const [w, s] of [
      ["admin", "s1"],
      ["memberB", "s4"],
    ] as const) {
      const shape = async (sid: string) => {
        const out = [];
        for (const path of [
          `${R.artifacts}?scope=space&spaceId=${sid}`,
          `${R.artifacts}?spaceId=${sid}`,
          `${R.search}?q=${word}&spaceId=${sid}`,
        ]) {
          const r = await api(app, path, who[w].cookie);
          out.push([r.status, await r.json()]);
        }
        return out;
      };
      const real = await shape(spaceIds[s]);
      expect(real).toEqual(await shape(newId()));
      expect(real.map(([status]) => status)).toEqual([404, 404, 404]);
    }
  });

  it("a capped caller lists at viewer only, and never sees trash", async () => {
    const got = await listAll("restricted", { includeDeleted: true });
    expect(new Set(Object.values(got))).toEqual(new Set(["viewer"]));
    for (const id of Object.keys(got)) expect(arts[id]?.deleted).toBeFalsy();
  });

  it("trash lists the caller's own personal deleted artifacts as owner", async () => {
    const got = await listAll("memberA", {
      scope: "mine",
      includeDeleted: true,
    });
    const deleted = Object.keys(got).filter((id) => arts[id]?.deleted);
    // Deleted private, team and public.
    expect(deleted).toHaveLength(3);
    for (const id of deleted) expect(got[id]).toBe("owner");
  });
});

describe("public links off only refuses new public links (decided)", () => {
  const word = `linkword${tag}`;
  let id: string;
  let sid: string;

  beforeAll(async () => {
    const db = getDb(env);
    const a = (await getUser(env, who.memberA.id)) as Member;
    id = (
      await publish(
        env,
        a,
        {
          title: "already public",
          format: "html",
          content: `<p>${word}</p>`,
          visibility: "public",
        } as never,
        null,
      )
    ).id;
    await runIndex(id);
    // A public artifact in a shared space with public links on, then the
    // toggle goes off (the spaces API is T9; the rows are what it writes).
    sid = newId();
    await db.insert(spaces).values({
      id: sid,
      kind: "shared",
      name: `links-${tag}`,
      publicLinks: 1,
      createdAt: Date.now(),
    });
    await db.insert(spaceMembers).values({
      spaceId: sid,
      userId: who.memberA.id,
      role: "manager",
      source: "manual",
      createdAt: Date.now(),
    });
    await db
      .update(artifacts)
      .set({ spaceId: sid })
      .where(eq(artifacts.id, id));
    await db.update(spaces).set({ publicLinks: 0 }).where(eq(spaces.id, sid));
  });

  it("an existing public artifact stays servable after the toggle goes off", async () => {
    expect((await contentCall(`${publicPrefix(id, 1)}__view`)).status).toBe(
      200,
    );
    const u = await api(app, R.contentUrl(id), null);
    expect(u.status).toBe(200);
    expect(((await u.json()) as { url: string }).url).toContain("/p/");
    expect((await api(app, R.artifact(id), null)).status).toBe(200);
    await expect(
      authorize(env, { kind: "anonymous" }, id, "view"),
    ).resolves.toMatchObject({ level: "viewer" });
  });

  it("lists and search match decide(): viewer by the link, manager by the role", async () => {
    for (const [w, level] of [
      ["memberB", "viewer"],
      ["memberA", "manager"],
    ] as const) {
      const page = await list(
        env,
        who[w].caller,
        ListQuerySchema.parse({ limit: 100 }),
      );
      expect(page.items.find((a) => a.id === id)?.access).toBe(level);
      const hits = await search(env, who[w].caller, word);
      expect(hits.items.map((h) => [h.id, h.access])).toEqual([[id, level]]);
      expect((await authorize(env, who[w].caller, id, "view")).level).toBe(
        level,
      );
    }
  });

  it("echoing visibility public on an already-public artifact is a no-op that passes", async () => {
    const keep = await api(app, R.artifact(id), who.memberA.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    expect(keep.status).toBe(200);
    const v = await api(app, R.versions(id), who.memberA.cookie, {
      method: "POST",
      body: { format: "html", content: "<p>echo", visibility: "public" },
    });
    expect(v.status).toBeLessThan(300);
    expect((await contentCall(`${publicPrefix(id, 1)}__view`)).status).toBe(
      200,
    );
  });

  it("a new public link is refused with public_links_off, even by a manager", async () => {
    const team = await api(app, R.artifact(id), who.memberA.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(team.status).toBe(200);
    for (const req of [
      // set_visibility (MCP) is this PATCH.
      { method: "PATCH", path: R.artifact(id), body: { visibility: "public" } },
      {
        method: "POST",
        path: R.versions(id),
        body: { format: "html", content: "<p>v2", visibility: "public" },
      },
    ]) {
      const r = await api(app, req.path, who.memberA.cookie, req);
      expect({ req: req.method, ...(await errOf(r)) }).toMatchObject({
        req: req.method,
        code: "public_links_off",
      });
      expect(r.status).toBe(403);
    }
    const row = await getDb(env)
      .select({ v: artifacts.visibility })
      .from(artifacts)
      .where(eq(artifacts.id, id));
    expect(row[0]?.v).toBe("team");
    expect((await contentCall(`${publicPrefix(id, 1)}__view`)).status).toBe(
      404,
    );
    // private → public is refused the same way.
    expect(
      (
        await api(app, R.artifact(id), who.memberA.cookie, {
          method: "PATCH",
          body: { visibility: "private" },
        })
      ).status,
    ).toBe(200);
    const fromPrivate = await api(app, R.artifact(id), who.memberA.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    expect(fromPrivate.status).toBe(403);
    expect((await errOf(fromPrivate)).code).toBe("public_links_off");
  });
});

// P3 T10 (manager ruling): every list row and search hit carries the same
// `space` and `can` as getSummary for the same caller and artifact, with
// spaces on, signed-in callers only, read from the query's own join.
describe("space and can on list and search rows", () => {
  const ON = { ...(env as object), FEATURES: "spaces" } as unknown as Env;
  type Deco = Pick<ArtifactSummary, "space" | "can" | "access">;
  const pick = (a: ArtifactSummary): Deco => ({
    space: a.space,
    can: a.can,
    access: a.access,
  });
  const summaries = async (w: Who, ids: string[]) => {
    const out: Record<string, Deco> = {};
    for (const id of ids)
      out[id] = pick(await getSummary(ON, who[w].caller, id));
    return out;
  };
  const collect = async (
    next: (cursor?: string) => Promise<Page<ArtifactSummary>>,
  ) => {
    const out: Record<string, Deco> = {};
    let cursor: string | undefined;
    do {
      const page = await next(cursor);
      for (const a of page.items) if (arts[a.id]) out[a.id] = pick(a);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out;
  };

  it("list(all) and search rows equal getSummary for every caller and artifact", async () => {
    let decorated = 0;
    let hidden = 0;
    for (const w of CALLERS) {
      const listed = await collect((cursor) =>
        list(ON, who[w].caller, ListQuerySchema.parse({ limit: 100, cursor })),
      );
      const searched = await collect((cursor) =>
        search(ON, who[w].caller, word, cursor, 100),
      );
      const want = await summaries(w, Object.keys(listed));
      expect({ w, listed }).toEqual({ w, listed: want });
      expect({ w, searched }).toEqual({
        w,
        searched: await summaries(w, Object.keys(searched)),
      });
      for (const d of Object.values(listed)) {
        expect(d.can).toBeDefined();
        if (d.space) decorated++;
        else hidden++;
      }
    }
    // Both happen across the matrix: a role shows the space, a share or a
    // team or public link alone hides a shared one.
    expect(decorated).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);
  });

  it("a share recipient with no role in the shared space gets no space on list, search and get", async () => {
    const s = await getDb(env)
      .insert(spaces)
      .values({
        id: newId(),
        kind: "shared",
        name: `Hidden ${tag}`,
        publicLinks: 1,
        createdAt: Date.now(),
      })
      .returning({ id: spaces.id });
    const sid = s[0]?.id as string;
    const id = newId();
    const title = `hiddenspace${tag}`.replace(/\d/g, "q");
    await env.DB.prepare(
      "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at) values (?, ?, ?, ?, 'html', 'private', 1, ?)",
    )
      .bind(id, who.owner.id, sid, title, Date.now())
      .run();
    await env.DB.prepare(
      "insert into artifact_search (rowid, artifact_id, title, description, body) select rowid, id, title, '', '' from artifacts where id = ?",
    )
      .bind(id)
      .run();
    const m = await getUser(env, who.memberA.id);
    await env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, 1)",
    )
      .bind(id, m?.email, who.owner.id)
      .run();
    const c = who.memberA.caller;
    const got = await getSummary(ON, c, id);
    expect(got.access).toBe("viewer");
    expect(got.space).toBeUndefined();
    expect(got.can).toMatchObject({ edit: false });
    const listed = await list(
      ON,
      c,
      ListQuerySchema.parse({ scope: "shared", limit: 100 }),
    );
    const row = listed.items.find((a) => a.id === id);
    expect(row?.space).toBeUndefined();
    expect(row?.can).toEqual(got.can);
    const hit = (await search(ON, c, title, undefined, 10)).items.find(
      (a) => a.id === id,
    );
    expect(hit?.space).toBeUndefined();
    expect(hit?.can).toEqual(got.can);
  });

  it("spaces off: the server's can on every row and hit (parity 1, B5), no space; move and transfer false", async () => {
    const page = await list(
      env,
      who.memberA.caller,
      ListQuerySchema.parse({ limit: 100 }),
    );
    const hits = await search(env, who.memberA.caller, word, undefined, 100);
    expect(page.items.length).toBeGreaterThan(0);
    for (const a of [...page.items, ...hits.items]) {
      expect(a.space).toBeUndefined();
      expect(a.can).toBeDefined();
      expect(a.can?.move).toBe(false);
      expect(a.can?.transfer).toBe(false);
    }
    const first = page.items[0];
    if (!first) throw new Error("no row");
    const one = await getSummary(env, who.memberA.caller, first.id);
    expect(one.space).toBeUndefined();
    expect(one.can).toEqual(first.can);
  });

  it("anonymous: no space or can, spaces on or off", async () => {
    const pub = (
      await env.DB.prepare(
        "select id from artifacts where visibility = 'public' and deleted_at is null limit 1",
      ).first<{ id: string }>()
    )?.id;
    if (!pub) return;
    for (const e of [env, ON]) {
      const a = await getSummary(e, { kind: "anonymous" }, pub);
      expect(a.space).toBeUndefined();
      expect(a.can).toBeUndefined();
    }
  });

  it("REST list and search, and MCP list_artifacts and search_artifacts, carry them", async () => {
    const rest = async (path: string) =>
      (await (
        await fetchAndWait(
          app,
          new Request(`http://app.localhost${path}`, {
            headers: { "x-oa-request": "1", cookie: who.s1Viewer.cookie },
          }),
          ON,
        )
      ).json()) as Page<ArtifactSummary>;
    const viaRest = {
      list: await rest(`${R.artifacts}?limit=100`),
      search: await rest(`${R.search}?q=${word}&limit=100`),
    };
    const c = await connect(
      (await createPat(env, who.s1Viewer.id, "deco")).token,
      { env: ON },
    );
    const viaMcp = {
      list: (await tool(c, "list_artifacts", { limit: 100 }))
        .structuredContent as unknown as Page<ArtifactSummary>,
      search: (await tool(c, "search_artifacts", { q: word, limit: 100 }))
        .structuredContent as unknown as Page<ArtifactSummary>,
    };
    await c.close();
    for (const p of [
      viaRest.list,
      viaRest.search,
      viaMcp.list,
      viaMcp.search,
    ]) {
      const mine = p.items.filter((a) => arts[a.id]);
      expect(mine.length).toBeGreaterThan(0);
      const want = await summaries(
        "s1Viewer",
        mine.map((a) => a.id),
      );
      for (const a of mine) expect(pick(a)).toEqual(want[a.id]);
    }
  });
});
