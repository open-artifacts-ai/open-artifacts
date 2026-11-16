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
  answerAsk,
  answerChallenge,
  artifactAgents,
  type CommentWho,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

// Guests count as outside for agent wake-ups, with no AUTH_DOMAINS set.

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
  await E.DB.prepare("delete from counters where key like 'notice:%'").run();
});

type U = { userId: string; member: Member; email: string };
async function mk(prefix: string, role: "member" | "guest"): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { userId: l.userId, member: m, email };
}
let owner: U;
let guest: U;
let member: U;
beforeAll(async () => {
  owner = await mk("go-owner", "member");
  guest = await mk("go-guest", "guest");
  member = await mk("go-member", "member");
});

const LINKED: AgentAttr = {
  name: "Claude",
  version: null,
  identity: {
    identityId: "id-pub-go-1",
    namespace: "ns-o",
    name: "Claude",
    kind: "claude-code",
  },
};
const who = (u: U): CommentWho => ({ kind: "user", id: u.userId, typed: true });
const view = (u: U, guestFlag = false) => ({
  userId: u.userId,
  short: null,
  moderator: true,
  ...(guestFlag ? { guest: true } : {}),
});
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;
const NOTE = { kind: "note" } as const;
const OPTS = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];

async function setup() {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    LINKED,
    undefined,
    "create",
  );
  for (const u of [guest, member])
    await putShare(E, owner.member, a.id, { email: u.email, role: "editor" });
  await follow(E, owner.userId, { namespace: "ns-o", name: "Claude" }, a.id);
  await follow(E, member.userId, { namespace: "ns-m", name: "Codex" }, a.id);
  const list = await artifactAgents(E, a.id, owner.userId);
  const key = (n: string) =>
    list.find((x) => x.name.startsWith(n))?.key as string;
  return { id: a.id, claude: key("Claude"), codex: key("Codex") };
}
const post = (id: string, u: U, extra: object = {}, opts: object = {}) =>
  addThread(
    E,
    art(id),
    who(u),
    view(u, u === guest),
    { anchor: NOTE, body: "hi", ...extra },
    { moderator: true, ...opts },
  ) as Promise<Thread>;

describe("a guest wakes no agent, with no AUTH_DOMAINS", () => {
  it("a mention of another person's agent is refused", async () => {
    const s = await setup();
    await expect(
      post(s.id, guest, { mentions: [{ key: s.claude }] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bus.sent).toEqual([]);
  });

  it("an ask addressed to an agent is refused", async () => {
    const s = await setup();
    await expect(
      post(s.id, guest, {
        ask: { question: "Q?", options: OPTS, to: [{ key: s.claude }] },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bus.sent).toEqual([]);
  });

  it("a plain note on an agent's page wakes nothing; a member's does", async () => {
    const s = await setup();
    const t = await post(s.id, guest);
    expect(t.comments[0]?.body).toBe("hi");
    expect(bus.sent).toEqual([]);
    await post(s.id, member);
    expect(bus.sent.map((x) => x.notice.to.name)).toEqual(["Claude"]);
  });

  it("a reply wakes no agent already in the thread", async () => {
    const s = await setup();
    const t = await post(s.id, owner, { mentions: [{ key: s.claude }] });
    bus.sent = [];
    await addReply(
      E,
      s.id,
      t.id,
      who(guest),
      view(guest, true),
      "r",
      {},
      { moderator: true },
    );
    expect(bus.sent).toEqual([]);
  });

  it("a follower notice is not sent for a guest's comment; a member's is", async () => {
    const s = await setup();
    await post(s.id, guest, {}, { after: { version: 1 } });
    expect(bus.sent).toEqual([]);
    // A member's comment on a page with no publishing agent: followers hear it.
    const plain = await publish(
      E,
      owner.member,
      { title: "d2", format: "html", content: "<p>y</p>" } as never,
      null,
      undefined,
      "create",
    );
    await putShare(E, owner.member, plain.id, {
      email: member.email,
      role: "editor",
    });
    await putShare(E, owner.member, plain.id, {
      email: guest.email,
      role: "editor",
    });
    await follow(E, owner.userId, { namespace: "ns-o", name: "Pi" }, plain.id);
    await post(plain.id, guest, {}, { after: { version: 1 } });
    expect(bus.sent).toEqual([]);
    await post(plain.id, member, {}, { after: { version: 1 } });
    expect(bus.sent.map((x) => [x.notice.kind, x.notice.to.name])).toEqual([
      ["commented", "Pi"],
    ]);
  });

  it("a guest picks no ask option, and gets no passkey challenge", async () => {
    const s = await setup();
    const t = await post(s.id, owner, {
      ask: { question: "Q?", options: OPTS, to: [{ key: guest.userId }] },
    });
    const c = t.comments[0]?.id as string;
    await expect(
      answerAsk(
        E,
        s.id,
        t.id,
        c,
        who(guest),
        view(guest, true),
        "a",
        undefined,
        { interactive: false },
        { canDecide: false, guest: true },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    // The guest role alone refuses, without the request's flags.
    await expect(
      answerAsk(
        E,
        s.id,
        t.id,
        c,
        who(guest),
        view(guest),
        "a",
        undefined,
        { interactive: false },
        { canDecide: false, guest: false },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      answerChallenge(E, s.id, t.id, c, who(guest), "a", true),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a guest's @ list is empty; a member's is not", async () => {
    const s = await setup();
    expect(await artifactAgents(E, s.id, guest.userId, true)).toEqual([]);
    expect(
      (await artifactAgents(E, s.id, member.userId)).length,
    ).toBeGreaterThan(0);
  });
});
