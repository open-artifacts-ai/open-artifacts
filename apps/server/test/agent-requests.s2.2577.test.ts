import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
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
import { api, login } from "./helpers.js";
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

// #2577 S2: the switch and the "listens to" list routes, and the gate with the switch off.
/** #2868: a member with no real name reads "Someone", never the email or its local part. */
const NAMELESS = "Someone";
const nameRow = async (u: U) =>
  (
    await E.DB.prepare("select name from users where id = ?1")
      .bind(u.userId)
      .first<{ name: string }>()
  )?.name as string;
const setName = (u: U, name: string) =>
  E.DB.prepare("update users set name = ?1 where id = ?2")
    .bind(name, u.userId)
    .run();
afterEach(async () => {
  await api(app, R.agentRequests, owner.cookie, {
    method: "PUT",
    body: { on: true },
  });
});
const flip = (on: boolean, u: U = owner) =>
  api(app, R.agentRequests, u.cookie, { method: "PUT", body: { on } });
const auditCount = async (action: string, actor: string) =>
  (
    await E.DB.prepare(
      "select count(*) as n from audit_events where action = ?1 and actor_id = ?2",
    )
      .bind(action, actor)
      .first<{ n: number }>()
  )?.n;
const listens = async (u: U = owner) =>
  (await (await api(app, R.agentListens, u.cookie)).json()) as {
    entries: {
      id: string;
      member: { id: string; name: string };
      scope: string;
      artifact: { id: string; title: string } | null;
      until: number;
    }[];
  };
/** Lists `editor` on one page for the owner (the "allow on this page" path). */
async function listEditor(s: { id: string; claude: string }) {
  await post(s.id, typed(editor), editor, "first", mention(s.claude));
  const [r] = await held(s.id);
  await allow(E, owner.userId, r?.id as string, {
    level: "page",
    items: (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    })),
  });
  bus.sent = [];
}

describe("the switch", () => {
  it("is on by default; a browser session turns it off and on, audited once per change", async () => {
    const u = await mk("sw-own");
    const get = async () =>
      (await (await api(app, R.agentRequests, u.cookie)).json()) as {
        on: boolean;
      };
    expect(await get()).toEqual({ on: true });
    expect(await auditCount("agent_requests.switch", u.userId)).toBe(0);
    const off = await flip(false, u);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ on: false });
    expect(await get()).toEqual({ on: false });
    // The same value again writes nothing.
    await flip(false, u);
    expect(await auditCount("agent_requests.switch", u.userId)).toBe(1);
    expect(await (await flip(true, u)).json()).toEqual({ on: true });
    expect(await auditCount("agent_requests.switch", u.userId)).toBe(2);
    // A save keeps the member's other notification choices.
    const prefs = await api(app, R.meNotificationPrefs, u.cookie);
    expect(prefs.status).toBe(200);
  });

  it("is saved by a browser session only: a token is refused and can read it; a bad body is 400", async () => {
    const u = await mk("sw-tok");
    const pat = (await createPat(E, u.userId, "sw")).token;
    expect(
      (
        await api(app, R.agentRequests, pat, {
          method: "PUT",
          body: { on: false },
        })
      ).status,
    ).toBe(403);
    expect((await api(app, R.agentRequests, pat)).status).toBe(200);
    expect(
      (
        await api(app, R.agentRequests, u.cookie, {
          method: "PUT",
          body: { on: "no" },
        })
      ).status,
    ).toBe(400);
    expect((await api(app, R.agentRequests, null)).status).toBe(401);
    expect(await (await api(app, R.agentRequests, u.cookie)).json()).toEqual({
      on: true,
    });
  });
});

describe("with the switch off", () => {
  it("a mention or an ask of their agent is refused at post: Only answers <person>; nothing is held or sent", async () => {
    const s = await setup();
    await flip(false);
    for (const extra of [
      mention(s.claude),
      {
        ask: {
          question: "ok?",
          options: [
            { id: "a", label: "yes" },
            { id: "b", label: "no" },
          ],
          to: [{ key: s.claude }],
        },
      },
    ])
      await expect(
        post(s.id, typed(editor), editor, "hello", extra),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Only answers its owner",
      });
    expect(await held(s.id)).toHaveLength(0);
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    // The same comment with no mention posts.
    await post(s.id, typed(editor), editor, "plain");
  });

  it("the switch beats the list: a listed person is refused too", async () => {
    const s = await setup();
    await listEditor(s);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    await flip(false);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("off");
    await expect(
      post(s.id, typed(editor), editor, "again", mention(s.claude)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(toOwnerAgent(s.id)).toHaveLength(0);
  });

  it("a note on a page whose agent is theirs, and a follower notice, post but wake and hold nothing; what is already held stays", async () => {
    const s = await setup({}, OWNER_AGENT);
    await post(s.id, typed(editor), editor, "held first", mention(s.claude));
    expect(await held(s.id)).toHaveLength(1);
    await flip(false);
    const note = await post(s.id, typed(editor), editor, "a plain note");
    expect(note.comments[0]?.body).toBe("a plain note");
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    // Nothing new is held: the one request from before is untouched.
    const after = await held(s.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.items).toHaveLength(1);
    // A reply in the thread does not wake or hold either.
    await addReply(
      E,
      s.id,
      note.id,
      typed(editor),
      view(editor),
      "and a reply",
      {},
      { moderator: true },
    );
    expect(toOwnerAgent(s.id)).toHaveLength(0);
    expect((await held(s.id))[0]?.items).toHaveLength(1);
  });

  it("their own agents are never gated: they can mention each other", async () => {
    const s = await setup();
    await flip(false);
    await post(s.id, typed(owner), owner, "to my agent", mention(s.claude));
    expect(toOwnerAgent(s.id).map((x) => x.notice.to.name)).toEqual(["Claude"]);
  });

  it("turning it back on holds again", async () => {
    const s = await setup();
    await flip(false);
    await expect(
      post(s.id, typed(editor), editor, "x", mention(s.claude)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await flip(true);
    await post(s.id, typed(editor), editor, "y", mention(s.claude));
    expect(await held(s.id)).toHaveLength(1);
    expect(toOwnerAgent(s.id)).toHaveLength(0);
  });
});

describe("names in the 403 and the list (#2843)", () => {
  it("a nameless owner is never named by their email: Only answers its owner; a named one is named", async () => {
    const s = await setup();
    await flip(false);
    const refused = async () => {
      try {
        await post(s.id, typed(editor), editor, "hi", mention(s.claude));
      } catch (e) {
        return e as { message: string };
      }
      throw new Error("not refused");
    };
    const original = await nameRow(owner);
    const nameless = await refused();
    expect(nameless.message).toBe("Only answers its owner");
    expect(nameless.message).not.toContain(owner.email);
    try {
      await setName(owner, "Olive Owner");
      expect((await refused()).message).toBe("Only answers Olive Owner");
      // An address as a name, or a name that reads as an agent, is not shown either.
      await setName(owner, owner.email);
      expect((await refused()).message).toBe("Only answers its owner");
    } finally {
      await setName(owner, original);
    }
  });

  it("the list names a member as the app does: a real name, else Someone (never the email or its local part)", async () => {
    const s = await setup();
    await listEditor(s);
    const entry = async () =>
      (await listens()).entries.find((e) => e.artifact?.id === s.id);
    expect((await entry())?.member.name).toBe(NAMELESS);
    const original = await nameRow(editor);
    try {
      await setName(editor, "Eddie Editor");
      expect((await entry())?.member.name).toBe("Eddie Editor");
    } finally {
      await setName(editor, original);
    }
  });
});

describe("the listens-to list", () => {
  it("lists the member's live entries by name; another member sees none", async () => {
    const s = await setup();
    expect(
      (await listens()).entries.filter((e) => e.artifact?.id === s.id),
    ).toHaveLength(0);
    await listEditor(s);
    const mine = (await listens()).entries.filter(
      (e) => e.artifact?.id === s.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      member: { id: editor.userId, name: NAMELESS },
      scope: "page",
      artifact: { id: s.id, title: "doc" },
    });
    expect(mine[0]?.until).toBeGreaterThan(Date.now());
    expect(
      (await listens(editor)).entries.filter((e) => e.artifact?.id === s.id),
    ).toHaveLength(0);
  });

  it("an ended entry is not listed", async () => {
    const s = await setup();
    await listEditor(s);
    await E.DB.prepare(
      "update agent_listens set until = ?1 where owner_id = ?2 and artifact_id = ?3",
    )
      .bind(Date.now() - 1000, owner.userId, s.id)
      .run();
    expect(
      (await listens()).entries.filter((e) => e.artifact?.id === s.id),
    ).toHaveLength(0);
  });

  it("shorten ends it sooner (audited); later, past or equal ends are 400; the person is still listened to until then", async () => {
    const s = await setup();
    await listEditor(s);
    const e = (await listens()).entries.find((x) => x.artifact?.id === s.id);
    const path = R.agentListen(e?.id as string);
    const patch = (until: number, cookie = owner.cookie) =>
      api(app, path, cookie, { method: "PATCH", body: { until } });
    for (const bad of [
      e?.until as number,
      (e?.until as number) + 1000,
      Date.now() - 1000,
    ])
      expect((await patch(bad)).status).toBe(400);
    const to = Date.now() + 86_400_000;
    const ok = await patch(to);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: e?.id, until: to });
    expect((await listens()).entries.find((x) => x.id === e?.id)?.until).toBe(
      to,
    );
    expect(
      await auditCount("agent_listens.shorten", owner.userId),
    ).toBeGreaterThan(0);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    // Not another member's to change.
    expect((await patch(Date.now() + 1000, editor.cookie)).status).toBe(404);
  });

  it("remove affects the future only: the next request is held, what was delivered stays; audited; a second remove is 404", async () => {
    const s = await setup();
    await listEditor(s);
    await post(s.id, typed(editor), editor, "delivered", mention(s.claude));
    expect(toOwnerAgent(s.id)).toHaveLength(1);
    const e = (await listens()).entries.find((x) => x.artifact?.id === s.id);
    const path = R.agentListen(e?.id as string);
    // Not another member's to remove.
    expect(
      (await api(app, path, editor.cookie, { method: "DELETE" })).status,
    ).toBe(404);
    const before = await auditCount("agent_listens.remove", owner.userId);
    expect(
      (await api(app, path, owner.cookie, { method: "DELETE" })).status,
    ).toBe(204);
    expect(await auditCount("agent_listens.remove", owner.userId)).toBe(
      (before ?? 0) + 1,
    );
    expect(
      (await listens()).entries.find((x) => x.id === e?.id),
    ).toBeUndefined();
    expect(toOwnerAgent(s.id)).toHaveLength(1);
    await post(s.id, typed(editor), editor, "next", mention(s.claude));
    expect(toOwnerAgent(s.id)).toHaveLength(1);
    expect(await held(s.id)).toHaveLength(1);
    expect(
      (await api(app, path, owner.cookie, { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("a token or an agent can neither read nor change the list", async () => {
    const s = await setup();
    await listEditor(s);
    const e = (await listens()).entries.find((x) => x.artifact?.id === s.id);
    const path = R.agentListen(e?.id as string);
    const pat = (await createPat(E, owner.userId, "ls")).token;
    expect((await api(app, R.agentListens, pat)).status).toBe(403);
    expect(
      (
        await api(app, path, pat, {
          method: "PATCH",
          body: { until: Date.now() + 1000 },
        })
      ).status,
    ).toBe(403);
    expect((await api(app, path, pat, { method: "DELETE" })).status).toBe(403);
    expect((await api(app, R.agentListens, null)).status).toBe(401);
    expect((await listens()).entries.find((x) => x.id === e?.id)).toBeDefined();
  });
});
