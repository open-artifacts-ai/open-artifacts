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

// #2577 S2: askState on the @ list: what asking each agent does for the viewer.
const flip = (on: boolean, u: U = owner) =>
  api(app, R.agentRequests, u.cookie, { method: "PUT", body: { on } });
afterEach(async () => {
  await flip(true);
});
const stateOf = async (id: string, viewer: U, guest = false) =>
  Object.fromEntries(
    (await artifactAgents(E, id, viewer.userId, guest)).map((a) => [
      a.name.split(" ")[0],
      a.askState,
    ]),
  );

describe("askState on the @ list", () => {
  it("the viewer's own agents always listen; another member's agent is held until they are listed, then listening", async () => {
    const s = await setup();
    // The owner's view: the owner's Claude is theirs, the editor's Codex is held.
    expect(await stateOf(s.id, owner)).toEqual({
      Claude: "listening",
      Codex: "held",
    });
    // The editor's view: Codex is theirs; Claude's owner has not listed them.
    expect(await stateOf(s.id, editor)).toEqual({
      Claude: "held",
      Codex: "listening",
    });
    // The owner lists the editor on this page.
    await post(s.id, typed(editor), editor, "first", mention(s.claude));
    const [r] = await held(s.id);
    await allow(E, owner.userId, r?.id as string, {
      level: "page",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    expect((await stateOf(s.id, editor)).Claude).toBe("listening");
    // The list is one way: the editor has not listed the owner.
    expect((await stateOf(s.id, owner)).Codex).toBe("held");
  });

  it("with the owner's switch off the agent reads off, a listed viewer too; their own agent still listens; back on restores it", async () => {
    const s = await setup();
    await flip(false);
    expect((await stateOf(s.id, editor)).Claude).toBe("off");
    expect(await stateOf(s.id, owner)).toMatchObject({ Claude: "listening" });
    await flip(true);
    expect((await stateOf(s.id, editor)).Claude).toBe("held");
  });

  it("a page open to anyone with the link: a listed viewer reads held again", async () => {
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
    expect((await stateOf(s.id, editor)).Claude).toBe("listening");
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(s.id)
      .run();
    expect((await stateOf(s.id, editor)).Claude).toBe("held");
  });

  it("a masked (guest) view carries no askState", async () => {
    const s = await setup();
    const seen = await artifactAgents(E, s.id, editor.userId, true);
    expect(seen.length).toBeGreaterThan(0);
    for (const a of seen) expect(a.askState).toBeUndefined();
    const none = await artifactAgents(E, s.id, null);
    for (const a of none) expect(a.askState).toBeUndefined();
  });

  it("the route carries it", async () => {
    const s = await setup();
    const r = await api(app, R.artifactAgents(s.id), editor.cookie);
    expect(r.status).toBe(200);
    const list = (await r.json()) as { name: string; askState?: string }[];
    expect(list.find((a) => a.name.startsWith("Claude"))?.askState).toBe(
      "held",
    );
    expect(list.find((a) => a.name.startsWith("Codex"))?.askState).toBe(
      "listening",
    );
  });
});
