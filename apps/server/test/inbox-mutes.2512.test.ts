// #2512 S4: mutes (push only).
import { env } from "cloudflare:workers";
import { type InboxMutes, newId, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { MUTES_MAX } from "../src/services/inbox-mutes.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

async function mk(p: string) {
  const l = await login(`${p}-${tag}@x.com`, "member");
  const member = await getUser(E, l.userId);
  if (!member) throw new Error("no user");
  return { ...l, member };
}
const post = (cookie: string, body: unknown) =>
  api(app, R.meInboxMutes, cookie, { method: "POST", body });
const list = async (cookie: string) =>
  (await (await api(app, R.meInboxMutes, cookie)).json()) as InboxMutes;
const page = async (u: Awaited<ReturnType<typeof mk>>, title = "Plan") =>
  (
    await publish(
      E,
      u.member,
      { title, format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    )
  ).id;
/** An update item from an agent, as the inbox stores one (the agent's bus identity in the actor). */
async function itemFrom(
  userId: string,
  artifactId: string,
  identityId: string,
  name: string,
) {
  await E.DB.prepare(
    `insert into inbox_items (id, user_id, kind, level, key, artifact_id, actor, excerpt, created_at)
     values (?, ?, 'comment', 'update', ?, ?, ?, 'hi', ?)`,
  )
    .bind(
      newId(),
      userId,
      `comment:${newId()}`,
      artifactId,
      JSON.stringify({
        kind: "user",
        ref: "someone",
        agent: {
          name,
          via: null,
          identity: { identityId, name, kind: "claude" },
        },
      }),
      Date.now(),
    )
    .run();
}

describe("mutes", () => {
  it("a page they can read and an agent on one of their items: listed with names, then unmuted", async () => {
    const a = await mk("a");
    const art = await page(a, "Roadmap");
    const idn = `idn-${newId()}`;
    await itemFrom(a.userId, art, idn, "Scout");
    expect((await post(a.cookie, { kind: "page", id: art })).status).toBe(204);
    expect((await post(a.cookie, { kind: "agent", id: idn })).status).toBe(204);
    // Again: no-op.
    expect((await post(a.cookie, { kind: "page", id: art })).status).toBe(204);
    const l = await list(a.cookie);
    expect(l.items).toHaveLength(2);
    expect(l.items).toContainEqual({ kind: "page", id: art, name: "Roadmap" });
    expect(l.items).toContainEqual({ kind: "agent", id: idn, name: "Scout" });
    expect(
      (
        await api(app, R.meInboxMute("agent", idn), a.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await list(a.cookie)).items).toHaveLength(1);
    // Unmuting what isn't muted is fine.
    expect(
      (
        await api(app, R.meInboxMute("agent", idn), a.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });

  it("a mute shows a page's title only while they can still read it (and it isn't deleted)", async () => {
    const owner = await mk("t-own");
    const guest = await mk("t-read");
    const art = await page(owner, "Secret plan");
    await E.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
    )
      .bind(art, guest.member.email, owner.userId, Date.now())
      .run();
    expect((await post(guest.cookie, { kind: "page", id: art })).status).toBe(
      204,
    );
    expect((await list(guest.cookie)).items).toEqual([
      { kind: "page", id: art, name: "Secret plan" },
    ]);
    // Access lost: the mute stays, the title doesn't.
    await E.DB.prepare("delete from shares where artifact_id = ?")
      .bind(art)
      .run();
    expect((await list(guest.cookie)).items).toEqual([
      { kind: "page", id: art, name: "" },
    ]);
    expect(JSON.stringify(await list(guest.cookie))).not.toContain("Secret");
    // The owner still sees it; soft-deleted, nobody does.
    await post(owner.cookie, { kind: "page", id: art });
    expect((await list(owner.cookie)).items[0]?.name).toBe("Secret plan");
    await E.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now(), art)
      .run();
    expect((await list(owner.cookie)).items[0]?.name).toBe("");
  });

  it("an unmute with an unknown kind is a 400", async () => {
    const a = await mk("kind");
    const r = await api(app, "/api/v1/me/inbox/mutes/tag/x", a.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(400);
  });

  it("only ids they can see: another's private page and an agent on none of their items are 404", async () => {
    const a = await mk("own");
    const b = await mk("other");
    const theirs = await page(b, "Private");
    expect((await post(a.cookie, { kind: "page", id: theirs })).status).toBe(
      404,
    );
    expect(
      (await post(a.cookie, { kind: "page", id: "no-such-page" })).status,
    ).toBe(404);
    // An agent that is on someone else's item.
    const idn = `idn-${newId()}`;
    await itemFrom(b.userId, theirs, idn, "Other");
    expect((await post(a.cookie, { kind: "agent", id: idn })).status).toBe(404);
    expect((await list(a.cookie)).items).toHaveLength(0);
  });

  it("each person's own list; a token and anonymous can't change it", async () => {
    const a = await mk("p1");
    const b = await mk("p2");
    const art = await page(a);
    await post(a.cookie, { kind: "page", id: art });
    expect((await list(b.cookie)).items).toHaveLength(0);
    const pat = (await createPat(E, a.userId, "mutes")).token;
    expect((await post(pat, { kind: "page", id: art })).status).toBe(404);
    expect(
      (await api(app, R.meInboxMute("page", art), pat, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect((await api(app, R.meInboxMutes, pat)).status).toBe(200);
    expect(
      (
        await api(app, R.meInboxMutes, null, {
          method: "POST",
          body: { kind: "page", id: art },
        })
      ).status,
    ).toBe(401);
    expect((await list(a.cookie)).items).toHaveLength(1);
    // Another person's unmute changes nothing of theirs.
    await api(app, R.meInboxMute("page", art), b.cookie, { method: "DELETE" });
    expect((await list(a.cookie)).items).toHaveLength(1);
  });

  it("a bad body is 400, and MUTES_MAX is the cap (409 mutes_full)", async () => {
    const a = await mk("cap");
    expect((await post(a.cookie, { kind: "tag", id: "x" })).status).toBe(400);
    expect((await post(a.cookie, {})).status).toBe(400);
    const arts: string[] = [];
    for (let i = 0; i < MUTES_MAX; i++)
      await E.DB.prepare(
        "insert into inbox_mutes (user_id, kind, target_id, name, created_at) values (?, 'agent', ?, 'x', ?)",
      )
        .bind(a.userId, `idn-${i}`, Date.now())
        .run();
    const art = await page(a);
    arts.push(art);
    const r = await post(a.cookie, { kind: "page", id: art });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "mutes_full",
    );
    // Muting what is already muted still works at the cap.
    await E.DB.prepare(
      "delete from inbox_mutes where user_id = ? and target_id = 'idn-0'",
    )
      .bind(a.userId)
      .run();
    expect((await post(a.cookie, { kind: "page", id: art })).status).toBe(204);
    expect((await post(a.cookie, { kind: "page", id: art })).status).toBe(204);
  });
});
