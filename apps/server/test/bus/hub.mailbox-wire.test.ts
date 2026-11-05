// #1295 PR B: the mailbox wire. A hello that lists BUS_CAPS.mailbox gets
// queued/since on a send receipt, `mailbox_full`, `reserved_name`, and away
// rows in the roster; every other socket keeps exactly today's shapes (its
// strict decoder refuses a frame with a new key).

import { runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  MAILBOX_BYTES_CAP,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
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
type Roster = Extract<ServerFrame, { type: "roster" }>;

async function connect(
  token: string,
  caps: string[] | undefined,
): Promise<Daemon> {
  const d = await daemon(token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
    ...(caps === undefined ? {} : { caps }),
  });
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(d: Daemon, ref: string, name: string, namespace: string) {
  d.send(up(id("u"), ref, name, namespace));
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

/** The raw JSON of the frame answering `fid`. */
const rawFor = (d: Daemon, fid: string): Record<string, unknown> => {
  for (const t of d.raw) {
    if (!t.startsWith("{")) continue;
    const v = JSON.parse(t) as { id?: string };
    if (v.id === fid) return v as Record<string, unknown>;
  }
  throw new Error(`no frame ${fid}`);
};

async function list(
  d: Daemon,
  from: string,
): Promise<{ r: Roster; raw: unknown }> {
  const fid = id("l");
  d.send({ v: 1, id: fid, type: "list", from_ref: from });
  for (;;) {
    const f = await d.next();
    if (f.type === "roster" && f.id === fid)
      return { r: f, raw: rawFor(d, fid) };
  }
}

async function receiptFor(d: Daemon, fid: string): Promise<Receipt> {
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === fid) return f;
  }
}

const close = async (d: Daemon, ref: string) => {
  d.send({ v: 1, id: id("c"), type: "sessions", open: [], closed: [ref] });
  for (let k = 0; k < 400; k++) {
    const r = await sqlOf<{ live: number }>(
      "select live from agents where native_ref = ?",
      ref,
    );
    if (r[0]?.live === 0) return;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("close never applied");
};

const MB = [BUS_CAPS.mailbox];

describe("mailbox wire (#1295 PR B)", () => {
  async function trio(caps: string[] | undefined) {
    await setClock(base());
    const n = ns("mw");
    const rm = await machine("Rcv");
    const sm = await machine("Snd");
    const rcv = await connect(rm.token, MB);
    const snd = await connect(sm.token, caps);
    const ref = uniq("r");
    const name = await reg(rcv, ref, uniq("Rcv"), n);
    await reg(snd, "snd", uniq("Snd"), n);
    return { rcv, snd, n, ref, name };
  }

  it("hello_ok lists mailbox to a hello that listed caps", async () => {
    const d = await daemon((await machine("M")).token);
    d.send({
      v: 1,
      id: "hh1",
      type: "hello",
      machine_label: "M",
      client_version: "0.0.0",
      caps: MB,
    });
    expect((await waitFor(d, "hello_ok")).caps).toContain(BUS_CAPS.mailbox);
    d.close();
  });

  it("a send to an away agent: a cap socket gets queued away + since, a no-cap socket neither", async () => {
    const { rcv, snd, ref, name } = await trio(MB);
    await close(rcv, ref);
    const [{ t }] = await sqlOf<{ t: number }>(
      "select away_since as t from agents where native_ref = ?",
      ref,
    );
    const r = await send(snd, "snd", name);
    expect(r).toMatchObject({
      state: "pending",
      queued: "away",
      since: new Date(t).toISOString(),
    });

    const om = await machine("Old");
    const old = await connect(om.token, undefined);
    await reg(
      old,
      "oldsnd",
      uniq("Old"),
      (
        await sqlOf<{ namespace: string }>(
          "select namespace from agents where native_ref = ?",
          ref,
        )
      )[0].namespace,
    );
    const fid = id("s");
    old.send({
      v: 1,
      id: fid,
      type: "send",
      from_ref: "oldsnd",
      to_name: name,
      body: "hi",
    } as ClientFrame);
    await waitFor(old, "receipt");
    const raw = rawFor(old, fid);
    expect(raw.state).toBe("pending");
    expect(raw).not.toHaveProperty("queued");
    expect(raw).not.toHaveProperty("since");
    rcv.close();
    snd.close();
    old.close();
  });

  it("a send to a live agent on an offline machine: queued offline since disconnected_at", async () => {
    const { rcv, snd, ref, name } = await trio(MB);
    rcv.close();
    let since: number | null = null;
    for (let k = 0; k < 400 && since === null; k++) {
      since =
        (
          await sqlOf<{ t: number | null }>(
            "select m.disconnected_at as t from machines m join agents a on a.machine_id = m.id where a.native_ref = ?",
            ref,
          )
        )[0]?.t ?? null;
      if (since === null) await new Promise((res) => setTimeout(res, 5));
    }
    expect(since).not.toBeNull();
    const r = await send(snd, "snd", name);
    expect(r).toMatchObject({
      state: "pending",
      queued: "offline",
      since: new Date(since as number).toISOString(),
    });
    snd.close();
  });

  it("a send to a live agent on an online machine carries no queued", async () => {
    const { rcv, snd, name } = await trio(MB);
    const r = await send(snd, "snd", name);
    expect(r.state).toBe("pending");
    expect(r).not.toHaveProperty("queued");
    rcv.close();
    snd.close();
  });

  it("a full mailbox: mailbox_full to a cap socket, inbox_full to a no-cap one", async () => {
    for (const [caps, reason] of [
      [MB, "mailbox_full"],
      [undefined, "inbox_full"],
    ] as const) {
      const { rcv, snd, ref, name } = await trio(caps);
      await close(rcv, ref);
      await inHub((_, s) => {
        s.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
           select ?, org_id, namespace, id, name, id, name, 'pending', ?, ?, ?
             from agents where native_ref = ?`,
          id("seedfull"),
          MAILBOX_BYTES_CAP,
          Date.now(),
          Date.now() + 3_600_000,
          ref,
        );
      });
      expect(await send(snd, "snd", name)).toMatchObject({
        state: "refused",
        reason,
      });
      rcv.close();
      snd.close();
    }
  });

  it("a name only held by a move or flip: reserved_name to a cap socket, unknown_agent to a no-cap one", async () => {
    for (const [caps, reason] of [
      [MB, "reserved_name"],
      [undefined, "unknown_agent"],
    ] as const) {
      const { rcv, snd, ref, name, n } = await trio(caps);
      rcv.send(up(id("u"), ref, name, ns("mwmoved")));
      await waitFor(rcv, "agent_ok");
      expect(await send(snd, "snd", name)).toMatchObject({
        state: "refused",
        reason,
      });
      expect(n).toBeTruthy();
      rcv.close();
      snd.close();
    }
  });

  it("the roster lists an away agent with state away + since to a cap socket only", async () => {
    const { rcv, snd, ref, name, n } = await trio(MB);
    await close(rcv, ref);
    const [{ t }] = await sqlOf<{ t: number }>(
      "select away_since as t from agents where native_ref = ?",
      ref,
    );
    const { r } = await list(snd, "snd");
    expect(r.agents.find((a) => a.bus_name === name)).toMatchObject({
      state: "away",
      since: new Date(t).toISOString(),
    });
    const om = await machine("Old");
    const old = await connect(om.token, undefined);
    await reg(old, "oldsnd", uniq("Old"), n);
    const { r: r2, raw } = await list(old, "oldsnd");
    expect(r2.agents.some((a) => a.bus_name === name)).toBe(false);
    expect(JSON.stringify(raw)).not.toContain('"away"');
    expect(JSON.stringify(raw)).not.toContain('"since"');
    rcv.close();
    snd.close();
    old.close();
  });

  const upReplacing = (ref: string, name: string, n: string, old: string) =>
    ({ ...up(id("u"), ref, name, n), replaces: old }) as ClientFrame;

  it("/clear: a new ref that replaces the old one keeps its name and its mail (live or away)", async () => {
    for (const away of [false, true]) {
      const { rcv, snd, n, ref, name } = await trio(MB);
      if (away) await close(rcv, ref);
      const r = await send(snd, "snd", name);
      expect(r.state).toBe("pending");
      const fresh = uniq("fresh");
      rcv.send(upReplacing(fresh, name, n, ref));
      expect((await waitFor(rcv, "agent_ok")).bus_name).toBe(name);
      const d = await waitFor(rcv, "deliver");
      expect(d.msg_id).toBe(r.msg_id);
      const rows = await sqlOf<{ c: number }>(
        "select count(*) as c from agents where native_ref in (?, ?)",
        ref,
        fresh,
      );
      expect(rows[0].c).toBe(1);
      rcv.close();
      snd.close();
    }
  });

  const owner = async (ref: string) =>
    (
      await sqlOf<{ c: number }>(
        "select count(*) as c from agents where native_ref = ?",
        ref,
      )
    )[0].c;

  it("a replaces from another machine is ignored: the new ref gets -2 and the old row stays", async () => {
    const { rcv, snd, n, ref, name } = await trio(MB);
    const om = await machine("Other");
    const other = await connect(om.token, MB);
    other.send(upReplacing(uniq("x"), name, n, ref));
    expect((await waitFor(other, "agent_ok")).bus_name).toBe(`${name}-2`);
    expect(await owner(ref)).toBe(1);
    rcv.close();
    snd.close();
    other.close();
  });

  it("a replaces on the same machine whose hello lacks the mailbox cap is ignored", async () => {
    await setClock(base());
    const n = ns("mw");
    const rm = await machine("Rcv");
    const first = await connect(rm.token, MB);
    const ref = uniq("r");
    const name = await reg(first, ref, uniq("Rcv"), n);
    first.close();
    // The same machine reconnects with a hello that lists ids only.
    const same = await connect(rm.token, [BUS_CAPS.ids]);
    same.send(upReplacing(uniq("y"), name, n, ref));
    expect((await waitFor(same, "agent_ok")).bus_name).toBe(`${name}-2`);
    expect(await owner(ref)).toBe(1);
    same.close();
  });

  it("a replaces onto a ref the hub already knows changes nothing", async () => {
    const { rcv, snd, n, ref, name } = await trio(MB);
    const known = uniq("known");
    const knownName = await reg(rcv, known, uniq("Known"), n);
    rcv.send(upReplacing(known, knownName, n, ref));
    expect((await waitFor(rcv, "agent_ok")).bus_name).toBe(knownName);
    expect(await owner(ref)).toBe(1);
    expect(await owner(known)).toBe(1);
    const r = await send(snd, "snd", name);
    expect(r.state).toBe("pending");
    rcv.close();
    snd.close();
  });

  it("a socket that listed ids only sees none of the new keys, values or states", async () => {
    const { rcv, snd, ref, name, n } = await trio([BUS_CAPS.ids]);
    await close(rcv, ref);
    // Away: queued/since are not shown; the roster has no away row.
    const fid = id("s");
    snd.send({
      v: 1,
      id: fid,
      type: "send",
      from_ref: "snd",
      to_name: name,
      body: "hi",
    } as ClientFrame);
    await waitFor(snd, "receipt");
    const rc = rawFor(snd, fid);
    expect(rc).toMatchObject({ state: "pending" });
    expect(rc).not.toHaveProperty("queued");
    expect(rc).not.toHaveProperty("since");
    const { raw } = await list(snd, "snd");
    expect(JSON.stringify(raw)).not.toMatch(/"away"|"since"/);
    // A moved name and a full mailbox read as the old reasons.
    const moved = await reg(snd, "snd2", uniq("Mv"), n);
    snd.send(up(id("u"), "snd2", moved, ns("mwm")));
    await waitFor(snd, "agent_ok");
    expect(await send(snd, "snd", moved)).toMatchObject({
      reason: "unknown_agent",
    });
    expect(snd.raw.join("\n").match(/mailbox_full|reserved_name/)).toBeNull();
    rcv.close();
    snd.close();
  });

  it("a resend of a send to an away agent repeats queued and since", async () => {
    const { rcv, snd, ref, name } = await trio(MB);
    await close(rcv, ref);
    const fid = id("s");
    const frame = {
      v: 1,
      id: fid,
      type: "send",
      from_ref: "snd",
      to_name: name,
      body: "hi",
    } as ClientFrame;
    snd.send(frame);
    const first = await receiptFor(snd, fid);
    snd.send(frame);
    const again = await receiptFor(snd, fid);
    expect(again.msg_id).toBe(first.msg_id);
    expect(again).toMatchObject({ state: "pending", queued: "away" });
    expect(again.since).toBe(first.since);
    rcv.close();
    snd.close();
  });

  it("the dashboard snapshot omits an away agent (the dashboard shows them in part C); the roster keeps it", async () => {
    const { rcv, snd, ref, name, n } = await trio(MB);
    await close(rcv, ref);
    const { agents } = await (await hubOf()).snapshot();
    expect(agents.find((a) => a.name === name)).toBeUndefined();
    const { r } = await list(snd, "snd");
    expect(r.agents.find((a) => a.bus_name === name)).toMatchObject({
      state: "away",
    });
    expect(
      agents.find((a) => a.namespace === n && a.name.startsWith("Snd")),
    ).toMatchObject({
      state: "live",
      running: true,
      since: null,
    });
    rcv.close();
    snd.close();
  });

  it("/clear while the old session is live: its acked notice bodies are gone, its pending mail still arrives", async () => {
    const { rcv, snd, n, ref, name } = await trio(MB);
    const big = "z".repeat(40_000);
    const first = await send(snd, "snd", name, big);
    const d1 = await waitFor(rcv, "deliver");
    expect(d1.msg_id).toBe(first.msg_id);
    rcv.send({ v: 1, id: id("ak"), type: "ack", msg_id: first.msg_id });
    for (let k = 0; k < 400; k++) {
      const st = await sqlOf<{ state: string }>(
        "select state from receipts where id = ?",
        first.msg_id,
      );
      if (st[0]?.state === "delivered") break;
      await new Promise((res) => setTimeout(res, 5));
    }
    const second = await send(snd, "snd", name, "still pending");
    await waitFor(rcv, "deliver");
    const fresh = uniq("fresh");
    rcv.send(upReplacing(fresh, name, n, ref));
    expect((await waitFor(rcv, "agent_ok")).bus_name).toBe(name);
    const again = await waitFor(rcv, "deliver");
    expect(again.msg_id).toBe(second.msg_id);
    rcv.send({
      v: 1,
      id: id("f"),
      type: "fetch",
      from_ref: fresh,
      msg_id: first.msg_id,
    } as ClientFrame);
    expect((await waitFor(rcv, "error")).code).toBe("not_found");
    rcv.close();
    snd.close();
  });
});
