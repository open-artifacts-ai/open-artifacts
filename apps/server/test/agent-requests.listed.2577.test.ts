import { env } from "cloudflare:workers";
import {
  type AskHistory,
  type BusNotice,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { callerOf } from "../src/auth/authz.js";
import type { Env } from "../src/env.js";
import {
  askHistory,
  lapseHeld,
  listHeld,
  recordListed,
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
import { inboxOf } from "../src/services/inbox.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2577: a request that went straight to a listed sender's receiver is
// remembered (ids and a time) so "Who asked what" can say on_list; it is
// never a held request, an inbox item or something to allow.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const DAY = 86_400_000;

class FakeBus implements NoticeDelivery {
  sent: { userId: string; notice: BusNotice }[] = [];
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    this.sent.push({ userId, notice });
    return "delivered" as const;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => installDelivery(prev));

type U = { userId: string; member: Member; email: string; cookie: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  return {
    userId: l.userId,
    member: (await getUser(E, l.userId)) as Member,
    email,
    cookie: l.cookie,
  };
}
let owner: U;
let editor: U;
beforeAll(async () => {
  owner = await mk("li-owner");
  editor = await mk("li-editor");
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
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;

async function setup() {
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
  const claude = (await artifactAgents(E, a.id, editor.userId)).find((x) =>
    x.name.startsWith("Claude"),
  )?.key as string;
  return { id: a.id, claude };
}
const listEditor = (artifactId: string | null = null) =>
  E.DB.prepare(
    `insert into agent_listens (id, owner_id, member_id, scope, artifact_id, until, created_via, created_at)
     values (?1, ?2, ?3, ?4, ?5, ?6, 'settings', ?7)`,
  )
    .bind(
      newId(),
      owner.userId,
      editor.userId,
      artifactId ? "page" : "all",
      artifactId,
      Date.now() + 30 * DAY,
      Date.now(),
    )
    .run();
const mention = (id: string, key: string) =>
  addThread(
    E,
    art(id),
    typed(editor),
    view(editor),
    { anchor: { kind: "note" }, body: "please look", mentions: [{ key }] },
    { moderator: true },
  );
const listedRows = (id: string) =>
  E.DB.prepare("select * from listed_deliveries where artifact_id = ?1")
    .bind(id)
    .all<{
      receiver_id: string;
      sender_id: string;
      comment_id: string;
      agent_key: string;
      created_at: number;
    }>()
    .then((r) => r.results);

describe("listed deliveries", () => {
  it("a mention from a listed sender is delivered, written once, and reads on_list; never held, in the inbox or allowable", async () => {
    const s = await setup();
    await listEditor(s.id);
    bus.sent = [];
    await mention(s.id, s.claude);
    expect(
      bus.sent.some(
        (x) => x.userId === owner.userId && x.notice.artifactId === s.id,
      ),
    ).toBe(true);
    const rows = await listedRows(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      receiver_id: owner.userId,
      sender_id: editor.userId,
      agent_key: s.claude,
    });
    // Ids and a time only.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "agent_key",
      "artifact_id",
      "comment_id",
      "created_at",
      "id",
      "receiver_id",
      "sender_id",
    ]);
    const h = (await askHistory(E, owner.userId)).rows.filter(
      (r) => r.artifact?.id === s.id,
    );
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({
      outcome: "on_list",
      agent: { key: s.claude },
      asker: { id: editor.userId },
    });
    expect(JSON.stringify(h)).not.toContain("please look");
    // Through the route too.
    const r = (await (
      await api(app, R.agentAskHistory, owner.cookie)
    ).json()) as AskHistory;
    expect(
      r.rows.some((x) => x.artifact?.id === s.id && x.outcome === "on_list"),
    ).toBe(true);
    // Not a held request, not an item to allow, not in the inbox.
    expect(
      (await listHeld(E, owner.userId)).requests.filter(
        (q) => q.artifact.id === s.id,
      ),
    ).toHaveLength(0);
    expect(
      (
        await E.DB.prepare(
          "select count(*) as n from held_requests where artifact_id = ?1",
        )
          .bind(s.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    const inbox = await inboxOf(E, callerOf(owner.member) as never);
    expect(JSON.stringify(inbox ?? {})).not.toContain('"kind":"request"');
  });

  it("a sender who is not on the list is held, not written as listed; the receiver's own comment is not listed", async () => {
    const s = await setup();
    await mention(s.id, s.claude);
    expect(await listedRows(s.id)).toHaveLength(0);
    await recordListed(E, s.id, "c-self", s.claude, owner.userId, owner.userId);
    expect(await listedRows(s.id)).toHaveLength(0);
  });

  it("a write that fails never stops the delivery or throws", async () => {
    const s = await setup();
    await listEditor(s.id);
    const broken = {
      ...E,
      DB: new Proxy(E.DB, {
        get: (t, k) =>
          k === "prepare"
            ? (sql: string) => {
                if (sql.includes("listed_deliveries")) throw new Error("boom");
                return t.prepare(sql);
              }
            : (t as never)[k],
      }),
    } as Env;
    await expect(
      recordListed(broken, s.id, "c1", s.claude, owner.userId, editor.userId),
    ).resolves.toBeUndefined();
    expect(await listedRows(s.id)).toHaveLength(0);
  });

  it("is swept after 30 days and shows only for 30 days", async () => {
    const s = await setup();
    await listEditor(s.id);
    await recordListed(
      E,
      s.id,
      "c-old",
      s.claude,
      owner.userId,
      editor.userId,
      Date.now() - 31 * DAY,
    );
    await recordListed(E, s.id, "c-new", s.claude, owner.userId, editor.userId);
    expect(
      (await askHistory(E, owner.userId)).rows.filter(
        (r) => r.artifact?.id === s.id,
      ),
    ).toHaveLength(1);
    await lapseHeld(E);
    expect((await listedRows(s.id)).map((r) => r.comment_id)).toEqual([
      "c-new",
    ]);
  });
});
