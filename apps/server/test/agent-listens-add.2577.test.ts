import { env } from "cloudflare:workers";
import {
  type AskHistory,
  HELD_LAPSE_MS,
  HELD_QUIET_MS,
  type ListenAddResult,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { askHistory, listListens } from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import { putShare } from "../src/services/shares.js";
import { getUser, personName } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2577 / #2868: adding a teammate to the "listens to" list directly, "Who
// asked what", and the app's name for a person on those screens.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const DAY = 86_400_000;

type U = { userId: string; member: Member; email: string; cookie: string };
async function mk(prefix: string, role: "member" | "guest" = "member") {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = (await getUser(E, l.userId)) as Member;
  return { userId: l.userId, member: m, email, cookie: l.cookie } as U;
}
let owner: U;
let mate: U;
let mate2: U;
let guest: U;
let stranger: U;
beforeAll(async () => {
  owner = await mk("la-owner");
  mate = await mk("la-mate");
  mate2 = await mk("la-mate2");
  guest = await mk("la-guest", "guest");
  stranger = await mk("la-stranger");
});

const page = async (shareWith: U[] = [mate]) => {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of shareWith)
    await putShare(E, owner.member, a.id, { email: u.email, role: "editor" });
  return a.id;
};
const add = (body: Record<string, unknown>, u: U = owner) =>
  api(app, R.agentListens, u.cookie, { method: "POST", body });
const base = { scope: "all", until: 30, via: "settings" } as const;
const rows = (id: string) =>
  E.DB.prepare(
    "select * from agent_listens where owner_id = ?1 and member_id = ?2 and removed_at is null",
  )
    .bind(owner.userId, id)
    .all<{
      id: string;
      scope: string;
      artifact_id: string | null;
      space_id: string | null;
      until: number;
      created_via: string;
    }>()
    .then((r) => r.results);
const audits = async (action: string) =>
  (
    await E.DB.prepare(
      "select count(*) as n from audit_events where action = ?1 and actor_id = ?2",
    )
      .bind(action, owner.userId)
      .first<{ n: number }>()
  )?.n as number;

describe("the app's name for a person on the request screens (#2868)", () => {
  it("a real name shows; a nameless member is Someone, never the email or its local part", () => {
    const email = "ada.l@x.com";
    expect(personName({ email, name: null, displayName: "Ada L" })).toBe(
      "Ada L",
    );
    expect(personName({ email, name: "Ada Lovelace", displayName: null })).toBe(
      "Ada Lovelace",
    );
    expect(personName({ email, name: "ada.l", displayName: null })).toBe(
      "Someone",
    );
    expect(personName({ email, name: email, displayName: null })).toBe(
      "Someone",
    );
    expect(personName({ email, name: null, displayName: null })).toBe(
      "Someone",
    );
  });

  it("the listens list names a nameless member Someone", async () => {
    expect((await add({ ...base, memberId: mate.userId })).status).toBe(200);
    const e = (await listListens(E, owner.userId)).entries.find(
      (x) => x.member.id === mate.userId,
    );
    expect(e?.member.name).toBe("Someone");
  });
});

describe("POST agent-listens", () => {
  it("all pages: adds with the day choice, returns the entry, audits, needs no passkey", async () => {
    const before = await audits("agent_listens.add");
    const t0 = Date.now();
    const r = await add({ ...base, memberId: mate2.userId, until: 90 });
    expect(r.status).toBe(200);
    const body = (await r.json()) as ListenAddResult;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      member: { id: mate2.userId },
      scope: "all",
      artifact: null,
      space: null,
    });
    expect(body.entries[0]?.until).toBeGreaterThanOrEqual(t0 + 90 * DAY);
    const [row] = await rows(mate2.userId);
    expect(row).toMatchObject({ scope: "all", created_via: "settings" });
    expect(await audits("agent_listens.add")).toBe(before + 1);
  });

  it("an end time in ms is clamped to a year", async () => {
    const m = await mk("la-clamp");
    const r = await add({
      ...base,
      memberId: m.userId,
      until: Date.now() + 5 * 365 * DAY,
    });
    expect(r.status).toBe(200);
    const [row] = await rows(m.userId);
    expect(row?.until).toBeLessThanOrEqual(Date.now() + 365 * DAY);
    expect(row?.until).toBeGreaterThan(Date.now() + 364 * DAY);
    expect(
      (await add({ ...base, memberId: m.userId, until: Date.now() - 5000 }))
        .status,
    ).toBe(400);
  });

  it("page scope: needs a page both can open; a page open to the link or guests is refused", async () => {
    const id = await page();
    const ok = await add({
      memberId: mate.userId,
      scope: "page",
      artifactId: id,
      until: 30,
      via: "share_tick",
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ListenAddResult).entries[0]?.artifact).toEqual(
      {
        id,
        title: "doc",
      },
    );
    const send = (artifactId: string, memberId = mate.userId) =>
      add({ memberId, scope: "page", artifactId, until: 30, via: "settings" });
    // A member who cannot open the page.
    expect((await send(id, mate2.userId)).status).toBe(400);
    // A viewer-only member: an entry would never apply, so it is refused.
    const v = await mk("la-viewer");
    await putShare(E, owner.member, id, { email: v.email, role: "viewer" });
    expect((await send(id, v.userId)).status).toBe(400);
    expect(await rows(v.userId)).toHaveLength(0);
    // Public.
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?1",
    )
      .bind(id)
      .run();
    expect((await send(id)).status).toBe(400);
    // A guest-role share.
    const g = await page([mate, guest]);
    expect((await send(g)).status).toBe(400);
    // No page named, or one that is not there.
    expect(
      (
        await add({
          memberId: mate.userId,
          scope: "page",
          until: 30,
          via: "settings",
        })
      ).status,
    ).toBe(400);
    expect((await send("nope")).status).toBe(400);
  });

  it("space scope: the space must exist and the caller be in it", async () => {
    const sid = newId();
    await E.DB.prepare(
      "insert into spaces (id, kind, name, all_members_role, public_links, created_at) values (?1, 'shared', 'S', 'viewer', 0, ?2)",
    )
      .bind(sid, Date.now())
      .run();
    const send = (spaceId: string) =>
      add({
        memberId: mate.userId,
        scope: "space",
        spaceId,
        until: 30,
        via: "settings",
      });
    expect((await send(sid)).status).toBe(400);
    expect((await send("nope")).status).toBe(400);
    await E.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?1, ?2, 'member', 'manual', ?3)",
    )
      .bind(sid, owner.userId, Date.now())
      .run()
      .catch(async () =>
        E.DB.prepare(
          "insert into space_members (space_id, user_id, role, source, created_at) values (?1, ?2, 'editor', 'manual', ?3)",
        )
          .bind(sid, owner.userId, Date.now())
          .run(),
      );
    const r = await send(sid);
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as ListenAddResult).entries[0]?.space,
    ).toMatchObject({ id: sid });
  });

  it("refuses an outsider, a non-member, yourself and a missing person (400, nothing written)", async () => {
    for (const memberId of [guest.userId, "nobody", owner.userId, ""]) {
      expect((await add({ ...base, memberId })).status).toBe(400);
    }
    expect(await rows(guest.userId)).toHaveLength(0);
  });

  it("refuses a token, an MCP-style bearer and a signed-out caller; a guest account cannot add", async () => {
    const pat = (await createPat(E, owner.userId, "la")).token;
    const r = await api(app, R.agentListens, pat, {
      method: "POST",
      body: { ...base, memberId: stranger.userId },
    });
    expect(r.status).toBe(403);
    expect(await rows(stranger.userId)).toHaveLength(0);
    expect(
      (
        await api(app, R.agentListens, null, {
          method: "POST",
          body: { ...base, memberId: stranger.userId },
        })
      ).status,
    ).toBe(401);
    expect([403, 404]).toContain(
      (await add({ ...base, memberId: mate.userId }, guest)).status,
    );
  });

  it("re-adding extends until instead of duplicating; a shorter re-add keeps the longer end", async () => {
    const m = await mk("la-ext");
    await add({ ...base, memberId: m.userId, until: 30 });
    const [a] = await rows(m.userId);
    await add({ ...base, memberId: m.userId, until: 365 });
    const after = await rows(m.userId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(a?.id);
    expect(after[0]?.until).toBeGreaterThan((a?.until as number) + 300 * DAY);
    const longer = after[0]?.until as number;
    await add({ ...base, memberId: m.userId, until: 30 });
    expect((await rows(m.userId))[0]?.until).toBe(longer);
    // A different scope is its own entry.
    const id = await page([m]);
    await add({
      memberId: m.userId,
      scope: "page",
      artifactId: id,
      until: 30,
      via: "settings",
    });
    expect(await rows(m.userId)).toHaveLength(2);
  });

  it("batch: all members, one refusal refuses all, at most 200", async () => {
    const a = await mk("la-b1");
    const b = await mk("la-b2");
    const ok = await add({
      ...base,
      memberIds: [a.userId, b.userId],
      until: 90,
      via: "first_setup",
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ListenAddResult).entries).toHaveLength(2);
    expect((await rows(a.userId))[0]?.created_via).toBe("first_setup");

    const c = await mk("la-b3");
    const bad = await add({ ...base, memberIds: [c.userId, guest.userId] });
    expect(bad.status).toBe(400);
    expect(await rows(c.userId)).toHaveLength(0);

    const many = Array.from({ length: 201 }, (_, i) => `u${i}`);
    expect((await add({ ...base, memberIds: many })).status).toBe(400);
    // Both or neither of memberId and memberIds is a bad body.
    expect((await add({ ...base })).status).toBe(400);
    expect(
      (await add({ ...base, memberId: a.userId, memberIds: [b.userId] }))
        .status,
    ).toBe(400);
  });
});

describe("GET agent-asks/history", () => {
  const seed = async (
    receiver: U,
    sender: U,
    artifactId: string | null,
    items: {
      state: string;
      at: number;
      expires?: number;
      quiet?: number | null;
    }[],
  ) => {
    const rid = newId();
    // One request row per (receiver, sender, page): each seeded request gets its own page.
    const pid = artifactId ?? (await page([receiver, sender]));
    await E.DB.prepare(
      `insert into held_requests (id, receiver_id, sender_id, artifact_id, created_at, last_at, quiet_until)
       values (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
    )
      .bind(
        rid,
        receiver.userId,
        sender.userId,
        pid,
        items[0]?.at,
        items[0]?.quiet ?? null,
      )
      .run();
    for (const it of items)
      await E.DB.prepare(
        `insert into held_request_items (id, request_id, thread_id, comment_id, agent_key, way, state, created_at, expires_at)
         values (?1, ?2, 't', ?3, 'k1', 'mention', ?4, ?5, ?6)`,
      )
        .bind(
          newId(),
          rid,
          newId(),
          it.state,
          it.at,
          it.expires ?? it.at + HELD_LAPSE_MS,
        )
        .run();
  };
  const get = async (u: U) =>
    (await (await api(app, R.agentAskHistory, u.cookie)).json()) as AskHistory;

  it("last 30 days, newest first, outcome per row, ids/names/titles/times only", async () => {
    const r = await mk("la-hist");
    const now = Date.now();
    await seed(r, mate, null, [{ state: "held", at: now - 40 * DAY }]);
    await seed(r, mate, null, [{ state: "allowed", at: now - 3 * DAY }]);
    await seed(r, mate, null, [
      { state: "held", at: now - 2 * DAY, expires: now - DAY },
    ]);
    await seed(r, mate, null, [
      {
        state: "held",
        at: now - 5 * 3600_000,
        quiet: now - 3600_000 + HELD_QUIET_MS,
      },
    ]);
    await seed(r, mate, null, [{ state: "held", at: now - 1000 }]);
    await seed(r, mate, null, [{ state: "withdrawn", at: now - 500 }]);
    const h = await get(r);
    expect(h.rows.map((x) => x.outcome)).toEqual([
      "held",
      "not_now",
      "lapsed",
      "allowed_once",
    ]);
    expect(h.rows.map((x) => x.at)).toEqual(
      [...h.rows.map((x) => x.at)].sort((a, b) => b - a),
    );
    expect(h.rows[0]).toMatchObject({
      agent: { key: "k1" },
      asker: { id: mate.userId, name: "Someone" },
      artifact: { title: "doc" },
    });
    expect(Object.keys(h.rows[0] ?? {}).sort()).toEqual([
      "agent",
      "artifact",
      "asker",
      "at",
      "outcome",
    ]);
    // Only the receiver's own rows.
    expect(
      (await get(mate)).rows.filter((x) => x.asker.id === mate.userId),
    ).toHaveLength(0);
    expect((await askHistory(E, r.userId)).rows).toHaveLength(4);
  });

  it("a page the receiver can no longer open is null, not its title", async () => {
    const r = await mk("la-hist2");
    const id = await page([mate]);
    await seed(r, mate, id, [{ state: "allowed", at: Date.now() - 1000 }]);
    expect((await get(r)).rows[0]?.artifact).toBeNull();
  });

  it("browser session only", async () => {
    const pat = (await createPat(E, owner.userId, "hist")).token;
    expect((await api(app, R.agentAskHistory, pat)).status).toBe(403);
    expect((await api(app, R.agentAskHistory, null)).status).toBe(401);
  });
});

afterAll(() => undefined);
