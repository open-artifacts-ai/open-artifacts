import { env } from "cloudflare:workers";
import { type BusNotice, type Member, newId } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  listHeld,
  RECONCILE_PAGES,
  RECONCILE_PREFIX,
  reconcileHeld,
  recordHolds,
} from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import {
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import {
  addThread,
  artifactAgents,
  type CommentViewer,
  type CommentWho,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

// #2851: a held target whose D1 request row failed to write is reconciled by
// the nightly sweep, from a note left when the write failed.

const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
const DAY = 86_400_000;

class FakeBus implements NoticeDelivery {
  async deliver(_e: Env, _u: string, _n: BusNotice) {
    return "delivered" as const;
  }
}
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(new FakeBus());
});
afterAll(() => installDelivery(prev));

type U = { userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  return {
    userId: l.userId,
    member: (await getUser(E, l.userId)) as Member,
    email,
  };
}
let owner: U;
let editor: U;
beforeAll(async () => {
  owner = await mk("rc-owner");
  editor = await mk("rc-editor");
});

const view = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
});
const typed = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  typed: true,
});

/** A page, and a held mention of the owner's agent by the editor (rows written as usual). */
async function held() {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  await putShare(E, owner.member, a.id, {
    email: editor.email,
    role: "editor",
  });
  await follow(E, owner.userId, { namespace: "ns-o", name: "Claude" }, a.id);
  const key = (await artifactAgents(E, a.id, editor.userId)).find((x) =>
    x.name.startsWith("Claude"),
  )?.key as string;
  await addThread(
    E,
    { id: a.id, format: "html", currentVersion: 1 } as never,
    typed(editor),
    view(editor),
    { anchor: { kind: "note" }, body: "please look", mentions: [{ key }] },
    { moderator: true },
  );
  return { id: a.id, key };
}
const rowsOf = (id: string) =>
  E.DB.prepare(
    `select r.id as rid, r.created_at as rat, i.comment_id, i.agent_key, i.state, i.expires_at
       from held_requests r left join held_request_items i on i.request_id = r.id
      where r.artifact_id = ?1`,
  )
    .bind(id)
    .all<{
      rid: string;
      rat: number;
      comment_id: string | null;
      agent_key: string | null;
      state: string | null;
      expires_at: number | null;
    }>()
    .then((r) => r.results);
const wipe = (id: string) =>
  E.DB.prepare("delete from held_requests where artifact_id = ?1")
    .bind(id)
    .run();
const note = (id: string, at = Date.now()) =>
  E.DB.prepare(
    "insert into settings (key, value) values (?1, ?2) on conflict (key) do update set value = excluded.value",
  )
    .bind(`${RECONCILE_PREFIX}${id}`, String(at))
    .run();
const noted = async (id: string) =>
  !!(await E.DB.prepare("select 1 as x from settings where key = ?1")
    .bind(`${RECONCILE_PREFIX}${id}`)
    .first());

describe("held reconcile sweep (#2851)", () => {
  it("a failed hold write leaves a note; the sweep writes the missing rows, dated from the comment, and clears the note", async () => {
    const p = await held();
    const before = await rowsOf(p.id);
    expect(before).toHaveLength(1);
    const commentId = before[0]?.comment_id as string;
    // The D1 write failed: no rows, a note instead.
    await wipe(p.id);
    expect(await rowsOf(p.id)).toHaveLength(0);
    expect(
      (await listHeld(E, owner.userId)).requests.some(
        (r) => r.artifact.id === p.id,
      ),
    ).toBe(false);
    await note(p.id);
    expect(await reconcileHeld(E)).toBe(1);
    const after = await rowsOf(p.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      comment_id: commentId,
      agent_key: p.key,
      state: "held",
    });
    // Dated from the comment: the 7 days count from it, not from the sweep.
    expect((after[0]?.expires_at as number) - (after[0]?.rat as number)).toBe(
      7 * DAY,
    );
    expect(Date.now() - (after[0]?.rat as number)).toBeLessThan(60_000);
    // The owner can now see it to allow or decline.
    expect(
      (await listHeld(E, owner.userId)).requests.some(
        (r) => r.artifact.id === p.id,
      ),
    ).toBe(true);
    // The note is gone; another run does nothing.
    expect(await noted(p.id)).toBe(false);
    expect(await reconcileHeld(E)).toBe(0);
  });

  it("a target that already has its row is left alone and the note still clears", async () => {
    const p = await held();
    await note(p.id);
    expect(await reconcileHeld(E)).toBe(0);
    expect(await rowsOf(p.id)).toHaveLength(1);
    expect(await noted(p.id)).toBe(false);
  });

  it("a page with no note is not scanned", async () => {
    const p = await held();
    await wipe(p.id);
    expect(await reconcileHeld(E)).toBe(0);
    expect(await rowsOf(p.id)).toHaveLength(0);
  });

  it("a note older than the 7 days is dropped without writing", async () => {
    const p = await held();
    await wipe(p.id);
    await note(p.id, Date.now() - 8 * DAY);
    expect(await reconcileHeld(E)).toBe(0);
    expect(await rowsOf(p.id)).toHaveLength(0);
    expect(await noted(p.id)).toBe(false);
  });

  it("a target past its 7 days gets no row (it lapses by age alone)", async () => {
    const p = await held();
    await wipe(p.id);
    await note(p.id);
    expect(await reconcileHeld(E, Date.now() + 8 * DAY)).toBe(0);
    expect(await rowsOf(p.id)).toHaveLength(0);
  });

  it("a write that fails again keeps the note for the next night", async () => {
    const p = await held();
    await wipe(p.id);
    await note(p.id);
    const broken = {
      ...E,
      DB: new Proxy(E.DB, {
        get: (t, k) =>
          k === "prepare"
            ? (sql: string) => {
                if (sql.includes("insert into held_requests"))
                  throw new Error("boom");
                return t.prepare(sql);
              }
            : (t as never)[k],
      }),
    } as Env;
    expect(await reconcileHeld(broken)).toBe(0);
    expect(await rowsOf(p.id)).toHaveLength(0);
    expect(await noted(p.id)).toBe(true);
    expect(await reconcileHeld(E)).toBe(1);
    expect(await noted(p.id)).toBe(false);
  });

  it("recordHolds leaves the note when its D1 write fails twice", async () => {
    const p = await held();
    const broken = {
      ...E,
      DB: new Proxy(E.DB, {
        get: (t, k) =>
          k === "prepare"
            ? (sql: string) => {
                if (sql.includes("insert into held_requests"))
                  throw new Error("boom");
                return t.prepare(sql);
              }
            : (t as never)[k],
      }),
    } as Env;
    expect(await noted(p.id)).toBe(false);
    await recordHolds(broken, editor.userId, p.id, "t1", "c-x", [
      {
        agent: {
          key: p.key,
          owner: owner.userId,
          namespace: "ns-o",
          name: "Claude",
        },
        way: "mention",
      },
    ]);
    expect(await noted(p.id)).toBe(true);
  });

  it("is bounded: one run handles at most RECONCILE_PAGES noted pages", async () => {
    const pages: string[] = [];
    for (let i = 0; i < RECONCILE_PAGES + 2; i++) {
      const p = await held();
      await wipe(p.id);
      await note(p.id, Date.now() - (RECONCILE_PAGES + 2 - i) * 1000);
      pages.push(p.id);
    }
    await reconcileHeld(E);
    const left = await Promise.all(pages.map((id) => noted(id)));
    expect(left.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(pages.length - left.filter(Boolean).length).toBeLessThanOrEqual(
      RECONCILE_PAGES,
    );
    await reconcileHeld(E);
    expect(
      (await Promise.all(pages.map((id) => noted(id)))).some(Boolean),
    ).toBe(false);
  });
});
