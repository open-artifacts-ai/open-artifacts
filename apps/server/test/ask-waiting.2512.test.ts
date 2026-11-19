// #2512: the "waiting" mark on the page's ask card and the Library card, by the
// inbox's rule: the asker is the viewer's own agent and blocked on the bus; the
// time is the later of the hub's since and the ask's own time.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ArtifactSummary,
  type CommentList,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { waitingSince } from "../src/services/ask-waiting.js";
import { addThread, type CommentWho } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { hubOf } from "./bus/helpers.js";
import { api, login } from "./helpers.js";

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const OPTS = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];
const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });
const agentOf = (u: U, identityId: string): CommentWho =>
  ({
    kind: "user",
    id: u.userId,
    agent: {
      name: "Claude",
      identity: { identityId, name: "Scout", kind: "claude-code" },
    },
  }) as never;
const personOf = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  typed: true,
});

/** `u`'s hub holds a live agent with this identity that says it waits on them, since `at` (a number, or a SQL literal like 9e999 = Infinity). */
async function waitingAgent(u: U, identityId: string, at: number | string) {
  await E.DB.prepare(
    "insert or ignore into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, 0, 1)",
  )
    .bind(`m-${u.userId}`, u.userId, `h-${u.userId}`)
    .run();
  await runInDurableObject(await hubOf(u.userId), (_i, st) => {
    st.storage.sql.exec(
      `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, live, updated_at, status, status_at, identity_id)
       values (?, 'owner', 'ns', 'Scout', 'claude-code', ?, ?, 1, ?, 'waiting_on_owner', ${typeof at === "string" ? at : "?"}, ?)`,
      ...[
        `ag-${identityId}`,
        `m-${u.userId}`,
        `ref-${identityId}`,
        typeof at === "string" ? 0 : at,
        ...(typeof at === "string" ? [] : [at]),
        identityId,
      ],
    );
  });
}

let owner: U;
beforeAll(async () => {
  owner = await mk("wm-owner");
});

async function page(readers: U[]) {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of readers)
    await api(app, R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role: "viewer" },
    });
  return a.id;
}
const ask = (id: string, by: CommentWho, to: U, q = "go?") =>
  addThread(
    E,
    { id, format: "html", currentVersion: 1 } as never,
    by,
    view(owner),
    {
      anchor: { kind: "note" },
      body: q,
      ask: { question: q, options: OPTS, to: [{ key: to.userId }] },
    },
    { moderator: true },
  );
const askOf = async (u: U, id: string) =>
  (
    (await (await api(app, R.comments(id), u.cookie)).json()) as CommentList
  ).threads
    .flatMap((t) => t.comments)
    .find((c) => c.ask)?.ask;

describe("waitingSince (the rule)", () => {
  it("the later of the hub's start and the ask's time; a bad time keeps the hub's", () => {
    const asked = "2026-11-18T10:00:00.000Z";
    const t = Date.parse(asked);
    expect(waitingSince(t - 6 * 86_400_000, asked)).toBe(t);
    expect(waitingSince(t + 60_000, asked)).toBe(t + 60_000);
    expect(waitingSince(5, "not a date")).toBe(5);
    expect(waitingSince(undefined, asked)).toBeUndefined();
    // A non-finite hub time is no wait, whatever the ask's time.
    for (const bad of [Number.NaN, Infinity, -Infinity])
      for (const at of [asked, "not a date"])
        expect(waitingSince(bad, at)).toBeUndefined();
  });
});

describe("the page's ask card", () => {
  it("my own agent, blocked: waitingSince is the ask's time when the wait is older", async () => {
    const me = await mk("wm-me1");
    const id = await page([me]);
    await waitingAgent(me, "idn-own-old", Date.now() - 6 * 86_400_000);
    const t = await ask(id, agentOf(me, "idn-own-old"), me);
    const a = await askOf(me, id);
    expect(a?.waitingSince).toBe(t.comments[0]?.createdAt);
  });

  it("a wait that began after the ask keeps its own time", async () => {
    const me = await mk("wm-me2");
    const id = await page([me]);
    await ask(id, agentOf(me, "idn-own-new"), me);
    const began = Date.now() + 5 * 60_000;
    await waitingAgent(me, "idn-own-new", began);
    expect((await askOf(me, id))?.waitingSince).toBe(
      new Date(began).toISOString(),
    );
  });

  it("absent for another person's agent, even one blocked in their hub", async () => {
    const me = await mk("wm-me3");
    const them = await mk("wm-them3");
    const id = await page([me, them]);
    await waitingAgent(them, "idn-theirs", Date.now() - 3_600_000);
    await ask(id, agentOf(them, "idn-theirs"), me);
    const a = await askOf(me, id);
    expect(a).toBeDefined();
    expect(a?.waitingSince).toBeUndefined();
  });

  it("absent when my agent is not blocked, for a person's ask, and for another person's view", async () => {
    const me = await mk("wm-me4");
    const other = await mk("wm-other4");
    const id = await page([me, other]);
    // Not blocked: no hub row at all.
    await ask(id, agentOf(me, "idn-idle"), me, "idle?");
    expect((await askOf(me, id))?.waitingSince).toBeUndefined();
    // A blocked agent of mine, but the ask is to someone else: they see none, and so do I.
    const id2 = await page([me, other]);
    await waitingAgent(me, "idn-blocked-4", Date.now() - 3_600_000);
    await ask(id2, agentOf(me, "idn-blocked-4"), other, "to other");
    expect((await askOf(other, id2))?.waitingSince).toBeUndefined();
    // The mark is for the person it is put to: not the asker's own user, who
    // holds no row for it in the inbox, though their agent is blocked.
    expect((await askOf(me, id2))?.waitingSince).toBeUndefined();
    // A person's own ask to me.
    const id3 = await page([me]);
    await ask(id3, personOf(owner), me);
    expect((await askOf(me, id3))?.waitingSince).toBeUndefined();
  });
});

describe("the Library card", () => {
  const list = async (u: U) =>
    (
      (await (await api(app, `${R.artifacts}?limit=100`, u.cookie)).json()) as {
        items: ArtifactSummary[];
      }
    ).items;

  it("counts the asks waiting on me and the oldest wait; no mark without one", async () => {
    const me = await mk("wm-lib");
    const waitingPage = await page([me]);
    const plainPage = await page([me]);
    await waitingAgent(me, "idn-lib", Date.now() - 6 * 86_400_000);
    const first = await ask(waitingPage, agentOf(me, "idn-lib"), me, "one?");
    await ask(waitingPage, agentOf(me, "idn-lib"), me, "two?");
    // A plain ask from a person: counted in asksForYou, never waiting.
    await ask(waitingPage, personOf(owner), me, "plain?");
    await ask(plainPage, personOf(owner), me, "just a person");
    const items = await list(me);
    const w = items.find((i) => i.id === waitingPage);
    expect(w?.asksForYou).toBe(3);
    expect(w?.waiting?.count).toBe(2);
    // The wait is older than both asks: the oldest is the first ask's time.
    expect(w?.waiting?.oldestSince).toBe(first.comments[0]?.createdAt);
    const p = items.find((i) => i.id === plainPage);
    expect(p?.asksForYou).toBe(1);
    expect(p?.waiting).toBeUndefined();
  });

  it("another person's blocked agent is no mark on my card", async () => {
    const me = await mk("wm-lib2");
    const them = await mk("wm-lib2t");
    const id = await page([me, them]);
    await waitingAgent(them, "idn-lib-theirs", Date.now() - 3_600_000);
    await ask(id, agentOf(them, "idn-lib-theirs"), me);
    const card = (await list(me)).find((i) => i.id === id);
    expect(card?.asksForYou).toBe(1);
    expect(card?.waiting).toBeUndefined();
  });
});

describe("a non-finite hub time never throws and shows no mark (#2512)", () => {
  it("the page's ask card, the Library card and the inbox", async () => {
    const me = await mk("wm-inf");
    const id = await page([me]);
    // Infinity as the hub stores it (a bad status_at).
    await waitingAgent(me, "idn-inf", "9e999");
    await ask(id, agentOf(me, "idn-inf"), me);
    // The page's ask card.
    const c = await api(app, R.comments(id), me.cookie);
    expect(c.status).toBe(200);
    expect((await askOf(me, id))?.waitingSince).toBeUndefined();
    // The Library card.
    const l = await api(app, `${R.artifacts}?limit=100`, me.cookie);
    expect(l.status).toBe(200);
    const card = ((await l.json()) as { items: ArtifactSummary[] }).items.find(
      (i) => i.id === id,
    );
    expect(card?.asksForYou).toBe(1);
    expect(card?.waiting).toBeUndefined();
    // The inbox: the ask is listed, plain, with no waitingSince.
    const inb = await api(app, R.meInbox, me.cookie);
    expect(inb.status).toBe(200);
    const item = (
      (await inb.json()) as {
        needsYou: {
          artifact: { id: string } | null;
          urgency?: string;
          waitingSince?: string;
        }[];
      }
    ).needsYou.find((i) => i.artifact?.id === id);
    expect(item).toBeDefined();
    expect(item?.waitingSince).toBeUndefined();
    expect(item?.urgency).not.toBe("waiting");
  });
});
