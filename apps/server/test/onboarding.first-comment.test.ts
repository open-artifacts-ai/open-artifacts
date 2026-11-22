// #2953: "Comment on a page". The first comment a person typed in the web app
// (a thread or a reply) is the step; a token, MCP, agent or anonymous comment
// never is. Earned progress outlives access to the page, and nothing of the
// page leaks once access is gone. Historical comments are found by a bounded
// scan of the pages; the first_comment event is sent once, with its original time.
import { env } from "cloudflare:workers";
import {
  type Comment,
  newId,
  OnboardingSchema,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { runtimeStub } from "../src/runtime/do.js";
import {
  BACKFILL_FIRST_COMMENT_KEY,
  BACKFILL_KEY,
  backfillFirstComment,
  memberDistinctId,
  resetAnalyticsMemo,
} from "../src/services/analytics.js";
import { publish } from "../src/services/artifacts.js";
import { addThread } from "../src/services/comments.js";
import {
  type PageReader,
  readPageFirsts,
  scanFirstComments,
} from "../src/services/first-comment-scan.js";
import {
  getOnboarding,
  memberSetups,
  noteCommented,
  teamStepKey,
} from "../src/services/onboarding.js";
import {
  commentedKey,
  FIRST_COMMENT_SCAN_CURSOR_KEY,
  FIRST_COMMENT_SCAN_DONE_KEY,
  FIRST_COMMENT_SCAN_STARTED_KEY,
  noteFirstComment,
  parseFirstComment,
} from "../src/services/onboarding-firsts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const NOTE = { kind: "note" };
const TITLE = `Quarterly secret plan ${tag}`;
const WORDS = `confidential words ${tag}`;

type U = { cookie: string; userId: string; email: string };
const mk = async (
  prefix: string,
  role: "owner" | "admin" | "member" | "guest",
) => {
  const email = `${prefix}-${tag}@x.com`;
  return { ...(await login(email, role)), email } as U;
};

let owner: U;
let member: U;
let admin: U;
let guest: U;

const row = async (key: string) =>
  (
    await env.DB.prepare("select value from settings where key = ?1")
      .bind(key)
      .first<{ value: string }>()
  )?.value ?? null;
const setting = (key: string, value: string) =>
  env.DB.prepare(
    "insert into settings (key, value) values (?1, ?2) on conflict (key) do update set value = excluded.value",
  )
    .bind(key, value)
    .run();
const reset = () =>
  env.DB.prepare(
    `delete from settings where key like 'onboarding:%' or key like 'onboarding-scan:%' or key like 'analytics:%'`,
  ).run();

const roleOf = (u: U) =>
  u === owner
    ? "owner"
    : u === admin
      ? "admin"
      : u === guest
        ? "guest"
        : "member";
const state = async (u: U) =>
  OnboardingSchema.parse(
    await getOnboarding(env as Env, { id: u.userId, role: roleOf(u) }),
  );

/** A page of the owner's: `team` (every member can comment) or private. */
async function page(visibility: "team" | "private", title = TITLE) {
  const o = await getUser(env as Env, owner.userId);
  if (!o) throw new Error("no owner");
  return (
    await publish(
      env as Env,
      o,
      { title, format: "html", content: "<p>x</p>", visibility } as never,
      null,
      undefined,
      "create",
    )
  ).id;
}
const post = async (id: string, by: string | null, body = WORDS) => {
  const r = await api(app, R.comments(id), by, {
    method: "POST",
    body: { anchor: NOTE, body },
  });
  expect(r.status).toBe(201);
  return (await r.json()) as Thread;
};
const reply = async (id: string, t: Thread, by: string | null) => {
  const r = await api(app, R.commentReplies(id, t.id), by, {
    method: "POST",
    body: { body: WORDS },
  });
  expect(r.status).toBe(201);
  return (await r.json()) as Comment;
};
const share = (id: string, to: U) =>
  api(app, R.shares(id), owner.cookie, {
    method: "PUT",
    body: { email: to.email, role: "viewer" },
  });

beforeEach(async () => {
  // New people every test: comments stay in the pages' stores, so an older
  // test's comments must not be found again for the same person by the scan.
  const n = newId().slice(0, 4).toLowerCase();
  owner = await mk(`fc-owner-${n}`, "owner");
  member = await mk(`fc-member-${n}`, "member");
  admin = await mk(`fc-admin-${n}`, "admin");
  guest = await mk(`fc-guest-${n}`, "guest");
  await reset();
  resetAnalyticsMemo();
});

describe("the step, live", () => {
  it("is null until a typed comment; a thread counts, with the page's id and title", async () => {
    const id = await page("team");
    expect((await state(member)).firstComment).toBeNull();
    await post(id, member.cookie);
    expect((await state(member)).firstComment).toEqual({
      artifactId: id,
      title: TITLE,
    });
    // Others are unaffected.
    expect((await state(admin)).firstComment).toBeNull();
  });

  it("a typed reply counts, on a page the person does not own", async () => {
    const id = await page("team");
    const t = await post(id, owner.cookie);
    expect((await state(member)).firstComment).toBeNull();
    await reply(id, t, member.cookie);
    expect((await state(member)).firstComment).toEqual({
      artifactId: id,
      title: TITLE,
    });
  });

  it("every account role that can comment gets it: owner, admin, member", async () => {
    const id = await page("team");
    for (const u of [owner, admin, member]) {
      await post(id, u.cookie);
      expect((await state(u)).firstComment?.artifactId).toBe(id);
    }
  });

  it("the first one is kept: a later comment on another page changes nothing", async () => {
    const a = await page("team", `First ${tag}`);
    const b = await page("team", `Second ${tag}`);
    await post(a, member.cookie);
    await post(b, member.cookie);
    expect((await state(member)).firstComment?.artifactId).toBe(a);
  });

  it("a token comment or reply (PAT) never counts", async () => {
    const id = await page("team");
    const { token } = await createPat(env as Env, member.userId, "fc token");
    const t = await post(id, token);
    await reply(id, t, token);
    // At most the legacy timestamp: never typed metadata.
    expect(
      parseFirstComment(await row(commentedKey(member.userId))),
    ).toBeNull();
    expect((await state(member)).firstComment).toBeNull();
  });

  it("an agent's comment (MCP identity) and an untyped one never count", async () => {
    const id = await page("team");
    const art = { id, format: "html", currentVersion: 1 } as never;
    const viewer = {
      userId: member.userId,
      short: null,
      moderator: true,
    } as never;
    const who = (extra: object) =>
      ({ kind: "user", id: member.userId, ...extra }) as never;
    await addThread(env as Env, art, who({ typed: false }), viewer, {
      anchor: NOTE,
      body: "untyped",
    });
    await addThread(
      env as Env,
      art,
      who({
        agent: { name: "Claude", version: null, via: null },
        typed: true,
      }),
      viewer,
      { anchor: NOTE, body: "from an agent" },
    );
    expect(
      parseFirstComment(await row(commentedKey(member.userId))),
    ).toBeNull();
    expect(await runtimeStub(env as Env, id).commentsTypedFirsts()).toEqual([]);
  });

  it("an anonymous comment on a public page counts for nobody", async () => {
    const o = await getUser(env as Env, owner.userId);
    if (!o) throw new Error("no owner");
    // The same fixture as comments.routes.test.ts: comments open to everyone,
    // and the caller's IP (the guest limiter keys on it).
    const pub = (
      await publish(
        env as Env,
        o,
        {
          title: `Public ${tag}`,
          format: "html",
          content: "<p>x</p>",
          visibility: "public",
          comments: "everyone",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const r = await api(app, R.comments(pub), null, {
      method: "POST",
      body: { anchor: NOTE, body: "hello", guestName: "Visitor" },
      headers: {
        "cf-connecting-ip": `203.0.113.${(Math.random() * 200 + 10) | 0}`,
      },
    });
    // Genuinely accepted: a guest comment, stored as one.
    expect(r.status).toBe(201);
    const t = (await r.json()) as Thread;
    expect(t.comments[0]?.author).toMatchObject({ kind: "guest" });
    expect(await runtimeStub(env as Env, pub).commentsTypedFirsts()).toEqual(
      [],
    );
    const keys = await env.DB.prepare(
      "select key from settings where key like 'onboarding:commented:%'",
    ).all();
    expect(keys.results).toEqual([]);
  });

  it("a typed comment from a guest-role account earns no progress, and no row", async () => {
    const id = await page("team");
    const art = { id, format: "html", currentVersion: 1 } as never;
    await addThread(
      env as Env,
      art,
      { kind: "user", id: guest.userId, typed: true } as never,
      { userId: guest.userId, short: null, moderator: true } as never,
      { anchor: NOTE, body: WORDS },
    );
    // Only the older flag (a timestamp): the legacy behaviour is kept.
    expect(parseFirstComment(await row(commentedKey(guest.userId)))).toBeNull();
    expect((await state(guest)).firstComment).toBeNull();
    // Promoted later, it still has nothing to count.
    expect(
      (
        await memberSetups(
          env as Env,
          [{ id: guest.userId, role: "member", lastSeenAt: 1 }] as never,
        )
      ).get(guest.userId)?.done,
    ).toBe(0);
  });
});

describe("the one commented row (legacy and typed)", () => {
  it("a legacy timestamp alone is commented=true and no typed comment, in both views", async () => {
    await setting(commentedKey(member.userId), String(Date.now()));
    const s = await state(member);
    expect(s.commented).toBe(true);
    expect(s.firstComment).toBeNull();
    const done = (
      await memberSetups(
        env as Env,
        [{ id: member.userId, role: "member", lastSeenAt: 1 }] as never,
      )
    ).get(member.userId)?.done;
    expect(done).toBe(0);
  });

  it("a typed comment upgrades the legacy value in place, and the team step stays", async () => {
    const id = await page("team");
    const stamp = String(Date.now() - 86_400_000);
    await setting(commentedKey(member.userId), stamp);
    await post(id, member.cookie);
    const fc = parseFirstComment(await row(commentedKey(member.userId)));
    expect(fc?.artifactId).toBe(id);
    expect((await state(member)).commented).toBe(true);
    expect(await row(teamStepKey(member.userId))).not.toBeNull();
  });

  it("an older server's write after the typed one changes nothing (rolling update)", async () => {
    const id = await page("team");
    await post(id, member.cookie);
    const before = await row(commentedKey(member.userId));
    // What the older code does: insert the timestamp, do nothing on conflict.
    await env.DB.prepare(
      "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
    )
      .bind(commentedKey(member.userId), String(Date.now()))
      .run();
    await noteCommented(env as Env, member.userId, id);
    expect(await row(commentedKey(member.userId))).toBe(before);
    expect((await state(member)).firstComment?.artifactId).toBe(id);
  });

  it("an unreadable value reads as commented with no typed comment, and a typed one still replaces it", async () => {
    await setting(commentedKey(member.userId), "not json {");
    expect((await state(member)).commented).toBe(true);
    expect((await state(member)).firstComment).toBeNull();
    await noteFirstComment(env as Env, member.userId, "p", 10);
    expect(parseFirstComment(await row(commentedKey(member.userId)))).toEqual({
      artifactId: "p",
      at: 10,
    });
  });
});

describe("access to the first page", () => {
  it("a removed share keeps the step done and names no page; a re-share names it again", async () => {
    const id = await page("private");
    expect((await share(id, member)).status).toBe(200);
    await post(id, member.cookie);
    expect((await state(member)).firstComment?.title).toBe(TITLE);
    const gone = await api(app, R.share(id, member.email), owner.cookie, {
      method: "DELETE",
    });
    expect(gone.status).toBeLessThan(300);
    const s = await state(member);
    expect(s.firstComment).not.toBeNull();
    const raw = JSON.stringify(s);
    expect(raw).not.toContain(TITLE);
    expect(raw).not.toContain(id);
    expect(s.firstComment?.artifactId).toBe("");
    await share(id, member);
    expect((await state(member)).firstComment?.artifactId).toBe(id);
  });

  it("a deleted page keeps the step done and names nothing", async () => {
    const id = await page("team");
    await post(id, member.cookie);
    const del = await api(app, R.artifact(id), owner.cookie, {
      method: "DELETE",
    });
    expect(del.status).toBeLessThan(300);
    const s = await state(member);
    expect(s.firstComment).not.toBeNull();
    expect(JSON.stringify(s)).not.toContain(TITLE);
    expect(JSON.stringify(s)).not.toContain(id);
  });

  it("a row naming a purged page still reads as done, nameless", async () => {
    await setting(
      commentedKey(member.userId),
      JSON.stringify({ artifactId: "purged-page", at: 1 }),
    );
    const s = await state(member);
    expect(s.firstComment).toEqual({ artifactId: "", title: "a page" });
  });
});

describe("member progress (the Members column)", () => {
  it("counts the comment step for any role, from the stored first, and shows no page", async () => {
    const id = await page("team");
    const rows = [owner, admin, member].map((u) => ({
      id: u.userId,
      role: roleOf(u),
      lastSeenAt: Date.now(),
    }));
    const before = await memberSetups(env as Env, rows as never);
    await post(id, member.cookie);
    const after = await memberSetups(env as Env, rows as never);
    const b = before.get(member.userId);
    const a = after.get(member.userId);
    expect(a?.done).toBe((b?.done ?? 0) + 1);
    // Everyone's total includes the step (6, or 4 without the bus).
    expect([6, 4]).toContain(a?.total);
    expect(after.get(admin.userId)?.done).toBe(before.get(admin.userId)?.done);
    expect(JSON.stringify([...after])).not.toContain(TITLE);
    // A guest has no setup.
    const g = await memberSetups(
      env as Env,
      [{ id: guest.userId, role: "guest", lastSeenAt: 1 }] as never,
    );
    expect(g.size).toBe(0);
  });

  it("keeps dismissed and completed as they were", async () => {
    const id = await page("team");
    await setting(`onboarding:dismissed:${member.userId}`, "1");
    await setting(`onboarding:completed:${member.userId}`, "1");
    await post(id, member.cookie);
    const s = await state(member);
    expect(s.dismissed).toBe(true);
    expect(s.completed).toBe(true);
    expect(s.firstComment?.artifactId).toBe(id);
  });
});

describe("concurrency", () => {
  it("two comments at once on different pages leave exactly one row: the earliest", async () => {
    const [a, b] = await Promise.all([page("team"), page("team")]);
    await Promise.all([post(a, member.cookie), post(b, member.cookie)]);
    const rows = await env.DB.prepare(
      "select value from settings where key = ?1",
    )
      .bind(commentedKey(member.userId))
      .all<{ value: string }>();
    expect(rows.results).toHaveLength(1);
    const fc = parseFirstComment(rows.results[0]?.value);
    expect([a, b]).toContain(fc?.artifactId);
  });

  it("the upsert keeps the earliest time whatever the order, and a repeat changes nothing", async () => {
    const u = member.userId;
    await Promise.all([
      noteFirstComment(env as Env, u, "late", 3000),
      noteFirstComment(env as Env, u, "early", 1000),
      noteFirstComment(env as Env, u, "mid", 2000),
    ]);
    expect(parseFirstComment(await row(commentedKey(u)))).toEqual({
      artifactId: "early",
      at: 1000,
    });
    await noteFirstComment(env as Env, u, "again", 5000);
    expect(parseFirstComment(await row(commentedKey(u)))?.artifactId).toBe(
      "early",
    );
  });
});

describe("upgrade: the historical scan", () => {
  /** A comment as it was stored before this shipped: no typed row, only the old flag. */
  const forget = () =>
    env.DB.prepare(
      "delete from settings where key like 'onboarding:commented:%'",
    ).run();
  const scanAll = async (batch?: number, read?: PageReader) => {
    for (let i = 0; i < 500; i++) {
      await scanFirstComments(env as Env, batch, read);
      if (await row(FIRST_COMMENT_SCAN_DONE_KEY)) return i + 1;
    }
    throw new Error("scan never finished");
  };
  const artifactIds = async () =>
    (
      await env.DB.prepare("select id from artifacts order by id").all<{
        id: string;
      }>()
    ).results.map((r) => r.id);
  /** Every page empty, except what `by` says. */
  const readerOf =
    (by: Record<string, [string, number][]>): PageReader =>
    async (_env, id) =>
      new Map(by[id] ?? []);

  it("finds a typed comment made before, with its original time, and ignores token and untyped ones", async () => {
    const typedPage = await page("team");
    const tokenPage = await page("team");
    const t = await post(typedPage, member.cookie);
    const { token } = await createPat(env as Env, admin.userId, "fc scan");
    await post(tokenPage, token);
    const stored = parseFirstComment(await row(commentedKey(member.userId)));
    expect(stored).not.toBeNull();
    // The RPC answers only the person's ref and ISO time: nothing else leaves the page.
    const rpc = await runtimeStub(env as Env, typedPage).commentsTypedFirsts();
    expect(rpc).toHaveLength(1);
    expect(rpc[0]?.ref).toBe(member.userId);
    expect(Object.keys(rpc[0] ?? {}).sort()).toEqual(["at", "ref"]);
    expect(
      await runtimeStub(env as Env, tokenPage).commentsTypedFirsts(),
    ).toEqual([]);
    // As if it were written by the old code: the old flag (a timestamp) only.
    await forget();
    await setting(commentedKey(member.userId), "1");
    await setting(commentedKey(admin.userId), "1");
    expect((await state(member)).firstComment).toBeNull();
    await scanAll();
    const found = parseFirstComment(await row(commentedKey(member.userId)));
    expect(found?.artifactId).toBe(typedPage);
    expect(found?.at).toBe(stored?.at);
    expect(t.comments[0]?.createdAt).toBeTruthy();
    expect(Date.parse(t.comments[0]?.createdAt as string)).toBe(found?.at);
    // The token's comment and the bare old flag prove nothing: it stays a legacy value.
    expect(parseFirstComment(await row(commentedKey(admin.userId)))).toBeNull();
    expect(await row(commentedKey(admin.userId))).toBe("1");
    expect((await state(admin)).firstComment).toBeNull();
    expect((await state(admin)).commented).toBe(true);
    expect((await state(member)).firstComment?.title).toBe(TITLE);
  });

  it("a guest-role author found on a page is not recorded", async () => {
    const id = await page("team");
    await scanAll(1000, readerOf({ [id]: [[guest.userId, 5]] }));
    expect(await row(commentedKey(guest.userId))).toBeNull();
  });

  it("leaves a member's legacy flag alone when the only typed comment is from an agent", async () => {
    const id = await page("team");
    const stub = runtimeStub(env as Env, id);
    // Seed the historic author shape directly through the page's storage API.
    await stub.commentsAdd({
      actor: {
        kind: "user",
        ref: member.userId,
        typed: true,
        agent: { name: "Claude", via: null },
      },
      rate: `u:${member.userId}`,
      version: 1,
      anchor: { kind: "note" },
      body: WORDS,
    });
    expect(await stub.commentsTypedFirsts()).toEqual([]);
    await forget();
    await setting(commentedKey(member.userId), "1");
    await scanAll();
    expect(await row(commentedKey(member.userId))).toBe("1");
    expect(parseFirstComment(await row(commentedKey(member.userId)))).toBeNull();
    const s = await state(member);
    expect(s.firstComment).toBeNull();
    expect(s.commented).toBe(true);
  });

  it("asks at most `batch` pages a run", async () => {
    for (let i = 0; i < 3; i++) await page("team", `Cap ${i} ${tag}`);
    let asked = 0;
    await scanFirstComments(env as Env, 2, async () => {
      asked++;
      return new Map();
    });
    expect(asked).toBe(2);
  });

  it("a transient page read error stays retryable: the cursor stops before it, nothing is marked done", async () => {
    for (let i = 0; i < 4; i++) await page("team", `Retry ${i} ${tag}`);
    const ids = await artifactIds();
    const bad = ids[ids.length - 2] as string;
    const before = ids[ids.length - 3] as string;
    const last = ids[ids.length - 1] as string;
    let healthy = false;
    const asked: string[] = [];
    const read: PageReader = async (e, id) => {
      asked.push(id);
      if (id === bad && !healthy) throw new Error("do_overloaded");
      // The page after the failure is included when the read succeeds.
      return id === last
        ? new Map([[member.userId, 7000]])
        : readPageFirsts(e, id);
    };
    await scanFirstComments(env as Env, ids.length + 5, read);
    expect(await row(FIRST_COMMENT_SCAN_DONE_KEY)).toBeNull();
    expect(await row(FIRST_COMMENT_SCAN_CURSOR_KEY)).toBe(before);
    // Run again with the store healthy: the failed page is asked again, then done.
    healthy = true;
    asked.length = 0;
    await scanFirstComments(env as Env, ids.length + 5, read);
    expect(asked[0]).toBe(bad);
    expect(await row(FIRST_COMMENT_SCAN_DONE_KEY)).not.toBeNull();
    expect(await row(FIRST_COMMENT_SCAN_CURSOR_KEY)).toBe(last);
  });

  it("a failed page never hides the person's earlier comment found on a good page", async () => {
    const a = await page("team");
    const b = await page("team");
    const [first, second] = [a, b].sort() as [string, string];
    // The later comment is what is recorded while the earlier page cannot be read.
    await noteFirstComment(env as Env, member.userId, second, 9000);
    const failing: PageReader = async (_e, id) => {
      if (id === first) throw new Error("boom");
      return new Map();
    };
    await scanFirstComments(env as Env, 1000, failing);
    expect(await row(FIRST_COMMENT_SCAN_DONE_KEY)).toBeNull();
    expect(
      parseFirstComment(await row(commentedKey(member.userId))),
    ).toMatchObject({
      artifactId: second,
      at: 9000,
    });
    // The retry reads the page: the earlier comment wins.
    await scanAll(1000, readerOf({ [first]: [[member.userId, 3000]] }));
    expect(parseFirstComment(await row(commentedKey(member.userId)))).toEqual({
      artifactId: first,
      at: 3000,
    });
  });

  it("keeps the correct earliest time beside live comments and a second backfill, in any order", async () => {
    const a = await page("team");
    const b = await page("team");
    const reader = readerOf({
      [a]: [[member.userId, 1000]],
      [b]: [[member.userId, 2000]],
    });
    // A live comment (now) lands while two scans run: the older comment wins.
    await Promise.all([
      post(b, member.cookie),
      scanFirstComments(env as Env, 1000, reader),
      scanFirstComments(env as Env, 1000, reader),
      noteFirstComment(env as Env, member.userId, b, 2000),
    ]);
    expect(parseFirstComment(await row(commentedKey(member.userId)))).toEqual({
      artifactId: a,
      at: 1000,
    });
    // A live comment that is older than what a later scan reports is kept.
    await env.DB.prepare(
      "delete from settings where key like 'onboarding-scan:%'",
    ).run();
    await noteFirstComment(env as Env, admin.userId, b, 500);
    await scanAll(1000, readerOf({ [a]: [[admin.userId, 1000]] }));
    expect(parseFirstComment(await row(commentedKey(admin.userId)))).toEqual({
      artifactId: b,
      at: 500,
    });
  });

  it("is bounded per run, moves a cursor forward, and writes its marker only at the end", async () => {
    for (let i = 0; i < 3; i++) await page("team", `Many ${i} ${tag}`);
    const total = (
      await env.DB.prepare("select count(*) as n from artifacts").first<{
        n: number;
      }>()
    )?.n as number;
    await scanFirstComments(env as Env, 1);
    expect(await row(FIRST_COMMENT_SCAN_DONE_KEY)).toBeNull();
    const c1 = await row(FIRST_COMMENT_SCAN_CURSOR_KEY);
    expect(c1).toBeTruthy();
    await scanFirstComments(env as Env, 1);
    expect(
      ((await row(FIRST_COMMENT_SCAN_CURSOR_KEY)) ?? "") > (c1 ?? ""),
    ).toBe(true);
    const runs = await scanAll(1);
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(runs).toBeLessThanOrEqual(total + 1);
    // Done: further runs read nothing and change nothing.
    const done = await row(FIRST_COMMENT_SCAN_DONE_KEY);
    await scanFirstComments(env as Env, 1);
    expect(await row(FIRST_COMMENT_SCAN_DONE_KEY)).toBe(done);
  });

  it("a scan running twice, or beside a live comment, converges on the earliest", async () => {
    const id = await page("team");
    await post(id, member.cookie);
    const live = parseFirstComment(await row(commentedKey(member.userId)));
    await Promise.all([
      scanFirstComments(env as Env, 1000),
      scanFirstComments(env as Env, 1000),
    ]);
    await scanFirstComments(env as Env, 1000);
    const after = parseFirstComment(await row(commentedKey(member.userId)));
    expect(after).toEqual(live);
  });
});

describe("the first_comment event", () => {
  const E = {
    ...env,
    HOSTED: "1",
    POSTHOG_KEY: "phc_test",
    INSTALL_ID: "inst123",
  } as Env;
  const fetchSpy = vi.fn();
  const bodies = () =>
    fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body as string)) as {
      event: string;
      distinct_id: string;
      timestamp?: string;
    }[];
  let held: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void held.push(p) };
  const flush = async () => {
    await Promise.all(held);
    held = [];
  };
  const typed = async (u: U, id: string) => {
    const art = { id, format: "html", currentVersion: 1 } as never;
    await addThread(
      E,
      art,
      { kind: "user", id: u.userId, typed: true } as never,
      { userId: u.userId, short: null, moderator: true } as never,
      { anchor: NOTE, body: WORDS },
      { after: { version: 1, ctx } as never },
    );
    await flush();
  };
  const sentFor = async (u: U) => {
    const d = await memberDistinctId(E, u.userId);
    return bodies().filter(
      (b) => b.event === "first_comment" && b.distinct_id === d,
    );
  };

  async function finishScan() {
    for (let i = 0; i < 500; i++) {
      await scanFirstComments(E);
      if (await row(FIRST_COMMENT_SCAN_DONE_KEY)) return;
    }
    throw new Error("The first-comment scan did not finish");
  }
  // A single tick need not reach this member; prior fixtures also contain comments.
  async function finishBackfill() {
    for (let i = 0; i < 500; i++) {
      await backfillFirstComment(E);
      if (await row(BACKFILL_FIRST_COMMENT_KEY)) return;
    }
    throw new Error("The first-comment event backfill did not finish");
  }

  beforeEach(() => {
    held = [];
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("waits for the scan, then is sent once with the original time and no page, title or text", async () => {
    const id = await page("team");
    await typed(member, id);
    // The older pages are not read yet: a live send would carry a wrong first.
    expect(await sentFor(member)).toHaveLength(0);
    await finishScan();
    const at = parseFirstComment(await row(commentedKey(member.userId)))?.at;
    await finishBackfill();
    const sent = await sentFor(member);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.timestamp).toBe(new Date(at as number).toISOString());
    const raw = JSON.stringify(bodies());
    for (const secret of [id, TITLE, WORDS, member.userId, member.email])
      expect(raw).not.toContain(secret);
    // Never again.
    await finishBackfill();
    expect(await sentFor(member)).toHaveLength(1);
    expect(await row(BACKFILL_FIRST_COMMENT_KEY)).not.toBeNull();
  });

  it("an install whose earlier backfill was complete still gets it", async () => {
    const id = await page("team");
    await typed(member, id);
    await setting(BACKFILL_KEY, String(Date.now()));
    await finishScan();
    await finishBackfill();
    expect(await sentFor(member)).toHaveLength(1);
  });

  it("after the scan, a live first is sent once, and the backfill does not repeat it", async () => {
    await finishScan();
    const a = await page("team");
    const b = await page("team");
    await typed(admin, a);
    await typed(admin, b);
    expect(await sentFor(admin)).toHaveLength(1);
    await finishBackfill();
    expect(await sentFor(admin)).toHaveLength(1);
  });

  it("a guest, a token comment and a self-hosted install send nothing", async () => {
    const id = await page("team");
    await setting(
      commentedKey(guest.userId),
      JSON.stringify({ artifactId: id, at: 5 }),
    );
    await finishScan();
    const { token } = await createPat(env as Env, member.userId, "fc ev");
    await post(id, token);
    await finishBackfill();
    expect(await sentFor(guest)).toHaveLength(0);
    expect(await sentFor(member)).toHaveLength(0);
    fetchSpy.mockClear();
    await backfillFirstComment({ ...E, HOSTED: undefined } as Env);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("legacy timestamps never take a place in a backfill batch: the typed one is sent in a batch of one", async () => {
    await setting(FIRST_COMMENT_SCAN_DONE_KEY, "1");
    // Two active members with only the old flag, and one typed.
    await setting(commentedKey(owner.userId), String(Date.now()));
    await setting(commentedKey(admin.userId), String(Date.now()));
    await setting(commentedKey("unreadable-person"), "not json {");
    await setting(
      commentedKey(member.userId),
      JSON.stringify({ artifactId: "p", at: 4242 }),
    );
    await backfillFirstComment(E, 1);
    const sent = await sentFor(member);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.timestamp).toBe(new Date(4242).toISOString());
    expect(await sentFor(owner)).toHaveLength(0);
    expect(await sentFor(admin)).toHaveLength(0);
    expect(await row(BACKFILL_FIRST_COMMENT_KEY)).not.toBeNull();
  });

  it("a person created after the scan began is sent at once; one from before waits for the scan", async () => {
    // Not finished: only started, before the test's people existed.
    await setting(FIRST_COMMENT_SCAN_STARTED_KEY, String(Date.now() - 60_000));
    const id = await page("team");
    await typed(member, id);
    expect(await sentFor(member)).toHaveLength(1);
    expect(await row(FIRST_COMMENT_SCAN_DONE_KEY)).toBeNull();
    // Started after they were created: they may have older comments, so it waits.
    await setting(FIRST_COMMENT_SCAN_STARTED_KEY, String(Date.now() + 60_000));
    await typed(admin, id);
    expect(await sentFor(admin)).toHaveLength(0);
  });
});
