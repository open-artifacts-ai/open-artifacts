// #2768: a server notice carries structured fields (userId, until, ids) to the
// daemon as `deliver.meta`, never in the text. Only a socket whose hello listed
// BUS_CAPS.noticeMeta gets it; held and flushed notices keep it; a newer
// coalesced notice's meta wins; a malformed stored meta is no meta. Real hub,
// real daemon sockets; waits are signals.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS } from "@oa/bus-protocol";
import { type BusNotice, NOTICE_SENDER, newId } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import {
  daemon,
  hubOf,
  machine,
  member,
  ns,
  hello as plainHello,
  up,
  waitFor,
} from "./helpers.js";
import { eventually } from "./helpers.ts";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const WITH = [BUS_CAPS.follow, BUS_CAPS.noticeMeta];
const WITHOUT = [BUS_CAPS.follow];
const UNTIL = "2026-11-20T09:00:00.000Z";

async function setup(online: boolean, caps: string[]) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...plainHello(id("h")), caps } as never);
  const hok = await waitFor(d, "hello_ok");
  const namespace = ns("meta");
  const ref = id("ref");
  d.send(up(id("u"), ref, `agent-${++seq}`, namespace));
  const ok = await waitFor(d, "agent_ok");
  const hub = await hubOf(m.userId);
  if (!online) {
    d.close();
    await d.closed;
    await eventually(async () =>
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
  }
  return {
    d,
    hub,
    mach,
    ref,
    ok,
    namespace,
    hokCaps: (hok.caps ?? []) as string[],
    to: { namespace, name: ok.bus_name },
  };
}
type S = Awaited<ReturnType<typeof setup>>;

const note = (s: S, extra: Partial<BusNotice> = {}): BusNotice => ({
  id: newId(),
  kind: "ask_answered",
  from: NOTICE_SENDER,
  artifactId: "art1",
  version: 1,
  url: "https://app.test/a/art1",
  to: s.to,
  text: "Open Artifacts: an ask was put off.",
  coalesceKey: "art1:later",
  threadId: "t1",
  commentId: "c1",
  userId: "u_1",
  until: UNTIL,
  ...extra,
});

async function comeBack(s: S, caps: string[]) {
  const d = await daemon(s.mach.token);
  d.send({ ...plainHello(id("h")), caps } as never);
  await waitFor(d, "hello_ok");
  d.send(up(id("u"), s.ref, s.ok.bus_name, s.namespace));
  return d;
}

describe("notice meta (#2768)", () => {
  it("the hub lists the cap in hello_ok", async () => {
    expect((await setup(true, WITH)).hokCaps).toContain(BUS_CAPS.noticeMeta);
  });

  it("a live notice carries its fields as meta, and the text stays the text", async () => {
    const s = await setup(true, WITH);
    expect(await s.hub.deliverNotice(note(s))).toBe("delivered");
    const f = await waitFor(s.d, "deliver");
    expect(f.from_name).toBe(NOTICE_SENDER);
    expect(f.body).toBe("Open Artifacts: an ask was put off.");
    expect(f.meta).toEqual({
      kind: "ask_answered",
      artifact_id: "art1",
      comment_id: "c1",
      thread_id: "t1",
      user_id: "u_1",
      until: UNTIL,
    });
  });

  it("omits absent fields", async () => {
    const s = await setup(true, WITH);
    await s.hub.deliverNotice(
      note(s, {
        threadId: undefined,
        commentId: undefined,
        userId: undefined,
        until: undefined,
      }),
    );
    const f = await waitFor(s.d, "deliver");
    expect(f.meta).toEqual({ kind: "ask_answered", artifact_id: "art1" });
  });

  it("a socket without the cap gets no meta key", async () => {
    const s = await setup(true, WITHOUT);
    await s.hub.deliverNotice(note(s));
    const f = await waitFor(s.d, "deliver");
    expect("meta" in f).toBe(false);
  });

  it("a held notice keeps its meta through the flush, and not for an uncapped socket", async () => {
    const s = await setup(false, WITH);
    expect(await s.hub.deliverNotice(note(s))).toBe("held");
    const f = await waitFor(await comeBack(s, WITH), "deliver");
    expect(f.meta).toMatchObject({ user_id: "u_1", until: UNTIL });
    const t = await setup(false, WITH);
    await t.hub.deliverNotice(note(t));
    const g = await waitFor(await comeBack(t, WITHOUT), "deliver");
    expect("meta" in g).toBe(false);
  });

  it("a notice held for its time keeps its meta when due", async () => {
    const s = await setup(true, WITH);
    expect(
      await s.hub.deliverNotice(note(s, { notBefore: Date.now() + 3_600_000 })),
    ).toBe("held");
    const stored = await runInDurableObject(
      s.hub,
      (_i, st) =>
        st.storage.sql.exec("select meta from notices").one().meta as string,
    );
    expect(JSON.parse(stored)).toMatchObject({ user_id: "u_1", until: UNTIL });
  });

  it("coalescing keeps the newest notice's meta", async () => {
    const s = await setup(false, WITH);
    await s.hub.deliverNotice(note(s, { userId: "u_old", commentId: "c1" }));
    await s.hub.deliverNotice(note(s, { userId: "u_new", commentId: "c2" }));
    const f = await waitFor(await comeBack(s, WITH), "deliver");
    expect(f.meta).toMatchObject({ user_id: "u_new", comment_id: "c2" });
  });

  it("a malformed stored meta is no meta, never a throw", async () => {
    const s = await setup(false, WITH);
    await s.hub.deliverNotice(note(s));
    await runInDurableObject(
      s.hub,
      (_i, st) => void st.storage.sql.exec("update notices set meta = '{nope'"),
    );
    const f = await waitFor(await comeBack(s, WITH), "deliver");
    expect("meta" in f).toBe(false);
    expect(f.body).toBe("Open Artifacts: an ask was put off.");
  });

  it("refuses a notice whose userId or until is not safe", async () => {
    const s = await setup(true, WITH);
    for (const bad of [
      { userId: "has space" },
      { userId: "x".repeat(200) },
      { until: "tomorrow" },
      { until: "2026-13-45T99:00:00Z" },
    ])
      expect(await s.hub.deliverNotice(note(s, bad))).toBe("dropped");
  });
});
