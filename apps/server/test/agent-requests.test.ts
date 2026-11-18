import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { callerOf } from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import {
  allow,
  allowChallenge,
  decide,
  HELD_PER_PAIR_MAX,
  listHeld,
  notNow,
} from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import {
  addReply,
  addThread,
  artifactAgents,
  type CommentViewer,
  type CommentWho,
  editComment,
  listComments,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { inboxOf, needsYouCount } from "../src/services/inbox.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

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
  return { id: a.id, claude };
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
      "Someone else wrote this comment",
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

  it("all pages needs a passkey, an end date within a year, and a page not open", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held(s.id);
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    const until = Date.now() + 30 * 86_400_000;
    await expect(
      allow(E, owner.userId, r?.id as string, { level: "all", items, until }),
    ).rejects.toMatchObject({ code: "passkey_required" });
    await expect(
      allow(E, owner.userId, r?.id as string, {
        level: "all",
        items,
        until: Date.now() + 400 * 86_400_000,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    // The prompt is for a member with a passkey: this one has none.
    await expect(
      allowChallenge(E, owner.userId, r?.id as string, until),
    ).rejects.toMatchObject({ code: "no_passkey" });
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

  it("the allow needs a page in a shared space, an end date and a passkey", async () => {
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
      allow(E, owner.userId, r?.id as string, { level: "space", items, until }),
    ).rejects.toMatchObject({ code: "passkey_required" });
    await expect(
      allow(E, owner.userId, r?.id as string, {
        level: "space",
        items,
        until: Date.now() + 400 * 86_400_000,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
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
