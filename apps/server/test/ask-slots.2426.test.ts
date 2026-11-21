// #2426 B, #2536: GET /artifacts/:id/ask-slots. The server maps a page's slot
// keys to asks, and leaves out every slot whose home page the caller cannot
// open (the contract, jp3RtzkygV1sijvM, section 2).
import { env } from "cloudflare:workers";
import type { AskSlot, Member } from "@oa/shared";
import { R, viewerPath } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { addThread } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

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
    const listR = await api(app, R.comments(home), owner.cookie, {}, E);
    const homeList = (await listR.json()) as {
      threads: { comments: { id: string; ask?: unknown }[] }[];
    };
    console.log(
      "DBG home comments",
      JSON.stringify(
        homeList.threads.map((t) => t.comments.map((x) => [x.id, !!x.ask])),
      ),
      "want",
      a.commentId,
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
    expect(s.placer?.agent).toBe("OA Manager");
    expect(s.placer?.id).toBe(owner.userId);
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
});
