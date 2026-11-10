import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ArtifactAgent,
  type BusNotice,
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
  THREAD_REPLY_NOTICES_MAX,
  THREAD_REPLY_WINDOW_MS,
} from "../src/services/comment-rules.js";
import { addReply, type CommentWho } from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { deleteShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #1900: an agent in a thread hears later replies from people.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  sent: { userId: string; notice: BusNotice }[] = [];
  outcome: DeliveryOutcome = "delivered";
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    if (notice.kind === "commented") return "delivered" as const;
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
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}
let owner: U;
let editor: U;
let viewer: U;
beforeAll(async () => {
  owner = await mk("tr-owner");
  editor = await mk("tr-editor");
  viewer = await mk("tr-viewer");
});

/** Owner follows with Claude and Pi; the editor with Codex. */
async function setup(extra: Record<string, unknown> = {}) {
  const a = await publish(
    E,
    owner.member,
    {
      title: "doc",
      format: "html",
      content: "<p>x</p>",
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
  await follow(E, owner.userId, { namespace: "ns-owner", name: "Pi" }, id);
  await follow(E, editor.userId, { namespace: "ns-editor", name: "Codex" }, id);
  const list = (await (
    await api(app, R.artifactAgents(id), owner.cookie)
  ).json()) as ArtifactAgent[];
  const key = (name: string) => {
    const k = list.find((x) => x.name.startsWith(name))?.key;
    if (!k) throw new Error(`no agent ${name}`);
    return k;
  };
  return { id, claude: key("Claude"), pi: key("Pi"), codex: key("Codex") };
}

const post = (id: string, u: U, body: object) =>
  api(app, R.comments(id), u.cookie, {
    method: "POST",
    body: { anchor: { kind: "note" }, body: "hello", ...body },
  });
const reply = (id: string, tid: string, u: U, body: object = {}) =>
  api(app, R.commentReplies(id, tid), u.cookie, {
    method: "POST",
    body: { body: "again", ...body },
  });
const threadReplies = () =>
  bus.sent.filter((x) => x.notice.coalesceKey.includes(":thread_reply:"));
const names = () =>
  threadReplies()
    .map((x) => x.notice.to.name)
    .sort();
const age = (id: string) =>
  runInDurableObject(
    runtimeStub(E, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (_i, state) => {
      state.storage.sql.exec(
        "update comment_reply_notices set last_at = '2000-01-01T00:00:00.000Z'",
      );
    },
  );
const counts = (id: string) =>
  runInDurableObject(
    runtimeStub(E, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "select coalesce(sum(n), 0) as n from comment_reply_notices",
        )
        .toArray()[0]?.n ?? 0,
  );

const agentWho = (
  u: U,
  ns: string,
  name: string,
  identified = true,
): CommentWho => ({
  kind: "user",
  id: u.userId,
  agent: {
    name,
    version: null,
    via: { kind: "token", id: "tok1" },
    ...(identified
      ? {
          identity: {
            identityId: `id-${name}`,
            namespace: ns,
            name,
            kind: "x",
          },
        }
      : {}),
  },
});
const viewerOf = (u: U) => ({ userId: u.userId, short: null, moderator: true });
const agentReply = (id: string, tid: string, w: CommentWho, u: U, x = {}) =>
  addReply(E, id, tid, w, viewerOf(u), "from an agent", x, { moderator: true });

describe("thread_reply notices (#1900)", () => {
  it("a person's later reply notifies the mentioned agent, not the others", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    expect((await reply(s.id, t.id, viewer)).status).toBe(201);
    expect(names()).toEqual(["Claude"]);
    const n = threadReplies()[0] as (typeof bus.sent)[number];
    expect(n.userId).toBe(owner.userId);
    expect(n.notice.to).toEqual({ namespace: "ns-owner", name: "Claude" });
    expect(n.notice.text).toContain(`Thread ${t.id}, comment `);
    expect(n.notice.text).not.toContain("again");
  });

  it("an assigned agent is a participant", async () => {
    const s = await setup();
    const t = (await (await post(s.id, editor, {})).json()) as Thread;
    await reply(s.id, t.id, editor, { assign: { key: s.pi } });
    bus.clear();
    await reply(s.id, t.id, viewer);
    expect(names()).toEqual(["Pi"]);
  });

  it("an agent that commented as a verified identity is a participant, only that agent", async () => {
    const s = await setup();
    const t = (await (await post(s.id, editor, {})).json()) as Thread;
    await agentReply(s.id, t.id, agentWho(owner, "ns-owner", "Claude"), owner);
    bus.clear();
    await reply(s.id, t.id, viewer);
    // Claude, not the same member's Pi, and not the editor's Codex.
    expect(names()).toEqual(["Claude"]);
  });

  it("an agent with no identity does not join by commenting", async () => {
    const s = await setup();
    const t = (await (await post(s.id, editor, {})).json()) as Thread;
    await agentReply(
      s.id,
      t.id,
      agentWho(owner, "ns-owner", "Claude", false),
      owner,
    );
    bus.clear();
    await reply(s.id, t.id, viewer);
    expect(names()).toEqual([]);
  });

  it("an agent's reply never fans out, but still reaches who it mentions", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    await agentReply(
      s.id,
      t.id,
      agentWho(editor, "ns-editor", "Codex"),
      editor,
    );
    expect(threadReplies()).toHaveLength(0);
    await agentReply(
      s.id,
      t.id,
      agentWho(editor, "ns-editor", "Codex"),
      editor,
      {
        mentions: [{ key: s.pi }],
      },
    );
    expect(threadReplies()).toHaveLength(0);
    expect(bus.sent.map((x) => x.notice.to.name)).toEqual(["Pi"]);
  });

  it("no second notice for the agent the same comment already mentioned", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }, { key: s.pi }] })
    ).json()) as Thread;
    bus.clear();
    await reply(s.id, t.id, editor, { mentions: [{ key: s.claude }] });
    expect(bus.sent.map((x) => x.notice.to.name).sort()).toEqual([
      "Claude",
      "Pi",
    ]);
    const claude = bus.sent.filter((x) => x.notice.to.name === "Claude");
    expect(claude).toHaveLength(1);
    expect(claude[0]?.notice.coalesceKey).not.toContain(":thread_reply:");
  });

  it("one notice per agent per window; again once the window has passed", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    await reply(s.id, t.id, viewer);
    await reply(s.id, t.id, viewer);
    expect(names()).toEqual(["Claude"]);
    await age(s.id);
    await reply(s.id, t.id, viewer);
    expect(names()).toEqual(["Claude", "Claude"]);
    expect(THREAD_REPLY_WINDOW_MS).toBeGreaterThan(0);
  });

  it("a thread notifies at most THREAD_REPLY_NOTICES_MAX times in all", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    for (let i = 0; i < THREAD_REPLY_NOTICES_MAX + 3; i++) {
      await age(s.id);
      expect((await reply(s.id, t.id, viewer)).status).toBe(201);
    }
    expect(threadReplies()).toHaveLength(THREAD_REPLY_NOTICES_MAX);
  });

  it("a resolved thread sends nothing; reopening resumes", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    const set = (status: string) =>
      api(app, R.commentThread(s.id, t.id), owner.cookie, {
        method: "PATCH",
        body: { status },
      });
    await set("resolved");
    bus.clear();
    await reply(s.id, t.id, viewer);
    expect(threadReplies()).toHaveLength(0);
    await set("open");
    await reply(s.id, t.id, viewer);
    expect(names()).toEqual(["Claude"]);
  });

  it("a participant whose person lost access is not notified, and the spend is given back", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, owner, { mentions: [{ key: s.codex }] })
    ).json()) as Thread;
    await deleteShare(E, owner.member, s.id, editor.email);
    bus.clear();
    await reply(s.id, t.id, viewer);
    expect(threadReplies()).toHaveLength(0);
    expect(await counts(s.id)).toBe(0);
  });

  it("a reply no session heard is given back, so the next one tries again", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    bus.outcome = "dropped";
    await reply(s.id, t.id, viewer);
    bus.outcome = "delivered";
    await reply(s.id, t.id, viewer);
    expect(names()).toEqual(["Claude", "Claude"]);
    expect(await counts(s.id)).toBe(1);
  });

  it("another person's agent that never took part is not notified", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    await reply(s.id, t.id, owner);
    expect(bus.sent.map((x) => x.notice.to.name)).not.toContain("Codex");
    expect(bus.sent.map((x) => x.notice.to.name)).not.toContain("Pi");
  });

  it("a signed-out guest's reply on a public artifact notifies participants like a person's", async () => {
    const s = await setup({ visibility: "public" });
    const t = (await (
      await post(s.id, owner, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    const r = await api(app, R.commentReplies(s.id, t.id), null, {
      method: "POST",
      body: { body: "hi from a guest" },
      headers: { "cf-connecting-ip": "198.51.100.21" },
    });
    expect(r.status).toBe(201);
    expect(names()).toEqual(["Claude"]);
    const n = threadReplies()[0]?.notice;
    // A guest wrote it: the notice reads as data, not as the user.
    expect(n?.text).not.toContain("Your user typed this");
    expect(n?.text).not.toContain("hi from a guest");
  });

  it("the text is fixed; a comment typed by the participant's own user carries the user tier", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    bus.clear();
    await reply(s.id, t.id, owner);
    expect(threadReplies()[0]?.notice.text).toContain("Your user typed this");
  });

  it("deleting the root drops the thread's participants and bound", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    await reply(s.id, t.id, viewer);
    const cid = t.comments[0]?.id as string;
    await api(app, R.comment(s.id, t.id, cid), owner.cookie, {
      method: "DELETE",
    });
    const rows = await runInDurableObject(
      runtimeStub(E, s.id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "select (select count(*) from comment_participants) + (select count(*) from comment_reply_notices) as n",
          )
          .toArray()[0]?.n,
    );
    expect(rows).toBe(0);
  });
});
