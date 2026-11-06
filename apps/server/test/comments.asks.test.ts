import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ArtifactAgent,
  type BusNotice,
  type Comment,
  type CommentList,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import {
  addReply,
  addThread,
  type CommentWho,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { deleteShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

// #1535: asks, mentions and assignments, server side.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  sent: { userId: string; notice: BusNotice }[] = [];
  outcome: DeliveryOutcome = "delivered";
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    this.sent.push({ userId, notice });
    return this.outcome;
  }
  clear() {
    this.sent = [];
    this.outcome = "delivered";
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => {
  installDelivery(prev);
});
beforeEach(() => bus.clear());

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string, role: Member["role"] = "member"): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

let owner: U;
let editor: U;
let viewer: U;
let stranger: U;
beforeAll(async () => {
  owner = await mk("a-owner");
  editor = await mk("a-editor");
  viewer = await mk("a-viewer");
  stranger = await mk("a-stranger");
});

const NOTE = { kind: "note" };
const OPTS = [
  { id: "wide", label: "Wide hero", detail: "Full bleed" },
  { id: "compact", label: "Compact hero" },
];

/** A team artifact with the editor and viewer shared in and two agents following. */
async function setup(extra: Record<string, unknown> = {}) {
  const a = await publish(
    E,
    owner.member,
    {
      title: "doc",
      format: "html",
      content: "<p>The quick brown fox</p>",
      ...extra,
    } as never,
    null,
    undefined,
    "create",
  );
  const id = a.id;
  for (const [u, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const)
    await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role },
    });
  await follow(E, owner.userId, { namespace: "ns-owner", name: "Claude" }, id);
  await follow(E, editor.userId, { namespace: "ns-editor", name: "Codex" }, id);
  const list = (await (
    await api(app, R.artifactAgents(id), owner.cookie)
  ).json()) as ArtifactAgent[];
  const key = (name: string) => {
    const k = list.find((x) => x.name.startsWith(name))?.key;
    if (!k) throw new Error(`no agent ${name}`);
    return k;
  };
  return { id, claude: key("Claude"), codex: key("Codex") };
}

const post = (id: string, u: U | null, body: object) =>
  api(app, R.comments(id), u?.cookie ?? null, {
    method: "POST",
    body: { anchor: NOTE, body: "hello", ...body },
    headers: u ? {} : { "cf-connecting-ip": "198.51.100.7" },
  });
const reply = (id: string, tid: string, u: U, body: object) =>
  api(app, R.commentReplies(id, tid), u.cookie, {
    method: "POST",
    body: { body: "again", ...body },
  });
const answer = (
  id: string,
  tid: string,
  cid: string,
  u: U | null,
  optionId: string,
) =>
  api(app, R.commentAnswer(id, tid, cid), u?.cookie ?? null, {
    method: "POST",
    body: { optionId },
    headers: u ? {} : { "cf-connecting-ip": "198.51.100.8" },
  });
const who = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });

/** An ask from the owner's agent to the viewer, through the service (MCP-only on the wire). */
async function ask(
  id: string,
  to: string[],
  extra: Record<string, unknown> = {},
) {
  const art = { id, format: "html", currentVersion: 1 } as never;
  return addThread(
    E,
    art,
    who(owner),
    view(owner),
    {
      anchor: NOTE,
      body: "Which layout?",
      ask: {
        question: "Which layout do we ship?",
        options: OPTS,
        recommended: { optionId: "compact", why: "Loads faster" },
        to: to.map((key) => ({ key })),
        ...extra,
      },
    },
    { moderator: true },
  );
}

describe("GET agents", () => {
  it("lists following agents for the owner and editors, none for viewers", async () => {
    const s = await setup();
    const asOwner = (await (
      await api(app, R.artifactAgents(s.id), owner.cookie)
    ).json()) as ArtifactAgent[];
    expect(asOwner.map((a) => a.name).sort()).toEqual([
      "Claude",
      expect.stringMatching(/^Codex \(/),
    ]);
    expect(asOwner.every((a) => a.online === false)).toBe(true);
    expect(JSON.stringify(asOwner)).not.toContain("@");
    expect(JSON.stringify(asOwner)).not.toContain("ns-");
    const asEditor = await api(app, R.artifactAgents(s.id), editor.cookie);
    expect(((await asEditor.json()) as unknown[]).length).toBe(2);
    const asViewer = await api(app, R.artifactAgents(s.id), viewer.cookie);
    expect(asViewer.status).toBe(200);
    expect(await asViewer.json()).toEqual([]);
    expect(
      (await api(app, R.artifactAgents(s.id), stranger.cookie)).status,
    ).toBe(404);
  });
});

describe("mentions and assignments", () => {
  it("delivers a mention and records the state; the notice carries no text of the comment", async () => {
    const s = await setup();
    const r = await post(s.id, editor, {
      body: "secret-body-text",
      mentions: [{ key: s.claude }],
    });
    expect(r.status).toBe(201);
    const t = (await r.json()) as Thread;
    expect(t.comments[0]?.mentions).toEqual([
      { key: s.claude, name: "Claude", delivery: "delivered" },
    ]);
    expect(bus.sent).toHaveLength(1);
    const n = bus.sent[0] as (typeof bus.sent)[number];
    expect(n.userId).toBe(owner.userId);
    expect(n.notice.kind).toBe("comment");
    expect(n.notice.to).toEqual({ namespace: "ns-owner", name: "Claude" });
    expect(n.notice.text).not.toContain("secret-body-text");
    expect(n.notice.text).toContain(n.notice.url);
    // And it persists.
    const l = (await (
      await api(app, R.comments(s.id), owner.cookie)
    ).json()) as CommentList;
    expect(l.threads[0]?.comments[0]?.mentions?.[0]?.delivery).toBe(
      "delivered",
    );
  });

  it("an offline machine is queued, an agent with no session is gone", async () => {
    const s = await setup();
    bus.outcome = "held";
    const a = (await (
      await post(s.id, owner, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    expect(a.comments[0]?.mentions?.[0]?.delivery).toBe("queued");
    bus.outcome = "dropped";
    const b = (await (
      await post(s.id, owner, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    expect(b.comments[0]?.mentions?.[0]?.delivery).toBe("gone");
  });

  it("assigns on a reply, and resolving the thread marks it done", async () => {
    const s = await setup();
    const t = (await (await post(s.id, owner, {})).json()) as Thread;
    const r = await reply(s.id, t.id, editor, { assign: { key: s.claude } });
    expect(r.status).toBe(201);
    const c = (await r.json()) as Comment;
    expect(c.assigned).toEqual({
      key: s.claude,
      name: "Claude",
      state: "delivered",
    });
    bus.outcome = "dropped";
    const r2 = await reply(s.id, t.id, editor, { assign: { key: s.codex } });
    expect(((await r2.json()) as Comment).assigned?.state).toBe("queued");
    await api(app, R.commentThread(s.id, t.id), owner.cookie, {
      method: "PATCH",
      body: { status: "resolved" },
    });
    const l = (await (
      await api(app, R.comments(s.id), owner.cookie)
    ).json()) as CommentList;
    const done = l.threads[0]?.comments.filter((x) => x.assigned) ?? [];
    expect(done.map((x) => x.assigned?.state)).toEqual(["done", "done"]);
  });

  it("is for the owner and editors: a viewer is 403 and nothing is written or sent", async () => {
    const s = await setup();
    const r = await post(s.id, viewer, { mentions: [{ key: s.claude }] });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("forbidden");
    const r2 = await post(s.id, viewer, { assign: { key: s.claude } });
    expect(r2.status).toBe(403);
    const t = (await (await post(s.id, viewer, {})).json()) as Thread;
    expect(
      (await reply(s.id, t.id, viewer, { mentions: [{ key: s.claude }] }))
        .status,
    ).toBe(403);
    expect(bus.sent).toHaveLength(0);
    const l = (await (
      await api(app, R.comments(s.id), owner.cookie)
    ).json()) as CommentList;
    expect(l.threads).toHaveLength(1);
  });

  it("a signed-out guest on a public artifact is 403", async () => {
    const s = await setup({ visibility: "public" });
    const r = await post(s.id, null, { mentions: [{ key: s.claude }] });
    expect(r.status).toBe(403);
    expect(bus.sent).toHaveLength(0);
  });

  it("refuses keys that are not following agents, and too many mentions", async () => {
    const s = await setup();
    for (const body of [
      { mentions: [{ key: "agent:nope" }] },
      { mentions: [{ key: viewer.userId }] },
      { assign: { key: "agent:nope" } },
    ])
      expect((await post(s.id, owner, body)).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}` }));
    expect((await post(s.id, owner, { mentions: many })).status).toBe(400);
    expect(bus.sent).toHaveLength(0);
  });

  it("loses an agent whose member lost access", async () => {
    const s = await setup();
    await deleteShare(E, owner.member, s.id, editor.email);
    const r = await post(s.id, owner, { mentions: [{ key: s.codex }] });
    expect(r.status).toBe(400);
  });
});

describe("asks", () => {
  it("stores an ask for the viewer and shows it with the recommendation", async () => {
    const s = await setup();
    const t = await ask(s.id, [viewer.userId]);
    const c = t.comments[0] as Comment;
    expect(c.ask).toMatchObject({
      question: "Which layout do we ship?",
      options: OPTS,
      recommended: { optionId: "compact", why: "Loads faster" },
      closed: false,
    });
    expect(c.ask?.to).toEqual([
      expect.objectContaining({ id: viewer.userId, me: false }),
    ]);
    const mine = (await (
      await api(app, R.comments(s.id), viewer.cookie)
    ).json()) as CommentList;
    expect(mine.threads[0]?.comments[0]?.ask?.to[0]?.me).toBe(true);
    expect(JSON.stringify(mine)).not.toContain("@");
  });

  it("only the people asked answer; the answer can change; resolving closes it", async () => {
    const s = await setup();
    const t = await ask(s.id, [viewer.userId]);
    const cid = (t.comments[0] as Comment).id;
    // Not asked: the editor, a stranger (404 first), a signed-out guest.
    expect((await answer(s.id, t.id, cid, editor, "wide")).status).toBe(403);
    expect((await answer(s.id, t.id, cid, stranger, "wide")).status).toBe(404);
    const pub = await setup({ visibility: "public" });
    const pt = await ask(pub.id, [viewer.userId]);
    expect(
      (
        await answer(
          pub.id,
          pt.id,
          (pt.comments[0] as Comment).id,
          null,
          "wide",
        )
      ).status,
    ).toBe(403);
    // Unknown option, unknown ask, bad id.
    const bad = await answer(s.id, t.id, cid, viewer, "huge");
    expect(bad.status).toBe(400);
    expect((await errOf(bad)).code).toBe("bad_request");
    const root = (await (await post(s.id, owner, {})).json()) as Thread;
    expect(
      (
        await answer(
          s.id,
          root.id,
          (root.comments[0] as Comment).id,
          viewer,
          "wide",
        )
      ).status,
    ).toBe(404);
    // The people asked answer, and may change it.
    const ok = await answer(s.id, t.id, cid, viewer, "wide");
    expect(ok.status).toBe(200);
    const a = ((await ok.json()) as Comment).ask;
    expect(a?.answer).toMatchObject({
      optionId: "wide",
      by: { id: viewer.userId, me: true },
    });
    const again = (await (
      await answer(s.id, t.id, cid, viewer, "compact")
    ).json()) as Comment;
    expect(again.ask?.answer?.optionId).toBe("compact");
    // Resolving closes it: 409, and the list says closed.
    await api(app, R.commentThread(s.id, t.id), owner.cookie, {
      method: "PATCH",
      body: { status: "resolved" },
    });
    const late = await answer(s.id, t.id, cid, viewer, "wide");
    expect(late.status).toBe(409);
    expect((await errOf(late)).code).toBe("conflict");
    const l = (await (
      await api(app, R.comments(s.id), viewer.cookie)
    ).json()) as CommentList;
    expect(l.threads[0]?.comments[0]?.ask).toMatchObject({
      closed: true,
      answer: { optionId: "compact" },
    });
  });

  it("an agent addressed is answered by the member whose agent it is", async () => {
    const s = await setup();
    const t = await ask(s.id, [s.claude]);
    expect(t.comments[0]?.ask?.to[0]).toMatchObject({
      name: "Claude",
      me: true,
    });
    expect(bus.sent[0]?.notice.kind).toBe("comment");
    const cid = (t.comments[0] as Comment).id;
    expect((await answer(s.id, t.id, cid, editor, "wide")).status).toBe(403);
    expect((await answer(s.id, t.id, cid, owner, "wide")).status).toBe(200);
  });

  it("validates the ask: the recommendation is an option, 2 to 6 options, someone can read", async () => {
    const s = await setup();
    const rejects = async (
      extra: Record<string, unknown>,
      to = [viewer.userId],
    ) => {
      await expect(ask(s.id, to, extra)).rejects.toMatchObject({
        code: "bad_request",
      });
    };
    await rejects({ recommended: { optionId: "nope", why: "x" } });
    await rejects({ options: [OPTS[0]] });
    await rejects({ options: [...OPTS, ...OPTS] });
    await rejects({}, [stranger.userId]);
    await rejects({}, ["agent:nope"]);
    await rejects({}, []);
  });

  it("an ask needs a signed-in asker; the REST bodies ignore an ask field", async () => {
    const s = await setup({ visibility: "public" });
    const guest: CommentWho = {
      kind: "guest",
      short: "g1",
      rate: "ip:1.2.3.4",
    };
    await expect(
      addThread(
        E,
        { id: s.id, format: "html", currentVersion: 1 } as never,
        guest,
        { userId: null, short: "g1" },
        {
          anchor: NOTE,
          body: "q",
          ask: { question: "q", options: OPTS, to: [{ key: viewer.userId }] },
        },
        { moderator: true },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const r = await post(s.id, owner, {
      ask: { question: "q", options: OPTS, to: [{ key: viewer.userId }] },
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as Thread).comments[0]?.ask).toBeUndefined();
  });

  it("keeps the ask on edit, and deleting the comment deletes its ask and targets", async () => {
    const s = await setup();
    const t = await ask(s.id, [viewer.userId]);
    const cid = (t.comments[0] as Comment).id;
    const e = await api(app, R.comment(s.id, t.id, cid), owner.cookie, {
      method: "PATCH",
      body: { body: "edited" },
    });
    expect(((await e.json()) as Comment).ask?.question).toBe(
      "Which layout do we ship?",
    );
    const m = (await (
      await post(s.id, owner, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    for (const th of [t, m])
      await api(
        app,
        R.comment(s.id, th.id, (th.comments[0] as Comment).id),
        owner.cookie,
        { method: "DELETE" },
      );
    const left = await runInDurableObject(
      runtimeStub(E, s.id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => ({
        asks: state.storage.sql
          .exec<{ n: number }>("select count(*) as n from comment_asks")
          .one().n,
        targets: state.storage.sql
          .exec<{ n: number }>("select count(*) as n from comment_targets")
          .one().n,
      }),
    );
    expect(left).toEqual({ asks: 0, targets: 0 });
  });

  it("a reply may carry an ask and a mention through the service", async () => {
    const s = await setup();
    const t = (await (await post(s.id, owner, {})).json()) as Thread;
    const c = await addReply(
      E,
      s.id,
      t.id,
      who(owner),
      view(owner),
      "and a question",
      {
        mentions: [{ key: s.codex }],
        ask: {
          question: "Ship it?",
          options: OPTS,
          to: [{ key: viewer.userId }],
        },
      },
      { moderator: true },
    );
    expect(c.ask?.question).toBe("Ship it?");
    expect(c.mentions?.[0]?.delivery).toBe("delivered");
    expect(bus.sent).toHaveLength(1);
  });
});
