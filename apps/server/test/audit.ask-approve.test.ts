import {
  type Comment,
  type PasskeyChallenge,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { addThread } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api } from "./helpers.js";
import {
  addPasskey,
  assertFor,
  E,
  mkUser,
  type U,
} from "./passkey-fixtures.js";
import type { FakeAuthenticator } from "./passkey-helper.js";

// #2458: a risky ask's decision writes one ask.approve row: ids and enums,
// never the question, an option's text or an address.

const app = createApp();
type K = { artifactId: string; threadId: string; commentId: string };
const QUESTION = "Ship the zebra-quartz change?";
const LABEL = "Merge the zebra-quartz change";
const OPTS = [
  { id: "merge", label: LABEL, action: "merge" as const },
  { id: "wait", label: "Not yet" },
];
const PLAIN = [
  { id: "a", label: "Option A" },
  { id: "b", label: "Option B" },
];

type Row = {
  id: string;
  actor_kind: string;
  actor_id: string | null;
  actor_cred_kind: string | null;
  target_type: string;
  target_id: string;
  detail: string;
};
const rows = async (k: K) =>
  (
    await E.DB.prepare(
      "select * from audit_events where action = 'ask.approve' and target_id = ? order by at, id",
    )
      .bind(k.commentId)
      .all<Row>()
  ).results;

let owner: U;
let alice: U; // has a passkey
let aliceKey: FakeAuthenticator;
let bob: U; // none
let artifactId = "";
let asks = 0;

beforeEach(async () => {
  await E.DB.prepare("delete from counters where key like 'pk:ch:%'").run();
});
beforeAll(async () => {
  owner = await mkUser("aa-owner");
  alice = await mkUser("aa-alice");
  bob = await mkUser("aa-bob");
  aliceKey = (await addPasskey(app, alice)).a;
});

const member = async (u: U) => {
  const m = await getUser(E, u.userId);
  if (!m) throw new Error("no user");
  return m;
};

async function ask(
  to: U,
  options: object[],
  from: U = to,
  agent?: object,
): Promise<K> {
  if (!artifactId || asks >= 5) {
    artifactId = (
      await publish(
        E,
        await member(owner),
        { title: "doc", format: "html", content: "<p>x</p>" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    asks = 0;
    for (const u of [alice, bob]) {
      await api(app, R.shares(artifactId), owner.cookie, {
        method: "PUT",
        body: { email: (await member(u)).email, role: "editor" },
      });
    }
  }
  asks++;
  const t = (await addThread(
    E,
    { id: artifactId, format: "html", currentVersion: 1 } as never,
    {
      kind: "user",
      id: from.userId,
      ...(agent ? { agent } : { agent: null, typed: true }),
    } as never,
    { userId: from.userId, short: null, moderator: true },
    {
      anchor: { kind: "note" } as never,
      body: QUESTION,
      ask: {
        question: QUESTION,
        options: options as never,
        to: [{ key: to.userId }],
      },
    },
    { moderator: true },
  )) as Thread;
  return {
    artifactId,
    threadId: t.id,
    commentId: (t.comments[0] as Comment).id,
  };
}

const answer = (k: K, auth: string, body: object) =>
  api(app, R.commentAnswer(k.artifactId, k.threadId, k.commentId), auth, {
    method: "POST",
    body,
  });
const passkeyPick = async (k: K, optionId = "merge") => {
  const r = await api(
    app,
    R.commentAnswerChallenge(k.artifactId, k.threadId, k.commentId),
    alice.cookie,
    { method: "POST", body: { optionId } },
  );
  const c = (await r.json()) as PasskeyChallenge;
  if (!c.options) throw new Error(`challenge ${r.status} ${JSON.stringify(c)}`);
  return answer(k, alice.cookie, {
    optionId,
    assertion: await assertFor(aliceKey, c),
  });
};

describe("ask.approve", () => {
  it("a passkey decision: who, ids, the option, the action, passkey true; no text", async () => {
    const k = await ask(alice, OPTS);
    expect((await passkeyPick(k)).status).toBe(200);
    const r = await rows(k);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      actor_kind: "user",
      actor_id: alice.userId,
      actor_cred_kind: "session",
      target_type: "ask",
      target_id: k.commentId,
    });
    expect(JSON.parse(r[0]?.detail ?? "")).toEqual({
      artifactId: k.artifactId,
      threadId: k.threadId,
      commentId: k.commentId,
      optionId: "merge",
      action: "merge",
      passkey: true,
      askerIsAgent: false,
    });
    const all = JSON.stringify(r);
    for (const s of [QUESTION, LABEL, "zebra", "Option", "Not yet"])
      expect(all).not.toContain(s);
    expect(all).not.toMatch(/@/);
    // Replaying the same pick is refused (409) and writes nothing more.
    expect((await answer(k, alice.cookie, { optionId: "merge" })).status).toBe(
      409,
    );
    expect(await rows(k)).toHaveLength(1);
  });

  it("an action option with no passkey on file: passkey false, by token", async () => {
    const k = await ask(bob, OPTS);
    expect((await answer(k, bob.pat, { optionId: "merge" })).status).toBe(200);
    const [row] = await rows(k);
    expect(row).toMatchObject({
      actor_id: bob.userId,
      actor_cred_kind: "pat",
    });
    expect(JSON.parse(row?.detail ?? "")).toMatchObject({
      action: "merge",
      passkey: false,
    });
    // A retried or repeated pick, even concurrent, never writes a second row.
    const before = (await rows(k))[0]?.id;
    await Promise.all(
      [1, 2, 3].map(() => answer(k, bob.pat, { optionId: "merge" })),
    );
    const after = await rows(k);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before);
  });

  it("a row lost to a failed write is written by the retry, once", async () => {
    const k = await ask(bob, OPTS);
    await E.DB.prepare(
      "create trigger if not exists ask_audit_fail2 before insert on audit_events when new.action = 'ask.approve' begin select raise(abort, 'audit down'); end",
    ).run();
    try {
      expect((await answer(k, bob.pat, { optionId: "merge" })).status).toBe(
        200,
      );
    } finally {
      await E.DB.prepare("drop trigger if exists ask_audit_fail2").run();
    }
    expect(await rows(k)).toHaveLength(0);
    expect((await answer(k, bob.pat, { optionId: "merge" })).status).toBe(200);
    expect((await answer(k, bob.pat, { optionId: "merge" })).status).toBe(200);
    expect(await rows(k)).toHaveLength(1);
  });

  it("changing the decision is a new decision: a second row", async () => {
    const k = await ask(bob, [
      ...OPTS,
      { id: "deploy", label: "Deploy", action: "deploy" as const },
    ]);
    await answer(k, bob.pat, { optionId: "merge" });
    await answer(k, bob.pat, { optionId: "deploy" });
    const r = await rows(k);
    expect(r.map((x) => JSON.parse(x.detail).action).sort()).toEqual([
      "deploy",
      "merge",
    ]);
  });

  it("the option picked decides: a plain option on an action ask writes nothing", async () => {
    const k = await ask(bob, OPTS);
    expect((await answer(k, bob.pat, { optionId: "wait" })).status).toBe(200);
    expect(await rows(k)).toHaveLength(0);
  });

  it("an ask by an agent records the agent's identity id, not its name", async () => {
    const k = await ask(bob, OPTS, bob, {
      name: "robot-name",
      identity: { identityId: "idn-ask-1", name: "robot-name", kind: "claude" },
    });
    expect((await answer(k, bob.pat, { optionId: "merge" })).status).toBe(200);
    const [row] = await rows(k);
    expect(JSON.parse(row?.detail ?? "")).toMatchObject({
      askerIsAgent: true,
      askerAgentId: "idn-ask-1",
    });
    expect(row?.detail).not.toContain("robot-name");
  });

  it("a weigh-in writes nothing", async () => {
    const k = await ask(bob, PLAIN, alice);
    expect((await answer(k, bob.cookie, { optionId: "a" })).status).toBe(200);
    expect(await rows(k)).toHaveLength(0);
  });

  it("a plain ask decided writes nothing", async () => {
    const k = await ask(bob, PLAIN);
    expect((await answer(k, bob.pat, { optionId: "a" })).status).toBe(200);
    expect(await rows(k)).toHaveLength(0);
  });

  it("refused picks write nothing: no assertion, a token with passkey ask, a stranger", async () => {
    const k = await ask(alice, OPTS);
    expect((await answer(k, alice.cookie, { optionId: "merge" })).status).toBe(
      403,
    );
    expect((await answer(k, alice.pat, { optionId: "merge" })).status).toBe(
      403,
    );
    expect((await answer(k, bob.cookie, { optionId: "merge" })).status).toBe(
      403,
    );
    expect(await rows(k)).toHaveLength(0);
  });

  it("a failing audit insert is logged and does not fail the pick", async () => {
    const k = await ask(bob, OPTS);
    await E.DB.prepare(
      "create trigger if not exists ask_audit_fail before insert on audit_events when new.action = 'ask.approve' begin select raise(abort, 'audit down'); end",
    ).run();
    try {
      expect((await answer(k, bob.pat, { optionId: "merge" })).status).toBe(
        200,
      );
    } finally {
      await E.DB.prepare("drop trigger if exists ask_audit_fail").run();
    }
    expect(await rows(k)).toHaveLength(0);
  });
});
