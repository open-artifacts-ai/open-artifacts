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
import {
  setThreadAgent,
  withdrawHeldTimeout,
} from "../src/services/comments.js";
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
    const down = {
      ...E,
      BUS_HUB: {
        idFromName: () => ({}),
        get: () =>
          new Proxy(
            {},
            {
              get: () => () => {
                throw new Error("hub down");
              },
            },
          ),
      },
    } as unknown as Env;
    await setThreadAgent(
      down,
      s.id,
      t.id,
      s.claude,
      { userId: owner.userId, short: null, owner: true },
      true,
    );
    const th = await read(s.id);
    expect(th?.agents).toBeUndefined();
    expect(th?.comments[0]?.mentions?.[0]?.delivery).toBe("queued");
  });

  it("with an execution context the withdrawal runs after the call returns", async () => {
    const { s, t } = await (async () => {
      const s = await setup();
      const t = (await (
        await post(s.id, editor, { mentions: [{ key: s.claude }] })
      ).json()) as Thread;
      return { s, t };
    })();
    const later: Promise<unknown>[] = [];
    await setThreadAgent(
      E,
      s.id,
      t.id,
      s.claude,
      { userId: owner.userId, short: null, owner: true },
      true,
      { waitUntil: (p) => void later.push(p) },
    );
    expect(later).toHaveLength(1);
    await Promise.all(later);
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

describe("removing an agent: its asks and one retry (#2240)", () => {
  const seedAsk = (
    id: string,
    threadId: string,
    commentId: string,
    agentName: string,
    opts: { identityId?: string | null; ref?: string } = {},
  ) =>
    rt(id)((_i, st) => {
      const identityId =
        opts.identityId === undefined ? `idn-${agentName}` : opts.identityId;
      const author = JSON.stringify({
        kind: "user",
        ref: opts.ref ?? owner.userId,
        agent: {
          name: agentName,
          via: null,
          ...(identityId
            ? { identity: { identityId, name: agentName, kind: "x" } }
            : {}),
        },
      });
      st.storage.sql.exec(
        "insert into comments (id, thread_id, body, author, created_at) values (?, ?, 'q', ?, '2026-01-01T00:00:00Z')",
        commentId,
        threadId,
        author,
      );
      st.storage.sql.exec(
        "insert into comment_asks (comment_id, thread_id, question, options, addressees) values (?, ?, 'q', '[]', '[]')",
        commentId,
        threadId,
      );
    });
  /** Gives the thread's participant a linked bus identity. */
  const linkParticipant = (id: string, key: string, identityId: string) =>
    rt(id)((_i, st) =>
      st.storage.sql.exec(
        "update comment_participants set identity = ? where key = ?",
        JSON.stringify({ identityId, kind: "x" }),
        key,
      ),
    );
  async function holdAnswered(artifactId: string, commentId: string) {
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
         values ('ns-owner', 'claude', ?, ?, 'hi', 0, ?, 1, NULL)`,
        `${artifactId}:${commentId}:answered`,
        `n-ans-${commentId}`,
        Date.now() + 3_600_000,
      );
    });
    return hub;
  }
  const answeredRows = (
    hub: Awaited<ReturnType<typeof hubOf>>,
    artifactId: string,
    commentId: string,
  ) =>
    runInDurableObject(
      hub,
      (_i, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from notices where ckey = ?",
            `${artifactId}:${commentId}:answered`,
          )
          .toArray()[0]?.n ?? 0,
    );
  const threadOnly = async () => {
    const s = await setup();
    bus.outcome = "held";
    const t = (await (
      await post(s.id, editor, { mentions: [{ key: s.claude }] })
    ).json()) as Thread;
    return { s, t };
  };

  it("removing the agent withdraws the answered notice of its own ask", async () => {
    const { s, t } = await threadOnly();
    await seedAsk(s.id, t.id, "ask-mine", "Claude");
    const hub = await holdAnswered(s.id, "ask-mine");
    expect(await answeredRows(hub, s.id, "ask-mine")).toBe(1);
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    expect(await answeredRows(hub, s.id, "ask-mine")).toBe(0);
  });

  it("with a linked identity, a same-name ask by a different identity stays; the same identity goes", async () => {
    const { s, t } = await threadOnly();
    await linkParticipant(s.id, s.claude, "idn-A");
    await seedAsk(s.id, t.id, "ask-a", "Claude", { identityId: "idn-A" });
    await seedAsk(s.id, t.id, "ask-b", "Claude", { identityId: "idn-B" });
    const hub = await holdAnswered(s.id, "ask-a");
    await holdAnswered(s.id, "ask-b");
    await stop(s.id, t.id, s.claude, owner);
    expect(await answeredRows(hub, s.id, "ask-a")).toBe(0);
    expect(await answeredRows(hub, s.id, "ask-b")).toBe(1);
  });

  it("an ask by another member's agent with the same name stays", async () => {
    const { s, t } = await threadOnly();
    await seedAsk(s.id, t.id, "ask-other-member", "Claude", {
      ref: editor.userId,
    });
    const hub = await holdAnswered(s.id, "ask-other-member");
    await stop(s.id, t.id, s.claude, owner);
    expect(await answeredRows(hub, s.id, "ask-other-member")).toBe(1);
  });

  it("an unlinked asker matches by name, ignoring case", async () => {
    const { s, t } = await threadOnly();
    await seedAsk(s.id, t.id, "ask-unlinked", "CLAUDE", { identityId: null });
    const hub = await holdAnswered(s.id, "ask-unlinked");
    await stop(s.id, t.id, s.claude, owner);
    expect(await answeredRows(hub, s.id, "ask-unlinked")).toBe(0);
  });

  it("a failed read of the asks still withdraws the held mention", async () => {
    const { s, t } = await threadOnly();
    const root = t.comments[0] as Comment;
    const hub = await hold("mention", s.claude, s.id, root.id);
    const ns = E.ARTIFACT_RUNTIME as unknown as DurableObjectNamespace;
    const broken = {
      idFromName: (n: string) => ns.idFromName(n),
      get: (id: DurableObjectId) =>
        new Proxy(ns.get(id) as unknown as Record<string, unknown>, {
          get: (tg, k) =>
            k === "commentsAskAuthors"
              ? () => {
                  throw new Error("read failed");
                }
              : tg[k as string],
        }),
    };
    await setThreadAgent(
      { ...E, ARTIFACT_RUNTIME: broken } as unknown as Env,
      s.id,
      t.id,
      s.claude,
      { userId: owner.userId, short: null, owner: true },
      true,
    );
    expect(await heldRows(hub, root.id)).toBe(0);
  });

  it("an ask by another agent keeps its answered notice", async () => {
    const { s, t } = await threadOnly();
    await seedAsk(s.id, t.id, "ask-theirs", "Other");
    const hub = await holdAnswered(s.id, "ask-theirs");
    expect((await stop(s.id, t.id, s.claude, owner)).status).toBe(204);
    expect(await answeredRows(hub, s.id, "ask-theirs")).toBe(1);
  });

  /** An env whose hub loses the reply of the first withdrawHeld (after it ran), via `lose`. */
  const flaky = (lose: () => Promise<never> | never, failRetry = false) => {
    let calls = 0;
    const ns = E.BUS_HUB as unknown as DurableObjectNamespace;
    const wrapped = {
      idFromName: (n: string) => ns.idFromName(n),
      get: (id: DurableObjectId) => {
        const real = ns.get(id) as unknown as Record<string, unknown>;
        return new Proxy(real, {
          get: (tg, k) =>
            k === "withdrawHeld"
              ? async (a: unknown) => {
                  calls++;
                  const run = (x: unknown) =>
                    (real.withdrawHeld as (x: unknown) => Promise<unknown>)(x);
                  if (calls === 1) {
                    await run(a);
                    return lose();
                  }
                  if (failRetry) throw new Error("still down");
                  return run(a);
                }
              : tg[k as string],
        });
      },
    };
    return {
      e2: { ...E, BUS_HUB: wrapped } as unknown as Env,
      calls: () => calls,
    };
  };
  const removeVia = (e2: Env, s: { id: string; claude: string }, t: Thread) =>
    setThreadAgent(
      e2,
      s.id,
      t.id,
      s.claude,
      { userId: owner.userId, short: null, capped: false, owner: true },
      true,
    );
  const seedAsker = async (
    s: { id: string; claude: string },
    t: Thread,
    rootId: string,
  ) => {
    await hold("mention", s.claude, s.id, rootId);
    await seedTarget(s.id, rootId, t.id, "asker", s.claude, "queued");
    await rt(s.id)((_i, st) =>
      st.storage.sql.exec(
        "insert into comment_asker_notices (thread_id, last_at, prev_at, n) select ?, created_at, null, 1 from comments where id = ?",
        t.id,
        rootId,
      ),
    );
  };
  const spent = (id: string, tid: string) =>
    rt(id)(
      (_i, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select n from comment_asker_notices where thread_id = ?",
            tid,
          )
          .toArray()[0]?.n,
    );
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

  it("a lost reply is retried once: marked withdrawn once, refunded once", async () => {
    const { s, t } = await threadOnly();
    const root = t.comments[0] as Comment;
    await seedAsker(s, t, root.id);
    await hold("asker", s.claude, s.id, root.id);
    const f = flaky(() => {
      throw new Error("reply lost");
    });
    await removeVia(f.e2, s, t);
    expect(f.calls()).toBe(2);
    const state = await rt(s.id)(
      (_i, st) =>
        st.storage.sql
          .exec<{ state: string }>(
            "select state from comment_targets where comment_id = ? and kind = 'asker'",
            root.id,
          )
          .toArray()[0]?.state,
    );
    expect(state).toBe("withdrawn");
    expect(await spent(s.id, t.id)).toBe(0);
  });

  it("a hung first call times out and is retried", async () => {
    withdrawHeldTimeout.ms = 50;
    try {
      const { s, t } = await threadOnly();
      const root = t.comments[0] as Comment;
      await seedAsker(s, t, root.id);
      await hold("asker", s.claude, s.id, root.id);
      const f = flaky(() => new Promise<never>(() => {}));
      const done = removeVia(f.e2, s, t);
      await done;
      expect(f.calls()).toBe(2);
      expect(await spent(s.id, t.id)).toBe(0);
    } finally {
      withdrawHeldTimeout.ms = 10_000;
    }
  });

  it("both calls failing still removes the agent", async () => {
    const { s, t } = await threadOnly();
    const root = t.comments[0] as Comment;
    await seedAsker(s, t, root.id);
    const f = flaky(() => {
      throw new Error("lost");
    }, true);
    await removeVia(f.e2, s, t);
    expect(f.calls()).toBe(2);
    expect((await read(s.id))?.agents).toBeUndefined();
    expect(await spent(s.id, t.id)).toBe(1);
  });
});
