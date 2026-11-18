import { env } from "cloudflare:workers";
import {
  type ArtifactAgent,
  type BusNotice,
  type CommentList,
  type CompactCommentList,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import type { AgentAttr } from "../src/services/agent-usage.js";
import { publish } from "../src/services/artifacts.js";
import {
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import {
  addThread,
  type CommentViewer,
  type CommentWho,
  listComments,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { getUser } from "../src/services/users.js";
import { FakeHubs } from "./comment-hub.js";
import { listenEachOther } from "./held-listens.js";
import { api as baseApi, errOf, login } from "./helpers.js";

// #2688: list_comments answeredSince, mentionedSince and compact. The caller
// reads what it missed on one artifact, only its own asks and mentions of it.

const app = createApp();
const hubs = new FakeHubs();
/** The pool env; the mention test swaps in the stub hubs so identities resolve. */
let E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
/** The app called with this file's env (its stub bus hubs while swapped in). */
const api = (
  path: string,
  auth: string | null,
  init: Parameters<typeof baseApi>[3] = {},
) => baseApi(app, path, auth, init, E);
const NOTE = { kind: "note" };
const OPTS = [
  { id: "wide", label: "Wide hero" },
  { id: "compact", label: "Compact hero" },
];

class Quiet implements NoticeDelivery {
  async deliver(_e: Env, _u: string, _n: BusNotice) {
    return "delivered" as const;
  }
}
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(new Quiet());
});
afterAll(() => installDelivery(prev));

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email);
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

let owner: U;
let editor: U;
let reader: U;
let outsider: U;
beforeAll(async () => {
  owner = await mk("s-owner");
  editor = await mk("s-editor");
  reader = await mk("s-reader");
  outsider = await mk("s-out");
  await listenEachOther(E, [
    owner.userId,
    editor.userId,
    reader.userId,
    outsider.userId,
  ]);
});

const identityOf = (name: string) => ({
  identityId: `id-ns-${name}`,
  namespace: `ns-${name}`,
  name,
  kind: "x",
});
/** An agent of `u` with a verified bus identity. */
const agentOf = (u: U, name: string): AgentAttr => {
  const identity = {
    ...identityOf(
      `${name.toLowerCase()}-${u.userId.slice(0, 4).toLowerCase()}`,
    ),
    name,
  };
  hubs.set({ ...identity, owner: u.userId });
  return { name, version: null, via: { kind: "token", id: "t" }, identity };
};
const asAgent = (u: U, a: AgentAttr): CommentWho => ({
  kind: "user",
  id: u.userId,
  agent: a,
});
const viewerOf = (u: U, a?: AgentAttr): CommentViewer => ({
  userId: u.userId,
  short: null,
  ...(a ? { agent: a } : {}),
});

async function setup() {
  const a = await publish(
    E,
    owner.member,
    {
      title: "doc",
      format: "html",
      content: "<p>hi</p>",
      visibility: "private",
    } as never,
    null,
    undefined,
    "create",
  );
  for (const [u, role] of [
    [editor, "editor"],
    [reader, "viewer"],
  ] as const)
    await api(R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role },
    });
  return a.id;
}

/** A thread with an ask from `as`, put to the reader, decided by the owner. */
async function askBy(id: string, as: CommentWho, v: CommentViewer, q: string) {
  const art = { id, format: "html", currentVersion: 1 } as never;
  const t = await addThread(
    E,
    art,
    as,
    v,
    {
      anchor: NOTE,
      body: "Which?",
      ask: {
        question: q,
        options: OPTS,
        to: [{ key: reader.userId }],
      },
    },
    { moderator: true },
  );
  return { threadId: t.id, commentId: t.comments[0]?.id as string };
}
const answerIt = (id: string, t: { threadId: string; commentId: string }) =>
  api(R.commentAnswer(id, t.threadId, t.commentId), owner.cookie, {
    method: "POST",
    body: { optionId: "wide" },
  });
const iso = (ms: number) => new Date(ms).toISOString();
const compact = (
  id: string,
  v: CommentViewer,
  since: { answeredSince?: string; mentionedSince?: string },
) =>
  listComments(E, id, "all", v, {
    ...since,
    compact: true,
  }) as Promise<CompactCommentList>;

describe("answeredSince (#2688)", () => {
  it("lists answers to the caller's own asks after T; T equal to answer.at is excluded; another member's agent never appears", async () => {
    const id = await setup();
    const mine = agentOf(owner, "Claude");
    const theirs = agentOf(editor, "Codex");
    const a = await askBy(id, asAgent(owner, mine), viewerOf(owner), "Mine?");
    const b = await askBy(
      id,
      asAgent(editor, theirs),
      viewerOf(editor),
      "Theirs?",
    );
    const c = await askBy(
      id,
      asAgent(owner, mine),
      viewerOf(owner),
      "Unanswered?",
    );
    expect((await answerIt(id, a)).status).toBe(200);
    // The editor's agent's ask is decided by the editor.
    expect(
      (
        await api(R.commentAnswer(id, b.threadId, b.commentId), editor.cookie, {
          method: "POST",
          body: { optionId: "wide" },
        })
      ).status,
    ).toBe(200);
    const all = (await listComments(
      E,
      id,
      "all",
      viewerOf(owner, mine),
    )) as CommentList;
    const at = all.threads
      .flatMap((t) => t.comments)
      .find((x) => x.id === a.commentId)?.ask?.answer?.at as string;
    const t0 = Date.parse(at);

    const before = await compact(id, viewerOf(owner, mine), {
      answeredSince: iso(t0 - 1),
    });
    expect(before).toEqual({
      answers: [
        {
          threadId: a.threadId,
          commentId: a.commentId,
          question: "Mine?",
          optionId: "wide",
          label: "Wide hero",
          at,
          by: expect.any(String),
          yes: true,
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(before)).not.toContain(b.commentId);
    expect(JSON.stringify(before)).not.toContain(c.commentId);
    // T equal to answer.at: excluded. T after: excluded.
    for (const t of [t0, t0 + 1, t0 + 60_000])
      expect(
        await compact(id, viewerOf(owner, mine), { answeredSince: iso(t) }),
      ).toEqual({ answers: [], truncated: false });
    // The other member's agent sees only its own.
    const editorSees = await compact(id, viewerOf(editor, theirs), {
      answeredSince: iso(t0 - 60_000),
    });
    expect(editorSees.answers?.map((x) => x.commentId)).toEqual([b.commentId]);
    // A different agent of the same member does not read this agent's asks.
    const sibling = agentOf(owner, "Other");
    expect(
      (
        await compact(id, viewerOf(owner, sibling), {
          answeredSince: iso(t0 - 1),
        })
      ).answers,
    ).toEqual([]);
  });

  it("an ask posted while unlinked is found by the same connection, linked or not, and not by another connection", async () => {
    const id = await setup();
    const unlinked: AgentAttr = {
      name: "Claude",
      version: null,
      via: { kind: "token", id: "conn1" },
    };
    const a = await askBy(
      id,
      asAgent(owner, unlinked),
      viewerOf(owner),
      "Late?",
    );
    await answerIt(id, a);
    const since = { answeredSince: iso(0) };
    const ids = async (v: AgentAttr) =>
      (await compact(id, viewerOf(owner, v), since)).answers?.map(
        (x) => x.commentId,
      );
    expect(await ids(unlinked)).toEqual([a.commentId]);
    const linked = agentOf(owner, "Claude");
    expect(await ids({ ...linked, via: unlinked.via })).toEqual([a.commentId]);
    expect(
      await ids({ ...linked, via: { kind: "token", id: "conn2" } }),
    ).toEqual([]);
    expect(
      await ids({ ...unlinked, via: { kind: "token", id: "conn2" } }),
    ).toEqual([]);
  });

  it("without compact it returns the full threads that hold a match", async () => {
    const id = await setup();
    const mine = agentOf(owner, "Claude");
    const a = await askBy(id, asAgent(owner, mine), viewerOf(owner), "Mine?");
    await askBy(id, asAgent(owner, mine), viewerOf(owner), "Open?");
    await answerIt(id, a);
    const out = (await listComments(E, id, "all", viewerOf(owner, mine), {
      answeredSince: iso(0),
    })) as CommentList;
    expect(out.threads.map((t) => t.id)).toEqual([a.threadId]);
    expect(out.threads[0]?.comments[0]?.ask?.answer?.optionId).toBe("wide");
  });
});

describe("mentionedSince (#2688)", () => {
  const real = E;
  beforeAll(() => {
    E = hubs.env();
  });
  afterAll(() => {
    E = real;
  });
  it("lists comments after T that mention the caller's agent, with a 200 character excerpt", async () => {
    const id = await setup();
    const mine = agentOf(owner, "Claude");
    await follow(
      E,
      owner.userId,
      { namespace: mine.identity?.namespace ?? "", name: "Claude" },
      id,
    );
    const keys = (await (
      await api(R.artifactAgents(id), owner.cookie)
    ).json()) as ArtifactAgent[];
    const key = keys.find((k) => k.name.startsWith("Claude"))?.key as string;
    const long = "x".repeat(300);
    const r = await api(R.comments(id), editor.cookie, {
      method: "POST",
      body: { anchor: NOTE, body: long, mentions: [{ key }] },
    });
    expect(r.status).toBe(201);
    const t = (await r.json()) as CommentList["threads"][number];
    const c = t.comments[0];
    const at = Date.parse(c?.createdAt as string);
    // Another comment with no mention.
    await api(R.comments(id), editor.cookie, {
      method: "POST",
      body: { anchor: NOTE, body: "no mention" },
    });
    const got = await compact(id, viewerOf(owner, mine), {
      mentionedSince: iso(at - 1),
    });
    expect(got.answers).toBeUndefined();
    expect(got.mentions).toEqual([
      {
        threadId: t.id,
        commentId: c?.id,
        at: c?.createdAt,
        by: expect.any(String),
        excerpt: "x".repeat(200),
      },
    ]);
    expect(
      (await compact(id, viewerOf(owner, mine), { mentionedSince: iso(at) }))
        .mentions,
    ).toEqual([]);
    // Another agent of the same member is not the one mentioned.
    expect(
      (
        await compact(id, viewerOf(owner, agentOf(owner, "Other")), {
          mentionedSince: iso(at - 1),
        })
      ).mentions,
    ).toEqual([]);
  });
});

describe("the route (#2688)", () => {
  it("no new params: the list is unchanged; a bad ISO or a lone compact is 400", async () => {
    const id = await setup();
    const mine = agentOf(owner, "Claude");
    const a = await askBy(id, asAgent(owner, mine), viewerOf(owner), "Mine?");
    await answerIt(id, a);
    const plain = (await (
      await api(R.comments(id), owner.cookie)
    ).json()) as CommentList;
    expect(Object.keys(plain).sort()).toEqual(["open", "threads", "truncated"]);
    expect(plain.threads).toHaveLength(1);
    for (const q of [
      "answeredSince=yesterday",
      "mentionedSince=1700000000",
      "compact=true",
      "compact=yes",
    ]) {
      const r = await api(`${R.comments(id)}?${q}`, owner.cookie);
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("bad_request");
    }
  });

  it("the owner's session reads its own asks; a reader and a stranger see no more than before", async () => {
    const id = await setup();
    const mine = agentOf(owner, "Claude");
    const a = await askBy(id, asAgent(owner, mine), viewerOf(owner), "Mine?");
    await answerIt(id, a);
    const q = `?answeredSince=${encodeURIComponent(iso(0))}&compact=true`;
    const own = await api(`${R.comments(id)}${q}`, owner.cookie);
    expect(((await own.json()) as CompactCommentList).answers).toHaveLength(1);
    const rd = await api(`${R.comments(id)}${q}`, reader.cookie);
    expect(rd.status).toBe(200);
    expect(await rd.json()).toEqual({ answers: [], truncated: false });
    const full = await api(
      `${R.comments(id)}?answeredSince=${encodeURIComponent(iso(0))}`,
      reader.cookie,
    );
    expect(((await full.json()) as CommentList).threads).toEqual([]);
    expect((await api(`${R.comments(id)}${q}`, outsider.cookie)).status).toBe(
      404,
    );
  });
});
