import { env } from "cloudflare:workers";
import { type DataDoc, type Member, newId, R, type Share } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2590: a "commenter" share. A guest with "viewer" cannot comment; with
// "commenter" can comment and reply only; members keep today's rules.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string, role: "member" | "guest"): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}
let owner: U;
let guest: U;
let member: U;
beforeAll(async () => {
  owner = await mk("sc-owner", "member");
  guest = await mk("sc-guest", "guest");
  member = await mk("sc-member", "member");
});

async function page(extra: Record<string, unknown> = {}) {
  return (
    await publish(
      E,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>x</p>",
        comments: "everyone",
        capabilities: { db: true, viewer: true, storage: true },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
}
const share = (id: string, email: string, role?: string) =>
  api(app, R.shares(id), owner.cookie, {
    method: "PUT",
    body: { email, ...(role ? { role } : {}) },
  });
const comment = (id: string, u: U) =>
  api(app, R.comments(id), u.cookie, {
    method: "POST",
    body: { anchor: { kind: "note" }, body: "hi" },
  });
const replyTo = (id: string, tid: string, u: U) =>
  api(app, R.commentReplies(id, tid), u.cookie, {
    method: "POST",
    body: { body: "again" },
  });

describe("a commenter share", () => {
  it("is a valid role and is stored; a guest's default is commenter, anyone else's viewer", async () => {
    const id = await page();
    const a = (await (
      await share(id, guest.email, "commenter")
    ).json()) as Share;
    expect(a.role).toBe("commenter");
    const b = (await (await share(id, member.email)).json()) as Share;
    expect(b.role).toBe("viewer");
    const g2 = await mk("sc-guest2", "guest");
    const c = (await (await share(id, g2.email)).json()) as Share;
    expect(c.role).toBe("commenter");
  });

  it("a guest with a commenter share comments and replies", async () => {
    const id = await page();
    await share(id, guest.email, "commenter");
    const res = await comment(id, guest);
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: string };
    expect((await replyTo(id, t.id, guest)).status).toBe(201);
  });

  it("a guest with a commenter share still writes nothing else", async () => {
    const id = await page();
    await share(id, guest.email, "commenter");
    const t = (await (await comment(id, guest)).json()) as {
      id: string;
      comments: { id: string }[];
    };
    // Resolving a thread, a version, a share and live data stay refused.
    const patch = await api(app, `${R.comments(id)}/${t.id}`, guest.cookie, {
      method: "PATCH",
      body: { status: "resolved" },
    });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    expect((await share(id, member.email, "viewer")).status).toBe(200);
    const put = await api(app, R.shares(id), guest.cookie, {
      method: "PUT",
      body: { email: `x-${tag}@x.com`, role: "viewer" },
    });
    expect(put.status).toBeGreaterThanOrEqual(400);
  });

  it("a guest with a viewer share cannot comment or reply", async () => {
    const id = await page();
    await share(id, guest.email, "viewer");
    expect((await comment(id, guest)).status).toBe(404);
    const t = (await (await comment(id, owner)).json()) as { id: string };
    expect((await replyTo(id, t.id, guest)).status).toBe(404);
  });

  it("a guest with a stored editor share (an old row) is still read-only", async () => {
    const id = await page();
    await E.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'editor', ?, ?)",
    )
      .bind(id, guest.email, owner.userId, Date.now())
      .run();
    expect((await comment(id, guest)).status).toBe(404);
  });

  it("a guest without a share cannot comment on a public page either", async () => {
    const id = await page();
    expect((await comment(id, guest)).status).toBe(404);
  });

  it("members keep today's rules: a commenter share reads as viewer and comments", async () => {
    const id = await page();
    await share(id, member.email, "commenter");
    expect((await comment(id, member)).status).toBe(201);
    const list = await api(app, R.artifact(id), member.cookie);
    expect(list.status).toBe(200);
  });
});

describe("an outsider is never stored as editor", () => {
  it("an editor share to a guest is clamped to commenter and the response says so; a member's stays editor", async () => {
    const id = await page();
    const g = (await (await share(id, guest.email, "editor")).json()) as Share;
    expect(g.role).toBe("commenter");
    const m = (await (await share(id, member.email, "editor")).json()) as Share;
    expect(m.role).toBe("editor");
    const row = await E.DB.prepare(
      "select role from shares where artifact_id = ? and email = ?",
    )
      .bind(id, guest.email)
      .first<{ role: string }>();
    expect(row?.role).toBe("commenter");
  });
});

describe("a guest's live-data writes (#2590)", () => {
  const put = (id: string, u: U, doc = "d") =>
    api(app, R.dataDoc(id, "c", doc), u.cookie, {
      method: "PUT",
      body: { n: 1 },
    });

  it("a commenter writes where the page admits viewers, and the doc is marked outsider", async () => {
    const id = await page({
      dataWriters: "viewers",
      allowAnonymousWrites: true,
    });
    await share(id, guest.email, "commenter");
    const res = await put(id, guest);
    expect(res.status).toBe(200);
    const doc = (await (
      await api(app, R.dataDoc(id, "c", "d"), owner.cookie)
    ).json()) as DataDoc;
    expect(doc.updatedBy).toBe(`g:${guest.userId}`);
    expect(doc.outsider).toBe(true);
    // A member's write is not marked.
    await api(app, R.dataDoc(id, "c", "m"), member.cookie, {
      method: "PUT",
      body: 1,
    });
    await share(id, member.email, "viewer");
    const mine = (await (
      await api(app, R.dataDoc(id, "c", "m"), owner.cookie)
    ).json()) as DataDoc;
    expect(mine.outsider).toBeUndefined();
  });

  it("a commenter is refused where the page does not admit viewers", async () => {
    const id = await page({ dataWriters: "editors" });
    await share(id, guest.email, "commenter");
    expect((await put(id, guest)).status).toBeGreaterThanOrEqual(400);
  });

  it("a viewer is refused even where the page admits viewers", async () => {
    const id = await page({
      dataWriters: "viewers",
      allowAnonymousWrites: true,
    });
    await share(id, guest.email, "viewer");
    expect((await put(id, guest)).status).toBeGreaterThanOrEqual(400);
  });
});
