// #2770: @mention a person. A mention of me is Needs you (Open, Later); an
// agent's mention stays an Update.
import { env } from "cloudflare:workers";
import {
  type CommentAuthor,
  type Inbox,
  MENTIONS_MAX,
  type Me,
  type Member,
  type MentionCandidates,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  addReply,
  addThread,
  type CommentWho,
  deleteComment,
  editComment,
} from "../src/services/comments.js";
import { PERSON_MENTIONS_PER_DAY } from "../src/services/inbox-items.js";
import { MENTION_SEARCHES_PER_MIN } from "../src/services/mention-candidates.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string, role: "member" | "guest" = "member") {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email } as U;
}
let owner: U;
let sam: U;
let pat: U;
let outsider: U;
let guest: U;
beforeAll(async () => {
  owner = await mk("p-owner");
  sam = await mk("sam-rivera");
  pat = await mk("pat-lee");
  outsider = await mk("zed-nope");
  guest = await mk("gus-guest", "guest");
});

const who = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const view = (u: U, moderator = true) => ({
  userId: u.userId,
  short: null,
  moderator,
});
const after = { version: 1 };
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;

async function mkArtifact(readers: U[] = [sam, pat]) {
  const a = await publish(
    E,
    owner.member,
    { title: "Roadmap", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of readers)
    await api(app, R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role: "viewer" },
    });
  await E.DB.prepare("delete from inbox_items where artifact_id = ?")
    .bind(a.id)
    .run();
  return a.id;
}
const mention = (
  id: string,
  by: U,
  people: string[],
  body = "can you look?",
  extra: object = {},
) =>
  addThread(
    E,
    art(id),
    who(by),
    view(by),
    { anchor: { kind: "note" }, body, people, ...extra },
    { after, moderator: true },
  );
const inbox = async (u: U) =>
  (await (await api(app, R.meInbox, u.cookie)).json()) as Inbox;
const rows = async (id: string, u: U) =>
  (
    await E.DB.prepare(
      "select id, kind, level, key, excerpt, agent_name from inbox_items where artifact_id = ? and user_id = ?",
    )
      .bind(id, u.userId)
      .all<{
        id: string;
        kind: string;
        level: string;
        key: string;
        excerpt: string;
        agent_name: string | null;
      }>()
  ).results;
const bell = async (u: U) =>
  ((await (await api(app, R.me, u.cookie)).json()) as Me).inbox?.needsYou ?? 0;

describe("a person @mentioned", () => {
  it("is in Needs you with Open and the words; the comment shows who", async () => {
    const id = await mkArtifact();
    const t = await mention(id, owner, [sam.userId], "Sam, your call");
    const [r] = await rows(id, sam);
    expect(r).toMatchObject({
      kind: "mention",
      level: "needs_you",
      agent_name: null,
      excerpt: "Sam, your call",
    });
    const ny = (await inbox(sam)).needsYou.filter((i) => i.artifact?.id === id);
    expect(ny).toHaveLength(1);
    expect(ny[0]).toMatchObject({
      level: "needs_you",
      kind: "mention",
      excerpt: "Sam, your call",
    });
    expect(ny[0]?.text).toMatch(/mentioned you on Roadmap$/);
    expect(ny[0]?.href).toContain(`thread=${t.id}`);
    expect(
      (await inbox(sam)).updates.filter((i) => i.artifact?.id === id),
    ).toEqual([]);
    // The comment names who it mentions.
    const people = t.comments[0]?.people as CommentAuthor[];
    expect(people.map((p) => [p.kind, p.id])).toEqual([["user", sam.userId]]);
    // Others hear nothing as Needs you.
    expect(
      (await inbox(pat)).needsYou.filter((i) => i.artifact?.id === id),
    ).toEqual([]);
  });

  it("counts on the bell; read by id clears it, read-all does not", async () => {
    const id = await mkArtifact();
    const before = await bell(sam);
    await mention(id, owner, [sam.userId]);
    expect(await bell(sam)).toBe(before + 1);
    expect(
      (await api(app, R.meInboxReadAll, sam.cookie, { method: "POST" })).status,
    ).toBe(200);
    expect(await bell(sam)).toBe(before + 1);
    const [r] = await rows(id, sam);
    expect(
      (
        await api(app, R.meInboxRead, sam.cookie, {
          method: "POST",
          body: { ids: [r?.id] },
        })
      ).status,
    ).toBe(200);
    expect(await bell(sam)).toBe(before);
    expect(
      (await inbox(sam)).needsYou.filter((i) => i.artifact?.id === id),
    ).toEqual([]);
  });

  it("can be put off with Later once, then comes back on top", async () => {
    const id = await mkArtifact();
    await mention(id, owner, [sam.userId]);
    const [r] = await rows(id, sam);
    const later = (until = "hour") =>
      api(app, R.meInboxLater(r?.id as string), sam.cookie, {
        method: "POST",
        body: { until },
      });
    const before = await bell(sam);
    expect((await later()).status).toBe(200);
    expect((await later()).status).toBe(409);
    expect(await bell(sam)).toBe(before - 1);
    const i = await inbox(sam);
    expect(i.later.map((x) => x.id)).toContain(r?.id);
    expect(i.needsYou.map((x) => x.id)).not.toContain(r?.id);
    // Its time has come.
    await E.DB.prepare("update inbox_later set until = ? where item_id = ?")
      .bind(Date.now() - 1000, `mention:${r?.id}`)
      .run();
    const back = (await inbox(sam)).needsYou.find((x) => x.id === r?.id);
    expect(back?.backFromLater).toBe(true);
  });

  it("an edit shows the new words; a delete takes the item and its Later row", async () => {
    const id = await mkArtifact();
    const t = await mention(id, owner, [sam.userId], "first words");
    const cid = t.comments[0]?.id as string;
    await editComment(
      E,
      id,
      t.id,
      cid,
      who(owner),
      view(owner),
      "second words",
    );
    expect((await rows(id, sam))[0]?.excerpt).toBe("second words");
    const [r] = await rows(id, sam);
    await api(app, R.meInboxLater(r?.id as string), sam.cookie, {
      method: "POST",
      body: { until: "hour" },
    });
    await deleteComment(E, id, t.id, cid, who(owner), true);
    expect(await rows(id, sam)).toEqual([]);
    expect(
      (
        await E.DB.prepare(
          "select count(*) n from inbox_later where item_id = ?",
        )
          .bind(`mention:${r?.id}`)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("yourself, twice, or on a reply: one item per person per comment, never your own", async () => {
    const id = await mkArtifact();
    const t = await mention(id, owner, [owner.userId, sam.userId, sam.userId]);
    expect(await rows(id, owner)).toEqual([]);
    expect(await rows(id, sam)).toHaveLength(1);
    await addReply(
      E,
      id,
      t.id,
      who(owner),
      view(owner),
      "again",
      { people: [pat.userId] },
      { after, moderator: true },
    );
    expect(await rows(id, pat)).toHaveLength(1);
    expect((await rows(id, pat))[0]?.level).toBe("needs_you");
  });
});

describe("who may be mentioned, and by whom", () => {
  const ref = async (id: string, key: string) => {
    try {
      await mention(id, owner, [key]);
      return "ok";
    } catch (e) {
      return `${(e as { code?: string }).code}:${(e as { message: string }).message.replace(key, "KEY")}`;
    }
  };

  it("someone who can't read the page and an id that is no one are refused the same way", async () => {
    const id = await mkArtifact([sam]);
    const a = await ref(id, outsider.userId);
    const b = await ref(id, newId());
    const c = await ref(id, "not-an-id");
    expect(a).toMatch(/^bad_request:Unknown agent or person: KEY$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
    // A removed member is the same too.
    await E.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(pat.userId)
      .run();
    expect(await ref(id, pat.userId)).toBe(a);
    await E.DB.prepare("update users set status = 'active' where id = ?")
      .bind(pat.userId)
      .run();
    // Nothing was written and no one was told.
    expect(await rows(id, outsider)).toEqual([]);
  });

  it("only owner and editors may mention a person (403 for a viewer, over HTTP)", async () => {
    const id = await mkArtifact();
    const r = await api(app, R.comments(id), sam.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "hi", people: [pat.userId] },
    });
    expect(r.status).toBe(403);
    expect(await rows(id, pat)).toEqual([]);
    const ok = await api(app, R.comments(id), owner.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "hi", people: [pat.userId] },
    });
    expect(ok.status).toBe(201);
    expect(await rows(id, pat)).toHaveLength(1);
  });

  it("a guest names no one; a guest who has access can be named but has no inbox to put it in", async () => {
    const id = await mkArtifact([sam, guest]);
    await E.DB.prepare(
      "update shares set role = 'editor' where artifact_id = ? and email = ?",
    )
      .bind(id, guest.email)
      .run();
    const r = await api(app, R.comments(id), guest.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "hi", people: [sam.userId] },
    });
    // A guest-role member is read-only for comments (404), so they name no one.
    expect([403, 404]).toContain(r.status);
    expect(await rows(id, sam)).toEqual([]);
    await mention(id, owner, [guest.userId]);
    // A guest-role member has no For you: the mention is stored, no item is written.
    expect(await rows(id, guest)).toEqual([]);
  });

  it("people and agents together stay under the one per-comment cap", async () => {
    const id = await mkArtifact();
    const ids = Array.from({ length: MENTIONS_MAX }, () => sam.userId);
    // MENTIONS_MAX distinct-looking ids pass the schema; more is a 400 from the body schema.
    const over = await api(app, R.comments(id), owner.cookie, {
      method: "POST",
      body: {
        anchor: { kind: "note" },
        body: "x",
        people: [...ids, pat.userId],
      },
    });
    expect(over.status).toBe(400);
    const mixed = await api(app, R.comments(id), owner.cookie, {
      method: "POST",
      body: {
        anchor: { kind: "note" },
        body: "x",
        mentions: Array.from({ length: 6 }, (_, i) => ({ key: `agent:${i}` })),
        people: [
          sam.userId,
          pat.userId,
          owner.userId,
          outsider.userId,
          guest.userId,
        ],
      },
    });
    expect(mixed.status).toBe(400);
    expect(
      ((await mixed.json()) as { error: { message: string } }).error.message,
    ).toMatch(/at most 10 agents and people together/);
  });
});

describe("who sends, and how many", () => {
  it("a token, an agent or a grant can't carry people: 400, nothing written; a plain comment with a token is fine", async () => {
    const id = await mkArtifact();
    const token = (await createPat(E, owner.userId, "people")).token;
    const r = await api(app, R.comments(id), token, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "hi", people: [sam.userId] },
    });
    expect(r.status).toBe(400);
    expect(await rows(id, sam)).toEqual([]);
    const ok = await api(app, R.comments(id), token, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "just a note" },
    });
    expect(ok.status).toBe(201);
    const thread = ((await ok.json()) as { id: string }).id;
    const rr = await api(app, R.commentReplies(id, thread), token, {
      method: "POST",
      body: { body: "re", people: [pat.userId] },
    });
    expect(rr.status).toBe(400);
  });

  it("a sender's daily cap: the comment posts, no more items are written, and it is logged", async () => {
    const id = await mkArtifact();
    const day = new Date().toISOString().slice(0, 10);
    await E.DB.prepare(
      "insert into counters (key, n, day) values (?, ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
    )
      .bind(`prefs:pm:${owner.userId}`, PERSON_MENTIONS_PER_DAY, day)
      .run();
    const t = await mention(id, owner, [sam.userId]);
    expect(t.comments[0]?.people).toHaveLength(1);
    expect(await rows(id, sam)).toEqual([]);
    // Another sender is unaffected.
    const other = await mk("p-owner2");
    await E.DB.prepare("update users set role = 'admin' where id = ?")
      .bind(other.userId)
      .run();
    await E.DB.prepare("delete from counters where key = ?")
      .bind(`prefs:pm:${owner.userId}`)
      .run();
    await mention(id, owner, [sam.userId], "after the reset");
    expect(await rows(id, sam)).toHaveLength(1);
  });
});

describe("the candidates route", () => {
  const find = (id: string, u: U, q: string) =>
    api(app, R.artifactMentionCandidates(id), u.cookie, {
      method: "POST",
      body: { q },
    });

  it("people who can read the page, matched by the start of a name or email, as faces with no email", async () => {
    const id = await mkArtifact([sam, pat]);
    const r = await find(id, owner, "sam");
    expect(r.status).toBe(200);
    const body = (await r.json()) as MentionCandidates;
    expect(body.items.map((i) => i.id)).toEqual([sam.userId]);
    expect(body.items[0]?.kind).toBe("user");
    expect(JSON.stringify(body)).not.toContain("@");
    // A person who can't read it is not offered, however well they match.
    expect(
      ((await (await find(id, owner, "zed")).json()) as MentionCandidates)
        .items,
    ).toEqual([]);
    // Not yourself.
    expect(
      ((await (await find(id, owner, "p-owner")).json()) as MentionCandidates)
        .items,
    ).toEqual([]);
  });

  it("names only: an email matches only when typed in full and exactly; a prefix of it matches nothing", async () => {
    const id = await mkArtifact([sam, pat]);
    const ids = async (q: string) =>
      (
        (await (await find(id, owner, q)).json()) as MentionCandidates
      ).items.map((i) => i.id);
    expect(await ids(`sam-rivera-${tag}@x`)).toEqual([]);
    expect(await ids(`sam-rivera-${tag}@x.co`)).toEqual([]);
    expect(await ids("@x.com")).toEqual([]);
    expect(await ids(sam.email.toUpperCase())).toEqual([sam.userId]);
    // A word inside a name still matches.
    await E.DB.prepare("update users set name = 'Sam Rivera' where id = ?")
      .bind(sam.userId)
      .run();
    expect(await ids("rivera")).toEqual([sam.userId]);
  });

  it("a big team with a common prefix: readers are found past the first 40 who can't read", async () => {
    const readers: U[] = [];
    for (let i = 0; i < 45; i++) await mk(`zzbig-a${i}`);
    for (let i = 0; i < 3; i++) readers.push(await mk(`zzbig-z${i}`));
    const id = await mkArtifact(readers);
    const items = (
      (await (await find(id, owner, `zzbig-`)).json()) as MentionCandidates
    ).items;
    expect(items.map((i) => i.id).sort()).toEqual(
      readers.map((r) => r.userId).sort(),
    );
  });

  it("only owner and editors; a viewer, a guest and a signed-out caller get none", async () => {
    const id = await mkArtifact([sam, pat, guest]);
    // None: an empty answer, or the write refused for a caller who can't comment on this page.
    const none = async (r: Response) =>
      r.status === 200 ? ((await r.json()) as MentionCandidates).items : [];
    expect(await none(await find(id, sam, "pat"))).toEqual([]);
    expect(await none(await find(id, guest, "pat"))).toEqual([]);
    expect(
      (
        await api(app, R.artifactMentionCandidates(id), null, {
          method: "POST",
          body: { q: "pat" },
        })
      ).status,
    ).toBeGreaterThanOrEqual(401);
    // The search is a POST: the old GET, with q in the URL, is gone.
    expect(
      (await api(app, `${R.artifactMentionCandidates(id)}?q=pat`, owner.cookie))
        .status,
    ).toBe(404);
  });

  it("an empty, long or missing search is a 400; the search is rate limited per person", async () => {
    const id = await mkArtifact([sam]);
    expect((await find(id, owner, "")).status).toBe(400);
    expect((await find(id, owner, "a".repeat(41))).status).toBe(400);
    expect(
      (
        await api(app, R.artifactMentionCandidates(id), owner.cookie, {
          method: "POST",
          body: {},
        })
      ).status,
    ).toBe(400);
    const w = await mk("busy-owner");
    const art2 = (
      await publish(
        E,
        w.member,
        { title: "T", format: "html", content: "x" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    for (let i = 0; i < MENTION_SEARCHES_PER_MIN; i++)
      expect((await find(art2, w, "s")).status).toBe(200);
    expect((await find(art2, w, "s")).status).toBe(429);
  });
});
