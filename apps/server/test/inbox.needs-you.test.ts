import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Inbox, type Me, type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  addThread,
  answerAsk,
  type CommentWho,
  setStatus,
} from "../src/services/comments.js";
import { deleteShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { hubOf } from "./bus/helpers.js";
import { api, login } from "./helpers.js";

// #2512 S1: GET R.meInbox, the Needs-you list from the asks index.

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

let owner: U;
let me: U;
let other: U;
beforeAll(async () => {
  owner = await mk("i-owner");
  me = await mk("i-me");
  other = await mk("i-other");
});

const OPTS = [
  { id: "a", label: "Option A" },
  { id: "b", label: "Option B" },
];
const who = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });

async function mkArtifact(readers: U[] = [me, other]) {
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

function ask(
  id: string,
  to: U[],
  question = "Which one do we ship?",
  by: CommentWho = who(owner),
  asker: U = owner,
) {
  return addThread(
    E,
    { id, format: "html", currentVersion: 1 } as never,
    by,
    view(asker),
    {
      anchor: { kind: "note" },
      body: "Which one?",
      ask: {
        question,
        options: OPTS,
        to: to.map((u) => ({ key: u.userId })),
      },
    },
    { moderator: true },
  );
}

/** The member's hub holds a live agent with this identity that says it waits on them. */
async function waitingAgent(u: U, identityId: string, at: number) {
  await E.DB.prepare(
    "insert or ignore into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, 0, 1)",
  )
    .bind(`m-${u.userId}`, u.userId, `h-${u.userId}`)
    .run();
  await runInDurableObject(await hubOf(u.userId), (_i, st) => {
    st.storage.sql.exec(
      `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, live, updated_at, status, status_at, identity_id)
       values (?, 'owner', 'ns', 'Scout', 'claude-code', ?, ?, 1, ?, 'waiting_on_owner', ?, ?)`,
      `ag-${identityId}`,
      `m-${u.userId}`,
      `ref-${identityId}`,
      at,
      at,
      identityId,
    );
  });
}

const inbox = async (u: U) => {
  const r = await api(app, R.meInbox, u.cookie);
  expect(r.status).toBe(200);
  return (await r.json()) as Inbox;
};
const mine = async (u: U, id: string) =>
  (await inbox(u)).needsYou.filter((i) => i.artifact?.id === id);

describe("GET R.meInbox: Needs you", () => {
  it("an ask to me shows with fixed text and the page link, never the options", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [me]);
    const items = await mine(me, id);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0).toMatchObject({
      level: "needs_you",
      kind: "ask",
      urgency: "plain",
      text: `${it0?.actor?.name} asks: Which one do we ship?`,
      href: `/a/${id}?thread=${t.id}`,
      artifact: { id, title: "doc" },
      readAt: null,
    });
    expect(it0?.actor).toMatchObject({ kind: "user", id: owner.userId });
    expect(JSON.stringify(it0)).not.toContain("Option A");
    const all = await inbox(me);
    expect(all.later).toEqual([]);
    expect(all.updates).toEqual([]);
    expect(all.cursor).toBeNull();
  });

  it("trims the question to 200 characters", async () => {
    const id = await mkArtifact();
    await ask(id, [me], "q".repeat(300));
    const [item] = await mine(me, id);
    expect(item?.text.endsWith(`asks: ${"q".repeat(200)}`)).toBe(true);
  });

  it("an ask to someone else is absent", async () => {
    const id = await mkArtifact();
    await ask(id, [other]);
    expect(await mine(me, id)).toEqual([]);
    expect(await mine(other, id)).toHaveLength(1);
  });

  it("answered, resolved, deleted, comments off and no-longer-visible asks are absent", async () => {
    const answered = await mkArtifact();
    const t = await ask(answered, [me]);
    await answerAsk(
      E,
      answered,
      t.id,
      t.comments[0]?.id as string,
      who(me),
      view(me),
      "a",
      undefined,
      { interactive: true },
      { canDecide: true, guest: false },
    );
    expect(await mine(me, answered)).toEqual([]);

    const resolved = await mkArtifact();
    const r = await ask(resolved, [me]);
    await setStatus(E, resolved, r.id, who(owner), view(owner), "resolved");
    expect(await mine(me, resolved)).toEqual([]);

    const deleted = await mkArtifact();
    await ask(deleted, [me]);
    expect(await mine(me, deleted)).toHaveLength(1);
    await api(app, R.artifact(deleted), owner.cookie, { method: "DELETE" });
    expect(await mine(me, deleted)).toEqual([]);

    const off = await mkArtifact();
    await ask(off, [me]);
    await api(app, R.artifact(off), owner.cookie, {
      method: "PATCH",
      body: { comments: false },
    });
    expect(await mine(me, off)).toEqual([]);

    const gone = await mkArtifact();
    await ask(gone, [me]);
    expect(await mine(me, gone)).toHaveLength(1);
    await deleteShare(E, owner.member, gone, me.email);
    expect(await mine(me, gone)).toEqual([]);
  });

  it("orders waiting, then approval, then plain, oldest first in each", async () => {
    const u = await mk("i-order");
    const sess = (m: U) => view(m);
    // The asker is the one asked (an ask that names an action goes to the asker only): they own the page.
    const own = await publish(
      E,
      u.member,
      { title: "mine", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    );
    const at = (q: string, opts: object[], by?: CommentWho) =>
      addThread(
        E,
        { id: own.id, format: "html", currentVersion: 1 } as never,
        by ?? who(u),
        sess(u),
        {
          anchor: { kind: "note" },
          body: q,
          ask: { question: q, options: opts as never, to: [{ key: u.userId }] },
        },
        { moderator: true },
      );
    await at("plain old", OPTS);
    await at("merge it?", [
      { id: "y", label: "Merge", action: "merge" },
      { id: "n", label: "No" },
    ]);
    await at("plain newer", OPTS);
    await waitingAgent(u, "idn-wait", Date.parse("2026-11-14T08:00:00Z"));
    await at("go?", OPTS, {
      kind: "user",
      id: u.userId,
      agent: {
        name: "Claude",
        identity: {
          identityId: "idn-wait",
          name: "Scout",
          kind: "claude-code",
        },
      },
    } as never);
    const items = (await inbox(u)).needsYou.filter(
      (i) => i.artifact?.id === own.id,
    );
    expect(items.map((i) => i.urgency)).toEqual([
      "waiting",
      "approval",
      "plain",
      "plain",
    ]);
    expect(items.map((i) => i.text.split("asks: ")[1])).toEqual([
      "go?",
      "merge it?",
      "plain old",
      "plain newer",
    ]);
    expect(items[0]).toMatchObject({
      waitingSince: "2026-11-14T08:00:00.000Z",
      agentKey: "idn-wait",
    });
    expect(items[0]?.actor?.kind).toBe("agent");
  });

  it("an agent of someone else waiting on its owner is not waiting on me", async () => {
    await waitingAgent(owner, "idn-theirs", Date.parse("2026-11-14T07:00:00Z"));
    const id = await mkArtifact();
    await ask(id, [me], "from their agent", {
      kind: "user",
      id: owner.userId,
      agent: {
        name: "Claude",
        identity: {
          identityId: "idn-theirs",
          name: "Scout",
          kind: "claude-code",
        },
      },
    } as never);
    const [item] = await mine(me, id);
    expect(item?.urgency).toBe("plain");
    expect(item?.waitingSince).toBeUndefined();
  });

  it("R.me counts the same asks", async () => {
    const u = await mk("i-count");
    const id = await mkArtifact([u]);
    await ask(id, [u]);
    await ask(id, [u]);
    const r = await api(app, R.me, u.cookie);
    const j = (await r.json()) as Me;
    expect(j.inbox).toEqual({ needsYou: 2, unreadUpdates: 0 });
    expect((await inbox(u)).counts.needsYou).toBe(2);
  });

  it("another person's token or session reads only their own list", async () => {
    const id = await mkArtifact();
    await ask(id, [me]);
    expect(await mine(other, id)).toEqual([]);
    const anon = await api(app, R.meInbox, "");
    expect(anon.status).toBe(401);
  });

  it("a personal access token reads its own owner's inbox only", async () => {
    const id = await mkArtifact();
    await ask(id, [me]);
    const read = async (u: U) => {
      const { token } = await createPat(E, u.userId, "inbox");
      const r = await api(app, R.meInbox, token);
      expect(r.status).toBe(200);
      return ((await r.json()) as Inbox).needsYou.filter(
        (i) => i.artifact?.id === id,
      );
    };
    expect(await read(me)).toHaveLength(1);
    expect(await read(other)).toEqual([]);
  });
});
