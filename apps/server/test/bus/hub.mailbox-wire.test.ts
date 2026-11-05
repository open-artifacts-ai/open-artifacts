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

  it("a replaces without the mailbox cap, from another machine, or onto a known ref is ignored: the new ref gets -2", async () => {
    const { rcv, snd, n, ref, name } = await trio(MB);
    // Another machine's agent cannot take over this address.
    const om = await machine("Other");
    const other = await connect(om.token, MB);
    expect(
      await (async () => {
        other.send(upReplacing(uniq("x"), name, n, ref));
        return (await waitFor(other, "agent_ok")).bus_name;
      })(),
    ).toBe(`${name}-2`);
    // The same machine without the cap in its hello.
    const nm = await machine("NoCap");
    const nocap = await connect(nm.token, undefined);
    nocap.send(upReplacing(uniq("y"), name, n, ref));
    expect((await waitFor(nocap, "agent_ok")).bus_name).toBe(`${name}-3`);
    expect(
      (
        await sqlOf<{ c: number }>(
          "select count(*) as c from agents where native_ref = ?",
          ref,
        )
      )[0].c,
    ).toBe(1);
    rcv.close();
    snd.close();
    other.close();
    nocap.close();
  });

  it("the dashboard snapshot lists an away agent: state away, not running, since its close", async () => {
    const { rcv, snd, ref, name, n } = await trio(MB);
    await close(rcv, ref);
    const [{ t }] = await sqlOf<{ t: number }>(
      "select away_since as t from agents where native_ref = ?",
      ref,
    );
    const { agents } = await (await hubOf()).snapshot();
    expect(agents.find((a) => a.name === name)).toMatchObject({
      state: "away",
      running: false,
      since: new Date(t).toISOString(),
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
