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
import { api, login } from "./helpers.js";
import { connect, oauthToken, textOf, tool } from "./mcp-helpers.js";

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
  await Promise.all(clients.map((c) => c.close()));
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
});

describe("comment tools over MCP", () => {
  it("add, list, reply, resolve and reopen", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const t = sc<{ thread: Thread }>(
      (await reader.client.callTool({
        name: "add_comment",
        arguments: { id, body: "  Is this right?  " },
      })) as never,
    ).thread;
    expect(t.anchor).toEqual({ kind: "note" });
    expect(t.comments[0]).toMatchObject({
      body: "Is this right?",
      author: { kind: "user", me: true },
    });

    const reply = sc<{ comment: Comment }>(
      await tool(owner.client, "add_comment", {
        id,
        threadId: t.id,
        body: "Yes.",
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

    const done = sc<{ thread: Thread }>(
      await tool(reader.client, "resolve_comment", { id, threadId: t.id }),
    ).thread;
    expect(done.status).toBe("resolved");
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
    const again = sc<{ thread: Thread }>(
      await tool(reader.client, "resolve_comment", {
        id,
        threadId: t.id,
        resolved: false,
      }),
    ).thread;
    expect(again.status).toBe("open");

    // The same threads over REST.
    const rest = (await (
      await api(app, comments(id), owner.cookie)
    ).json()) as CommentList;
    expect(rest.threads.map((x) => x.id)).toEqual([t.id]);
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
    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "x" }),
    ).thread;
    expect(
      textOf(
        await tool(owner.client, "add_comment", {
          id,
          body: "y",
          threadId: t.id,
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
      ["add_comment", { body: "hi" }],
    ] as const) {
      const r = await tool(owner.client, name, { id, ...args });
      expect(textOf(r)).toMatch(/^comments_off: .*turn them on/);
    }
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

  it("an ask on a reply works", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "start" }),
    ).thread;
    const r = sc<{ comment: Comment }>(
      await tool(owner.client, "add_comment", {
        id,
        threadId: t.id,
        body: "Pick one",
        ask: ASK([reader.userId]),
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
    await bad({ options: [OPTS[0]] }, /options/);
    await bad({ options: two(7) }, /options/);
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
    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "start" }),
    ).thread;
    sc(await tool(owner.client, "resolve_comment", { id, threadId: t.id }));
    const args = {
      id,
      threadId: t.id,
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
        threadId: t.id,
        body: "plain",
      }),
    );
    sc(
      await tool(owner.client, "resolve_comment", {
        id,
        threadId: t.id,
        resolved: false,
      }),
    );
    sc(await tool(owner.client, "add_comment", args));
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
      role: "viewer",
    });
    const addr = (name: string) => ({ namespace: "github.com/acme/app", name });
    await follow(E, owner.userId, addr("owner-agent"), id);
    await follow(E, reader.userId, addr("reader-agent"), id);

    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "SECRET BODY" }),
    ).thread;
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
    sc(
      await tool(reader.client, "add_comment", {
        id,
        threadId: t.id,
        body: "hi",
      }),
    );
    got = await heard(id, 2);
    expect(got[1]?.userId).toBe(owner.userId);

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
    // A member's comment is the marker that the guest's sent nothing first.
    await tool(reader.client, "add_comment", { id, body: "member" });
    expect(await heardAll(id)).toBe(1);
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
});
