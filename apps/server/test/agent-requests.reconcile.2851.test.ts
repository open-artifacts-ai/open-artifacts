import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type BusNotice, type Member, newId } from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
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
beforeEach(async () => {
  // Each test mentions anew: the per-sender hourly limit is not under test.
  await E.DB.prepare(
    "delete from counters where key like 'notice:mention:%'",
  ).run();
});
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

// The DO's own retry: when even the settings note cannot be written (D1 is
// down), the page's DO retries from its alarm a few minutes later.
const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(E, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      (i as unknown as { env: Env }).env = E;
      return cb(i);
    },
  );
const MIN = 60_000;
const d1Down = {
  ...E,
  DB: new Proxy(E.DB, {
    get: (t, k) =>
      k === "prepare"
        ? (sql: string) => {
            if (sql.includes("held_request") || sql.includes("settings"))
              throw new Error("D1 down");
            return t.prepare(sql);
          }
        : (t as never)[k],
  }),
} as Env;
const hold = (p: { id: string; key: string }) =>
  recordHolds(d1Down, editor.userId, p.id, "t1", "c-x", [
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
/** Fires the page's alarm as if `ms` had passed. */
const fire = (id: string, ms: number) =>
  inDo(id, (i) => {
    const t = Date.now() + ms;
    i.now = () => t;
    return i.alarm();
  });

describe("the DO's own hold retry (#2851)", () => {
  it("D1 down for the row AND the note: the alarm later, with D1 back, writes the row and schedules nothing more", async () => {
    const p = await held();
    await wipe(p.id);
    await hold(p);
    expect(await noted(p.id)).toBe(false);
    expect(await rowsOf(p.id)).toHaveLength(0);
    const job = await inDo(p.id, (i) => i.pendingHeldRetry());
    expect(job).not.toBeNull();
    expect((job?.due as number) - (job?.since as number)).toBe(3 * MIN);
    // Too early: nothing happens.
    await fire(p.id, MIN);
    expect(await rowsOf(p.id)).toHaveLength(0);
    expect(await inDo(p.id, (i) => i.pendingHeldRetry())).not.toBeNull();
    // D1 is back: the alarm writes the row, dated from the comment, and the job is gone.
    await fire(p.id, 4 * MIN);
    const after = await rowsOf(p.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ agent_key: p.key, state: "held" });
    expect(await inDo(p.id, (i) => i.pendingHeldRetry())).toBeNull();
    expect(
      (await listHeld(E, owner.userId)).requests.some(
        (r) => r.artifact.id === p.id,
      ),
    ).toBe(true);
  });

  it("an alarm with nothing to do schedules nothing further", async () => {
    const p = await held();
    await inDo(p.id, (i) => i.commentsHeldRetryArm());
    expect(await inDo(p.id, (i) => i.pendingHeldRetry())).not.toBeNull();
    // The row exists already (the nightly sweep or the first write got there).
    expect(await rowsOf(p.id)).toHaveLength(1);
    const sets = await inDo(p.id, async (i) => {
      const storage = (i as unknown as { ctx: DurableObjectState }).ctx.storage;
      let n = 0;
      const real = storage.setAlarm.bind(storage);
      storage.setAlarm = async (t: number | Date) => {
        n++;
        return real(t);
      };
      const t = Date.now() + 4 * MIN;
      i.now = () => t;
      await i.alarm();
      storage.setAlarm = real;
      return n;
    });
    expect(await inDo(p.id, (i) => i.pendingHeldRetry())).toBeNull();
    expect(sets).toBe(0);
  });

  it("a failed try backs off (3 min, doubling) and gives up after the 7-day window", async () => {
    const p = await held();
    await inDo(p.id, (i) => i.commentsHeldRetryArm());
    const times: number[] = [];
    for (let k = 1; k <= 3; k++) {
      const next = await inDo(p.id, async (i) => {
        i.heldReconciler = async () => ({ complete: false });
        const t = Date.now() + 30 * 60_000 * k;
        i.now = () => t;
        await i.alarm();
        const j = i.pendingHeldRetry();
        return j ? { attempts: j.attempts, wait: j.due - t } : null;
      });
      times.push(next?.wait as number);
      expect(next?.attempts).toBe(k);
    }
    expect(times).toEqual([6 * MIN, 12 * MIN, 24 * MIN]);
    await inDo(p.id, async (i) => {
      i.heldReconciler = async () => ({ complete: false });
      const t = Date.now() + 8 * 86_400_000;
      i.now = () => t;
      await i.alarm();
    });
    expect(await inDo(p.id, (i) => i.pendingHeldRetry())).toBeNull();
  });
});

describe("paging past 200 held targets (#2851)", () => {
  // 201 held targets in one page's DO and no D1 rows. The caps (50 per sender
  // and receiver, 200 per receiver) never bite: 3 receivers x 3 senders.
  const TOTAL = 201;
  let people: { owners: U[]; senders: U[] } | undefined;
  async function seed() {
    people ??= {
      owners: [owner, await mk("rc-o2"), await mk("rc-o3")],
      senders: [editor, await mk("rc-s2"), await mk("rc-s3")],
    };
    const { owners, senders } = people;
    // Earlier tests' held requests would count against the per-person caps.
    await E.DB.prepare("delete from held_requests").run();
    const a = await publish(
      E,
      owner.member,
      { title: "big", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    );
    const base = Date.now() - TOTAL * 1000;
    await inDo(a.id, (i) => {
      const sql = (i as unknown as { sql: SqlStorage }).sql;
      for (let n = 0; n < TOTAL; n++) {
        const o = owners[n % 3] as U;
        const sd = senders[Math.floor(n / 3) % 3] as U;
        const id = `cm${String(n).padStart(4, "0")}`;
        sql.exec(
          "insert into comments (id, thread_id, body, author, created_at) values (?, 't1', 'x', ?, ?)",
          id,
          JSON.stringify({ kind: "user", ref: sd.userId }),
          new Date(base + n * 1000).toISOString(),
        );
        sql.exec(
          `insert into comment_targets (comment_id, thread_id, kind, key, name, state, owner, identity)
           values (?, 't1', 'held', ?, 'mention', 'held', ?, ?)`,
          id,
          `agent:k${n}`,
          o.userId,
          JSON.stringify({ namespace: "ns", name: "Claude" }),
        );
      }
    });
    return a.id;
  }
  const items = async (id: string) =>
    (
      await E.DB.prepare(
        `select count(*) as n from held_request_items i join held_requests r on r.id = i.request_id where r.artifact_id = ?1`,
      )
        .bind(id)
        .first<{ n: number }>()
    )?.n;

  it("the alarm: two runs write all 201 rows, then the job is deleted", async () => {
    const id = await seed();
    await inDo(id, (i) => i.commentsHeldRetryArm());
    await fire(id, 4 * MIN);
    expect(await items(id)).toBe(200);
    const mid = await inDo(id, (i) => i.pendingHeldRetry());
    expect(mid?.cursor).not.toBeNull();
    expect(mid?.failed).toBe(false);
    await fire(id, 6 * MIN);
    expect(await items(id)).toBe(201);
    expect(await inDo(id, (i) => i.pendingHeldRetry())).toBeNull();
  });

  it("the nightly sweep: two runs write all 201 rows, then the note is gone", async () => {
    const id = await seed();
    // Notes left by earlier tests would share the run's 10 pages.
    await E.DB.prepare(
      `delete from settings where key like '${RECONCILE_PREFIX}%'`,
    ).run();
    await note(id);
    expect(await reconcileHeld(E)).toBe(200);
    expect(await items(id)).toBe(200);
    expect(await noted(id)).toBe(true);
    expect(await reconcileHeld(E)).toBe(1);
    expect(await items(id)).toBe(201);
    expect(await noted(id)).toBe(false);
  });

  it("a failed write in a pass restarts it from the beginning after the backoff", async () => {
    const id = await seed();
    await inDo(id, (i) => i.commentsHeldRetryArm());
    await inDo(id, async (i) => {
      let calls = 0;
      i.heldReconciler = async () => ({ complete: ++calls > 1 });
      const t = Date.now() + 4 * MIN;
      i.now = () => t;
      await i.alarm();
      const t2 = t + 2 * MIN;
      i.now = () => t2;
      await i.alarm();
    });
    // The first page failed: back to the start, backing off, not done.
    const j = await inDo(id, (i) => i.pendingHeldRetry());
    expect(j).toMatchObject({ attempts: 1, cursor: null, failed: false });
  });
});
