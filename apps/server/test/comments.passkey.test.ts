import {
  type Comment,
  type CommentList,
  type PasskeyChallenge,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { addThread } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api, errOf } from "./helpers.js";
import {
  addPasskey,
  assertFor,
  DAY,
  E,
  mkUser,
  type U,
} from "./passkey-fixtures.js";
import type { FakeAuthenticator } from "./passkey-helper.js";

// #2263 B: a pick on an ask the server marked confirm "passkey" needs the
// picker's passkey; a token or MCP grant never carries one.

const app = createApp();
type K = { artifactId: string; threadId: string; commentId: string };
const NOTE = { kind: "note" };
const OPTS = [
  { id: "merge", label: "Merge it", action: "merge" as const },
  { id: "wait", label: "Not yet" },
];

let owner: U;
let alice: U; // asked; has a usable passkey
let aliceKey: FakeAuthenticator;
let bob: U; // asked; no passkey
let artifactId = "";
let asksOnArtifact = 0;
const shared = new Set<string>();

type Member = NonNullable<Awaited<ReturnType<typeof getUser>>>;
const member = async (u: U): Promise<Member> => {
  const m = await getUser(E, u.userId);
  if (!m) throw new Error("no user");
  return m;
};

// Each test starts with a full challenge budget; the 429 test spends its own.
beforeEach(async () => {
  await E.DB.prepare("delete from counters where key like 'pk:ch:%'").run();
});

beforeAll(async () => {
  owner = await mkUser("pk-owner");
  alice = await mkUser("pk-alice");
  bob = await mkUser("pk-bob");
  aliceKey = (await addPasskey(app, alice)).a;
});

/** The artifact for the next ask: a new one every 6 asks (a comment limit per artifact), with `u` shared in. */
async function artifactFor(...us: U[]): Promise<string> {
  if (!artifactId || asksOnArtifact >= 6) {
    const a = await publish(
      E,
      await member(owner),
      { title: "doc", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    );
    artifactId = a.id;
    asksOnArtifact = 0;
  }
  asksOnArtifact++;
  for (const u of [alice, bob, ...us]) {
    if (shared.has(`${artifactId}:${u.userId}`)) continue;
    shared.add(`${artifactId}:${u.userId}`);
    await api(app, R.shares(artifactId), owner.cookie, {
      method: "PUT",
      body: { email: (await member(u)).email, role: "viewer" },
    });
  }
  return artifactId;
}

const ownerWho = () =>
  ({ kind: "user", id: owner.userId, agent: null, typed: true }) as never;

async function ask(
  to: U,
  options: object[] = OPTS,
  extra: object = {},
): Promise<K & { comment: Comment }> {
  const artifactId = await artifactFor(to);
  const t = (await addThread(
    E,
    { id: artifactId, format: "html", currentVersion: 1 } as never,
    ownerWho(),
    { userId: owner.userId, short: null, moderator: true },
    {
      anchor: NOTE as never,
      body: "Merge?",
      ask: {
        question: "Merge?",
        options: options as never,
        to: [{ key: to.userId }],
        ...extra,
      },
    },
    { moderator: true },
  )) as Thread;
  const c = t.comments[0] as Comment;
  return { artifactId, threadId: t.id, commentId: c.id, comment: c };
}

const challenge = (k: K, auth: string, optionId = "merge") =>
  api(
    app,
    R.commentAnswerChallenge(k.artifactId, k.threadId, k.commentId),
    auth,
    {
      method: "POST",
      body: { optionId },
    },
  );
const answer = (k: K, auth: string, body: object) =>
  api(app, R.commentAnswer(k.artifactId, k.threadId, k.commentId), auth, {
    method: "POST",
    body,
  });
const read = async (k: K, auth = alice.cookie) => {
  const l = (await (
    await api(app, R.comments(k.artifactId), auth)
  ).json()) as CommentList;
  return l.threads
    .flatMap((t) => t.comments)
    .find((c) => c.id === k.commentId) as Comment;
};
const settings = (u: U, body: object) =>
  api(app, R.passkeySettings, u.cookie, { method: "PATCH", body });

describe("the server marks asks confirm: passkey", () => {
  it("from the actions the options name, for a member with a passkey", async () => {
    const k = await ask(alice);
    expect(k.comment.ask?.confirm).toBe("passkey");
    expect((await read(k)).ask?.confirm).toBe("passkey");
  });

  it("not for an option with no action, nor for a member with no passkey", async () => {
    expect(
      (
        await ask(alice, [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ])
      ).comment.ask?.confirm,
    ).toBeUndefined();
    expect((await ask(bob)).comment.ask?.confirm).toBeUndefined();
  });

  it("ignores a confirm the client sends", async () => {
    const k = await ask(bob, OPTS, { confirm: "passkey" });
    expect(k.comment.ask?.confirm).toBeUndefined();
  });

  it("follows the switches: an action off is unmarked, every pick marks any ask", async () => {
    const u = await mkUser("pk-sw");
    const { a } = await addPasskey(app, u);
    const on = {
      merge: true,
      deploy: true,
      delete: true,
      share: true,
      public: true,
      command: true,
    };
    const plain = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    expect((await ask(u, plain)).comment.ask?.confirm).toBeUndefined();
    expect((await settings(u, { actions: on, everyPick: true })).status).toBe(
      200,
    );
    expect((await ask(u, plain)).comment.ask?.confirm).toBe("passkey");
    // Off needs an assertion bound to that exact change.
    const body = { actions: { ...on, merge: false }, everyPick: false };
    const c = (await (
      await api(app, R.passkeySettingsChallenge, u.cookie, {
        method: "POST",
        body,
      })
    ).json()) as PasskeyChallenge;
    expect(
      (await settings(u, { ...body, assertion: await assertFor(a, c) })).status,
    ).toBe(200);
    expect((await ask(u, OPTS)).comment.ask?.confirm).toBeUndefined();
    // Run a command is always on.
    expect(
      (
        await ask(u, [
          { id: "r", label: "Run", action: "command" },
          { id: "n", label: "No" },
        ])
      ).comment.ask?.confirm,
    ).toBe("passkey");
  });

  it("an edit leaves the mark", async () => {
    const k = await ask(alice);
    const r = await api(
      app,
      R.comment(k.artifactId, k.threadId, k.commentId),
      owner.cookie,
      {
        method: "PATCH",
        body: { body: "Merge, please?" },
      },
    );
    expect(r.status).toBe(200);
    expect((await read(k)).ask?.confirm).toBe("passkey");
  });
});

describe("POST answer/challenge", () => {
  it("returns WebAuthn options bound to the member, expiring within 2 minutes", async () => {
    const k = await ask(alice);
    const r = await challenge(k, alice.cookie);
    expect(r.status).toBe(200);
    const c = (await r.json()) as PasskeyChallenge;
    expect(c.options).toMatchObject({ userVerification: "required" });
    expect(Date.parse(c.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
  });

  it("409 no_passkey when the member has none left", async () => {
    const u = await mkUser("pk-none");
    const { passkey } = await addPasskey(app, u);
    const k = await ask(u);
    expect(k.comment.ask?.confirm).toBe("passkey");
    await E.DB.prepare("delete from passkeys where id = ?")
      .bind(passkey.id)
      .run();
    const r = await challenge(k, u.cookie);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("no_passkey");
  });

  it("409 passkey_cooling while every passkey is under 24 h", async () => {
    const u = await mkUser("pk-cool");
    await addPasskey(app, u, u.fresh, false);
    const k = await ask(u);
    const r = await challenge(k, u.cookie);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("passkey_cooling");
    // Day one over: it works.
    await E.DB.prepare("update passkeys set created_at = ? where user_id = ?")
      .bind(Date.now() - DAY - 1000, u.userId)
      .run();
    expect((await challenge(k, u.cookie)).status).toBe(200);
  });

  it("403 passkey_required for a token, 403 forbidden for someone not asked", async () => {
    const k = await ask(alice);
    const t = await challenge(k, alice.pat);
    expect(t.status).toBe(403);
    expect((await errOf(t)).code).toBe("passkey_required");
    expect((await challenge(k, bob.cookie)).status).toBe(403);
  });

  it("400 for an ask that needs no passkey and for an unknown option", async () => {
    expect((await challenge(await ask(bob), bob.cookie)).status).toBe(400);
    expect(
      (await challenge(await ask(alice), alice.cookie, "nope")).status,
    ).toBe(400);
  });

  it("is limited per member (429)", async () => {
    const u = await mkUser("pk-spam");
    await addPasskey(app, u);
    const k = await ask(u);
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++)
      last = (await challenge(k, u.cookie)).status;
    expect(last).toBe(429);
  });

  it("409 already_answered once answered", async () => {
    const k = await ask(alice);
    const c = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    expect(
      (
        await answer(k, alice.cookie, {
          optionId: "merge",
          assertion: await assertFor(aliceKey, c),
        })
      ).status,
    ).toBe(200);
    const r = await challenge(k, alice.cookie);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("already_answered");
  });
});

describe("POST answer on a confirm ask", () => {
  it("changing a verified answer needs a new assertion", async () => {
    const k = await ask(alice);
    const c1 = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    const a1 = await assertFor(aliceKey, c1);
    expect(
      (await answer(k, alice.cookie, { optionId: "merge", assertion: a1 }))
        .status,
    ).toBe(200);
    // Without an assertion, or with the spent one, or by token: refused, answer unchanged.
    const bare = await answer(k, alice.cookie, { optionId: "wait" });
    expect(bare.status).toBe(403);
    expect((await errOf(bare)).code).toBe("passkey_required");
    expect(
      (await answer(k, alice.cookie, { optionId: "wait", assertion: a1 }))
        .status,
    ).toBe(410);
    expect((await answer(k, alice.pat, { optionId: "wait" })).status).toBe(403);
    expect((await read(k)).ask?.answer?.optionId).toBe("merge");
    // The same option again is 409; a fresh challenge for the other option works.
    expect((await challenge(k, alice.cookie, "merge")).status).toBe(409);
    const c2 = (await (
      await challenge(k, alice.cookie, "wait")
    ).json()) as PasskeyChallenge;
    const r = await answer(k, alice.cookie, {
      optionId: "wait",
      assertion: await assertFor(aliceKey, c2),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Comment).ask?.answer).toMatchObject({
      optionId: "wait",
      verified: "passkey",
    });
  });

  it("refuses a malformed assertion with 400 bad_request", async () => {
    const k = await ask(alice);
    for (const assertion of [
      { id: "x" },
      "text",
      {
        id: "a",
        rawId: "a",
        type: "public-key",
        response: {
          clientDataJSON: "a".repeat(5000),
          authenticatorData: "a",
          signature: "a",
        },
      },
    ]) {
      const r = await answer(k, alice.cookie, { optionId: "merge", assertion });
      expect(r.status).toBe(400);
    }
  });

  it("a verified pick records verified: passkey, and is your user's yes for the asker", async () => {
    const k = await ask(alice);
    const c = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    const r = await answer(k, alice.cookie, {
      optionId: "merge",
      assertion: await assertFor(aliceKey, c),
    });
    expect(r.status).toBe(200);
    const got = (await r.json()) as Comment;
    expect(got.ask?.answer).toMatchObject({
      optionId: "merge",
      typed: true,
      verified: "passkey",
    });
    expect((await read(k)).ask?.answer?.verified).toBe("passkey");
    // Replaying it is 409: the ask is answered.
    const again = await answer(k, alice.cookie, {
      optionId: "merge",
      assertion: await assertFor(aliceKey, c),
    });
    expect(again.status).toBe(409);
    expect((await errOf(again)).code).toBe("already_answered");
  });

  it("403 passkey_required with no assertion", async () => {
    const k = await ask(alice);
    const r = await answer(k, alice.cookie, { optionId: "merge" });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("passkey_required");
    expect((await read(k)).ask?.answer).toBeUndefined();
  });

  it("403 passkey_required for a token, always, even with a valid assertion", async () => {
    const k = await ask(alice);
    const c = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    const assertion = await assertFor(aliceKey, c);
    for (const body of [
      { optionId: "merge" },
      { optionId: "merge", assertion },
    ]) {
      const r = await answer(k, alice.pat, body);
      expect(r.status).toBe(403);
      expect((await errOf(r)).code).toBe("passkey_required");
    }
    expect((await read(k)).ask?.answer).toBeUndefined();
    // The assertion was not spent by the token: the browser can still use it.
    expect(
      (await answer(k, alice.cookie, { optionId: "merge", assertion })).status,
    ).toBe(200);
  });

  it("410 challenge_expired for a missing, spent or timed-out challenge", async () => {
    const k = await ask(alice);
    const none = await answer(k, alice.cookie, {
      optionId: "merge",
      assertion: {
        id: "x",
        rawId: "x",
        type: "public-key",
        response: {
          clientDataJSON: "x",
          authenticatorData: "x",
          signature: "x",
        },
      },
    });
    expect(none.status).toBe(410);
    expect((await errOf(none)).code).toBe("challenge_expired");
    const c = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    const assertion = await assertFor(aliceKey, c);
    await E.DB.prepare(
      "update pick_assertions set expires_at = ? where user_id = ?",
    )
      .bind(Date.now() - 1, alice.userId)
      .run();
    const late = await answer(k, alice.cookie, {
      optionId: "merge",
      assertion,
    });
    expect(late.status).toBe(410);
    expect((await errOf(late)).code).toBe("challenge_expired");
  });

  it("a challenge is single use, even when the first use failed", async () => {
    const k = await ask(alice);
    const c = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    const bad = await assertFor(aliceKey, c, {
      originOverride: "https://evil.test",
    });
    expect(
      (await answer(k, alice.cookie, { optionId: "merge", assertion: bad }))
        .status,
    ).toBe(400);
    const good = await assertFor(aliceKey, c);
    expect(
      (await answer(k, alice.cookie, { optionId: "merge", assertion: good }))
        .status,
    ).toBe(410);
  });

  it("400 passkey_failed when the challenge was issued for another option", async () => {
    const k = await ask(alice);
    const c = (await (
      await challenge(k, alice.cookie, "wait")
    ).json()) as PasskeyChallenge;
    const r = await answer(k, alice.cookie, {
      optionId: "merge",
      assertion: await assertFor(aliceKey, c),
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("passkey_failed");
  });

  it("a challenge for one ask does not answer another (410)", async () => {
    const k1 = await ask(alice);
    const k2 = await ask(alice);
    const c = (await (
      await challenge(k1, alice.cookie)
    ).json()) as PasskeyChallenge;
    const r = await answer(k2, alice.cookie, {
      optionId: "merge",
      assertion: await assertFor(aliceKey, c),
    });
    expect(r.status).toBe(410);
    expect((await read(k2)).ask?.answer).toBeUndefined();
  });

  it("a new challenge voids the previous one for the ask", async () => {
    const k = await ask(alice);
    const first = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    const second = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    expect(second.options.challenge).not.toBe(first.options.challenge);
    const r = await answer(k, alice.cookie, {
      optionId: "merge",
      assertion: await assertFor(aliceKey, first),
    });
    expect(r.status).toBe(400);
  });

  it("another member's passkey fails (400 passkey_failed)", async () => {
    const k = await ask(alice);
    const mallory = await mkUser("pk-mal");
    const m = await addPasskey(app, mallory);
    const c = (await (
      await challenge(k, alice.cookie)
    ).json()) as PasskeyChallenge;
    const r = await answer(k, alice.cookie, {
      optionId: "merge",
      assertion: await assertFor(m.a, c),
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("passkey_failed");
  });

  it("a passkey still cooling cannot confirm (400)", async () => {
    const u = await mkUser("pk-cool2");
    const fresh = await addPasskey(app, u, u.fresh, false);
    const k = await ask(u);
    // Age it for the challenge, then put it back to cooling before the answer.
    await E.DB.prepare("update passkeys set created_at = ? where id = ?")
      .bind(Date.now() - 2 * DAY, fresh.passkey.id)
      .run();
    const c = (await (await challenge(k, u.cookie)).json()) as PasskeyChallenge;
    await E.DB.prepare("update passkeys set created_at = ? where id = ?")
      .bind(Date.now(), fresh.passkey.id)
      .run();
    const r = await answer(k, u.cookie, {
      optionId: "merge",
      assertion: await assertFor(fresh.a, c),
    });
    expect(r.status).toBe(400);
  });

  it("a signCount that did not grow fails", async () => {
    const u = await mkUser("pk-cnt");
    const { a } = await addPasskey(app, u);
    const k1 = await ask(u);
    const c1 = (await (
      await challenge(k1, u.cookie)
    ).json()) as PasskeyChallenge;
    expect(
      (
        await answer(k1, u.cookie, {
          optionId: "merge",
          assertion: await assertFor(a, c1),
        })
      ).status,
    ).toBe(200);
    const k2 = await ask(u);
    const c2 = (await (
      await challenge(k2, u.cookie)
    ).json()) as PasskeyChallenge;
    const stale = await answer(k2, u.cookie, {
      optionId: "merge",
      assertion: await assertFor(a, c2, { signCount: 1 }),
    });
    expect(stale.status).toBe(400);
  });

  it("a plain ask is answered by a token as before", async () => {
    const k = await ask(bob);
    const r = await answer(k, bob.pat, { optionId: "merge" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Comment).ask?.answer?.verified).toBeUndefined();
  });

  it("someone not asked gets 403 forbidden, and an unknown option 400", async () => {
    const k = await ask(alice);
    expect((await answer(k, bob.cookie, { optionId: "merge" })).status).toBe(
      403,
    );
    expect((await answer(k, alice.cookie, { optionId: "nope" })).status).toBe(
      400,
    );
  });
});
