// #1742 / #3132: a new session (a new agent_ref) asking for the chosen name an
// away or live session holds NEVER takes it back (#3132, Leo 2026-11-26: "the
// name is the role"; "new session, any machine = card"). It gets the suffixed
// session name and asks the holder for the role: a pending role proposal, and
// nothing moves (name, role, mail, follows stay with the holder). Only the
// same session (same agent_ref) reopening gets its name back, silently. Time
// is BusHub.setTestClock, ahead of real time, reset after each test.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  MAILBOX_PENDING_CAP,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusHub, OFFLINE_REAP_MS } from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
  fence,
  framesSeen,
  hello,
  hubOf,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";
import { eventually } from "./helpers.ts";

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

async function connect(token: string, caps?: string[]): Promise<Daemon> {
  const d = await daemon(token);
  d.send({
    ...hello(id("h")),
    ...(caps === undefined ? {} : { caps }),
  } as ClientFrame);
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
  await eventually(async () => {
    const r = await sqlOf<{ live: number }>(
      "select live from agents where native_ref = ? order by rowid desc limit 1",
      ref,
    );
    expect(r[0]?.live).toBe(0);
  });
};

const delivers = (d: Daemon) =>
  framesSeen(d).flatMap((f) => (f.type === "deliver" ? [f] : []));

const awayRows = (name: string) =>
  sqlOf<{ ref: string }>(
    "select a.native_ref as ref from former_names f join agents a on a.id = f.agent_id where f.kind = 'away' and f.lname = ?",
    name.toLowerCase(),
  ).then((r) => r.map((x) => x.ref));

/** The roles a session's ref has a pending take-over ask for (#3132). */
const asksOf = (ref: string) =>
  sqlOf<{ name: string }>(
    "select p.name as name from role_proposals p join agents a on a.id = p.agent_id where a.native_ref = ? and p.status = 'pending' and p.action = 'repoint'",
    ref,
  ).then((r) => r.map((x) => x.name));

const pendingOf = (ref: string) =>
  sqlOf<{ id: string }>(
    "select r.id as id from receipts r join agents a on a.id = r.to_agent where a.native_ref = ? and r.state = 'pending' order by r.rowid",
    ref,
  ).then((r) => r.map((x) => x.id));

const receiptOf = (msgId: string) =>
  sqlOf<{ state: string; reason: string | null }>(
    "select state, reason from receipts where id = ?",
    msgId,
  ).then((r) => r[0]);

const waitExpired = async (d: Daemon, msgIds: string[]) => {
  await eventually(() => {
    const updates = framesSeen(d).flatMap((f) =>
      f.type === "receipt_update" ? [f] : [],
    );
    for (const mid of msgIds) {
      expect(
        updates.find(
          (u) =>
            u.msg_id === mid &&
            u.state === "expired" &&
            u.reason === "recipient_closed",
        ),
      ).toBeDefined();
    }
  });
};

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
  it("agent_up: the away holder keeps its name; the newcomer gets a suffix and asks for the role (#3132)", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    expect(await asksOf(ref)).toEqual([s.name]);
    shut(s);
  });

  it("rename: a live session renamed to the away name gets a suffix and asks, nothing moves", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    const other = uniq("Other");
    expect(await reg(s.d, ref, other, s.n)).toBe(other);
    const r = await rename(s.d, ref, s.name);
    expect(r.bus_name).toBe(`${s.name}-2`);
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    expect(await asksOf(ref)).toEqual([s.name]);
    shut(s);
  });

  it("the name is the holder's role now: a later send is refused (vacant to an old socket), never the newcomer", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    await reg(s.d, ref, s.name, s.n);
    const r = await send(s.snd, "snd", s.name, "after");
    expect(r).toMatchObject({ state: "refused", reason: "unknown_agent" });
    await fence(s.d);
    expect(delivers(s.d)).toEqual([]);
    expect(await pendingOf(ref)).toEqual([]);
    shut(s);
  });

  it("agent_up: mail queued for the old row stays with it; the newcomer gets none", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const a = await send(s.snd, "snd", s.name, "first");
    const b = await send(s.snd, "snd", s.name, "second");
    expect([a.state, b.state]).toEqual(["pending", "pending"]);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
    await fence(s.d);
    expect(delivers(s.d)).toEqual([]);
    expect(await pendingOf(s.oldRef)).toEqual([a.msg_id, b.msg_id]);
    expect(await pendingOf(ref)).toEqual([]);
    shut(s);
  });

  it("rename: mail queued for the old row stays with it", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const a = await send(s.snd, "snd", s.name, "queued");
    const ref = uniq("new");
    await reg(s.d, ref, uniq("Other"), s.n);
    await rename(s.d, ref, s.name);
    await fence(s.d);
    expect(delivers(s.d)).toEqual([]);
    expect(await pendingOf(s.oldRef)).toEqual([a.msg_id]);
    shut(s);
  });

  it("acked bodies stay with the old row: the newcomer cannot fetch an old acked notice, and gets none of the unacked mail", async () => {
    const s = await scene();
    const big = "z".repeat(40_000);
    const acked = await send(s.snd, "snd", s.name, big);
    const dl = await waitFor(s.d, "deliver");
    expect(dl.msg_id).toBe(acked.msg_id);
    s.d.send({ v: 1, id: id("ak"), type: "ack", msg_id: acked.msg_id });
    await eventually(async () => {
      const st = await sqlOf<{ state: string }>(
        "select state from receipts where id = ?",
        acked.msg_id,
      );
      expect(st[0]?.state).toBe("delivered");
    });
    await close(s.d, s.oldRef);
    const queued = await send(s.snd, "snd", s.name, "unacked");
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
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
    expect(await pendingOf(s.oldRef)).toEqual([queued.msg_id]);
    expect(
      await sqlOf<{ a: string }>(
        "select a.native_ref as a from receipts r join agents a on a.id = r.to_agent where r.id = ?",
        acked.msg_id,
      ),
    ).toEqual([{ a: s.oldRef }]);
    shut(s);
  });

  it("a rename loop asks once: away and back never files a second proposal or moves mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const a = await send(s.snd, "snd", s.name, "once");
    const ref = uniq("new");
    await reg(s.d, ref, uniq("Other"), s.n);
    await rename(s.d, ref, s.name);
    const away = uniq("Away");
    await rename(s.d, ref, away);
    expect((await rename(s.d, ref, s.name)).bus_name).toBe(`${s.name}-2`);
    expect(await asksOf(ref)).toEqual([s.name]);
    expect(await pendingOf(ref)).toEqual([]);
    expect(await pendingOf(s.oldRef)).toEqual([a.msg_id]);
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    shut(s);
  });

  it("the old session coming back later (same ref) gets its own name bare, silently, and its mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const q = await send(s.snd, "snd", s.name, "for the old one");
    await reg(s.d, uniq("new"), s.name, s.n);
    expect(await reg(s.d, s.oldRef, s.name, s.n)).toBe(s.name);
    const dl = await waitFor(s.d, "deliver");
    expect(dl).toMatchObject({ msg_id: q.msg_id, to_ref: s.oldRef });
    shut(s);
  });

  // The unchanged cases: each still gets a suffix.
  it("a live holder still means a suffix", async () => {
    const s = await scene();
    expect(await reg(s.d, uniq("new"), s.name, s.n)).toBe(`${s.name}-2`);
    shut(s);
  });

  it("an away holder on another machine is asked too, and keeps its queued mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const q = await send(s.snd, "snd", s.name, "for the restart");
    const om = await machine("Other");
    const o = await connect(om.token);
    const ref = uniq("new");
    expect(await reg(o, ref, s.name, s.n)).toBe(`${s.name}-2`);
    await fence(o);
    expect(delivers(o)).toEqual([]);
    expect(await pendingOf(s.oldRef)).toEqual([q.msg_id]);
    expect(await awayRows(s.name)).toEqual([s.oldRef]);
    expect(await asksOf(ref)).toEqual([s.name]);
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

  it("a full restart: every agent of a machine goes away with its socket; new sessions asking the same chosen names, by agent_up and by rename, get suffixes and ask, mail stays with each holder", async () => {
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
    await eventually(async () => {
      const r = await sqlOf<{ t: number | null }>(
        "select disconnected_at as t from machines where id = ?",
        dm.id,
      );
      expect(typeof r[0]?.t).toBe("number");
    });
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
      `${names[0]}-2`,
    );
    expect(await reg(d2, refs[2] as string, names[2] as string, n)).toBe(
      `${names[2]}-2`,
    );
    expect(await reg(d2, refs[1] as string, uniq("Tmp"), n)).not.toBe(names[1]);
    expect(
      (await rename(d2, refs[1] as string, names[1] as string)).bus_name,
    ).toBe(`${names[1]}-2`);
    await fence(d2);
    expect(delivers(d2)).toEqual([]);
    for (const [msgId, name] of mail)
      expect(await pendingOf(oldRefs[names.indexOf(name)] as string)).toEqual([
        msgId,
      ]);
    for (const [i, name] of names.entries()) {
      expect(await awayRows(name)).toEqual([oldRefs[i]]);
      expect(await asksOf(refs[i] as string)).toEqual([name]);
    }
    d2.close();
    snd.close();
  });

  it("a machine move: a new session on the new machine asks and gets a suffix; the old session returning keeps the name and its mail", async () => {
    const s = await scene();
    await close(s.d, s.oldRef);
    const q = await send(s.snd, "snd", s.name, "queued on A");
    const bm = await machine("B");
    const b = await connect(bm.token);
    const ref = uniq("onB");
    expect(await reg(b, ref, s.name, s.n)).toBe(`${s.name}-2`);
    await fence(b);
    expect(delivers(b)).toEqual([]);
    // A's old session comes back: the same session, silently its own name.
    expect(await reg(s.d, s.oldRef, s.name, s.n)).toBe(s.name);
    const dl = await waitFor(s.d, "deliver");
    expect(dl).toMatchObject({ msg_id: q.msg_id, to_ref: s.oldRef });
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

  it("acked notice bodies left past the close batch stay with the holder: none is fetchable by the newcomer", async () => {
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
    await eventually(async () => {
      const st = await sqlOf<{ n: number }>(
        "select count(*) as n from receipts where state = 'delivered' and id in (select value from json_each(?))",
        JSON.stringify(ids),
      );
      expect(st[0]?.n).toBe(12);
    });
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
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
    ["antigravity", "antigravity"],
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
      await fence(s.d);
      expect(delivers(s.d)).toEqual([]);
      expect(await awayRows(fallback)).toContain(oldRef);
      expect(await pendingOf(oldRef)).toEqual([q.msg_id]);
      shut(s);
    });

  it("a named session of a harness kind asks for its name too, and gets a suffix", async () => {
    const s = await scene();
    const name = uniq("Review");
    const oldRef = uniq("old");
    expect(await reg(s.d, oldRef, name, s.n, { kind: "codex" })).toBe(name);
    await close(s.d, oldRef);
    const ref = uniq("new");
    expect(await reg(s.d, ref, name, s.n, { kind: "codex" })).toBe(`${name}-2`);
    expect(await asksOf(ref)).toEqual([name]);
    shut(s);
  });

  it("a pushed, unacked body stays with the holder: the newcomer gets nothing, the old session coming back gets it", async () => {
    const s = await scene();
    const r = await send(s.snd, "snd", s.name, "pushed, never acked");
    await waitFor(s.d, "deliver");
    await close(s.d, s.oldRef);
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
    await fence(s.d);
    expect(delivers(s.d).some((x) => x.to_ref === ref)).toBe(false);
    expect(await pendingOf(s.oldRef)).toEqual([r.msg_id]);
    shut(s);
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

  it("#1480: a trailing space or doubled spaces still mean the same held name: a suffix and an ask (#3132)", async () => {
    const s = await scene();
    const name = uniq("Two Words");
    const old = uniq("old2");
    await reg(s.d, old, name, s.n);
    await close(s.d, old);
    const sp = uniq("sp");
    expect(await reg(s.d, sp, `${name} `, s.n)).toBe(`${name}-2`);
    expect(await asksOf(sp)).toEqual([name]);
    const name2 = uniq("Two Words");
    const old2 = uniq("old3");
    await reg(s.d, old2, name2, s.n);
    await close(s.d, old2);
    const dbl = name2.replace(" ", "  ");
    const dref = uniq("dbl");
    expect(await reg(s.d, dref, dbl, s.n)).toBe(`${name2}-2`);
    expect(await asksOf(dref)).toEqual([name2]);
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

describe("held mail stays with its session (#3208)", () => {
  it("an agy row that closes without a handover keeps its mail: a new agy session gets agy-2 and none of it, and the row's own reopen receives it", async () => {
    await setClock(base());
    const n = ns("rc");
    const dm = await machine("Work");
    const sm = await machine("Snd");
    const d = await connect(dm.token, [BUS_CAPS.mailbox]);
    const snd = await connect(sm.token, [BUS_CAPS.mailbox]);
    const oldRef = uniq("agy-starting-1");
    expect(await reg(d, oldRef, "agy", n, { kind: "antigravity" })).toBe("agy");
    await reg(snd, "snd", uniq("Snd"), n);
    const m1 = await send(snd, "snd", "agy", "first");
    const m2 = await send(snd, "snd", "agy", "second");
    await close(d, oldRef);
    const newRef = uniq("agy-starting-2");
    const got = await reg(d, newRef, "agy", n, { kind: "antigravity" });
    expect(got).toBe("agy-2");
    expect(delivers(d).filter((x) => x.to_ref === newRef)).toEqual([]);
    expect(await pendingOf(newRef)).toEqual([]);
    expect(await pendingOf(oldRef)).toEqual([m1.msg_id, m2.msg_id]);
    expect((await receiptOf(m1.msg_id))?.state).toBe("pending");
    await reg(d, oldRef, "agy", n, { kind: "antigravity" });
    await eventually(() => {
      const ids = delivers(d)
        .filter((x) => x.to_ref === oldRef)
        .map((x) => x.msg_id);
      expect(ids).toContain(m1.msg_id);
      expect(ids).toContain(m2.msg_id);
    });
    d.close();
    snd.close();
  });

  it("a chosen-name restart with no handover: the newcomer gets a suffix and asks; the held mail stays (#3132)", async () => {
    await setClock(base());
    const n = ns("rc");
    const dm = await machine("Work");
    const sm = await machine("Snd");
    const d = await connect(dm.token, [BUS_CAPS.mailbox]);
    const snd = await connect(sm.token, [BUS_CAPS.mailbox]);
    const name = uniq("Lead");
    const oldRef = uniq("codex-1");
    expect(await reg(d, oldRef, name, n, { kind: "codex" })).toBe(name);
    await reg(snd, "snd", uniq("Snd"), n);
    const m = await send(snd, "snd", name, "for the old lead");
    await close(d, oldRef);
    const newRef = uniq("codex-2");
    expect(await reg(d, newRef, name, n, { kind: "codex" })).toBe(`${name}-2`);
    expect(await asksOf(newRef)).toEqual([name]);
    await fence(d);
    expect(
      delivers(d).some((x) => x.to_ref === newRef && x.msg_id === m.msg_id),
    ).toBe(false);
    expect(await pendingOf(oldRef)).toEqual([m.msg_id]);
    expect((await receiptOf(m.msg_id))?.state).not.toBe("expired");
    d.close();
    snd.close();
  });

  it("an explicit handover (replaces) keeps the mail and the successor receives it", async () => {
    await setClock(base());
    const n = ns("rc");
    const dm = await machine("Work");
    const sm = await machine("Snd");
    const d = await connect(dm.token, [BUS_CAPS.mailbox]);
    const snd = await connect(sm.token, [BUS_CAPS.mailbox]);
    const oldRef = uniq("agy-starting-3");
    expect(await reg(d, oldRef, "agy", n, { kind: "antigravity" })).toBe("agy");
    await reg(snd, "snd", uniq("Snd"), n);
    const m = await send(snd, "snd", "agy", "during startup");
    const newRef = uniq("conv-uuid-3");
    d.send({
      ...up(id("u"), newRef, "agy", n),
      kind: "antigravity",
      replaces: oldRef,
    } as ClientFrame);
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("agy");
    await eventually(() => {
      const dl = delivers(d).find(
        (x) => x.to_ref === newRef && x.msg_id === m.msg_id,
      );
      expect(dl).toBeDefined();
    });
    expect((await receiptOf(m.msg_id))?.state).not.toBe("expired");
    d.close();
    snd.close();
  });

  it("Claude /clear still carries mail", async () => {
    await setClock(base());
    const n = ns("rc");
    const dm = await machine("Work");
    const sm = await machine("Snd");
    const d = await connect(dm.token, [BUS_CAPS.mailbox]);
    const snd = await connect(sm.token, [BUS_CAPS.mailbox]);
    const name = uniq("Lead");
    const oldRef = uniq("claude-1");
    expect(await reg(d, oldRef, name, n, { kind: "claude-code" })).toBe(name);
    await reg(snd, "snd", uniq("Snd"), n);
    const m = await send(snd, "snd", name, "before clear");
    const newRef = uniq("claude-2");
    d.send({
      ...up(id("u"), newRef, name, n),
      kind: "claude-code",
      replaces: oldRef,
    } as ClientFrame);
    expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
    await eventually(() => {
      const dl = delivers(d).find(
        (x) => x.to_ref === newRef && x.msg_id === m.msg_id,
      );
      expect(dl).toBeDefined();
    });
    expect((await receiptOf(m.msg_id))?.state).not.toBe("expired");
    d.close();
    snd.close();
  });

  it("a starting agy row whose process ended (gone): its mail expires at once as recipient_closed, the sender is told, and a new agy session gets none", async () => {
    await setClock(base());
    const n = ns("rc");
    const dm = await machine("Work");
    const sm = await machine("Snd");
    const d = await connect(dm.token, [
      BUS_CAPS.mailbox,
      BUS_CAPS.sessionsGone,
    ]);
    const snd = await connect(sm.token, [
      BUS_CAPS.mailbox,
      BUS_CAPS.sessionsGone,
    ]);
    const oldRef = uniq("agy-starting-9");
    expect(await reg(d, oldRef, "agy", n, { kind: "antigravity" })).toBe("agy");
    await reg(snd, "snd", uniq("Snd"), n);
    const m = await send(snd, "snd", "agy", "during startup");
    d.send({
      v: 1,
      id: id("c"),
      type: "sessions",
      open: [],
      closed: [oldRef],
      gone: [oldRef],
    });
    await waitExpired(snd, [m.msg_id]);
    expect(await receiptOf(m.msg_id)).toEqual({
      state: "expired",
      reason: "recipient_closed",
    });
    expect(await awayRows("agy")).not.toContain(oldRef);
    const newRef = uniq("agy-starting-10");
    expect(await reg(d, newRef, "agy", n, { kind: "antigravity" })).toBe("agy");
    expect(delivers(d).filter((x) => x.to_ref === newRef)).toEqual([]);
    expect(await pendingOf(newRef)).toEqual([]);
    d.close();
    snd.close();
  });

  it("a plain close (no gone) keeps the mail for the reopen", async () => {
    await setClock(base());
    const n = ns("rc");
    const dm = await machine("Work");
    const sm = await machine("Snd");
    const d = await connect(dm.token, [
      BUS_CAPS.mailbox,
      BUS_CAPS.sessionsGone,
    ]);
    const snd = await connect(sm.token, [
      BUS_CAPS.mailbox,
      BUS_CAPS.sessionsGone,
    ]);
    const oldRef = uniq("agy-starting-11");
    expect(await reg(d, oldRef, "agy", n, { kind: "antigravity" })).toBe("agy");
    await reg(snd, "snd", uniq("Snd"), n);
    const m = await send(snd, "snd", "agy", "keep for reopen");
    await close(d, oldRef);
    expect((await receiptOf(m.msg_id))?.state).toBe("pending");
    await reg(d, oldRef, "agy", n, { kind: "antigravity" });
    await eventually(() => {
      const dl = delivers(d).find(
        (x) => x.to_ref === oldRef && x.msg_id === m.msg_id,
      );
      expect(dl).toBeDefined();
    });
    d.close();
    snd.close();
  });

  it("gone that is not in closed is refused", async () => {
    await setClock(base());
    const dm = await machine("Work");
    const d = await connect(dm.token, [
      BUS_CAPS.mailbox,
      BUS_CAPS.sessionsGone,
    ]);
    const fid = id("c");
    d.send({
      v: 1,
      id: fid,
      type: "sessions",
      open: [],
      closed: [],
      gone: [uniq("agy-starting-12")],
    } as ClientFrame);
    const err = await waitFor(d, "error");
    expect(err).toMatchObject({ id: fid, code: "bad_frame" });
    d.close();
  });
});
