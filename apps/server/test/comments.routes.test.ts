import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ANON_ID_HEADER,
  type Comment,
  type CommentList,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { issueAnonToken } from "../src/runtime/anon-id.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login, runIndex } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let editor: U;
let viewer: U;
let other: U;
let stranger: U;

async function mk(prefix: string, role: Member["role"] = "member"): Promise<U> {
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
      {
        title: "doc",
        format: "html",
        content: "<p>The quick brown fox jumps over the lazy dog</p>",
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const share = (id: string, u: U, role: "viewer" | "editor") =>
  api(app, R.shares(id), owner.cookie, {
    method: "PUT",
    body: { email: u.email, role },
  });

let ipSeq = 0;
const uniqueIp = () =>
  `198.51.${Math.floor(Math.random() * 256)}.${(++ipSeq % 254) + 1}`;

const call = (
  id: string,
  who: U | null,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
) =>
  api(app, `${R.comments(id)}${path}`, who?.cookie ?? null, {
    method: init.method,
    body: init.body,
    headers: {
      ...(who || init.ip === ""
        ? {}
        : { "cf-connecting-ip": init.ip ?? uniqueIp() }),
      ...init.headers,
    },
  });

const NOTE = { kind: "note" };
const post = async (
  id: string,
  who: U | null,
  body = "hello",
  anchor: unknown = NOTE,
  extra = {},
) => call(id, who, "", { method: "POST", body: { anchor, body, ...extra } });
const thread = async (r: Response) => (await r.json()) as Thread;
const list = async (id: string, who: U | null, q = "", headers = {}) =>
  (await (await call(id, who, q, { headers })).json()) as CommentList;

const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );

beforeAll(async () => {
  owner = await mk("c-owner");
  editor = await mk("c-editor");
  viewer = await mk("c-viewer");
  other = await mk("c-other");
  stranger = await mk("c-stranger");
});

describe("threads", () => {
  it("creates a note thread: 201, author without an email, can", async () => {
    const id = await pub({ visibility: "team" });
    const r = await post(id, viewer, "  first  ");
    expect(r.status).toBe(201);
    const t = await thread(r);
    expect(t).toMatchObject({
      anchor: NOTE,
      version: 1,
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    });
    const c = t.comments[0] as Comment;
    expect(c).toMatchObject({
      body: "first",
      editedAt: null,
      author: { kind: "user", id: viewer.userId, me: true },
      can: { edit: true, delete: true },
    });
    expect(JSON.stringify(t)).not.toContain("@");
  });

  it("GET filters by status, counts open, and reports me and can per viewer", async () => {
    const id = await pub({ visibility: "team" });
    const a = await thread(await post(id, viewer, "a"));
    await post(id, viewer, "b");
    await call(id, viewer, `/${a.id}`, {
      method: "PATCH",
      body: { status: "resolved" },
    });
    expect((await list(id, viewer)).open).toBe(1);
    const open = await list(id, owner, "?status=open");
    expect(open.threads).toHaveLength(1);
    const resolved = await list(id, owner, "?status=resolved");
    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0]?.resolvedBy).toMatchObject({
      id: viewer.userId,
      me: false,
    });
    expect(resolved.open).toBe(1);
    // The owner moderates, so can.delete on another's comment; edit stays the author's.
    expect(resolved.threads[0]?.comments[0]?.can).toEqual({
      edit: false,
      delete: true,
    });
    const all = await list(id, other);
    expect(all.truncated).toBe(false);
    expect(all.threads).toHaveLength(2);
    expect(all.threads[0]?.comments[0]?.can).toEqual({
      edit: false,
      delete: false,
    });
    expect((await call(id, owner, "?status=bogus")).status).toBe(400);
  });

  it("orders by newest activity: a reply moves its thread first", async () => {
    const id = await pub({ visibility: "team" });
    const a = await thread(await post(id, viewer, "a"));
    await post(id, viewer, "b");
    await call(id, viewer, `/${a.id}/replies`, {
      method: "POST",
      body: { body: "r" },
    });
    expect((await list(id, viewer)).threads[0]?.id).toBe(a.id);
  });

  it("a text anchor is verified against the html version", async () => {
    const id = await pub({ visibility: "team" });
    const ok = await post(id, viewer, "x", {
      kind: "text",
      exact: "brown fox",
      prefix: "WRONG",
      suffix: "WRONG",
    });
    expect(ok.status).toBe(201);
    const t = await thread(ok);
    expect(t.anchor).toMatchObject({
      version: 1,
      prefix: "The quick ",
      suffix: " jumps over the lazy dog",
    });
    const miss = await post(id, viewer, "x", {
      kind: "text",
      exact: "purple cat",
      prefix: "",
      suffix: "",
    });
    expect(miss.status).toBe(422);
    expect((await errOf(miss)).code).toBe("anchor_not_in_version");
    const v9 = await post(id, viewer, "x", {
      kind: "text",
      version: 9,
      exact: "brown",
      prefix: "",
      suffix: "",
    });
    expect(v9.status).toBe(422);
  });

  it("anchor and body errors", async () => {
    const id = await pub({ visibility: "team" });
    const bad = await post(id, viewer, "x", { kind: "text" });
    expect(bad.status).toBe(400);
    expect((await errOf(bad)).code).toBe("invalid_anchor");
    const pin = await post(id, viewer, "x", {
      kind: "pin",
      x: 0.1,
      y: 0.1,
      contentHash: "no spaces",
    });
    expect((await errOf(pin)).code).toBe("invalid_anchor");
    for (const body of ["   ", "x".repeat(2001)]) {
      const r = await post(id, viewer, body);
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("invalid_body");
    }
    expect((await post(id, viewer, "x".repeat(2000))).status).toBe(201);
    expect(
      (await call(id, viewer, "", { method: "POST", body: { body: "x" } }))
        .status,
    ).toBe(400);
  });

  it("replies do not reopen; resolve and reopen; reply to a missing thread is 404", async () => {
    const id = await pub({ visibility: "team" });
    const t = await thread(await post(id, viewer));
    const res = await call(id, other, `/${t.id}`, {
      method: "PATCH",
      body: { status: "resolved" },
    });
    expect(res.status).toBe(200);
    expect(await thread(res)).toMatchObject({
      status: "resolved",
      resolvedBy: { id: other.userId },
    });
    const rep = await call(id, viewer, `/${t.id}/replies`, {
      method: "POST",
      body: { body: "later" },
    });
    expect(rep.status).toBe(201);
    expect(((await rep.json()) as Comment).body).toBe("later");
    expect((await list(id, viewer)).threads[0]?.status).toBe("resolved");
    const re = await call(id, viewer, `/${t.id}`, {
      method: "PATCH",
      body: { status: "open" },
    });
    expect(await thread(re)).toMatchObject({
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    });
    const gone = await call(id, viewer, `/${newId()}/replies`, {
      method: "POST",
      body: { body: "x" },
    });
    expect(gone.status).toBe(404);
    expect(
      (
        await call(id, viewer, "/bad/replies", {
          method: "POST",
          body: { body: "x" },
        })
      ).status,
    ).toBe(400);
  });

  it("the 201st reply is 409; reads cap replies at 200", async () => {
    const id = await pub({ visibility: "team" });
    const t = await thread(await post(id, viewer));
    await inDo(id, (i) => {
      for (let n = 0; n < 200; n++)
        i.commentsReply({
          threadId: t.id,
          actor: { kind: "user", ref: viewer.userId },
          rate: `u:r${n}`,
          body: `r${n}`,
        });
    });
    const over = await call(id, viewer, `/${t.id}/replies`, {
      method: "POST",
      body: { body: "x" },
    });
    expect(over.status).toBe(409);
    expect((await list(id, viewer)).threads[0]?.comments).toHaveLength(201);
  });
});

describe("edit and delete", () => {
  it("only the author edits, and editedAt is set", async () => {
    const id = await pub({ visibility: "team" });
    const t = await thread(await post(id, viewer, "mine"));
    const cid = (t.comments[0] as Comment).id;
    const path = `/${t.id}/comments/${cid}`;
    const no = await call(id, other, path, {
      method: "PATCH",
      body: { body: "hax" },
    });
    expect(no.status).toBe(403);
    expect((await errOf(no)).code).toBe("forbidden");
    const own = await call(owner.cookie ? id : id, owner, path, {
      method: "PATCH",
      body: { body: "hax" },
    });
    expect(own.status).toBe(403);
    const ok = await call(id, viewer, path, {
      method: "PATCH",
      body: { body: " better " },
    });
    expect(ok.status).toBe(200);
    const c = (await ok.json()) as Comment;
    expect(c.body).toBe("better");
    expect(c.editedAt).not.toBeNull();
    expect(
      (await call(id, viewer, path, { method: "PATCH", body: { body: " " } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(id, viewer, `/${t.id}/comments/${newId()}`, {
          method: "PATCH",
          body: { body: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("delete: author; owner, manager-level and editors on any; others 403", async () => {
    const id = await pub({ visibility: "team" });
    await share(id, editor, "editor");
    const mkThread = async () => thread(await post(id, viewer, "x"));
    const del = (t: Thread, who: U) =>
      call(id, who, `/${t.id}/comments/${(t.comments[0] as Comment).id}`, {
        method: "DELETE",
      });
    let t = await mkThread();
    expect((await del(t, other)).status).toBe(403);
    expect((await del(t, viewer)).status).toBe(204);
    t = await mkThread();
    expect((await del(t, editor)).status).toBe(204);
    t = await mkThread();
    expect((await del(t, owner)).status).toBe(204);
    expect((await list(id, owner)).threads).toHaveLength(0);
    expect((await del(t, owner)).status).toBe(404);
  });

  it("deleting a reply keeps the thread; deleting the root removes it and its replies", async () => {
    const id = await pub({ visibility: "team" });
    const t = await thread(await post(id, viewer, "root"));
    const rep = (await (
      await call(id, other, `/${t.id}/replies`, {
        method: "POST",
        body: { body: "re" },
      })
    ).json()) as Comment;
    expect(
      (
        await call(id, other, `/${t.id}/comments/${rep.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await list(id, viewer)).threads[0]?.comments).toHaveLength(1);
    await call(id, other, `/${t.id}/replies`, {
      method: "POST",
      body: { body: "again" },
    });
    const root = (t.comments[0] as Comment).id;
    expect(
      (
        await call(id, viewer, `/${t.id}/comments/${root}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await list(id, viewer)).threads).toHaveLength(0);
    const rows = await inDo(id, (i) =>
      (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        .exec(
          "select (select count(*) from comments) c, (select count(*) from comment_threads) t",
        )
        .one(),
    );
    expect(rows).toEqual({ c: 0, t: 0 });
  });
});

describe("who can", () => {
  it("a stranger and a signed-out caller on a private artifact get 404, never 403", async () => {
    const id = await pub();
    for (const who of [stranger, null]) {
      expect((await call(id, who, "")).status).toBe(404);
      expect((await post(id, who)).status).toBe(404);
    }
  });

  it("a shared viewer reads and comments", async () => {
    const id = await pub();
    await share(id, viewer, "viewer");
    expect((await post(id, viewer)).status).toBe(201);
    expect((await call(id, viewer, "")).status).toBe(200);
  });

  it("a signed-out caller on a team artifact is 404; on any public one they read and comment, even when anonymous data writes are off", async () => {
    const team = await pub({ visibility: "team" });
    expect((await call(team, null, "")).status).toBe(404);
    expect((await post(team, null)).status).toBe(404);
    const pubEd = await pub({ visibility: "public", dataWriters: "editors" });
    expect((await call(pubEd, null, "")).status).toBe(200);
    expect((await post(pubEd, null)).status).toBe(201);
    // No `can` for a signed-out viewer: the shell derives it from `comments`.
    const art = (await (await api(app, R.artifact(pubEd), null)).json()) as {
      comments: boolean;
      can?: unknown;
    };
    expect(art).toMatchObject({ comments: true });
    expect(art.can).toBeUndefined();
  });

  it("comments off: 403 comments_off on every route; owner and manager toggle it, editors cannot", async () => {
    const id = await pub({ visibility: "team" });
    await share(id, editor, "editor");
    const t = await thread(await post(id, viewer));
    const s = (u: U, comments: boolean) =>
      api(app, R.artifact(id), u.cookie, {
        method: "PATCH",
        body: { comments },
      });
    expect((await s(editor, false)).status).toBe(400);
    expect((await s(viewer, false)).status).toBeGreaterThanOrEqual(400);
    const off = await s(owner, false);
    expect(off.status).toBe(200);
    expect(((await off.json()) as { comments: boolean }).comments).toBe(false);
    const got = (await (
      await api(app, R.artifact(id), viewer.cookie)
    ).json()) as {
      comments: boolean;
      can?: { comment: boolean };
    };
    expect(got.comments).toBe(false);
    expect(got.can?.comment).toBe(false);
    for (const r of [
      await call(id, viewer, ""),
      await post(id, viewer),
      await call(id, viewer, `/${t.id}`, {
        method: "PATCH",
        body: { status: "resolved" },
      }),
      await call(id, viewer, `/${t.id}/replies`, {
        method: "POST",
        body: { body: "x" },
      }),
    ]) {
      expect(r.status).toBe(403);
      expect((await errOf(r)).code).toBe("comments_off");
    }
    await s(owner, true);
    const on = (await (
      await api(app, R.artifact(id), viewer.cookie)
    ).json()) as {
      comments: boolean;
      can?: { comment: boolean };
    };
    expect(on).toMatchObject({ comments: true, can: { comment: true } });
    expect((await call(id, viewer, "")).status).toBe(200);
  });

  it("every summary carries comments: true by default, false when off, signed out or in", async () => {
    const id = await pub({ visibility: "public" });
    const get = async (who: U | null) =>
      (await (await api(app, R.artifact(id), who?.cookie ?? null)).json()) as {
        comments?: boolean;
      };
    expect((await get(null)).comments).toBe(true);
    expect((await get(viewer)).comments).toBe(true);
    await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { comments: false },
    });
    expect((await get(null)).comments).toBe(false);
    expect((await get(viewer)).comments).toBe(false);
    const list = (await (await api(app, R.artifacts, owner.cookie)).json()) as {
      items: { id: string; comments?: boolean }[];
    };
    expect(list.items.find((a) => a.id === id)?.comments).toBe(false);
  });

  it("comments is on every response that returns an artifact summary", async () => {
    const id = await pub({ visibility: "private", title: "zebracomments" });
    await runIndex(id);
    type Row = { id: string; comments?: boolean };
    const rows = async (path: string): Promise<Row[]> =>
      ((await (await api(app, path, owner.cookie)).json()) as { items: Row[] })
        .items;
    const seen = async (want: boolean) => {
      expect(
        ((await (await api(app, R.artifact(id), owner.cookie)).json()) as Row)
          .comments,
      ).toBe(want);
      for (const path of [R.artifacts, `${R.search}?q=zebracomments`]) {
        const hit = (await rows(path)).find((a) => a.id === id);
        expect(hit, path).toBeDefined();
        expect(hit?.comments, path).toBe(want);
      }
    };
    await seen(true);
    // The PATCH result, for a settings save and for a title edit.
    const off = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { comments: false },
    });
    expect(((await off.json()) as Row).comments).toBe(false);
    const title = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { title: "zebracomments two" },
    });
    expect(((await title.json()) as Row).comments).toBe(false);
    await seen(false);
    // Trash.
    await api(app, R.artifact(id), owner.cookie, { method: "DELETE" });
    const trashed = (await rows(R.trash)).find((a) => a.id === id);
    expect(trashed?.comments).toBe(false);
    // Restore, still off.
    const back = await api(app, R.restoreDeleted(id), owner.cookie, {
      method: "POST",
    });
    expect(((await back.json()) as Row).comments).toBe(false);
  });

  it("comments: false at publish creates the artifact with comments off", async () => {
    const id = await pub({ comments: false });
    expect((await call(id, owner, "")).status).toBe(403);
  });

  it("embed requests get 403 on every comment route, even for a public artifact", async () => {
    const id = await pub({ visibility: "public" });
    const h = { "x-oa-embed": "1" };
    expect((await call(id, null, "", { headers: h })).status).toBe(403);
    expect((await call(id, null, "?embed=1")).status).toBe(403);
    const w = await call(id, null, "", {
      method: "POST",
      body: { anchor: NOTE, body: "x" },
      headers: h,
    });
    expect(w.status).toBe(403);
    expect((await errOf(w)).code).toBe("forbidden");
    // A signed-in cookie with the embed header is anonymous: still 403 here.
    expect((await call(id, owner, "", { headers: h })).status).toBe(403);
  });
});

describe("guests", () => {
  const ip = "203.0.113.50";
  it("comment under a name, edit and delete their own by the anon id, see me", async () => {
    const id = await pub({ visibility: "public" });
    const r = await call(id, null, "", {
      method: "POST",
      ip,
      body: { anchor: NOTE, body: "hi", guestName: "  Ada\u0000  Lovelace " },
    });
    expect(r.status).toBe(201);
    const token = r.headers.get(ANON_ID_HEADER);
    expect(token).toBeTruthy();
    const t = await thread(r);
    const c = t.comments[0] as Comment;
    expect(c.author).toEqual({ kind: "guest", name: "Ada Lovelace", me: true });
    expect(c.can).toEqual({ edit: true, delete: true });
    const h = { [ANON_ID_HEADER]: token as string };
    expect(
      (await list(id, null, "", h)).threads[0]?.comments[0]?.author.me,
    ).toBe(true);
    expect((await list(id, null, "")).threads[0]?.comments[0]?.author.me).toBe(
      false,
    );
    const path = `/${t.id}/comments/${c.id}`;
    expect(
      (await call(id, null, path, { method: "PATCH", body: { body: "x" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(id, null, path, {
          method: "PATCH",
          body: { body: "edited" },
          headers: h,
        })
      ).status,
    ).toBe(200);
    expect((await call(id, null, path, { method: "DELETE" })).status).toBe(403);
    expect(
      (await call(id, null, path, { method: "DELETE", headers: h })).status,
    ).toBe(204);
  });

  it("a blank guest name is Guest; 50 characters pass, 51 are a 400", async () => {
    const id = await pub({ visibility: "public" });
    const a = await thread(
      await call(id, null, "", {
        method: "POST",
        body: { anchor: NOTE, body: "a", guestName: "   " },
      }),
    );
    expect(a.comments[0]?.author.name).toBe("Guest");
    const b = await thread(
      await call(id, null, "", {
        method: "POST",
        body: { anchor: NOTE, body: "b", guestName: "n".repeat(50) },
      }),
    );
    expect(b.comments[0]?.author.name).toBe("n".repeat(50));
    const long = await call(id, null, "", {
      method: "POST",
      body: { anchor: NOTE, body: "b", guestName: "n".repeat(51) },
    });
    expect(long.status).toBe(400);
  });

  it("GET never mints a token; a valid one only sets me", async () => {
    const id = await pub({ visibility: "public" });
    const r = await call(id, null, "");
    expect(r.status).toBe(200);
    expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
  });

  it("a guest resolves with no token as Guest (me false), with one as themselves; never minted", async () => {
    const id = await pub({ visibility: "public" });
    const t = await thread(await post(id, owner));
    const none = await call(id, null, `/${t.id}`, {
      method: "PATCH",
      body: { status: "resolved" },
    });
    expect(none.status).toBe(200);
    expect(none.headers.get(ANON_ID_HEADER)).toBeNull();
    expect((await thread(none)).resolvedBy).toEqual({
      kind: "guest",
      name: "Guest",
      me: false,
    });
    const mine = await call(id, null, "", {
      method: "POST",
      body: { anchor: NOTE, body: "hi" },
    });
    const token = mine.headers.get(ANON_ID_HEADER) as string;
    const r = await call(id, null, `/${t.id}`, {
      method: "PATCH",
      body: { status: "open" },
      headers: { [ANON_ID_HEADER]: token },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
    const again = await call(id, null, `/${t.id}`, {
      method: "PATCH",
      body: { status: "resolved" },
      headers: { [ANON_ID_HEADER]: token },
    });
    expect((await thread(again)).resolvedBy).toMatchObject({ me: true });
  });

  it("guest status changes count against the 10 a minute per IP, not the daily comment cap", async () => {
    const id = await pub({ visibility: "public" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    const t = await thread(await post(id, owner));
    const ip = uniqueIp();
    const flip = (status: string) =>
      call(id, null, `/${t.id}`, { method: "PATCH", ip, body: { status } });
    for (let n = 0; n < 10; n++)
      expect((await flip(n % 2 ? "open" : "resolved")).status).toBe(200);
    const r = await flip("open");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    const day = await inDo(id, (i) =>
      (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        .exec<{ n: number }>("select n from comment_limits")
        .one(),
    );
    expect(day.n).toBe(1);
  });
});

describe("rate limits", () => {
  it("10 a minute per signed-out IP, with Retry-After; a new IP is fine", async () => {
    const id = await pub({ visibility: "public" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    const ip = uniqueIp();
    for (let n = 0; n < 10; n++)
      expect(
        (
          await call(id, null, "", {
            method: "POST",
            ip,
            body: { anchor: NOTE, body: `c${n}` },
          })
        ).status,
      ).toBe(201);
    const r = await call(id, null, "", {
      method: "POST",
      ip,
      body: { anchor: NOTE, body: "x" },
    });
    expect(r.status).toBe(429);
    expect((await errOf(r)).code).toBe("rate_limited");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(
      (
        await call(id, null, "", {
          method: "POST",
          ip: uniqueIp(),
          body: { anchor: NOTE, body: "x" },
        })
      ).status,
    ).toBe(201);
    // The next minute opens again.
    await inDo(id, (i) => {
      i.now = () => 1_800_000_060_000;
    });
    expect(
      (
        await call(id, null, "", {
          method: "POST",
          ip,
          body: { anchor: NOTE, body: "x" },
        })
      ).status,
    ).toBe(201);
  });

  it("a token-holding guest's edits, status changes and deletes share the 10 a minute per IP", async () => {
    const id = await pub({ visibility: "public" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    const ip = uniqueIp();
    const first = await call(id, null, "", {
      method: "POST",
      ip,
      body: { anchor: NOTE, body: "mine" },
    });
    const t = await thread(first);
    const h = { [ANON_ID_HEADER]: first.headers.get(ANON_ID_HEADER) as string };
    const path = `/${t.id}/comments/${(t.comments[0] as Comment).id}`;
    for (let n = 0; n < 9; n++)
      expect(
        (
          await call(id, null, path, {
            method: "PATCH",
            ip,
            headers: h,
            body: { body: `e${n}` },
          })
        ).status,
      ).toBe(200);
    const status = await call(id, null, `/${t.id}`, {
      method: "PATCH",
      ip,
      headers: h,
      body: { status: "resolved" },
    });
    expect(status.status).toBe(429);
    expect(Number(status.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(
      (await call(id, null, path, { method: "DELETE", ip, headers: h })).status,
    ).toBe(429);
    // Another address is unaffected.
    expect(
      (
        await call(id, null, path, {
          method: "DELETE",
          ip: uniqueIp(),
          headers: h,
        })
      ).status,
    ).toBe(204);
  });

  it("30 a minute per person, replies included; a refused comment is not stored", async () => {
    const id = await pub({ visibility: "team" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    const t = await thread(await post(id, viewer));
    for (let n = 0; n < 29; n++)
      expect(
        (
          await call(id, viewer, `/${t.id}/replies`, {
            method: "POST",
            body: { body: `r${n}` },
          })
        ).status,
      ).toBe(201);
    const r = await call(id, viewer, `/${t.id}/replies`, {
      method: "POST",
      body: { body: "x" },
    });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await list(id, viewer)).threads[0]?.comments).toHaveLength(30);
    expect(
      (
        await call(id, other, `/${t.id}/replies`, {
          method: "POST",
          body: { body: "x" },
        })
      ).status,
    ).toBe(201);
  });

  it("1,000 a day per artifact", async () => {
    const id = await pub({ visibility: "team" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    await post(id, viewer);
    await inDo(id, (i) => {
      (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "update comment_limits set n = 999",
      );
    });
    expect((await post(id, other)).status).toBe(201);
    const r = await post(id, owner);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("storage and live signal", () => {
  it("comments stay outside the data budget and out of page data", async () => {
    const id = await pub({ visibility: "team", capabilities: { db: true } });
    const before = await inDo(id, (i) => i.totalBytes());
    await post(id, viewer, "x".repeat(1500));
    expect(await inDo(id, (i) => i.totalBytes())).toBe(before);
    for (const col of ["comments", "comment_threads"]) {
      const r = await api(app, R.dataCollection(id, col), owner.cookie);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { items: unknown[] }).items).toEqual([]);
    }
  });

  it("they go with a soft delete and come back on undelete", async () => {
    const id = await pub({ visibility: "team" });
    await post(id, viewer, "keep me");
    expect(
      (await api(app, R.artifact(id), owner.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect((await call(id, owner, "")).status).toBe(404);
    expect(
      (await api(app, R.restoreDeleted(id), owner.cookie, { method: "POST" }))
        .status,
    ).toBe(200);
    expect((await list(id, owner)).threads[0]?.comments[0]?.body).toBe(
      "keep me",
    );
  });

  it("every change sends {type:comments, open} to events sockets, nothing else", async () => {
    const id = await pub({ visibility: "team" });
    const sent: string[] = [];
    await inDo(id, (i) => {
      const ctx = (
        i as unknown as { ctx: { getWebSockets: (t?: string) => unknown[] } }
      ).ctx;
      ctx.getWebSockets = (t?: string) =>
        t === "~ev" ? [{ send: (m: string) => void sent.push(m) }] : [];
    });
    const t = await thread(await post(id, viewer, "secret text"));
    await call(id, viewer, `/${t.id}/replies`, {
      method: "POST",
      body: { body: "more secret" },
    });
    await call(id, viewer, `/${t.id}`, {
      method: "PATCH",
      body: { status: "resolved" },
    });
    await call(
      id,
      viewer,
      `/${t.id}/comments/${(t.comments[0] as Comment).id}`,
      { method: "DELETE" },
    );
    expect(sent.map((m) => JSON.parse(m))).toEqual([
      { type: "comments", open: 1 },
      { type: "comments", open: 1 },
      { type: "comments", open: 0 },
      { type: "comments", open: 0 },
    ]);
    expect(sent.join("")).not.toMatch(/secret|id|name/);
  });
});

describe("agents", () => {
  it("shows a private token label only to its owner", async () => {
    const id = await pub({ visibility: "team" });
    await inDo(id, (i) => {
      i.commentsAdd({
        actor: {
          kind: "user",
          ref: viewer.userId,
          agent: { name: "my secret bot", via: "t:abc" },
        },
        rate: "u:x",
        anchor: NOTE as never,
        version: 1,
        body: "from agent",
      });
      i.commentsAdd({
        actor: {
          kind: "user",
          ref: viewer.userId,
          agent: { name: "Claude Code", via: "g:xyz" },
        },
        rate: "u:y",
        anchor: NOTE as never,
        version: 1,
        body: "from grant",
      });
    });
    const agents = async (who: U) =>
      Object.fromEntries(
        (await list(id, who)).threads.map((t) => [
          t.comments[0]?.body,
          t.comments[0]?.author.agent,
        ]),
      );
    expect(await agents(viewer)).toEqual({
      "from agent": "my secret bot",
      "from grant": "Claude Code",
    });
    const seen = await agents(other);
    expect(seen["from grant"]).toBe("Claude Code");
    expect(seen["from agent"]).toMatch(/'s agent$/);
    expect(JSON.stringify(seen)).not.toContain("secret bot");
  });
});

describe("review fixes (#682)", () => {
  const sqlOf = (i: ArtifactRuntime) =>
    (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql;

  it("an html text anchor drops block; a pin on html is invalid_anchor", async () => {
    const id = await pub({ visibility: "team" });
    const r = await post(id, viewer, "x", {
      kind: "text",
      exact: "brown fox",
      prefix: "",
      suffix: "",
      block: { path: "evil/free text" },
    });
    expect(r.status).toBe(201);
    const t = await thread(r);
    expect(t.anchor).not.toHaveProperty("block");
    expect((await list(id, viewer)).threads[0]?.anchor).not.toHaveProperty(
      "block",
    );
    const pin = await post(id, viewer, "x", {
      kind: "pin",
      x: 0.5,
      y: 0.5,
      contentHash: "abc",
    });
    expect(pin.status).toBe(400);
    expect((await errOf(pin)).code).toBe("invalid_anchor");
  });

  it("the body limit counts UTF-16 units after trim, on REST and in bodyOk", async () => {
    const id = await pub({ visibility: "team" });
    // 1,000 emoji are 2,000 units: allowed; one more is 2,002: refused.
    expect((await post(id, viewer, "😀".repeat(1000))).status).toBe(201);
    const over = await post(id, viewer, "😀".repeat(1001));
    expect(over.status).toBe(400);
    expect((await errOf(over)).code).toBe("invalid_body");
    const { bodyOk } = await import("../src/runtime/comments-store.js");
    expect(bodyOk("😀".repeat(1000))).toBe(true);
    expect(bodyOk("😀".repeat(1001))).toBe(false);
    expect(bodyOk(` ${"x".repeat(2000)} `)).toBe(true);
  });

  it("a markdown text anchor keeps its block hint", async () => {
    const id = await pub({
      visibility: "team",
      format: "markdown",
      content: "# Hi\n\nsome text",
    });
    const t = await thread(
      await post(id, viewer, "x", {
        kind: "text",
        exact: "some",
        prefix: "",
        suffix: "",
        block: { line: 3 },
      }),
    );
    expect(t.anchor).toMatchObject({ block: { line: 3 } });
  });

  it("the limit is taken before the quote is verified: refused quotes count (10 a minute per IP)", async () => {
    const id = await pub({ visibility: "public" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    const ip = uniqueIp();
    const miss = () =>
      call(id, null, "", {
        method: "POST",
        ip,
        body: {
          anchor: {
            kind: "text",
            exact: "no such text",
            prefix: "",
            suffix: "",
          },
          body: "x",
        },
      });
    for (let n = 0; n < 10; n++) expect((await miss()).status).toBe(422);
    expect((await miss()).status).toBe(429);
  });

  it("signed-in status changes count against 30 a minute; a no-op neither broadcasts nor changes", async () => {
    const id = await pub({ visibility: "team" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    const t = await thread(await post(id, viewer));
    const sent: string[] = [];
    await inDo(id, (i) => {
      const ctx = (
        i as unknown as { ctx: { getWebSockets: (t?: string) => unknown[] } }
      ).ctx;
      ctx.getWebSockets = (tag?: string) =>
        tag === "~ev" ? [{ send: (m: string) => void sent.push(m) }] : [];
    });
    const set = (status: string) =>
      call(id, viewer, `/${t.id}`, { method: "PATCH", body: { status } });
    // Already open: nothing changes, nothing is sent.
    expect((await set("open")).status).toBe(200);
    expect(sent).toHaveLength(0);
    for (let n = 0; n < 28; n++)
      expect((await set(n % 2 ? "open" : "resolved")).status).toBe(200);
    expect((await set("open")).status).toBe(429);
  });

  it("an expired but valid guest token still names its author (read, edit, delete, status); a forged one does not", async () => {
    const id = await pub({ visibility: "public" });
    const ip = uniqueIp();
    const old = await issueAnonToken(
      env,
      `${"b".repeat(21)}A`,
      Math.floor(Date.now() / 1000) - 31 * 24 * 3600,
    );
    const h = { [ANON_ID_HEADER]: old };
    const mine = await call(id, null, "", {
      method: "POST",
      ip,
      headers: h,
      body: { anchor: NOTE, body: "old timer" },
    });
    expect(mine.status).toBe(201);
    const t = await thread(mine);
    const path = `/${t.id}/comments/${(t.comments[0] as Comment).id}`;
    const seen = await list(id, null, "", h);
    expect(seen.threads[0]?.comments[0]?.author.me).toBe(true);
    const edit = await call(id, null, path, {
      method: "PATCH",
      ip,
      headers: h,
      body: { body: "still mine" },
    });
    expect(edit.status).toBe(200);
    expect(edit.headers.get(ANON_ID_HEADER)).toBeNull();
    const res = await call(id, null, `/${t.id}`, {
      method: "PATCH",
      ip,
      headers: h,
      body: { status: "resolved" },
    });
    expect((await thread(res)).resolvedBy).toMatchObject({ me: true });
    const forged = { [ANON_ID_HEADER]: `${old.slice(0, -2)}AA` };
    expect(
      (
        await call(id, null, path, {
          method: "PATCH",
          ip,
          headers: forged,
          body: { body: "x" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(id, null, path, { method: "DELETE", ip, headers: h })).status,
    ).toBe(204);
  });

  it("a guest token from artifact A is not the author on artifact B", async () => {
    const a = await pub({ visibility: "public" });
    const b = await pub({ visibility: "public" });
    const first = await call(a, null, "", {
      method: "POST",
      body: { anchor: NOTE, body: "a" },
    });
    const tokenA = first.headers.get(ANON_ID_HEADER) as string;
    const onB = await thread(
      await call(b, null, "", {
        method: "POST",
        body: { anchor: NOTE, body: "b" },
      }),
    );
    const path = `/${onB.id}/comments/${(onB.comments[0] as Comment).id}`;
    const edit = await call(b, null, path, {
      method: "PATCH",
      headers: { [ANON_ID_HEADER]: tokenA },
      body: { body: "stolen" },
    });
    expect(edit.status).toBe(403);
    const del = await call(b, null, path, {
      method: "DELETE",
      headers: { [ANON_ID_HEADER]: tokenA },
    });
    expect(del.status).toBe(403);
  });

  it("a signed-out write with no cf-connecting-ip is refused", async () => {
    const id = await pub({ visibility: "public" });
    const r = await call(id, null, "", {
      method: "POST",
      ip: "",
      body: { anchor: NOTE, body: "x" },
    });
    expect(r.status).toBe(429);
    expect((await errOf(r)).code).toBe("rate_limited");
  });

  it("addresses in one IPv6 /64 share the guest limit", async () => {
    const id = await pub({ visibility: "public" });
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    const net = `2001:db8:${(++ipSeq).toString(16)}:2`;
    for (let n = 0; n < 10; n++)
      expect(
        (
          await call(id, null, "", {
            method: "POST",
            ip: `${net}::${n + 1}`,
            body: { anchor: NOTE, body: "x" },
          })
        ).status,
      ).toBe(201);
    expect(
      (
        await call(id, null, "", {
          method: "POST",
          ip: `${net}:ffff::9`,
          body: { anchor: NOTE, body: "x" },
        })
      ).status,
    ).toBe(429);
  });

  it("GET stops at 5,000 comments across threads and says truncated", async () => {
    const id = await pub({ visibility: "team" });
    await post(id, viewer, "seed");
    await inDo(id, (i) => {
      const sql = sqlOf(i);
      const actor = JSON.stringify({ kind: "user", ref: viewer.userId });
      for (let t = 0; t < 30; t++) {
        const tid = `T${t.toString().padStart(15, "0")}`;
        sql.exec(
          "insert into comment_threads (id, anchor, version, status, created_at, activity_at) values (?, '{\"kind\":\"note\"}', 1, 'open', ?, ?)",
          tid,
          "2026-01-01T00:00:00.000Z",
          `2027-01-01T00:00:${t.toString().padStart(2, "0")}.000Z`,
        );
        sql.exec(
          `insert into comments (id, thread_id, body, author, created_at)
           select ? || value, ?, 'b', ?, '2026-01-01T00:00:00.000Z' from json_each(?)`,
          `C${t}-`,
          tid,
          actor,
          JSON.stringify(Array.from({ length: 201 }, (_, k) => k)),
        );
      }
    });
    const out = await list(id, viewer);
    expect(out.truncated).toBe(true);
    const total = out.threads.reduce((n, t) => n + t.comments.length, 0);
    expect(total).toBeLessThanOrEqual(5000);
    expect(out.threads.length).toBe(24);
    // Newest activity first: the seeded real thread is oldest, so it is cut.
    expect(out.threads[0]?.id).toBe(`T${"29".padStart(15, "0")}`);
  });
});
