import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import {
  type BusNotice,
  type Comment,
  type CommentList,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { insertComment } from "../src/runtime/comments-store.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import {
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import {
  CHANGED_WINDOW_MS,
  FANOUT_MAX,
  follow,
  notifyChanged,
  notifyCommented,
} from "../src/services/follows.js";
import { deleteShare, putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { listenEachOther } from "./held-listens.js";
import { api, login } from "./helpers.js";
import {
  close,
  connect,
  oauthToken,
  settle,
  textOf,
  tool,
} from "./mcp-helpers.js";

// #682 part 2: list_comments, add_comment, resolve_comment and the `comment`
// notice. The tools call the services the REST routes call, so these tests
// check the seams: permissions, the shared rate bucket, anchors, notices.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
type U = {
  cookie: string;
  userId: string;
  member: Member;
  email: string;
  client: Client;
};

type Sent = { userId: string; notice: BusNotice };
class FakeBus implements NoticeDelivery {
  sent: Sent[] = [];
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    this.sent.push({ userId, notice });
    return "delivered" as const;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
const clients: Client[] = [];
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(async () => {
  installDelivery(prev);
  await Promise.all(clients.map((c) => close(c)));
});

async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email);
  const member = (await getUser(E, l.userId)) as Member;
  const { token } = await createPat(env, l.userId, prefix);
  const client = await connect(token);
  clients.push(client);
  return { ...l, member, email, client };
}

let owner: U;
let reader: U;
let stranger: U;

const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      E,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>The quick brown fox jumps over the lazy dog</p>",
        comments: "everyone",
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const sc = <T>(r: Awaited<ReturnType<typeof tool>>) => {
  expect(r.isError, textOf(r)).toBeFalsy();
  return r.structuredContent as T;
};
const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );
/** Notices sent for `id` once the after-response work is done. */
const heardAll = async (id: string) => {
  await vi.waitFor(() =>
    expect(bus.sent.some((s) => s.notice.artifactId === id)).toBe(true),
  );
  return bus.sent.filter((s) => s.notice.artifactId === id).length;
};
const comments = (id: string) => `${R.comments(id)}`;

beforeAll(async () => {
  owner = await mk("mc-owner");
  reader = await mk("mc-reader");
  stranger = await mk("mc-stranger");
  await listenEachOther(E, [owner.userId, reader.userId, stranger.userId]);
});

describe("comment tools over MCP", () => {
  it("add, list, reply, resolve and reopen", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const added = (await reader.client.callTool({
      name: "add_comment",
      arguments: { id, body: "  Is this right?  ", verbose: true },
    })) as never;
    await settle(reader.client);
    const t = sc<{ thread: Thread }>(added).thread;
    expect(t.anchor).toEqual({ kind: "note" });
    expect(t.comments[0]).toMatchObject({
      body: "Is this right?",
      author: { kind: "agent", me: true },
    });

    const reply = sc<{ comment: Comment }>(
      await tool(owner.client, "add_comment", {
        id,
        threadId: t.id,
        body: "Yes.",
        verbose: true,
      }),
    );
    expect(reply.comment.body).toBe("Yes.");

    const open = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, status: "open" }),
    );
    expect(open.open).toBe(1);
    expect(open.threads[0]?.comments.map((c) => c.body)).toEqual([
      "Is this right?",
      "Yes.",
    ]);

    const done = sc<{ threadId: string; commentId: string; status: string }>(
      await tool(reader.client, "resolve_comment", { id, threadId: t.id }),
    );
    expect(done).toEqual({
      threadId: t.id,
      commentId: t.comments[0]?.id,
      status: "resolved",
    });
    expect(
      sc<CommentList>(
        await tool(owner.client, "list_comments", { id, status: "open" }),
      ).threads,
    ).toEqual([]);
    expect(
      sc<CommentList>(
        await tool(owner.client, "list_comments", { id, status: "resolved" }),
      ).threads,
    ).toHaveLength(1);
    const again = sc<{ threadId: string; commentId: string; status: string }>(
      await tool(reader.client, "resolve_comment", {
        id,
        threadId: t.id,
        resolved: false,
      }),
    );
    expect(again).toEqual({
      threadId: t.id,
      commentId: t.comments[0]?.id,
      status: "open",
    });

    // #3139: one thread by id, and one comment with the one before it and the first.
    const other = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "Another thread." }),
    ).thread;
    const one = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, threadId: t.id }),
    );
    expect(one.threads.map((x) => x.id)).toEqual([t.id]);
    expect(one.threads[0]?.comments.map((c) => c.body)).toEqual([
      "Is this right?",
      "Yes.",
    ]);
    for (const b of ["third", "fourth", "fifth"])
      sc(
        await tool(owner.client, "add_comment", {
          id,
          threadId: t.id,
          body: b,
        }),
      );
    const all = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, threadId: t.id }),
    ).threads[0]?.comments as Comment[];
    const fifth = all.at(-1) as Comment;
    const trimmed = sc<CommentList>(
      await tool(owner.client, "list_comments", {
        id,
        threadId: t.id,
        commentId: fifth.id,
      }),
    );
    expect(trimmed.threads[0]?.comments.map((c) => c.body)).toEqual([
      "Is this right?",
      "fourth",
      "fifth",
    ]);
    expect(
      textOf(
        await tool(owner.client, "list_comments", {
          id,
          threadId: "nope0000nope0000",
        }),
      ),
    ).toMatch(/^not_found: No such thread/);
    expect(
      textOf(
        await tool(owner.client, "list_comments", {
          id,
          threadId: t.id,
          commentId: "nope0000nope0000",
        }),
      ),
    ).toMatch(/^not_found: No such comment in this thread/);
    expect(
      textOf(
        await tool(owner.client, "list_comments", { id, commentId: fifth.id }),
      ),
    ).toMatch(/^bad_request: commentId needs threadId/);
    expect(
      textOf(
        await tool(owner.client, "list_comments", {
          id,
          threadId: t.id,
          compact: true,
        }),
      ),
    ).toMatch(/^bad_request: threadId reads one thread/);
    // A stranger can't read a thread by id either.
    expect(
      textOf(
        await tool(stranger.client, "list_comments", { id, threadId: t.id }),
      ),
    ).toMatch(/^not_found/);
    expect(other.id).not.toBe(t.id);

    // The same threads over REST.
    const rest = (await (
      await api(app, comments(id), owner.cookie)
    ).json()) as CommentList;
    expect(rest.threads.map((x) => x.id).sort()).toEqual(
      [t.id, other.id].sort(),
    );
  });

  it("a text anchor on html is verified like REST", async () => {
    const id = await pub();
    const ok = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", {
        id,
        body: "this word",
        anchor: {
          kind: "text",
          exact: "quick brown",
          prefix: "The ",
          suffix: " fox",
        },
        verbose: true,
      }),
    );
    expect(ok.thread.anchor).toMatchObject({
      kind: "text",
      exact: "quick brown",
    });
    const bad = await tool(owner.client, "add_comment", {
      id,
      body: "nope",
      anchor: {
        kind: "text",
        exact: "not in the page",
        prefix: "",
        suffix: "",
      },
      verbose: true,
    });
    expect(bad.isError).toBeFalsy();
    expect(sc<{ thread: Thread }>(bad).thread.anchor).toMatchObject({
      exact: "not in the page",
      prefix: "",
      suffix: "",
    });
    const rest = await api(app, comments(id), owner.cookie, {
      method: "POST",
      body: {
        anchor: {
          kind: "text",
          exact: "not in the page",
          prefix: "",
          suffix: "",
        },
        body: "nope",
      },
    });
    expect(rest.status).toBe(201);
  });

  it("refuses an empty body, a reply with an anchor and a missing thread, saying what to do", async () => {
    const id = await pub();
    expect(
      textOf(await tool(owner.client, "add_comment", { id, body: "  " })),
    ).toMatch(/^invalid_body\b/);
    const { threadId } = sc<{ threadId: string }>(
      await tool(owner.client, "add_comment", { id, body: "x" }),
    );
    expect(
      textOf(
        await tool(owner.client, "add_comment", {
          id,
          body: "y",
          threadId,
          anchor: { kind: "note" },
        }),
      ),
    ).toMatch(/^bad_request: A reply has no anchor/);
    for (const [name, args] of [
      ["add_comment", { body: "y" }],
      ["resolve_comment", {}],
    ] as const) {
      const r = await tool(owner.client, name, {
        id,
        threadId: "AAAAAAAAAAAAAAAA",
        ...args,
      });
      expect(textOf(r)).toMatch(/^not_found: No such thread.*list_comments/);
    }
  });

  it("someone who cannot open the artifact is refused; comments off is refused with a next step", async () => {
    const id = await pub({ visibility: "private" });
    for (const [name, args] of [
      ["list_comments", {}],
      ["get_comment_picture", { pictureId: newId() }],
      ["add_comment", { body: "hi" }],
      ["resolve_comment", { threadId: "AAAAAAAAAAAAAAAA" }],
    ] as const) {
      const r = await tool(stranger.client, name, { id, ...args });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^not_found\b/);
    }
    const off = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { comments: false },
    });
    expect(off.status).toBe(200);
    for (const [name, args] of [
      ["list_comments", {}],
      ["get_comment_picture", { pictureId: newId() }],
      ["add_comment", { body: "hi" }],
    ] as const) {
      const r = await tool(owner.client, name, { id, ...args });
      expect(textOf(r)).toMatch(/^comments_off: .*turn them on/);
    }
  });

  it("#3139: a thread at the reply cap reads whole, root plus every reply", async () => {
    const id = await pub();
    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "root" }),
    ).thread;
    const author = (t.comments[0] as Comment).author;
    // The store's cap: the root plus COMMENTS_MAX_REPLIES (200) replies.
    await inDo(id, (i) => {
      const sql = (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const actor = sql
        .exec<{ author: string }>(
          "select author from comments where thread_id = ?",
          t.id,
        )
        .toArray()[0]?.author as string;
      for (let n = 1; n <= 200; n++)
        insertComment(
          sql,
          new Date(Date.UTC(2030, 0, 1, 0, 0, n)).toISOString(),
          t.id,
          JSON.parse(actor),
          `reply ${n}`,
        );
    });
    expect(author).toBeTruthy();
    const whole = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, threadId: t.id }),
    );
    const cs = whole.threads[0]?.comments as Comment[];
    expect(cs).toHaveLength(201);
    expect(whole.truncated).toBe(false);
    const last = cs.at(-1) as Comment;
    expect(last.body).toBe("reply 200");
    const one = sc<CommentList>(
      await tool(owner.client, "list_comments", {
        id,
        threadId: t.id,
        commentId: last.id,
      }),
    );
    expect(one.threads[0]?.comments.map((c) => c.body)).toEqual([
      "root",
      "reply 199",
      "reply 200",
    ]);
  });

  it("shares the 30 a minute bucket with REST", async () => {
    const id = await pub();
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    for (let n = 0; n < 15; n++) {
      const r = await api(app, comments(id), owner.cookie, {
        method: "POST",
        body: { anchor: { kind: "note" }, body: `rest ${n}` },
      });
      expect(r.status).toBe(201);
    }
    for (let n = 0; n < 15; n++)
      sc(await tool(owner.client, "add_comment", { id, body: `mcp ${n}` }));
    const over = await tool(owner.client, "add_comment", { id, body: "over" });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toMatch(/^rate_limited\b/);
    const rest = await api(app, comments(id), owner.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "over" },
    });
    expect(rest.status).toBe(429);
  });
});

describe("add_comment with an ask (#1535)", () => {
  const OPTS = [
    { id: "wide", label: "Wide hero", detail: "Full bleed" },
    { id: "compact", label: "Compact hero" },
  ];
  const ASK = (to: string[]) => ({
    question: "Which layout do we ship?",
    options: OPTS,
    recommended: { optionId: "compact", why: "Loads faster" },
    to: to.map((key) => ({ key })),
  });

  it("an owner's PAT asks; REST readers see an ask and the addressee can answer", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", {
        id,
        body: "Which layout?",
        ask: ASK([reader.userId]),
        verbose: true,
      }),
    ).thread;
    const root = t.comments[0];
    expect(root?.ask).toMatchObject({
      question: "Which layout do we ship?",
      options: OPTS,
      recommended: { optionId: "compact" },
      closed: false,
    });
    const rest = (await (
      await api(app, comments(id), reader.cookie)
    ).json()) as CommentList;
    const seen = rest.threads[0]?.comments[0];
    expect(seen?.ask?.options.map((o) => o.id)).toEqual(["wide", "compact"]);
    expect(seen?.ask?.to).toHaveLength(1);
    const answered = await api(
      app,
      R.commentAnswer(id, t.id, root?.id ?? ""),
      reader.cookie,
      { method: "POST", body: { optionId: "wide" } },
    );
    expect(answered.status).toBe(200);
  });

  it("`me` addresses the caller's own person, stored as the user id (#3066)", async () => {
    const id = await pub();
    const stored = async (key: string) => {
      const r = sc<{ thread: Thread }>(
        await tool(owner.client, "add_comment", {
          id,
          body: "q",
          ask: ASK([key]),
          verbose: true,
        }),
      );
      return JSON.stringify(r.thread.comments[0]?.ask?.to);
    };
    const viaMe = await stored("me");
    const viaId = await stored(owner.userId);
    expect(viaMe).toBe(viaId);
    expect(viaMe).toContain(owner.userId);
    // `me` and the id together are one addressee.
    const both = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", {
        id,
        body: "q",
        ask: ASK(["me", owner.userId]),
        verbose: true,
      }),
    );
    expect(both.thread.comments[0]?.ask?.to).toHaveLength(1);
    // `me` as the decider is the default decider.
    const dec = await tool(owner.client, "add_comment", {
      id,
      body: "q",
      ask: { ...ASK(["me"]), decider: { key: "me" } },
    });
    expect(dec.isError).toBeFalsy();
    // `user:<id>` is still unknown.
    const bad = await tool(owner.client, "add_comment", {
      id,
      body: "q",
      ask: ASK([`user:${owner.userId}`]),
    });
    expect(textOf(bad)).toMatch(/^bad_request: Unknown agent or person/);
  });

  it("an ask on a reply works", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const { threadId } = sc<{ threadId: string }>(
      await tool(owner.client, "add_comment", { id, body: "start" }),
    );
    const r = sc<{ comment: Comment }>(
      await tool(owner.client, "add_comment", {
        id,
        threadId,
        body: "Pick one",
        ask: ASK([reader.userId]),
        verbose: true,
      }),
    );
    expect(r.comment.ask?.question).toBe("Which layout do we ship?");
  });

  it("an OAuth caller asks like a PAT caller", async () => {
    const o = await oauthToken(`mc-oauth-${tag}@x.com`);
    const m = (await getUser(E, o.member.userId)) as Member;
    const id = (
      await publish(
        E,
        m,
        { title: "d", format: "html", content: "<p>x</p>" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    await putShare(E, m, id, { email: reader.email, role: "viewer" });
    const c = await connect(o.accessToken);
    clients.push(c);
    const t = sc<{ thread: Thread }>(
      await tool(c, "add_comment", {
        id,
        body: "Which?",
        ask: ASK([reader.userId]),
        verbose: true,
      }),
    ).thread;
    expect(t.comments[0]?.ask?.closed).toBe(false);
  });

  it("an editor may ask; a viewer is refused as REST refuses mentions", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    await putShare(E, owner.member, id, {
      email: stranger.email,
      role: "editor",
    });
    const refused = await tool(reader.client, "add_comment", {
      id,
      body: "x",
      ask: ASK([owner.userId]),
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^forbidden: Only the owner and editors/);
    expect(textOf(refused)).toMatch(/plain comment/);
    const ok = await tool(stranger.client, "add_comment", {
      id,
      body: "x",
      ask: ASK([owner.userId]),
    });
    expect(ok.isError, textOf(ok)).toBeFalsy();
  });

  it("names a decider who can edit the page (#2381); a viewer or an action ask is refused", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    await putShare(E, owner.member, id, {
      email: stranger.email,
      role: "editor",
    });
    const ok = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", {
        id,
        body: "x",
        ask: { ...ASK([reader.userId]), decider: { key: stranger.userId } },
        verbose: true,
      }),
    ).thread;
    expect(ok.comments[0]?.ask).toMatchObject({
      decider: { id: stranger.userId },
      chosenBy: { id: owner.userId },
    });
    const viewer = await tool(owner.client, "add_comment", {
      id,
      body: "x",
      ask: { ...ASK([owner.userId]), decider: { key: reader.userId } },
    });
    expect(viewer.isError).toBe(true);
    expect(textOf(viewer)).toMatch(/can edit this page/);
    const risky = await tool(owner.client, "add_comment", {
      id,
      body: "x",
      ask: {
        question: "Merge it?",
        options: [
          { id: "merge", label: "Merge", action: "merge" },
          { id: "wait", label: "Wait" },
        ],
        to: [{ key: owner.userId }],
        decider: { key: stranger.userId },
      },
    });
    expect(risky.isError).toBe(true);
    expect(textOf(risky)).toMatch(/decided by you/);
  });

  it("someone who cannot open the artifact is refused", async () => {
    const id = await pub({ visibility: "private" });
    const r = await tool(stranger.client, "add_comment", {
      id,
      body: "x",
      ask: ASK([owner.userId]),
    });
    expect(textOf(r)).toMatch(/^not_found\b/);
  });

  it("the ask limits are REST's: options 2 to 6, 1 to 10 addressees, a question of 1000, no blank text", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const base = ASK([reader.userId]);
    // The good ask goes through, so each refusal below is about its one change.
    expect(
      (
        await tool(owner.client, "add_comment", {
          id,
          body: "x",
          ask: base,
        })
      ).isError,
    ).toBeFalsy();
    const bad = async (ask: Record<string, unknown>, why: RegExp) => {
      const r = await tool(owner.client, "add_comment", {
        id,
        body: "x",
        ask: { ...base, ...ask },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(why);
      expect(textOf(r)).not.toMatch(/Unknown agent or person/);
    };
    const two = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: "L" }));
    await bad({ options: [OPTS[0]], recommended: undefined }, /options/);
    await bad({ options: two(7), recommended: undefined }, /options/);
    await bad({ options: [OPTS[0], { ...OPTS[0] }] }, /unique/);
    await bad({ to: [] }, /\bto\b/);
    await bad(
      { to: Array.from({ length: 11 }, () => ({ key: reader.userId })) },
      /\bto\b/,
    );
    await bad({ question: "q".repeat(1001) }, /question/);
    await bad({ question: "   " }, /question/);
    await bad({ options: [OPTS[0], { id: "z", label: "  " }] }, /label/);
    await bad({ recommended: { optionId: "nope", why: "x" } }, /recommended/);
    // An addressee who cannot read the artifact.
    const r = await tool(owner.client, "add_comment", {
      id,
      body: "x",
      ask: ASK([stranger.userId]),
    });
    expect(textOf(r)).toMatch(/^bad_request: Unknown agent or person/);
  });

  it("an ask on a reply to a resolved thread is refused with a next step; open again, it works", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const { threadId } = sc<{ threadId: string }>(
      await tool(owner.client, "add_comment", { id, body: "start" }),
    );
    sc(await tool(owner.client, "resolve_comment", { id, threadId }));
    const args = {
      id,
      threadId,
      body: "Pick one",
      ask: ASK([reader.userId]),
    };
    const refused = await tool(owner.client, "add_comment", args);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^conflict: .*resolve_comment/);
    // A plain reply on the resolved thread still works.
    sc(
      await tool(owner.client, "add_comment", {
        id,
        threadId,
        body: "plain",
      }),
    );
    sc(
      await tool(owner.client, "resolve_comment", {
        id,
        threadId,
        resolved: false,
      }),
    );
    sc(await tool(owner.client, "add_comment", args));
  });
});

describe("compact write results (#3163)", () => {
  const ASK = (to: string[]) => ({
    question: "Which layout do we ship?",
    options: [
      { id: "wide", label: "Wide hero", detail: "Full bleed" },
      { id: "compact", label: "Compact hero" },
    ],
    recommended: { optionId: "compact", why: "Loads faster" },
    to: to.map((key) => ({ key })),
  });

  it("add_comment returns compact ids and status under 300 chars by default, and full shape with verbose: true", async () => {
    const id = await pub();
    const longBody = "A".repeat(400);

    const created = await tool(owner.client, "add_comment", {
      id,
      body: longBody,
    });
    expect(created.isError, textOf(created)).toBeFalsy();
    expect(JSON.stringify(created).length).toBeLessThan(300);
    const cData = sc<Record<string, unknown>>(created);
    expect(cData).toEqual({
      threadId: expect.any(String),
      commentId: expect.any(String),
      status: "open",
    });
    expect(cData).not.toHaveProperty("thread");
    expect(cData).not.toHaveProperty("comment");

    const threadId = cData.threadId as string;
    const replied = await tool(owner.client, "add_comment", {
      id,
      threadId,
      body: longBody,
    });
    expect(replied.isError, textOf(replied)).toBeFalsy();
    expect(JSON.stringify(replied).length).toBeLessThan(300);
    const rData = sc<Record<string, unknown>>(replied);
    // A plain reply never says the thread's status: it does not know it.
    expect(rData).toEqual({ threadId, commentId: expect.any(String) });
    expect(rData).not.toHaveProperty("thread");
    expect(rData).not.toHaveProperty("comment");

    const verboseThread = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", {
        id,
        body: "verbose thread",
        verbose: true,
      }),
    );
    expect(verboseThread.thread.comments[0]?.body).toBe("verbose thread");

    const verboseReply = sc<{ threadId: string; comment: Comment }>(
      await tool(owner.client, "add_comment", {
        id,
        threadId,
        body: "verbose reply",
        verbose: true,
      }),
    );
    expect(verboseReply.threadId).toBe(threadId);
    expect(verboseReply.comment.body).toBe("verbose reply");
  });

  it("resolve_comment and withdraw_ask omit thread/comment by default and keep full fields with verbose: true", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });

    const asked = await tool(owner.client, "add_comment", {
      id,
      body: "Which layout?",
      ask: ASK([reader.userId]),
    });
    expect(asked.isError, textOf(asked)).toBeFalsy();
    expect(JSON.stringify(asked).length).toBeLessThan(300);
    const askData = sc<{
      threadId: string;
      commentId: string;
      askId: string;
      status: string;
    }>(asked);
    expect(askData).toEqual({
      threadId: expect.any(String),
      commentId: expect.any(String),
      askId: askData.commentId,
      status: "open",
    });

    const withdrawn = await tool(owner.client, "withdraw_ask", {
      id,
      threadId: askData.threadId,
      commentId: askData.commentId,
    });
    const wData = sc<Record<string, unknown>>(withdrawn);
    expect(wData).toEqual({
      threadId: askData.threadId,
      commentId: askData.commentId,
      askId: askData.commentId,
      status: "withdrawn",
    });
    expect(wData).not.toHaveProperty("thread");
    expect(wData).not.toHaveProperty("comment");

    const withdrawnVerbose = sc<{ threadId: string; comment: Comment }>(
      await tool(owner.client, "withdraw_ask", {
        id,
        threadId: askData.threadId,
        commentId: askData.commentId,
        verbose: true,
      }),
    );
    expect(withdrawnVerbose.threadId).toBe(askData.threadId);
    expect(withdrawnVerbose.comment.ask?.withdrawn?.at).toEqual(
      expect.any(String),
    );

    const resolved = await tool(owner.client, "resolve_comment", {
      id,
      threadId: askData.threadId,
    });
    const resData = sc<Record<string, unknown>>(resolved);
    expect(resData).toEqual({
      threadId: askData.threadId,
      commentId: askData.commentId,
      status: "resolved",
    });
    expect(resData).not.toHaveProperty("thread");
    expect(resData).not.toHaveProperty("comment");

    const reopenedVerbose = sc<{ thread: Thread }>(
      await tool(owner.client, "resolve_comment", {
        id,
        threadId: askData.threadId,
        resolved: false,
        verbose: true,
      }),
    );
    expect(reopenedVerbose.thread.id).toBe(askData.threadId);
    expect(reopenedVerbose.thread.status).toBe("open");
    expect(reopenedVerbose.thread.comments[0]?.body).toBe("Which layout?");
  });
});

describe("the comment notice", () => {
  /** Notices are sent after the response (waitUntil): wait for `n` for this artifact. */
  const heard = async (id: string, n: number) => {
    await vi.waitFor(() =>
      expect(bus.sent.filter((s) => s.notice.artifactId === id)).toHaveLength(
        n,
      ),
    );
    return bus.sent.filter((s) => s.notice.artifactId === id);
  };

  it("goes once per comment to followers, never to the author, and carries no text", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "editor",
    });
    const addr = (name: string) => ({ namespace: "github.com/acme/app", name });
    await follow(E, owner.userId, addr("owner-agent"), id);
    await follow(E, reader.userId, addr("reader-agent"), id);

    // #2559: only a comment a person typed in the web app tells followers; a
    // token's (MCP) comment tells nobody (checked below).
    const t = (await (
      await api(app, comments(id), owner.cookie, {
        method: "POST",
        body: { anchor: { kind: "note" }, body: "SECRET BODY" },
      })
    ).json()) as Thread;
    // Only the follower who is not the author hears it.
    let got = await heard(id, 1);
    expect(got.map((s) => [s.userId, s.notice.kind, s.notice.to.name])).toEqual(
      [[reader.userId, "commented", "reader-agent"]],
    );
    const n = got[0]?.notice as BusNotice;
    expect(n.text).toContain("has a new comment");
    expect(n.text).toContain("list_comments");
    expect(n.text).not.toContain("SECRET");
    expect(n.text).not.toContain(owner.email);
    expect(n.notBefore).toBeUndefined();

    // A reply is a comment: one more, from the other side.
    await api(app, R.commentReplies(id, t.id), reader.cookie, {
      method: "POST",
      body: { body: "hi" },
    });
    got = await heard(id, 2);
    expect(got[1]?.userId).toBe(owner.userId);
    // A token's comment tells no follower.
    sc(await tool(owner.client, "add_comment", { id, body: "from a token" }));
    await settle(owner.client);
    expect(bus.sent.filter((s) => s.notice.artifactId === id)).toHaveLength(2);

    // A resolve is not a comment, and a refused comment is not one either.
    sc(await tool(owner.client, "resolve_comment", { id, threadId: t.id }));
    await tool(owner.client, "add_comment", { id, body: " " });
    // REST comments notify the same way.
    await follow(E, reader.userId, addr("reader-agent-2"), id);
    const r = await api(app, comments(id), owner.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "via rest" },
    });
    expect(r.status).toBe(201);
    // The reader's first agent heard a comment a moment ago, so only a new
    // address hears this one.
    got = await heard(id, 3);
    expect(got[2]?.notice.to.name).toBe("reader-agent-2");
    expect(got[2]?.userId).toBe(reader.userId);
  });

  const forId = (id: string) =>
    bus.sent.filter((s) => s.notice.artifactId === id);

  it("at most one per address per artifact per minute", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    await follow(E, reader.userId, { namespace: "ns/a", name: "r1" }, id);
    await follow(E, reader.userId, { namespace: "ns/a", name: "r2" }, id);
    const t = Date.now();
    await notifyCommented(E, id, 1, owner.userId, t);
    await notifyCommented(E, id, 1, owner.userId, t + 1_000);
    await notifyCommented(E, id, 1, owner.userId, t + 59_000);
    // One per address (two addresses), however many comments.
    expect(
      forId(id)
        .map((s) => s.notice.to.name)
        .sort(),
    ).toEqual(["r1", "r2"]);
    await notifyCommented(E, id, 1, owner.userId, t + CHANGED_WINDOW_MS);
    expect(forId(id)).toHaveLength(4);
    // `changed` keeps its own clock.
    await notifyChanged(E, id, 2, owner.userId, t);
    expect(forId(id).filter((s) => s.notice.kind === "changed")).toHaveLength(
      2,
    );
  });

  it("goes least recently notified first, so past the cap the tail is not starved", async () => {
    const id = await pub({ visibility: "team" });
    const members = await Promise.all(
      [0, 1, 2].map((i) => login(`mc-fan${i}-${tag}@x.com`)),
    );
    const rows: [string, string][] = [];
    for (let i = 0; i <= FANOUT_MAX; i++)
      rows.push([(members[i % 3] as { userId: string }).userId, `a${i}`]);
    await E.DB.batch(
      rows.map(([u, name]) =>
        E.DB.prepare(
          "insert into follows (user_id, artifact_id, namespace, agent_name, created_at) values (?, ?, 'ns', ?, 1)",
        ).bind(u, id, name),
      ),
    );
    const t = Date.now();
    await notifyCommented(E, id, 1, owner.userId, t);
    expect(forId(id)).toHaveLength(FANOUT_MAX);
    const heardNames = new Set(forId(id).map((s) => s.notice.to.name));
    const left = rows.map(([, n]) => n).filter((n) => !heardNames.has(n));
    expect(left).toHaveLength(1);
    await notifyCommented(E, id, 1, owner.userId, t + CHANGED_WINDOW_MS);
    expect(forId(id)[FANOUT_MAX]?.notice.to.name).toBe(left[0]);
  });

  it("a guest's comment is not announced", async () => {
    const id = await pub({ visibility: "public" });
    await follow(E, owner.userId, { namespace: "ns/g", name: "o" }, id);
    await notifyCommented(E, id, 1, null);
    expect(forId(id)).toEqual([]);
    const r = await api(app, comments(id), null, {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.7" },
      body: { anchor: { kind: "note" }, body: "from a guest" },
    });
    expect(r.status).toBe(201);
    // #2577: on a public page the list never applies, so a member's comment
    // is held too. `api` has already waited for the after-response work, so
    // nothing more can go out.
    expect(forId(id)).toEqual([]);
  });

  it("a follower who lost access gets nothing and loses the follow", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    await follow(E, reader.userId, { namespace: "ns/l", name: "r" }, id);
    await deleteShare(E, owner.member, id, reader.email);
    await notifyCommented(E, id, 1, owner.userId);
    expect(forId(id)).toEqual([]);
    const left = await E.DB.prepare(
      "select count(*) n from follows where artifact_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("a capped (restricted) follower gets nothing", async () => {
    const id = await pub({ visibility: "team" });
    const m = await login(`mc-cap-${tag}@x.com`);
    await follow(E, m.userId, { namespace: "ns/c", name: "m" }, id);
    await notifyCommented(E, id, 1, owner.userId);
    expect(forId(id)).toHaveLength(1);
    bus.sent = [];
    await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(m.userId)
      .run();
    await notifyCommented(E, id, 1, owner.userId, Date.now() + 120_000);
    expect(forId(id)).toEqual([]);
  });

  it("an agent already told by a mention is not told again as a follower", async () => {
    const id = await pub();
    const heardBy = (name: string) =>
      forId(id).filter((s) => s.notice.to.name === name);
    await follow(E, owner.userId, { namespace: "ns/m", name: "mentioned" }, id);
    await follow(E, owner.userId, { namespace: "ns/m", name: "bystander" }, id);
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "editor",
    });
    const agents = await api(app, R.artifactAgents(id), reader.cookie);
    const roster = (await agents.json()) as { key: string; name: string }[];
    const key = roster.find((a) => a.name.startsWith("mentioned"))?.key;
    expect(key).toBeTruthy();
    const r = await api(app, comments(id), reader.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "hey", mentions: [{ key }] },
    });
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(heardBy("bystander")).toHaveLength(1));
    // The mention's own notice (kind comment) only; no follower notice on top.
    expect(heardBy("mentioned").map((s) => s.notice.kind)).toEqual(["comment"]);
    expect(heardBy("bystander").map((s) => s.notice.kind)).toEqual([
      "commented",
    ]);
  });

  it("list_comments shows a member a removed agent, marked; a restricted caller gets no agents (#2174)", async () => {
    const id = await pub({ visibility: "team" });
    await follow(E, owner.userId, { namespace: "ns/r", name: "removable" }, id);
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "editor",
    });
    const roster = (await (
      await api(app, R.artifactAgents(id), reader.cookie)
    ).json()) as { key: string; name: string }[];
    const key = roster.find((a) => a.name.startsWith("removable"))?.key;
    expect(key).toBeTruthy();
    const t = (await (
      await api(app, comments(id), owner.cookie, {
        method: "POST",
        body: { anchor: { kind: "note" }, body: "hey", mentions: [{ key }] },
      })
    ).json()) as Thread;
    const gone = await api(
      app,
      R.commentThreadAgent(id, t.id, key as string),
      owner.cookie,
      { method: "DELETE" },
    );
    expect(gone.status).toBe(204);
    for (const who of [owner, reader]) {
      const l = sc<CommentList>(
        await tool(who.client, "list_comments", { id, status: "open" }),
      );
      expect(l.threads[0]?.agents?.map((a) => [a.name, a.removed])).toEqual([
        [expect.stringContaining("removable"), true],
      ]);
    }
    await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(reader.userId)
      .run();
    try {
      // The capped caller is refused outright (as with #2151), never shown the roster.
      await expect(
        tool(reader.client, "list_comments", { id, status: "open" }),
      ).rejects.toThrow(/Only members can connect agents/);
    } finally {
      await E.DB.prepare("update users set restricted_manual = 0 where id = ?")
        .bind(reader.userId)
        .run();
    }
  });
});
