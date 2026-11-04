// Ported from OpenBus v0.63.0 apps/server/test/hub.roster-label.test.ts (#1291).
// Dropped: the KIND_TOKEN_MIN_CLIENT hello (no client-version gates).
// B13: every roster row carries its machine's label, on exactly the rows the
// caller already receives. Every frame is checked with decodeServerFrame.
import { decodeServerFrame, PONG, type ServerFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  type Daemon,
  daemon,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

type Roster = Extract<ServerFrame, { type: "roster" }>;

let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

async function agent(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  global = false,
): Promise<void> {
  d.send(up(`u-${ref}-${++seq}`, ref, name, namespace, global));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

async function list(d: Daemon, from_ref: string): Promise<Roster> {
  const id = `l${++seq}`;
  d.send({ v: 1, id, type: "list", from_ref });
  for (;;) {
    const r = await waitFor(d, "roster");
    if (r.id === id) return r;
  }
}

/** The raw text of the roster reply `id`, as the daemon received it. */
const rawRoster = (d: Daemon, id: string) =>
  d.raw.find(
    (t) => t !== PONG && t.includes('"roster"') && t.includes(`"${id}"`),
  );

describe("omp agents", () => {
  it("registers an omp agent_up and lists it", async () => {
    // No client-version gate in the port: any daemon sees omp rows.
    const d = await daemon((await machine(uniq("Omp box"))).token);
    try {
      d.send({
        v: 1,
        id: "h-omp",
        type: "hello",
        machine_label: "Omp box",
        client_version: "0.1.0",
      });
      await waitFor(d, "hello_ok");
      const n = ns();
      const name = uniq("omp");
      const f = up(`u-${++seq}`, "r-omp", name, n);
      if (f.type !== "agent_up") throw new Error("up builds an agent_up");
      d.send({ ...f, kind: "omp" });
      expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
      const r = await list(d, "r-omp");
      expect(r.agents.find((x) => x.bus_name === name)?.kind).toBe("omp");
    } finally {
      d.close();
    }
  });
});

describe("roster machine_label", () => {
  it("labels every row with its own machine's label", async () => {
    const la = uniq("Laptop A");
    const lb = uniq("Desk B");
    const ma = await machine(la);
    const mb = await machine(lb);
    const a = await ready(ma.token);
    const b = await ready(mb.token);
    try {
      const n = ns();
      const na = uniq("Alpha");
      const nb = uniq("Beta");
      await agent(a, "ra", na, n);
      await agent(b, "rb", nb, n);

      const r = await list(a, "ra");
      const byName = new Map(r.agents.map((x) => [x.bus_name, x]));
      expect(byName.get(na)?.machine_label).toBe(la);
      expect(byName.get(nb)?.machine_label).toBe(lb);
      // Every row, not only these two, carries a label.
      expect(r.agents.every((x) => typeof x.machine_label === "string")).toBe(
        true,
      );
      // The raw frame has the key and the daemon's strict decoder takes it.
      const raw = rawRoster(a, r.id);
      expect(raw).toContain(`"machine_label":${JSON.stringify(la)}`);
      expect(decodeServerFrame(raw).ok).toBe(true);
      // A queued agent (its machine offline) keeps its label.
      b.close();
      await b.closed;
      const q = (await list(a, "ra")).agents.find((x) => x.bus_name === nb);
      expect(q).toMatchObject({ state: "queued", machine_label: lb });
    } finally {
      for (const d of [a, b])
        try {
          d.close();
        } catch {
          // Already closed.
        }
    }
  });

  it("labels only the rows the caller's scope already returns", async () => {
    const la = uniq("Scope A");
    const lb = uniq("Scope B");
    const ma = await machine(la);
    const mb = await machine(lb);
    const a = await ready(ma.token);
    const b = await ready(mb.token);
    try {
      const n1 = ns();
      const n2 = ns();
      const local = uniq("Local");
      const other = uniq("Other");
      const glob = uniq("Glob");
      const gcaller = uniq("GCaller");
      await agent(a, "local", local, n1);
      await agent(b, "other", other, n2);
      await agent(b, "glob", glob, n2, true);
      await agent(a, "gcaller", gcaller, n1, true);

      // Non-global caller: its namespace plus globals, never n2's locals.
      const r = (await list(a, "local")).agents;
      const names = r.map((x) => x.bus_name);
      expect(names).toContain(local);
      expect(names).toContain(glob);
      expect(names).toContain(gcaller);
      expect(names).not.toContain(other);
      expect(r.every((x) => x.namespace === n1 || x.global)).toBe(true);
      const row = (n: string) => r.find((x) => x.bus_name === n);
      expect(row(local)?.machine_label).toBe(la);
      expect(row(glob)?.machine_label).toBe(lb);
      expect(row(gcaller)?.machine_label).toBe(la);
      // n2's local agent appears nowhere in the raw frame, label or not.
      const raw = rawRoster(a, (await list(a, "local")).id) ?? "";
      expect(raw).not.toContain(other);

      // Global caller: every open agent, each with its machine's label.
      const g = (await list(a, "gcaller")).agents;
      const gl = (n: string) => g.find((x) => x.bus_name === n);
      expect(gl(local)?.machine_label).toBe(la);
      expect(gl(other)?.machine_label).toBe(lb);
      expect(gl(glob)?.machine_label).toBe(lb);
      expect(g.every((x) => typeof x.machine_label === "string")).toBe(true);
    } finally {
      for (const d of [a, b])
        try {
          d.close();
        } catch {
          // Already closed.
        }
    }
  });
});
