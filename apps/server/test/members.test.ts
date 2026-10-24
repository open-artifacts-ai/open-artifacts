import { env } from "cloudflare:workers";
import { MemberSchema, MeSchema, newId, R, SettingsSchema } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat, verifyPat } from "../src/auth/pat.js";
import { getDb } from "../src/db/client.js";
import { artifacts, shares, uploads, versions } from "../src/db/schema.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const call = (
  path: string,
  cookie: string | null,
  init: { method?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = { "x-oa-request": "1" };
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return app.fetch(
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    ctx,
  );
};
const errCode = async (r: Response) =>
  ((await r.json()) as { error: { code: string } }).error.code;

const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; userId: string };
let admin: { cookie: string; userId: string };
let member: { cookie: string; userId: string };
let guest: { cookie: string; userId: string };
let ownerOfRecord: string;

beforeAll(async () => {
  owner = await login(`owner-${tag}@x.com`, "owner");
  admin = await login(`admin-${tag}@x.com`, "admin");
  member = await login(`member-${tag}@x.com`, "member");
  guest = await login(`guest-${tag}@x.com`, "guest");
  const r = await env.DB.prepare(
    "select id from users where role = 'owner' order by created_at, id limit 1",
  ).first<{ id: string }>();
  ownerOfRecord = r?.id ?? "";
});

describe("GET /api/v1/me", () => {
  it("401 for anonymous", async () => {
    const r = await call(R.me, null);
    expect(r.status).toBe(401);
  });
  it("returns Me", async () => {
    const r = await call(R.me, member.cookie);
    expect(r.status).toBe(200);
    const me = MeSchema.parse(await r.json());
    expect(me.user.id).toBe(member.userId);
    expect(me.user.email).toBe(`member-${tag}@x.com`);
    expect(me.instance).toEqual({
      name: expect.any(String),
      defaultVisibility: expect.stringMatching(/^(private|team)$/),
      appUrl: "http://app.localhost",
      mcpUrl: "http://app.localhost/mcp",
      emailEnabled: false,
      plan: "free",
      update: null,
    });
  });
});

describe("members API", () => {
  it("member/guest calling GET /members → 404; anonymous → 401", async () => {
    expect((await call(R.members, member.cookie)).status).toBe(404);
    expect((await call(R.members, guest.cookie)).status).toBe(404);
    expect((await call(R.members, null)).status).toBe(401);
    const p = await call(R.members, member.cookie, {
      method: "POST",
      body: { email: "z@x.com", role: "member" },
    });
    expect(p.status).toBe(404);
  });

  it("admin and owner list members", async () => {
    for (const who of [admin, owner]) {
      const r = await call(R.members, who.cookie);
      expect(r.status).toBe(200);
      const list = MemberSchema.array().parse(await r.json());
      expect(list.map((m) => m.id)).toContain(member.userId);
    }
  });

  it("invite: creates the row, normalizes email, 409 on duplicate, 400 invalid", async () => {
    const r = await call(R.members, admin.cookie, {
      method: "POST",
      body: { email: `  New-${tag}@X.com `.trim(), role: "member" },
    });
    expect(r.status).toBe(201);
    const m = MemberSchema.parse(await r.json());
    expect(m.email).toBe(`new-${tag}@x.com`);
    expect(m.role).toBe("member");
    const dup = await call(R.members, admin.cookie, {
      method: "POST",
      body: { email: `NEW-${tag}@x.com`, role: "admin" },
    });
    expect(dup.status).toBe(409);
    expect(await errCode(dup)).toBe("conflict");
    for (const body of [
      { email: "not-an-email", role: "member" },
      { email: "a@x.com", role: "owner" },
      { email: "a@x.com", role: "guest" },
      { email: "a@x.com", role: "member", extra: 1 },
    ]) {
      const bad = await call(R.members, admin.cookie, {
        method: "POST",
        body,
      });
      expect(bad.status).toBe(400);
    }
    // Kelvin sign: passes z.email() style checks in some engines; normalizeEmail rejects.
    const k = await call(R.members, admin.cookie, {
      method: "POST",
      body: { email: "Kelvin@x.com", role: "member" },
    });
    expect(k.status).toBe(400);
  });

  it("patch role; owner cannot be demoted; admin cannot promote to owner", async () => {
    const t = await login(`p-${tag}@x.com`, "guest");
    const r = await call(R.member(t.userId), admin.cookie, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(r.status).toBe(200);
    expect(MemberSchema.parse(await r.json()).role).toBe("admin");
    const demote = await call(R.member(owner.userId), admin.cookie, {
      method: "PATCH",
      body: { role: "member" },
    });
    // An admin acting on the owner: owner_only (#475); the owner on
    // themselves keeps the 400.
    expect(demote.status).toBe(403);
    expect(await errCode(demote)).toBe("owner_only");
    const self = await call(R.member(owner.userId), owner.cookie, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(self.status).toBe(400);
    const promote = await call(R.member(t.userId), admin.cookie, {
      method: "PATCH",
      body: { role: "owner" },
    });
    expect(promote.status).toBe(400);
    const missing = await call(R.member(newId()), admin.cookie, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(missing.status).toBe(404);
    const byMember = await call(R.member(t.userId), member.cookie, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(byMember.status).toBe(404);
  });

  it("owner cannot be deleted", async () => {
    const r = await call(R.member(owner.userId), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(403);
    expect(await errCode(r)).toBe("owner_only");
    const self = await call(R.member(owner.userId), owner.cookie, {
      method: "DELETE",
    });
    expect(self.status).toBe(400);
    expect(
      (await call(R.member(newId()), admin.cookie, { method: "DELETE" }))
        .status,
    ).toBe(404);
  });

  it("delete reassigns artifacts to the owner, removes tokens, keeps shares", async () => {
    const v = await login(`del-${tag}@x.com`, "member");
    const db = getDb(env);
    const aid = newId();
    const now = Date.now();
    await db.insert(artifacts).values({
      id: aid,
      ownerId: v.userId,
      spaceId: v.userId,
      title: "t",
      format: "html",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(versions).values({
      artifactId: aid,
      version: 1,
      entry: "index.html",
      createdBy: v.userId,
      createdAt: now,
    });
    await db.insert(shares).values({
      artifactId: aid,
      email: `del-${tag}@x.com`,
      role: "viewer",
      createdBy: v.userId,
      createdAt: now,
    });
    await db.insert(uploads).values({
      id: newId(),
      artifactId: aid,
      userId: v.userId,
      r2Key: "k",
      size: 1,
      contentType: "text/plain",
      path: "a.txt",
      createdAt: now,
    });
    const { token } = await createPat(env, v.userId, "ci");

    const r = await call(R.member(v.userId), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);

    const a = await env.DB.prepare("select owner_id from artifacts where id=?")
      .bind(aid)
      .first<{ owner_id: string }>();
    expect(a?.owner_id).toBe(ownerOfRecord);
    expect(
      await env.DB.prepare("select id from users where id=?")
        .bind(v.userId)
        .first(),
    ).toBeNull();
    expect(await verifyPat(env, token)).toBeNull();
    const s = await env.DB.prepare(
      "select count(*) as n from shares where artifact_id=?",
    )
      .bind(aid)
      .first<{ n: number }>();
    expect(s?.n).toBe(1);
    // Their session/PAT now resolve to anonymous.
    expect((await call(R.me, v.cookie)).status).toBe(401);
  });
});

describe("settings", () => {
  it("GET: any member; guest 404; anonymous 401", async () => {
    const r = await call(R.settings, member.cookie);
    expect(r.status).toBe(200);
    SettingsSchema.parse(await r.json());
    expect((await call(R.settings, guest.cookie)).status).toBe(404);
    expect((await call(R.settings, null)).status).toBe(401);
  });

  it("PATCH: admin/owner only; upserts; reflected in /me", async () => {
    const no = await call(R.settings, member.cookie, {
      method: "PATCH",
      body: { name: "X" },
    });
    expect(no.status).toBe(404);
    const r = await call(R.settings, admin.cookie, {
      method: "PATCH",
      body: { name: "Acme", defaultVisibility: "team" },
    });
    expect(r.status).toBe(200);
    expect(SettingsSchema.parse(await r.json())).toEqual({
      name: "Acme",
      defaultVisibility: "team",
    });
    const r2 = await call(R.settings, owner.cookie, {
      method: "PATCH",
      body: { defaultVisibility: "private" },
    });
    expect(SettingsSchema.parse(await r2.json())).toEqual({
      name: "Acme",
      defaultVisibility: "private",
    });
    const me = MeSchema.parse(await (await call(R.me, member.cookie)).json());
    expect(me.instance.name).toBe("Acme");
    const trimmed = await call(R.settings, admin.cookie, {
      method: "PATCH",
      body: { name: "  Acme  " },
    });
    expect(trimmed.status).toBe(200);
    expect(SettingsSchema.parse(await trimmed.json()).name).toBe("Acme");
    for (const name of [
      "   ",
      "a\u0000b",
      "a\nb",
      "a\u007fb",
      "a\u0085b",
      "a\u202Eb",
      "a\u2066b",
      "a\u200Fb",
      "a\u061Cb",
    ]) {
      const bad = await call(R.settings, admin.cookie, {
        method: "PATCH",
        body: { name },
      });
      expect(bad.status, JSON.stringify(name)).toBe(400);
      expect(await errCode(bad)).toBe("bad_request");
    }
    for (const body of [
      { name: "" },
      { defaultVisibility: "public" },
      { other: 1 },
    ]) {
      const bad = await call(R.settings, admin.cookie, {
        method: "PATCH",
        body,
      });
      expect(bad.status).toBe(400);
    }
  });
});
