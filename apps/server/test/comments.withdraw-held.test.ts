import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type Comment,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { setThreadAgent } from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { getUser } from "../src/services/users.js";
import { hubOf } from "./bus/helpers.js";
import { api, login } from "./helpers.js";

// #2175: removing an agent from a thread withdraws what its hub still holds for it.

vi.mock("../src/services/bus.js", async (orig) => {
  const m = await orig<typeof import("../src/services/bus.js")>();
  return { ...m, busHub: vi.fn(m.busHub) };
});
const busMod = await import("../src/services/bus.js");

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  sent: BusNotice[] = [];
  outcome: DeliveryOutcome = "delivered";
  async deliver(_e: Env, _u: string, notice: BusNotice) {
    if (notice.kind === "commented") return "delivered" as const;
    this.sent.push(notice);
    return this.outcome;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => installDelivery(prev));
beforeEach(() => {
  bus.sent = [];
  bus.outcome = "delivered";
});

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}
let owner: U;
let editor: U;
beforeAll(async () => {
  owner = await mk("wh-owner");
  editor = await mk("wh-editor");
});

async function setup() {
  const a = await publish(
    E,
    owner.member,
    {
      title: "doc",
      format: "html",
      content: "<p>x</p>",
      comments: "everyone",
    } as never,
    null,
    undefined,
    "create",
  );
  await api(app, R.shares(a.id), owner.cookie, {
    method: "PUT",
    body: { email: editor.email, role: "editor" },
  });
  await follow(
    E,
    owner.userId,
    { namespace: "ns-owner", name: "Claude" },
    a.id,
  );
  const list = (await (
    await api(app, R.artifactAgents(a.id), owner.cookie)
  ).json()) as { key: string; name: string }[];
  const claude = list.find((x) => x.name.startsWith("Claude"))?.key as string;
  return { id: a.id, claude };
}

/** The owner's hub holds a notice for Claude with this ack target. */
async function hold(
  kind: string,
  key: string,
  artifactId: string,
  commentId: string,
) {
  const hub = await hubOf(owner.userId);
  await runInDurableObject(hub, (_i, st) => {
    const sql = st.storage.sql;
    sql.exec(
      `insert or ignore into agents (id, org_id, namespace, name, kind, machine_id, native_ref, live, updated_at)
       values (?, 'owner', 'ns-owner', 'Claude', 'x', 'm1', ?, 0, 0)`,
      `ag-${tag}`,
      `ref-${tag}`,
    );
    sql.exec(
      `insert into notices (to_ns, to_lname, ckey, id, text, not_before, expires_at, parked, ack)
       values ('ns-owner', 'claude', ?, ?, 'hi', 0, ?, 1, ?)`,
      `ck-${commentId}-${kind}`,
      `n-${commentId}-${kind}`,
      Date.now() + 3_600_000,
      JSON.stringify({ a: artifactId, c: commentId, k: kind, key }),
    );
  });
  return hub;
}
const heldRows = async (
  hub: Awaited<ReturnType<typeof hubOf>>,
  commentId: string,
) =>
  runInDurableObject(
    hub,
    (_i, st) =>
      st.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from notices where ckey like ?",
          `ck-${commentId}-%`,
        )
        .toArray()[0]?.n ?? 0,
  );
const rt =
  (id: string) =>
  <T>(fn: (i: ArtifactRuntime, st: DurableObjectState) => T | Promise<T>) =>
    runInDurableObject(
      runtimeStub(E, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      fn,
    );
const post = (id: string, u: U, body: object) =>
  api(app, R.comments(id), u.cookie, {
    method: "POST",
    body: { anchor: { kind: "note" }, body: "hello", ...body },
  });
const stop = (id: string, tid: string, key: string, u: U, method = "DELETE") =>
  api(app, R.commentThreadAgent(id, tid, key), u.cookie, { method });
const read = async (id: string) =>
  (
    (await (await api(app, R.comments(id), owner.cookie)).json()) as {
      threads: Thread[];
    }
  ).threads[0];

describe("removing an agent withdraws its held notices (#2175)", () => {
  it("a held mention is withdrawn; Undo does not resend it", async () => {
    const s = await setup();
    bus.outcome = "held";
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    const root = t.comments[0] as Comment;
    expect(root.mentions?.[0]?.delivery).toBe("queued");
    const hub = await hold("mention", s.claude, s.id, root.id);
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    expect((await read(s.id))?.comments[0]?.mentions?.[0]?.delivery).toBe(
      "withdrawn",
    );
    expect(await heldRows(hub, root.id)).toBe(0);
    const sent = bus.sent.length;
    expect((await stop(s.id, t.id, s.claude, owner, "PUT")).status).toBe(204);
    expect(bus.sent).toHaveLength(sent);
    expect((await read(s.id))?.comments[0]?.mentions?.[0]?.delivery).toBe(
      "withdrawn",
    );
  });

  it("an older untargeted thread-reply row is withdrawn by thread, with nothing tracked", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    const hub = await hubOf(owner.userId);
    const ckey = `${s.id}:${t.id}:thread_reply:${s.claude}:others`;
    await runInDurableObject(hub, (_i, st) => {
      const sql = st.storage.sql;
      sql.exec(
        `insert or ignore into agents (id, org_id, namespace, name, kind, machine_id, native_ref, live, updated_at)
         values (?, 'owner', 'ns-owner', 'Claude', 'x', 'm1', ?, 0, 0)`,
        `ag-${tag}`,
        `ref-${tag}`,
      );
      // Sent before #2059: no ack target, so the Worker tracks nothing for it.
      sql.exec(
        `insert into notices (to_ns, to_lname, ckey, id, text, not_before, expires_at, parked, ack)
         values ('ns-owner', 'claude', ?, ?, 'hi', 0, ?, 1, NULL)`,
        ckey,
        `n-legacy-${tag}`,
        Date.now() + 3_600_000,
      );
    });
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    const left = await runInDurableObject(
      hub,
      (_i, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from notices where ckey = ?",
            ckey,
          )
          .toArray()[0]?.n ?? 0,
    );
    expect(left).toBe(0);
  });

  it("a delivered notice stays delivered", async () => {
    const s = await setup();
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    const hub = await hold("mention", s.claude, s.id, "other-comment");
    const other = "other-comment";
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    expect((await read(s.id))?.comments[0]?.mentions?.[0]?.delivery).toBe(
      "delivered",
    );
    expect(await heldRows(hub, other)).toBe(1);
  });

  it("a withdrawn asker notice gives its spend back", async () => {
    const s = await setup();
    bus.outcome = "held";
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    const root = t.comments[0] as Comment;
    const owned = rt(s.id);
    await owned((_i, st) => {
      const sql = st.storage.sql;
      sql.exec(
        "insert into comment_targets (comment_id, thread_id, kind, key, name, state, owner) values (?, ?, 'asker', ?, 'Claude', 'queued', ?)",
        root.id,
        t.id,
        s.claude,
        owner.userId,
      );
      sql.exec(
        "insert into comment_asker_notices (thread_id, last_at, prev_at, n) select ?, created_at, null, 1 from comments where id = ?",
        t.id,
        root.id,
      );
    });
    await hold("mention", s.claude, s.id, root.id);
    await hold("asker", s.claude, s.id, root.id);
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    const n = await owned(
      (_i, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select n from comment_asker_notices where thread_id = ?",
            t.id,
          )
          .toArray()[0]?.n,
    );
    expect(n).toBe(0);
  });

  const seedTarget = (
    id: string,
    commentId: string,
    threadId: string,
    kind: string,
    key: string,
    state: string,
  ) =>
    rt(id)((_i, st) =>
      st.storage.sql.exec(
        "insert or replace into comment_targets (comment_id, thread_id, kind, key, name, state, owner) values (?, ?, ?, ?, 'Claude', ?, ?)",
        commentId,
        threadId,
        kind,
        key,
        state,
        owner.userId,
      ),
    );
  const stateOf = (id: string, commentId: string, kind: string) =>
    rt(id)(
      (_i, st) =>
        st.storage.sql
          .exec<{ state: string }>(
            "select state from comment_targets where comment_id = ? and kind = ?",
            commentId,
            kind,
          )
          .toArray()[0]?.state,
    );
  const threadOf = async (mentionHeld = true) => {
    const s = await setup();
    bus.outcome = mentionHeld ? "held" : "delivered";
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    return { s, t, root: t.comments[0] as Comment };
  };

  it("a target the Worker gave up on (gone) is withdrawn too, with no second refund", async () => {
    const { s, t, root } = await threadOf();
    await seedTarget(s.id, root.id, t.id, "mention", s.claude, "gone");
    await seedTarget(s.id, root.id, t.id, "asker", s.claude, "gone");
    await rt(s.id)((_i, st) =>
      st.storage.sql.exec(
        "insert into comment_asker_notices (thread_id, last_at, prev_at, n) select ?, created_at, null, 1 from comments where id = ?",
        t.id,
        root.id,
      ),
    );
    await hold("mention", s.claude, s.id, root.id);
    await hold("asker", s.claude, s.id, root.id);
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    expect(await stateOf(s.id, root.id, "mention")).toBe("withdrawn");
    expect(await stateOf(s.id, root.id, "asker")).toBe("withdrawn");
    const n = await rt(s.id)(
      (_i, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select n from comment_asker_notices where thread_id = ?",
            t.id,
          )
          .toArray()[0]?.n,
    );
    expect(n).toBe(1);
  });

  it("a delivered or seen target named by the hub stays", async () => {
    const { s, t, root } = await threadOf(false);
    await seedTarget(s.id, root.id, t.id, "asker", s.claude, "seen");
    await rt(s.id)((_i, st) =>
      st.storage.sql.exec(
        "insert into comment_asker_notices (thread_id, last_at, prev_at, n) select ?, created_at, null, 1 from comments where id = ?",
        t.id,
        root.id,
      ),
    );
    await runtimeStub(E, s.id).commentsTargetsWithdraw({
      threadId: t.id,
      key: s.claude,
      targets: [
        { commentId: root.id, kind: "mention" },
        { commentId: root.id, kind: "asker" },
      ],
    });
    expect(await stateOf(s.id, root.id, "mention")).toBe("delivered");
    expect(await stateOf(s.id, root.id, "asker")).toBe("seen");
    const n = await rt(s.id)(
      (_i, st) =>
        st.storage.sql
          .exec<{ n: number }>("select n from comment_asker_notices")
          .toArray()[0]?.n,
    );
    expect(n).toBe(1);
  });

  it("a withdrawn thread reply gives its notice back", async () => {
    const { s, t, root } = await threadOf();
    await seedTarget(s.id, root.id, t.id, "reply", s.claude, "queued");
    await rt(s.id)((_i, st) =>
      st.storage.sql.exec(
        "insert into comment_reply_notices (thread_id, key, last_at, prev_at, n) select ?, ?, created_at, null, 1 from comments where id = ?",
        t.id,
        s.claude,
        root.id,
      ),
    );
    await hold("reply", s.claude, s.id, root.id);
    await stop(s.id, t.id, s.claude, owner);
    expect(await stateOf(s.id, root.id, "reply")).toBe("withdrawn");
    const n = await rt(s.id)(
      (_i, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select n from comment_reply_notices where thread_id = ?",
            t.id,
          )
          .toArray()[0]?.n,
    );
    expect(n).toBe(0);
  });

  it("only the removed agent's targets are marked, whatever the hub names", async () => {
    const { s, t, root } = await threadOf();
    await hold("mention", "agent:someone-else", s.id, root.id);
    await stop(s.id, t.id, s.claude, owner);
    expect(await stateOf(s.id, root.id, "mention")).toBe("queued");
  });

  it("a hub failure still removes the agent", async () => {
    const s = await setup();
    bus.outcome = "held";
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    vi.mocked(busMod.busHub).mockImplementationOnce(() => {
      throw new Error("hub down");
    });
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    const th = await read(s.id);
    // No active agent is left; the removed one stays listed, marked (#2174).
    expect(th?.agents?.filter((a) => !a.removed) ?? []).toEqual([]);
    expect(th?.agents?.find((a) => a.key === s.claude)?.removed).toBe(true);
    expect(th?.comments[0]?.mentions?.[0]?.delivery).toBe("queued");
  });

  it("a member who may not remove it triggers nothing", async () => {
    const s = await setup();
    bus.outcome = "held";
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    const cid = (t.comments[0] as Comment).id;
    const hub = await hold("mention", s.claude, s.id, cid);
    await expect(
      setThreadAgent(
        E,
        s.id,
        t.id,
        s.claude,
        { userId: editor.userId, short: null, capped: true },
        true,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await heldRows(hub, cid)).toBe(1);
    expect((await read(s.id))?.comments[0]?.mentions?.[0]?.delivery).toBe(
      "queued",
    );
  });
});
