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

// #2263, reworked by #2661: a pick on a high-stakes option needs the picker's
// passkey when their switch is on (or "every answer" is); a token or MCP grant
// never carries one. The server decides per person, from their own settings,
// at read and answer time.

const app = createApp();
type K = { artifactId: string; threadId: string; commentId: string };
const NOTE = { kind: "note" };
const OPTS = [
  { id: "merge", label: "Merge it", highStakes: { reason: "Hard to undo" } },
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
      body: { email: (await member(u)).email, role: "editor" },
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
  /** Who posts it: by default the person asked (a risky ask goes to its asker only). */
  from: U = to,
): Promise<K & { comment: Comment }> {
  const artifactId = await artifactFor(to, from);
  const t = (await addThread(
    E,
    { id: artifactId, format: "html", currentVersion: 1 } as never,
    // #2381: a risky ask is decided by its asker's own user, so the person asked asks it.
    {
      kind: "user",
      id: from.userId,
      agent: null,
      typed: true,
    } as never,
    { userId: from.userId, short: null, moderator: true },
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
const ALL_ON = { highStakes: true, everyAnswer: false, ownRule: "" };

const withMark = (id: string, label: string, reason = "Hard to undo") => ({
  id,
  label,
  highStakes: { reason },
});
const PLAIN = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];
/** Two marked options: each pick needs the passkey. */
const TWO = [withMark("merge", "Merge it"), withMark("wait", "Wait")];
const optionOf = (c: Comment, id: string) =>
  c.ask?.options.find((o) => o.id === id);

describe("the server stamps each viewer (#2661)", () => {
  it("a marked option carries the reason; only the viewer's own switches add `passkey`", async () => {
    const k = await ask(alice);
    const got = await read(k);
    expect(optionOf(got, "merge")).toMatchObject({
      highStakes: { reason: "Hard to undo" },
      passkey: true,
    });
    // "No" is one tap: unmarked options never ask unless every answer is on.
    expect(optionOf(got, "wait")?.passkey).toBeUndefined();
    expect(got.ask?.passkeyMissing).toBeUndefined();
    // The ask is not marked for anyone else by the server: no `confirm`.
    expect((got.ask as { confirm?: unknown }).confirm).toBeUndefined();
  });

  it("a viewer with no passkey sees passkeyMissing on a marked ask, and none on a plain one", async () => {
    const k = await ask(bob);
    const got = await read(k, bob.cookie);
    expect(optionOf(got, "merge")?.passkey).toBe(true);
    expect(got.ask?.passkeyMissing).toBe(true);
    const plain = await ask(bob, PLAIN);
    const p = await read(plain, bob.cookie);
    expect(p.ask?.passkeyMissing).toBeUndefined();
    expect(p.ask?.options.some((o) => o.passkey)).toBe(false);
  });

  it("every answer asks for every option, whatever was marked, and the mark can only add a prompt", async () => {
    const u = await mkUser("pk-every");
    const { a } = await addPasskey(app, u);
    expect((await settings(u, { ...ALL_ON, everyAnswer: true })).status).toBe(
      200,
    );
    const k = await ask(u, OPTS);
    const got = await read(k, u.cookie);
    expect(got.ask?.options.every((o) => o.passkey === true)).toBe(true);
    // An ask with no mark at all asks for it too.
    const plain = await read(await ask(u, PLAIN), u.cookie);
    expect(plain.ask?.options.every((o) => o.passkey === true)).toBe(true);
    // Turning it off needs the passkey, bound to that change.
    const off = { ...ALL_ON, everyAnswer: false };
    const c = (await (
      await api(app, R.passkeySettingsChallenge, u.cookie, {
        method: "POST",
        body: off,
      })
    ).json()) as PasskeyChallenge;
    expect(
      (await settings(u, { ...off, assertion: await assertFor(a, c) })).status,
    ).toBe(200);
  });

  it("a flipped switch applies to an ask already waiting, both ways", async () => {
    const u = await mkUser("pk-flip");
    const { a } = await addPasskey(app, u);
    const k = await ask(u, OPTS);
    expect(optionOf(await read(k, u.cookie), "merge")?.passkey).toBe(true);
    // Off (with the passkey): the same card no longer asks, and the pick is
    // recorded as made with the switch off, never as verified.
    const off = { ...ALL_ON, highStakes: false };
    const c = (await (
      await api(app, R.passkeySettingsChallenge, u.cookie, {
        method: "POST",
        body: off,
      })
    ).json()) as PasskeyChallenge;
    expect(
      (await settings(u, { ...off, assertion: await assertFor(a, c) })).status,
    ).toBe(200);
    const waiting = await read(k, u.cookie);
    expect(optionOf(waiting, "merge")?.passkey).toBeUndefined();
    expect(waiting.ask?.passkeyMissing).toBeUndefined();
    // On again (needs nothing): it asks again, and a bare pick is refused.
    expect((await settings(u, ALL_ON)).status).toBe(200);
    expect(optionOf(await read(k, u.cookie), "merge")?.passkey).toBe(true);
    const refused = await answer(k, u.cookie, { optionId: "merge" });
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).code).toBe("passkey_required");
  });

  it("a high-stakes pick with the switch off records passkey: 'off', never verified", async () => {
    const u = await mkUser("pk-off");
    const { a } = await addPasskey(app, u);
    const off = { ...ALL_ON, highStakes: false };
    const c = (await (
      await api(app, R.passkeySettingsChallenge, u.cookie, {
        method: "POST",
        body: off,
      })
    ).json()) as PasskeyChallenge;
    expect(
      (await settings(u, { ...off, assertion: await assertFor(a, c) })).status,
    ).toBe(200);
    const k = await ask(u, OPTS);
    const r = await answer(k, u.cookie, { optionId: "merge" });
    expect(r.status).toBe(200);
    const got = (await r.json()) as Comment;
    expect(got.ask?.answer).toMatchObject({
      optionId: "merge",
      passkey: "off",
    });
    expect(got.ask?.answer?.verified).toBeUndefined();
    // A plain option records neither.
    const p = await ask(u, [withMark("m", "Merge"), { id: "w", label: "No" }]);
    const plain = (await (
      await answer(p, u.cookie, { optionId: "w" })
    ).json()) as Comment;
    expect(plain.ask?.answer?.passkey).toBeUndefined();
    expect(plain.ask?.answer?.verified).toBeUndefined();
  });

  it("refuses the old fields on input (400, naming highStakes)", async () => {
    for (const extra of [
      { confirm: "passkey" },
      {
        options: [
          { id: "m", label: "Merge", action: "merge" },
          { id: "n", label: "No" },
        ],
      },
      {
        options: [
          { id: "m", label: "Merge", passkey: true },
          { id: "n", label: "No" },
        ],
      },
    ])
      await expect(ask(alice, PLAIN, extra)).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("highStakes"),
      });
  });

  it("requires a plain reason of at most 200 characters", async () => {
    for (const reason of ["", "x".repeat(201), "two\nlines"])
      await expect(
        ask(alice, [withMark("m", "Merge", reason), { id: "n", label: "No" }]),
      ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      ask(alice, [
        { id: "m", label: "Merge", highStakes: {} },
        { id: "n", label: "No" },
      ]),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("an edit is refused (withdraw and post a new card), so the mark can't be changed", async () => {
    const k = await ask(alice);
    const r = await api(
      app,
      R.comment(k.artifactId, k.threadId, k.commentId),
      alice.cookie,
      {
        method: "PATCH",
        body: { body: "Merge, please?" },
      },
    );
    expect(r.status).toBe(409);
    expect(optionOf(await read(k), "merge")?.highStakes?.reason).toBe(
      "Hard to undo",
    );
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

  it("400 for a pick that needs no passkey and for an unknown option", async () => {
    expect(
      (await challenge(await ask(bob, PLAIN), bob.cookie, "a")).status,
    ).toBe(400);
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

describe("POST answer on a high-stakes option", () => {
  it("changing a verified answer needs a new assertion", async () => {
    const k = await ask(alice, TWO);
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
    const k = await ask(alice, TWO);
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
    const k = await ask(bob, PLAIN);
    const r = await answer(k, bob.pat, { optionId: "a" });
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

describe("the decider's own passkey settings (#2381)", () => {
  const plain = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];
  it("an ask with a high-stakes option goes to its asker only: asking someone else is refused", async () => {
    const a = await mkUser("pk-dec-a");
    await addPasskey(app, a);
    await expect(ask(bob, OPTS, {}, a)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("every pick: the asker's passkey is asked for though only someone else is addressed", async () => {
    const a = await mkUser("pk-dec-b");
    await addPasskey(app, a);
    expect((await settings(a, { ...ALL_ON, everyAnswer: true })).status).toBe(
      200,
    );
    const k = await ask(bob, plain, {}, a);
    // The decider (the asker) cannot pick without it; the addressee's own switches are what govern their weigh-in.
    const r = await answer(k, a.cookie, { optionId: "a" });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("passkey_required");
    expect((await answer(k, bob.cookie, { optionId: "a" })).status).toBe(200);
  });

  it("a switch turned on after the ask, or an older ask: the decider's pick still needs the passkey", async () => {
    const a = await mkUser("pk-dec-c");
    const { a: key } = await addPasskey(app, a);
    const k = await ask(bob, plain, {}, a);
    expect((await settings(a, { ...ALL_ON, everyAnswer: true })).status).toBe(
      200,
    );
    const r = await answer(k, a.cookie, { optionId: "a" });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("passkey_required");
    expect(await read(k, a.cookie).then((c) => c.ask?.answer)).toBeUndefined();
    // The addressee's own weigh-in is still plain input.
    expect((await answer(k, bob.cookie, { optionId: "b" })).status).toBe(200);
    expect(key).toBeDefined();
  });
});
