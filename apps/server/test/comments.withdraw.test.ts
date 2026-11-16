import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import {
  addReply,
  addThread,
  answerAsk,
  type CommentViewer,
  type CommentWho,
  editComment,
  withdrawAsk,
} from "../src/services/comments.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2511: withdraw, replace (on this page and across pages) and edit.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(
  prefix: string,
  role: "member" | "guest" = "member",
): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const member = (await getUser(E, l.userId)) as Member;
  return { ...l, member, email };
}
let owner: U;
let viewer: U;
let other: U;
let guest: U;
beforeAll(async () => {
  owner = await mk("wd-owner");
  viewer = await mk("wd-viewer");
  other = await mk("wd-other");
  guest = await mk("wd-guest", "guest");
});

const agent = (name: string) => ({
  name,
  version: null,
  via: { kind: "token" as const, id: `tok-${name}` },
  identity: {
    identityId: `id-${name}-${tag}`,
    namespace: "ns",
    name,
    kind: "claude-code",
  },
});
const person = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  typed: true,
});
const asAgent = (u: U, name: string): CommentWho => ({
  kind: "user",
  id: u.userId,
  agent: agent(name),
});
const view = (w: CommentWho, u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
  agent: w.kind === "user" && w.typed !== true ? (w.agent ?? null) : undefined,
});
const OPTS = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;

async function page(title = "doc", shareOther = true) {
  const a = await publish(
    E,
    owner.member,
    {
      title,
      format: "html",
      content: "<p>x</p>",
      comments: "everyone",
    } as never,
    null,
    undefined,
    "create",
  );
  for (const u of shareOther ? [viewer, other] : [viewer])
    await putShare(E, owner.member, a.id, { email: u.email, role: "viewer" });
  return a.id;
}
const ask = async (id: string, who: CommentWho, extra: object = {}) => {
  const t = (await addThread(
    E,
    art(id),
    who,
    view(who, owner),
    {
      anchor: { kind: "note" },
      body: "Which?",
      ask: {
        question: "Which one?",
        options: OPTS,
        to: [{ key: viewer.userId }],
        ...extra,
      },
    },
    { moderator: true },
  )) as Thread;
  return { t, c: t.comments[0]?.id as string };
};
const rows = async (id: string, c: string) =>
  (
    await E.DB.prepare(
      "select count(*) as n from artifact_asks where artifact_id = ? and comment_id = ?",
    )
      .bind(id, c)
      .first<{ n: number }>()
  )?.n;
const pick = (id: string, t: string, c: string, opt = "a") =>
  answerAsk(
    E,
    id,
    t,
    c,
    person(viewer),
    { userId: viewer.userId, short: null },
    opt,
    undefined,
    { interactive: false },
    { canDecide: false, guest: false },
  );

describe("withdraw", () => {
  it("the asking agent withdraws: the card stays, takes no picks, leaves the index", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const { t, c } = await ask(id, bot);
    expect(await rows(id, c)).toBeGreaterThan(0);
    const out = await withdrawAsk(E, id, t.id, c, bot, view(bot, owner));
    expect(out.ask?.withdrawn?.at).toEqual(expect.any(String));
    expect(out.ask?.options).toHaveLength(2);
    expect(out.ask?.answer).toBeUndefined();
    expect(await rows(id, c)).toBe(0);
    await expect(pick(id, t.id, c)).rejects.toMatchObject({
      code: "withdrawn",
    });
    // Repeating is safe, and the card is still in the thread.
    const again = await withdrawAsk(E, id, t.id, c, bot, view(bot, owner));
    expect(again.ask?.withdrawn?.at).toBe(out.ask?.withdrawn?.at);
  });

  it("the person it acts for withdraws too, over REST, once", async () => {
    const id = await page();
    const { t, c } = await ask(id, asAgent(owner, "Bot"));
    const res = await api(app, R.commentWithdraw(id, t.id, c), owner.cookie, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ask: { withdrawn?: unknown } };
    expect(body.ask.withdrawn).toBeTruthy();
    expect(await rows(id, c)).toBe(0);
  });

  it("refuses another agent of the same person, another person, a guest and an unknown card", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const { t, c } = await ask(id, bot);
    const rival = asAgent(owner, "Rival");
    await expect(
      withdrawAsk(E, id, t.id, c, rival, view(rival, owner)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      withdrawAsk(E, id, t.id, c, person(other), view(person(other), other)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      withdrawAsk(E, id, t.id, c, person(guest), view(person(guest), guest)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      withdrawAsk(E, id, t.id, newId(), bot, view(bot, owner)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await rows(id, c)).toBeGreaterThan(0);
  });

  it("an answered ask can't be withdrawn or replaced (409)", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const { t, c } = await ask(id, bot);
    // The decider (the asker's own user) answers.
    await answerAsk(
      E,
      id,
      t.id,
      c,
      person(owner),
      { userId: owner.userId, short: null, moderator: true },
      "a",
      undefined,
      { interactive: false },
      { canDecide: true, guest: false },
    );
    await expect(
      withdrawAsk(E, id, t.id, c, bot, view(bot, owner)),
    ).rejects.toMatchObject({ code: "already_answered" });
    await expect(ask(id, bot, { replaces: c })).rejects.toMatchObject({
      code: "already_answered",
    });
  });

  it("a withdrawn ask can't be replaced, and the thread keeps working", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const { t, c } = await ask(id, bot);
    await withdrawAsk(E, id, t.id, c, bot, view(bot, owner));
    await expect(ask(id, bot, { replaces: c })).rejects.toMatchObject({
      code: "withdrawn",
    });
    const r = await addReply(
      E,
      id,
      t.id,
      person(owner),
      view(person(owner), owner),
      "ok",
      {},
      { moderator: true },
    );
    expect(r.body).toBe("ok");
  });
});

describe("audit", () => {
  it("a withdraw and a cross-page replace each write one event, ids only", async () => {
    const a = await page();
    const b = await page();
    const bot = asAgent(owner, "Bot");
    const one = await ask(a, bot);
    await withdrawAsk(E, a, one.t.id, one.c, bot, view(bot, owner));
    const two = await ask(a, bot);
    const fresh = await ask(b, bot, {
      replaces: { artifactId: a, threadId: two.t.id, commentId: two.c },
    });
    const ev = async (action: string, id: string) =>
      (
        await E.DB.prepare(
          "select actor_id as actor, detail from audit_events where action = ? and target_id = ?",
        )
          .bind(action, id)
          .all<{ actor: string; detail: string }>()
      ).results;
    const w = await ev("ask.withdraw", one.c);
    expect(w).toHaveLength(1);
    expect(w[0]?.actor).toBe(owner.userId);
    expect(JSON.parse(w[0]?.detail ?? "{}")).toEqual({
      artifactId: a,
      threadId: one.t.id,
      commentId: one.c,
    });
    const r = await ev("ask.replace", two.c);
    expect(r).toHaveLength(1);
    expect(JSON.parse(r[0]?.detail ?? "{}").replacedBy).toEqual({
      artifactId: b,
      threadId: fresh.t.id,
      commentId: fresh.c,
    });
    // A repeat writes nothing more.
    await withdrawAsk(E, a, one.t.id, one.c, bot, view(bot, owner));
    expect(await ev("ask.withdraw", one.c)).toHaveLength(1);
  });
});

describe("replace", () => {
  it("on this page the old card leaves the index and refuses picks", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const first = await ask(id, bot);
    const second = await ask(id, bot, { replaces: first.c });
    expect(await rows(id, first.c)).toBe(0);
    expect(await rows(id, second.c)).toBeGreaterThan(0);
    await expect(pick(id, first.t.id, first.c)).rejects.toMatchObject({
      code: "replaced",
    });
  });

  it("across pages: the new card is posted and the old one is withdrawn with a link", async () => {
    const a = await page("Old page");
    const b = await page("New page");
    const bot = asAgent(owner, "Bot");
    const old = await ask(a, bot);
    const fresh = await ask(b, bot, {
      replaces: { artifactId: a, threadId: old.t.id, commentId: old.c },
    });
    expect(fresh.t.comments[0]?.notice).toBeUndefined();
    expect(await rows(a, old.c)).toBe(0);
    expect(await rows(b, fresh.c)).toBeGreaterThan(0);
    await expect(pick(a, old.t.id, old.c)).rejects.toMatchObject({
      code: "withdrawn",
    });
    // The old card reads where it went, with the title for someone who can open that page.
    const list = await api(app, R.comments(a), owner.cookie);
    const th = ((await list.json()) as { threads: Thread[] }).threads.find(
      (x) => x.id === old.t.id,
    );
    expect(th?.comments[0]?.ask?.withdrawn?.replacedBy).toMatchObject({
      artifactId: b,
      threadId: fresh.t.id,
      commentId: fresh.c,
      title: "New page",
    });
  });

  it("across pages needs the same asker, an editable page, and no decision", async () => {
    const a = await page();
    const b = await page();
    const bot = asAgent(owner, "Bot");
    const old = await ask(a, bot);
    const ref = { artifactId: a, threadId: old.t.id, commentId: old.c };
    // Another agent of the same person did not ask it.
    await expect(
      ask(b, asAgent(owner, "Rival"), { replaces: ref }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    // A card that does not exist.
    await expect(
      ask(b, bot, { replaces: { ...ref, commentId: newId() } }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await rows(a, old.c)).toBeGreaterThan(0);
  });

  it("a partial failure is reported, and withdraw_ask with replacedBy finishes it", async () => {
    const a = await page("Old");
    const b = await page("New");
    const bot = asAgent(owner, "Bot");
    const old = await ask(a, bot);
    // The old page's DO refuses the withdraw (its minute budget is spent).
    await runInDurableObject(
      runtimeStub(E, a) as unknown as DurableObjectStub<ArtifactRuntime>,
      (i) => {
        (i as unknown as { commentRate: Map<string, number> }).commentRate.set(
          `u:${owner.userId}`,
          999,
        );
      },
    );
    const fresh = await ask(b, bot, {
      replaces: { artifactId: a, threadId: old.t.id, commentId: old.c },
    });
    expect(fresh.t.comments[0]?.notice).toMatch(
      /could not be withdrawn.*withdraw_ask/,
    );
    expect(await rows(b, fresh.c)).toBeGreaterThan(0);
    expect(await rows(a, old.c)).toBeGreaterThan(0);
    // The budget returns; the retry completes it.
    await runInDurableObject(
      runtimeStub(E, a) as unknown as DurableObjectStub<ArtifactRuntime>,
      (i) =>
        (
          i as unknown as { commentRate: Map<string, number> }
        ).commentRate.clear(),
    );
    const done = await withdrawAsk(
      E,
      a,
      old.t.id,
      old.c,
      bot,
      view(bot, owner),
      {
        artifactId: b,
        threadId: fresh.t.id,
        commentId: fresh.c,
      },
    );
    expect(done.ask?.withdrawn?.replacedBy?.artifactId).toBe(b);
    expect(await rows(a, old.c)).toBe(0);
    // And a repeat is a no-op; another replacement is refused.
    const second = await ask(b, bot);
    await expect(
      withdrawAsk(E, a, old.t.id, old.c, bot, view(bot, owner), {
        artifactId: b,
        threadId: second.t.id,
        commentId: second.c,
      }),
    ).rejects.toMatchObject({ code: "already_replaced" });
  });
});

describe("edit_comment", () => {
  const post = async (id: string, who: CommentWho) =>
    (await addThread(
      E,
      art(id),
      who,
      view(who, owner),
      { anchor: { kind: "note" }, body: "first" },
      { moderator: true },
    )) as Thread;

  it("an agent edits only its own comment; the person may; an ask's question stays", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const t = await post(id, bot);
    const cid = t.comments[0]?.id as string;
    const out = await editComment(
      E,
      id,
      t.id,
      cid,
      bot,
      view(bot, owner),
      "second",
      true,
    );
    expect(out.body).toBe("second");
    expect(out.editedAt).not.toBeNull();
    const rival = asAgent(owner, "Rival");
    await expect(
      editComment(E, id, t.id, cid, rival, view(rival, owner), "x", true),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A person's own comment is not an agent's to edit.
    const mine = await post(id, person(owner));
    await expect(
      editComment(
        E,
        id,
        mine.id,
        mine.comments[0]?.id as string,
        bot,
        view(bot, owner),
        "x",
        true,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Another person never.
    await expect(
      editComment(
        E,
        id,
        t.id,
        cid,
        person(other),
        view(person(other), other),
        "x",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    // The question and options of an ask are not touched by an edit.
    const a = await ask(id, bot);
    const edited = await editComment(
      E,
      id,
      a.t.id,
      a.c,
      bot,
      view(bot, owner),
      "new body",
      true,
    );
    expect(edited.ask?.question).toBe("Which one?");
    expect(edited.ask?.options.map((o) => o.id)).toEqual(["a", "b"]);
  });
});

describe("Axe's checks (#2623)", () => {
  const post = async (id: string, who: CommentWho, extra: object = {}) =>
    (await addThread(
      E,
      art(id),
      who,
      view(who, owner),
      { anchor: { kind: "note" }, body: "first", ...extra },
      { moderator: true },
    )) as Thread;

  it("an ask's comment can't be edited once anyone picked, or from the start when it names an action or needs a passkey (REST and MCP)", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const plain = await ask(id, bot);
    // Before any pick: editable, by the agent over MCP's path and by REST.
    const ok = await editComment(
      E,
      id,
      plain.t.id,
      plain.c,
      bot,
      view(bot, owner),
      "reworded",
      true,
    );
    expect(ok.body).toBe("reworded");
    // A weigh-in by the person asked.
    await pick(id, plain.t.id, plain.c);
    await expect(
      editComment(
        E,
        id,
        plain.t.id,
        plain.c,
        bot,
        view(bot, owner),
        "again",
        true,
      ),
    ).rejects.toMatchObject({
      code: "already_answered",
      message:
        "This card already has an answer, so it can't be edited. Post a new card, and withdraw this one first if it has no decision yet.",
    });
    const rest = await api(
      app,
      R.comment(id, plain.t.id, plain.c),
      owner.cookie,
      {
        method: "PATCH",
        body: { body: "again" },
      },
    );
    expect(rest.status).toBe(409);
    // An action option: refused from the start.
    const risky = (await post(id, person(owner), {
      ask: {
        question: "Merge it?",
        options: [
          { id: "y", label: "Merge", highStakes: { reason: "Hard to undo" } },
          { id: "n", label: "No" },
        ],
        to: [{ key: owner.userId }],
      },
    })) as Thread;
    const rc = risky.comments[0]?.id as string;
    await expect(
      editComment(
        E,
        id,
        risky.id,
        rc,
        person(owner),
        view(person(owner), owner),
        "x",
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "A card that approves an action can't be edited. Withdraw it and post a new card.",
    });
    const restRisky = await api(
      app,
      R.comment(id, risky.id, rc),
      owner.cookie,
      {
        method: "PATCH",
        body: { body: "x" },
      },
    );
    expect(restRisky.status).toBe(409);
  });

  it("withdraw_ask's replacedBy must be a card by the same asker, on a page the caller can edit", async () => {
    const a = await page();
    const b = await page();
    const bot = asAgent(owner, "Bot");
    const old = await ask(a, bot);
    const fresh = await ask(b, asAgent(owner, "Rival"));
    // Another agent's card, a card that does not exist: refused, and nothing is withdrawn.
    await expect(
      withdrawAsk(E, a, old.t.id, old.c, bot, view(bot, owner), {
        artifactId: b,
        threadId: fresh.t.id,
        commentId: fresh.c,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      withdrawAsk(E, a, old.t.id, old.c, bot, view(bot, owner), {
        artifactId: b,
        threadId: fresh.t.id,
        commentId: newId(),
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await rows(a, old.c)).toBeGreaterThan(0);
  });

  it("checks use the request's own caller: a capped token can't edit the other page, and no title leaks", async () => {
    const a = await page("A page");
    const b = await page("B page", false);
    const bot = asAgent(owner, "Bot");
    const old = await ask(a, bot);
    const capped = {
      kind: "user",
      user: owner.member,
      cap: "restricted",
    } as const;
    await expect(
      addThread(
        E,
        art(b),
        bot,
        { ...view(bot, owner), caller: capped },
        {
          anchor: { kind: "note" },
          body: "new",
          ask: {
            question: "Which?",
            options: OPTS,
            to: [{ key: viewer.userId }],
            replaces: { artifactId: a, threadId: old.t.id, commentId: old.c },
          },
        },
        { moderator: true },
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await rows(a, old.c)).toBeGreaterThan(0);
    // The uncapped request caller may.
    const done = await ask(b, bot, {
      replaces: { artifactId: a, threadId: old.t.id, commentId: old.c },
    });
    expect(done.t.comments[0]?.notice).toBeUndefined();
    // A reader who can't open the new page (`other` is shared on A only) sees no title.
    const list = await api(app, R.comments(a), other.cookie);
    const th = ((await list.json()) as { threads: Thread[] }).threads.find(
      (x) => x.id === old.t.id,
    );
    expect(th?.comments[0]?.ask?.withdrawn?.replacedBy?.title).toBeUndefined();
    expect(th?.comments[0]?.ask?.withdrawn?.replacedBy?.artifactId).toBe(b);
  });

  it("a token with no agent identity falls back to the DO's author rule for edit_comment", async () => {
    const id = await page();
    const bot = asAgent(owner, "Bot");
    const t = await post(id, bot);
    const cid = t.comments[0]?.id as string;
    const tokenNoAgent: CommentWho = {
      kind: "user",
      id: owner.userId,
      agent: null,
    };
    const v: CommentViewer = {
      userId: owner.userId,
      short: null,
      moderator: true,
      agent: null,
    };
    // The same person's unlabeled token edits (the DO's rule: the author's person).
    const out = await editComment(
      E,
      id,
      t.id,
      cid,
      tokenNoAgent,
      v,
      "by token",
      true,
    );
    expect(out.body).toBe("by token");
    // Another person's never.
    const otherTok: CommentWho = {
      kind: "user",
      id: other.userId,
      agent: null,
    };
    await expect(
      editComment(
        E,
        id,
        t.id,
        cid,
        otherTok,
        { userId: other.userId, short: null, agent: null },
        "x",
        true,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("withdraw_ask with replacedBy still withdraws after someone picked on the new card", async () => {
    const a = await page();
    const b = await page();
    const bot = asAgent(owner, "Bot");
    const old = await ask(a, bot);
    const fresh = await ask(b, bot);
    // A pick on the replacement card.
    await pick(b, fresh.t.id, fresh.c);
    const done = await withdrawAsk(
      E,
      a,
      old.t.id,
      old.c,
      bot,
      view(bot, owner),
      {
        artifactId: b,
        threadId: fresh.t.id,
        commentId: fresh.c,
      },
    );
    expect(done.ask?.withdrawn?.replacedBy?.commentId).toBe(fresh.c);
    expect(await rows(a, old.c)).toBe(0);
  });

  it("a capped caller who can open the page but can't edit it can't replace across pages", async () => {
    const a = await page("A");
    const b = await page("B");
    const bot = asAgent(owner, "Bot");
    const old = await ask(a, bot);
    // The cap lowers the owner to a viewer on the new page: it opens, it does not edit.
    const capped = { kind: "user", user: owner.member, cap: "guest" } as const;
    await expect(
      addThread(
        E,
        art(b),
        bot,
        { ...view(bot, owner), caller: capped },
        {
          anchor: { kind: "note" },
          body: "new",
          ask: {
            question: "Which?",
            options: OPTS,
            to: [{ key: viewer.userId }],
            replaces: { artifactId: a, threadId: old.t.id, commentId: old.c },
          },
        },
        { moderator: true },
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await rows(a, old.c)).toBeGreaterThan(0);
  });
});
