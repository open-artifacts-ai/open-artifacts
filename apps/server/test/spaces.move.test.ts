// P3 T10: publish into spaces, move, single transfer and the departed-person
// transfer. Every write is compare-and-set (#484), audited in its own batch
// (#504) and closes the live sockets it narrows.
import { env } from "cloudflare:workers";
import {
  type AccessLevel,
  type ArtifactSummary,
  newId,
  R,
  type Space,
  TRANSFER_PAGE,
  type TransferResult,
  type TransferSummary,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { accessLevel, callerOf } from "../src/auth/authz.js";
import type { Env } from "../src/env.js";
import { getUser } from "../src/services/users.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

/** Spaces on (Paid, so no fan-out cap gets in the way). */
const ON = {
  ...(env as object),
  PLAN: "paid",
  FEATURES: "spaces",
} as unknown as Env;
const OFF = { ...(env as object), FEATURES: "" } as unknown as Env;

type Init = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};
const call = (
  path: string,
  cookie: string | null,
  init: Init = {},
  e: Env = ON,
) =>
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
        ...init.headers,
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
const row = (id: string) =>
  one<{
    space_id: string;
    owner_id: string;
    visibility: string;
    deleted_at: number | null;
  }>(
    "select space_id, owner_id, visibility, deleted_at from artifacts where id = ?",
    id,
  );
const audits = async (action: string, targetId: string) =>
  (
    await env.DB.prepare(
      "select * from audit_events where action = ? and target_id = ? order by at, id",
    )
      .bind(action, targetId)
      .all<{ actor_id: string; space_id: string | null; detail: string }>()
  ).results;

type U = { cookie: string; userId: string; email: string };
const mk = async (
  p: string,
  role: "member" | "admin" | "guest" | "owner" = "member",
): Promise<U> => {
  const email = `${p}-${newId().slice(0, 4).toLowerCase()}-${tag}@x.com`;
  return { ...(await login(email, role)), email };
};
const level = async (
  userId: string,
  artifactId: string,
): Promise<AccessLevel | null> => {
  const u = await getUser(ON, userId);
  if (!u) return null;
  return (await accessLevel(ON, callerOf(u), artifactId))?.level ?? null;
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

let admin: U;
const createSpace = async (body: Record<string, unknown> = {}) => {
  const r = await call(R.spaces, admin.cookie, {
    method: "POST",
    body: { name: `M ${newId().slice(0, 6)}`, ...body },
  });
  expect(r.status).toBe(201);
  return json<Space>(r);
};
const addMember = async (sid: string, u: U, role: string) =>
  expect(
    (
      await call(R.spaceMember(sid, u.userId), admin.cookie, {
        method: "PUT",
        body: { role },
      })
    ).status,
  ).toBe(200);
const restrict = (u: U) =>
  run("update users set restricted_manual = 1 where id = ?", u.userId);
/** ON whose first D1 batch runs `change` first (a write racing the request). */
const racing = (change: () => Promise<unknown>): Env => {
  let fired = false;
  const DB = new Proxy(env.DB, {
    get(t, p) {
      if (p === "batch")
        return async (ss: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await change();
          }
          return t.batch(ss);
        };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...(ON as object), DB } as unknown as Env;
};

const base = { title: "T10", format: "html", content: "<p>x</p>" };
const publishTo = (u: U, body: Record<string, unknown>) =>
  call(R.artifacts, u.cookie, { method: "POST", body: { ...base, ...body } });
const move = (u: U | null, id: string, spaceId: string) =>
  call(R.moveArtifact(id), u?.cookie ?? null, {
    method: "POST",
    body: { spaceId },
  });
const transfer = (u: U, id: string, userId: string) =>
  call(R.transferArtifact(id), u.cookie, { method: "POST", body: { userId } });
const departed = (u: U, from: string, body: unknown) =>
  call(R.memberTransfer(from), u.cookie, { method: "POST", body });

beforeAll(async () => {
  admin = await mk("adm", "admin");
});

describe("publish into a space", () => {
  it("an editor publishes into a shared space; the owner_id stays theirs", async () => {
    const s = await createSpace();
    const ed = await mk("ed");
    await addMember(s.id, ed, "editor");
    const r = await publishTo(ed, { spaceId: s.id });
    expect(r.status).toBe(201);
    const { id } = await json<{ id: string }>(r);
    expect(await row(id)).toMatchObject({
      space_id: s.id,
      owner_id: ed.userId,
    });
    expect(await level(ed.userId, id)).toBe("editor");
    // Their own personal space works too, and is the default.
    const own = await publishTo(ed, { spaceId: ed.userId });
    expect(own.status).toBe(201);
    const ownId = (await json<{ id: string }>(own)).id;
    expect((await row(ownId))?.space_id).toBe(ed.userId);
  });

  it("publish with spaceId = someone else's personal space → 404; nothing written", async () => {
    const a = await mk("pa");
    const b = await mk("pb");
    const before = await one<{ n: number }>(
      "select count(*) n from artifacts where space_id = ?",
      b.userId,
    );
    const r = await publishTo(a, { spaceId: b.userId });
    expect(r.status).toBe(404);
    const after = await one<{ n: number }>(
      "select count(*) n from artifacts where space_id = ?",
      b.userId,
    );
    expect(after?.n).toBe(before?.n);
  });

  it("an unknown space, or a shared one with no role → 404; a view-only one → 403 space_forbidden", async () => {
    const s = await createSpace();
    const vw = await mk("vw");
    expect((await publishTo(vw, { spaceId: s.id })).status).toBe(404);
    expect((await publishTo(vw, { spaceId: newId() })).status).toBe(404);
    await addMember(s.id, vw, "viewer");
    const r = await publishTo(vw, { spaceId: s.id });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("space_forbidden");
    // An org admin with no role in the space can see it, but not publish.
    const r2 = await publishTo(admin, { spaceId: s.id });
    expect(await code(r2)).toBe("space_forbidden");
  });

  it("any create by a restricted member → 403 space_forbidden, even as a space editor", async () => {
    const s = await createSpace();
    const c = await mk("cap");
    await addMember(s.id, c, "editor");
    await restrict(c);
    expect(await code(await publishTo(c, {}))).toBe("space_forbidden");
    expect(await code(await publishTo(c, { spaceId: s.id }))).toBe(
      "space_forbidden",
    );
  });

  it("spaceId on an existing artifact → 400 use_move", async () => {
    const u = await mk("um");
    const s = await createSpace();
    await addMember(s.id, u, "editor");
    const { id } = await json<{ id: string }>(await publishTo(u, {}));
    const r = await call(R.versions(id), u.cookie, {
      method: "POST",
      body: { format: "html", content: "<p>2</p>", spaceId: s.id },
    });
    expect(r.status).toBe(400);
    expect(await code(r)).toBe("use_move");
    const r2 = await publishTo(u, { id, spaceId: s.id });
    expect(await code(r2)).toBe("use_move");
    expect((await row(id))?.space_id).toBe(u.userId);
  });

  it("visibility public into a no-public-links space → 403 public_links_off; team is fine", async () => {
    const s = await createSpace({ publicLinks: false });
    const ed = await mk("pl");
    await addMember(s.id, ed, "editor");
    const r = await publishTo(ed, { spaceId: s.id, visibility: "public" });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("public_links_off");
    expect(
      (await publishTo(ed, { spaceId: s.id, visibility: "team" })).status,
    ).toBe(201);
  });

  it("a stale visibility resend loses to a concurrent change: 409 conflict, nothing written (#484)", async () => {
    const s = await createSpace({ publicLinks: false });
    const mgr = await mk("cas");
    await addMember(s.id, mgr, "manager");
    const id = await insertArtifact(mgr.userId, s.id, "public");
    // Between the access read and the write, someone narrows it to team.
    let fired = false;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return async (ss: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await t
                .prepare(
                  "update artifacts set visibility = 'team' where id = ?",
                )
                .bind(id)
                .run();
            }
            return t.batch(ss);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await call(
      R.versions(id),
      mgr.cookie,
      {
        method: "POST",
        body: { format: "html", content: "<p>2</p>", visibility: "public" },
      },
      { ...(ON as object), DB } as unknown as Env,
    );
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("conflict");
    expect((await row(id))?.visibility).toBe("team");
  });
});

describe("patch compare-and-set (#484)", () => {
  it("a stale PATCH visibility loses to a concurrent change: 409, no audit row", async () => {
    const u = await mk("pcas");
    const id = await insertArtifact(u.userId, u.userId, "team");
    let fired = false;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return async (ss: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await t
                .prepare(
                  "update artifacts set visibility = 'private' where id = ?",
                )
                .bind(id)
                .run();
            }
            return t.batch(ss);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await call(
      R.artifact(id),
      u.cookie,
      { method: "PATCH", body: { visibility: "public" } },
      { ...(ON as object), DB } as unknown as Env,
    );
    expect(r.status).toBe(409);
    expect((await row(id))?.visibility).toBe("private");
    expect(await audits("artifact.visibility", id)).toHaveLength(0);
  });
});

describe("publish compare-and-set with agent attribution (#559)", () => {
  // The versions insert binds the CAS guard and agent_via positionally: a
  // swapped bind would break one of these silently.
  const versionsOf = async (id: string) =>
    (await one<{ n: number }>(
      "select count(*) as n from versions where artifact_id = ?",
      id,
    ))?.n;

  it("a stale visibility change on publish: 409, no version written", async () => {
    const u = await mk("vcas");
    const id = await insertArtifact(u.userId, u.userId, "team");
    const before = await versionsOf(id);
    let fired = false;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return async (ss: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await t
                .prepare(
                  "update artifacts set visibility = 'private' where id = ?",
                )
                .bind(id)
                .run();
            }
            return t.batch(ss);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await call(
      R.versions(id),
      u.cookie,
      {
        method: "POST",
        body: { format: "markdown", content: "# 2", visibility: "public" },
      },
      { ...(ON as object), DB } as unknown as Env,
    );
    expect(r.status).toBe(409);
    expect((await row(id))?.visibility).toBe("private");
    expect(await versionsOf(id)).toBe(before);
  });

  it("an agent publish with a visibility change records agent_via and counts", async () => {
    const u = await mk("vvia");
    const id = await insertArtifact(u.userId, u.userId, "team");
    const pat = await createPat(env, u.userId, "cas");
    const r = await call(R.versions(id), null, {
      method: "POST",
      headers: { authorization: `Bearer ${pat.token}` },
      body: { format: "markdown", content: "# 2", visibility: "private" },
    });
    expect(r.status).toBe(201);
    const { version } = await json<{ version: number }>(r);
    expect(
      await one<{ via: string | null }>(
        "select agent_via as via from versions where artifact_id = ? and version = ?",
        id,
        version,
      ),
    ).toEqual({ via: `t:${pat.id}` });
    expect(
      await one<{ n: number }>(
        "select versions_published as n from tokens where id = ?",
        pat.id,
      ),
    ).toEqual({ n: 1 });
    expect((await row(id))?.visibility).toBe("private");
  });
});

describe("roles and status re-checked in the write", () => {
  const dropRole = (sid: string, u: U) =>
    run(
      "delete from space_members where space_id = ? and user_id = ?",
      sid,
      u.userId,
    );

  it("move: the target role revoked mid-call → 409, nothing moved", async () => {
    const to = await createSpace();
    const u = await mk("rt");
    await addMember(to.id, u, "editor");
    const art = await insertArtifact(u.userId, u.userId);
    const r = await call(
      R.moveArtifact(art),
      u.cookie,
      { method: "POST", body: { spaceId: to.id } },
      racing(() => dropRole(to.id, u)),
    );
    expect(r.status).toBe(409);
    expect((await row(art))?.space_id).toBe(u.userId);
    expect(await audits("artifact.move", art)).toHaveLength(0);
  });

  it("move: the source manager role revoked mid-call → 409, nothing moved", async () => {
    const from = await createSpace();
    const to = await createSpace();
    const u = await mk("rs");
    await addMember(from.id, u, "manager");
    await addMember(to.id, u, "editor");
    const art = await insertArtifact(u.userId, from.id);
    const r = await call(
      R.moveArtifact(art),
      u.cookie,
      { method: "POST", body: { spaceId: to.id } },
      racing(() => dropRole(from.id, u)),
    );
    expect(r.status).toBe(409);
    expect((await row(art))?.space_id).toBe(from.id);
  });

  it("create: the editor role revoked mid-call → 409, nothing created", async () => {
    const s = await createSpace();
    const u = await mk("rc");
    await addMember(s.id, u, "editor");
    const before = await one<{ n: number }>(
      "select count(*) n from artifacts where space_id = ?",
      s.id,
    );
    const r = await call(
      R.artifacts,
      u.cookie,
      { method: "POST", body: { ...base, spaceId: s.id } },
      racing(() => dropRole(s.id, u)),
    );
    expect(r.status).toBe(409);
    const after = await one<{ n: number }>(
      "select count(*) n from artifacts where space_id = ?",
      s.id,
    );
    expect(after?.n).toBe(before?.n);
  });

  it("departed transfer: the source reactivated mid-call → 409, nothing moved", async () => {
    const g = await mk("react");
    await insertArtifact(g.userId, g.userId);
    await run("update users set status = 'suspended' where id = ?", g.userId);
    const s = await createSpace();
    const r = await call(
      R.memberTransfer(g.userId),
      admin.cookie,
      { method: "POST", body: { to: { kind: "space", spaceId: s.id } } },
      racing(() =>
        run("update users set status = 'active' where id = ?", g.userId),
      ),
    );
    expect(r.status).toBe(409);
    expect(
      (
        await one<{ n: number }>(
          "select count(*) n from artifacts where space_id = ?",
          g.userId,
        )
      )?.n,
    ).toBe(1);
  });
});

describe("public links toggled off mid-write", () => {
  it("PATCH team → public loses to a racing toggle-off: 409, still team", async () => {
    const s = await createSpace();
    const mgr = await mk("prace");
    await addMember(s.id, mgr, "manager");
    const id = await insertArtifact(mgr.userId, s.id, "team");
    const r = await call(
      R.artifact(id),
      mgr.cookie,
      { method: "PATCH", body: { visibility: "public" } },
      racing(() =>
        run("update spaces set public_links = 0 where id = ?", s.id),
      ),
    );
    expect(r.status).toBe(409);
    expect((await row(id))?.visibility).toBe("team");
    expect(await audits("artifact.visibility", id)).toHaveLength(0);
  });

  it("publish (new version) team → public loses the same race: 409", async () => {
    const s = await createSpace();
    const mgr = await mk("prace2");
    await addMember(s.id, mgr, "manager");
    const id = await insertArtifact(mgr.userId, s.id, "team");
    const r = await call(
      R.versions(id),
      mgr.cookie,
      {
        method: "POST",
        body: { format: "html", content: "<p>2</p>", visibility: "public" },
      },
      racing(() =>
        run("update spaces set public_links = 0 where id = ?", s.id),
      ),
    );
    expect(r.status).toBe(409);
    expect((await row(id))?.visibility).toBe("team");
  });
});

describe("spaces off", () => {
  it("publish with a spaceId other than one's own → 404; one's own works", async () => {
    const s = await createSpace();
    const ed = await mk("soff");
    await addMember(s.id, ed, "editor");
    const r = await call(
      R.artifacts,
      ed.cookie,
      { method: "POST", body: { ...base, spaceId: s.id } },
      OFF,
    );
    expect(r.status).toBe(404);
    const own = await call(
      R.artifacts,
      ed.cookie,
      { method: "POST", body: { ...base, spaceId: ed.userId } },
      OFF,
    );
    expect(own.status).toBe(201);
  });
});

describe("move", () => {
  it("move shared → personal is 400 space_personal", async () => {
    const s = await createSpace();
    const mgr = await mk("mp");
    await addMember(s.id, mgr, "manager");
    const art = await insertArtifact(mgr.userId, s.id);
    const r = await move(mgr, art, mgr.userId);
    expect(r.status).toBe(400);
    expect(await code(r)).toBe("space_personal");
    // Someone else's personal space is 404 (no user-id oracle).
    const other = await mk("mpo");
    expect((await move(mgr, art, other.userId)).status).toBe(404);
    expect((await row(art))?.space_id).toBe(s.id);
  });

  it("personal → shared as an editor there: moved, audited artifact.move in the batch", async () => {
    const s = await createSpace();
    const u = await mk("mv");
    await addMember(s.id, u, "editor");
    const art = await insertArtifact(u.userId, u.userId);
    const r = await move(u, art, s.id);
    expect(r.status).toBe(200);
    const a = await json<ArtifactSummary>(r);
    expect(a).toMatchObject({
      id: art,
      access: "editor",
      space: { id: s.id, kind: "shared" },
      can: { move: false, transfer: false, edit: true },
    });
    expect(await row(art)).toMatchObject({
      space_id: s.id,
      owner_id: u.userId,
    });
    const rows = await audits("artifact.move", art);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: u.userId, space_id: s.id });
    const detail = JSON.parse(rows[0]?.detail ?? "{}");
    expect(detail).toEqual({ from: u.userId, to: s.id });
    expect(rows[0]?.detail).not.toContain("@");
    // Now an editor there: moving it again is not theirs to do.
    expect((await move(u, art, s.id)).status).toBe(404);
  });

  it("a move to the same space is a no-op without an audit row", async () => {
    const s = await createSpace();
    const mgr = await mk("same");
    await addMember(s.id, mgr, "manager");
    const art = await insertArtifact(mgr.userId, s.id);
    expect((await move(mgr, art, s.id)).status).toBe(200);
    expect(await audits("artifact.move", art)).toHaveLength(0);
  });

  it("a manager moving into a space where they're only a viewer → 403 space_forbidden", async () => {
    const from = await createSpace();
    const to = await createSpace();
    const mgr = await mk("mvw");
    await addMember(from.id, mgr, "manager");
    await addMember(to.id, mgr, "viewer");
    const art = await insertArtifact(mgr.userId, from.id);
    const r = await move(mgr, art, to.id);
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("space_forbidden");
    expect((await row(art))?.space_id).toBe(from.id);
    expect(await audits("artifact.move", art)).toHaveLength(0);
  });

  it("no role in the target → 404; an editor of the source → 404; anonymous → 401", async () => {
    const from = await createSpace();
    const to = await createSpace();
    const mgr = await mk("nr");
    const ed = await mk("nre");
    await addMember(from.id, mgr, "manager");
    await addMember(from.id, ed, "editor");
    await addMember(to.id, ed, "manager");
    const art = await insertArtifact(mgr.userId, from.id);
    expect((await move(mgr, art, to.id)).status).toBe(404);
    expect((await move(ed, art, to.id)).status).toBe(404);
    expect((await move(null, art, to.id)).status).toBe(401);
    expect((await row(art))?.space_id).toBe(from.id);
  });

  it("id swaps: a space id as the artifact, an artifact id as the space → 404", async () => {
    const s = await createSpace();
    const mgr = await mk("swap");
    await addMember(s.id, mgr, "manager");
    const art = await insertArtifact(mgr.userId, mgr.userId);
    const other = await insertArtifact(mgr.userId, mgr.userId);
    expect((await move(mgr, s.id, s.id)).status).toBe(404);
    expect((await move(mgr, art, other)).status).toBe(404);
    expect((await move(mgr, mgr.userId, s.id)).status).toBe(404);
    expect((await row(art))?.space_id).toBe(mgr.userId);
  });

  it("a capped caller can't move, even their own personal artifact or as a space manager", async () => {
    const s = await createSpace();
    const c = await mk("mcap");
    await addMember(s.id, c, "manager");
    const art = await insertArtifact(c.userId, c.userId);
    const inSpace = await insertArtifact(c.userId, s.id);
    await restrict(c);
    expect((await move(c, art, s.id)).status).toBe(404);
    expect((await move(c, inSpace, c.userId)).status).toBe(404);
    expect((await row(art))?.space_id).toBe(c.userId);
  });

  it("the source space's members lose access; the target's gain it", async () => {
    const from = await createSpace();
    const to = await createSpace();
    const mgr = await mk("mvm");
    const fromVw = await mk("fvw");
    const toVw = await mk("tvw");
    await addMember(from.id, mgr, "manager");
    await addMember(to.id, mgr, "editor");
    await addMember(from.id, fromVw, "viewer");
    await addMember(to.id, toVw, "viewer");
    const art = await insertArtifact(mgr.userId, from.id);
    expect(await level(fromVw.userId, art)).toBe("viewer");
    expect((await move(mgr, art, to.id)).status).toBe(200);
    expect(await level(fromVw.userId, art)).toBeNull();
    expect(await level(toVw.userId, art)).toBe("viewer");
    expect(await level(mgr.userId, art)).toBe("editor");
  });

  it("moving a public artifact into a no-public-links space: team in the same batch, anonymous sockets close", async () => {
    const u = await mk("pub");
    const s = await createSpace({ publicLinks: false });
    await addMember(s.id, u, "manager");
    const r = await publishTo(u, {
      visibility: "public",
      capabilities: { db: true },
    });
    const { id } = await json<{ id: string }>(r);
    const ws = (path: string) =>
      call(path, null, {
        headers: { upgrade: "websocket", "cf-connecting-ip": "198.51.100.7" },
      });
    const socks = [];
    for (const p of [R.dataSubscribe(id, "c"), R.events(id)]) {
      const res = await ws(p);
      const sock = res.webSocket;
      if (!sock) throw new Error(`no websocket for ${p} (${res.status})`);
      const closed = new Promise<number>((res) =>
        sock.addEventListener("close", (e) => res((e as CloseEvent).code)),
      );
      sock.accept();
      socks.push(closed);
    }
    const m = await move(u, id, s.id);
    expect(m.status).toBe(200);
    expect((await json<ArtifactSummary>(m)).visibility).toBe("team");
    expect((await row(id))?.visibility).toBe("team");
    // Anonymous: no longer viewable.
    expect((await call(R.artifact(id), null)).status).toBe(404);
    for (const closed of socks) expect(await closed).toBe(4403);
    const detail = JSON.parse(
      (await audits("artifact.move", id))[0]?.detail ?? "{}",
    );
    expect(detail).toEqual({
      from: u.userId,
      to: s.id,
      visibility: { from: "public", to: "team" },
    });
  });

  it("a stale move loses to a concurrent move: 409 conflict (#484)", async () => {
    const a = await createSpace();
    const b = await createSpace();
    const mgr = await mk("cmv");
    await addMember(a.id, mgr, "manager");
    await addMember(b.id, mgr, "manager");
    const art = await insertArtifact(mgr.userId, mgr.userId);
    let fired = false;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return async (ss: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await t
                .prepare("update artifacts set space_id = ? where id = ?")
                .bind(a.id, art)
                .run();
            }
            return t.batch(ss);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await call(
      R.moveArtifact(art),
      mgr.cookie,
      { method: "POST", body: { spaceId: b.id } },
      { ...(ON as object), DB } as unknown as Env,
    );
    expect(r.status).toBe(409);
    expect((await row(art))?.space_id).toBe(a.id);
    expect(await audits("artifact.move", art)).toHaveLength(0);
  });

  it("spaces off → 404", async () => {
    const u = await mk("off");
    const art = await insertArtifact(u.userId, u.userId);
    const r = await call(
      R.moveArtifact(art),
      u.cookie,
      { method: "POST", body: { spaceId: newId() } },
      OFF,
    );
    expect(r.status).toBe(404);
  });
});

describe("transfer", () => {
  it("the owner hands it over: their space, an editor share back, audited", async () => {
    const a = await mk("ta");
    const b = await mk("tb");
    const art = await insertArtifact(a.userId, a.userId, "team");
    const r = await transfer(a, art, b.userId);
    expect(r.status).toBe(200);
    expect(await json<ArtifactSummary>(r)).toMatchObject({
      access: "editor",
      owner: { id: b.userId },
      space: { id: b.userId, kind: "personal" },
    });
    expect(await row(art)).toMatchObject({
      space_id: b.userId,
      owner_id: b.userId,
    });
    expect(await level(b.userId, art)).toBe("owner");
    expect(await level(a.userId, art)).toBe("editor");
    const rows = await audits("artifact.transfer", art);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      from: a.userId,
      to: b.userId,
    });
    expect(rows[0]?.detail).not.toContain("@");
  });

  it("a successor's existing share is removed in the same batch", async () => {
    const a = await mk("tsa");
    const b = await mk("tsb");
    const art = await insertArtifact(a.userId, a.userId);
    await run(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, 1)",
      art,
      b.email,
      a.userId,
    );
    expect((await transfer(a, art, b.userId)).status).toBe(200);
    const left = await env.DB.prepare(
      "select email, role from shares where artifact_id = ? order by email",
    )
      .bind(art)
      .all<{ email: string; role: string }>();
    expect(left.results).toEqual([{ email: a.email, role: "editor" }]);
  });

  it("transfer by a non-owner → 404: an editor share, a space manager, a stranger", async () => {
    const a = await mk("tn");
    const ed = await mk("tne");
    const b = await mk("tnb");
    const art = await insertArtifact(a.userId, a.userId);
    await run(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'editor', ?, 1)",
      art,
      ed.email,
      a.userId,
    );
    expect((await transfer(ed, art, b.userId)).status).toBe(404);
    expect((await transfer(b, art, b.userId)).status).toBe(404);
    const s = await createSpace();
    await addMember(s.id, a, "manager");
    const inSpace = await insertArtifact(a.userId, s.id);
    expect((await transfer(a, inSpace, b.userId)).status).toBe(404);
    expect((await row(art))?.owner_id).toBe(a.userId);
  });

  it("transfer to a guest, a restricted, a suspended member or oneself → 400 invalid_successor", async () => {
    const a = await mk("ti");
    const guest = await mk("tig", "guest");
    const r = await mk("tir");
    await restrict(r);
    const s = await mk("tis");
    await run("update users set status = 'suspended' where id = ?", s.userId);
    const art = await insertArtifact(a.userId, a.userId);
    for (const to of [guest.userId, r.userId, s.userId, a.userId, newId()]) {
      const res = await transfer(a, art, to);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("invalid_successor");
    }
    expect((await row(art))?.owner_id).toBe(a.userId);
  });

  it("a capped owner can't transfer", async () => {
    const a = await mk("tc");
    const b = await mk("tcb");
    const art = await insertArtifact(a.userId, a.userId);
    await restrict(a);
    expect((await transfer(a, art, b.userId)).status).toBe(404);
  });
});

describe("departed transfer", () => {
  const gone = async (n: number, deleted = 0) => {
    const g = await mk("gone");
    for (let i = 0; i < n; i++) await insertArtifact(g.userId, g.userId);
    for (let i = 0; i < deleted; i++)
      await insertArtifact(g.userId, g.userId, "private", Date.now());
    await run("update users set status = 'suspended' where id = ?", g.userId);
    return g;
  };

  it("departed transfer on an active member → 409 member_active", async () => {
    const m = await mk("act");
    const s = await createSpace();
    const r = await departed(admin, m.userId, {
      to: { kind: "space", spaceId: s.id },
    });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("member_active");
  });

  it("org admins only; a member gets 404", async () => {
    const g = await gone(1);
    const m = await mk("nadm");
    const s = await createSpace();
    expect(
      (await departed(m, g.userId, { to: { kind: "space", spaceId: s.id } }))
        .status,
    ).toBe(404);
    expect((await call(R.memberTransfer(g.userId), m.cookie)).status).toBe(404);
  });

  it("requires an inactive source and pages 100 at a time; GET is counts only", async () => {
    const g = await gone(140, 10);
    const s = await createSpace();
    const sum = await call(R.memberTransfer(g.userId), admin.cookie);
    expect(await json<TransferSummary>(sum)).toEqual({
      live: 140,
      deleted: 10,
    });
    const r1 = await json<TransferResult>(
      await departed(admin, g.userId, { to: { kind: "space", spaceId: s.id } }),
    );
    expect(r1).toMatchObject({ moved: TRANSFER_PAGE, remaining: 50 });
    expect(r1.nextCursor).not.toBeNull();
    const r2 = await json<TransferResult>(
      await departed(admin, g.userId, {
        to: { kind: "space", spaceId: s.id },
        cursor: r1.nextCursor,
      }),
    );
    expect(r2).toEqual({ moved: 50, remaining: 0, nextCursor: null });
    const left = await one<{ n: number }>(
      "select count(*) n from artifacts where space_id = ?",
      g.userId,
    );
    expect(left?.n).toBe(0);
    const audit = await audits("artifact.transfer", g.userId);
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[0]?.detail ?? "{}")).toEqual({
      moved: 100,
      teamed: 0,
      to: { kind: "space", id: s.id },
    });
  });

  it("the paging limit holds: a forged cursor never moves more than a page; extra fields are 400", async () => {
    const g = await gone(TRANSFER_PAGE + 5);
    const s = await createSpace();
    const r = await json<TransferResult>(
      await departed(admin, g.userId, {
        to: { kind: "space", spaceId: s.id },
        cursor: "AAAA",
      }),
    );
    expect(r.moved).toBe(TRANSFER_PAGE);
    expect(
      (
        await departed(admin, g.userId, {
          to: { kind: "space", spaceId: s.id },
          limit: 1000,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await departed(admin, g.userId, {
          to: { kind: "space", spaceId: s.id },
          cursor: "x".repeat(5000),
        })
      ).status,
    ).toBe(400);
  });

  it("to a user: their personal space and owner; a bad successor is 400; a personal space target is 400", async () => {
    const g = await gone(2);
    const b = await mk("dst");
    const guest = await mk("dsg", "guest");
    expect(
      await code(
        await departed(admin, g.userId, {
          to: { kind: "user", userId: guest.userId },
        }),
      ),
    ).toBe("invalid_successor");
    expect(
      await code(
        await departed(admin, g.userId, {
          to: { kind: "user", userId: g.userId },
        }),
      ),
    ).toBe("invalid_successor");
    expect(
      await code(
        await departed(admin, g.userId, {
          to: { kind: "space", spaceId: b.userId },
        }),
      ),
    ).toBe("space_personal");
    expect(
      (
        await departed(admin, g.userId, {
          to: { kind: "space", spaceId: newId() },
        })
      ).status,
    ).toBe(404);
    const r = await json<TransferResult>(
      await departed(admin, g.userId, {
        to: { kind: "user", userId: b.userId },
      }),
    );
    expect(r).toEqual({ moved: 2, remaining: 0, nextCursor: null });
    const owned = await one<{ n: number }>(
      "select count(*) n from artifacts where space_id = ?1 and owner_id = ?1",
      b.userId,
    );
    expect(owned?.n).toBe(2);
  });

  it("into a no-public-links space, public artifacts become team", async () => {
    const g = await mk("dpub");
    const pub = await insertArtifact(g.userId, g.userId, "public");
    await run("update users set status = 'removed' where id = ?", g.userId);
    const s = await createSpace({ publicLinks: false });
    await departed(admin, g.userId, { to: { kind: "space", spaceId: s.id } });
    expect(await row(pub)).toMatchObject({
      space_id: s.id,
      visibility: "team",
    });
    const detail = JSON.parse(
      (await audits("artifact.transfer", g.userId))[0]?.detail ?? "{}",
    );
    expect(detail).toEqual({
      moved: 1,
      teamed: 1,
      to: { kind: "space", id: s.id },
    });
  });

  // The target is re-checked in the write: a change between the read and
  // the batch moves nothing and is 409.
  const raced = async (
    body: unknown,
    from: string,
    change: () => Promise<unknown>,
  ) =>
    call(
      R.memberTransfer(from),
      admin.cookie,
      { method: "POST", body },
      racing(change),
    );

  it("race: public links toggled off mid-call → 409, nothing moved", async () => {
    const g = await gone(2);
    const s = await createSpace();
    const r = await raced(
      { to: { kind: "space", spaceId: s.id } },
      g.userId,
      () => run("update spaces set public_links = 0 where id = ?", s.id),
    );
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("conflict");
    expect(
      (
        await one<{ n: number }>(
          "select count(*) n from artifacts where space_id = ?",
          g.userId,
        )
      )?.n,
    ).toBe(2);
    expect(await audits("artifact.transfer", g.userId)).toHaveLength(0);
  });

  it("race: the target space deleted mid-call → 409, nothing moved", async () => {
    const g = await gone(1);
    const s = await createSpace();
    const r = await raced(
      { to: { kind: "space", spaceId: s.id } },
      g.userId,
      () => run("update spaces set deleted_at = 1 where id = ?", s.id),
    );
    expect(r.status).toBe(409);
    expect(
      (
        await one<{ n: number }>(
          "select count(*) n from artifacts where space_id = ?",
          g.userId,
        )
      )?.n,
    ).toBe(1);
  });

  it("race: the successor suspended mid-call → 409, nothing moved", async () => {
    const g = await gone(1);
    const b = await mk("rsucc");
    const r = await raced(
      { to: { kind: "user", userId: b.userId } },
      g.userId,
      () => run("update users set status = 'suspended' where id = ?", b.userId),
    );
    expect(r.status).toBe(409);
    expect(
      (
        await one<{ n: number }>(
          "select count(*) n from artifacts where space_id = ?",
          b.userId,
        )
      )?.n,
    ).toBe(0);
  });
});
