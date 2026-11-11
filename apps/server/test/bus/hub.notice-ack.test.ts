// #1752 hub half: a notice sent to a notice_ack socket reads held (queued)
// until the daemon's ack, then the comment target becomes delivered; a refuse
// makes it gone. Real hub, real daemon sockets, real runtime DO for the
// target row. Waits are signals (a roster round trip, a state poll).
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS } from "@oa/bus-protocol";
import { type BusNotice, NOTICE_SENDER, newId } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
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
    expect(await targetState(art, "c1")).toBe("queued");
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
});
