// #2426 B, #2536: GET /artifacts/:id/ask-slots. The server maps a page's slot
// keys to asks, and leaves out every slot whose home page the caller cannot
// open (the contract, jp3RtzkygV1sijvM, section 2).
import { env } from "cloudflare:workers";
import {
  ASK_SLOT_HOMES_MAX,
  ASK_SLOTS_MAX,
  type AskSlot,
  type Member,
  R,
  viewerPath,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { publish, purgeNow } from "../src/services/artifacts.js";
import { addThread } from "../src/services/comments.js";
import { eraseMember, SYSTEM_ACTOR } from "../src/services/members.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import { connect, E as mcpEnv } from "./mcp-helpers.js";

const E = env as unknown as Env;
const app = createApp();
const tag = Math.random().toString(36).slice(2, 8);

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const NOTE = { kind: "note" };
const OPTS = [
  { id: "yes", label: "Yes, go ahead" },
  { id: "no", label: "Not yet" },
];

async function page(u: U, title: string, visibility = "private") {
  const a = await publish(
    E,
    u.member,
    {
      title,
      format: "html",
      content: `<div data-oa-ask="one"></div>`,
      comments: true,
      visibility,
    } as never,
    null,
    undefined,
    "create",
  );
  return a.id;
}

/** An ask on `id` addressed to the owner themselves, and its thread/comment ids. */
async function ask(
  u: U,
  id: string,
): Promise<{ threadId: string; commentId: string }> {
  const t = await addThread(
    E,
    { id, format: "html", currentVersion: 1 } as never,
    { kind: "user", id: u.userId, typed: true },
    { userId: u.userId, short: "v1", owner: true, moderator: true },
    {
      anchor: NOTE,
      body: "Which way?",
      ask: {
        question: "Deploy now?",
        options: OPTS,
        to: [{ key: u.userId }],
      },
    },
    { moderator: true },
  );
  const commentId = t.comments[t.comments.length - 1]?.id;
  if (!commentId) throw new Error("no comment in the new thread");
  return { threadId: t.id, commentId };
}

/** Writes a placement row the way the server will (place_ask, or an ask with a slot). */
async function slot(
  pageId: string,
  key: string,
  home: { id: string; threadId: string; commentId: string },
  extra: { note?: string; placedBy?: string; agent?: string } = {},
) {
  await E.DB.prepare(
    `insert into artifact_ask_slots
       (artifact_id, slot_key, home_artifact_id, thread_id, comment_id, note, placed_by, placed_agent, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      pageId,
      key,
      home.id,
      home.threadId,
      home.commentId,
      extra.note ?? null,
      extra.placedBy ?? null,
      extra.agent ?? null,
      new Date().toISOString(),
    )
    .run();
}

const slots = async (id: string, u: U | null) =>
  api(app, R.askSlots(id), u?.cookie ?? null, {}, E);

describe("ask slots: the read route", () => {
  let owner: U;
  let viewer: U;
  let outsider: U;

  beforeAll(async () => {
    owner = await mk("sl-owner");
    viewer = await mk("sl-viewer");
    outsider = await mk("sl-outsider");
  });

  it("a slot whose home page the caller can open carries that ask, its author and the placer's note", async () => {
    const home = await page(owner, "Opening runbook");
    const shown = await page(owner, "Open Artifacts Asks");
    const a = await ask(owner, home);
    await slot(
      shown,
      "gate",
      { id: home, ...a },
      {
        note: "Gates the landing. Do this one first.",
        placedBy: owner.userId,
        agent: "OA Manager",
      },
    );
    const r = await slots(shown, owner);
    expect(r.status).toBe(200);
    const list = (await r.json()) as AskSlot[];
    expect(list).toHaveLength(1);
    const s = list[0] as AskSlot;
    expect(s.key).toBe("gate");
    expect(s.home).toEqual({ artifactId: home, title: "Opening runbook" });
    expect(s.threadId).toBe(a.threadId);
    expect(s.commentId).toBe(a.commentId);
    // The ask view the home page would give this viewer: the question, never a pick it invented.
    expect(s.ask.question).toBe("Deploy now?");
    expect(s.ask.options.map((o) => o.id)).toEqual(["yes", "no"]);
    // Who asked, for "{agent} asks you".
    expect(s.author.kind).toBe("user");
    expect(s.note).toBe("Gates the landing. Do this one first.");
    expect(s.placer).toEqual({ name: "OA Manager", agent: "OA Manager" });
    expect("id" in (s.placer ?? {})).toBe(false);
  });

  it("leaves out a slot whose home the caller cannot open, never a mask (rule 1)", async () => {
    const home = await page(owner, "Private home");
    const shown = await page(owner, "Public board", "public");
    const open = await page(owner, "Shared home");
    const aHome = await ask(owner, home);
    const aOpen = await ask(owner, open);
    await slot(shown, "hidden", { id: home, ...aHome });
    await slot(shown, "shown", { id: open, ...aOpen });
    await api(app, R.shares(open), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "viewer" },
    });
    const mine = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(mine.map((s) => s.key)).toEqual(["hidden", "shown"]);
    const theirs = (await (await slots(shown, viewer)).json()) as AskSlot[];
    expect(theirs.map((s) => s.key)).toEqual(["shown"]);
    // A stranger to both homes sees neither.
    const none = (await (await slots(shown, outsider)).json()) as AskSlot[];
    expect(none).toEqual([]);
  });

  it("leaves out a deleted home, and answers [] to a signed-out visitor", async () => {
    const home = await page(owner, "Doomed");
    const shown = await page(owner, "Board", "public");
    const a = await ask(owner, home);
    await slot(shown, "gone", { id: home, ...a });
    expect((await slots(shown, owner)).status).toBe(200);
    await api(app, R.artifact(shown), owner.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    // Signed out: no slots, even on a public page.
    const anon = (await (await slots(shown, null)).json()) as AskSlot[];
    expect(anon).toEqual([]);
    // The home page is gone: nothing, not a stale card.
    await api(app, R.artifact(home), owner.cookie, { method: "DELETE" });
    const after = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(after).toEqual([]);
  });

  it("drops a withdrawn ask and any key the page could not have written", async () => {
    const home = await page(owner, "Answers");
    const shown = await page(owner, "Board 2");
    const a = await ask(owner, home);
    await slot(shown, "kept", { id: home, ...a });
    await slot(shown, "Not A Key", { id: home, ...a });
    const before = (await (await slots(shown, owner)).json()) as AskSlot[];
    // The malformed key never reaches a viewer, whatever a row holds.
    expect(before.map((s) => s.key)).toEqual(["kept"]);
    // Withdrawn at home by the asker: the slot goes with it, never a stale card.
    const w = await api(
      app,
      R.commentWithdraw(home, a.threadId, a.commentId),
      owner.cookie,
      { method: "POST", body: {} },
    );
    expect(w.status, await w.text()).toBeLessThan(300);
    const after = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(after).toEqual([]);
  });

  it("leaves every slot out for a signed-out visitor, even on a public page (rule 1)", async () => {
    const home = await page(owner, "Open home", "public");
    const shown = await page(owner, "Open board", "public");
    const a = await ask(owner, home);
    await slot(shown, "public", { id: home, ...a });
    // The owner sees it; the same page, signed out, shows nothing at all.
    expect(
      ((await (await slots(shown, owner)).json()) as AskSlot[]).length,
    ).toBe(1);
    const anon = await slots(shown, null);
    expect(anon.status).toBe(200);
    expect((await anon.json()) as AskSlot[]).toEqual([]);
  });

  it("leaves out a home whose comments are off", async () => {
    const home = await page(owner, "No comments here");
    const shown = await page(owner, "Board 3");
    const a = await ask(owner, home);
    await slot(shown, "quiet", { id: home, ...a });
    expect(
      ((await (await slots(shown, owner)).json()) as AskSlot[]).length,
    ).toBe(1);
    // Comments off at home: the ask cannot be read or answered there, so the
    // card is not shown anywhere.
    await api(app, R.artifact(home), owner.cookie, {
      method: "PATCH",
      body: { comments: false },
    });
    expect((await (await slots(shown, owner)).json()) as AskSlot[]).toEqual([]);
  });

  it("reads at most ASK_SLOT_HOMES_MAX homes, and unchecked homes never use that budget", async () => {
    // Public, so a viewer can read the page itself; the homes are private.
    const shown = await page(owner, "Busy board", "public");
    const homes: string[] = [];
    for (let i = 1; i <= 11; i++) {
      const home = await page(owner, `Home ${i}`);
      const a = await ask(owner, home);
      homes.push(home);
      await slot(shown, `h${String(i).padStart(2, "0")}`, { id: home, ...a });
    }
    const all = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(all.length).toBe(ASK_SLOT_HOMES_MAX);
    expect(all.map((s) => s.key)).toEqual(
      Array.from(
        { length: ASK_SLOT_HOMES_MAX },
        (_, i) => `h${String(i + 1).padStart(2, "0")}`,
      ),
    );
    // Homes this viewer cannot open do not spend the budget: a stranger to the
    // first ten still gets the eleventh, which they can read.
    await api(app, R.shares(homes[10] as string), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "viewer" },
    });
    const theirs = (await (await slots(shown, viewer)).json()) as AskSlot[];
    expect(theirs.map((s) => s.key)).toEqual(["h11"]);
  });

  it("is the viewer's own page that decides the floor, not the ask's home", async () => {
    const home = await page(owner, "Home");
    const shown = await page(owner, "Shown");
    const a = await ask(owner, home);
    await slot(shown, "x", { id: home, ...a });
    // A stranger cannot read the page either: the route refuses, as comments do.
    const r = await slots(shown, outsider);
    expect(r.status).toBe(404);
    expect(viewerPath(shown)).toContain(shown);
  });

  it("resolves a replaced ask (same-page and cross-page) when readable, drops when unreadable (#2536)", async () => {
    const home1 = await page(owner, "Original home");
    const home2 = await page(owner, "Replacement home");
    const shown = await page(owner, "Board replace", "public");
    const a1 = await ask(owner, home1);
    // Same-page replacement on home1.
    const tSame = await addThread(
      E,
      { id: home1, format: "html", currentVersion: 1 } as never,
      { kind: "user", id: owner.userId, typed: true },
      { userId: owner.userId, short: "v1", owner: true, moderator: true },
      {
        anchor: NOTE,
        body: "Updated question",
        ask: {
          question: "Deploy v2 now?",
          options: OPTS,
          to: [{ key: owner.userId }],
          replaces: a1.commentId,
        },
      },
      { moderator: true },
    );
    const cSameId = tSame.comments[tSame.comments.length - 1]?.id as string;
    await slot(shown, "same", { id: home1, ...a1 }, { placedBy: owner.userId });
    const sameList = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(sameList).toHaveLength(1);
    expect(sameList[0]?.commentId).toBe(cSameId);
    expect(sameList[0]?.ask.question).toBe("Deploy v2 now?");
    // User-only placer never exposes raw user id, email, or email local part.
    const localPart = owner.email.split("@")[0] as string;
    await E.DB.prepare(
      "update users set name = ?, display_name = null where id = ?",
    )
      .bind(owner.email, owner.userId)
      .run();
    const emailPlacerList = (await (
      await slots(shown, owner)
    ).json()) as AskSlot[];
    expect(emailPlacerList[0]?.placer?.name).toBe("Someone");
    expect(emailPlacerList[0]?.placer?.name).not.toContain("@");
    expect(emailPlacerList[0]?.placer?.name).not.toContain(localPart);

    // Cross-page replacement: withdraw cSameId pointing at a new ask on home2.
    const a2 = await ask(owner, home2);
    const w = await api(
      app,
      R.commentWithdraw(home1, tSame.id, cSameId),
      owner.cookie,
      {
        method: "POST",
        body: {
          replacedBy: {
            artifactId: home2,
            threadId: a2.threadId,
            commentId: a2.commentId,
          },
        },
      },
    );
    expect(w.status, await w.text()).toBeLessThan(300);
    // Owner can read home2 -> slot resolves to home2's ask.
    const crossOwner = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(crossOwner).toHaveLength(1);
    expect(crossOwner[0]?.home).toEqual({
      artifactId: home2,
      title: "Replacement home",
    });
    expect(crossOwner[0]?.commentId).toBe(a2.commentId);

    // Viewer can read home1, NOT home2 -> replacement is unreadable, slot is omitted.
    await api(app, R.shares(home1), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "viewer" },
    });
    const crossViewer = (await (
      await slots(shown, viewer)
    ).json()) as AskSlot[];
    expect(crossViewer).toEqual([]);
  });

  it("rate limits GET /ask-slots per viewer (#2536)", async () => {
    const home = await page(owner, "RL Home");
    const shown = await page(owner, "RL Board");
    const a = await ask(owner, home);
    await slot(shown, "rl", { id: home, ...a });
    const denied = {
      ...E,
      RL_ANON: { limit: async () => ({ success: false }) },
    } as unknown as Env;
    const r = await api(app, R.askSlots(shown), owner.cookie, {}, denied);
    expect(r.status).toBe(429);
  });

  it("cleans up slot rows when showing page, home page, or placing user is removed (#2536)", async () => {
    const home = await page(owner, "Purge Home");
    const shown = await page(owner, "Purge Board");
    const other = await page(owner, "Keep Board");
    const a = await ask(owner, home);
    await slot(shown, "s1", { id: home, ...a });
    await slot(other, "s2", { id: home, ...a });

    const count = async (where: string, ...args: unknown[]) =>
      (
        await E.DB.prepare(
          `select count(*) as n from artifact_ask_slots where ${where}`,
        )
          .bind(...args)
          .first<{ n: number }>()
      )?.n ?? 0;

    // Purging the showing page removes its slot rows.
    expect(await purgeNow(E, shown)).toBe(true);
    expect(await count("artifact_id = ?", shown)).toBe(0);
    expect(await count("artifact_id = ?", other)).toBe(1);

    // Purging the home page removes slot rows pointing at it from other pages.
    expect(await purgeNow(E, home)).toBe(true);
    expect(await count("home_artifact_id = ?", home)).toBe(0);

    // Erasing a placing user removes rows pointing at their user id.
    const doomed = await mk("sl-erased");
    const keepHome = await page(owner, "Keep Home");
    const keepAsk = await ask(owner, keepHome);
    await slot(
      other,
      "by-doomed",
      { id: keepHome, ...keepAsk },
      { placedBy: doomed.userId },
    );
    expect(await count("placed_by = ?", doomed.userId)).toBe(1);
    await E.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(doomed.userId)
      .run();
    await eraseMember(E, doomed.userId, SYSTEM_ACTOR);
    expect(await count("placed_by = ?", doomed.userId)).toBe(0);
  });

  it("places and removes ask slots over REST with access, state, and cap checks (#2536)", async () => {
    const home = await page(owner, "REST Home");
    const privateHome = await page(outsider, "Outsider Secret Home");
    const shown = await page(owner, "REST Board", "public");
    const a = await ask(owner, home);
    const secretAsk = await ask(outsider, privateHome);

    // Owner places cross-page ask with note.
    const put1 = await api(app, R.askSlot(shown, "launch"), owner.cookie, {
      method: "PUT",
      body: {
        homeArtifactId: home,
        threadId: a.threadId,
        commentId: a.commentId,
        note: "Key launch decision",
      },
    });
    expect(put1.status, await put1.text()).toBe(200);

    // Owner sees it; outsider (cannot read home) sees [] (Rule 1).
    const ownerSlots = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(ownerSlots).toHaveLength(1);
    expect(ownerSlots[0]?.key).toBe("launch");
    expect(ownerSlots[0]?.note).toBe("Key launch decision");
    const outsiderSlots = (await (
      await slots(shown, outsider)
    ).json()) as AskSlot[];
    expect(outsiderSlots).toEqual([]);

    // Viewer of target page cannot place or remove a slot.
    await api(app, R.shares(shown), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "viewer" },
    });
    const viewerPut = await api(
      app,
      R.askSlot(shown, "viewer-try"),
      viewer.cookie,
      {
        method: "PUT",
        body: {
          homeArtifactId: home,
          threadId: a.threadId,
          commentId: a.commentId,
        },
      },
    );
    expect(viewerPut.status).toBe(404);
    const viewerDel = await api(
      app,
      R.askSlot(shown, "launch"),
      viewer.cookie,
      {
        method: "DELETE",
      },
    );
    expect(viewerDel.status).toBe(404);

    // Rule 5: owner of target page cannot place an ask from an unreadable home.
    const rule5 = await api(app, R.askSlot(shown, "stolen"), owner.cookie, {
      method: "PUT",
      body: {
        homeArtifactId: privateHome,
        threadId: secretAsk.threadId,
        commentId: secretAsk.commentId,
      },
    });
    expect(rule5.status).toBe(404);

    // Refuses withdrawn asks.
    const aWithdrawn = await ask(owner, home);
    const wRes = await api(
      app,
      R.commentWithdraw(home, aWithdrawn.threadId, aWithdrawn.commentId),
      owner.cookie,
      { method: "POST", body: {} },
    );
    expect(wRes.status).toBeLessThan(300);
    const putWithdrawn = await api(
      app,
      R.askSlot(shown, "dead"),
      owner.cookie,
      {
        method: "PUT",
        body: {
          homeArtifactId: home,
          threadId: aWithdrawn.threadId,
          commentId: aWithdrawn.commentId,
        },
      },
    );
    expect(putWithdrawn.status).toBe(409);
    expect(
      ((await putWithdrawn.json()) as { error: { code: string } }).error.code,
    ).toBe("withdrawn");

    // Refuses replaced asks.
    const aOld = await ask(owner, home);
    await addThread(
      E,
      { id: home, format: "html", currentVersion: 1 } as never,
      { kind: "user", id: owner.userId, typed: true },
      { userId: owner.userId, short: "v1", owner: true, moderator: true },
      {
        anchor: NOTE,
        body: "Newer",
        ask: {
          question: "Newer?",
          options: OPTS,
          to: [{ key: owner.userId }],
          replaces: aOld.commentId,
        },
      },
      { moderator: true },
    );
    const putReplaced = await api(app, R.askSlot(shown, "old"), owner.cookie, {
      method: "PUT",
      body: {
        homeArtifactId: home,
        threadId: aOld.threadId,
        commentId: aOld.commentId,
      },
    });
    expect(putReplaced.status).toBe(409);
    expect(
      ((await putReplaced.json()) as { error: { code: string } }).error.code,
    ).toBe("already_replaced");

    // Enforces ASK_SLOTS_MAX (20) on new keys, while updating an existing key works.
    const capped = await page(owner, "Capped Board");
    for (let i = 1; i <= ASK_SLOTS_MAX; i++) {
      const r = await api(app, R.askSlot(capped, `k${i}`), owner.cookie, {
        method: "PUT",
        body: {
          homeArtifactId: home,
          threadId: a.threadId,
          commentId: a.commentId,
        },
      });
      expect(r.status).toBe(200);
    }
    const over = await api(app, R.askSlot(capped, "k21"), owner.cookie, {
      method: "PUT",
      body: {
        homeArtifactId: home,
        threadId: a.threadId,
        commentId: a.commentId,
      },
    });
    expect(over.status).toBe(409);
    const updateExisting = await api(
      app,
      R.askSlot(capped, "k1"),
      owner.cookie,
      {
        method: "PUT",
        body: {
          homeArtifactId: home,
          threadId: a.threadId,
          commentId: a.commentId,
          note: "Updated at cap",
        },
      },
    );
    expect(updateExisting.status).toBe(200);

    // Removing the slot removes it from the board without touching the home ask.
    const del = await api(app, R.askSlot(shown, "launch"), owner.cookie, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    const afterDel = (await (await slots(shown, owner)).json()) as AskSlot[];
    expect(afterDel).toEqual([]);
  });

  it("places and removes ask slots over MCP (#2536)", async () => {
    const home = await page(owner, "MCP Home");
    const secretHome = await page(outsider, "MCP Secret Home");
    const shown = await page(owner, "MCP Board");
    const a = await ask(owner, home);
    const secretAsk = await ask(outsider, secretHome);

    const pat = await createPat(E, owner.userId, "mcp-slot-test");
    const client = await connect(pat.token, { env: mcpEnv() });
    try {
      const placed = await client.callTool({
        name: "place_ask",
        arguments: {
          id: shown,
          key: "mcp-slot",
          homeArtifactId: home,
          threadId: a.threadId,
          commentId: a.commentId,
          note: "From MCP",
        },
      });
      expect(placed.isError).not.toBe(true);

      const list1 = (await (await slots(shown, owner)).json()) as AskSlot[];
      expect(list1).toHaveLength(1);
      expect(list1[0]?.key).toBe("mcp-slot");
      expect(list1[0]?.note).toBe("From MCP");

      // Rule 5 over MCP: unreadable home artifact is refused.
      const denied = await client.callTool({
        name: "place_ask",
        arguments: {
          id: shown,
          key: "bad-slot",
          homeArtifactId: secretHome,
          threadId: secretAsk.threadId,
          commentId: secretAsk.commentId,
        },
      });
      expect(denied.isError).toBe(true);

      const removed = await client.callTool({
        name: "remove_ask_slot",
        arguments: { id: shown, key: "mcp-slot" },
      });
      expect(removed.isError).not.toBe(true);

      const list2 = (await (await slots(shown, owner)).json()) as AskSlot[];
      expect(list2).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
