import { describe, expect, it } from "vitest";
import {
  hello,
  inOwnerHub,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

const agentRow = (machineId: string, ref: string) =>
  inOwnerHub((s) =>
    s.storage.sql
      .exec<{ live: number; away_since: number | null }>(
        "select live, away_since from agents where machine_id = ? and native_ref = ?",
        machineId,
        ref,
      )
      .one(),
  );

describe("hub sessions: open is the complete live set (#3192)", () => {
  it("a sessions frame ends a live row the daemon no longer lists (#3192)", async () => {
    const m = await machine();
    const d = await ready(m.token);
    const a = ns("open");
    d.send(up("u1", "ses_a", "Alpha", a));
    await waitFor(d, "agent_ok");
    d.send(up("u2", "ses_b", "Beta", a));
    await waitFor(d, "agent_ok");

    d.send({ v: 1, id: "s1", type: "sessions", open: ["ses_a"], closed: [] });
    d.send({ v: 1, id: "l1", type: "list", from_ref: "ses_a" });
    const roster = await waitFor(d, "roster");
    expect(roster.agents.find((x) => x.bus_name === "Alpha")?.state).toBe(
      "live",
    );
    expect(roster.agents.find((x) => x.bus_name === "Beta")).toBeUndefined();

    const rowA = await agentRow(m.id, "ses_a");
    const rowB = await agentRow(m.id, "ses_b");
    expect(rowA.live).toBe(1);
    expect(rowA.away_since).toBeNull();
    expect(rowB.live).toBe(0);
    expect(typeof rowB.away_since).toBe("number");
    d.close();
  });

  it("the forgotten row keeps its name away: a new session asking it gets a suffix (#3132, was a reclaim)", async () => {
    const m = await machine();
    const d = await ready(m.token);
    const a = ns("free");
    d.send(up("u1", "ses_a", "Alpha", a));
    await waitFor(d, "agent_ok");
    d.send(up("u2", "ses_b", "Pi", a));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("Pi");

    d.send({ v: 1, id: "s1", type: "sessions", open: ["ses_a"], closed: [] });
    d.send(hello("sync"));
    await waitFor(d, "hello_ok");

    d.send(up("u3", "ses_c", "Pi", a));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("Pi-2");
    d.send(up("u4", "ses_d", "Pi", a));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("Pi-3");
    d.close();
  });

  it("rows of another machine are untouched", async () => {
    const m1 = await machine("M1");
    const m2 = await machine("M2");
    const d1 = await ready(m1.token);
    const d2 = await ready(m2.token);
    const a = ns("other");
    d1.send(up("u1", "ses_a", "Alpha", a));
    await waitFor(d1, "agent_ok");
    d2.send(up("u2", "ses_x", "Xray", a));
    await waitFor(d2, "agent_ok");

    d1.send({ v: 1, id: "s1", type: "sessions", open: ["ses_a"], closed: [] });
    d1.send({ v: 1, id: "l1", type: "list", from_ref: "ses_a" });
    const roster = await waitFor(d1, "roster");
    expect(roster.agents.find((x) => x.bus_name === "Alpha")?.state).toBe(
      "live",
    );
    expect(roster.agents.find((x) => x.bus_name === "Xray")?.state).toBe(
      "live",
    );

    const rowX = await agentRow(m2.id, "ses_x");
    expect(rowX.live).toBe(1);
    expect(rowX.away_since).toBeNull();
    d1.close();
    d2.close();
  });

  it("a row in open stays live and a closed one ends as before", async () => {
    const m = await machine();
    const d = await ready(m.token);
    const a = ns("both");
    d.send(up("u1", "ses_a", "Alpha", a));
    await waitFor(d, "agent_ok");
    d.send(up("u2", "ses_b", "Beta", a));
    await waitFor(d, "agent_ok");

    d.send({
      v: 1,
      id: "s1",
      type: "sessions",
      open: ["ses_a"],
      closed: ["ses_b"],
    });
    d.send({ v: 1, id: "l1", type: "list", from_ref: "ses_a" });
    const roster = await waitFor(d, "roster");
    expect(roster.agents.find((x) => x.bus_name === "Alpha")?.state).toBe(
      "live",
    );
    expect(roster.agents.find((x) => x.bus_name === "Beta")).toBeUndefined();

    const rowA = await agentRow(m.id, "ses_a");
    const rowB = await agentRow(m.id, "ses_b");
    expect(rowA.live).toBe(1);
    expect(rowB.live).toBe(0);
    expect(typeof rowB.away_since).toBe("number");
    d.close();
  });

  it("an empty open ends every live row of that machine", async () => {
    const m = await machine();
    const d = await ready(m.token);
    const a = ns("empty");
    d.send(up("u1", "ses_a", "Alpha", a));
    await waitFor(d, "agent_ok");
    d.send(up("u2", "ses_b", "Beta", a));
    await waitFor(d, "agent_ok");

    d.send({ v: 1, id: "s1", type: "sessions", open: [], closed: [] });
    d.send(hello("sync"));
    await waitFor(d, "hello_ok");

    const rowA = await agentRow(m.id, "ses_a");
    const rowB = await agentRow(m.id, "ses_b");
    expect(rowA.live).toBe(0);
    expect(typeof rowA.away_since).toBe("number");
    expect(rowB.live).toBe(0);
    expect(typeof rowB.away_since).toBe("number");
    d.close();
  });
});
