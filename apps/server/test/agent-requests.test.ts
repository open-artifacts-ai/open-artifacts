import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type Comment,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.js";
import { callerOf } from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { runtimeStub } from "../src/runtime/do.js";
import {
  allow,
  allowChallenge,
  decide,
  HELD_PER_PAIR_MAX,
  lapseHeld,
  listenBinding,
  listHeld,
  notNow,
} from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { reservePicture } from "../src/services/comment-pictures.js";
import {
  addReply,
  addThread,
  answerAsk,
  artifactAgents,
  type CommentViewer,
  type CommentWho,
  editComment,
  listComments,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { inboxOf, needsYouCount } from "../src/services/inbox.js";
import {
  HELD_EXCERPT,
  recordCommentItems,
} from "../src/services/inbox-items.js";
import {
  giveBackReceiverSlot,
  takeReceiverSlot,
} from "../src/services/mention-guards.js";
import { deleteShare, putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, fetchAndWait, login } from "./helpers.js";
import { close, connect, tool } from "./mcp-helpers.js";
import { png } from "./picture-fixtures.js";

// #2577: asking someone else's agent. The comment posts; its delivery to the
// receiver's agents is held until the receiver allows it or the sender is on
// their list. The receiver's own agents read a placeholder meanwhile.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  sent: { userId: string; notice: BusNotice }[] = [];
  outcome: DeliveryOutcome = "delivered";
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    if (notice.kind === "commented") {
      this.sent.push({ userId, notice });
      return "delivered" as const;
    }
    this.sent.push({ userId, notice });
    return this.outcome;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => installDelivery(prev));
beforeEach(async () => {
  bus.sent = [];
  await E.DB.prepare(
    "delete from counters where key like 'notice:mention:%'",
  ).run();
});

type U = { userId: string; member: Member; email: string; cookie: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { userId: l.userId, member: m, email, cookie: l.cookie };
}
let owner: U;
let editor: U;
beforeAll(async () => {
  owner = await mk("ar-owner");
  editor = await mk("ar-editor");
});

const typed = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  typed: true,
});
const token = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const view = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
});
/** A viewer that is an agent of `u` (a token or MCP grant). */
const asAgent = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  agent: { name: "Claude", version: null, via: { kind: "token", id: "t1" } },
});
const NOTE = { kind: "note" } as const;
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;

/** The owner's agent as a publisher: its versions carry an agent name. */
const OWNER_AGENT = { name: "Claude", version: null };

async function setup(
  extra: Record<string, unknown> = {},
  publisher: { name: string; version: string | null } | null = null,
) {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>", ...extra } as never,
    publisher,
    undefined,
    "create",
  );
  await putShare(E, owner.member, a.id, {
    email: editor.email,
    role: "editor",
  });
  await follow(E, owner.userId, { namespace: "ns-o", name: "Claude" }, a.id);
  await follow(E, editor.userId, { namespace: "ns-e", name: "Codex" }, a.id);
  const list = await artifactAgents(E, a.id, editor.userId);
  const claude = list.find((x) => x.name.startsWith("Claude"))?.key as string;
  const codex = list.find((x) => x.name.startsWith("Codex"))?.key as string;
  return { id: a.id, claude, codex };
}

const post = (
  id: string,
  who: CommentWho,
  u: U,
  body: string,
  extra: Record<string, unknown> = {},
) =>
  addThread(
    E,
    art(id),
    who,
    view(u),
    { anchor: NOTE, body, ...extra },
    { moderator: true },
  ) as Promise<Thread>;
const mention = (key: string) => ({ mentions: [{ key }] });
/** Notices to the owner's agents about one page (earlier tests' background notices must not bleed in). */
const toOwnerAgent = (id: string) =>
  bus.sent.filter(
    (x) => x.userId === owner.userId && x.notice.artifactId === id,
  );
/** The owner's held requests on one page (the owner collects holds from every test). */
const held = async (id: string, u: U = owner) =>
  (await listHeld(E, u.userId)).requests.filter((r) => r.artifact.id === id);
const listAs = async (id: string, v: CommentViewer) =>
  (await listComments(E, id, "all", v)).threads;

describe("holding", () => {
  it("a mention of someone else's agent posts, sends nothing, and reads waiting to the asker", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "where does the 42% come from?",
      mention(s.claude),
    );
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    // The asker's view: the comment, the mention still queued, nothing refused.
    const seen = (await listAs(s.id, view(editor)))[0]?.comments[0];
    expect(seen?.body).toBe("where does the 42% come from?");
    expect(seen?.mentions?.[0]?.delivery).toBe("queued");
    const [r] = await held(s.id);
    expect(r?.sender.id).toBe(editor.userId);
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0]?.body).toBe("where does the 42% come from?");
    expect(t.comments[0]?.body).toContain("42%");
    // A new request is audited once, however many comments follow.
    await post(s.id, typed(editor), editor, "and again?", mention(s.claude));
    const { results: audited } = await env.DB.prepare(
      "select target_id from audit_events where action = 'agent_ask.held' and actor_id = ?1 and target_id = ?2",
    )
      .bind(editor.userId, owner.userId)
      .all<{ target_id: string }>();
    expect(audited).toHaveLength(1);
  });

  it("the receiver's agents read a placeholder in every list; the person and the asker read the words", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "secret words", mention(s.claude));
    const agentView = (await listAs(s.id, asAgent(owner)))[0]?.comments[0];
    expect(agentView?.body).toContain("is waiting for your person");
    expect(JSON.stringify(agentView)).not.toContain("secret words");
    expect((await listAs(s.id, view(owner)))[0]?.comments[0]?.body).toBe(
      "secret words",
    );
    expect((await listAs(s.id, view(editor)))[0]?.comments[0]?.body).toBe(
      "secret words",
    );
  });

  it("an agent's or a token's comment holds nothing and wakes nothing", async () => {
    const s = await setup();
    await post(s.id, token(editor), editor, "from a token", mention(s.claude));
    expect(toOwnerAgent(s.id).map((x) => x.notice.text.slice(0, 90))).toEqual(
      [],
    );
    expect(await held(s.id)).toHaveLength(0);
  });

  it("a note on the page where the page agent is someone else's is held too, and a follower notice from a non-listed member goes nowhere", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "a plain note");
    expect(toOwnerAgent(s.id)).toHaveLength(0);
  });
});

describe("allow", () => {
  it("once passes exactly the shown words, marks them as a teammate's, and unmasks", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "one", mention(s.claude));
    const [r] = await held(s.id);
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    expect(out).toEqual({ sent: 1, changed: 0, waiting: 0 });
    expect(toOwnerAgent(s.id).map((x) => x.notice.to.name)).toEqual(["Claude"]);
    // Delivered as someone else's words, never as the receiver's own (the "your user" tier).
    expect(toOwnerAgent(s.id)[0]?.notice.text).not.toContain("Your user typed");
    expect(toOwnerAgent(s.id)[0]?.notice.text).toContain(
      "Someone else wrote this.",
    );
    expect((await listAs(s.id, asAgent(owner)))[0]?.comments[0]?.body).toBe(
      "one",
    );
    expect(await held(s.id)).toHaveLength(0);
    // Once is once: the next request asks again.
    await post(s.id, typed(editor), editor, "two", mention(s.claude));
    expect(await held(s.id)).toHaveLength(1);
  });

  it("an edit after the notice is never delivered", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "before",
      mention(s.claude),
    );
    const [r] = await held(s.id);
    const shown = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    await editComment(
      E,
      s.id,
      t.id,
      t.comments[0]?.id as string,
      typed(editor),
      view(editor),
      "after, with new words",
    );
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: shown,
    });
    expect(out).toEqual({ sent: 0, changed: 1, waiting: 0 });
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    // Still masked, and the notice now shows the new words with a new hash.
    expect(
      JSON.stringify((await listAs(s.id, asAgent(owner)))[0]?.comments[0]),
    ).not.toContain("new words");
    const again = (await held(s.id))[0]?.items[0];
    expect(again?.body).toBe("after, with new words");
    expect(again?.wordsHash).not.toBe(shown[0]?.wordsHash);
  });

  it("an edit after an allow sends the request back to held: masked again, allowed only on the new words (#2577)", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "first words",
      mention(s.claude),
    );
    const commentId = t.comments[0]?.id as string;
    const [r] = await held(s.id);
    const items = (rr: typeof r) =>
      (rr?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      }));
    await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: items(r),
    });
    expect(toOwnerAgent(s.id)).toHaveLength(1);
    expect((await listAs(s.id, asAgent(owner)))[0]?.comments[0]?.body).toBe(
      "first words",
    );
    // The same words again change nothing.
    await editComment(
      E,
      s.id,
      t.id,
      commentId,
      typed(editor),
      view(editor),
      "first words",
    );
    expect(await held(s.id)).toHaveLength(0);
    // New words: held again, masked, and the first allow is spent.
    await editComment(
      E,
      s.id,
      t.id,
      commentId,
      typed(editor),
      view(editor),
      "second, different words",
    );
    const [again] = await held(s.id);
    expect(again?.items[0]?.body).toBe("second, different words");
    expect(
      JSON.stringify((await listAs(s.id, asAgent(owner)))[0]?.comments[0]),
    ).not.toContain("second");
    expect(
      await allow(E, owner.userId, again?.id as string, {
        level: "once",
        items: items(r),
      }),
    ).toEqual({ sent: 0, changed: 1, waiting: 0 });
    expect(toOwnerAgent(s.id)).toHaveLength(1);
    // Allowed at the words shown now: delivered once more.
    expect(
      await allow(E, owner.userId, again?.id as string, {
        level: "once",
        items: items(again),
      }),
    ).toEqual({ sent: 1, changed: 0, waiting: 0 });
    expect(toOwnerAgent(s.id)).toHaveLength(2);
    // Allowing a request that is already allowed delivers nothing twice.
    expect(
      await allow(E, owner.userId, again?.id as string, {
        level: "once",
        items: items(again),
      }),
    ).toMatchObject({ sent: 0 });
    expect(toOwnerAgent(s.id)).toHaveLength(2);
  });

  it("a hash that is not the one shown, or someone else's request, passes nothing", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: [
        {
          commentId: r?.items[0]?.commentId as string,
          wordsHash: "0".repeat(64),
        },
      ],
    });
    expect(out.sent).toBe(0);
    await expect(
      allow(E, editor.userId, r?.id as string, {
        level: "once",
        items: [{ commentId: "c", wordsHash: "0".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("for this page lists the sender: later requests go straight to the agent", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "first", mention(s.claude));
    const [r] = await held(s.id);
    // No passkey on this member: no assertion needed.
    await allow(E, owner.userId, r?.id as string, {
      level: "page",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    bus.sent = [];
    await post(s.id, typed(editor), editor, "second", mention(s.claude));
    expect(toOwnerAgent(s.id).map((x) => x.notice.to.name)).toEqual(["Claude"]);
    expect(await held(s.id)).toHaveLength(0);
    // The entry is live: it ends when the member loses edit rights on the page.
    await putShare(E, owner.member, s.id, {
      email: editor.email,
      role: "viewer",
    });
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
  });

  it("the list never applies on a page open to anyone with the link", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    await allow(E, owner.userId, r?.id as string, {
      level: "page",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(s.id)
      .run();
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
  });

  it("all pages and a space are refused on a page that is open to anyone with the link (#2905)", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(s.id)
      .run();
    const listed = () =>
      E.DB.prepare(
        "select count(*) as n from agent_listens where owner_id = ? and member_id = ? and (scope = 'all' or artifact_id = ?)",
      )
        .bind(owner.userId, editor.userId, s.id)
        .first<{ n: number }>()
        .then((x) => x?.n);
    const before = await listed();
    for (const level of ["all", "page"] as const)
      await expect(
        allow(E, owner.userId, r?.id as string, {
          level,
          items,
          until: Date.now() + 30 * 86_400_000,
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
    expect(await listed()).toBe(before);
  });

  it("all pages needs no passkey, but an end date within a year (#2864)", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    const until = Date.now() + 30 * 86_400_000;
    await expect(
      allow(E, owner.userId, r?.id as string, {
        level: "all",
        items,
        until: Date.now() + 400 * 86_400_000,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "all",
      items,
      until,
    });
    expect(out.sent).toBe(1);
    expect(
      (
        await E.DB.prepare(
          "select count(*) as n from agent_listens where owner_id = ? and member_id = ? and scope = 'all'",
        )
          .bind(owner.userId, editor.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await E.DB.prepare("delete from agent_listens where owner_id = ?")
      .bind(owner.userId)
      .run();
  });

  it("not now quiets the sender for a day and changes nothing the asker sees", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    await notNow(E, owner.userId, r?.id as string);
    const row = await E.DB.prepare(
      "select quiet_until as q from held_requests where id = ?",
    )
      .bind(r?.id)
      .first<{ q: number }>();
    expect(row?.q).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(
      (await listAs(s.id, view(editor)))[0]?.comments[0]?.mentions?.[0]
        ?.delivery,
    ).toBe("queued");
  });

  it("the hourly limit sends what fits and leaves the rest held", async () => {
    const s = await setup();
    for (let n = 0; n < 3; n++)
      await post(s.id, typed(editor), editor, `m${n}`, mention(s.claude));
    const [r] = await held(s.id);
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    const hour = new Date().toISOString().slice(0, 13);
    await E.DB.prepare(
      "insert or replace into counters (key, day, n) values (?, ?, ?)",
    )
      .bind(`notice:mention:to:${owner.userId}`, hour, 39)
      .run();
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items,
    });
    expect(out.sent).toBe(1);
    expect(out.waiting).toBe(2);
    expect((await held(s.id))[0]?.items).toHaveLength(2);
  });
});

describe("all pages in a space", () => {
  const space = async (name: string) => {
    const id = `sp_${newId().slice(0, 10)}`;
    await E.DB.prepare(
      "insert into spaces (id, kind, name, created_at) values (?, 'shared', ?, ?)",
    )
      .bind(id, name, Date.now())
      .run();
    return members(id);
  };
  const members = async (spaceId: string) => {
    for (const u of [owner, editor])
      await E.DB.prepare(
        "insert or ignore into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', ?)",
      )
        .bind(spaceId, u.userId, Date.now())
        .run();
    return spaceId;
  };
  const move = (artifactId: string, spaceId: string) =>
    E.DB.prepare("update artifacts set space_id = ? where id = ?")
      .bind(spaceId, artifactId)
      .run();
  const listen = (spaceId: string) =>
    E.DB.prepare(
      `insert into agent_listens (id, owner_id, member_id, scope, space_id, until, created_via, created_at)
       values (?, ?, ?, 'space', ?, ?, 'allow_space', ?)`,
    )
      .bind(
        newId(),
        owner.userId,
        editor.userId,
        spaceId,
        Date.now() + 30 * 86_400_000,
        Date.now(),
      )
      .run();

  it("a page in the space delivers, a page moved out holds, and a page in another space holds", async () => {
    const launch = await space("Launch");
    const other = await space("Other");
    const s = await setup({}, OWNER_AGENT);
    // Every page is in some space: "moved out" is back to the owner's personal one.
    const home = (
      await E.DB.prepare("select space_id as s from artifacts where id = ?")
        .bind(s.id)
        .first<{ s: string }>()
    )?.s as string;
    await move(s.id, launch);
    await listen(launch);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    await post(s.id, typed(editor), editor, "in the space", mention(s.claude));
    expect(toOwnerAgent(s.id).map((x) => x.notice.to.name)).toEqual(["Claude"]);
    // Moved out of the space: the entry stops applying to it.
    await move(s.id, home);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
    // In another space: not covered.
    await move(s.id, other);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
    // Back in: covered again; and never on a page open to anyone with the link.
    await move(s.id, launch);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(s.id)
      .run();
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
  });

  it("covers only pages where the owner's own agent published: not one the sender made, not one where it was only mentioned (#2577)", async () => {
    const launch = await space("Launch");
    await listen(launch);
    const agentMade = await setup({}, OWNER_AGENT);
    const bySender = await setup(); // the owner's page, no agent publish
    // A page the sender created in the space: the owner's agent never published it.
    const mine = await publish(
      E,
      editor.member,
      { title: "theirs", format: "html", content: "<p>y</p>" } as never,
      { name: "Codex", version: null },
      undefined,
      "create",
    );
    await putShare(E, editor.member, mine.id, {
      email: owner.email,
      role: "editor",
    });
    for (const id of [agentMade.id, bySender.id, mine.id])
      await move(id, launch);
    expect(await decide(E, editor.userId, owner.userId, agentMade.id)).toBe(
      "deliver",
    );
    expect(await decide(E, editor.userId, owner.userId, bySender.id)).toBe(
      "hold",
    );
    expect(await decide(E, editor.userId, owner.userId, mine.id)).toBe("hold");
    // The owner's agent was only mentioned on the sender's page: still held.
    await follow(
      E,
      owner.userId,
      { namespace: "ns-o", name: "Claude" },
      mine.id,
    );
    expect(await decide(E, editor.userId, owner.userId, mine.id)).toBe("hold");
    // A personal space is never offered.
    await E.DB.prepare("update spaces set kind = 'personal' where id = ?")
      .bind(launch)
      .run();
    expect(await decide(E, editor.userId, owner.userId, agentMade.id)).toBe(
      "hold",
    );
    await E.DB.prepare("update spaces set kind = 'shared' where id = ?")
      .bind(launch)
      .run();
  });

  it("the confirm step counts the pages a space allow covers today", async () => {
    const launch = await space("Launch");
    const a = await setup({}, OWNER_AGENT);
    const b = await setup({}, OWNER_AGENT);
    const c = await setup(); // no agent publish: not counted
    for (const x of [a, b, c]) await move(x.id, launch);
    await post(c.id, typed(editor), editor, "x", mention(c.claude));
    const [r] = await held(c.id);
    expect(r?.space?.pagesCovered).toBe(
      (
        await E.DB.prepare(
          `select count(*) as n from artifacts a where a.space_id = ? and a.deleted_at is null
             and exists (select 1 from versions v where v.artifact_id = a.id and v.created_by = ? and v.agent_name is not null)`,
        )
          .bind(launch, owner.userId)
          .first<{ n: number }>()
      )?.n,
    );
    expect(r?.space?.pagesCovered).toBe(2);
  });

  it("the allow needs a page in a shared space and an end date, and no passkey", async () => {
    const s = await setup({}, OWNER_AGENT);
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    const until = Date.now() + 30 * 86_400_000;
    // Not in a space: nothing to allow.
    expect(r?.space).toBeNull();
    await expect(
      allow(E, owner.userId, r?.id as string, { level: "space", items, until }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const launch = await space("Launch");
    await move(s.id, launch);
    expect((await held(s.id))[0]?.space).toEqual({
      id: launch,
      name: "Launch",
      pagesCovered: 1,
    });
    await expect(
      allow(E, owner.userId, r?.id as string, {
        level: "space",
        items,
        until: Date.now() + 400 * 86_400_000,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    // #2864: no passkey, no assertion.
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "space",
      items,
      until,
    });
    expect(out.sent).toBe(1);
    await E.DB.prepare("delete from agent_listens where owner_id = ?")
      .bind(owner.userId)
      .run();
  });
});

describe("held on every path, and read nowhere (#2577)", () => {
  const LINKED = {
    name: "Claude",
    version: null,
    identity: {
      identityId: "id-pub-ar-1",
      namespace: "ns-o",
      name: "Claude",
      kind: "claude-code",
    },
  };

  it("a plain note to the page agent stores the held target and is masked for it", async () => {
    const s = await setup({}, LINKED as never);
    await post(s.id, typed(editor), editor, "note for the page agent");
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    const [r] = await held(s.id);
    expect(r?.items[0]?.way).toBe("page");
    expect(
      JSON.stringify((await listAs(s.id, asAgent(owner)))[0]?.comments[0]),
    ).not.toContain("note for the page agent");
    expect((await listAs(s.id, view(owner)))[0]?.comments[0]?.body).toBe(
      "note for the page agent",
    );
  });

  it("a reply that would wake the receiver's thread agent is held and masked", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(owner),
      owner,
      "ask Claude",
      mention(s.claude),
    );
    bus.sent = [];
    const reply = await addReply(
      E,
      s.id,
      t.id,
      typed(editor),
      view(editor),
      "reply secret",
      {},
      { moderator: true },
    );
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    expect((await held(s.id))[0]?.items[0]?.way).toBe("reply");
    const seen = (await listAs(s.id, asAgent(owner)))[0]?.comments.find(
      (c) => c.id === reply.id,
    );
    expect(JSON.stringify(seen)).not.toContain("reply secret");
  });

  it("the REST list masks for a token of the receiver, and shows the words to the person's session", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "rest secret", mention(s.claude));
    const pat = (await createPat(E, owner.userId, "owner token")).token;
    const viaToken = await (await api(app, R.comments(s.id), pat)).text();
    expect(viaToken).not.toContain("rest secret");
    expect(viaToken).toContain("is waiting for your person");
    const viaSession = await (
      await api(app, R.comments(s.id), owner.cookie)
    ).text();
    expect(viaSession).toContain("rest secret");
  });

  it("an ask held for the receiver is masked in its question and options, and out of the asks index until allowed", async () => {
    const s = await setup();
    const t = await addThread(
      E,
      art(s.id),
      typed(editor),
      view(editor),
      {
        anchor: NOTE,
        body: "ask secret",
        ask: {
          question: "secret question?",
          options: [
            { id: "a", label: "secret yes" },
            { id: "b", label: "secret no" },
          ],
          to: [{ key: s.claude }],
        },
      },
      { moderator: true },
    );
    const seen = JSON.stringify(
      (await listAs(s.id, asAgent(owner)))[0]?.comments[0],
    );
    for (const w of [
      "ask secret",
      "secret question",
      "secret yes",
      "secret no",
    ])
      expect(seen).not.toContain(w);
    const rows = await E.DB.prepare(
      "select open, held, question, asker from artifact_asks where addressee = ? and artifact_id = ? and comment_id = ?",
    )
      .bind(owner.userId, s.id, t.comments[0]?.id)
      .first<{
        open: number;
        held: number;
        question: string | null;
        asker: string | null;
      }>();
    expect(rows).toMatchObject({
      open: 0,
      held: 1,
      question: null,
      asker: null,
    });
    const me = callerOf(owner.member) as Parameters<typeof inboxOf>[1];
    expect(
      (await inboxOf(E, me)).needsYou.filter(
        (i) => i.kind === "ask" && i.artifact?.id === s.id,
      ),
    ).toHaveLength(0);
  });

  /** An env whose D1 refuses every write to the held request tables (#2733). */
  const noHoldRows = (): Env =>
    ({
      ...E,
      DB: new Proxy(E.DB, {
        get(t, k) {
          if (k === "prepare")
            return (sql: string) => {
              if (/held_requests|held_request_items/.test(sql))
                throw new Error("D1 down");
              return t.prepare(sql);
            };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    }) as Env;
  /** An env whose DO refuses to let go of a reply's up-front hold. */
  const noUnhold = (): Env =>
    ({
      ...E,
      ARTIFACT_RUNTIME: new Proxy(E.ARTIFACT_RUNTIME, {
        get(t, k) {
          if (k === "get")
            return (id: DurableObjectId) =>
              new Proxy(t.get(id) as object, {
                get(stubTarget, m) {
                  if (m === "commentsUnhold")
                    return async () => {
                      throw new Error("DO down");
                    };
                  const v = Reflect.get(stubTarget, m);
                  // An RPC method is not a plain function: call it, don't bind it.
                  return typeof v === "function"
                    ? (...args: unknown[]) => Reflect.apply(v, stubTarget, args)
                    : v;
                },
              });
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    }) as Env;
  const errLines = async (fn: () => Promise<unknown>) => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      }),
    );
    try {
      await fn();
    } finally {
      for (const x of spies) x.mockRestore();
    }
    return lines;
  };
  const maskedAndSeen = async (
    id: string,
    commentId: string,
    words: string,
  ) => {
    const agent = (await listAs(id, asAgent(owner)))[0]?.comments.find(
      (c) => c.id === commentId,
    );
    expect(JSON.stringify(agent)).not.toContain(words);
    const person = (await listAs(id, view(owner)))[0]?.comments.find(
      (c) => c.id === commentId,
    );
    expect(JSON.stringify(person)).toContain(words);
    const sender = (await listAs(id, view(editor)))[0]?.comments.find(
      (c) => c.id === commentId,
    );
    expect(JSON.stringify(sender)).toContain(words);
  };

  it("a mention whose D1 hold rows fail to write is still masked and undelivered; the failure is logged once, with no words (#2733)", async () => {
    const s = await setup();
    let t: Thread | undefined;
    const lines = await errLines(async () => {
      t = (await addThread(
        noHoldRows(),
        art(s.id),
        typed(editor),
        view(editor),
        { anchor: NOTE, body: "mention secret", mentions: [{ key: s.claude }] },
        { moderator: true },
      )) as Thread;
    });
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    await maskedAndSeen(s.id, t?.comments[0]?.id as string, "mention secret");
    expect(await held(s.id)).toHaveLength(0);
    const evts = lines.filter((l) => l.includes("hold_write_failed"));
    expect(evts).toHaveLength(1);
    expect(evts[0]).not.toContain("mention secret");
  });

  it("an ask whose D1 hold rows fail to write is still masked and undelivered (#2733)", async () => {
    const s = await setup();
    let t: Thread | undefined;
    const lines = await errLines(async () => {
      t = (await addThread(
        noHoldRows(),
        art(s.id),
        typed(editor),
        view(editor),
        {
          anchor: NOTE,
          body: "ask body secret",
          ask: {
            question: "ask question secret?",
            options: [
              { id: "a", label: "ask yes secret" },
              { id: "b", label: "ask no secret" },
            ],
            to: [{ key: s.claude }],
          },
        },
        { moderator: true },
      )) as Thread;
    });
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    const agent = JSON.stringify(
      (await listAs(s.id, asAgent(owner)))[0]?.comments[0],
    );
    for (const w of [
      "ask body secret",
      "ask question secret",
      "ask yes secret",
    ])
      expect(agent).not.toContain(w);
    const person = JSON.stringify(
      (await listAs(s.id, view(owner)))[0]?.comments[0],
    );
    expect(person).toContain("ask question secret");
    expect(t?.comments[0]?.body).toContain("ask body secret");
    expect(lines.filter((l) => l.includes("hold_write_failed"))).toHaveLength(
      1,
    );
  });

  it("a held thread reply whose D1 hold rows fail to write is still masked and undelivered (#2733)", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(owner),
      owner,
      "ask Claude",
      mention(s.claude),
    );
    bus.sent = [];
    let reply: Comment | undefined;
    const lines = await errLines(async () => {
      reply = (await addReply(
        noHoldRows(),
        s.id,
        t.id,
        typed(editor),
        view(editor),
        "reply secret",
        {},
        { moderator: true },
      )) as Comment;
    });
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    await maskedAndSeen(s.id, reply?.id as string, "reply secret");
    expect(await held(s.id)).toHaveLength(0);
    expect(lines.filter((l) => l.includes("hold_write_failed"))).toHaveLength(
      1,
    );
    expect(lines.join("\n")).not.toContain("reply secret");
  });

  describe("the original leak: whatever fails after a held reply is stored, the receiver's agents never read it (#2733)", () => {
    type Sab = {
      /** Throw on a D1 statement containing any of these. */
      sql?: RegExp;
      /** Throw on these DO methods (the reply's insert and the participant take still run). */
      rpc?: string[];
    };
    const sabotaged = (x: Sab): Env =>
      ({
        ...E,
        ...(x.sql
          ? {
              DB: new Proxy(E.DB, {
                get(t, k) {
                  if (k === "prepare")
                    return (q: string) => {
                      if (x.sql?.test(q)) throw new Error("D1 down");
                      return t.prepare(q);
                    };
                  const v = Reflect.get(t, k);
                  return typeof v === "function" ? v.bind(t) : v;
                },
              }),
            }
          : {}),
        ...(x.rpc
          ? {
              ARTIFACT_RUNTIME: new Proxy(E.ARTIFACT_RUNTIME, {
                get(t, k) {
                  if (k === "get")
                    return (id: DurableObjectId) =>
                      new Proxy(t.get(id) as object, {
                        get(st, m) {
                          if (typeof m === "string" && x.rpc?.includes(m))
                            return async () => {
                              throw new Error("DO down");
                            };
                          const v = Reflect.get(st, m);
                          return typeof v === "function"
                            ? (...a: unknown[]) => Reflect.apply(v, st, a)
                            : v;
                        },
                      });
                  const v = Reflect.get(t, k);
                  return typeof v === "function" ? v.bind(t) : v;
                },
              }),
            }
          : {}),
      }) as Env;
    // Each step after the insert on its own, then all of them at once.
    const cases: [string, Sab][] = [
      [
        "the decision (the person's list) can't be read",
        { sql: /agent_listens/ },
      ],
      [
        "the DO hold write and release fail",
        { rpc: ["commentsHold", "commentsUnhold"] },
      ],
      ["the D1 request rows fail", { sql: /held_requests|held_request_items/ }],
      [
        "the notice bookkeeping fails",
        {
          rpc: [
            "commentsReplyTargets",
            "commentsTargetStates",
            "commentsThreadReplyRefund",
          ],
        },
      ],
      [
        "everything after the insert fails",
        {
          sql: /agent_listens|held_requests|held_request_items/,
          rpc: [
            "commentsHold",
            "commentsUnhold",
            "commentsReplyTargets",
            "commentsTargetStates",
            "commentsThreadReplyRefund",
          ],
        },
      ],
    ];
    it.each(cases)("%s", async (_name, sab) => {
      const s = await setup();
      const t = await post(
        s.id,
        typed(owner),
        owner,
        "ask Claude",
        mention(s.claude),
      );
      bus.sent = [];
      let reply: Comment | undefined;
      await errLines(async () => {
        reply = (await addReply(
          sabotaged(sab),
          s.id,
          t.id,
          typed(editor),
          view(editor),
          "leak canary words",
          {},
          { moderator: true },
        )) as Comment;
      });
      // Never delivered, never readable by the receiver's agents, any list.
      expect(toOwnerAgent(s.id)).toHaveLength(0);
      const agentLists = JSON.stringify(await listAs(s.id, asAgent(owner)));
      expect(agentLists).not.toContain("leak canary words");
      const viaToken = await (
        await api(
          app,
          R.comments(s.id),
          (
            await createPat(E, owner.userId, "leak check")
          ).token,
        )
      ).text();
      expect(viaToken).not.toContain("leak canary words");
      // The sender and the receiver's person still read it.
      await maskedAndSeen(s.id, reply?.id as string, "leak canary words");
    });
  });

  it("a reply that would be delivered but whose hold can't be let go stays masked and undelivered (#2733)", async () => {
    const s = await setup();
    // The owner's agents hear the editor on this page.
    await E.DB.prepare(
      `insert into agent_listens (id, owner_id, member_id, scope, artifact_id, until, created_via, created_at)
       values (?1, ?2, ?3, 'page', ?4, ?5, 'settings', ?6)`,
    )
      .bind(
        newId(),
        owner.userId,
        editor.userId,
        s.id,
        Date.now() + 86_400_000,
        Date.now(),
      )
      .run();
    try {
      const t = await post(
        s.id,
        typed(owner),
        owner,
        "ask Claude",
        mention(s.claude),
      );
      bus.sent = [];
      let reply: Comment | undefined;
      const lines = await errLines(async () => {
        reply = (await addReply(
          noUnhold(),
          s.id,
          t.id,
          typed(editor),
          view(editor),
          "reply unreleased",
          {},
          { moderator: true },
        )) as Comment;
      });
      expect(toOwnerAgent(s.id)).toHaveLength(0);
      await maskedAndSeen(s.id, reply?.id as string, "reply unreleased");
      expect(
        lines.filter((l) => l.includes("hold_release_failed")),
      ).toHaveLength(1);
      // Control: with the release working, the same reply is delivered and readable.
      bus.sent = [];
      const ok = await addReply(
        E,
        s.id,
        t.id,
        typed(editor),
        view(editor),
        "reply released",
        {},
        { moderator: true },
      );
      expect(toOwnerAgent(s.id).length).toBeGreaterThan(0);
      const seen = (await listAs(s.id, asAgent(owner)))[0]?.comments.find(
        (c) => c.id === ok.id,
      );
      expect(JSON.stringify(seen)).toContain("reply released");
    } finally {
      await E.DB.prepare("delete from agent_listens where artifact_id = ?")
        .bind(s.id)
        .run();
    }
  });

  it("over the hold caps nothing is written to D1, but the comment is still masked and undelivered", async () => {
    const s = await setup();
    // Fill the sender's allowance with this receiver (other requests, same pair).
    const other = await setup();
    await post(other.id, typed(editor), editor, "x", mention(other.claude));
    const [req] = await held(other.id);
    for (let i = 0; i < HELD_PER_PAIR_MAX; i++)
      await E.DB.prepare(
        `insert into held_request_items (id, request_id, thread_id, comment_id, agent_key, way, state, created_at, expires_at)
         values (?, ?, ?, ?, ?, 'mention', 'held', ?, ?)`,
      )
        .bind(
          newId(),
          req?.id,
          "t",
          `c-fill-${tag}-${i}`,
          `k${i}`,
          Date.now(),
          Date.now() + 86_400_000,
        )
        .run();
    await post(s.id, typed(editor), editor, "capped secret", mention(s.claude));
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    expect(await held(s.id)).toHaveLength(0); // no D1 row
    expect(
      JSON.stringify((await listAs(s.id, asAgent(owner)))[0]?.comments[0]),
    ).not.toContain("capped secret");
    expect((await listAs(s.id, view(editor)))[0]?.comments[0]?.body).toBe(
      "capped secret",
    );
  });
});

describe("the sender's hourly limit comes before the hold (#2577)", () => {
  it("a sender over their limit creates no hold: the comment posts, nothing is held, nothing is woken", async () => {
    const s = await setup();
    const hour = new Date().toISOString().slice(0, 13);
    await E.DB.prepare(
      "insert or replace into counters (key, day, n) values (?, ?, ?)",
    )
      .bind(`notice:mention:from:${editor.userId}`, hour, 10)
      .run();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "over the limit",
      mention(s.claude),
    );
    expect(t.comments[0]?.body).toBe("over the limit");
    expect(await held(s.id)).toHaveLength(0);
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    // The words are not hidden by a hold that does not exist.
    expect((await listAs(s.id, asAgent(owner)))[0]?.comments[0]?.body).toBe(
      "over the limit",
    );
    // Under the limit it holds again (and takes the sender's slot once).
    await E.DB.prepare("delete from counters where key = ?")
      .bind(`notice:mention:from:${editor.userId}`)
      .run();
    await post(
      s.id,
      typed(editor),
      editor,
      "under the limit",
      mention(s.claude),
    );
    expect(await held(s.id)).toHaveLength(1);
  });
});

describe("review fixes (#2577, OA Axe W)", () => {
  const itemsOf = (
    r: { items: { commentId: string; wordsHash: string }[] } | undefined,
  ) =>
    (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));

  it("a receiver who can no longer open the page sees nothing, and an allow is a 404 that withdraws the items", async () => {
    const s = await setup();
    // The owner asks the editor's agent: held for the editor.
    await post(s.id, typed(owner), owner, "for your agent", mention(s.codex));
    const mine = async () =>
      (await listHeld(E, editor.userId)).requests.filter(
        (r) => r.artifact.id === s.id,
      );
    const [r] = await mine();
    expect(r?.items).toHaveLength(1);
    const me = callerOf(editor.member) as Parameters<typeof inboxOf>[1];
    const inboxItems = async () =>
      (await inboxOf(E, me)).needsYou.filter(
        (i) => i.kind === "request" && i.artifact?.id === s.id,
      );
    expect(await inboxItems()).toHaveLength(1);
    // The share is removed: the editor can no longer open the page.
    await deleteShare(E, owner.member, s.id, editor.email);
    expect(await mine()).toHaveLength(0);
    expect(await inboxItems()).toHaveLength(0);
    await expect(
      allow(E, editor.userId, r?.id as string, {
        level: "once",
        items: itemsOf(r),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const left = await E.DB.prepare(
      "select state from held_request_items where request_id = ?",
    )
      .bind(r?.id)
      .all<{ state: string }>();
    expect(left.results.every((x) => x.state === "withdrawn")).toBe(true);
  });

  it("no scope needs a passkey, even for a member who has one (#2864)", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    await E.DB.prepare(
      `insert into passkeys (id, user_id, credential_id, public_key, alg, label, created_at)
       values (?, ?, ?, 'pk', -7, 'test', ?)`,
    )
      .bind(newId(), owner.userId, `cred-${newId()}`, Date.now())
      .run();
    try {
      // The page level: no assertion, and it works.
      const out = await allow(E, owner.userId, r?.id as string, {
        level: "page",
        items: itemsOf(r),
      });
      expect(out.sent).toBe(1);
      expect(
        (
          await E.DB.prepare(
            "select count(*) as n from agent_listens where owner_id = ? and member_id = ? and scope = 'page' and artifact_id = ?",
          )
            .bind(owner.userId, editor.userId, s.id)
            .first<{ n: number }>()
        )?.n,
      ).toBe(1);
      // All pages need none either.
      await post(s.id, typed(editor), editor, "y", mention(s.claude)); // listed now: delivers
      await E.DB.prepare("delete from agent_listens where owner_id = ?")
        .bind(owner.userId)
        .run();
      await post(s.id, typed(editor), editor, "z", mention(s.claude));
      const [r2] = await held(s.id);
      const all = await allow(E, owner.userId, r2?.id as string, {
        level: "all",
        items: itemsOf(r2),
        until: Date.now() + 30 * 86_400_000,
      });
      expect(all.sent).toBe(1);
      await E.DB.prepare("delete from agent_listens where owner_id = ?")
        .bind(owner.userId)
        .run();
    } finally {
      await E.DB.prepare("delete from passkeys where user_id = ?")
        .bind(owner.userId)
        .run();
    }
  });

  it("a space-level passkey binding names its space", () => {
    const until = Date.now() + 86_400_000;
    expect(listenBinding("space", until, "sp_a")).not.toBe(
      listenBinding("space", until, "sp_b"),
    );
    expect(listenBinding("space", until, "sp_a")).toBe(
      listenBinding("space", until, "sp_a"),
    );
    expect(listenBinding("all", until)).toBe(`all:${until}`);
    expect(listenBinding("page", until)).toBe(`page:${until}`);
  });

  it("the receiver's agent or token cannot answer an ask while it is held for them", async () => {
    const s = await setup();
    const t = await addThread(
      E,
      art(s.id),
      typed(editor),
      view(editor),
      {
        anchor: NOTE,
        body: "Which?",
        ask: {
          question: "Which export?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          to: [{ key: s.claude }],
        },
      },
      { moderator: true },
    );
    await expect(
      answerAsk(
        E,
        s.id,
        t.id,
        t.comments[0]?.id as string,
        token(owner),
        asAgent(owner),
        "a",
        undefined,
        { interactive: false },
        { canDecide: true, guest: false },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a receiver slot taken for an allow that delivered nothing is given back", async () => {
    const hour = new Date().toISOString().slice(0, 13);
    const n = async () =>
      (
        await E.DB.prepare("select n from counters where key = ? and day = ?")
          .bind(`notice:mention:to:${owner.userId}`, hour)
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await n();
    expect(await takeReceiverSlot(E, owner.userId)).toBe(true);
    expect(await n()).toBe(before + 1);
    await giveBackReceiverSlot(E, owner.userId);
    expect(await n()).toBe(before);
  });

  it("a guest-role member of the page's space makes the page open: the list never applies, and no page counts", async () => {
    const launch = `sp_${newId().slice(0, 10)}`;
    await E.DB.prepare(
      "insert into spaces (id, kind, name, created_at) values (?, 'shared', 'Guesty', ?)",
    )
      .bind(launch, Date.now())
      .run();
    const guestLogin = await login(`ar-guest-${tag}@x.com`, "guest");
    for (const u of [owner.userId, editor.userId, guestLogin.userId])
      await E.DB.prepare(
        "insert or ignore into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', ?)",
      )
        .bind(launch, u, Date.now())
        .run();
    const s = await setup({}, OWNER_AGENT);
    await E.DB.prepare("update artifacts set space_id = ? where id = ?")
      .bind(launch, s.id)
      .run();
    await E.DB.prepare(
      `insert into agent_listens (id, owner_id, member_id, scope, space_id, until, created_via, created_at)
       values (?, ?, ?, 'space', ?, ?, 'allow_space', ?)`,
    )
      .bind(
        newId(),
        owner.userId,
        editor.userId,
        launch,
        Date.now() + 86_400_000,
        Date.now(),
      )
      .run();
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    expect((await held(s.id))[0]?.space?.pagesCovered).toBe(0);
  });
});

describe("the inbox", () => {
  it("one request item per sender and page, until allowed or quieted", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "one", mention(s.claude));
    await post(s.id, typed(editor), editor, "two", mention(s.claude));
    const me = callerOf(owner.member) as Parameters<typeof inboxOf>[1];
    const mine = async () =>
      (await inboxOf(E, me)).needsYou.filter(
        (i) => i.kind === "request" && i.artifact?.id === s.id,
      );
    const [item] = await mine();
    expect(await mine()).toHaveLength(1);
    expect(item).toMatchObject({
      level: "needs_you",
      urgency: "approval",
      artifact: { id: s.id },
    });
    expect(item?.text).toContain("wants to ask your agent");
    // The words are never in the item.
    expect(JSON.stringify(item)).not.toContain("one");
    expect((await needsYouCount(E, me)) >= 1).toBe(true);
    const [r] = await held(s.id);
    await notNow(E, owner.userId, r?.id as string);
    expect(await mine()).toHaveLength(0);
  });
  // #2577 (OA Axe W): an inbox item never stores the words of a request held for its person.
  const inboxVia = async (id: string, cred: string) =>
    JSON.stringify(
      (
        (await (await api(app, R.meInbox, cred)).json()) as {
          updates: { artifact?: { id: string } }[];
        }
      ).updates.filter((i) => i.artifact?.id === id),
    );
  const record = async (id: string, threadId: string) => {
    const t = await runtimeStub(E, id).commentsGet(threadId);
    await recordCommentItems(E, {
      artifactId: id,
      threadId,
      comment: t.comments[0] as never,
      reply: false,
    });
  };

  it("a held mention's item keeps a placeholder through a lapse and an edit, and the allow fills in the words", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "inbox secret",
      mention(s.claude),
    );
    await record(s.id, t.id);
    const pat = (await createPat(E, owner.userId, "inbox token")).token;
    for (const cred of [pat, owner.cookie]) {
      const seen = await inboxVia(s.id, cred);
      expect(seen).not.toContain("inbox secret");
      expect(seen).toContain(HELD_EXCERPT);
    }
    // An edit of the held comment writes no words either.
    await editComment(
      E,
      s.id,
      t.id,
      t.comments[0]?.id as string,
      typed(editor),
      view(editor),
      "edited secret",
    );
    expect(await inboxVia(s.id, pat)).not.toContain("edited secret");
    // The allow fills in the words the person allowed.
    const [r] = await held(s.id);
    await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    expect(await inboxVia(s.id, pat)).toContain("edited secret");
  });

  it("a held thread reply's item reads the placeholder until the allow, through the reply path itself", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(owner),
      owner,
      "ask Claude",
      mention(s.claude),
    );
    const waits: Promise<unknown>[] = [];
    const after = {
      version: 1,
      ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) },
    };
    await addReply(
      E,
      s.id,
      t.id,
      typed(editor),
      view(editor),
      "reply inbox secret",
      {},
      { moderator: true, after } as never,
    );
    await Promise.all(waits);
    const pat = (await createPat(E, owner.userId, "reply token")).token;
    const seen = await inboxVia(s.id, pat);
    expect(seen).toContain(HELD_EXCERPT);
    expect(seen).not.toContain("reply inbox secret");
    const [r] = await held(s.id);
    await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    expect(await inboxVia(s.id, pat)).toContain("reply inbox secret");
  });

  it("a lapsed hold's item still reads the placeholder", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "lapsed secret",
      mention(s.claude),
    );
    await record(s.id, t.id);
    await lapseHeld(E, Date.now() + 30 * 86_400_000);
    const pat = (await createPat(E, owner.userId, "lapse token")).token;
    expect(await inboxVia(s.id, pat)).not.toContain("lapsed secret");
  });

  it("a hold over the per-sender cap (no D1 row) still stores no words", async () => {
    const s = await setup();
    const other = await setup();
    await post(other.id, typed(editor), editor, "x", mention(other.claude));
    const [req] = await held(other.id);
    for (let i = 0; i < HELD_PER_PAIR_MAX; i++)
      await E.DB.prepare(
        `insert into held_request_items (id, request_id, thread_id, comment_id, agent_key, way, state, created_at, expires_at)
         values (?, ?, ?, ?, ?, 'mention', 'held', ?, ?)`,
      )
        .bind(
          newId(),
          req?.id,
          "t",
          `c-inbox-${tag}-${i}`,
          `k${i}`,
          Date.now(),
          Date.now() + 86_400_000,
        )
        .run();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "capped inbox secret",
      mention(s.claude),
    );
    expect(await held(s.id)).toHaveLength(0);
    await record(s.id, t.id);
    const pat = (await createPat(E, owner.userId, "cap token")).token;
    const seen = await inboxVia(s.id, pat);
    expect(seen).not.toContain("capped inbox secret");
    expect(seen).toContain(HELD_EXCERPT);
  });
});

describe("an ask addressed to someone else's agent", () => {
  it("posts as a card, the receiver's row stays closed and empty until they allow it", async () => {
    const s = await setup();
    await addThread(
      E,
      art(s.id),
      typed(editor),
      view(editor),
      {
        anchor: NOTE,
        body: "Which export?",
        ask: {
          question: "Which export do we use?",
          options: [
            { id: "weekly", label: "Weekly" },
            { id: "daily", label: "Daily" },
          ],
          to: [{ key: s.claude }],
        },
      },
      { moderator: true },
    );
    const row = await E.DB.prepare(
      "select open, held, question from artifact_asks where addressee = ? and artifact_id = ?",
    )
      .bind(owner.userId, s.id)
      .first<{ open: number; held: number; question: string | null }>();
    expect(row).toMatchObject({ open: 0, held: 1, question: null });
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    const [r] = await held(s.id);
    await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    const after = await E.DB.prepare(
      "select open, held, question from artifact_asks where addressee = ? and artifact_id = ?",
    )
      .bind(owner.userId, s.id)
      .first<{ open: number; held: number; question: string }>();
    expect(after).toMatchObject({
      open: 1,
      held: 0,
      question: "Which export do we use?",
    });
  });
});

describe("the sender's comment route", () => {
  it("shows request facts only to the sender's browser session", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "words", mention(s.claude));
    const pat = (await createPat(E, editor.userId, "comment reader")).token;
    const read = async (credential: string) => {
      const response = await api(app, R.comments(s.id), credential);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { threads: Thread[] };
      const comment = body.threads[0]?.comments[0];
      expect(comment).toBeDefined();
      return comment?.requestFacts;
    };
    expect(await read(editor.cookie)).toMatchObject([
      { key: s.claude, status: "waiting_owner" },
    ]);
    expect(await read(pat)).toBeUndefined();
    expect(await read(owner.cookie)).toBeUndefined();
  });
});

describe("the receiver's routes", () => {
  it("are a browser session of the receiver only", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const ok = await api(app, R.agentAskHeld, owner.cookie);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { requests: { items: unknown[] }[] };
    expect(body.requests[0]?.items).toHaveLength(1);
    // The sender sees none of it.
    const mine = await api(app, R.agentAskHeld, editor.cookie);
    expect(((await mine.json()) as { requests: unknown[] }).requests).toEqual(
      [],
    );
    // No credentials: refused.
    expect(
      (await api(app, R.agentAskHeld, null)).status,
    ).toBeGreaterThanOrEqual(401);
  });
});

describe("pictures of a held request (#2508, #2577)", () => {
  /** A picture the editor reserved and uploaded, ready to attach. */
  async function picture(id: string) {
    const bytes = png(6, 4, false);
    const r = await reservePicture(E, editor.member, id, {
      type: "image/png",
      bytes: bytes.length,
    });
    const u = new URL(r.url);
    const put = await fetchAndWait(
      app,
      new Request(`http://app.localhost${u.pathname}${u.search}`, {
        method: "PUT",
        headers: { "content-length": String(bytes.length) },
        body: bytes as BodyInit,
      }),
    );
    expect(put.status).toBe(200);
    return r.pictureId;
  }
  const picsOf = async (id: string, v: CommentViewer, commentId: string) =>
    (await listAs(id, v))
      .flatMap((t) => t.comments)
      .find((c) => c.id === commentId)?.pictures;
  const get = (id: string, pic: string, bearer: string) =>
    api(app, R.commentPicture(id, pic), bearer);

  async function check(
    s: { id: string },
    commentId: string,
    pic: string,
    release: () => Promise<void>,
  ) {
    const ownerToken = (await createPat(E, owner.userId, "pic token")).token;
    // Held: the receiver's agent reads neither the words nor the picture.
    expect(await picsOf(s.id, asAgent(owner), commentId)).toBeUndefined();
    expect((await get(s.id, pic, ownerToken)).status).toBe(404);
    const client = await connect(ownerToken);
    try {
      const read = () =>
        tool(client, "get_comment_picture", { id: s.id, pictureId: pic });
      const hidden = await read();
      expect(hidden.isError).toBe(true);
      expect(hidden.content).toEqual([
        { type: "text", text: "not_found: Not found" },
      ]);
      // The person (their session), and the sender, read it.
      expect(await picsOf(s.id, view(owner), commentId)).toHaveLength(1);
      expect((await get(s.id, pic, owner.cookie)).status).toBe(200);
      expect((await get(s.id, pic, editor.cookie)).status).toBe(200);
      await release();
      // After Allow, the agent reads the picture again.
      expect(await picsOf(s.id, asAgent(owner), commentId)).toHaveLength(1);
      expect((await get(s.id, pic, ownerToken)).status).toBe(200);
      const shown = await read();
      expect(shown.content).toEqual([
        {
          type: "image",
          mimeType: "image/png",
          data: btoa(String.fromCharCode(...png(6, 4, false))),
        },
      ]);
    } finally {
      await close(client);
    }
  }

  const allowOnce = async (id: string) => {
    const [r] = await held(id);
    await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
  };

  it("a held mention: hidden from the receiver's agent (list and GET), readable after Allow", async () => {
    const s = await setup();
    const pic = await picture(s.id);
    const t = await post(s.id, typed(editor), editor, "see this", {
      ...mention(s.claude),
      pictures: [{ pictureId: pic }],
    });
    await check(s, t.comments[0]?.id as string, pic, () => allowOnce(s.id));
  });

  it("a held thread reply: hidden from the receiver's agent (list and GET), readable after Allow", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(owner),
      owner,
      "ask Claude",
      mention(s.claude),
    );
    const pic = await picture(s.id);
    const reply = await addReply(
      E,
      s.id,
      t.id,
      typed(editor),
      view(editor),
      "reply with a picture",
      { pictures: [{ pictureId: pic }] },
      { moderator: true },
    );
    expect((await held(s.id))[0]?.items[0]?.way).toBe("reply");
    await check(s, reply.id, pic, () => allowOnce(s.id));
  });
});

describe("catch-up read masks like the plain list (#2688)", () => {
  const since = { mentionedSince: new Date(0).toISOString() };
  it("a held mention never shows its words to the receiver's agent, compact or not", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "secret words", mention(s.claude));
    expect((await held(s.id))[0]?.items).toHaveLength(1);
    const small = await listComments(E, s.id, "all", asAgent(owner), {
      ...since,
      compact: true,
    });
    expect(JSON.stringify(small)).not.toContain("secret words");
    expect(small).toEqual({ mentions: [], truncated: false });
    const full = await listComments(E, s.id, "all", asAgent(owner), since);
    expect(JSON.stringify(full)).not.toContain("secret words");
    expect(JSON.stringify(full)).toContain("is waiting for your person");
  });

  it("a guest-role member mentioned as a person reads the same names as the plain list", async () => {
    const s = await setup();
    const g = await login(`ar-gm-${tag}@x.com`, "guest");
    await putShare(E, owner.member, s.id, {
      email: `ar-gm-${tag}@x.com`,
      role: "viewer",
    });
    const agent = {
      kind: "user" as const,
      id: editor.userId,
      agent: {
        name: "Codex",
        version: null,
        via: { kind: "token" as const, id: "t2" },
      },
    };
    await post(s.id, agent, editor, "hi guest", { people: [g.userId] });
    const gv: CommentViewer = { userId: g.userId, short: null, guest: true };
    const plain = (await listComments(E, s.id, "all", gv)).threads
      .flatMap((t) => t.comments)
      .find((c) => c.body === "hi guest");
    const small = (await listComments(E, s.id, "all", gv, {
      ...since,
      compact: true,
    })) as { mentions?: { by: string; excerpt: string }[] };
    expect(small.mentions).toHaveLength(1);
    expect(small.mentions?.[0]?.by).toBe(plain?.author.name);
    expect(small.mentions?.[0]?.by).not.toBe("Codex");
  });
});
