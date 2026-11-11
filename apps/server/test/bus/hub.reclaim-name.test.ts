// #1742: a restarted session (a new agent_ref) takes back its old name when
// only one `away` reservation of a closed agent of the same kind and scope,
// on any non-revoked machine, holds it: on agent_up and on rename. The old
// reservation is released and mail still queued for it (never acked) moves to
// the newcomer; acked bodies never move. Every other holder still means a
// suffix. Time is BusHub.setTestClock, ahead of real time, reset after each
// test.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  MAILBOX_PENDING_CAP,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub, OFFLINE_REAP_MS } from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
  framesSeen,
  hello,
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
const sqlRun = (q: string, ...binds: SqlStorageValue[]) =>
  inHub((_, s) => {
    s.storage.sql.exec(q, ...binds);
  });

afterEach(async () => {
  await setClock(null);
});

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
const base = () => Date.now() + 3_600_000 + ++seq * 1000;

type Receipt = Extract<ServerFrame, { type: "receipt" }>;

async function connect(token: string): Promise<Daemon> {
  const d = await daemon(token);
  d.send(hello(id("h")));
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  opts: { global?: boolean; kind?: string; nameKind?: "default" } = {},
): Promise<string> {
  const f = up(id("u"), ref, name, namespace, opts.global ?? false);
  d.send({
    ...f,
    ...(opts.kind === undefined ? {} : { kind: opts.kind }),
    ...(opts.nameKind === undefined ? {} : { name_kind: opts.nameKind }),
  } as ClientFrame);
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function send(
  d: Daemon,
  from: string,
  to: string,
  body = "hi",
): Promise<Receipt> {
  const fid = id("s");
  d.send({
    v: 1,
    id: fid,
    type: "send",
    from_ref: from,
    to_name: to,
    body,
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === fid) return f;
  }
}

async function rename(
  d: Daemon,
  ref: string,
  name: string,
): Promise<Extract<ServerFrame, { type: "renamed" }>> {
  const fid = id("r");
  d.send({
    v: 1,
    id: fid,
    type: "rename",
    agent_ref: ref,
    proposed_name: name,
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "error" && f.id === fid) throw new Error(JSON.stringify(f));
    if (f.type === "renamed" && f.id === fid) return f;
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

const delivers = (d: Daemon) =>
  framesSeen(d).flatMap((f) => (f.type === "deliver" ? [f] : []));

const awayRows = (name: string) =>
  sqlOf<{ ref: string }>(
    "select a.native_ref as ref from former_names f join agents a on a.id = f.agent_id where f.kind = 'away' and f.lname = ?",
    name.toLowerCase(),
  ).then((r) => r.map((x) => x.ref));

const pendingOf = (ref: string) =>
  sqlOf<{ id: string }>(
    "select r.id as id from receipts r join agents a on a.id = r.to_agent where a.native_ref = ? and r.state = 'pending' order by r.rowid",
    ref,
  ).then((r) => r.map((x) => x.id));

/** One machine `d` (the restarting harness) with a closed agent `old` away under `name`, and a sender on another machine. */
async function scene(opts: { kind?: string; global?: boolean } = {}) {
  await setClock(base());
  const n = ns("rc");
  const dm = await machine("Work");
  const sm = await machine("Snd");
  const d = await connect(dm.token);
  const snd = await connect(sm.token);
  const name = uniq("Lead");
  const oldRef = uniq("old");
  expect(await reg(d, oldRef, name, n, opts)).toBe(name);
  await reg(snd, "snd", uniq("Snd"), n);
  return { d, snd, n, name, oldRef, dm, sm, opts };
}
type Scene = Awaited<ReturnType<typeof scene>>;
const shut = (s: Scene) => {
  s.d.close();
  s.snd.close();
};

describe("a restarted session takes back its own name (#1742)", () => {
  it("agent_up: the exact name, no suffix; the away row is released", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    expect(await reg(s.d, uniq("new"), s.name, s.n)).toBe(s.name);
    expect(await awayRows(s.name)).toEqual([]);
    shut(s);
  });

  it("rename: a live session renamed to the old name gets it bare", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    const other = uniq("Other");
    expect(await reg(s.d, ref, other, s.n)).toBe(other);
    const r = await rename(s.d, ref, s.name);
    expect(r.bus_name).toBe(s.name);
    expect(await awayRows(s.name)).toEqual([]);
    shut(s);
  });

  it("a name that resolves only to the newcomer: a later send reaches it live, not a mailbox", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    await reg(s.d, ref, s.name, s.n);
    const r = await send(s.snd, "snd", s.name, "after");
    const dl = await waitFor(s.d, "deliver");
    expect(dl.msg_id).toBe(r.msg_id);
    expect(dl.to_ref).toBe(ref);
    shut(s);
  });

  it("agent_up: mail queued for the old row arrives at the newcomer, in order", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const a = await send(s.snd, "snd", s.name, "first");
    const b = await send(s.snd, "snd", s.name, "second");
    expect([a.state, b.state]).toEqual(["pending", "pending"]);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(s.name);
    const d1 = await waitFor(s.d, "deliver");
    const d2 = await waitFor(s.d, "deliver");
    expect([d1.msg_id, d2.msg_id]).toEqual([a.msg_id, b.msg_id]);
    expect(d1.to_ref).toBe(ref);
    expect("body" in d1 && d1.body).toBe("first");
    expect(await pendingOf(s.oldRef)).toEqual([]);
    shut(s);
  });

  it("rename: mail queued for the old row arrives at the live newcomer", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const a = await send(s.snd, "snd", s.name, "queued");
    const ref = uniq("new");
    await reg(s.d, ref, uniq("Other"), s.n);
    await rename(s.d, ref, s.name);
    const dl = await waitFor(s.d, "deliver");
    expect(dl.msg_id).toBe(a.msg_id);
    expect(dl.to_ref).toBe(ref);
    shut(s);
  });

  it("acked bodies never move: the newcomer cannot fetch an old acked notice, and gets only the unacked mail", async () => {
    const s = await scene();
    const big = "z".repeat(40_000);
    const acked = await send(s.snd, "snd", s.name, big);
    const dl = await waitFor(s.d, "deliver");
    expect(dl.msg_id).toBe(acked.msg_id);
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: acked.msg_id });
    for (let k = 0; k < 400; k++) {
      const st = await sqlOf<{ state: string }>(
        "select state from receipts where id = ?",
        acked.msg_id,
      );
      if (st[0]?.state === "delivered") break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await close(s.d, s.oldRef);
    const queued = await send(s.snd, "snd", s.name, "unacked");
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(s.name);
    const d2 = await waitFor(s.d, "deliver");
    expect(d2.msg_id).toBe(queued.msg_id);
    s.d.send({
      v: 1,
      id: "fz",
      type: "fetch",
      from_ref: ref,
      msg_id: acked.msg_id,
    } as ClientFrame);
    const e = await waitFor(s.d, "error");
    expect(e.id).toBe("fz");
    expect(e.code).toBe("not_found");
    expect(
      await sqlOf<{ n: number }>(
        "select count(*) as n from mail where id = ?",
        acked.msg_id,
      ),
    ).toEqual([{ n: 0 }]);
    // Nothing of the acked one was re-pointed.
    expect(
      await sqlOf<{ a: string }>(
        "select a.native_ref as a from receipts r join agents a on a.id = r.to_agent where r.id = ?",
        acked.msg_id,
      ),
    ).toEqual([{ a: s.oldRef }]);
    shut(s);
  });

  it("moved mail honours the newcomer's mailbox cap: the oldest fit, the rest stays with the old row", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const sent: string[] = [];
    for (const t of ["m1", "m2", "m3"])
      sent.push((await send(s.snd, "snd", s.name, t)).msg_id);
    const ref = uniq("new");
    await reg(s.d, ref, uniq("Other"), s.n);
    // The newcomer already holds all but two of its pending slots, below its
    // session boundary (negative rowids never collide).
    const have = MAILBOX_PENDING_CAP - 2;
    for (let k = 1; k <= have; k++)
      await sqlRun(
        `insert into receipts (rowid, id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
         select ?, ?, org_id, namespace, id, name, id, name, 'pending', 1, 0, 9e15 from agents where native_ref = ?`,
        -k,
        `filler${seq}-${k}`,
        ref,
      );
    await rename(s.d, ref, s.name);
    const dl1 = await waitFor(s.d, "deliver");
    const dl2 = await waitFor(s.d, "deliver");
    expect([dl1.msg_id, dl2.msg_id]).toEqual([sent[0], sent[1]]);
    expect(await pendingOf(s.oldRef)).toEqual([sent[2]]);
    await sqlRun("delete from receipts where id like ?", `filler${seq}-%`);
    shut(s);
  });

  it("a rename loop gains nothing: away and back never duplicates or re-takes mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const a = await send(s.snd, "snd", s.name, "once");
    const ref = uniq("new");
    await reg(s.d, ref, uniq("Other"), s.n);
    await rename(s.d, ref, s.name);
    await waitFor(s.d, "deliver");
    const away = uniq("Away");
    await rename(s.d, ref, away);
    expect((await rename(s.d, ref, s.name)).bus_name).toBe(s.name);
    expect(await pendingOf(ref)).toEqual([a.msg_id]);
    expect(await pendingOf(s.oldRef)).toEqual([]);
    // Names the loop left are not away rows of anyone.
    expect(await awayRows(s.name)).toEqual([]);
    shut(s);
  });

  it("the old session coming back later gets a suffix and none of the mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    await send(s.snd, "snd", s.name, "for the new one");
    await reg(s.d, uniq("new"), s.name, s.n);
    await waitFor(s.d, "deliver");
    expect(await reg(s.d, s.oldRef, s.name, s.n)).toBe(`${s.name}-2`);
    shut(s);
  });

  // The unchanged cases: each still gets a suffix.
  it("a live holder still means a suffix", async () => {
    const s = await scene();
    expect(await reg(s.d, uniq("new"), s.name, s.n)).toBe(`${s.name}-2`);
    shut(s);
  });

  it("an away holder on another machine is reclaimed too, with its queued mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const q = await send(s.snd, "snd", s.name, "for the restart");
    const om = await machine("Other");
    const o = await connect(om.token);
    const ref = uniq("new");
    expect(await reg(o, ref, s.name, s.n)).toBe(s.name);
    const dl = await waitFor(o, "deliver");
    expect(dl.msg_id).toBe(q.msg_id);
    expect(dl.to_ref).toBe(ref);
    expect(await awayRows(s.name)).toEqual([]);
    o.close();
    shut(s);
  });

  it("an away holder on a revoked machine still means a suffix", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    // Seeded: a real revoke frees the name outright; this pins the guard.
    await sqlRun(
      "update machines set revoked_at = ? where id = (select machine_id from agents where native_ref = ?)",
      1,
      s.oldRef,
    );
    const om = await machine("Other");
    const o = await connect(om.token);
    expect(await reg(o, uniq("new"), s.name, s.n)).toBe(`${s.name}-2`);
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    o.close();
    shut(s);
  });

  it("another kind still means a suffix", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    expect(await reg(s.d, uniq("new"), s.name, s.n, { kind: "pi" })).toBe(
      `${s.name}-2`,
    );
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    shut(s);
  });

  it("another scope (a global newcomer, a namespace-only away holder, and the reverse) still means a suffix", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    expect(await reg(s.d, uniq("g"), s.name, s.n, { global: true })).toBe(
      `${s.name}-2`,
    );
    const g = await scene({ global: true });
    await close(g.d, g.oldRef);
    expect(await reg(g.d, uniq("n"), g.name, g.n)).toBe(`${g.name}-2`);
    shut(s);
    shut(g);
  });

  it("a global takes back its own global name", async () => {
    const g = await scene({ global: true });
    await close(g.d, g.oldRef);
    expect(await reg(g.d, uniq("n"), g.name, g.n, { global: true })).toBe(
      g.name,
    );
    shut(g);
  });

  it("a held reservation still means a suffix", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    // The old session reopens under another name: its away row becomes held.
    await reg(s.d, s.oldRef, uniq("Else"), s.n);
    expect(
      (
        await sqlOf<{ kind: string }>(
          "select kind from former_names where lname = ?",
          s.name.toLowerCase(),
        )
      )[0]?.kind,
    ).toBe("held");
    expect(await reg(s.d, uniq("new"), s.name, s.n)).toBe(`${s.name}-2`);
    shut(s);
  });

  it("a role of the name still means a suffix", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    await sqlRun(
      "insert into roles (id, org_id, namespace, name, lname, agent_id, set_at) select ?, org_id, namespace, name, lower(name), null, 0 from agents where native_ref = ?",
      id("role"),
      s.oldRef,
    );
    expect(await reg(s.d, uniq("new"), s.name, s.n)).toBe(`${s.name}-2`);
    shut(s);
  });

  it("a minted (default) name is never reclaimed, and a default newcomer is never given it", async () => {
    await setClock(base());
    const n = ns("rc");
    const dm = await machine("Work");
    const d = await connect(dm.token);
    const oldRef = uniq("old");
    const minted = await reg(d, oldRef, uniq("Mint"), n, {
      nameKind: "default",
    });
    await close(d, oldRef);
    const got = await reg(d, uniq("new"), minted, n);
    expect(got).not.toBe(minted);
    expect(got).toBe(`${minted}-2`);
    const def = await reg(d, uniq("new2"), minted, n, { nameKind: "default" });
    expect(def).not.toBe(minted);
    d.close();
  });

  it("two away holders still mean a suffix", async () => {
    const s = await scene();
    const other = uniq("Other");
    const secondRef = uniq("old2");
    await reg(s.d, secondRef, other, s.n);
    await close(s.d, s.oldRef);
    await close(s.d, secondRef);
    // Seeded: two closed agents away under one name.
    await sqlRun(
      "update former_names set name = ?, lname = ? where kind = 'away' and agent_id = (select id from agents where native_ref = ?)",
      s.name,
      s.name.toLowerCase(),
      secondRef,
    );
    expect(await awayRows(s.name)).toHaveLength(2);
    expect(await reg(s.d, uniq("new"), s.name, s.n)).toBe(`${s.name}-2`);
    expect(await awayRows(s.name)).toHaveLength(2);
    shut(s);
  });

  it("a held row of a closed agent (a scope it left) still means a suffix", async () => {
    const s = await scene();
    const other = ns("rc");
    // Moves to another namespace (holding the name here), then closes.
    expect(await reg(s.d, s.oldRef, s.name, other)).toBe(s.name);
    await close(s.d, s.oldRef);
    expect(
      await sqlOf<{ kind: string }>(
        "select kind from former_names where lname = ? and namespace = ?",
        s.name.toLowerCase(),
        s.n,
      ),
    ).toEqual([{ kind: "held" }]);
    expect(await reg(s.d, uniq("new"), s.name, s.n)).toBe(`${s.name}-2`);
    shut(s);
  });

  it("a full restart: every agent of a machine goes away with its socket, then the same chosen names come back bare, by agent_up and by rename, each with its own mail", async () => {
    const t0 = base();
    await setClock(t0);
    const n = ns("rc");
    const dm = await machine("Work");
    const sm = await machine("Snd");
    const d = await connect(dm.token);
    const snd = await connect(sm.token);
    await reg(snd, "snd", uniq("Snd"), n);
    const names = [uniq("Lead"), uniq("Back"), uniq("Front")];
    const oldRefs = names.map(() => uniq("old"));
    for (const [i, name] of names.entries())
      expect(await reg(d, oldRefs[i] as string, name, n)).toBe(name);
    // The machine goes offline; the hub reaps its agents into `away`.
    d.close();
    await d.closed;
    for (let k = 0; k < 400; k++) {
      const r = await sqlOf<{ t: number | null }>(
        "select disconnected_at as t from machines where id = ?",
        dm.id,
      );
      if (typeof r[0]?.t === "number") break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await setClock(t0 + OFFLINE_REAP_MS);
    await inHub(async (_, st) => {
      if ((await st.storage.getAlarm()) === null)
        await st.storage.setAlarm(t0 + OFFLINE_REAP_MS);
    });
    await runDurableObjectAlarm(await hubOf());
    for (const name of names) expect(await awayRows(name)).toHaveLength(1);
    const mail = new Map<string, string>();
    for (const name of names)
      mail.set((await send(snd, "snd", name, `for ${name}`)).msg_id, name);
    expect(mail.size).toBe(3);
    // The machine is back: new sessions, new refs.
    const d2 = await connect(dm.token);
    const refs = names.map(() => uniq("new"));
    // 0 and 2 by agent_up, 1 by a rename from another name.
    expect(await reg(d2, refs[0] as string, names[0] as string, n)).toBe(
      names[0],
    );
    expect(await reg(d2, refs[2] as string, names[2] as string, n)).toBe(
      names[2],
    );
    expect(await reg(d2, refs[1] as string, uniq("Tmp"), n)).not.toBe(names[1]);
    expect(
      (await rename(d2, refs[1] as string, names[1] as string)).bus_name,
    ).toBe(names[1]);
    // reg() skips frames it does not wait for: read every deliver received.
    for (let k = 0; k < 400 && delivers(d2).length < 3; k++)
      await new Promise((res) => setTimeout(res, 5));
    const got = new Map(delivers(d2).map((x) => [x.msg_id, x.to_ref]));
    for (const [msgId, name] of mail)
      expect(got.get(msgId)).toBe(refs[names.indexOf(name)]);
    for (const name of names) expect(await awayRows(name)).toEqual([]);
    d2.close();
    snd.close();
  });

  it("a machine move: the name and the queued mail go to the new machine; the old session returning gets a suffix and no mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const q = await send(s.snd, "snd", s.name, "queued on A");
    const bm = await machine("B");
    const b = await connect(bm.token);
    const ref = uniq("onB");
    expect(await reg(b, ref, s.name, s.n)).toBe(s.name);
    const dl = await waitFor(b, "deliver");
    expect(dl).toMatchObject({ msg_id: q.msg_id, to_ref: ref });
    // A's old session comes back.
    expect(await reg(s.d, s.oldRef, s.name, s.n)).toBe(`${s.name}-2`);
    await new Promise((res) => setTimeout(res, 50));
    expect(s.d.raw.some((t) => t.includes('"deliver"'))).toBe(false);
    b.close();
    shut(s);
  });

  it("a live holder on another machine keeps its name; the newcomer is suffixed", async () => {
    const s = await scene();
    const om = await machine("Other");
    const o = await connect(om.token);
    const ref = uniq("onO");
    expect(await reg(o, ref, s.name, s.n)).toBe(`${s.name}-2`);
    expect(
      await sqlOf<{ live: number }>(
        "select live from agents where native_ref = ? and name = ?",
        s.oldRef,
        s.name,
      ),
    ).toEqual([{ live: 1 }]);
    o.close();
    shut(s);
  });

  it("acked notice bodies left past the close batch are gone after the name is taken, and none is fetchable by the newcomer", async () => {
    const s = await scene();
    const big = "z".repeat(40_000);
    // More than CLOSE_INLINE_BATCH (10): the close leaves bodies for its drain.
    const ids: string[] = [];
    for (let k = 0; k < 12; k++) {
      const r = await send(s.snd, "snd", s.name, `${big}${k}`);
      ids.push(r.msg_id);
      await waitFor(s.d, "deliver");
      s.d.send({ v: 1, id: `ak${k}`, type: "ack", msg_id: r.msg_id });
    }
    for (let k = 0; k < 400; k++) {
      const st = await sqlOf<{ n: number }>(
        "select count(*) as n from receipts where state = 'delivered' and id in (select value from json_each(?))",
        JSON.stringify(ids),
      );
      if (st[0]?.n === 12) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await close(s.d, s.oldRef);
    const left = () =>
      sqlOf<{ n: number }>(
        "select count(*) as n from mail where id in (select value from json_each(?))",
        JSON.stringify(ids),
      );
    expect((await left())[0]?.n).toBeGreaterThan(0);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(s.name);
    expect((await left())[0]?.n).toBe(0);
    for (const [k, mid] of ids.entries()) {
      s.d.send({
        v: 1,
        id: `fy${k}`,
        type: "fetch",
        from_ref: ref,
        msg_id: mid,
      } as ClientFrame);
      expect((await waitFor(s.d, "error")).code).toBe("not_found");
    }
    shut(s);
  });

  // The daemon's agent_up carries no name_kind, so a harness fallback name
  // reads as chosen: it must never be taken over.
  for (const [kind, fallback] of [
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["pi", "pi"],
    ["omp", "omp"],
    ["openclaw", "openclaw"],
    ["hermes", "hermes"],
    ["hermes", "hermes-myproject"],
    ["claude-code", "agent"],
    ["claude-code", "claude-1234"],
    ["pi", "Agent"],
  ] as const)
    it(`a fallback name (${kind}: ${fallback}) is not reclaimed by an unrelated session, on agent_up or rename`, async () => {
      const s = await scene();
      const oldRef = uniq("old");
      expect(await reg(s.d, oldRef, fallback, s.n, { kind })).toBe(fallback);
      await close(s.d, oldRef);
      const q = await send(s.snd, "snd", fallback, "not yours");
      expect(q.state).toBe("pending");
      const ref = uniq("new");
      expect(await reg(s.d, ref, fallback, s.n, { kind })).toBe(
        `${fallback}-2`,
      );
      const ref2 = uniq("new2");
      await reg(s.d, ref2, uniq("Other"), s.n, { kind });
      expect((await rename(s.d, ref2, fallback)).bus_name).not.toBe(fallback);
      await new Promise((res) => setTimeout(res, 50));
      expect(delivers(s.d)).toEqual([]);
      expect(await awayRows(fallback)).toContain(oldRef);
      expect(await pendingOf(oldRef)).toEqual([q.msg_id]);
      shut(s);
    });

  it("a named session of a harness kind still reclaims its name", async () => {
    const s = await scene();
    const name = uniq("Review");
    const oldRef = uniq("old");
    expect(await reg(s.d, oldRef, name, s.n, { kind: "codex" })).toBe(name);
    await close(s.d, oldRef);
    expect(await reg(s.d, uniq("new"), name, s.n, { kind: "codex" })).toBe(
      name,
    );
    shut(s);
  });

  it("a pushed, unacked body follows the name: the newcomer gets it under the same msg_id and its ack settles", async () => {
    const s = await scene();
    const r = await send(s.snd, "snd", s.name, "pushed, never acked");
    await waitFor(s.d, "deliver");
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(s.name);
    for (
      let k = 0;
      k < 400 && !delivers(s.d).some((x) => x.to_ref === ref);
      k++
    )
      await new Promise((res) => setTimeout(res, 5));
    const dl = delivers(s.d).find((x) => x.to_ref === ref);
    expect(dl).toMatchObject({ msg_id: r.msg_id });
    expect(dl && "body" in dl && dl.body).toBe("pushed, never acked");
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: r.msg_id });
    for (let k = 0; k < 400; k++) {
      const st = await sqlOf<{ state: string; ref: string }>(
        "select r.state as state, a.native_ref as ref from receipts r join agents a on a.id = r.to_agent where r.id = ?",
        r.msg_id,
      );
      if (st[0]?.state === "delivered") {
        expect(st[0].ref).toBe(ref);
        shut(s);
        return;
      }
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("ack never settled");
  });

  it("#1480: a name with parentheses is cleaned; a restart gets a suffix, never the old address", async () => {
    const s = await scene();
    const raw = "OA Owner (2)";
    const ref = uniq("paren");
    expect(await reg(s.d, ref, raw, s.n)).toBe("OA Owner 2");
    await close(s.d, ref);
    expect(await awayRows("OA Owner 2")).toEqual([ref]);
    expect(await reg(s.d, uniq("new"), raw, s.n)).toBe("OA Owner 2-2");
    expect(await awayRows("OA Owner 2")).toEqual([ref]);
    shut(s);
  });

  it("#1480: OA Manager! never takes the away OA Manager or its mail, by agent_up", async () => {
    const s = await scene();
    const real = uniq("OA Manager");
    const old = uniq("mgr");
    await reg(s.d, old, real, s.n);
    await close(s.d, old);
    await send(s.snd, "snd", real, "for the manager");
    const ref = uniq("bang");
    expect(await reg(s.d, ref, `${real}!`, s.n)).toBe(`${real}-2`);
    expect(await awayRows(real)).toEqual([old]);
    expect(await pendingOf(ref)).toEqual([]);
    expect((await pendingOf(old)).length).toBe(1);
    shut(s);
  });

  it("#1480: OA Manager! never takes the away OA Manager or its mail, by rename", async () => {
    const s = await scene();
    const real = uniq("OA Manager");
    const old = uniq("mgr");
    await reg(s.d, old, real, s.n);
    await close(s.d, old);
    await send(s.snd, "snd", real, "for the manager");
    const ref = uniq("bang");
    await reg(s.d, ref, uniq("Other"), s.n);
    expect((await rename(s.d, ref, `${real}!`)).bus_name).toBe(`${real}-2`);
    expect(await awayRows(real)).toEqual([old]);
    expect(await pendingOf(ref)).toEqual([]);
    expect((await pendingOf(old)).length).toBe(1);
    shut(s);
  });

  it("#1480: a trailing space or doubled spaces still reclaim (#1742 unchanged)", async () => {
    const s = await scene();
    const name = uniq("Two Words");
    const old = uniq("old2");
    await reg(s.d, old, name, s.n);
    await close(s.d, old);
    expect(await reg(s.d, uniq("sp"), `${name} `, s.n)).toBe(name);
    const name2 = uniq("Two Words");
    const old2 = uniq("old3");
    await reg(s.d, old2, name2, s.n);
    await close(s.d, old2);
    const dbl = name2.replace(" ", "  ");
    expect(await reg(s.d, uniq("dbl"), dbl, s.n)).toBe(name2);
    shut(s);
  });

  it("#1480: rename to a name with refused characters: cleaned once, the same raw name again is a no-op", async () => {
    const s = await scene();
    const ref = uniq("paren");
    await reg(s.d, ref, uniq("Plain"), s.n);
    const raw = "Tidy (3)";
    const first = await rename(s.d, ref, raw);
    expect(first.bus_name).toBe("Tidy 3");
    const again = await rename(s.d, ref, raw);
    expect(again.bus_name).toBe("Tidy 3");
    // the no-op wrote no former name for "Tidy 3" or "Tidy 3-2"
    expect(
      await sqlOf("select 1 from agents where lower(name) = 'tidy 3-2'"),
    ).toEqual([]);
    shut(s);
  });
});
