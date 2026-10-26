import { env } from "cloudflare:workers";
import { normalizeEmail } from "@oa/auth-core";
import {
  ArtifactPatchResultSchema,
  type ArtifactSummary,
  ArtifactSummarySchema,
  type Member,
  newId,
  PageSchema,
  PublishResultSchema,
  R,
  VersionInfoSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getDb } from "../src/db/client.js";
import { shares } from "../src/db/schema.js";
import { listQuery, publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const Page = PageSchema(ArtifactSummarySchema);
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let editor: U;
let guest: U;
let member: U;

async function mk(prefix: string, role: Member["role"] = "member"): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

async function share(id: string, email: string, role: "viewer" | "editor") {
  await getDb(env)
    .insert(shares)
    .values({
      artifactId: id,
      email: normalizeEmail(email) ?? email,
      role,
      createdBy: owner.userId,
      createdAt: Date.now(),
    });
}

const pub = (
  u: U,
  title: string,
  extra: Record<string, unknown> = {},
  content = "# hi",
) =>
  publish(
    env,
    u.member,
    { title, format: "markdown", content, ...extra } as never,
    null,
  );

const list = async (u: U | null, qs: string) => {
  const r = await api(app, `${R.artifacts}?${qs}`, u?.cookie ?? null);
  return r;
};
const items = async (u: U, qs: string) => {
  const r = await list(u, qs);
  expect(r.status).toBe(200);
  return Page.parse(await r.json());
};

beforeAll(async () => {
  owner = await mk("art-owner");
  editor = await mk("art-editor");
  guest = await mk("art-guest", "guest");
  member = await mk("art-member");
});

describe("list", () => {
  it("paginates 30 items as 25 + 5 with a keyset cursor", async () => {
    const pager = await mk("pager");
    for (let i = 0; i < 30; i++) await pub(pager, `p${i}`);
    const p1 = await items(pager, "scope=mine&limit=25");
    expect(p1.items).toHaveLength(25);
    expect(p1.nextCursor).toBeTypeOf("string");
    const p2 = await items(
      pager,
      `scope=mine&limit=25&cursor=${encodeURIComponent(p1.nextCursor ?? "")}`,
    );
    expect(p2.items).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();
    const ids = new Set([...p1.items, ...p2.items].map((a) => a.id));
    expect(ids.size).toBe(30);
    const all = [...p1.items, ...p2.items];
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1] as ArtifactSummary;
      const b = all[i] as ArtifactSummary;
      expect(
        a.updatedAt > b.updatedAt ||
          (a.updatedAt === b.updatedAt && a.id > b.id),
      ).toBe(true);
    }
  });

  it("rejects a malformed cursor, a bad updatedSince, and anonymous callers", async () => {
    for (const c of ["garbage!", btoa("{}"), btoa('{"u":"x","i":1}')]) {
      const r = await list(owner, `cursor=${encodeURIComponent(c)}`);
      expect(r.status).toBe(400);
    }
    expect((await list(owner, "updatedSince=yesterday")).status).toBe(400);
    expect((await list(null, "scope=all")).status).toBe(401);
  });

  it("a guest's scope=all lists only artifacts shared with them", async () => {
    const team = await pub(owner, "team one", { visibility: "team" });
    const pubA = await pub(owner, "public one", { visibility: "public" });
    const shared = await pub(owner, "shared one");
    await share(shared.id, guest.email, "viewer");
    const g = await items(guest, "scope=all");
    expect(g.items.map((a) => a.id)).toEqual([shared.id]);
    expect(g.items[0]?.access).toBe("viewer");
    const m = (await items(member, "scope=team")).items.map((a) => a.id);
    expect(m).toContain(team.id);
    expect(m).toContain(pubA.id);
    expect(m).not.toContain(shared.id);
  });

  it("honors format, q, owner, visibility, agent and updatedSince", async () => {
    const f = await mk("filters");
    const md = await pub(f, "Alpha 100% notes");
    const html = await publish(
      env,
      f.member,
      {
        title: "Beta page",
        format: "html",
        content: "<p>x</p>",
        description: "contains needle",
      } as never,
      { name: "agent-x", version: "1.0" },
    );
    const ids = async (qs: string) =>
      (await items(f, `scope=mine&${qs}`)).items.map((a) => a.id);
    expect(await ids("format=html")).toEqual([html.id]);
    expect(await ids("q=needle")).toEqual([html.id]);
    expect(await ids(`q=${encodeURIComponent("100%")}`)).toEqual([md.id]);
    // FTS: a q with no word characters is a 400.
    expect((await list(f, "scope=mine&q=%25")).status).toBe(400);
    expect(await ids("agent=agent-x")).toEqual([html.id]);
    expect(
      (await ids(`owner=${encodeURIComponent(f.email.toUpperCase())}`)).length,
    ).toBe(2);
    expect(await ids("owner=nobody%40x.com")).toEqual([]);
    expect(await ids("visibility=public")).toEqual([]);
    expect((await ids("updatedSince=2000-01-01T00:00:00Z")).length).toBe(2);
    expect(
      await ids(`updatedSince=${new Date(Date.now() + 60_000).toISOString()}`),
    ).toEqual([]);
    const s = (await items(f, "scope=mine&agent=agent-x")).items[0];
    expect(s?.lastAgent).toEqual({ name: "agent-x", version: "1.0" });
  });

  it("uses the live partial indexes for scope mine and team", async () => {
    const plan = async (scope: "mine" | "team") => {
      const q = listQuery(
        env,
        { kind: "user", user: owner.member },
        {
          scope,
          limit: 25,
          includeDeleted: false,
        },
      ).toSQL();
      const { results } = await env.DB.prepare(`explain query plan ${q.sql}`)
        .bind(...q.params)
        .all<{ detail: string }>();
      return results.map((r) => r.detail).join("\n");
    };
    expect(await plan("mine")).toMatch(/artifacts_owner_updated_live_idx/);
    expect(await plan("team")).toMatch(/artifacts_visibility_updated_live_idx/);
  });
});

describe("summary, patch, delete", () => {
  let id: string;
  beforeAll(async () => {
    id = (await pub(owner, "Doc")).id;
    await share(id, editor.email, "editor");
  });

  it("GET returns a schema-valid summary with the caller's access", async () => {
    const r = await api(app, R.artifact(id), owner.cookie);
    expect(r.status).toBe(200);
    const s = ArtifactSummarySchema.parse(await r.json());
    expect(s).toMatchObject({
      id,
      title: "Doc",
      access: "owner",
      owner: { id: owner.userId, email: owner.email },
      lastAgent: null,
      thumbnailUrl: null,
      deletedAt: null,
      currentVersion: 1,
      capabilities: { db: false, viewer: false, storage: false },
      allowAnonymousWrites: false,
    });
    const e = await api(app, R.artifact(id), editor.cookie);
    expect(ArtifactSummarySchema.parse(await e.json()).access).toBe("editor");
    expect((await api(app, R.artifact(id), member.cookie)).status).toBe(404);
    expect((await api(app, R.artifact(id), null)).status).toBe(404);
  });

  it("PATCH: unknown field → 400; editor may retitle but not change sharing", async () => {
    const bad = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { title: "x", bogus: 1 },
    });
    expect(bad.status).toBe(400);
    const ok = await api(app, R.artifact(id), editor.cookie, {
      method: "PATCH",
      body: { title: "Renamed", description: "d" },
    });
    expect(ok.status).toBe(200);
    expect(ArtifactSummarySchema.parse(await ok.json())).toMatchObject({
      title: "Renamed",
      description: "d",
    });
    const vis = await api(app, R.artifact(id), editor.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(vis.status).toBe(400);
    const own = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: {
        visibility: "team",
        capabilities: { db: true },
        allowAnonymousWrites: true,
      },
    });
    expect(ArtifactSummarySchema.parse(await own.json())).toMatchObject({
      visibility: "team",
      capabilities: { db: true, viewer: false, storage: false },
      allowAnonymousWrites: true,
    });
    const none = await api(app, R.artifact(id), member.cookie, {
      method: "PATCH",
      body: { title: "nope" },
    });
    expect(none.status).toBe(404);
  });

  // #681 C: the PATCH route shares set_visibility's service and its warning.
  it.each([
    ["public, db, anonymous writes off", "public", true, false, true],
    ["public, db, anonymous writes on", "public", true, true, false],
    ["public, no db", "public", false, false, false],
    ["private, db, anonymous writes off", "private", true, false, false],
  ] as const)("PATCH visibility warning: %s", async (_, visibility, db, allowAnonymousWrites, warns) => {
    const a = await publish(env, owner.member, {
      title: "warn",
      format: "html",
      content: "<p>x</p>",
      capabilities: { db, viewer: false, storage: false },
      allowAnonymousWrites,
    } as never);
    const r = await api(app, R.artifact(a.id), owner.cookie, {
      method: "PATCH",
      body: { visibility },
    });
    expect(r.status).toBe(200);
    const body = ArtifactPatchResultSchema.parse(await r.json());
    expect(body.visibility).toBe(visibility);
    if (warns) expect(body.warning).toMatch(/allowAnonymousWrites/);
    else expect(body.warning).toBeUndefined();
  });

  it("editor delete → 404; owner delete hides it; includeDeleted shows it; undelete restores", async () => {
    const del = (u: U) =>
      api(app, R.artifact(id), u.cookie, { method: "DELETE" });
    expect((await del(editor)).status).toBe(404);
    expect((await del(owner)).status).toBe(204);
    const ids = async (qs: string) =>
      (await items(owner, qs)).items.map((a) => a.id);
    expect(await ids("scope=mine")).not.toContain(id);
    const withDel = (await items(owner, "scope=mine&includeDeleted=true"))
      .items;
    const d = withDel.find((a) => a.id === id);
    expect(d?.deletedAt).toBeTypeOf("string");
    // editors never see deleted rows, even with includeDeleted
    expect(
      (await items(editor, "scope=all&includeDeleted=true")).items.map(
        (a) => a.id,
      ),
    ).not.toContain(id);
    expect((await api(app, R.artifact(id), owner.cookie)).status).toBe(404);
    expect(
      (await api(app, R.restoreDeleted(id), editor.cookie, { method: "POST" }))
        .status,
    ).toBe(404);
    const u = await api(app, R.restoreDeleted(id), owner.cookie, {
      method: "POST",
    });
    expect(u.status).toBe(200);
    expect(ArtifactSummarySchema.parse(await u.json()).deletedAt).toBeNull();
    expect(await ids("scope=mine")).toContain(id);
  });

  it("undelete after the 30-day window → 404", async () => {
    const old = await pub(owner, "old");
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now() - 31 * 86400_000, old.id)
      .run();
    const r = await api(app, R.restoreDeleted(old.id), owner.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(404);
  });

  it("soft delete removes the search row", async () => {
    const a = await pub(owner, "searchable");
    // Publish indexed it (B8).
    const before = await env.DB.prepare(
      "select count(*) n from artifact_search where rowid = (select rowid from artifacts where id = ?)",
    )
      .bind(a.id)
      .first<{ n: number }>();
    expect(before?.n).toBe(1);
    await api(app, R.artifact(a.id), owner.cookie, { method: "DELETE" });
    const row = await env.DB.prepare(
      "select count(*) n from artifact_search where artifact_id = ?",
    )
      .bind(a.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("thumbnail: 404 without one; served as webp with thumbnailUrl when set", async () => {
    const a = await pub(owner, "thumb");
    expect((await api(app, R.thumbnail(a.id), owner.cookie)).status).toBe(404);
    await env.FILES.put(`thumbs/${a.id}.webp`, new Uint8Array([1, 2, 3]));
    await env.DB.prepare("update artifacts set has_thumbnail = 1 where id = ?")
      .bind(a.id)
      .run();
    const s = ArtifactSummarySchema.parse(
      await (await api(app, R.artifact(a.id), owner.cookie)).json(),
    );
    expect(s.thumbnailUrl).toBe(`http://app.localhost${R.thumbnail(a.id)}`);
    const t = await api(app, R.thumbnail(a.id), owner.cookie);
    expect(t.status).toBe(200);
    expect(t.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await t.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect((await api(app, R.thumbnail(a.id), member.cookie)).status).toBe(404);
  });
});

describe("versions and restore", () => {
  it("restore v1 → v3 with v1's manifest; versions newest first; file readable", async () => {
    const v1 = await pub(owner, "R", {}, "first");
    await publish(
      env,
      owner.member,
      { id: v1.id, format: "markdown", content: "second" } as never,
      null,
    );
    const r = await api(app, R.restoreVersion(v1.id, 1), owner.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(201);
    const res = PublishResultSchema.parse(await r.json());
    expect(res.version).toBe(3);
    const m = await env.DB.prepare(
      "select version, manifest, message from versions where artifact_id = ? order by version",
    )
      .bind(v1.id)
      .all<{ version: number; manifest: string; message: string | null }>();
    expect(m.results[2]?.manifest).toBe(m.results[0]?.manifest);
    expect(m.results[2]?.message).toBe("Restored v1");

    const vr = await api(app, R.versions(v1.id), owner.cookie);
    const vs = VersionInfoSchema.array().parse(await vr.json());
    expect(vs.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(vs[0]?.files).toEqual([
      { path: "README.md", size: 5, contentType: expect.any(String) },
    ]);
    expect(vs[0]?.createdBy.id).toBe(owner.userId);

    const f = await api(
      app,
      R.versionFile(v1.id, 3, "README.md"),
      owner.cookie,
    );
    expect(f.status).toBe(200);
    expect(await f.text()).toBe("first");
    expect(f.headers.get("x-content-type-options")).toBe("nosniff");
    expect(f.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(f.headers.get("cache-control")).toBe("private, no-store");
    expect(f.headers.get("content-type")).toMatch(/markdown/);
    expect(
      (await api(app, R.versionFile(v1.id, 3, "nope.md"), owner.cookie)).status,
    ).toBe(404);
    expect(
      (await api(app, R.versionFile(v1.id, 9, "README.md"), owner.cookie))
        .status,
    ).toBe(404);
    expect(
      (await api(app, R.versionFile(v1.id, 1, "README.md"), member.cookie))
        .status,
    ).toBe(404);
    expect(
      (
        await api(app, R.restoreVersion(v1.id, 9), owner.cookie, {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect((await api(app, R.versions(v1.id), member.cookie)).status).toBe(404);
    expect((await errOf(await api(app, R.versions(v1.id), null))).code).toBe(
      "not_found",
    );
  });

  it("a viewer cannot restore (404)", async () => {
    const a = await pub(owner, "V");
    await share(a.id, member.email, "viewer");
    const r = await api(app, R.restoreVersion(a.id, 1), member.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(404);
  });
});
