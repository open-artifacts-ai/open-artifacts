// #1752: comment notices for one artifact fold while an agent is offline. One
// waiting notice per artifact, agent, kind and tier; the delivered text says
// how many it replaced; the folded comment targets settle with its ack. Real
// hub, real daemon sockets, real runtime DO; notifyAgent builds the notices.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { BUS_CAPS } from "@oa/bus-protocol";
import { type BusNotice, NOTICE_SENDER, newId } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { migrateHub } from "../../src/bus/schema.js";
import { runtimeStub } from "../../src/runtime/do.js";
import {
  notifyAgent,
  type RosterAgent,
} from "../../src/services/comment-agents.js";
import {
  daemon,
  e,
  hubOf,
  machine,
  member,
  ns,
  hello as plainHello,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const ACK = [BUS_CAPS.follow, BUS_CAPS.noticeAck];

async function setup(caps: string[] = ACK) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...plainHello(id("h")), caps } as never);
  await waitFor(d, "hello_ok");
  const namespace = ns("fold");
  const ref = id("ref");
  d.send(up(id("u"), ref, `agent-${++seq}`, namespace));
  const ok = await waitFor(d, "agent_ok");
  d.close();
  await d.closed;
  const hub = await hubOf(m.userId);
  await vi.waitFor(async () =>
    expect(
      await runInDurableObject(
        hub,
        (_i, st) =>
          st.storage.sql
            .exec(
              "select count(*) as n from machines where id = ? and disconnected_at is not null",
              mach.id,
            )
            .one().n,
      ),
    ).toBe(1),
  );
  const to: RosterAgent = {
    key: `agent:${id("k")}`,
    name: ok.bus_name,
    online: false,
    userId: m.userId,
    address: { namespace, name: ok.bus_name },
  } as RosterAgent;
  return { m, mach, hub, to, ref, ok, namespace };
}

type S = Awaited<ReturnType<typeof setup>>;
const rows = (s: S) =>
  runInDurableObject(
    s.hub,
    (_i, st) =>
      st.storage.sql
        .exec("select ckey, fold_n as n from notices order by ckey")
        .toArray() as { ckey: string; n: number }[],
  );

async function seedTarget(art: string, commentId: string, key: string) {
  const ns_ = e.ARTIFACT_RUNTIME;
  await runInDurableObject(
    ns_.get(ns_.idFromName(art)),
    (inst: unknown, st) => {
      (inst as { ensureSchema(): void }).ensureSchema();
      st.storage.sql.exec(
        `insert into comment_targets (comment_id, thread_id, kind, key, name, state)
         values (?, 't1', 'mention', ?, 'a', 'queued')`,
        commentId,
        key,
      );
    },
  );
}
const targetState = (art: string, commentId: string) =>
  runInDurableObject(
    e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(art)),
    (_i, st) =>
      st.storage.sql
        .exec(
          "select state from comment_targets where comment_id = ?",
          commentId,
        )
        .one().state as string,
  );

const send = (s: S, art: string, c: string, fromYourUser = false) =>
  notifyAgent(e, art, 1, "t1", c, "mention", s.to, fromYourUser);

async function comeBack(s: S, caps: string[] = ACK) {
  const d = await daemon(s.mach.token);
  d.send({ ...plainHello(id("h")), caps } as never);
  await waitFor(d, "hello_ok");
  d.send(up(id("u"), s.ref, s.ok.bus_name, s.namespace));
  return d;
}

describe("comment notice folding (#1752)", () => {
  it("folds an artifact's comments into one waiting notice that counts them", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    for (const c of ["c1", "c2", "c3"]) {
      await seedTarget(art, c, s.to.key);
      expect(await send(s, art, c)).toBe("held");
    }
    expect(await rows(s)).toHaveLength(1);
    const d = await comeBack(s);
    const f = await waitFor(d, "deliver");
    expect(f.body).toContain(
      `2 more comments on artifact ${art}. Read them with list_comments.`,
    );
  });

  it("says '1 more comment' for a single fold", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    await send(s, art, "c1");
    await send(s, art, "c2");
    const f = await waitFor(await comeBack(s), "deliver");
    expect(f.body).toContain(
      `\n1 more comment on artifact ${art}. Read them with list_comments.`,
    );
  });

  it("never folds a notice of your user's with someone else's", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    await send(s, art, "c1", true);
    await send(s, art, "c2", false);
    expect(await rows(s)).toHaveLength(2);
    const d = await comeBack(s);
    const a = await waitFor(d, "deliver");
    const b = await waitFor(d, "deliver");
    for (const f of [a, b]) expect(f.body ?? "").not.toContain("more comment");
    expect([a.body, b.body].some((t) => t?.includes("your user"))).toBe(true);
  });

  it("settles every folded target when the folded notice is acked", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    for (const c of ["c1", "c2", "c3"]) {
      await seedTarget(art, c, s.to.key);
      await send(s, art, c);
    }
    const d = await comeBack(s);
    const f = await waitFor(d, "deliver");
    for (const c of ["c1", "c2", "c3"])
      expect(await targetState(art, c)).toBe("queued");
    d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    for (const c of ["c1", "c2", "c3"])
      await vi.waitFor(async () =>
        expect(await targetState(art, c)).toBe("delivered"),
      );
  });

  it("one artifact's comments hold one slot, never the hub's cap", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    for (let i = 0; i < 40; i++) await send(s, art, `c${i}`);
    expect(await rows(s)).toEqual([expect.objectContaining({ n: 39 })]);
  });

  it("refuse settles every folded target gone", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    for (const c of ["c1", "c2", "c3"]) {
      await seedTarget(art, c, s.to.key);
      await send(s, art, c);
    }
    const d = await comeBack(s);
    const f = await waitFor(d, "deliver");
    d.send({
      v: 1,
      id: id("rf"),
      type: "refuse",
      msg_id: f.msg_id,
      reason: "closed",
      detail: "dropped",
    } as never);
    for (const c of ["c1", "c2", "c3"])
      await vi.waitFor(async () =>
        expect(await targetState(art, c)).toBe("gone"),
      );
  });

  it("a live send while an older same-key notice is held folds it in", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    const d = await comeBack(s);
    await waitFor(d, "agent_ok");
    for (const c of ["c1", "c2"]) await seedTarget(art, c, s.to.key);
    const mk = (c: string, notBefore?: number): BusNotice => ({
      id: newId(),
      kind: "comment",
      from: NOTICE_SENDER,
      artifactId: art,
      version: 1,
      url: `https://app.test/a/${art}`,
      to: s.to.address,
      text: "Open Artifacts: someone mentioned you.",
      coalesceKey: `${art}:mention:${s.to.key}:others`,
      threadId: "t1",
      commentId: c,
      target: { kind: "mention", key: s.to.key },
      ...(notBefore ? { notBefore } : {}),
    });
    // c1 waits (not due); c2 is due and goes out live.
    expect(await s.hub.deliverNotice(mk("c1", Date.now() + 3_600_000))).toBe(
      "held",
    );
    expect(await s.hub.deliverNotice(mk("c2"))).toBe("held");
    const f = await waitFor(d, "deliver");
    expect(f.body).toContain(
      `\n1 more comment on artifact ${art}. Read them with list_comments.`,
    );
    expect(await rows(s)).toEqual([]);
    expect(await targetState(art, "c1")).toBe("queued");
    d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    for (const c of ["c1", "c2"])
      await vi.waitFor(async () =>
        expect(await targetState(art, c)).toBe("delivered"),
      );
  });

  it("past 50 folded targets the oldest settle gone, the rest wait for the ack", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    const ids = Array.from({ length: 53 }, (_, i) => `c${i}`);
    for (const c of ids) {
      await seedTarget(art, c, s.to.key);
      await send(s, art, c);
    }
    // 52 folded, 50 kept: the two oldest are gone at once.
    await vi.waitFor(async () => {
      expect(await targetState(art, "c0")).toBe("gone");
      expect(await targetState(art, "c1")).toBe("gone");
    });
    expect(await targetState(art, "c2")).toBe("queued");
    const d = await comeBack(s);
    const f = await waitFor(d, "deliver");
    d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await vi.waitFor(async () =>
      expect(await targetState(art, "c52")).toBe("delivered"),
    );
    expect(await targetState(art, "c2")).toBe("delivered");
    expect(await targetState(art, "c0")).toBe("gone");
  });

  it("an expired folded notice settles all its targets gone", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    for (const c of ["c1", "c2"]) {
      await seedTarget(art, c, s.to.key);
      await send(s, art, c);
    }
    await runInDurableObject(s.hub, (_i, st) =>
      st.storage.sql.exec("update notices set expires_at = 1"),
    );
    await runDurableObjectAlarm(s.hub);
    expect(await rows(s)).toEqual([]);
    for (const c of ["c1", "c2"])
      await vi.waitFor(async () =>
        expect(await targetState(art, c)).toBe("gone"),
      );
  });

  it("a row written before the fold columns (defaults) still flushes", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    await send(s, art, "c1");
    await runInDurableObject(s.hub, (_i, st) =>
      st.storage.sql.exec(
        "update notices set fold_n = 0, fold_ref = null, fold_acks = null",
      ),
    );
    const f = await waitFor(await comeBack(s), "deliver");
    expect(f.body).not.toContain("more comment");
  });

  it("asker and thread_reply notices of the two tiers never share a slot", async () => {
    const s = await setup();
    const art = `art${++seq}`;
    for (const kind of ["asker", "thread_reply"] as const) {
      await notifyAgent(e, art, 1, "t1", "c1", kind, s.to, true);
      await notifyAgent(e, art, 1, "t1", "c2", kind, s.to, false);
    }
    expect(await rows(s)).toHaveLength(4);
  });

  it("a folded held row flushed to a socket without notice_ack settles every target delivered (#2062)", async () => {
    const s = await setup([BUS_CAPS.follow]);
    const art = `art${++seq}`;
    for (const c of ["c1", "c2", "c3"]) {
      await seedTarget(art, c, s.to.key);
      await send(s, art, c);
    }
    await comeBack(s, [BUS_CAPS.follow]);
    for (const c of ["c1", "c2", "c3"])
      await vi.waitFor(async () =>
        expect(await targetState(art, c)).toBe("delivered"),
      );
  });

  it("a late delivered ack moves a gone target to delivered; seen stays seen (#2062)", async () => {
    const art = `art${++seq}`;
    await seedTarget(art, "c1", "k1");
    await seedTarget(art, "c2", "k2");
    const stub = runtimeStub(e, art);
    const settle = (c: string, k: string, state: "delivered" | "gone") =>
      stub.commentsTargetSettle({
        commentId: c,
        kind: "mention",
        key: k,
        state,
      });
    await settle("c1", "k1", "gone");
    expect(await targetState(art, "c1")).toBe("gone");
    await settle("c1", "k1", "delivered");
    expect(await targetState(art, "c1")).toBe("delivered");
    await runInDurableObject(
      e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(art)),
      (_i, st) =>
        st.storage.sql.exec(
          "update comment_targets set state = 'seen' where comment_id = 'c2'",
        ),
    );
    await settle("c2", "k2", "delivered");
    expect(await targetState(art, "c2")).toBe("seen");
  });

  it("migrateHub adds each fold column on its own when only fold_n exists (#2062)", async () => {
    const s = await setup();
    await runInDurableObject(s.hub, (_i, st) => {
      st.storage.sql.exec("alter table notices drop column fold_ref");
      st.storage.sql.exec("alter table notices drop column fold_acks");
      migrateHub(st.storage.sql);
      const cols = st.storage.sql
        .exec<{ name: string }>("select name from pragma_table_info('notices')")
        .toArray()
        .map((r) => r.name);
      expect(cols).toEqual(
        expect.arrayContaining(["fold_n", "fold_ref", "fold_acks"]),
      );
    });
  });
});
