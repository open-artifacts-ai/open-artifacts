// #1816: a #1742 reclaim moves the roles the away row held to the newcomer, so
// a restarted lead keeps its role; a role with a reach_grants row stays vacant
// (holding it grants reach, which needs the member's confirmation, #1346).
// Also: a vacant/away role and an away agent of the same name in two linked
// namespaces are ambiguous. Time is BusHub.setTestClock; no sleeps.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, type ClientFrame, type ServerFrame } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
  framesSeen,
  hubOf,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const inHub = async <R>(fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(await hubOf(), fn);
const setClock = (ms: number | null) =>
  inHub((i) => BusHub.setTestClock(i, ms));
const sqlOf = <T extends Record<string, SqlStorageValue>>(
  q: string,
  ...binds: SqlStorageValue[]
) =>
  inHub(
    (_, s) => s.storage.sql.exec<T>(q, ...binds).toArray() as unknown as T[],
  );

afterEach(async () => {
  await setClock(null);
});

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
const base = () => Date.now() + 3_600_000 + ++seq * 1000;
type Receipt = Extract<ServerFrame, { type: "receipt" }>;
const CAPS = [BUS_CAPS.links, BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.roles];

async function connect(token: string): Promise<Daemon> {
  const d = await daemon(token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "M",
    client_version: "0.0.0",
    caps: CAPS,
  });
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(d: Daemon, ref: string, name: string, namespace: string) {
  d.send(up(id("u"), ref, name, namespace, false));
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function send(d: Daemon, from: string, to: string): Promise<Receipt> {
  const fid = id("s");
  d.send({
    v: 1,
    id: fid,
    type: "send",
    from_ref: from,
    to_name: to,
    body: "hi",
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === fid) return f;
  }
}

const close = async (d: Daemon, ref: string) => {
  d.send({ v: 1, id: id("c"), type: "sessions", open: [], closed: [ref] });
  for (let k = 0; k < 400; k++) {
    const r = await sqlOf<{ live: number }>(
      "select live from agents where native_ref = ? order by rowid desc limit 1",
      ref,
    );
    if (r[0]?.live === 0) return;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("close never applied");
};

const agentId = async (ref: string) =>
  (
    await sqlOf<{ id: string }>(
      "select id from agents where native_ref = ? order by rowid desc limit 1",
      ref,
    )
  )[0]?.id ?? "";

const sqlRun = (q: string, ...binds: SqlStorageValue[]) =>
  inHub((_, st) => {
    st.storage.sql.exec(q, ...binds);
  });

const holds = async (namespace: string, role: string, ref: string) => {
  const r = await (await hubOf()).putRole(namespace, role, await agentId(ref));
  if (!r.ok) throw new Error(`putRole refused: ${r.reason}`);
};

/** The native_ref of the row holding role `lname`, or null when vacant. */
const holderRef = async (lname: string) =>
  (
    await sqlOf<{ ref: string | null }>(
      "select a.native_ref as ref from roles r left join agents a on a.id = r.agent_id where r.lname = ?",
      lname.toLowerCase(),
    )
  )[0]?.ref ?? null;

async function scene() {
  await setClock(base());
  const n = ns("rr");
  const dm = await machine("Work");
  const sm = await machine("Snd");
  const d = await connect(dm.token);
  const snd = await connect(sm.token);
  const name = uniq("Lead");
  const oldRef = uniq("old");
  expect(await reg(d, oldRef, name, n)).toBe(name);
  await reg(snd, "snd", uniq("Snd"), n);
  return { d, snd, n, name, oldRef };
}
type Scene = Awaited<ReturnType<typeof scene>>;
const shut = (s: Scene) => {
  s.d.close();
  s.snd.close();
};

describe("a reclaimed name keeps its roles (#1816)", () => {
  it("a plain role moves to the newcomer and a send to it delivers there", async () => {
    const s = await scene();
    const role = uniq("role");
    await holds(s.n, role, s.oldRef);
    await close(s.d, s.oldRef);
    expect(await holderRef(role)).toBe(s.oldRef);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(s.name);
    expect(await holderRef(role)).toBe(ref);
    const r = await send(s.snd, "snd", role);
    const dl = await waitFor(s.d, "deliver");
    expect(dl.msg_id).toBe(r.msg_id);
    expect(dl.to_ref).toBe(ref);
    shut(s);
  });

  it("two roles held by the same row both move", async () => {
    const s = await scene();
    const [r1, r2] = [uniq("roleA"), uniq("roleB")];
    await holds(s.n, r1, s.oldRef);
    await holds(s.n, r2, s.oldRef);
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    await reg(s.d, ref, s.name, s.n);
    expect([await holderRef(r1), await holderRef(r2)]).toEqual([ref, ref]);
    shut(s);
  });

  it("rename: a live session renamed to the away name takes the roles too", async () => {
    const s = await scene();
    const role = uniq("role");
    await holds(s.n, role, s.oldRef);
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    await reg(s.d, ref, uniq("Other"), s.n);
    const fid = id("rn");
    s.d.send({
      v: 1,
      id: fid,
      type: "rename",
      agent_ref: ref,
      proposed_name: s.name,
    } as ClientFrame);
    await waitFor(s.d, "renamed");
    expect(await holderRef(role)).toBe(ref);
    shut(s);
  });

  it("the holder changes from the old row to the newcomer, and only then", async () => {
    const s = await scene();
    const role = uniq("role");
    await holds(s.n, role, s.oldRef);
    await close(s.d, s.oldRef);
    expect(await holderRef(role)).toBe(s.oldRef);
    const ref = uniq("new");
    await reg(s.d, ref, s.name, s.n);
    expect(await holderRef(role)).toBe(ref);
    shut(s);
  });

  it("a stale pointer in another namespace does not move", async () => {
    const s = await scene();
    const role = uniq("stale");
    const other = ns("ro");
    await sqlRun(
      "insert into roles (id, org_id, namespace, name, lname, agent_id, set_at) select ?, org_id, ?, ?, ?, id, 0 from agents where native_ref = ?",
      id("rl"),
      other,
      role,
      role.toLowerCase(),
      s.oldRef,
    );
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    await reg(s.d, ref, s.name, s.n);
    expect(await holderRef(role)).toBe(s.oldRef);
    shut(s);
  });

  it("a newcomer already holding a role gains the second", async () => {
    const s = await scene();
    const [r1, r2] = [uniq("roleA"), uniq("roleB")];
    await holds(s.n, r1, s.oldRef);
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    await reg(s.d, ref, uniq("Other"), s.n);
    await holds(s.n, r2, ref);
    const fid = id("rn");
    s.d.send({
      v: 1,
      id: fid,
      type: "rename",
      agent_ref: ref,
      proposed_name: s.name,
    } as ClientFrame);
    await waitFor(s.d, "renamed");
    expect([await holderRef(r1), await holderRef(r2)]).toEqual([ref, ref]);
    shut(s);
  });

  it("a role held by a global agent moves only to a global newcomer", async () => {
    await setClock(base());
    const n = ns("rg");
    const d = await connect((await machine("G")).token);
    const name = uniq("Glob");
    const oldRef = uniq("old");
    d.send(up(id("u"), oldRef, name, n, true));
    await waitFor(d, "agent_ok");
    const role = uniq("role");
    await holds(n, role, oldRef);
    await close(d, oldRef);
    // A non-global newcomer cannot reclaim a global's name: no move.
    const plain = uniq("plain");
    expect(await reg(d, plain, name, n)).not.toBe(name);
    expect(await holderRef(role)).toBe(oldRef);
    const ref = uniq("new");
    d.send(up(id("u"), ref, name, n, true));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
    expect(await holderRef(role)).toBe(ref);
    d.close();
  });

  it("a role with reach stays vacant for the newcomer and keeps its grants", async () => {
    const s = await scene();
    const [plain, granted] = [uniq("plain"), uniq("granted")];
    const target = ns("rt");
    await holds(s.n, plain, s.oldRef);
    await holds(s.n, granted, s.oldRef);
    expect((await (await hubOf()).putReach(s.n, granted, target)).ok).toBe(
      true,
    );
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(s.name);
    expect(await holderRef(plain)).toBe(ref);
    // The granted role still points at the old (closed) row: vacant, no reach.
    expect(await holderRef(granted)).toBe(s.oldRef);
    expect(
      await sqlOf<{ n: number }>(
        "select count(*) as n from reach_grants where lname = ?",
        granted.toLowerCase(),
      ),
    ).toEqual([{ n: 1 }]);
    const r = await send(s.snd, "snd", granted);
    expect(r).toMatchObject({ state: "refused", reason: "role_vacant" });
    shut(s);
  });

  it("a role held by a different away agent is untouched", async () => {
    const s = await scene();
    const other = uniq("other");
    const otherName = uniq("Other");
    await reg(s.d, other, otherName, s.n);
    const role = uniq("role");
    await holds(s.n, role, other);
    await close(s.d, other);
    await close(s.d, s.oldRef);
    await reg(s.d, uniq("new"), s.name, s.n);
    expect(await holderRef(role)).toBe(other);
    shut(s);
  });
});

describe("a vacant role and an away agent in two linked namespaces (#1816)", () => {
  it("answers ambiguous, never the role", async () => {
    await setClock(base());
    const [a, b, c] = [ns("la"), ns("lb"), ns("lc")];
    const hub = await hubOf();
    expect((await hub.putLink(a, b)).ok).toBe(true);
    expect((await hub.putLink(a, c)).ok).toBe(true);
    const d = await connect((await machine("L")).token);
    const name = uniq("Shared");
    await reg(d, "me", uniq("Me"), a);
    // B: a role named `name` whose holder is closed (vacant).
    await reg(d, "hb", uniq("Holder"), b);
    await holds(b, name, "hb");
    await close(d, "hb");
    // C: an agent named `name`, closed (away).
    await reg(d, "ac", name, c);
    await close(d, "ac");
    const r = await send(d, "me", name);
    expect(r).toMatchObject({ state: "refused", reason: "ambiguous" });
    d.close();
  });

  it("an away agent alone in one linked namespace still resolves", async () => {
    await setClock(base());
    const [a, c] = [ns("la"), ns("lc")];
    expect((await (await hubOf()).putLink(a, c)).ok).toBe(true);
    const d = await connect((await machine("L")).token);
    const name = uniq("Solo");
    await reg(d, "me", uniq("Me"), a);
    await reg(d, "ac", name, c);
    await close(d, "ac");
    const r = await send(d, "me", name);
    expect(r).toMatchObject({ state: "pending", queued: "away" });
    d.close();
  });
});
