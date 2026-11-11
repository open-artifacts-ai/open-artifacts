// #1752 hub half: a notice sent to a notice_ack socket reads held (queued)
// until the daemon's ack, then the comment target becomes delivered; a refuse
// makes it gone. Real hub, real daemon sockets, real runtime DO for the
// target row. Waits are signals (a roster round trip, a state poll).

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { BUS_CAPS } from "@oa/bus-protocol";
import { type BusNotice, NOTICE_SENDER, newId } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { SWEEP_BATCH } from "../../src/bus/hub.js";
import { setTargetState } from "../../src/runtime/comments-store.js";
import * as runtimeMod from "../../src/runtime/do.js";
import { runtimeStub } from "../../src/runtime/do.js";
import {
  type Daemon,
  daemon,
  e,
  framesSeen,
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
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

async function setup(caps: string[]) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...plainHello(id("h")), caps } as never);
  await waitFor(d, "hello_ok");
  const namespace = ns("ack");
  const ref = id("ref");
  d.send(up(id("u"), ref, uniq("agent"), namespace));
  const ok = await waitFor(d, "agent_ok");
  return { d, ref, userId: m.userId, namespace, name: ok.bus_name };
}

/** A runtime DO with one comment target row, state queued. */
async function seedTarget(artifactId: string, commentId: string, key: string) {
  const ns_ = e.ARTIFACT_RUNTIME;
  await runInDurableObject(
    ns_.get(ns_.idFromName(artifactId)),
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
const targetState = (artifactId: string, commentId: string) =>
  runInDurableObject(
    e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(artifactId)),
    (_i, st) =>
      st.storage.sql
        .exec(
          "select state from comment_targets where comment_id = ?",
          commentId,
        )
        .one().state as string,
  );
const setState = (artifactId: string, commentId: string, state: string) =>
  runInDurableObject(
    e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(artifactId)),
    (_i, st) =>
      void st.storage.sql.exec(
        "update comment_targets set state = ? where comment_id = ?",
        state,
        commentId,
      ),
  );

const note = (
  to: { namespace: string; name: string },
  artifactId: string,
  commentId: string,
  key: string,
): BusNotice => ({
  id: newId(),
  kind: "comment",
  from: NOTICE_SENDER,
  artifactId,
  version: 1,
  url: `https://app.test/a/${artifactId}`,
  to,
  text: "Open Artifacts: someone mentioned you.",
  coalesceKey: `${artifactId}:${commentId}:mention`,
  threadId: "t1",
  commentId,
  target: { kind: "mention", key },
});

async function settled(d: Daemon, from: string): Promise<void> {
  const fid = id("l");
  d.send({ v: 1, id: fid, type: "list", from_ref: from });
  for (;;) {
    const f = await d.next();
    if (f.type === "roster" && f.id === fid) return;
  }
}

const addr = (s: { namespace: string; name: string }) => ({
  namespace: s.namespace,
  name: s.name,
});
const ACK = [BUS_CAPS.follow, BUS_CAPS.noticeAck];

describe("notice_ack (#1752)", () => {
  it("queued on send, delivered on the daemon's ack", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    const out = await (await hubOf(s.userId)).deliverNotice(
      note(addr(s), art, "c1", "k1"),
    );
    expect(out).toBe("held");
    const f = await waitFor(s.d, "deliver");
    expect(await targetState(art, "c1")).toBe("queued");
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("delivered"),
    );
    // A duplicate ack changes nothing and draws no error.
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await settled(s.d, s.ref);
    expect(framesSeen(s.d).filter((x) => x.type === "error")).toEqual([]);
  });

  it("gone on refuse", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    await (await hubOf(s.userId)).deliverNotice(note(addr(s), art, "c1", "k1"));
    const f = await waitFor(s.d, "deliver");
    s.d.send({
      v: 1,
      id: id("rf"),
      type: "refuse",
      msg_id: f.msg_id,
      reason: "closed",
      detail: "dropped",
    } as never);
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("gone"),
    );
  });

  it("an ack never upgrades a target already seen", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    await (await hubOf(s.userId)).deliverNotice(note(addr(s), art, "c1", "k1"));
    const f = await waitFor(s.d, "deliver");
    await setState(art, "c1", "seen");
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await settled(s.d, s.ref);
    // The hub's callback runs after the frame; a no-op transition leaves seen.
    await runtimeStub(e, art).commentsTargetSettle({
      commentId: "c1",
      kind: "mention",
      key: "k1",
      state: "delivered",
    });
    expect(await targetState(art, "c1")).toBe("seen");
  });

  it("an ack from another machine is ignored", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    await (await hubOf(s.userId)).deliverNotice(note(addr(s), art, "c1", "k1"));
    const f = await waitFor(s.d, "deliver");
    // A second machine of the same member.
    const mach2 = await machine("Other", s.userId);
    const d2 = await daemon(mach2.token);
    d2.send({ ...plainHello(id("h")), caps: ACK } as never);
    await waitFor(d2, "hello_ok");
    const ref2 = id("ref");
    d2.send(up(id("u"), ref2, uniq("other"), s.namespace));
    await waitFor(d2, "agent_ok");
    d2.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await settled(d2, ref2);
    expect(await targetState(art, "c1")).toBe("queued");
    // The real machine can still settle it.
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("delivered"),
    );
  });

  it("a socket without the cap keeps today's rule: delivered at once", async () => {
    const s = await setup([BUS_CAPS.follow]);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    const out = await (await hubOf(s.userId)).deliverNotice(
      note(addr(s), art, "c1", "k1"),
    );
    expect(out).toBe("delivered");
    const f = await waitFor(s.d, "deliver");
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await settled(s.d, s.ref);
    expect(await targetState(art, "c1")).toBe("delivered");
  });

  it("a parked notice flushed on agent_up to a notice_ack socket settles on ack", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    const hub = await hubOf(s.userId);
    // Held for later: notBefore in the future parks nothing sent, row kept with its target.
    const n = note(addr(s), art, "c1", "k1");
    n.notBefore = Date.now() + 3_600_000;
    expect(await hub.deliverNotice(n)).toBe("held");
    await runInDurableObject(hub, (_i, st) =>
      st.storage.sql.exec("update notices set not_before = 0, parked = 1"),
    );
    s.d.send(up(id("u"), s.ref, s.name, s.namespace));
    const f = await waitFor(s.d, "deliver");
    expect(await targetState(art, "c1")).toBe("queued");
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("delivered"),
    );
  });

  it("a Worker write of gone or queued never undoes an ack that landed first", async () => {
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    await setState(art, "c1", "delivered");
    const write = (state: string) =>
      runInDurableObject(
        e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(art)),
        (_i, st) =>
          setTargetState(st.storage.sql, "c1", "mention", "k1", state),
      );
    await write("gone");
    expect(await targetState(art, "c1")).toBe("delivered");
    await write("queued");
    expect(await targetState(art, "c1")).toBe("delivered");
  });

  it("a failed settle call is retried", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    await (await hubOf(s.userId)).deliverNotice(note(addr(s), art, "c1", "k1"));
    const f = await waitFor(s.d, "deliver");
    const real = runtimeMod.runtimeStub;
    let calls = 0;
    const spy = vi
      .spyOn(runtimeMod, "runtimeStub")
      .mockImplementation((env, id2) => {
        const stub = real(env, id2);
        if (++calls > 1) return stub;
        return {
          commentsTargetSettle: () => Promise.reject(new Error("rpc down")),
        } as never;
      });
    try {
      s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: f.msg_id });
      await vi.waitFor(async () =>
        expect(await targetState(art, "c1")).toBe("delivered"),
      );
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("a refused asker notice gives the asker bound back", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    const ns_ = e.ARTIFACT_RUNTIME;
    const at = "2026-01-01T00:00:00.000Z";
    await runInDurableObject(
      ns_.get(ns_.idFromName(art)),
      (inst: unknown, st) => {
        (inst as { ensureSchema(): void }).ensureSchema();
        st.storage.sql.exec(
          "insert into comments (id, thread_id, body, author, created_at) values ('c1', 't1', 'b', 'a', ?)",
          at,
        );
        st.storage.sql.exec(
          `insert into comment_targets (comment_id, thread_id, kind, key, name, state)
           values ('c1', 't1', 'asker', 'k1', 'a', 'queued')`,
        );
        st.storage.sql.exec(
          "insert into comment_asker_notices (thread_id, last_at, prev_at, n) values ('t1', ?, null, 1)",
          at,
        );
      },
    );
    const n = note(addr(s), art, "c1", "k1");
    n.target = { kind: "asker", key: "k1" };
    await (await hubOf(s.userId)).deliverNotice(n);
    const f = await waitFor(s.d, "deliver");
    s.d.send({
      v: 1,
      id: id("rf"),
      type: "refuse",
      msg_id: f.msg_id,
      reason: "closed",
      detail: "dropped",
    } as never);
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("gone"),
    );
    const n0 = await runInDurableObject(
      ns_.get(ns_.idFromName(art)),
      (_i, st) =>
        st.storage.sql
          .exec("select n from comment_asker_notices where thread_id = 't1'")
          .one().n as number,
    );
    expect(n0).toBe(0);
  });

  it("a refused asker notice does not refund while another target is still queued", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    const ns_ = e.ARTIFACT_RUNTIME;
    const at = "2026-01-01T00:00:00.000Z";
    await runInDurableObject(
      ns_.get(ns_.idFromName(art)),
      (inst: unknown, st) => {
        (inst as { ensureSchema(): void }).ensureSchema();
        st.storage.sql.exec(
          "insert into comments (id, thread_id, body, author, created_at) values ('c1', 't1', 'b', 'a', ?)",
          at,
        );
        st.storage.sql.exec(
          `insert into comment_targets (comment_id, thread_id, kind, key, name, state)
           values ('c1', 't1', 'asker', 'k1', 'a', 'queued'), ('c1', 't1', 'mention', 'k2', 'b', 'queued')`,
        );
        st.storage.sql.exec(
          "insert into comment_asker_notices (thread_id, last_at, prev_at, n) values ('t1', ?, null, 1)",
          at,
        );
      },
    );
    const n = note(addr(s), art, "c1", "k1");
    n.target = { kind: "asker", key: "k1" };
    await (await hubOf(s.userId)).deliverNotice(n);
    const f = await waitFor(s.d, "deliver");
    s.d.send({
      v: 1,
      id: id("rf"),
      type: "refuse",
      msg_id: f.msg_id,
      reason: "closed",
      detail: "dropped",
    } as never);
    await vi.waitFor(async () =>
      expect(
        await runInDurableObject(
          ns_.get(ns_.idFromName(art)),
          (_i, st) =>
            st.storage.sql
              .exec("select state from comment_targets where key = 'k1'")
              .one().state as string,
        ),
      ).toBe("gone"),
    );
    const n0 = await runInDurableObject(
      ns_.get(ns_.idFromName(art)),
      (_i, st) =>
        st.storage.sql
          .exec("select n from comment_asker_notices where thread_id = 't1'")
          .one().n as number,
    );
    expect(n0).toBe(1);
  });

  it("write precedence: gone replaces queued and gone; delivered never replaces seen", async () => {
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    const write = (state: string) =>
      runInDurableObject(
        e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(art)),
        (_i, st) =>
          setTargetState(st.storage.sql, "c1", "mention", "k1", state),
      );
    await write("gone");
    expect(await targetState(art, "c1")).toBe("gone");
    await write("gone");
    expect(await targetState(art, "c1")).toBe("gone");
    await setState(art, "c1", "seen");
    await write("delivered");
    expect(await targetState(art, "c1")).toBe("seen");
    await write("gone");
    expect(await targetState(art, "c1")).toBe("seen");
  });

  const askRow = async (art: string) => {
    const at = "2026-01-01T00:00:00.000Z";
    await runInDurableObject(
      e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(art)),
      (inst: unknown, st) => {
        (inst as { ensureSchema(): void }).ensureSchema();
        st.storage.sql.exec(
          "insert into comments (id, thread_id, body, author, created_at) values ('c1', 't1', 'b', 'a', ?)",
          at,
        );
        st.storage.sql.exec(
          `insert into comment_targets (comment_id, thread_id, kind, key, name, state)
           values ('c1', 't1', 'asker', 'k1', 'a', 'queued')`,
        );
        st.storage.sql.exec(
          "insert into comment_asker_notices (thread_id, last_at, prev_at, n) values ('t1', ?, null, 1)",
          at,
        );
      },
    );
  };
  const askerN = (art: string) =>
    runInDurableObject(
      e.ARTIFACT_RUNTIME.get(e.ARTIFACT_RUNTIME.idFromName(art)),
      (_i, st) =>
        st.storage.sql
          .exec("select n from comment_asker_notices where thread_id = 't1'")
          .one().n as number,
    );
  const expireAcks = async (s: { userId: string }) => {
    const hub = await hubOf(s.userId);
    await runInDurableObject(hub, (_i, st) =>
      st.storage.sql.exec("update notice_acks set expires_at = 1"),
    );
    await runDurableObjectAlarm(hub);
  };

  it("an ack that never came settles its target gone past the TTL, and refunds the asker (#2082)", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await askRow(art);
    const n = note(addr(s), art, "c1", "k1");
    n.target = { kind: "asker", key: "k1" };
    await (await hubOf(s.userId)).deliverNotice(n);
    await waitFor(s.d, "deliver");
    expect(await targetState(art, "c1")).toBe("queued");
    await expireAcks(s);
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("gone"),
    );
    expect(await askerN(art)).toBe(0);
  });

  it("past the TTL a folded target settles gone with the notice's own (#2082)", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    await seedTarget(art, "c2", "k2");
    const hub = await hubOf(s.userId);
    await hub.deliverNotice(note(addr(s), art, "c1", "k1"));
    await waitFor(s.d, "deliver");
    const t = (c: string, k: string) => ({ a: art, c, k: "mention", key: k });
    await runInDurableObject(hub, (_i, st) =>
      st.storage.sql.exec(
        "update notice_acks set ack = ?, expires_at = 1",
        JSON.stringify({ ...t("c1", "k1"), more: [t("c2", "k2")] }),
      ),
    );
    await runDurableObjectAlarm(hub);
    for (const c of ["c1", "c2"])
      await vi.waitFor(async () =>
        expect(await targetState(art, c)).toBe("gone"),
      );
  });

  it("the sweep settles only expired rows: an acked one stays delivered, a pending one stays queued (#2082)", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    for (const c of ["c1", "c2", "c3"]) await seedTarget(art, c, `k${c}`);
    const hub = await hubOf(s.userId);
    const sent: Record<string, string> = {};
    for (const c of ["c1", "c2", "c3"]) {
      await hub.deliverNotice(note(addr(s), art, c, `k${c}`));
      sent[c] = (await waitFor(s.d, "deliver")).msg_id as string;
    }
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: sent.c1 });
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("delivered"),
    );
    // Only c2's row is past its TTL; c3 is still pending.
    await runInDurableObject(hub, (_i, st) =>
      st.storage.sql.exec(
        "update notice_acks set expires_at = 1 where msg_id = ?",
        sent.c2,
      ),
    );
    await runDurableObjectAlarm(hub);
    await vi.waitFor(async () =>
      expect(await targetState(art, "c2")).toBe("gone"),
    );
    expect(await targetState(art, "c1")).toBe("delivered");
    expect(await targetState(art, "c3")).toBe("queued");
  });

  it("more than a batch of expired ack rows: the alarm re-arms and every one settles gone (#2082)", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    const hub = await hubOf(s.userId);
    const N = SWEEP_BATCH + 10;
    for (let i = 0; i < N; i++) await seedTarget(art, `c${i}`, `k${i}`);
    await seedTarget(art, "live", "klive");
    // A real send arms the hub's alarm; then N expired rows sit beside it.
    await hub.deliverNotice(note(addr(s), art, "live", "klive"));
    await waitFor(s.d, "deliver");
    await runInDurableObject(hub, (_i, st) => {
      for (let i = 0; i < N; i++)
        st.storage.sql.exec(
          "insert into notice_acks (msg_id, machine_id, ack, expires_at) values (?, 'x', ?, 1)",
          `exp${i}`,
          JSON.stringify({ a: art, c: `c${i}`, k: "mention", key: `k${i}` }),
        );
    });
    const left = () =>
      runInDurableObject(
        hub,
        (_i, st) =>
          st.storage.sql
            .exec("select count(*) as n from notice_acks where expires_at = 1")
            .one().n as number,
      );
    await runDurableObjectAlarm(hub);
    expect(await left()).toBe(10);
    // The hub set its alarm again for the rest: it fires on its own.
    await vi.waitFor(async () => expect(await left()).toBe(0));
    for (const i of [0, SWEEP_BATCH - 1, SWEEP_BATCH, N - 1])
      await vi.waitFor(async () =>
        expect(await targetState(art, `c${i}`)).toBe("gone"),
      );
  });

  it("evicting the oldest ack row at the cap settles its targets gone (#2082)", async () => {
    const s = await setup(ACK);
    const art = uniq("art");
    await seedTarget(art, "c1", "k1");
    const hub = await hubOf(s.userId);
    await runInDurableObject(hub, (_i, st) => {
      const sql = st.storage.sql;
      sql.exec(
        "insert into notice_acks (msg_id, machine_id, ack, expires_at) values ('old0', 'x', ?, ?)",
        JSON.stringify({ a: art, c: "c1", k: "mention", key: "k1" }),
        Date.now() + 3_600_000,
      );
      for (let i = 1; i < 2000; i++)
        sql.exec(
          "insert into notice_acks (msg_id, machine_id, ack, expires_at) values (?, 'x', 'null', ?)",
          `old${i}`,
          Date.now() + 3_600_000,
        );
    });
    await seedTarget(art, "c2", "k2");
    await hub.deliverNotice(note(addr(s), art, "c2", "k2"));
    await waitFor(s.d, "deliver");
    await vi.waitFor(async () =>
      expect(await targetState(art, "c1")).toBe("gone"),
    );
  });
});
