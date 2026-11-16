import { runInDurableObject } from "cloudflare:test";
import {
  type Comment,
  type CommentList,
  type PasskeyChallenge,
  type PasskeySettings,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { addThread } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api, errOf } from "./helpers.js";
import {
  addPasskey,
  assertFor,
  E,
  mkUser,
  type U,
} from "./passkey-fixtures.js";
import type { FakeAuthenticator } from "./passkey-helper.js";

// #2661 (Axe's must-haves): the mark can only add a prompt; a pick that needs a
// passkey and has none is refused and never recorded as verified; changing the
// own rule or turning a switch off needs the passkey; every settings change is
// audited; asks posted before the rework follow the new rule.

const app = createApp();
const ALL_ON = { highStakes: true, everyAnswer: false, ownRule: "" };
const MARKED = [
  {
    id: "send",
    label: "Send",
    highStakes: { reason: "Emails all 240 customers." },
  },
  { id: "no", label: "No" },
];

let owner: U;
let alice: U;
let aliceKey: FakeAuthenticator;
let nopass: U;
let artifactId = "";

beforeAll(async () => {
  owner = await mkUser("hs-owner");
  alice = await mkUser("hs-alice");
  nopass = await mkUser("hs-none");
  aliceKey = (await addPasskey(app, alice)).a;
  const m = await getUser(E, owner.userId);
  if (!m) throw new Error("no owner");
  artifactId = (
    await publish(
      E,
      m,
      { title: "doc", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    )
  ).id;
  for (const u of [alice, nopass]) {
    const mem = await getUser(E, u.userId);
    await api(app, R.shares(artifactId), owner.cookie, {
      method: "PUT",
      body: { email: mem?.email, role: "editor" },
    });
  }
});

let asks = 0;
async function ask(from: U, options: object[] = MARKED) {
  // A comment limit per artifact: a new page now and then.
  if (asks++ >= 6) {
    const m = await getUser(E, owner.userId);
    artifactId = (
      await publish(
        E,
        m as never,
        { title: "doc", format: "html", content: "<p>x</p>" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    asks = 1;
    for (const u of [alice, nopass]) {
      const mem = await getUser(E, u.userId);
      await api(app, R.shares(artifactId), owner.cookie, {
        method: "PUT",
        body: { email: mem?.email, role: "editor" },
      });
    }
  }
  const t = (await addThread(
    E,
    { id: artifactId, format: "html", currentVersion: 1 } as never,
    { kind: "user", id: from.userId, agent: null, typed: true } as never,
    { userId: from.userId, short: null, moderator: true },
    {
      anchor: { kind: "note" } as never,
      body: "Send it?",
      ask: {
        question: "Send it?",
        options: options as never,
        to: [{ key: from.userId }],
      },
    },
    { moderator: true },
  )) as Thread;
  const c = t.comments[0] as Comment;
  return { artifactId, threadId: t.id, commentId: c.id };
}
type K = Awaited<ReturnType<typeof ask>>;
const answer = (k: K, auth: string, body: object) =>
  api(app, R.commentAnswer(k.artifactId, k.threadId, k.commentId), auth, {
    method: "POST",
    body,
  });
const read = async (k: K, auth: string) =>
  (
    (await (
      await api(app, R.comments(k.artifactId), auth)
    ).json()) as CommentList
  ).threads
    .flatMap((t) => t.comments)
    .find((c) => c.id === k.commentId) as Comment;
const settingsPatch = (u: U, body: object) =>
  api(app, R.passkeySettings, u.cookie, { method: "PATCH", body });
const challengeFor = async (u: U, body: object) =>
  (await (
    await api(app, R.passkeySettingsChallenge, u.cookie, {
      method: "POST",
      body,
    })
  ).json()) as PasskeyChallenge;
const audits = async (u: U) =>
  (
    await E.DB.prepare(
      "select detail from audit_events where actor_id = ? and action = 'passkey.settings' order by at, id",
    )
      .bind(u.userId)
      .all<{ detail: string }>()
  ).results.map((r) => r.detail);

describe("a pick that needs a passkey and has none", () => {
  it("is refused with passkey_required and never recorded, verified or not", async () => {
    const k = await ask(nopass);
    expect((await read(k, nopass.cookie)).ask?.passkeyMissing).toBe(true);
    for (const body of [
      { optionId: "send" },
      { optionId: "send", assertion: { id: "x" } },
    ]) {
      const r = await answer(k, nopass.cookie, body);
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    const bare = await answer(k, nopass.cookie, { optionId: "send" });
    expect((await errOf(bare)).code).toBe("passkey_required");
    // A token never carries one.
    expect(
      (await errOf(await answer(k, nopass.pat, { optionId: "send" }))).code,
    ).toBe("passkey_required");
    const after = (await read(k, nopass.cookie)).ask;
    expect(after?.answer).toBeUndefined();
    // "No" is one tap.
    const ok = await answer(k, nopass.cookie, { optionId: "no" });
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as Comment).ask?.answer?.verified,
    ).toBeUndefined();
  });

  it("a verified pick carries verified: passkey and nothing else", async () => {
    const k = await ask(alice);
    const c = (await (
      await api(
        app,
        R.commentAnswerChallenge(k.artifactId, k.threadId, k.commentId),
        alice.cookie,
        {
          method: "POST",
          body: { optionId: "send" },
        },
      )
    ).json()) as PasskeyChallenge;
    const r = await answer(k, alice.cookie, {
      optionId: "send",
      assertion: await assertFor(aliceKey, c),
    });
    expect(r.status).toBe(200);
    const a = ((await r.json()) as Comment).ask?.answer;
    expect(a?.verified).toBe("passkey");
    expect(a?.passkey).toBeUndefined();
  });
});

describe("the settings", () => {
  it("changing the own rule needs the passkey, bound to that exact change; turning a switch on needs nothing", async () => {
    const u = await mkUser("hs-rule");
    const { a } = await addPasskey(app, u);
    // Turning every answer on: nothing needed.
    expect(
      (await settingsPatch(u, { ...ALL_ON, everyAnswer: true })).status,
    ).toBe(200);
    // A rule with no assertion: refused.
    const body = {
      ...ALL_ON,
      everyAnswer: true,
      ownRule: "anything that emails a customer",
    };
    const bare = await settingsPatch(u, body);
    expect(bare.status).toBe(403);
    expect((await errOf(bare)).code).toBe("passkey_required");
    // An assertion for another rule fails.
    const other = await challengeFor(u, { ...body, ownRule: "something else" });
    const bad = await settingsPatch(u, {
      ...body,
      assertion: await assertFor(a, other),
    });
    expect(bad.status).toBe(400);
    // The right one works, and the rule is read back.
    const c = await challengeFor(u, body);
    const ok = await settingsPatch(u, {
      ...body,
      assertion: await assertFor(a, c),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as PasskeySettings).toMatchObject({
      everyAnswer: true,
      ownRule: "anything that emails a customer",
    });
    // Turning every answer off needs it too.
    const off = { ...body, everyAnswer: false };
    expect((await errOf(await settingsPatch(u, off))).code).toBe(
      "passkey_required",
    );
  });

  it("every change is audited, never with the rule's text", async () => {
    const u = await mkUser("hs-audit");
    const { a } = await addPasskey(app, u);
    await settingsPatch(u, { ...ALL_ON, everyAnswer: true });
    const body = { ...ALL_ON, highStakes: false, ownRule: "secret words" };
    const c = await challengeFor(u, body);
    expect(
      (await settingsPatch(u, { ...body, assertion: await assertFor(a, c) }))
        .status,
    ).toBe(200);
    const rows = await audits(u);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0] as string)).toMatchObject({
      everyAnswer: true,
      passkeyVerified: false,
    });
    expect(JSON.parse(rows[1] as string)).toMatchObject({
      highStakes: false,
      ruleChanged: true,
      weakened: expect.arrayContaining([
        "highStakes",
        "everyAnswer",
        "ownRule",
      ]),
      passkeyVerified: true,
    });
    expect(rows.join()).not.toContain("secret words");
  });
});

describe("asks posted before the rework follow the new rule", () => {
  it("a stored confirm and action are ignored: no mark, no passkey, and the pick is plain", async () => {
    const k = await ask(alice, [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    await runInDurableObject(
      runtimeStub(
        E,
        k.artifactId,
      ) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        state.storage.sql.exec(
          "update comment_asks set confirm = 'passkey', options = json_set(options, '$[0].action', 'merge') where comment_id = ?",
          k.commentId,
        );
      },
    );
    const got = await read(k, alice.cookie);
    expect(got.ask?.options.some((o) => "action" in o)).toBe(false);
    expect((got.ask as { confirm?: unknown }).confirm).toBeUndefined();
    expect(got.ask?.options.some((o) => o.passkey)).toBe(false);
    const r = await answer(k, alice.pat, { optionId: "a" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Comment).ask?.answer?.verified).toBeUndefined();
  });
});
