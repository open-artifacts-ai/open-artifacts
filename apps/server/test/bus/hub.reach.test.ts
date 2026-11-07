// #1346 PR 1: scoped role reach on the hub. A `reach_grants` row lets a role
// reach other namespaces: its live holder sees and messages the agents there,
// and they reply to it, only on sockets whose hello listed BUS_CAPS.reach.
// Nothing else in the target namespace sees the holder, and reach is never
// transitive. Rows are written through the hub's Worker-only putReach (as
// hub.links.test.ts uses putLink); no frame writes one.
import { BUS_CAPS, type ClientFrame, type ServerFrame } from "@oa/bus-protocol";
import { BUS_REACH_MAX, BUS_REACH_PER_ROLE } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { OWNER_ORG_ID } from "../../src/bus/hub.js";
import { addReach, reachNamespaces } from "../../src/bus/reach.js";
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
type Deliver = Extract<ServerFrame, { type: "deliver" }>;

const REACH = [BUS_CAPS.reach, BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.rename];

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

async function agent(d: Daemon, ref: string, name: string, namespace: string) {
  d.send(up(`u${++seq}`, ref, name, namespace));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

async function send(
  d: Daemon,
  from: string,
  to: string,
  to_namespace?: string,
  to_id?: string,
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
    ...(to_id === undefined ? {} : { to_id }),
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

const idOf = async (name: string): Promise<string> => {
  const a = (await (await hubOf()).snapshot()).agents.find(
    (x) => x.name === name,
  );
  if (!a) throw new Error(`no open agent ${name}`);
  return a.id;
};

/** Makes `holder` hold role `role` in `namespace`. */
const holds = async (namespace: string, role: string, holder: string) => {
  const r = await (await hubOf()).putRole(namespace, role, await idOf(holder));
  if (!r.ok) throw new Error(`putRole refused: ${r.reason}`);
};

const reach = async (roleNs: string, role: string, target: string) => {
  const r = await (await hubOf()).putReach(roleNs, role, target);
  expect(r.ok).toBe(true);
  return r;
};

const names = (rows: Roster["agents"]) => rows.map((r) => r.bus_name).sort();
const shape = (r: Receipt) => {
  const { id: _i, msg_id: _m, ...rest } = r;
  return JSON.stringify(rest);
};
const changed = (d: Daemon) =>
  d.raw.filter((t) => t.includes('"roster_changed"'));
async function waitUntil(ok: () => boolean) {
  for (let i = 0; i < 400 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(ok()).toBe(true);
}

/**
 * X holds `holder` (role `lead`, reaching Y) and `peer`; Y holds `bob` and
 * `carol`. Each agent has its own reach-capable socket.
 */
async function world(caps: string[] = REACH) {
  const [x, y] = [ns("rx"), ns("ry")];
  const [hn, pn, bn, cn] = [
    uniq("holder"),
    uniq("peer"),
    uniq("bob"),
    uniq("carol"),
  ];
  const dh = await connect(caps);
  const dp = await connect(caps);
  const db = await connect(caps);
  const dc = await connect(caps);
  await agent(dh, "h", hn, x);
  await agent(dp, "p", pn, x);
  await agent(db, "b", bn, y);
  await agent(dc, "c", cn, y);
  await holds(x, "lead", hn);
  await reach(x, "lead", y);
  const close = () => {
    for (const d of [dh, dp, db, dc]) d.close();
  };
  return { x, y, hn, pn, bn, cn, dh, dp, db, dc, close };
}

describe("reach out", () => {
  it("lists the target namespace's agents for the holder, with their own namespace, own first", async () => {
    const w = await world();
    const rows = await list(w.dh, "h");
    expect(names(rows)).toEqual([w.hn, w.pn, w.bn, w.cn].sort());
    expect(rows.find((r) => r.bus_name === w.bn)?.namespace).toBe(w.y);
    expect(rows[0]?.namespace).toBe(w.x);
    w.close();
  });

  it("sends by name, with or without to_namespace", async () => {
    const w = await world();
    expect((await send(w.dh, "h", w.bn)).state).toBe("pending");
    expect(((await waitFor(w.db, "deliver")) as Deliver).from_name).toBe(w.hn);
    expect((await send(w.dh, "h", w.cn, w.y)).state).toBe("pending");
    w.close();
  });

  it("the HUB_CAPS echo lists reach to a reach hello", async () => {
    const m = await machine("MacBook");
    const d = await daemon(m.token);
    d.send({
      v: 1,
      id: `h${++seq}`,
      type: "hello",
      machine_label: "MacBook",
      client_version: "0.0.0",
      caps: [BUS_CAPS.reach],
    });
    expect((await waitFor(d, "hello_ok")).caps).toContain(BUS_CAPS.reach);
    d.close();
  });
});

describe("replies", () => {
  it("the target answers the holder by name with to_namespace, and by to_id", async () => {
    const w = await world();
    await send(w.dh, "h", w.bn);
    const got = (await waitFor(w.db, "deliver")) as Deliver;
    // By name, naming the holder's namespace.
    expect((await send(w.db, "b", w.hn, w.x)).state).toBe("pending");
    expect(((await waitFor(w.dh, "deliver")) as Deliver).from_name).toBe(w.bn);
    // By to_id: the id does not skip the namespace check; with the namespace
    // it reaches only that agent.
    expect((await send(w.db, "b", w.hn, w.x, got.from_id)).state).toBe(
      "pending",
    );
    // Without the namespace the name is not in Y: refused, as it always was.
    const bare = await send(w.db, "b", w.hn, undefined, got.from_id);
    expect(bare.state).toBe("refused");
    // A to_id of someone else is agent_gone.
    const other = await send(w.db, "b", w.hn, w.x, await idOf(w.pn));
    expect(other).toMatchObject({ state: "refused", reason: "agent_gone" });
    w.close();
  });

  it("only the specific holder, never the holder's namespace-mates", async () => {
    const w = await world();
    const peer = await send(w.db, "b", w.pn, w.x);
    expect(peer.state).toBe("refused");
    // The same refusal as an unrelated namespace gives.
    const none = await send(w.db, "b", w.pn, ns("elsewhere"));
    expect(shape(peer)).toBe(shape(none));
    w.close();
  });
});

describe("visibility", () => {
  it("the target namespace's agents do not see the holder in list_agents", async () => {
    const w = await world();
    expect(names(await list(w.db, "b"))).toEqual([w.bn, w.cn].sort());
    w.close();
  });

  it("is not transitive: the holder's peers do not reach Y, Y's agents do not reach X's others", async () => {
    const w = await world();
    expect(names(await list(w.dp, "p"))).toEqual([w.hn, w.pn].sort());
    expect((await send(w.dp, "p", w.bn)).reason).toBe("unknown_agent");
    expect((await send(w.dp, "p", w.bn, w.y)).reason).toBe("other_namespace");
    // Y's role reaching Z gives X's holder nothing in Z.
    const z = ns("rz");
    const dz = await connect(REACH);
    const zn = uniq("zed");
    await agent(dz, "z", zn, z);
    await holds(w.y, "chief", w.bn);
    await reach(w.y, "chief", z);
    expect((await send(w.dh, "h", zn)).reason).toBe("unknown_agent");
    expect(names(await list(w.dh, "h"))).not.toContain(zn);
    dz.close();
    w.close();
  });
});

describe("resolution", () => {
  it("own namespace first", async () => {
    const w = await world();
    const twin = uniq("twin");
    const dt = await connect(REACH);
    const dt2 = await connect(REACH);
    await agent(dt, "t", twin, w.x);
    await agent(dt2, "t2", twin, w.y);
    expect((await send(w.dh, "h", twin)).state).toBe("pending");
    expect(((await waitFor(dt, "deliver")) as Deliver).from_name).toBe(w.hn);
    dt.close();
    dt2.close();
    w.close();
  });

  it("a name in two reached namespaces is ambiguous until to_namespace names one", async () => {
    const w = await world();
    const z = ns("rz");
    await reach(w.x, "lead", z);
    const dup = uniq("dup");
    const d1 = await connect(REACH);
    const d2 = await connect(REACH);
    await agent(d1, "d1", dup, w.y);
    await agent(d2, "d2", dup, z);
    expect((await send(w.dh, "h", dup)).reason).toBe("ambiguous");
    expect((await send(w.dh, "h", dup, z)).state).toBe("pending");
    d1.close();
    d2.close();
    w.close();
  });
});

describe("the role is the key", () => {
  it("a vacated role gives no reach but keeps its grants; a new holder gets them", async () => {
    const w = await world();
    expect((await send(w.dh, "h", w.bn)).state).toBe("pending");
    const hub = await hubOf();
    expect((await hub.putRole(w.x, "lead", null)).ok).toBe(true);
    expect((await send(w.dh, "h", w.bn)).reason).toBe("unknown_agent");
    expect(names(await list(w.dh, "h"))).toEqual([w.hn, w.pn].sort());
    expect((await hub.listReach()).some((g) => g.roleNamespace === w.x)).toBe(
      true,
    );
    // Re-pointed to another agent, the reach works again.
    await holds(w.x, "lead", w.pn);
    expect((await send(w.dp, "p", w.bn)).state).toBe("pending");
    expect((await send(w.dh, "h", w.bn)).reason).toBe("unknown_agent");
    w.close();
  });

  it("a role moved to a new holder takes the reach along", async () => {
    const w = await world();
    await holds(w.x, "lead", w.pn);
    expect((await send(w.dh, "h", w.bn)).reason).toBe("unknown_agent");
    expect((await send(w.dp, "p", w.bn)).state).toBe("pending");
    // And the reply rule follows: the old holder is no longer answerable.
    expect((await send(w.db, "b", w.hn, w.x)).state).toBe("refused");
    expect((await send(w.db, "b", w.pn, w.x)).state).toBe("pending");
    w.close();
  });

  it("a removed role takes its grants with it", async () => {
    const w = await world();
    const hub = await hubOf();
    const role = (await hub.listRoles()).find(
      (r) => r.namespace === w.x && r.name === "lead",
    );
    expect(await hub.deleteRole(role?.id ?? "")).toBe(true);
    expect((await hub.listReach()).some((g) => g.roleNamespace === w.x)).toBe(
      false,
    );
    expect((await send(w.dh, "h", w.bn)).reason).toBe("unknown_agent");
    w.close();
  });
});

describe("the holder is read from where it is now", () => {
  const reachOf = async (name: string) => {
    const id = await idOf(name);
    return inOwnerHub((st) =>
      reachNamespaces(st.storage.sql, OWNER_ORG_ID, id),
    );
  };

  it("a holder that moves to another namespace keeps no reach, either way", async () => {
    const w = await world();
    expect(await reachOf(w.hn)).toEqual([w.y]);
    const z = ns("rz");
    w.dh.send(up(`u${++seq}`, "h", w.hn, z));
    await waitFor(w.dh, "agent_ok");
    expect(await reachOf(w.hn)).toEqual([]);
    expect((await send(w.dh, "h", w.bn)).reason).toBe("unknown_agent");
    expect((await send(w.db, "b", w.hn, w.x)).state).toBe("refused");
    expect((await send(w.db, "b", w.hn, z)).state).toBe("refused");
    // Back home, the role reads held again and reach returns.
    w.dh.send(up(`u${++seq}`, "h", w.hn, w.x));
    await waitFor(w.dh, "agent_ok");
    expect(await reachOf(w.hn)).toEqual([w.y]);
    expect((await send(w.dh, "h", w.bn)).state).toBe("pending");
    w.close();
  });

  it("a holder that flips global loses reach until it flips back", async () => {
    const w = await world();
    w.dh.send(up(`u${++seq}`, "h", w.hn, w.x, true));
    await waitFor(w.dh, "agent_ok");
    expect(await reachOf(w.hn)).toEqual([]);
    w.dh.send(up(`u${++seq}`, "h", w.hn, w.x, false));
    await waitFor(w.dh, "agent_ok");
    expect(await reachOf(w.hn)).toEqual([w.y]);
    w.close();
  });
});

describe("the reply path by every name", () => {
  it("leaves mail for an away holder", async () => {
    const w = await world();
    w.dh.send({ v: 1, id: `d${++seq}`, type: "agent_down", agent_ref: "h" });
    await waitUntilAway(w);
    const r = await send(w.db, "b", w.hn, w.x);
    expect(r.state).not.toBe("refused");
    // The peer is not reachable the same way.
    expect((await send(w.db, "b", w.pn, w.x)).state).toBe("refused");
    w.close();
  });

  it("answers a pre-rename former name", async () => {
    const w = await world();
    const fresh = uniq("renamed");
    w.dh.send({
      v: 1,
      id: `r${++seq}`,
      type: "rename",
      agent_ref: "h",
      proposed_name: fresh,
      name_kind: "chosen",
    });
    await waitFor(w.dh, "renamed");
    expect((await send(w.db, "b", w.hn, w.x)).state).toBe("pending");
    expect((await send(w.db, "b", fresh, w.x)).state).toBe("pending");
    // A former name of the peer, who has no reach, stays refused.
    w.dp.send({
      v: 1,
      id: `r${++seq}`,
      type: "rename",
      agent_ref: "p",
      proposed_name: uniq("pr"),
      name_kind: "chosen",
    });
    await waitFor(w.dp, "renamed");
    expect((await send(w.db, "b", w.pn, w.x)).state).toBe("refused");
    w.close();
  });

  it("answers the role's own name", async () => {
    const w = await world();
    expect((await send(w.db, "b", "lead", w.x)).state).toBe("pending");
    // A role with no reach to Y is not an address from Y.
    await holds(w.x, "other", w.pn);
    expect((await send(w.db, "b", "other", w.x)).state).toBe("refused");
    w.close();
  });
});

async function waitUntilAway(w: { x: string; hn: string }) {
  const hub = await hubOf();
  for (let i = 0; i < 200; i++) {
    const open = (await hub.snapshot()).agents.some((a) => a.name === w.hn);
    if (!open) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("holder never went away");
}

describe("caps", () => {
  it("a holder on a socket without reach sees today's isolation", async () => {
    const w = await world([BUS_CAPS.ids]);
    expect(names(await list(w.dh, "h"))).toEqual([w.hn, w.pn].sort());
    expect((await send(w.dh, "h", w.bn)).reason).toBe("unknown_agent");
    w.close();
  });

  it("a target on a socket without reach cannot reply across", async () => {
    const w = await world();
    const old = await connect([BUS_CAPS.ids]);
    const on = uniq("old");
    await agent(old, "o", on, w.y);
    expect((await send(old, "o", w.hn, w.x)).reason).toBe("other_namespace");
    old.close();
    w.close();
  });
});

describe("live changes", () => {
  it("a grant and its removal reach the holder's machine at once, and only a reach-capable one", async () => {
    const [x, y] = [ns("lx"), ns("ly")];
    const [hn, bn] = [uniq("holder"), uniq("bob")];
    const dh = await connect(REACH);
    const oldh = await connect([BUS_CAPS.ids]);
    const db = await connect(REACH);
    await agent(dh, "h", hn, x);
    await agent(oldh, "o", uniq("oldx"), x);
    await agent(db, "b", bn, y);
    await holds(x, "lead", hn);
    const hub = await hubOf();
    const [before, beforeOld] = [changed(dh).length, changed(oldh).length];
    await reach(x, "lead", y);
    await waitUntil(() => changed(dh).length > before);
    expect(changed(dh).at(-1)).toContain(x);
    expect(names(await list(dh, "h"))).toContain(bn);
    // A change in Y reaches the holder's machine as its own namespace.
    const seen = changed(dh).length;
    const dc = await connect(REACH);
    await agent(dc, "c", uniq("carol"), y);
    await waitUntil(() => changed(dh).length > seen);
    expect(changed(dh).at(-1)).toContain(x);
    // Removal is live.
    const g = (await hub.listReach()).find((r) => r.roleNamespace === x);
    const rm = changed(dh).length;
    expect(await hub.deleteReach(g?.id ?? "")).toBe(true);
    await waitUntil(() => changed(dh).length > rm);
    expect(await hub.deleteReach(g?.id ?? "")).toBe(false);
    expect((await send(dh, "h", bn)).reason).toBe("unknown_agent");
    // The machine without the cap heard nothing extra.
    await list(oldh, "o");
    expect(changed(oldh).length).toBe(beforeOld);
    for (const d of [dh, oldh, db, dc]) d.close();
  });
});

describe("store and limits", () => {
  it("refuses an unknown role, a bad namespace and its own namespace", async () => {
    await inOwnerHub((s) => {
      const sql = s.storage.sql;
      const a = ns("sa");
      expect(addReach(sql, "o", a, "ghost", ns("sb"), 1, () => "i")).toEqual({
        ok: false,
        reason: "role_unknown",
      });
      expect(
        addReach(sql, "o", a, "ghost", "Not Canonical", 1, () => "i"),
      ).toEqual({
        ok: false,
        reason: "invalid",
        field: "target",
      });
      expect(addReach(sql, "o", a, "ghost", a, 1, () => "i")).toEqual({
        ok: false,
        reason: "invalid",
        field: "target",
      });
    });
  });

  it("caps grants per role and per hub; an existing grant passes at the cap", async () => {
    expect(BUS_REACH_MAX).toBe(200);
    expect(BUS_REACH_PER_ROLE).toBe(10);
    await inOwnerHub((s) => {
      const sql = s.storage.sql;
      const a = ns("la");
      let n = 0;
      const mk = () => `rl${++n}-${seq}`;
      for (const name of ["r1", "r2"])
        sql.exec(
          "insert into roles (id, org_id, namespace, name, lname, agent_id, set_at) values (?, 'oc', ?, ?, ?, null, 1)",
          `role-${name}-${a}`,
          a,
          name,
          name,
        );
      for (let i = 0; i < 3; i++)
        expect(addReach(sql, "oc", a, "r1", `${a}/${i}`, 1, mk, 5, 3).ok).toBe(
          true,
        );
      // The role is full; an existing target still passes.
      expect(addReach(sql, "oc", a, "r1", `${a}/9`, 1, mk, 5, 3)).toEqual({
        ok: false,
        reason: "reach_limit",
      });
      expect(addReach(sql, "oc", a, "r1", `${a}/1`, 1, mk, 5, 3)).toMatchObject(
        {
          ok: true,
          created: false,
        },
      );
      // Another role fills the hub (5 in all).
      expect(addReach(sql, "oc", a, "r2", `${a}/0`, 1, mk, 5, 3).ok).toBe(true);
      expect(addReach(sql, "oc", a, "r2", `${a}/1`, 1, mk, 5, 3).ok).toBe(true);
      expect(addReach(sql, "oc", a, "r2", `${a}/2`, 1, mk, 5, 3)).toEqual({
        ok: false,
        reason: "reach_limit",
      });
    });
  });

  it("the mode column only allows reach, so listed can come later without alter table", async () => {
    await inOwnerHub((s) => {
      expect(() =>
        s.storage.sql.exec(
          "insert into reach_grants (id, org_id, role_ns, role_name, lname, mode, target_ns, created_at) values ('m', 'om', 'a', 'r', 'r', 'listed', 'b', 1)",
        ),
      ).toThrow();
      expect(reachNamespaces(s.storage.sql, "om", "nobody")).toEqual([]);
    });
  });

  it("wipe() deletes the grants", async () => {
    const w = await world();
    w.close();
    const hub = await hubOf();
    expect((await hub.listReach()).length).toBeGreaterThan(0);
    await hub.wipe();
    expect(await hub.listReach()).toEqual([]);
  });
});
