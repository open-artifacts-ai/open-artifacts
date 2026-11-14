// #2238: a notice addressed to an identity (toIdentity) reaches only the live
// agent at that name that holds it; otherwise it drops, never by name alone.
// A real hub and real daemon sockets. Time is BusHub.setTestClock.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { BUS_CAPS } from "@oa/bus-protocol";
import { type BusNotice, NOTICE_SENDER, newId } from "@oa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import { noticeText } from "../../src/services/follows.js";
import {
  daemon,
  framesSeen,
  hubOf,
  machine,
  member,
  ns,
  hello as plainHello,
  up,
  waitFor,
} from "./helpers.js";

const hello = (hid: string) =>
  ({ ...plainHello(hid), caps: [BUS_CAPS.follow, "rename"] }) as never;

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
const base = () => Date.now() + 3_600_000 + ++seq * 1000;

const inHub = async <R>(
  userId: string,
  fn: (i: BusHub, s: DurableObjectState) => R,
) => runInDurableObject(await hubOf(userId), fn);
const setClock = (userId: string, ms: number | null) =>
  inHub(userId, (i) => BusHub.setTestClock(i, ms));
const clocked = new Set<string>();
afterEach(async () => {
  for (const u of clocked) await setClock(u, null);
  clocked.clear();
});

/** A member with one machine and agents `names` in one namespace, each given an identity. */
async function setup(...names: string[]) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send(hello(id("h")));
  await waitFor(d, "hello_ok");
  const namespace = ns("ident");
  const agents: { ref: string; name: string; identity: string }[] = [];
  for (const n of names) {
    const ref = id("ref");
    d.send(up(id("u"), ref, n, namespace));
    const ok = await waitFor(d, "agent_ok");
    const identity = uniq("ident");
    await inHub(m.userId, (_, s) =>
      s.storage.sql.exec(
        "update agents set identity_id = ? where machine_id = ? and native_ref = ?",
        identity,
        mach.id,
        ref,
      ),
    );
    agents.push({ ref, name: ok.bus_name, identity });
  }
  const t = base();
  clocked.add(m.userId);
  await setClock(m.userId, t);
  return { userId: m.userId, d, namespace, agents, t };
}

const note = (
  to: { namespace: string; name: string },
  over: Partial<BusNotice> = {},
): BusNotice => {
  const artifactId = over.artifactId ?? uniq("art");
  const url = `https://app.test/a/${artifactId}`;
  return {
    id: newId(),
    kind: "comment",
    from: NOTICE_SENDER,
    artifactId,
    version: 1,
    url,
    to,
    text: noticeText("shared", 1, url),
    coalesceKey: artifactId,
    ...over,
  };
};

const delivers = (d: Awaited<ReturnType<typeof daemon>>) =>
  framesSeen(d).filter((f) => f.type === "deliver");
const waiting = (userId: string) =>
  inHub(
    userId,
    (_, s) =>
      s.storage.sql.exec("select count(*) as n from notices").one().n as number,
  );

describe("a notice addressed to an identity (#2238)", () => {
  it("delivers when the agent at the name holds the identity", async () => {
    const s = await setup(uniq("a"));
    const [a] = s.agents;
    const stub = await hubOf(s.userId);
    const n = note(
      { namespace: s.namespace, name: a.name },
      { toIdentity: a.identity },
    );
    expect(await stub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).body).toBe(n.text);
  });

  it("without toIdentity, delivery is by name as before", async () => {
    const s = await setup(uniq("a"));
    const stub = await hubOf(s.userId);
    const n = note({ namespace: s.namespace, name: s.agents[0].name });
    expect(await stub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).body).toBe(n.text);
  });

  it("drops when the name now belongs to another agent of the same member", async () => {
    const s = await setup(uniq("a"), uniq("b"));
    const [a, b] = s.agents;
    const stub = await hubOf(s.userId);
    const n = note(
      { namespace: s.namespace, name: b.name },
      { toIdentity: a.identity },
    );
    expect(await stub.deliverNotice(n)).toBe("dropped");
    expect(delivers(s.d)).toEqual([]);
    expect(await waiting(s.userId)).toBe(0);
  });

  it("drops when the agent was renamed between send and delivery, though its former name still resolves", async () => {
    const s = await setup(uniq("old"));
    const [a] = s.agents;
    s.d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: a.ref,
      proposed_name: uniq("new"),
    } as never);
    await waitFor(s.d, "renamed");
    const stub = await hubOf(s.userId);
    expect(
      await stub.deliverNotice(
        note(
          { namespace: s.namespace, name: a.name },
          { toIdentity: a.identity },
        ),
      ),
    ).toBe("dropped");
    // The same notice without an identity still follows the former name.
    expect(
      await stub.deliverNotice(note({ namespace: s.namespace, name: a.name })),
    ).toBe("delivered");
  });

  it("never matches an identity of another member", async () => {
    const s = await setup(uniq("a"));
    const other = await setup(uniq("z"));
    const stub = await hubOf(s.userId);
    expect(
      await stub.deliverNotice(
        note(
          { namespace: s.namespace, name: s.agents[0].name },
          { toIdentity: other.agents[0].identity },
        ),
      ),
    ).toBe("dropped");
    expect(delivers(s.d)).toEqual([]);
  });

  it("a dropped notice leaves another agent's waiting notice alone, and a waiting one for a stale identity never folds or sends", async () => {
    const s = await setup(uniq("a"));
    const [a] = s.agents;
    const stub = await hubOf(s.userId);
    const to = { namespace: s.namespace, name: a.name };
    const key = uniq("art");
    // Held for A (due later).
    expect(
      await stub.deliverNotice(
        note(to, {
          artifactId: key,
          toIdentity: a.identity,
          notBefore: s.t + 60_000,
        }),
      ),
    ).toBe("held");
    // A mismatched notice at the same key drops and does not touch the row.
    expect(
      await stub.deliverNotice(
        note(to, {
          artifactId: key,
          toIdentity: uniq("nobody"),
          notBefore: s.t + 60_000,
        }),
      ),
    ).toBe("dropped");
    expect(await waiting(s.userId)).toBe(1);
    // The address now belongs to another identity: the alarm settles A's row as gone.
    const other = uniq("ident");
    await inHub(s.userId, (_, st) =>
      st.storage.sql.exec("update agents set identity_id = ?", other),
    );
    await setClock(s.userId, s.t + 120_000);
    await runDurableObjectAlarm(await hubOf(s.userId));
    expect(await waiting(s.userId)).toBe(0);
    expect(delivers(s.d)).toEqual([]);
  });

  it("a new notice for the current identity does not fold a stale identity's waiting row", async () => {
    const s = await setup(uniq("a"));
    const [a] = s.agents;
    const stub = await hubOf(s.userId);
    const to = { namespace: s.namespace, name: a.name };
    const key = uniq("art");
    await stub.deliverNotice(
      note(to, {
        artifactId: key,
        toIdentity: a.identity,
        notBefore: s.t + 60_000,
      }),
    );
    const now = uniq("ident");
    await inHub(s.userId, (_, st) =>
      st.storage.sql.exec("update agents set identity_id = ?", now),
    );
    expect(
      await stub.deliverNotice(
        note(to, { artifactId: key, toIdentity: now, notBefore: s.t + 60_000 }),
      ),
    ).toBe("held");
    expect(
      await inHub(
        s.userId,
        (_, st) =>
          st.storage.sql
            .exec("select fold_n as f, to_identity as i from notices")
            .toArray() as { f: number; i: string }[],
      ),
    ).toEqual([{ f: 0, i: now }]);
  });

  it("reaches the namespaced agent when a global agent shares its name (#2294)", async () => {
    const s = await setup(uniq("a"), uniq("b"));
    const [a, b] = s.agents;
    await inHub(s.userId, (_, st) =>
      st.storage.sql.exec(
        "update agents set name = ?, namespace = ?, global = 1 where identity_id = ?",
        a.name,
        uniq("elsewhere"),
        b.identity,
      ),
    );
    const stub = await hubOf(s.userId);
    const n = note(
      { namespace: s.namespace, name: a.name },
      { toIdentity: a.identity },
    );
    expect(await stub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).body).toBe(n.text);
  });

  it("a held identity notice follows the agent through a rename (#2294)", async () => {
    const s = await setup(uniq("old"));
    const [a] = s.agents;
    const stub = await hubOf(s.userId);
    const n = note(
      { namespace: s.namespace, name: a.name },
      { toIdentity: a.identity, notBefore: s.t + 60_000 },
    );
    expect(await stub.deliverNotice(n)).toBe("held");
    s.d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: a.ref,
      proposed_name: uniq("new"),
    } as never);
    await waitFor(s.d, "renamed");
    await setClock(s.userId, s.t + 120_000);
    await runDurableObjectAlarm(await hubOf(s.userId));
    expect((await waitFor(s.d, "deliver")).body).toBe(n.text);
    expect(await waiting(s.userId)).toBe(0);
  });
});
