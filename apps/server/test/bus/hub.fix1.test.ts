// Ported from OpenBus v0.63.0 apps/server/test/hub.fix1.test.ts (#1291).
// Dropped: nothing.
// B5 fix round 1: adversarial findings F1-F5 (adv-B5-report.md) and spec-review minors.
import {
  type ClientFrame,
  LIMITS,
  PONG,
  type ServerFrame,
} from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { OWNER_ORG_ID } from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
  hello,
  inOwnerHub,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

const list = (id: string, from_ref: string): ClientFrame => ({
  v: 1,
  id,
  type: "list",
  from_ref,
});
type Roster = Extract<ServerFrame, { type: "roster" }>;
const lowerNames = (r: Roster) => r.agents.map((a) => a.bus_name.toLowerCase());
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 20000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await tick(5);
  }
}
const changed = (d: Daemon) =>
  d.raw
    .filter((t) => t !== PONG && t.includes('"type":"roster_changed"'))
    .map((t) => (JSON.parse(t) as { namespace: string }).namespace);

function seedAgents(
  machineId: string,
  n: number,
  nsOf: (i: number) => string,
  global = false,
) {
  return inOwnerHub((s) => {
    for (let i = 0; i < n; i++)
      s.storage.sql.exec(
        `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
         values (?, ?, ?, ?, 'claude-code', ?, ?, ?, 1, 0)`,
        `s${machineId.slice(0, 6)}${i}`,
        OWNER_ORG_ID,
        nsOf(i),
        `Seed ${machineId.slice(0, 6)} ${i}`,
        machineId,
        `seed_${i}`,
        global ? 1 : 0,
      );
  });
}

describe("F1/F5: global names reserved everywhere, case-insensitive", () => {
  it("a non-global cannot shadow a live global (global first)", async () => {
    const d = await ready((await machine()).token);
    const n1 = ns();
    const n2 = ns();
    d.send(up("u1", "g", "Reviewer", n2, true));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("Reviewer");
    d.send(up("u2", "l", "reviewer", n1, false));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("reviewer-2");
    d.send(list("l1", "l"));
    const names = lowerNames(await waitFor(d, "roster"));
    expect(names.filter((x) => x === "reviewer")).toHaveLength(1);
    d.close();
  });

  it("a global cannot take a name live in another namespace (non-global first)", async () => {
    const d = await ready((await machine()).token);
    const n1 = ns();
    const n2 = ns();
    d.send(up("u1", "l", "Auditor", n1, false));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("Auditor");
    d.send(up("u2", "g", "AUDITOR", n2, true));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("AUDITOR-2");
    d.send(list("l1", "l"));
    const names = lowerNames(await waitFor(d, "roster"));
    expect(names.filter((x) => x === "auditor")).toHaveLength(1);
    d.close();
  });

  it("case variants collide in one namespace; distinct namespaces still share non-global names", async () => {
    const d = await ready((await machine()).token);
    const n = ns();
    d.send(up("u1", "a", "Alice", n));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("Alice");
    d.send(up("u2", "b", "alice", n));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("alice-2");
    d.send(up("u3", "c", "alice", ns()));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("alice");
    d.close();
  });
});

describe("F4: suffixes never run out before the roster cap", () => {
  it("the 100th agent proposing the same name still gets a name", async () => {
    const m = await machine();
    const d = await ready(m.token);
    const n = ns();
    await seedAgents(m.id, 0, () => n);
    await inOwnerHub((s) => {
      s.storage.sql.exec(
        `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
         values (?, ?, ?, 'Crowd', 'pi', ?, 'crowd_1', 0, 1, 0)`,
        `crowd${m.id}1`,
        OWNER_ORG_ID,
        n,
        m.id,
      );
      for (let i = 2; i <= 99; i++)
        s.storage.sql.exec(
          `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
           values (?, ?, ?, ?, 'pi', ?, ?, 0, 1, 0)`,
          `crowd${m.id}${i}`,
          OWNER_ORG_ID,
          n,
          `Crowd-${i}`,
          m.id,
          `crowd_${i}`,
        );
    });
    d.send(up("u100", "r100", "Crowd", n));
    const f = await d.next();
    expect(f).toMatchObject({ type: "agent_ok", bus_name: "Crowd-100" });
    d.close();
  });
});

describe("F2: a replaced socket is dead", () => {
  it("its agent_up after the replacement does nothing", async () => {
    const m = await machine();
    const watcher = await machine("W");
    const n = ns();
    const first = await ready(m.token);
    first.send(up("u1", "a", "First", n));
    await waitFor(first, "agent_ok");
    const second = await daemon(m.token);
    try {
      first.send(up("u2", "ghost", "Ghost", n));
    } catch {
      // Already closed on this side.
    }
    await first.closed;
    await tick(50);
    second.send(hello());
    await waitFor(second, "hello_ok");
    const w = await ready(watcher.token);
    w.send(up("u3", "w", "W", n));
    await waitFor(w, "agent_ok");
    w.send(list("l", "w"));
    const r = await waitFor(w, "roster");
    expect(r.agents.map((a) => a.bus_name)).not.toContain("Ghost");
    expect(first.raw.join("\n")).not.toContain(
      '"type":"agent_ok","agent_ref":"ghost"',
    );
    second.close();
    w.close();
  });
});

describe("F3: targeted roster_changed fan-out", () => {
  it("only daemons with an agent in the namespace, or a global agent, hear it", async () => {
    const actor = await ready((await machine("Actor")).token);
    const inNs = await ready((await machine("InNs")).token);
    const hasGlobal = await ready((await machine("Global")).token);
    const elsewhere = await ready((await machine("Elsewhere")).token);
    const n = ns("target");
    inNs.send(up("u1", "in", "In", n));
    await waitFor(inNs, "agent_ok");
    hasGlobal.send(up("u2", "gl", `Glob${Date.now()}`, ns(), true));
    await waitFor(hasGlobal, "agent_ok");
    elsewhere.send(up("u3", "el", "Else", ns()));
    await waitFor(elsewhere, "agent_ok");
    await tick(30);
    const before = [inNs, hasGlobal, elsewhere].map((d) => changed(d).length);
    actor.send(up("u4", "act", "Actor", n));
    await waitFor(actor, "agent_ok");
    await until(() => changed(inNs).length > before[0]);
    await until(() => changed(hasGlobal).length > before[1]);
    await tick(50);
    expect(changed(inNs).slice(before[0])).toEqual([n]);
    expect(changed(hasGlobal).slice(before[1])).toEqual([n]);
    expect(changed(elsewhere).slice(before[2])).toEqual([]);
    for (const d of [actor, inNs, hasGlobal, elsewhere]) d.close();
  });

  it("sessions{closed:1000 refs in 1000 namespaces} with 20 daemons stays targeted", async () => {
    const m = await machine("Big");
    const prefix = ns("fan");
    const d = await ready(m.token);
    const watchers: Daemon[] = [];
    for (let i = 0; i < 19; i++) {
      const w = await ready((await machine(`W${i}`)).token);
      // Each watcher shares exactly one of the 1000 namespaces.
      w.send(up(`u${i}`, `w${i}`, `Watcher ${i}`, `${prefix}-${i}`));
      await waitFor(w, "agent_ok");
      watchers.push(w);
    }
    // Seeded after the watchers register: 1000 live agents is the org-wide
    // live-agent cap (B11), past which agent_up is refused.
    await seedAgents(m.id, LIMITS.maxRosterAgents, (i) => `${prefix}-${i}`);
    await tick(100);
    const before = watchers.map((w) => changed(w).length);
    const t0 = Date.now();
    d.send({
      v: 1,
      id: "sc",
      type: "sessions",
      open: [],
      closed: Array.from(
        { length: LIMITS.maxRosterAgents },
        (_, i) => `seed_${i}`,
      ),
    });
    d.send(hello("after"));
    await waitFor(d, "hello_ok");
    const wall = Date.now() - t0;
    await until(() => watchers.every((w, i) => changed(w).length > before[i]));
    await tick(50);
    watchers.forEach((w, i) => {
      expect(changed(w).slice(before[i])).toEqual([`${prefix}-${i}`]);
    });
    // Recorded for the fix report (adv baseline was ~350 ms untargeted).
    console.info(`B5-FIX1 fan-out wall: ${wall} ms`);
    expect(wall).toBeLessThan(1000);
    for (const w of watchers) w.close();
    d.close();
  }, 60000);
});

describe("spec-review minors", () => {
  it("first connect flips queued agents to live with roster_changed", async () => {
    const away = await machine("Away");
    const n = ns();
    const a = await ready(away.token);
    a.send(up("u1", "aw", "Away", n));
    await waitFor(a, "agent_ok");
    a.close();
    await a.closed;
    const w = await ready((await machine("Watch")).token);
    w.send(up("u2", "wa", "Watch", n));
    await waitFor(w, "agent_ok");
    w.send(list("l1", "wa"));
    expect(
      (await waitFor(w, "roster")).agents.find((x) => x.bus_name === "Away")
        ?.state,
    ).toBe("queued");
    await tick(30);
    const before = changed(w).length;
    const back = await daemon(away.token);
    await until(() => changed(w).length > before);
    expect(changed(w).slice(before)).toEqual([n]);
    w.send(list("l2", "wa"));
    expect(
      (await waitFor(w, "roster")).agents.find((x) => x.bus_name === "Away")
        ?.state,
    ).toBe("live");
    back.close();
    w.close();
  });

  it("a 4403 close code passes through the close handler", async () => {
    const d = await ready((await machine()).token);
    d.ws.close(LIMITS.revokeCloseCode, "revoked");
    expect((await d.closed).code).toBe(LIMITS.revokeCloseCode);
  });
});

describe("fix round 2: global changes reach every daemon; no self-broadcast", () => {
  it("a global agent coming up in ns1 reaches a daemon whose only agent is in ns2", async () => {
    const n1 = ns("g1");
    const n2 = ns("g2");
    const other = await ready((await machine("Other")).token);
    other.send(up("u1", "o", "Other", n2));
    await waitFor(other, "agent_ok");
    const actor = await ready((await machine("Actor")).token);
    await tick(30);
    const before = changed(other).length;
    actor.send(up("u2", "g", `Glob${Date.now()}`, n1, true));
    await waitFor(actor, "agent_ok");
    await until(() => changed(other).length > before);
    await tick(30);
    expect(changed(other).slice(before)).toEqual([n2]);
    // And its agent_down too.
    const mid = changed(other).length;
    actor.send({ v: 1, id: "d1", type: "agent_down", agent_ref: "g" });
    await until(() => changed(other).length > mid);
    expect(changed(other).slice(mid)).toEqual([n2]);
    actor.close();
    other.close();
  });

  it("the originating socket gets no roster_changed for its own changes", async () => {
    const n = ns("self");
    const d = await ready((await machine("Self")).token);
    d.send(up("u1", "a", "SelfA", n));
    await waitFor(d, "agent_ok");
    // d now hosts an agent in n: any change in n would target it, except its own.
    d.send(up("u2", "b", "SelfB", n));
    await waitFor(d, "agent_ok");
    d.send({ v: 1, id: "d1", type: "agent_down", agent_ref: "b" });
    d.send({ v: 1, id: "s1", type: "sessions", open: [], closed: ["a"] });
    d.send(hello("sync"));
    await waitFor(d, "hello_ok");
    await tick(30);
    expect(changed(d)).toEqual([]);
    d.close();
  });

  it("a reconnecting machine gets no roster_changed for its own agents", async () => {
    const m = await machine("Back");
    const n = ns("back");
    const a = await ready(m.token);
    a.send(up("u1", "a", "Back", n));
    await waitFor(a, "agent_ok");
    a.close();
    await a.closed;
    const b = await ready(m.token);
    await tick(30);
    expect(changed(b)).toEqual([]);
    b.close();
  });
});
