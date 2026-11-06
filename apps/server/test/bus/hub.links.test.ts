// #1567 PR 1: project links on the hub. A `grants` link joins two of the
// member's namespaces, directly only. A links-capable socket then sees the
// linked namespaces' agents in its roster and reaches them by name (with or
// without `to_namespace`); any other socket keeps today's isolation. The
// refusal for a namespace that is not linked is the one it has always been.
import { runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  LIMITS,
  type ServerFrame,
} from "@oa/bus-protocol";
import { BUS_LINK_MAX, BUS_LINKS_PER_NAMESPACE } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import { addLink, linkedNamespaces, removeLink } from "../../src/bus/links.js";
import {
  type Daemon,
  daemon,
  hubOf,
  inOwnerHub,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
type Receipt = Extract<ServerFrame, { type: "receipt" }>;
type Roster = Extract<ServerFrame, { type: "roster" }>;

async function connect(caps: string[] | undefined): Promise<Daemon> {
  const m = await machine("MacBook");
  const d = await daemon(m.token);
  d.send({
    v: 1,
    id: `h${++seq}`,
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
    ...(caps === undefined ? {} : { caps }),
  });
  await waitFor(d, "hello_ok");
  return d;
}
const LINKED = [BUS_CAPS.links, BUS_CAPS.ids, BUS_CAPS.mailbox];

async function agent(d: Daemon, ref: string, name: string, namespace: string) {
  d.send(up(`u${++seq}`, ref, name, namespace));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

async function send(
  d: Daemon,
  from: string,
  to: string,
  to_namespace?: string,
): Promise<Receipt> {
  const id = `s${++seq}`;
  d.send({
    v: 1,
    id,
    type: "send",
    from_ref: from,
    to_name: to,
    body: "hi",
    ...(to_namespace === undefined ? {} : { to_namespace }),
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === id) return f;
  }
}

async function list(d: Daemon, from: string): Promise<Roster["agents"]> {
  const id = `l${++seq}`;
  d.send({ v: 1, id, type: "list", from_ref: from });
  for (;;) {
    const f = await waitFor(d, "roster");
    if (f.id === id) return f.agents;
  }
}

const link = async (a: string, b: string) => {
  const r = await (await hubOf()).putLink(a, b);
  expect(r.ok).toBe(true);
  return r;
};

/** Strips the per-call ids so two refusals compare byte for byte. */
const shape = (r: Receipt) => {
  const { id: _i, msg_id: _m, ...rest } = r;
  return JSON.stringify(rest);
};

describe("links store (#1567)", () => {
  it("stores a sorted pair once, reads it both ways, never transitively", async () => {
    const [a, b, c] = [ns("la"), ns("lb"), ns("lc")];
    await inOwnerHub((s) => {
      const sql = s.storage.sql;
      let n = 0;
      const mk = () => `g${++n}-${seq}`;
      expect(addLink(sql, "o", b, a, 1, mk).ok).toBe(true);
      // The same pair the other way round is the same link.
      const again = addLink(sql, "o", a, b, 2, mk);
      expect(again.ok && again.link.a < again.link.b).toBe(true);
      expect(addLink(sql, "o", b, c, 3, mk).ok).toBe(true);
      expect(linkedNamespaces(sql, "o", a)).toEqual([b]);
      expect(linkedNamespaces(sql, "o", b).sort()).toEqual([a, c].sort());
      expect(linkedNamespaces(sql, "o", c)).toEqual([b]);
      expect(
        sql.exec("select count(*) as n from grants where org_id = 'o'").one(),
      ).toEqual({ n: 2 });
    });
  });

  it("refuses the same namespace twice and non-canonical namespaces", async () => {
    const a = ns("lx");
    await inOwnerHub((s) => {
      const sql = s.storage.sql;
      expect(addLink(sql, "o2", a, a, 1, () => "x")).toEqual({
        ok: false,
        reason: "invalid",
        field: "namespaces",
      });
      expect(addLink(sql, "o2", "Not Canonical", a, 1, () => "x")).toEqual({
        ok: false,
        reason: "invalid",
        field: "a",
      });
      expect(addLink(sql, "o2", a, "bad ns", 1, () => "x")).toEqual({
        ok: false,
        reason: "invalid",
        field: "b",
      });
    });
  });

  it("caps links per member and lets an existing pair through at the cap", async () => {
    expect(BUS_LINK_MAX).toBe(100);
    await inOwnerHub((s) => {
      const sql = s.storage.sql;
      let n = 0;
      const mk = () => `c${++n}`;
      const hub = ns("cap");
      for (let i = 0; i < 3; i++)
        expect(addLink(sql, "o3", hub, `${hub}/${i}`, 1, mk, 3).ok).toBe(true);
      expect(addLink(sql, "o3", hub, `${hub}/9`, 1, mk, 3)).toEqual({
        ok: false,
        reason: "link_limit",
      });
      expect(addLink(sql, "o3", hub, `${hub}/1`, 1, mk, 3).ok).toBe(true);
    });
  });

  it("caps links per namespace", async () => {
    expect(BUS_LINKS_PER_NAMESPACE).toBe(10);
    await inOwnerHub((s) => {
      const sql = s.storage.sql;
      let n = 0;
      const mk = () => `p${++n}`;
      const hub = ns("pn");
      for (let i = 0; i < 3; i++)
        expect(addLink(sql, "o5", hub, `${hub}/${i}`, 1, mk, 100, 3).ok).toBe(
          true,
        );
      // The hub namespace is full, from either side.
      expect(addLink(sql, "o5", hub, `${hub}/9`, 1, mk, 100, 3)).toEqual({
        ok: false,
        reason: "link_limit",
      });
      expect(addLink(sql, "o5", `${hub}/9`, hub, 1, mk, 100, 3)).toEqual({
        ok: false,
        reason: "link_limit",
      });
      // An existing pair still passes; unrelated namespaces are unaffected.
      expect(addLink(sql, "o5", hub, `${hub}/1`, 1, mk, 100, 3).ok).toBe(true);
      expect(addLink(sql, "o5", `${hub}/8`, `${hub}/9`, 1, mk, 100, 3).ok).toBe(
        true,
      );
    });
  });

  it("removeLink returns the pair once, then null", async () => {
    await inOwnerHub((s) => {
      const sql = s.storage.sql;
      const [a, b] = [ns("ra"), ns("rb")];
      const r = addLink(sql, "o4", a, b, 1, () => "rid");
      expect(r.ok).toBe(true);
      expect(removeLink(sql, "o4", "rid")).toEqual({
        a: a < b ? a : b,
        b: a < b ? b : a,
      });
      expect(removeLink(sql, "o4", "rid")).toBeNull();
    });
  });

  it("wipe() deletes the links", async () => {
    const [a, b] = [ns("wa"), ns("wb")];
    const hub = await hubOf();
    await link(a, b);
    expect(await hub.listLinks()).not.toHaveLength(0);
    await hub.wipe();
    expect(await hub.listLinks()).toEqual([]);
  });

  it("the hub's own limit applies through putLink", async () => {
    const hub = await hubOf();
    await runInDurableObject(hub, (i) => BusHub.setMaxLinksForTests(i, 1));
    try {
      await hub.wipe();
      await link(ns("m1"), ns("m2"));
      expect(await hub.putLink(ns("m3"), ns("m4"))).toEqual({
        ok: false,
        reason: "link_limit",
      });
    } finally {
      await runInDurableObject(hub, (i) => BusHub.setMaxLinksForTests(i, null));
      await hub.wipe();
    }
  });
});

describe("routing across a link (#1567)", () => {
  it("a linked name resolves, with and without to_namespace; a reply goes back", async () => {
    const [a, b] = [ns("ra"), ns("rb")];
    const d = await connect(LINKED);
    const me = uniq("me");
    const peer = uniq("peer");
    await agent(d, "me", me, a);
    await agent(d, "peer", peer, b);
    // Not linked yet: the name is unknown, an explicit namespace is refused.
    expect(await send(d, "me", peer)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await send(d, "me", peer, b)).toMatchObject({
      state: "refused",
      reason: "other_namespace",
    });
    await link(a, b);
    expect(await send(d, "me", peer)).toMatchObject({ state: "pending" });
    expect(await send(d, "me", peer, b)).toMatchObject({ state: "pending" });
    // The recipient replies by name with the delivered namespace.
    expect(await send(d, "peer", me, a)).toMatchObject({ state: "pending" });
    expect(await send(d, "peer", me)).toMatchObject({ state: "pending" });
    d.close();
  });

  it("the same name in two linked namespaces is ambiguous; to_namespace picks; own wins", async () => {
    const [a, b, c] = [ns("aa"), ns("ab"), ns("ac")];
    const d = await connect(LINKED);
    const dup = uniq("dup");
    await agent(d, "me", uniq("me"), a);
    await agent(d, "b", dup, b);
    await agent(d, "c", dup, c);
    await link(a, b);
    await link(a, c);
    expect(await send(d, "me", dup)).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    expect(await send(d, "me", dup, b)).toMatchObject({ state: "pending" });
    expect(await send(d, "me", dup, c)).toMatchObject({ state: "pending" });
    // The same name in the sender's own namespace wins, unchanged.
    await agent(d, "own", dup, a);
    const r = await send(d, "me", dup);
    expect(r).toMatchObject({ state: "pending" });
    d.close();
  });

  it("the sender's own namespace wins completely: away, held and an explicit own to_namespace never reach a linked agent", async () => {
    const [a, b] = [ns("wa"), ns("wb")];
    const d = await connect(LINKED);
    const awayName = uniq("awayname");
    const heldName = uniq("heldname");
    const onlyB = uniq("onlyb");
    await agent(d, "me", uniq("me"), a);
    await agent(d, "own", awayName, a);
    await agent(d, "bl", awayName, b);
    await agent(d, "bh", heldName, b);
    await agent(d, "bo", onlyB, b);
    d.send({
      v: 1,
      id: `c${++seq}`,
      type: "sessions",
      open: [],
      closed: ["own"],
    });
    for (let k = 0; k < 400; k++) {
      const r = await inOwnerHub((s) =>
        s.storage.sql
          .exec(
            "select count(*) as n from agents where name = ? and namespace = ? and live = 0",
            awayName,
            a,
          )
          .one(),
      );
      if (r.n === 1) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await inOwnerHub((s) =>
      s.storage.sql.exec(
        "insert into former_names (agent_id, org_id, name, lname, kind, expires_at, namespace, global) values ('ghost', 'owner', ?, ?, 'held', ?, ?, 0)",
        heldName,
        heldName.toLowerCase(),
        Date.now() + 3_600_000,
        a,
      ),
    );
    await link(a, b);
    // Own away + linked live: queued in A's mailbox, with or without to_namespace.
    const away = await inOwnerHub((s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where name = ? and namespace = ? and live = 0",
          awayName,
          a,
        )
        .one(),
    );
    for (const to of [undefined, a]) {
      const r = await send(d, "me", awayName, to);
      expect(r, String(to)).toMatchObject({ state: "pending", queued: "away" });
      const got = await inOwnerHub((s) =>
        s.storage.sql
          .exec<{ to_agent: string }>(
            "select to_agent from receipts where id = ?",
            r.msg_id,
          )
          .one(),
      );
      expect(got.to_agent).toBe(away.id);
    }
    // Own held + linked live: today's own-namespace refusal.
    expect(await send(d, "me", heldName)).toMatchObject({
      state: "refused",
      reason: "reserved_name",
    });
    // An explicit own to_namespace never looks in a linked one.
    expect(await send(d, "me", onlyB, a)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await send(d, "me", onlyB)).toMatchObject({ state: "pending" });
    d.close();
  });

  it("links are not transitive: with A-B and B-C, A to C is other_namespace", async () => {
    const [a, b, c] = [ns("ta"), ns("tb"), ns("tc")];
    const d = await connect(LINKED);
    const far = uniq("far");
    await agent(d, "a", uniq("a"), a);
    await agent(d, "b", uniq("b"), b);
    await agent(d, "c", far, c);
    await link(a, b);
    await link(b, c);
    expect(await send(d, "a", far, c)).toMatchObject({
      state: "refused",
      reason: "other_namespace",
    });
    expect(await send(d, "a", far)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await list(d, "a")).toHaveLength(2);
    d.close();
  });

  it("the refusal for a namespace that is not linked is byte-identical to today's", async () => {
    const [a, b, c] = [ns("ia"), ns("ib"), ns("ic")];
    const old = await connect([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    const cap = await connect(LINKED);
    const name = uniq("there");
    await agent(old, "old", uniq("old"), a);
    await agent(cap, "cap", uniq("cap"), a);
    await agent(cap, "t", name, c);
    await agent(cap, "u", uniq("u"), b);
    await link(a, b);
    // c exists with the name; the other name does not exist anywhere.
    const present = await send(cap, "cap", name, c);
    const absent = await send(cap, "cap", uniq("nobody"), c);
    const was = await send(old, "old", name, c);
    expect(present).toMatchObject({ reason: "other_namespace" });
    expect(shape(present)).toBe(shape(absent));
    expect(shape(present)).toBe(shape(was));
    // And without to_namespace, a name only a non-linked namespace holds.
    const un = await send(cap, "cap", name);
    expect(shape(un)).toBe(shape(await send(old, "old", name)));
    old.close();
    cap.close();
  });

  it("a socket without the cap sees no linked rows and cannot route across", async () => {
    const [a, b] = [ns("oa"), ns("ob")];
    const old = await connect([BUS_CAPS.ids]);
    const peer = uniq("peer");
    await agent(old, "me", uniq("me"), a);
    await agent(old, "peer", peer, b);
    await link(a, b);
    expect((await list(old, "me")).map((r) => r.namespace)).toEqual([a]);
    expect(await send(old, "me", peer)).toMatchObject({
      reason: "unknown_agent",
    });
    expect(await send(old, "me", peer, b)).toMatchObject({
      reason: "other_namespace",
    });
    old.close();
  });

  it("hello_ok lists links to a hello that listed it", async () => {
    const m = await machine("MacBook");
    const d = await daemon(m.token);
    d.send({
      v: 1,
      id: "h",
      type: "hello",
      machine_label: "MacBook",
      client_version: "0.0.0",
      caps: [BUS_CAPS.links],
    });
    expect((await waitFor(d, "hello_ok")).caps).toContain(BUS_CAPS.links);
    d.close();
  });
});

describe("roster across a link (#1567)", () => {
  it("lists own rows first, then linked ones, each with its namespace", async () => {
    const [a, b, c] = [ns("ma"), ns("mb"), ns("mc")];
    const d = await connect(LINKED);
    // Names sort the other way round, so order comes from the scope.
    await agent(d, "me", "zz-me", a);
    await agent(d, "own2", "zz-own", a);
    await agent(d, "b1", "aa-b", b);
    await agent(d, "c1", "aa-c", c);
    await link(a, b);
    const rows = await list(d, "me");
    expect(rows.map((r) => [r.namespace, r.bus_name])).toEqual([
      [a, "zz-me"],
      [a, "zz-own"],
      [b, "aa-b"],
    ]);
    d.close();
  });

  it("includes the linked namespaces' away rows for a mailbox socket only", async () => {
    const [a, b, c] = [ns("ya"), ns("yb"), ns("yc")];
    const d = await connect(LINKED);
    const away = uniq("away");
    const farAway = uniq("faraway");
    await agent(d, "me", uniq("me"), a);
    await agent(d, "away", away, b);
    await agent(d, "far", farAway, c);
    d.send({
      v: 1,
      id: `c${++seq}`,
      type: "sessions",
      open: [],
      closed: ["away", "far"],
    });
    for (let k = 0; k < 400; k++) {
      const r = await inOwnerHub((s) =>
        s.storage.sql
          .exec(
            "select count(*) as n from agents where name in (?, ?) and live = 0",
            away,
            farAway,
          )
          .one(),
      );
      if (r.n === 2) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await link(a, b);
    const rows = await list(d, "me");
    expect(rows.find((r) => r.bus_name === away)).toMatchObject({
      namespace: b,
      state: "away",
    });
    // A namespace that is not linked stays out, away or not.
    expect(rows.some((r) => r.bus_name === farAway)).toBe(false);
    // A send to the away linked agent queues in its mailbox.
    expect(await send(d, "me", away)).toMatchObject({
      state: "pending",
      queued: "away",
    });
    const nomb = await connect([BUS_CAPS.links]);
    await agent(nomb, "me2", uniq("me2"), a);
    expect((await list(nomb, "me2")).some((r) => r.bus_name === away)).toBe(
      false,
    );
    nomb.close();
    d.close();
  });

  it("caps the merged roster with the own namespace first", async () => {
    expect(LIMITS.maxRosterAgents).toBeGreaterThan(2);
    const [a, b] = [ns("ka"), ns("kb")];
    const d = await connect(LINKED);
    await agent(d, "me", "zz-me", a);
    await agent(d, "b1", "aa-b", b);
    await link(a, b);
    const rows = await list(d, "me");
    expect(rows[0]?.namespace).toBe(a);
    d.close();
  });
});

describe("roster_changed fans out across a link (#1567)", () => {
  const changed = (d: Daemon) =>
    d.raw.filter((t) => t.includes('"roster_changed"'));

  it("a change in a linked namespace reaches the other side, and a link change reaches both", async () => {
    const [a, b] = [ns("fa"), ns("fb")];
    const da = await connect(LINKED);
    const db = await connect(LINKED);
    await agent(da, "a", uniq("a"), a);
    await agent(db, "b", uniq("b"), b);
    // Creating the link tells both sides.
    const beforeA = changed(da).length;
    const beforeB = changed(db).length;
    await link(a, b);
    await waitUntil(
      () => changed(da).length > beforeA && changed(db).length > beforeB,
    );
    expect(changed(da).at(-1)).toContain(a);
    expect(changed(db).at(-1)).toContain(b);
    // A new agent in b is news to the machine hosting a.
    const seen = changed(da).length;
    await agent(db, "b2", uniq("b2"), b);
    await waitUntil(() => changed(da).length > seen);
    expect(changed(da).at(-1)).toContain(a);
    // Removing the link tells both again.
    const hub = await hubOf();
    const l = (await hub.listLinks()).find((x) => x.a === a || x.b === a);
    const rA = changed(da).length;
    const rB = changed(db).length;
    expect(await hub.deleteLink(l?.id ?? "")).toBe(true);
    await waitUntil(() => changed(da).length > rA && changed(db).length > rB);
    expect(await hub.deleteLink(l?.id ?? "")).toBe(false);
    da.close();
    db.close();
  });

  it("an old-cap machine hears nothing extra across a link", async () => {
    const [a, b] = [ns("oa"), ns("ob")];
    const da = await connect(LINKED);
    const old = await connect([BUS_CAPS.ids]);
    await agent(da, "a", uniq("a"), a);
    await agent(old, "b", uniq("b"), b);
    const seen = changed(old).length;
    await link(a, b);
    await agent(da, "a2", uniq("a2"), a);
    await list(old, "b");
    await list(da, "a");
    expect(changed(old).length).toBe(seen);
    da.close();
    old.close();
  });

  it("without a link, a change in one namespace is silent to the other", async () => {
    const [a, b] = [ns("na"), ns("nb")];
    const da = await connect(LINKED);
    const db = await connect(LINKED);
    await agent(da, "a", uniq("a"), a);
    await agent(db, "b", uniq("b"), b);
    const seen = changed(da).length;
    await agent(db, "b2", uniq("b2"), b);
    // Frames on one socket are in order: a round trip on da proves the wait.
    await list(da, "a");
    expect(changed(da).length).toBe(seen);
    da.close();
    db.close();
  });
});

async function waitUntil(ok: () => boolean) {
  for (let i = 0; i < 400 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(ok()).toBe(true);
}
