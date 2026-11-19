import { runInDurableObject } from "cloudflare:test";
import {
  type Comment,
  type CommentList,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { addThread } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api, errOf } from "./helpers.js";
import { addPasskey, E, mkUser, type U } from "./passkey-fixtures.js";

// #2864: no ask needs a passkey for now. A typed pick is the answer, whatever
// the stored passkey switches say; old stored `confirm` marks are dropped.

const app = createApp();
type K = { artifactId: string; threadId: string; commentId: string };
const NOTE = { kind: "note" };
const OPTS = [
  { id: "merge", label: "Merge it", action: "merge" as const },
  { id: "wait", label: "Not yet" },
];

let owner: U;
let alice: U; // asked; has a usable passkey
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
  await addPasskey(app, alice);
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

const ON = {
  merge: true,
  deploy: true,
  delete: true,
  share: true,
  public: true,
  command: true,
};
const ACTIONS = [
  "merge",
  "deploy",
  "delete",
  "share",
  "public",
  "command",
] as const;

describe("no ask carries or needs a passkey (#2864)", () => {
  it("a member with every switch on gets no confirm and answers with a typed pick", async () => {
    const u = await mkUser("pk-on");
    await addPasskey(app, u);
    expect((await settings(u, { actions: ON, everyPick: true })).status).toBe(
      200,
    );
    for (const action of ACTIONS) {
      const k = await ask(u, [
        { id: "go", label: "Go", action },
        { id: "no", label: "No" },
      ]);
      expect(k.comment.ask?.confirm).toBeUndefined();
      expect((await read(k, u.cookie)).ask?.confirm).toBeUndefined();
      const r = await answer(k, u.cookie, { optionId: "go" });
      expect(r.status).toBe(200);
      const done = (await r.json()) as Comment;
      expect(done.ask?.confirm).toBeUndefined();
      expect(done.ask?.answer?.optionId).toBe("go");
      expect(done.ask?.answer?.verified).toBeUndefined();
    }
  });

  it("every pick on, a plain ask is answered without a passkey too", async () => {
    const u = await mkUser("pk-every");
    await addPasskey(app, u);
    await settings(u, { actions: ON, everyPick: true });
    const k = await ask(u, [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    expect(k.comment.ask?.confirm).toBeUndefined();
    expect((await answer(k, u.cookie, { optionId: "a" })).status).toBe(200);
  });

  it("a member with no passkey answers a merge ask in one pick", async () => {
    const k = await ask(bob);
    expect(k.comment.ask?.confirm).toBeUndefined();
    const r = await answer(k, bob.cookie, { optionId: "merge" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Comment).ask?.answer?.optionId).toBe("merge");
  });

  it("an ask stored earlier with confirm passkey is read without it and is pickable", async () => {
    const k = await ask(alice);
    // The row as an older server wrote it.
    await runInDurableObject(
      runtimeStub(
        E,
        k.artifactId,
      ) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        state.storage.sql.exec(
          "update comment_asks set confirm = 'passkey' where comment_id = ?",
          k.commentId,
        );
      },
    );
    const seen = await read(k);
    expect(seen.ask?.confirm).toBeUndefined();
    const r = await answer(k, alice.cookie, { optionId: "merge" });
    expect(r.status).toBe(200);
    const done = (await r.json()) as Comment;
    expect(done.ask?.confirm).toBeUndefined();
    expect(done.ask?.answer?.optionId).toBe("merge");
  });

  it("the pick challenge route needs no passkey: 400, never a prompt", async () => {
    const k = await ask(alice);
    const r = await api(
      app,
      R.commentAnswerChallenge(k.artifactId, k.threadId, k.commentId),
      alice.cookie,
      { method: "POST", body: { optionId: "merge" } },
    );
    expect(r.status).toBe(400);
  });

  it("the other ask rules stay: a stranger gets 403, an unknown option 400, a token's pick is data", async () => {
    const k = await ask(alice);
    expect((await answer(k, owner.cookie, { optionId: "merge" })).status).toBe(
      403,
    );
    expect((await answer(k, alice.cookie, { optionId: "zzz" })).status).toBe(
      400,
    );
    const r = await answer(k, alice.pat, { optionId: "merge" });
    if (r.status === 200) {
      const c = (await r.json()) as Comment;
      expect(c.ask?.answer?.yes).not.toBe(true);
    } else expect((await errOf(r)).code).not.toBe("passkey_required");
  });

  describe("an untyped pick never replaces a typed decision (#2886)", () => {
    it("typed pick, then a token pick of the same or another option: the answer and yes stay", async () => {
      for (const optionId of ["merge", "wait"]) {
        const k = await ask(alice);
        expect(
          (await answer(k, alice.cookie, { optionId: "merge" })).status,
        ).toBe(200);
        const r = await answer(k, alice.pat, { optionId });
        expect(r.status).toBe(200);
        const c = await read(k);
        expect(c.ask?.answer?.optionId).toBe("merge");
        expect(c.ask?.answer?.yes).toBe(true);
        expect(c.ask?.answer?.typed).toBe(true);
        const mine = c.ask?.picks?.filter((p) => p.optionId === optionId);
        expect(mine?.length).toBeGreaterThan(0);
        // A typed pick still replaces it.
        expect(
          (await answer(k, alice.cookie, { optionId: "wait" })).status,
        ).toBe(200);
        expect((await read(k)).ask?.answer?.optionId).toBe("wait");
      }
    });

    it("untyped picks kept beside a typed decision hit the per-person cap and are refused", async () => {
      const u = await mkUser("pk-cap");
      const k = await ask(u);
      expect((await answer(k, u.cookie, { optionId: "merge" })).status).toBe(
        200,
      );
      let refused = 0;
      for (let i = 0; i < 60; i++) {
        const r = await answer(k, u.pat, {
          optionId: i % 2 ? "merge" : "wait",
        });
        if (r.status !== 200) {
          expect((await errOf(r)).code).toBe("rate_limited");
          refused++;
        }
      }
      expect(refused).toBeGreaterThan(0);
      const c = await read(k, u.cookie);
      expect(c.ask?.answer?.optionId).toBe("merge");
      expect(c.ask?.answer?.yes).toBe(true);
    });

    it("a token pick with no typed answer sets the answer as before (not a yes)", async () => {
      const k = await ask(alice);
      expect((await answer(k, alice.pat, { optionId: "merge" })).status).toBe(
        200,
      );
      const c = await read(k);
      expect(c.ask?.answer?.optionId).toBe("merge");
      expect(c.ask?.answer?.yes).not.toBe(true);
      // A typed pick then replaces the untyped answer.
      expect(
        (await answer(k, alice.cookie, { optionId: "merge" })).status,
      ).toBe(200);
      expect((await read(k)).ask?.answer?.yes).toBe(true);
    });

    it("a plain ask (no action) is unchanged: the token pick replaces", async () => {
      const k = await ask(alice, [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]);
      expect((await answer(k, alice.cookie, { optionId: "a" })).status).toBe(
        200,
      );
      expect((await answer(k, alice.pat, { optionId: "b" })).status).toBe(200);
      expect((await read(k)).ask?.answer?.optionId).toBe("b");
    });
  });
});
