import { env } from "cloudflare:workers";
import { type Member, newId, R, ShareSchema } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let editor: U;
let member: U;
let guest: U;

async function mk(prefix: string, role: Member["role"]): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}
const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      { title: "t", format: "markdown", content: "hello", ...extra } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const put = (id: string, u: U | null, email: string, role: string) =>
  api(app, R.shares(id), u?.cookie ?? null, {
    method: "PUT",
    body: { email, role },
  });
const del = (id: string, u: U, email: string) =>
  api(app, R.share(id, email), u.cookie, { method: "DELETE" });

beforeAll(async () => {
  owner = await mk("sh-owner", "member");
  editor = await mk("sh-editor", "member");
  member = await mk("sh-member", "member");
  guest = await mk("sh-guest", "guest");
});

describe("shares", () => {
  it("viewer share lets a guest read; an editor share stays view-only (parity 2); delete revokes at once", async () => {
    const id = await pub();
    expect((await api(app, R.artifact(id), guest.cookie)).status).toBe(404);
    const r = await put(id, owner, guest.email, "viewer");
    expect(r.status).toBe(200);
    const s = ShareSchema.parse(await r.json());
    expect(s).toMatchObject({ email: guest.email, role: "viewer" });
    expect((await api(app, R.artifact(id), guest.cookie)).status).toBe(200);
    const body = { title: "t2", format: "markdown", content: "x" };
    const denied = await api(app, R.versions(id), guest.cookie, {
      method: "POST",
      body,
    });
    expect(denied.status).toBe(404);
    // upgrade (upsert)
    const up = await put(id, owner, guest.email, "editor");
    expect(up.status).toBe(200);
    const list = (await (
      await api(app, R.shares(id), owner.cookie)
    ).json()) as unknown[];
    expect(list).toHaveLength(1);
    const pr = await api(app, R.versions(id), guest.cookie, {
      method: "POST",
      body,
    });
    // Guests are view-only on every install: the editor row reads as viewer.
    expect(pr.status).toBe(404);
    // revoke
    expect((await del(id, owner, guest.email)).status).toBe(204);
    expect((await api(app, R.artifact(id), guest.cookie)).status).toBe(404);
    expect((await api(app, R.versions(id), guest.cookie)).status).toBe(404);
    expect(
      (await api(app, R.versionFile(id, 1, "README.md"), guest.cookie)).status,
    ).toBe(404);
    expect((await del(id, owner, guest.email)).status).toBe(404);
  });

  it("non-owners (incl. editor) get 404 on list/put/delete", async () => {
    const id = await pub();
    await put(id, owner, editor.email, "editor");
    // The guest lost their last share above (deactivated, which ended their
    // sessions: P2 T2 checks session_epoch). Their old cookie stays dead.
    await put(await pub(), owner, guest.email, "viewer");
    expect((await api(app, R.artifacts, guest.cookie)).status).toBe(401);
    // A new sign-in (the real Access callback path is covered in oidc.test.ts)
    // mints a fresh cookie at the reactivated epoch.
    const epoch = await env.DB.prepare(
      "select session_epoch e from users where id = ?",
    )
      .bind(guest.userId)
      .first<{ e: number }>();
    guest.cookie = `${sessionCookieName(env)}=${await signSession(env, guest.userId, Date.now(), { provider: "access", epoch: epoch?.e ?? 0 })}`;
    for (const u of [editor, member, guest]) {
      expect((await api(app, R.shares(id), u.cookie)).status).toBe(404);
      expect((await put(id, u, "z@x.com", "viewer")).status).toBe(404);
      expect((await del(id, u, editor.email)).status).toBe(404);
    }
    expect((await put(id, null, "z@x.com", "viewer")).status).toBe(401);
    expect((await api(app, R.shares(id), owner.cookie)).status).toBe(200);
  });

  it("is case-insensitive on email, in body and path", async () => {
    const id = await pub();
    const e = `Bob-${tag}@X.com`;
    await put(id, owner, e, "viewer");
    await put(id, owner, e.toLowerCase(), "editor");
    const list = (await (
      await api(app, R.shares(id), owner.cookie)
    ).json()) as { email: string; role: string }[];
    expect(list).toEqual([
      expect.objectContaining({ email: e.toLowerCase(), role: "editor" }),
    ]);
    expect((await del(id, owner, e.toUpperCase())).status).toBe(204);
  });

  it("400 for owner's own email, bad email, extra keys, bad role", async () => {
    const id = await pub();
    expect(
      (await put(id, owner, owner.email.toUpperCase(), "viewer")).status,
    ).toBe(400);
    expect((await put(id, owner, "nope", "viewer")).status).toBe(400);
    expect((await put(id, owner, "é@x.com", "viewer")).status).toBe(400);
    expect((await put(id, owner, "a@x.com", "owner")).status).toBe(400);
    const r = await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: "a@x.com", role: "viewer", extra: 1 },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("bad_request");
  });

  it("allows sharing with an existing member; share never downgrades", async () => {
    const id = await pub({ visibility: "team" });
    expect((await put(id, owner, member.email, "viewer")).status).toBe(200);
    expect((await api(app, R.artifact(id), member.cookie)).status).toBe(200);
    await put(id, owner, member.email, "editor");
    const pr = await api(app, R.versions(id), member.cookie, {
      method: "POST",
      body: { title: "t", format: "markdown", content: "y" },
    });
    expect(pr.status).toBe(201);
  });

  it("caps at 200 shares", async () => {
    const id = await pub();
    const now = Date.now();
    const stmts = Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare(
        "insert into shares (artifact_id,email,role,created_by,created_at) values (?,?,?,?,?)",
      ).bind(id, `cap${i}-${tag}@x.com`, "viewer", owner.userId, now + i),
    );
    await env.DB.batch(stmts);
    expect((await put(id, owner, `new-${tag}@x.com`, "viewer")).status).toBe(
      400,
    );
    // upsert of an existing share still OK at the cap
    expect((await put(id, owner, `cap0-${tag}@x.com`, "editor")).status).toBe(
      200,
    );
    expect((await del(id, owner, `cap1-${tag}@x.com`)).status).toBe(204);
    expect((await put(id, owner, `new-${tag}@x.com`, "viewer")).status).toBe(
      200,
    );
  });

  it("404 for unknown/deleted artifact and malformed id", async () => {
    expect((await api(app, R.shares(newId()), owner.cookie)).status).toBe(404);
    expect((await api(app, R.shares("bad"), owner.cookie)).status).toBe(404);
  });
});
