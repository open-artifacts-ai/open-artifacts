import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type CommentList,
  DisplayNameSchema,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import {
  memberTag,
  plainAgentName,
  readsAsAgent,
  skeleton,
} from "../src/services/agent-display.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { agentRoster } from "../src/services/comment-agents.js";
import { cleanGuestName } from "../src/services/comment-rules.js";
import {
  addThread,
  type CommentViewer,
  type CommentWho,
  listComments,
  resetNameClashCache,
} from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #1822: one face per linked agent, what a guest sees, and no agent reading as
// another person's.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let seq = 0;

class FakeBus implements NoticeDelivery {
  async deliver(_e: Env, _u: string, _n: BusNotice): Promise<DeliveryOutcome> {
    return "delivered";
  }
}
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(new FakeBus());
});
afterAll(() => installDelivery(prev));

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string, displayName?: string): Promise<U> {
  const email = `${prefix}-${tag}-${++seq}@x.com`;
  const l = await login(email, "member");
  if (displayName)
    await E.DB.prepare("update users set display_name = ? where id = ?")
      .bind(displayName, l.userId)
      .run();
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

let nameSeq = 0;
let nm = "";
/** A display name no other test member shares (a shared one is a collision). */
const newName = () => {
  nm = `Una ${String.fromCharCode(97 + (nameSeq % 26))}${nameSeq++} ${tag}`;
  return nm;
};

const IDENT = {
  identityId: "id-secret-0001",
  namespace: "ns",
  name: "OA Product",
  kind: "claude-code",
};
const agentWho = (u: U, identity?: typeof IDENT): CommentWho => ({
  kind: "user",
  id: u.userId,
  agent: {
    name: "Release bot",
    version: null,
    via: { kind: "token", id: "tok1" },
    ...(identity ? { identity } : {}),
  },
});
const signedIn = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
});
const GUEST: CommentViewer = { userId: null, short: "gst", guest: true };
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;
const pub = async (u: U) =>
  (
    await publish(
      E,
      u.member,
      { title: "doc", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const post = (id: string, u: U, w: CommentWho, extra: object = {}) =>
  addThread(
    E,
    art(id),
    w,
    signedIn(u),
    { anchor: { kind: "note" }, body: "hi", ...extra },
    { moderator: true },
  ) as Promise<Thread>;
const first = async (id: string, v: CommentViewer) =>
  (await listComments(E, id, "all", v)).threads[0]?.comments[0];
const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );

describe("agent faces (#1822)", () => {
  beforeEach(() => resetNameClashCache());

  it("a linked author: bus name, product from the kind, animal, never the identity id", async () => {
    const owner = await mk("f-own", newName());
    const other = await mk("f-oth");
    const id = await pub(owner);
    await post(id, owner, agentWho(owner, IDENT));
    const c = await first(id, signedIn(other));
    expect(c?.author).toMatchObject({
      kind: "agent",
      name: "OA Product",
      linked: true,
      product: "Claude Code",
      for: `${nm}`,
      me: false,
    });
    expect(c?.author.animal?.id).toEqual(expect.any(String));
    expect(JSON.stringify(c)).not.toContain(IDENT.identityId);
  });

  it("an unlinked author: label as #1800 does, linked false, no animal", async () => {
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    await post(id, owner, agentWho(owner));
    const c = await first(id, signedIn(await mk("f-oth")));
    expect(c?.author.kind).toBe("agent");
    expect(c?.author.linked).toBe(false);
    expect(c?.author.animal).toBeUndefined();
    expect(c?.author.product).toBeUndefined();
    expect(c?.author.name).toBe(`${nm}'s agent`);
  });

  it("an unlinked grant shows a known product name, else its person's agent", async () => {
    const owner = await mk("f-own", newName());
    const other = await mk("f-oth");
    const grant = (name: string): CommentWho => ({
      kind: "user",
      id: owner.userId,
      agent: { name, version: null, via: { kind: "grant", id: newId() } },
    });
    const shown = async (name: string, v: CommentViewer) => {
      const id = await pub(owner);
      await post(id, owner, grant(name));
      return (await first(id, v))?.author.name;
    };
    for (const [given, want] of [
      ["Claude Code", "Claude Code"],
      ["claude code", "Claude Code"],
      [" CODEX ", "Codex"],
      ["OA Product", `${nm}'s agent`],
      ["Claude Code 2", `${nm}'s agent`],
      ["Claude Code Pro", `${nm}'s agent`],
    ] as const) {
      expect(await shown(given, signedIn(other))).toBe(want);
      // The owner sees their own client's raw name.
      expect(await shown(given, signedIn(owner))).toBe(given);
    }
    // A token's label stays the owner's private note.
    const id = await pub(owner);
    await post(id, owner, agentWho(owner));
    expect((await first(id, signedIn(owner)))?.author.name).toBe("Release bot");
    expect((await first(id, signedIn(other)))?.author.name).toBe(
      `${nm}'s agent`,
    );
  });

  it("an old row (an agent with no identity, a mention with no owner) reads as unlinked, no for", async () => {
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    await post(id, owner, agentWho(owner));
    const stored = await inDo(id, (i) => JSON.stringify(i.commentsList("all")));
    expect(await stored).not.toContain("identity");
    expect(await stored).toContain('"via":"t:tok1"');
    const c = await first(id, signedIn(owner));
    expect(c?.author).toMatchObject({ kind: "agent", linked: false, me: true });
  });

  it("a person who commented stays kind user", async () => {
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    await post(id, owner, { kind: "user", id: owner.userId });
    const c = await first(id, GUEST);
    expect(c?.author).toEqual({
      kind: "user",
      id: owner.userId,
      name: `${nm}`,
      me: false,
    });
  });

  it("a guest sees <person>'s agent and no face, never the bus name", async () => {
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    await post(id, owner, agentWho(owner, IDENT));
    const c = await first(id, GUEST);
    expect(c?.author.name).toBe(`${nm}'s agent`);
    // No animal, product or linked: a stable id across artifacts.
    expect(c?.author.animal).toBeUndefined();
    expect(c?.author.linked).toBeUndefined();
    expect(c?.author.product).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain("OA Product");
    // A guest-role member is a guest too.
    const g = await first(id, { ...signedIn(await mk("f-g")), guest: true });
    expect(JSON.stringify(g)).not.toContain("OA Product");
  });

  it("one identity has the same animal and color on two artifacts", async () => {
    const owner = await mk("f-own", newName());
    const a = await pub(owner);
    const b = await pub(owner);
    await post(a, owner, agentWho(owner, IDENT));
    await post(b, owner, agentWho(owner, IDENT));
    const viewer = signedIn(await mk("f-v"));
    const [x, y] = [await first(a, viewer), await first(b, viewer)];
    expect(x?.author.animal).toEqual(y?.author.animal);
  });

  it("a name that collides: signed-in sees a member tag, a guest sees A member's agent", async () => {
    // "Leo" with a Cyrillic o, and a case and width variant.
    const real = await mk("f-real", `Leo Urbina ${tag}`);
    const fake = await mk("f-fake", `LEО  URBINA ${tag}`);
    const id = await pub(fake);
    await post(id, fake, agentWho(fake, IDENT));
    const seen = await first(id, signedIn(real));
    expect(seen?.author.for).toBe(
      `LEО URBINA ${tag} (member ${memberTag(fake.userId)})`,
    );
    expect(JSON.stringify(seen)).not.toContain(fake.email);
    const g = await first(id, GUEST);
    expect(g?.author.name).toBe("A member's agent");
    expect(g?.author.for).toBe("Member");
    expect(JSON.stringify(g)).not.toContain(fake.email);
    // An unlinked private label collides the same way.
    const id2 = await pub(fake);
    await post(id2, fake, agentWho(fake));
    expect((await first(id2, GUEST))?.author.name).toBe("A member's agent");
    expect((await first(id2, signedIn(real)))?.author.for).toContain(
      "(member ",
    );
  });

  it("an asked agent's bus name is masked for a guest in the body, question and options", async () => {
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    await E.DB.prepare(
      "insert into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, ?, ?)",
    )
      .bind(newId(), owner.userId, newId(), Date.now(), Date.now())
      .run();
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        snapshot: async () => ({
          connected: [],
          agents: [
            {
              id: newId(),
              namespace: "ns-o",
              name: "Runner",
              kind: "claude",
              machineId: "m",
              machineLabel: "m",
              global: false,
              state: "live",
              running: true,
              since: null,
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      }),
    };
    const e2 = { ...E, BUS_HUB: ns } as unknown as Env;
    const key = (await agentRoster(e2, id, owner.userId, true, true))[0]
      ?.key as string;
    await addThread(
      e2,
      art(id),
      { kind: "user", id: owner.userId },
      signedIn(owner),
      {
        anchor: { kind: "note" },
        body: "cc @runner",
        ask: {
          question: "Should @RUNNER go?",
          options: [
            { id: "a", label: "Yes, @Runner", detail: "@runner does it" },
            { id: "b", label: "No" },
          ],
          recommended: { optionId: "a", why: "@Runner knows" },
          to: [{ key }],
        },
      },
      { moderator: true },
    );
    const seen = async (v: CommentViewer) =>
      JSON.stringify((await listComments(e2, id, "all", v)).threads);
    const guest = await seen(GUEST);
    expect(guest.toLowerCase()).not.toContain("runner");
    expect(guest).toContain(`@${nm}'s agent`);
    // A member sees the bus name as written.
    const member = await seen(signedIn(owner));
    expect(member).toContain("@runner");
    expect(member).toContain("Should @RUNNER go?");
  });

  it("a for line is on a mention and on an ask's to, set from the owner", async () => {
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    await E.DB.prepare(
      "insert into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, ?, ?)",
    )
      .bind(newId(), owner.userId, newId(), Date.now(), Date.now())
      .run();
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        snapshot: async () => ({
          connected: [],
          agents: [
            {
              id: newId(),
              namespace: "ns-o",
              name: "Runner",
              kind: "claude",
              machineId: "m",
              machineLabel: "m",
              global: false,
              state: "live",
              running: true,
              since: null,
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      }),
    };
    const e2 = { ...E, BUS_HUB: ns } as unknown as Env;
    const key = (await agentRoster(e2, id, owner.userId, true, true))[0]
      ?.key as string;
    // `for` and `owner` in the input are ignored: the server sets them.
    const t = (await addThread(
      e2,
      art(id),
      { kind: "user", id: owner.userId },
      signedIn(owner),
      {
        anchor: { kind: "note" },
        body: "hi @Runner and @Runner2",
        mentions: [{ key, for: "Evil", owner: "x" } as never],
        ask: {
          question: "ok?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          to: [{ key }],
        },
      },
      { moderator: true },
    )) as Thread;
    const c = t.comments[0];
    expect(c?.mentions?.[0]?.for).toBe(`${nm}`);
    expect(c?.ask?.to[0]).toMatchObject({
      kind: "agent",
      name: "Runner",
      for: `${nm}`,
    });
    // A guest sees no bus name on either.
    const g = await first(id, GUEST);
    expect(g?.mentions?.[0]?.name).toBe(`${nm}'s agent`);
    expect(g?.ask?.to[0]?.name).toBe(`${nm}'s agent`);
    expect(JSON.stringify(g)).not.toContain("Runner");
    // The body says the shown name too, for a guest and through MCP-style reads.
    expect(g?.body).toBe(`hi @${nm}'s agent and @${nm}'s agent2`);
    expect((await first(id, signedIn(owner)))?.body).toBe(
      "hi @Runner and @Runner2",
    );
    // A mention row from before the owner was stored has no for.
    await inDo(id, (i) => {
      (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "update comment_targets set owner = null",
      );
    });
    expect(
      (await first(id, signedIn(owner)))?.mentions?.[0]?.for,
    ).toBeUndefined();
  });

  it("a client cannot set the identity, link, product, animal or for", async () => {
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    const forged = {
      identity: IDENT,
      linked: true,
      product: "Forged",
      animal: { id: "fox", color: 1 },
      for: "Someone Else",
      author: { kind: "agent", linked: true },
    };
    // A person's cookie stays a person.
    const r1 = await api(app, R.comments(id), owner.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "cookie", ...forged },
    });
    const t1 = (await r1.json()) as Thread;
    expect(t1.comments[0]?.author.kind).toBe("user");
    expect(t1.comments[0]?.author.linked).toBeUndefined();
    // A token with no proof is unlinked.
    const { token } = await createPat(E, owner.userId, "ci token");
    const r2 = await api(app, R.comments(id), token, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "token", ...forged },
    });
    const a = ((await r2.json()) as Thread).comments[0]?.author;
    expect(a?.linked).toBe(false);
    expect(a?.animal).toBeUndefined();
    expect(a?.product).toBeUndefined();
    expect(a?.for).toBe(`${nm}`);
    const all = (await (
      await api(app, R.comments(id), owner.cookie)
    ).json()) as CommentList;
    expect(JSON.stringify(all)).not.toContain(IDENT.identityId);
  });
});

describe("member names that read as an agent (#1822)", () => {
  beforeEach(() => resetNameClashCache());

  it("DisplayNameSchema refuses them, ordinary names pass", () => {
    for (const bad of [
      "Leo Urbina's agent",
      "Leo\u2019s AGENT.",
      "Leo\u02bcs  agent",
    ])
      expect(DisplayNameSchema.safeParse(bad).success).toBe(false);
    for (const ok of ["Leo Urbina", "Agent Smith", "Agents R Us"])
      expect(DisplayNameSchema.safeParse(ok).success).toBe(true);
  });

  it("a stored name 'X's agent' falls back to Member on a person comment and in a for line", async () => {
    const odd = await mk("f-sso", `Leo Urbina${tag}'s agent`);
    const other = await mk("f-oth");
    const id = await pub(odd);
    await post(id, odd, { kind: "user", id: odd.userId });
    await post(id, odd, agentWho(odd, IDENT));
    const list = await listComments(E, id, "all", signedIn(other));
    const authors = list.threads.map((t) => t.comments[0]?.author);
    const person = authors.find((a) => a?.kind !== "agent");
    const agent = authors.find((a) => a?.kind === "agent");
    expect(person?.name).toBe("Member");
    expect(agent?.for).toBe("Member");
    const fine = await mk("f-fine", newName());
    const id2 = await pub(fine);
    await post(id2, fine, { kind: "user", id: fine.userId });
    expect((await first(id2, signedIn(other)))?.author.name).toBe(nm);
  });
});

describe("guest names (#1822)", () => {
  it.each([
    "Leo's agent",
    "Leo’s agent",
    "LEO'S AGENT",
    "Leoʼs  Agent ",
    "Leo＇s agent",
  ])("%s is not a guest name", (n) => {
    expect(cleanGuestName(n)).toBe("Guest");
  });
  it("keeps an ordinary name", () => {
    expect(cleanGuestName("Agent Smith")).toBe("Agent Smith");
    expect(cleanGuestName("Jess")).toBe("Jess");
  });
});

describe("lookalikes and agent-shaped names (#1822)", () => {
  beforeEach(() => resetNameClashCache());

  it("skeleton folds fillers, I and l, and the added lookalikes", () => {
    expect(skeleton("AIice")).toBe(skeleton("Alice"));
    expect(skeleton("Al\u3164i\u200bce")).toBe(skeleton("Alice"));
    expect(skeleton("Al\u115F\uFFA0ice")).toBe(skeleton("Alice"));
    expect(skeleton("\u0585\u0251\u029F")).toBe(skeleton("oal"));
    expect(skeleton("\u043F")).toBe(skeleton("n"));
  });

  it("DisplayNameSchema rejects fillers and default-ignorable points", () => {
    for (const bad of [
      "Al\u3164ice",
      "Al\u115Fice",
      "Al\u1160ice",
      "Al\uFFA0ice",
      "Al\u00adice",
    ])
      expect(DisplayNameSchema.safeParse(bad).success).toBe(false);
    expect(DisplayNameSchema.safeParse("Alice").success).toBe(true);
  });

  it("a removed member's name stays reserved, and is not shown as active", async () => {
    const gone = await mk("f-gone", `Rae Gone ${tag}`);
    await E.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(gone.userId)
      .run();
    const live = await mk("f-live", `RAE GONE ${tag}`);
    const id = await pub(live);
    await post(id, live, agentWho(live, IDENT));
    const seen = await first(id, signedIn(await mk("f-oth")));
    expect(seen?.author.for).toBe(
      `RAE GONE ${tag} (member ${memberTag(live.userId)})`,
    );
    expect((await first(id, GUEST))?.author.name).toBe("A member's agent");
  });

  it("an agent that reads as a person's agent shows the product, or Agent", async () => {
    for (const n of [
      "Bob's agent",
      "Bob\u2019s Agent.",
      "B\u043eb\u02bcs  agent!!",
    ])
      expect(readsAsAgent(n)).toBe(true);
    expect(readsAsAgent("Agent Smith")).toBe(false);
    expect(plainAgentName("Bob's agent", "Codex")).toBe("Codex");
    expect(plainAgentName("Bob's agent")).toBe("Agent");
    const owner = await mk("f-own", newName());
    const id = await pub(owner);
    await post(
      id,
      owner,
      agentWho(owner, { ...IDENT, name: "Zed\u2019s agent." }),
    );
    const c = await first(id, signedIn(await mk("f-oth")));
    expect(c?.author.name).toBe("Claude Code");
    const id2 = await pub(owner);
    await post(
      id2,
      owner,
      agentWho(owner, { ...IDENT, name: "Zed's agent", kind: "x" }),
    );
    expect((await first(id2, signedIn(owner)))?.author.name).toBe("Agent");
  });

  it("the guest-name check uses the same folding", () => {
    expect(cleanGuestName("Z\u0435d\u2019s agent.")).toBe("Guest");
  });
});
