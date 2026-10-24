import { env } from "cloudflare:workers";
import {
  AUDIT_NEXT_CURSOR_HEADER,
  AUTH,
  type AuditEvent,
  type Member,
  newId,
  R,
  UploadCreatedSchema,
} from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { withCap } from "../src/auth/authz.js";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import {
  audit,
  auditFilters,
  EXPORT_PAGES,
  listAudit,
} from "../src/services/audit.js";
import { admit, resetIdentity } from "../src/services/identity.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";
import { api, login } from "./helpers.js";

// P3 Task 8: audit rows commit in the same batch as the change they record.
const app = createApp();

type AuditRow = {
  action: string;
  target_type: string;
  target_id: string;
  actor_kind: string;
  actor_id: string | null;
  space_id: string | null;
  detail: string;
};
const count = async (where = "1", ...b: unknown[]) =>
  (
    (await env.DB.prepare(`select count(*) n from audit_events where ${where}`)
      .bind(...b)
      .first<{ n: number }>()) as { n: number }
  ).n;
const rowsFor = async (targetId: string) =>
  (
    await env.DB.prepare(
      "select * from audit_events where target_id = ? order by at",
    )
      .bind(targetId)
      .all<AuditRow>()
  ).results;
const lastAudit = async (targetId: string) => (await rowsFor(targetId)).at(-1);

let owner: { cookie: string; userId: string };
let admin: { cookie: string; userId: string };
let member: { cookie: string; userId: string };
let guest: { cookie: string; userId: string };

beforeAll(async () => {
  owner = await login(uniq("owner"), "owner");
  admin = await login(uniq("admin"), "admin");
  member = await login(uniq("member"));
  guest = await login(uniq("guest", "out.com"), "guest");
});

async function publish(cookie: string, visibility?: string): Promise<string> {
  const r = await api(app, R.artifacts, cookie, {
    method: "POST",
    body: {
      title: "Audited",
      format: "markdown",
      content: "# hi",
      ...(visibility ? { visibility } : {}),
    },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
const share = (cookie: string, id: string, email: string, role = "viewer") =>
  api(app, R.shares(id), cookie, { method: "PUT", body: { email, role } });

/** A trigger that fails every audit insert (the atomicity tests). */
const FAIL =
  "create trigger if not exists audit_fail before insert on audit_events begin select raise(abort, 'audit down'); end";
const failAudit = () => env.DB.prepare(FAIL).run();
afterEach(async () => {
  await env.DB.prepare("drop trigger if exists audit_fail").run();
});

describe("audit()", () => {
  it("returns a statement for the caller's batch; reason and detail read back", async () => {
    const target = uniq("t");
    const s = audit(
      env,
      "user.status",
      { type: "user", id: target },
      { kind: "sync", id: null },
      { reason: "directory_suspend", detail: { status: "suspended" } },
    );
    expect(await count("target_id = ?", target)).toBe(0);
    await env.DB.batch([s]);
    const r = await lastAudit(target);
    expect(r).toMatchObject({ action: "user.status", actor_kind: "sync" });
    expect(JSON.parse(r?.detail ?? "")).toEqual({
      status: "suspended",
      reason: "directory_suspend",
    });
  });
});

describe("audit() guards", () => {
  it("throws when detail carries reason (pass extra.reason)", () => {
    expect(() =>
      audit(
        env,
        "user.status",
        { type: "user", id: "u" },
        { kind: "system", id: null },
        { detail: { reason: "admin_suspend" } },
      ),
    ).toThrow(/extra.reason/);
  });
});

describe("shares", () => {
  it("artifact.share writes one audit row in the share batch", async () => {
    const art = await publish(owner.cookie);
    const before = await count();
    expect((await share(owner.cookie, art, "x@y.com")).status).toBe(200);
    expect(await count()).toBe(before + 1);
    const r = await lastAudit(art);
    expect(r).toMatchObject({
      action: "artifact.share",
      target_type: "artifact",
      target_id: art,
      actor_kind: "user",
      actor_id: owner.userId,
      space_id: owner.userId,
    });
    // Never the grantee's address.
    expect(r?.detail).not.toContain("@");
    expect(JSON.parse(r?.detail ?? "")).toEqual({ role: "viewer" });
  });

  it("re-sharing at the same role writes no row; a role change writes one", async () => {
    const art = await publish(owner.cookie);
    expect((await share(owner.cookie, art, "same@y.com")).status).toBe(200);
    const again = await share(owner.cookie, art, "same@y.com");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      role: "viewer",
      emailed: false,
    });
    expect(await rowsFor(art)).toHaveLength(1);
    await share(owner.cookie, art, "same@y.com", "editor");
    const rows = await rowsFor(art);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]?.detail ?? "")).toEqual({ role: "editor" });
  });

  it("a share refused at the cap writes no audit row", async () => {
    const art = await publish(owner.cookie);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 200 }, (_, i) =>
        env.DB.prepare(
          "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
        ).bind(art, `cap${i}@y.com`, owner.userId, now),
      ),
    );
    expect((await share(owner.cookie, art, "over@y.com")).status).toBe(400);
    expect(await rowsFor(art)).toHaveLength(0);
  });

  it("artifact.unshare writes one row; a missing share writes none", async () => {
    const art = await publish(owner.cookie);
    await share(owner.cookie, art, "gone@y.com");
    const del = (e: string) =>
      api(app, R.share(art, e), owner.cookie, { method: "DELETE" });
    expect((await del("gone@y.com")).status).toBe(204);
    expect((await lastAudit(art))?.action).toBe("artifact.unshare");
    const n = (await rowsFor(art)).length;
    expect((await del("never@y.com")).status).toBe(404);
    expect(await rowsFor(art)).toHaveLength(n);
  });

  it("a failing audit insert rolls the share back", async () => {
    const art = await publish(owner.cookie);
    await failAudit();
    expect((await share(owner.cookie, art, "atomic@y.com")).status).toBe(500);
    const s = await env.DB.prepare(
      "select count(*) n from shares where artifact_id = ?",
    )
      .bind(art)
      .first<{ n: number }>();
    expect(s?.n).toBe(0);
  });

  it("a failing audit insert keeps the share on unshare", async () => {
    const art = await publish(owner.cookie);
    await share(owner.cookie, art, "kept@y.com");
    await failAudit();
    const r = await api(app, R.share(art, "kept@y.com"), owner.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(500);
    const s = await env.DB.prepare(
      "select count(*) n from shares where artifact_id = ?",
    )
      .bind(art)
      .first<{ n: number }>();
    expect(s?.n).toBe(1);
  });
});

describe("visibility", () => {
  const patch = (id: string, body: unknown) =>
    api(app, R.artifact(id), owner.cookie, { method: "PATCH", body });

  it("PATCH visibility writes artifact.visibility with from and to", async () => {
    const art = await publish(owner.cookie, "private");
    expect((await patch(art, { visibility: "team" })).status).toBe(200);
    const r = await lastAudit(art);
    expect(r).toMatchObject({
      action: "artifact.visibility",
      target_id: art,
      actor_id: owner.userId,
      space_id: owner.userId,
    });
    expect(JSON.parse(r?.detail ?? "")).toEqual({
      from: "private",
      to: "team",
    });
  });

  it("an unchanged visibility or a title edit writes no row", async () => {
    const art = await publish(owner.cookie, "team");
    await patch(art, { visibility: "team" });
    await patch(art, { title: "Renamed" });
    expect(await rowsFor(art)).toHaveLength(0);
  });

  it("a new version that changes visibility is audited", async () => {
    const art = await publish(owner.cookie, "private");
    const r = await api(app, R.versions(art), owner.cookie, {
      method: "POST",
      body: { format: "markdown", content: "# v2", visibility: "team" },
    });
    expect(r.status).toBe(201);
    expect(await lastAudit(art)).toMatchObject({
      action: "artifact.visibility",
    });
  });

  it("a publish whose uploads guard fails writes no visibility row", async () => {
    const art = await publish(owner.cookie, "private");
    const c = await api(app, R.uploads, owner.cookie, {
      method: "POST",
      body: { path: "a.txt", size: 3, artifactId: art },
    });
    expect(c.status).toBe(201);
    const up = UploadCreatedSchema.parse(await c.json());
    const u = new URL(up.url);
    const put = await app.fetch(
      new Request(`http://app.localhost${u.pathname}${u.search}`, {
        method: "PUT",
        body: "abc",
        headers: { "content-length": "3" },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(put.status).toBe(204);
    // A concurrent publish consumes the upload just before this batch runs.
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return async (ss: D1PreparedStatement[]) => {
            await t
              .prepare("update uploads set consumed = 1 where id = ?")
              .bind(up.uploadId)
              .run();
            return t.batch(ss);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const raced = { ...(env as object), DB } as typeof env;
    const A = {
      fetch: (r: Request, _e: unknown, x: never) => app.fetch(r, raced, x),
    };
    const r = await api(A as never, R.versions(art), owner.cookie, {
      method: "POST",
      body: {
        visibility: "team",
        entry: "index.html",
        files: { "index.html": "# v2", "a.txt": { uploadId: up.uploadId } },
      },
    });
    expect(r.status).toBe(409);
    expect(await rowsFor(art)).toHaveLength(0);
    const a = await env.DB.prepare(
      "select visibility v from artifacts where id = ?",
    )
      .bind(art)
      .first<{ v: string }>();
    expect(a?.v).toBe("private");
  });

  it("a failing audit insert rolls the visibility change back", async () => {
    const art = await publish(owner.cookie, "private");
    await failAudit();
    expect((await patch(art, { visibility: "team" })).status).toBe(500);
    const a = await env.DB.prepare(
      "select visibility v from artifacts where id = ?",
    )
      .bind(art)
      .first<{ v: string }>();
    expect(a?.v).toBe("private");
  });
});

describe("sign-in and identity", () => {
  it("sign-in is audited as auth.signin", async () => {
    const r = await admit(env, authConfig(direct()), {
      provider: "google",
      subject: `sub-${crypto.randomUUID()}`,
      email: uniq("signin"),
      name: "S",
      tenant: "a.com",
    });
    if (!r.ok) throw new Error(r.reason);
    const row = await lastAudit(r.user.id);
    expect(row).toMatchObject({
      action: "auth.signin",
      target_type: "user",
      actor_id: r.user.id,
    });
    expect(JSON.parse(row?.detail ?? "")).toEqual({
      provider: "google",
      tenant: "a.com",
    });
  });

  it("code sign-in is audited as auth.signin (provider code, no tenant for guests)", async () => {
    const email = uniq("codeguest", "x.com");
    const uid = await seedUser(email, "guest");
    const m = mailer();
    const e = { ...direct(), ...m.env } as Env;
    const post = async (path: string, body: unknown, cookie?: string) => {
      const waits: Promise<unknown>[] = [];
      const r = await app.fetch(
        new Request(`http://app.localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-oa-request": "1",
            "sec-fetch-site": "same-origin",
            "cf-connecting-ip": "198.51.100.78",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(body),
        }),
        e,
        {
          waitUntil: (p: Promise<unknown>) => waits.push(p),
          passThroughOnException() {},
        } as never,
      );
      await Promise.all(waits);
      return r;
    };
    const req = await post(AUTH.codeRequest, { email });
    const pending = req.headers
      .getSetCookie()
      .find((c) => c.startsWith("oa_code="))
      ?.split(";")[0];
    const v = await post(AUTH.codeVerify, { code: m.codeFor(email) }, pending);
    expect(v.status).toBe(200);
    const rows = (await rowsFor(uid)).filter((r) => r.action === "auth.signin");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? "")).toEqual({ provider: "code" });
    expect(rows[0]?.detail).not.toContain("@");
  });

  it("a failing audit insert fails the sign-in", async () => {
    await failAudit();
    await expect(
      admit(env, authConfig(direct()), {
        provider: "google",
        subject: `sub-${crypto.randomUUID()}`,
        email: uniq("signin"),
        name: "S",
        tenant: "a.com",
      }),
    ).rejects.toThrow();
  });

  it("identity.reset is audited in the reset batch", async () => {
    const uid = await seedUser(uniq("linked"), "member", {
      googleSub: `sub-${crypto.randomUUID()}`,
    });
    const actor = withCap({ id: admin.userId, role: "admin" } as Member, null);
    await resetIdentity(env, actor, uid);
    expect(await lastAudit(uid)).toMatchObject({
      action: "identity.reset",
      actor_id: admin.userId,
    });
  });

  it("the owner resetting an admin writes exactly one identity.reset row", async () => {
    const uid = await seedUser(uniq("linkedadmin"), "admin", {
      googleSub: `sub-${crypto.randomUUID()}`,
    });
    const actor = withCap({ id: owner.userId, role: "owner" } as Member, null);
    await resetIdentity(env, actor, uid);
    const rows = (await rowsFor(uid)).filter(
      (r) => r.action === "identity.reset",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: owner.userId });
  });

  it("a failing audit insert keeps the Google link", async () => {
    const uid = await seedUser(uniq("linked"), "member", {
      googleSub: `sub-${crypto.randomUUID()}`,
    });
    await failAudit();
    const actor = withCap({ id: admin.userId, role: "admin" } as Member, null);
    await expect(resetIdentity(env, actor, uid)).rejects.toThrow();
    const l = await env.DB.prepare(
      "select count(*) n from identities where user_id = ?",
    )
      .bind(uid)
      .first<{ n: number }>();
    expect(l?.n).toBe(1);
  });
});

describe("R.audit and R.auditExport", () => {
  it("member and guest get 404 on /audit", async () => {
    for (const who of [member, guest]) {
      expect((await api(app, R.audit, who.cookie)).status).toBe(404);
      expect((await api(app, R.auditExport, who.cookie)).status).toBe(404);
    }
    expect((await api(app, R.audit, null)).status).toBe(401);
    expect((await api(app, R.auditExport, null)).status).toBe(401);
  });

  it("a restricted (capped) admin gets 404 on /audit and /audit/export", async () => {
    const capped = await login(uniq("cappedadmin"), "admin");
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(capped.userId)
      .run();
    expect((await api(app, R.audit, capped.cookie)).status).toBe(404);
    expect((await api(app, R.auditExport, capped.cookie)).status).toBe(404);
    // The same admin uncapped reads it.
    await env.DB.prepare("update users set restricted_manual = 0 where id = ?")
      .bind(capped.userId)
      .run();
    expect((await api(app, R.audit, capped.cookie)).status).toBe(200);
  });

  it("owners and admins page newest first with a cursor", async () => {
    const tag = uniq("page");
    const base = Date.now() + 10_000_000;
    await env.DB.batch(
      [0, 1, 2].map((i) =>
        env.DB.prepare(
          "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail) values (?, ?, 'user', ?, 'space.create', 'space', ?, '{}')",
        ).bind(newId(), base + i, owner.userId, `${tag}-${i}`),
      ),
    );
    const p1 = await api(app, `${R.audit}?limit=2`, owner.cookie);
    expect(p1.status).toBe(200);
    const b1 = (await p1.json()) as { items: AuditEvent[]; nextCursor: string };
    expect(b1.items.map((e) => e.target.id)).toEqual([`${tag}-2`, `${tag}-1`]);
    expect(b1.items[0]).toMatchObject({
      action: "space.create",
      actor: { kind: "user", id: owner.userId },
      reason: null,
      detail: null,
    });
    expect(b1.items[0]?.actor.email).toContain("owner");
    const p2 = await api(
      app,
      `${R.audit}?limit=2&cursor=${b1.nextCursor}`,
      admin.cookie,
    );
    const b2 = (await p2.json()) as { items: AuditEvent[] };
    expect(b2.items[0]?.target.id).toBe(`${tag}-0`);
    expect(
      (await api(app, `${R.audit}?cursor=nope!`, admin.cookie)).status,
    ).toBe(400);
    expect((await api(app, `${R.audit}?limit=0`, admin.cookie)).status).toBe(
      400,
    );
  });

  it("export streams NDJSON with one line per event", async () => {
    const n = await count("actor_kind in ('user', 'sync', 'system')");
    const r = await api(app, R.auditExport, admin.cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await r.text()).split("\n").filter(Boolean);
    expect(lines.length).toBe(n);
    for (const l of lines) expect(JSON.parse(l)).toHaveProperty("action");
    expect(r.headers.get(AUDIT_NEXT_CURSOR_HEADER)).toBeNull();
  });

  it("export stops at 10 pages and the header continues it", async () => {
    const cap = EXPORT_PAGES * 500;
    // More than one request's worth, newest of all (future timestamps).
    await env.DB.prepare(
      `with recursive n(x) as (select 1 union all select x + 1 from n where x < ?1)
       insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail)
       select 'Exprt' || replace(printf('%011d', x), '0', 'z'), ?2 + x, 'system', null,
         'directory.sync', 'directory', 'exp-' || x, '{}' from n`,
    )
      .bind(cap + 120, Date.now() + 20_000_000)
      .run();
    const total = await count("actor_kind in ('user', 'sync', 'system')");
    const r1 = await api(app, R.auditExport, owner.cookie);
    const next = r1.headers.get(AUDIT_NEXT_CURSOR_HEADER);
    expect(next).toBeTruthy();
    const l1 = (await r1.text()).split("\n").filter(Boolean);
    expect(l1).toHaveLength(cap);
    const r2 = await api(app, `${R.auditExport}?cursor=${next}`, owner.cookie);
    expect(r2.headers.get(AUDIT_NEXT_CURSOR_HEADER)).toBeNull();
    const l2 = (await r2.text()).split("\n").filter(Boolean);
    expect(l1.length + l2.length).toBe(total);
    const ids = new Set(
      [...l1, ...l2].map((l) => (JSON.parse(l) as AuditEvent).id),
    );
    expect(ids.size).toBe(total);
    expect(
      (await api(app, `${R.auditExport}?cursor=nope!`, owner.cookie)).status,
    ).toBe(400);
  });
});

describe("audit cursors are opaque and bound", () => {
  const firstCursor = async (path = `${R.audit}?limit=1`) => {
    const r = await api(app, path, owner.cookie);
    expect(r.status).toBe(200);
    const c = ((await r.json()) as { nextCursor: string | null }).nextCursor;
    expect(c).toBeTruthy();
    return c as string;
  };
  const status = async (path: string) =>
    (await api(app, path, owner.cookie)).status;

  it("a cursor is not plain b64url JSON (it carries a MAC)", async () => {
    const c = await firstCursor();
    expect(c.split(".")).toHaveLength(2);
    expect(await status(`${R.audit}?limit=1&cursor=${c}`)).toBe(200);
  });

  it("a cursor from install A is rejected at install B", async () => {
    const page = await listAudit(env, undefined, 1);
    const c = page.nextCursor as string;
    const otherInstall = { ...(env as object), INSTALL_ID: "install-b" } as Env;
    await expect(listAudit(otherInstall, c, 1)).rejects.toMatchObject({
      code: "bad_request",
    });
    const otherSecret = {
      ...(env as object),
      SESSION_SECRET: "z".repeat(48),
    } as Env;
    await expect(listAudit(otherSecret, c, 1)).rejects.toMatchObject({
      code: "bad_request",
    });
    // The same install still accepts it.
    expect((await listAudit(env, c, 1)).items).toHaveLength(1);
  });

  it("a cursor binds known filters only, and is 400 on the other listing", async () => {
    const c = await firstCursor();
    expect(await status(`${R.auditExport}?cursor=${c}`)).toBe(400);
    // Unknown params (a cache-buster) are not filters: page 2 still works.
    expect(await status(`${R.audit}?limit=1&_=123&cursor=${c}`)).toBe(200);
    // Known filters bind in a canonical order; a change is a different scope.
    const keys = ["a", "b"];
    expect(
      auditFilters({ b: ["2"], a: ["1"], cursor: ["x"], limit: ["1"] }, keys),
    ).toBe(auditFilters({ a: ["1"], b: ["2"] }, keys));
    expect(auditFilters({ a: ["1"] }, keys)).not.toBe(
      auditFilters({ a: ["2"] }, keys),
    );
    expect(auditFilters({ _: ["123"], a: ["1"] }, keys)).toBe(
      auditFilters({ a: ["1"] }, keys),
    );
  });

  it("a tampered cursor is 400", async () => {
    const c = await firstCursor();
    const [body, sig] = c.split(".") as [string, string];
    const flip = (x: string) => (x[0] === "A" ? "B" : "A") + x.slice(1);
    expect(await status(`${R.audit}?cursor=${flip(body)}.${sig}`)).toBe(400);
    expect(await status(`${R.audit}?cursor=${body}.${flip(sig)}`)).toBe(400);
    expect(await status(`${R.audit}?cursor=${body}`)).toBe(400);
    // A plain b64url JSON position (the old format) is refused.
    const plain = btoa(JSON.stringify({ a: Date.now(), i: newId() }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await status(`${R.audit}?cursor=${plain}`)).toBe(400);
  });

  it("the paged round trip returns every row exactly once", async () => {
    const total = await count("actor_kind in ('user', 'sync', 'system')");
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await api(
        app,
        `${R.audit}?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
        admin.cookie,
      );
      expect(r.status).toBe(200);
      const b = (await r.json()) as {
        items: AuditEvent[];
        nextCursor: string | null;
      };
      ids.push(...b.items.map((e) => e.id));
      cursor = b.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
  });
});
