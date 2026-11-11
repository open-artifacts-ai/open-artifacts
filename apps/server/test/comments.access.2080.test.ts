import { env } from "cloudflare:workers";
import {
  ANON_ID_HEADER,
  type CommentList,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

// #2080: who can comment. Signed-out visitors read but never write where
// only signed-in people may.

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let guest: U;

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
        content: "<p>The quick brown fox</p>",
        visibility: "public",
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

let ipSeq = 0;
const call = (
  id: string,
  who: U | null,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) =>
  api(app, `${R.comments(id)}${path}`, who?.cookie ?? null, {
    method: init.method,
    body: init.body,
    headers: {
      ...(who
        ? {}
        : { "cf-connecting-ip": `198.51.100.${(++ipSeq % 250) + 1}` }),
      ...init.headers,
    },
  });
const NOTE = { kind: "note" };
const post = (id: string, who: U | null, body = "hello") =>
  call(id, who, "", { method: "POST", body: { anchor: NOTE, body } });
const art = async (id: string, who: U | null = owner) =>
  (await (await api(app, R.artifact(id), who?.cookie ?? null)).json()) as {
    comments: boolean;
    commenters?: string;
    can?: { comment: boolean };
  };
const patch = (id: string, comments: unknown) =>
  api(app, R.artifact(id), owner.cookie, {
    method: "PATCH",
    body: { comments },
  });

const SIGN_IN = {
  code: "comments_signed_in_only",
  message: "Sign in to comment.",
};
async function expectRefused(r: Response) {
  expect(r.status).toBe(403);
  expect(await errOf(r)).toMatchObject(SIGN_IN);
}

beforeAll(async () => {
  owner = await mk("a-owner");
  guest = await mk("a-member");
});

describe("default and storage", () => {
  it("new artifacts default to signed-in; the column default keeps migrated rows at everyone", async () => {
    const id = await pub();
    expect(await art(id)).toMatchObject({
      comments: true,
      commenters: "signed-in",
    });
    const cols = await env.DB.prepare("pragma table_info(artifacts)").all<{
      name: string;
      dflt_value: string;
    }>();
    expect(
      cols.results.find((c) => c.name === "comment_access")?.dflt_value,
    ).toBe("'everyone'");
  });

  it("publish with a string sets both fields; true keeps the commenters", async () => {
    expect(await art(await pub({ comments: "everyone" }))).toMatchObject({
      comments: true,
      commenters: "everyone",
    });
    expect(await art(await pub({ comments: "off" }))).toMatchObject({
      comments: false,
    });
    expect(await art(await pub({ comments: true }))).toMatchObject({
      comments: true,
      commenters: "signed-in",
    });
  });

  it("patch: strings set both, false turns off and true keeps the commenters", async () => {
    const id = await pub();
    expect((await patch(id, "everyone")).status).toBe(200);
    expect(await art(id)).toMatchObject({
      comments: true,
      commenters: "everyone",
    });
    expect((await patch(id, false)).status).toBe(200);
    expect(await art(id)).toMatchObject({
      comments: false,
      commenters: "everyone",
    });
    expect((await patch(id, true)).status).toBe(200);
    expect(await art(id)).toMatchObject({
      comments: true,
      commenters: "everyone",
    });
    expect((await patch(id, "signed-in")).status).toBe(200);
    expect(await art(id)).toMatchObject({
      comments: true,
      commenters: "signed-in",
    });
    expect((await patch(id, "off")).status).toBe(200);
    expect(await art(id)).toMatchObject({
      comments: false,
      commenters: "signed-in",
    });
    expect((await patch(id, "nobody")).status).toBe(400);
  });
});

describe("signed-in only", () => {
  it("the artifact DTO says a signed-out viewer cannot comment; a member can", async () => {
    const id = await pub();
    expect((await art(id, null)).can?.comment).toBe(false);
    expect((await art(id, guest)).can?.comment).toBe(true);
    const open = await pub({ comments: "everyone" });
    expect((await art(open, null)).can).toBeUndefined();
  });

  it("refuses a signed-out write on every route with comments_signed_in_only; reads stay open", async () => {
    const id = await pub();
    const t = (await (await post(id, owner, "root")).json()) as Thread;
    const cid = t.comments[0]?.id as string;
    const anon = { [ANON_ID_HEADER]: "bogus" };
    for (const h of [{}, anon]) {
      await expectRefused(
        await call(id, null, "", {
          method: "POST",
          headers: h,
          body: { anchor: NOTE, body: "x" },
        }),
      );
      await expectRefused(
        await call(id, null, `/${t.id}/replies`, {
          method: "POST",
          headers: h,
          body: { body: "x" },
        }),
      );
      await expectRefused(
        await call(id, null, `/${t.id}`, {
          method: "PATCH",
          headers: h,
          body: { status: "resolved" },
        }),
      );
      await expectRefused(
        await call(id, null, `/${t.id}/comments/${cid}`, {
          method: "PATCH",
          headers: h,
          body: { body: "y" },
        }),
      );
      await expectRefused(
        await call(id, null, `/${t.id}/comments/${cid}`, {
          method: "DELETE",
          headers: h,
        }),
      );
      await expectRefused(
        await call(id, null, `/${t.id}/comments/${cid}/answer`, {
          method: "POST",
          headers: h,
          body: { choice: "a" },
        }),
      );
    }
    const r = await call(id, null, "");
    expect(r.status).toBe(200);
    expect(((await r.json()) as CommentList).threads).toHaveLength(1);
  });

  it("a signed-in member who is not the owner can still comment", async () => {
    const id = await pub();
    expect((await post(id, guest)).status).toBe(201);
    expect((await post(id, owner)).status).toBe(201);
  });

  it("an anon commenter from before the switch loses edit and delete, in the list and on the routes", async () => {
    const id = await pub({ comments: "everyone" });
    const r = await post(id, null, "mine");
    expect(r.status).toBe(201);
    const h = { [ANON_ID_HEADER]: r.headers.get(ANON_ID_HEADER) as string };
    const t = (await r.json()) as Thread;
    const cid = t.comments[0]?.id as string;
    const mine = async () =>
      ((await (await call(id, null, "", { headers: h })).json()) as CommentList)
        .threads[0]?.comments[0]?.can;
    expect(await mine()).toEqual({ edit: true, delete: true });
    await patch(id, "signed-in");
    expect(await mine()).toEqual({ edit: false, delete: false });
    await expectRefused(
      await call(id, null, `/${t.id}/comments/${cid}`, {
        method: "PATCH",
        headers: h,
        body: { body: "y" },
      }),
    );
    await expectRefused(
      await call(id, null, `/${t.id}/comments/${cid}`, {
        method: "DELETE",
        headers: h,
      }),
    );
  });

  it("everyone: a signed-out visitor posts; off: comments_off", async () => {
    const open = await pub({ comments: "everyone" });
    expect((await post(open, null)).status).toBe(201);
    const off = await pub({ comments: "off" });
    expect((await post(off, owner)).status).toBe(403);
    expect(await errOf(await post(off, null))).toMatchObject({
      code: "comments_off",
    });
  });

  it("flipping the setting takes effect at once", async () => {
    const id = await pub({ comments: "everyone" });
    expect((await post(id, null)).status).toBe(201);
    await patch(id, "signed-in");
    await expectRefused(await post(id, null));
    await patch(id, "everyone");
    expect((await post(id, null)).status).toBe(201);
  });
});
