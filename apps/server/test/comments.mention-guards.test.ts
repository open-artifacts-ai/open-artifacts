import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type Member,
  newId,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { AgentAttr } from "../src/services/agent-usage.js";
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
  type CommentWho,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import {
  MENTIONS_PER_RECEIVER_PER_HOUR,
  MENTIONS_PER_SENDER_PER_HOUR,
  OWN_AGENTS_ONLY,
  TOO_MANY_MENTIONS,
} from "../src/services/mention-guards.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

// #2559: outsiders mention only their own agents; a limit on mentions of other
// people's agents; and a comment an agent or a token wrote never wakes another
// person's agent, by mention or by follower notice.

const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  sent: { userId: string; notice: BusNotice }[] = [];
  outcome: DeliveryOutcome = "delivered";
  async deliver(_e: Env, userId: string, notice: BusNotice) {
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

type U = { userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { userId: l.userId, member: m, email };
}
let owner: U;
let editor: U;
beforeAll(async () => {
  owner = await mk("mg-owner");
  editor = await mk("mg-editor");
});

const typed = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  typed: true,
});
const token = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const agent = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  agent: { name: "Bot", version: null, via: { kind: "token", id: "t1" } },
});
const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });
const NOTE = { kind: "note" } as const;

/** Owner follows with Claude and Pi, the editor with Codex. */
async function setup(publisher: AgentAttr | null = null) {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    publisher,
    undefined,
    "create",
  );
  await putShare(E, owner.member, a.id, {
    email: editor.email,
    role: "editor",
  });
  await follow(E, owner.userId, { namespace: "ns-o", name: "Claude" }, a.id);
  await follow(E, owner.userId, { namespace: "ns-o", name: "Pi" }, a.id);
  await follow(E, editor.userId, { namespace: "ns-e", name: "Codex" }, a.id);
  const list = await artifactAgents(E, a.id, owner.userId);
  const key = (n: string) => {
    const k = list.find((x) => x.name.startsWith(n))?.key;
    if (!k) throw new Error(`no agent ${n}`);
    return k;
  };
  return {
    id: a.id,
    claude: key("Claude"),
    pi: key("Pi"),
    codex: key("Codex"),
  };
}
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;
const post = (
  e: Env,
  id: string,
  who: CommentWho,
  u: U,
  mentions: string[],
  opts: object = { moderator: true },
) =>
  addThread(
    e,
    art(id),
    who,
    view(u),
    { anchor: NOTE, body: "hi", mentions: mentions.map((key) => ({ key })) },
    opts,
  ) as Promise<Thread>;
const names = () => bus.sent.map((x) => x.notice.to.name).sort();
const inHour = () => new Date().toISOString().slice(0, 13);
const setCount = (key: string, n: number) =>
  E.DB.prepare(
    "insert into counters (key, n, day) values (?, ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
  )
    .bind(key, n, inHour())
    .run();

const OUTSIDE = { ...E, AUTH_DOMAINS: "corp.test" } as unknown as Env;
const INSIDE = { ...E, AUTH_DOMAINS: "x.com" } as unknown as Env;

describe("guard 1: outsiders mention only their own agents", () => {
  it("refuses another person's agent with 403 and the exact message; nothing is written or sent", async () => {
    const s = await setup();
    await expect(
      post(OUTSIDE, s.id, typed(editor), editor, [s.claude]),
    ).rejects.toMatchObject({ code: "forbidden", message: OWN_AGENTS_ONLY });
    expect(OWN_AGENTS_ONLY).toBe("You can mention only your own agents here.");
    expect(bus.sent).toEqual([]);
  });

  it("an outsider's own agent still works, and an insider may mention another person's", async () => {
    const s = await setup();
    const t = await post(OUTSIDE, s.id, typed(editor), editor, [s.codex]);
    expect(t.comments[0]?.mentions?.[0]?.delivery).toBe("delivered");
    bus.sent = [];
    await post(INSIDE, s.id, typed(editor), editor, [s.claude]);
    expect(names()).toEqual(["Claude"]);
  });

  it("leaves other people's agents out of an outsider's @ list", async () => {
    const s = await setup();
    const out = await artifactAgents(OUTSIDE, s.id, editor.userId);
    expect(out.map((a) => a.name)).toEqual(["Codex"]);
    const inn = await artifactAgents(INSIDE, s.id, editor.userId);
    expect(inn.map((a) => a.name.replace(/ \(.*/, "")).sort()).toEqual([
      "Claude",
      "Codex",
      "Pi",
    ]);
  });
});

describe("guard 2: a limit on mentions of other people's agents", () => {
  it("over the per-sender limit the comment is kept, nobody is woken, the response says so", async () => {
    const s = await setup();
    await setCount(
      `notice:mention:from:${editor.userId}`,
      MENTIONS_PER_SENDER_PER_HOUR,
    );
    const t = await post(E, s.id, typed(editor), editor, [s.claude]);
    expect(t.comments[0]?.notice).toBe(TOO_MANY_MENTIONS);
    expect(TOO_MANY_MENTIONS).toBe(
      "That's a lot of mentions. Try again in a few minutes.",
    );
    expect(t.comments[0]?.body).toBe("hi");
    expect(t.comments[0]?.mentions?.[0]?.delivery).toBe("gone");
    expect(bus.sent).toEqual([]);
  });

  it("over the per-receiver limit the same", async () => {
    const s = await setup();
    await setCount(
      `notice:mention:to:${owner.userId}`,
      MENTIONS_PER_RECEIVER_PER_HOUR,
    );
    const t = await post(E, s.id, typed(editor), editor, [s.claude]);
    expect(t.comments[0]?.notice).toBe(TOO_MANY_MENTIONS);
    expect(bus.sent).toEqual([]);
  });

  it("under the limit it counts, and counts a reply too", async () => {
    const s = await setup();
    const t = await post(E, s.id, typed(editor), editor, [s.claude]);
    expect(t.comments[0]?.notice).toBeUndefined();
    await addReply(
      E,
      s.id,
      t.id,
      typed(editor),
      view(editor),
      "again",
      {
        mentions: [{ key: s.pi }],
      },
      { moderator: true },
    );
    const row = await E.DB.prepare("select n from counters where key = ?")
      .bind(`notice:mention:from:${editor.userId}`)
      .first<{ n: number }>();
    // The mention of Claude, of Pi, and the reply waking Claude as a thread agent.
    expect(row?.n).toBe(3);
  });

  it("a reply over the limit keeps the reply and says so", async () => {
    const s = await setup();
    const t = await post(E, s.id, typed(editor), editor, []);
    await setCount(
      `notice:mention:from:${editor.userId}`,
      MENTIONS_PER_SENDER_PER_HOUR,
    );
    bus.sent = [];
    const c = await addReply(
      E,
      s.id,
      t.id,
      typed(editor),
      view(editor),
      "r",
      {
        mentions: [{ key: s.claude }],
      },
      { moderator: true },
    );
    expect(c.notice).toBe(TOO_MANY_MENTIONS);
    expect(c.body).toBe("r");
    expect(bus.sent).toEqual([]);
  });

  it("mentions of your own agents do not count and are never limited", async () => {
    const s = await setup();
    await setCount(
      `notice:mention:from:${owner.userId}`,
      MENTIONS_PER_SENDER_PER_HOUR,
    );
    const t = await post(E, s.id, typed(owner), owner, [s.claude, s.pi]);
    expect(t.comments[0]?.notice).toBeUndefined();
    expect(names()).toEqual(["Claude", "Pi"]);
    const row = await E.DB.prepare("select n from counters where key = ?")
      .bind(`notice:mention:to:${owner.userId}`)
      .first();
    expect(row).toBeNull();
  });
});

describe("guard 3: an agent's or a token's comment never wakes another person's agent", () => {
  for (const [label, who] of [
    ["an agent's", agent],
    ["a token's", token],
  ] as const)
    it(`${label} mention of another person's agent wakes nothing, and the comment is kept`, async () => {
      const s = await setup();
      const t = await post(E, s.id, who(editor), editor, [s.claude]);
      expect(t.comments[0]?.body).toBe("hi");
      expect(t.comments[0]?.mentions?.[0]?.delivery).toBe("gone");
      expect(t.comments[0]?.notice).toBeUndefined();
      expect(bus.sent).toEqual([]);
      const row = await E.DB.prepare(
        "select n from counters where key like 'notice:mention:%'",
      ).first();
      expect(row).toBeNull();
    });

  it("an agent's or a token's comment tells no follower of another person", async () => {
    const s = await setup();
    for (const who of [agent, token])
      await addThread(
        E,
        art(s.id),
        who(owner),
        view(owner),
        { anchor: NOTE, body: "hi" },
        { moderator: true, after: { version: 1 } },
      );
    expect(bus.sent).toEqual([]);
  });

  it("an agent's mention of its own person's other agent still wakes it", async () => {
    const s = await setup();
    await post(E, s.id, agent(owner), owner, [s.claude, s.pi]);
    expect(names()).toEqual(["Claude", "Pi"]);
    bus.sent = [];
    await post(E, s.id, token(owner), owner, [s.pi]);
    expect(names()).toEqual(["Pi"]);
  });
});

describe("regression: one person's agents and typed comments still wake as before", () => {
  it("a typed comment wakes another person's mentioned agent and their followers; one person's agents wake each other", async () => {
    const s = await setup();
    // A person typing mentions a teammate's agent.
    await post(E, s.id, typed(editor), editor, [s.claude]);
    expect(names()).toEqual(["Claude"]);
    bus.sent = [];
    // Followers hear a typed comment (not the author's own agents).
    await addThread(
      E,
      art(s.id),
      typed(owner),
      view(owner),
      { anchor: NOTE, body: "hi" },
      { moderator: true, after: { version: 1 } },
    );
    expect(bus.sent.map((x) => [x.notice.kind, x.notice.to.name])).toEqual([
      ["commented", "Codex"],
    ]);
    bus.sent = [];
    // The owner's agent (a token with an agent label) wakes the owner's other agent.
    await post(E, s.id, agent(owner), owner, [s.pi]);
    expect(names()).toEqual(["Pi"]);
  });
});

describe("same person: every path behaves as before (#2559)", () => {
  it("a token comment by agent A of U never sent U's follower B a follower notice (the author's own agents are skipped), and still does not", async () => {
    const s = await setup();
    await addThread(
      E,
      art(s.id),
      agent(owner),
      view(owner),
      { anchor: NOTE, body: "hi" },
      { moderator: true, after: { version: 1 } },
    );
    // Claude and Pi follow as the owner's: no follower notice, same as on main.
    expect(bus.sent).toEqual([]);
  });

  it("agent A's token comment mentioning U's follower B wakes B; a token reply (no agent label) reaches U's thread agents", async () => {
    const s = await setup();
    const t = await post(E, s.id, agent(owner), owner, [s.claude]);
    expect(names()).toEqual(["Claude"]);
    bus.sent = [];
    await addReply(
      E,
      s.id,
      t.id,
      token(owner),
      view(owner),
      "again",
      {
        mentions: [{ key: s.pi }],
      },
      { moderator: true },
    );
    // Pi by the mention, Claude as a thread agent (thread reply): both U's.
    expect(names()).toEqual(["Claude", "Pi"]);
  });
});

// Axe's M1: the paths that wake an agent without an @.
const LINKED: AgentAttr = {
  name: "Claude",
  version: null,
  identity: {
    identityId: "id-pub-mg-1",
    namespace: "ns-o",
    name: "Claude",
    kind: "claude-code",
  },
};
const note = (e: Env, id: string, u: U, opts: object = {}) =>
  addThread(
    e,
    art(id),
    typed(u),
    view(u),
    { anchor: NOTE, body: "hi" },
    { moderator: true, ...opts },
  ) as Promise<Thread>;

describe("no-@ wakes: page agent, thread reply, follower notice", () => {
  it("an outsider's plain note on a page the owner's agent published wakes nothing; an insider's does", async () => {
    const s = await setup(LINKED);
    const t = await note(OUTSIDE, s.id, editor);
    expect(t.comments[0]?.body).toBe("hi");
    expect(bus.sent).toEqual([]);
    await note(INSIDE, s.id, editor);
    expect(names()).toEqual(["Claude"]);
  });

  it("an insider's 11th note in an hour wakes nothing and returns the notice", async () => {
    const s = await setup(LINKED);
    for (let i = 0; i < MENTIONS_PER_SENDER_PER_HOUR; i++) {
      const t = await note(E, s.id, editor);
      expect(t.comments[0]?.notice).toBeUndefined();
    }
    expect(bus.sent).toHaveLength(MENTIONS_PER_SENDER_PER_HOUR);
    bus.sent = [];
    const t = await note(E, s.id, editor);
    expect(t.comments[0]?.notice).toBe(TOO_MANY_MENTIONS);
    expect(t.comments[0]?.body).toBe("hi");
    expect(bus.sent).toEqual([]);
  });

  it("a note on the sender's own agent's page is never limited", async () => {
    const s = await setup(LINKED);
    await setCount(
      `notice:mention:from:${owner.userId}`,
      MENTIONS_PER_SENDER_PER_HOUR,
    );
    const t = await note(E, s.id, owner);
    expect(t.comments[0]?.notice).toBeUndefined();
    expect(names()).toEqual(["Claude"]);
  });

  it("a thread reply wakes the thread's agents of another person: not for an outsider, limited for an insider", async () => {
    const s = await setup();
    const root = () => post(E, s.id, typed(owner), owner, [s.claude]);
    const reply = (e: Env, id: string, tid: string) =>
      addReply(
        e,
        id,
        tid,
        typed(editor),
        view(editor),
        "r",
        {},
        { moderator: true },
      );
    const isReply = () =>
      bus.sent.filter((x) => x.notice.coalesceKey.includes(":thread_reply:"));
    const t1 = await root();
    bus.sent = [];
    await reply(OUTSIDE, s.id, t1.id);
    expect(isReply()).toEqual([]);
    const t2 = await root();
    bus.sent = [];
    const ok = await reply(INSIDE, s.id, t2.id);
    expect(isReply().map((x) => x.notice.to.name)).toEqual(["Claude"]);
    expect(ok.notice).toBeUndefined();
    const t3 = await root();
    bus.sent = [];
    await setCount(
      `notice:mention:from:${editor.userId}`,
      MENTIONS_PER_SENDER_PER_HOUR,
    );
    const over = await reply(E, s.id, t3.id);
    expect(over.notice).toBe(TOO_MANY_MENTIONS);
    expect(isReply()).toEqual([]);
  });

  it("a follower notice: not for an outsider, limited per receiving person", async () => {
    const s = await setup();
    const after = { after: { version: 1 } };
    await note(OUTSIDE, s.id, owner, after);
    expect(bus.sent).toEqual([]);
    await setCount(
      `notice:mention:to:${editor.userId}`,
      MENTIONS_PER_RECEIVER_PER_HOUR,
    );
    await note(E, s.id, owner, after);
    expect(bus.sent).toEqual([]);
    await E.DB.prepare("delete from counters where key like 'notice:%'").run();
    await note(E, s.id, owner, after);
    expect(bus.sent.map((x) => [x.notice.kind, x.notice.to.name])).toEqual([
      ["commented", "Codex"],
    ]);
  });
});
