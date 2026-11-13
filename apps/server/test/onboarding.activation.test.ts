// #2478: the three new activation steps and their first times. Times only.
import { env } from "cloudflare:workers";
import {
  type ArtifactAgent,
  type Comment,
  type CommentList,
  newId,
  OnboardingSchema,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { addReply, addThread } from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { getOnboarding } from "../src/services/onboarding.js";
import {
  askAnsweredKey,
  MENTION_STALLED_MS,
  mentionedKey,
  mentionRepliedKey,
  namedKey,
  noteAgentNamed,
} from "../src/services/onboarding-firsts.js";
import { getUser } from "../src/services/users.js";
import { connectedMachine, FakeHubs } from "./comment-hub.js";
import { api as baseApi, login } from "./helpers.js";

const hubs = new FakeHubs();
const E = hubs.env();
const api = (
  a: Parameters<typeof baseApi>[0],
  p: string,
  auth: string | null,
  init: Parameters<typeof baseApi>[3] = {},
) => baseApi(a, p, auth, init, E);
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const NOTE = { kind: "note" };
const OPTS = [
  { id: "wide", label: "Wide hero" },
  { id: "compact", label: "Compact hero" },
];

const clear = () =>
  env.DB.prepare("delete from settings where key like 'onboarding:%'").run();
const row = (key: string) =>
  env.DB.prepare("select value from settings where key = ?1")
    .bind(key)
    .first<{ value: string }>();
/** The activation rows (the older "commented" flag is not one). */
const rows = async () =>
  (
    await env.DB.prepare(
      "select key, value from settings where key like 'onboarding:%' and key not like 'onboarding:commented:%' order by key",
    ).all<{ key: string; value: string }>()
  ).results;

type U = { cookie: string; userId: string };
let owner: U;
let member: U;
let claude: string;
let artifactId: string;

const mcpWho = (userId: string, identityId = "id-ns-owner-Claude") =>
  ({
    kind: "user",
    id: userId,
    agent: {
      name: "owner token",
      version: null,
      via: null,
      identity: {
        identityId,
        namespace: "ns-owner",
        name: "Claude",
        kind: "x",
      },
    },
  }) as never;
const personWho = (userId: string) =>
  ({ kind: "user", id: userId, typed: true }) as never;
const viewer = (userId: string) =>
  ({ userId, short: null, moderator: true }) as never;
const art = () =>
  ({ id: artifactId, format: "html", currentVersion: 1 }) as never;

beforeAll(async () => {
  owner = await login(`ob-owner-${tag}@x.com`, "owner");
  member = await login(`ob-member-${tag}@x.com`, "member");
  for (const u of [owner, member]) await connectedMachine(env.DB, u.userId);
  const o = await getUser(E, owner.userId);
  if (!o) throw new Error("no owner");
  const a = await publish(
    E,
    o,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  artifactId = a.id;
  hubs.set({
    owner: owner.userId,
    identityId: "id-ns-owner-Claude",
    namespace: "ns-owner",
    name: "Claude",
  });
  hubs.set({
    owner: member.userId,
    identityId: "id-ns-member-Codex",
    namespace: "ns-member",
    name: "Codex",
  });
  await follow(
    E,
    owner.userId,
    { namespace: "ns-owner", name: "Claude" },
    a.id,
  );
  const list = (await (
    await api(app, R.artifactAgents(a.id), owner.cookie)
  ).json()) as ArtifactAgent[];
  const k = list.find((x) => x.name.startsWith("Claude"))?.key;
  if (!k) throw new Error("no agent");
  claude = k;
});
beforeEach(clear);

const state = async (userId = owner.userId) =>
  OnboardingSchema.parse(await getOnboarding(E as Env, userId));

describe("tick 2: the owner's agent is named", () => {
  it("is off until noted, then on, with the first time kept and no text stored", async () => {
    expect((await state()).agentNamed).toBe(false);
    expect(await noteAgentNamed(E, owner.userId)).toBe(true);
    const first = await row(namedKey(owner.userId));
    expect(Number(first?.value)).toBeGreaterThan(0);
    // The second call writes nothing: the first time stays, and reports it.
    expect(await noteAgentNamed(E, owner.userId)).toBe(false);
    expect((await row(namedKey(owner.userId)))?.value).toBe(first?.value);
    const s = await state();
    expect(s.agentNamed).toBe(true);
    // The name is read live from the hub, never stored.
    expect(s.agentName).toBe("Claude");
    for (const r of await rows()) expect(r.value).toMatch(/^\d+$/);
  });

  it("is recorded for the instance owner only", async () => {
    expect(await noteAgentNamed(E, member.userId)).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("the name reads null (the page says 'your agent') until a name exists", async () => {
    expect((await state()).agentName).toBeNull();
  });
});

describe("tick 4: an own agent replied to the owner's mention", () => {
  const mention = () =>
    addThread(
      E,
      art(),
      personWho(owner.userId),
      viewer(owner.userId),
      { anchor: NOTE, body: "hi @Claude", mentions: [{ key: claude }] },
      { moderator: true },
    );

  it("a mention starts the clock; the agent's reply in that thread ticks", async () => {
    const t = await mention();
    expect(
      Number((await row(mentionedKey(owner.userId)))?.value),
    ).toBeGreaterThan(0);
    let s = await state();
    expect(s.mentionReplied).toBe(false);
    expect(s.mentionStalled).toBe(false);
    await addReply(
      E,
      artifactId,
      t.id,
      mcpWho(owner.userId),
      viewer(owner.userId),
      "on it",
    );
    expect(
      Number((await row(mentionRepliedKey(owner.userId)))?.value),
    ).toBeGreaterThan(0);
    s = await state();
    expect(s.mentionReplied).toBe(true);
    expect(s.mentionStalled).toBe(false);
  });

  it("is stalled after 2 minutes with no reply, and a reply clears it", async () => {
    const t = await mention();
    await env.DB.prepare("update settings set value = ?2 where key = ?1")
      .bind(
        mentionedKey(owner.userId),
        String(Date.now() - MENTION_STALLED_MS + 5_000),
      )
      .run();
    expect((await state()).mentionStalled).toBe(false);
    await env.DB.prepare("update settings set value = ?2 where key = ?1")
      .bind(
        mentionedKey(owner.userId),
        String(Date.now() - MENTION_STALLED_MS - 1),
      )
      .run();
    expect((await state()).mentionStalled).toBe(true);
    await addReply(
      E,
      artifactId,
      t.id,
      mcpWho(owner.userId),
      viewer(owner.userId),
      "late",
    );
    const s = await state();
    expect(s.mentionReplied).toBe(true);
    expect(s.mentionStalled).toBe(false);
  });

  it("a plain comment, or an agent comment with no mention before it, ticks nothing", async () => {
    const plain = (await (
      await api(app, R.comments(artifactId), owner.cookie, {
        method: "POST",
        body: { anchor: NOTE, body: "no mention" },
      })
    ).json()) as Thread;
    await addReply(
      E,
      artifactId,
      plain.id,
      mcpWho(owner.userId),
      viewer(owner.userId),
      "unprompted",
    );
    expect(await rows()).toEqual([]);
  });

  it("a reply by a different agent than the one mentioned does not tick", async () => {
    const t = await mention();
    await addReply(
      E,
      artifactId,
      t.id,
      mcpWho(owner.userId, "id-ns-owner-Other"),
      viewer(owner.userId),
      "not me",
    );
    expect(await row(mentionRepliedKey(owner.userId))).toBeNull();
  });

  it("another member's mention of the owner's agent starts nothing for the owner", async () => {
    await addThread(
      E,
      art(),
      personWho(member.userId),
      viewer(member.userId),
      { anchor: NOTE, body: "hey", mentions: [{ key: claude }] },
      { moderator: true },
    );
    expect(await rows()).toEqual([]);
  });
});

describe("tick 5: the owner's typed answer to their own agent's ask", () => {
  const ask = async () =>
    (await addThread(
      E,
      art(),
      mcpWho(owner.userId),
      viewer(owner.userId),
      {
        anchor: NOTE,
        body: "Which layout?",
        ask: {
          question: "Which layout?",
          options: OPTS,
          to: [{ key: owner.userId }],
        },
      },
      { moderator: true },
    )) as Thread;
  const answer = (t: Thread, auth: string) =>
    api(
      app,
      R.commentAnswer(artifactId, t.id, (t.comments[0] as Comment).id),
      auth,
      { method: "POST", body: { optionId: "wide" } },
    );

  it("ticks on the owner's typed pick, once", async () => {
    const t = await ask();
    expect((await state()).askAnswered).toBe(false);
    expect((await answer(t, owner.cookie)).status).toBeLessThan(300);
    const first = await row(askAnsweredKey(owner.userId));
    expect(Number(first?.value)).toBeGreaterThan(0);
    expect((await state()).askAnswered).toBe(true);
    const again = await ask();
    await answer(again, owner.cookie);
    expect((await row(askAnsweredKey(owner.userId)))?.value).toBe(first?.value);
  });

  it("an ask a person posted does not count", async () => {
    const t = (await (
      await api(app, R.comments(artifactId), owner.cookie, {
        method: "POST",
        body: { anchor: NOTE, body: "?" },
      })
    ).json()) as Thread;
    expect(t.comments).toHaveLength(1);
    expect(await row(askAnsweredKey(owner.userId))).toBeNull();
  });

  it("a stored list read changes nothing", async () => {
    await ask();
    await api(app, R.comments(artifactId), owner.cookie);
    expect(
      (
        (await (
          await api(app, R.comments(artifactId), owner.cookie)
        ).json()) as CommentList
      ).threads.length,
    ).toBeGreaterThan(0);
    expect(await row(askAnsweredKey(owner.userId))).toBeNull();
  });
});
