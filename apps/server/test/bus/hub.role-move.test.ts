// #3132: when a role moves from one session to another (the dashboard's
// Change holder, or a confirmed proposal), what the old session was sent
// follows the role: an ask's answer (identity-addressed), a mention (by
// name) and its followed pages reach the new holder. A name alone moves
// nothing (#3208). Real hub, real daemon sockets, the real follows service
// on D1. Waits are signals (reply frames, a list round trip), never sleeps.
import { runInDurableObject } from "cloudflare:test";
import type { ServerFrame } from "@oa/bus-protocol";
import { type BusNotice, type Member, NOTICE_SENDER, newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { publish } from "../../src/services/artifacts.js";
import { noticeText, notifyChanged } from "../../src/services/follows.js";
import { getUser } from "../../src/services/users.js";
import {
  daemon,
  e,
  framesSeen,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

type Reply<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

async function setup() {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(id("h")), caps: ["follow", "rename"] } as never);
  await waitFor(d, "hello_ok");
  const namespace = ns("move");
  const hub = await hubOf(m.userId);
  const sql = <T>(q: string, ...b: unknown[]) =>
    runInDurableObject(hub, (_, s) =>
      s.storage.sql.exec(q, ...(b as SqlStorageValue[])).toArray(),
    ) as Promise<T[]>;
  /** An open session with its own identity (#1822 link). */
  const reg = async (name: string) => {
    const ref = id("ref");
    d.send(up(id("u"), ref, name, namespace));
    const busName = (await waitFor(d, "agent_ok")).bus_name;
    const identity = uniq("ident");
    await sql(
      "update agents set identity_id = ? where machine_id = ? and native_ref = ?",
      identity,
      mach.id,
      ref,
    );
    const [row] = await sql<{ id: string }>(
      "select id from agents where machine_id = ? and native_ref = ?",
      mach.id,
      ref,
    );
    return { ref, name: busName, identity, id: row.id };
  };
  const setRole = async (name: string, agentId: string) => {
    const r = await hub.putRole(namespace, name, agentId);
    if (!r.ok) throw new Error(`putRole refused: ${r.reason}`);
    return r;
  };
  return { m, d, hub, namespace, reg, setRole, sql };
}
type S = Awaited<ReturnType<typeof setup>>;

const ask = async <T extends ServerFrame["type"]>(
  s: S,
  frame: Record<string, unknown>,
  type: T,
): Promise<Reply<T>> => {
  const fid = id("f");
  s.d.send({ v: 1, id: fid, ...frame } as never);
  for (;;) {
    const f = await s.d.next();
    if (f.id === fid) {
      expect(f.type).toBe(type);
      return f as Reply<T>;
    }
  }
};
const follow = (s: S, ref: string, artifact: string) =>
  ask(s, { type: "follow", from_ref: ref, artifact }, "followed");
const listed = async (s: S, ref: string) =>
  (await ask(s, { type: "following", from_ref: ref }, "follows")).follows.map(
    (f) => f.artifact_id,
  );

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

const owner = async (userId: string): Promise<Member> => {
  const u = await getUser(e, userId);
  if (!u) throw new Error("no user");
  return u;
};
const artifactOf = async (userId: string) =>
  (
    await publish(
      e,
      await owner(userId),
      { title: "t", format: "markdown", content: "hello" } as never,
      null,
      undefined,
      "create",
    )
  ).id;

describe("a moved role takes the old session's notices along (#3132)", () => {
  it("an ask's answer to the old session's identity reaches the new holder", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    await s.setRole(role, old.id);
    const moved = await s.setRole(role, next.id);
    expect(moved.moved).toMatchObject({
      fromAgentId: old.id,
      toAgentId: next.id,
      from: { namespace: s.namespace, name: old.name },
      to: { namespace: s.namespace, name: next.name },
    });
    const n = note(
      { namespace: s.namespace, name: old.name },
      { toIdentity: old.identity },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    const dl = await waitFor(s.d, "deliver");
    expect(dl.to_ref).toBe(next.ref);
    expect(dl.body).toBe(n.text);
  });

  it("a mention of the old session's name reaches the new holder after the old one closed", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    await s.setRole(role, old.id);
    await s.setRole(role, next.id);
    s.d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: old.ref });
    await ask(s, { type: "list", from_ref: next.ref }, "roster");
    const n = note({ namespace: s.namespace, name: old.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).to_ref).toBe(next.ref);
  });

  it("the old session's followed pages move to the new holder, and their notices reach it", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    await follow(s, old.ref, art);
    const role = uniq("platform");
    await s.setRole(role, old.id);
    await s.setRole(role, next.id);
    // following waits for the hub's queued re-key.
    expect(await listed(s, next.ref)).toEqual([art]);
    expect(await listed(s, old.ref)).toEqual([]);
    await notifyChanged(e, art, 2, s.m.userId, Date.now());
    expect((await waitFor(s.d, "deliver")).to_ref).toBe(next.ref);
  });

  it("a namesake of the old session gets its own mail, not the role's", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    await s.setRole(role, old.id);
    await s.setRole(role, next.id);
    // The old session is gone for good and its name is free again.
    s.d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: old.ref });
    await ask(s, { type: "list", from_ref: next.ref }, "roster");
    await s.sql("delete from former_names where agent_id = ?", old.id);
    await s.sql("delete from agents where id = ?", old.id);
    const namesake = await s.reg(old.name);
    expect(namesake.name).toBe(old.name);
    const n = note({ namespace: s.namespace, name: old.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).to_ref).toBe(namesake.ref);
  });

  it("a session that holds the role again gets its mail again", async () => {
    const s = await setup();
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const role = uniq("platform");
    await s.setRole(role, a.id);
    await s.setRole(role, b.id);
    await s.setRole(role, a.id);
    const n = note(
      { namespace: s.namespace, name: a.name },
      { toIdentity: a.identity },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).to_ref).toBe(a.ref);
  });

  it("two sessions that swapped roles never bounce a notice", async () => {
    const s = await setup();
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const r1 = uniq("one");
    const r2 = uniq("two");
    await s.setRole(r1, a.id);
    await s.setRole(r2, b.id);
    await s.setRole(r1, b.id);
    await s.setRole(r2, a.id);
    const n = note({ namespace: s.namespace, name: a.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).to_ref).toBe(b.ref);
    expect(framesSeen(s.d).filter((f) => f.type === "deliver")).toHaveLength(1);
  });

  it("without a move, delivery is as addressed; a vacated role forwards nothing", async () => {
    const s = await setup();
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const role = uniq("platform");
    const set = await s.setRole(role, a.id);
    expect(set.moved).toBeNull();
    await s.setRole(role, b.id);
    const vacated = await s.hub.putRole(s.namespace, role, null);
    expect(vacated.ok && vacated.moved).toBeNull();
    const n = note({ namespace: s.namespace, name: a.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await waitFor(s.d, "deliver")).to_ref).toBe(a.ref);
  });
});
