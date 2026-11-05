// #1291 / #1323 (open-bus #426): a repeat agent_up for a live agent renames
// it, as OpenBus's agentUp does; the client relies on it. Since OpenBus #446
// it is a rename like `rename`: the old name is a former name.
import { describe, expect, it } from "vitest";
import { machine, ns, ready, up, waitFor } from "./helpers.js";

describe("repeat agent_up renames a live agent", () => {
  it("live 'a', then agent_up proposing 'b' on the same socket: agent_ok b, roster only b, mail to b arrives", async () => {
    const space = ns("rename");
    const d = await ready((await machine("rename-box")).token);
    d.send(up("u1", "ref-a", "a", space));
    expect((await waitFor(d, "agent_ok")).bus_name).toBe("a");
    d.send(up("u2", "ref-a", "b", space));
    const ok = await waitFor(d, "agent_ok");
    expect(ok.agent_ref).toBe("ref-a");
    expect(ok.bus_name).toBe("b");

    d.send(up("u3", "ref-s", "sender", space));
    await waitFor(d, "agent_ok");
    d.send({ v: 1, id: "l1", type: "list", from_ref: "ref-s" });
    const roster = await waitFor(d, "roster");
    expect(roster.agents.map((x) => x.bus_name).sort()).toEqual([
      "b",
      "sender",
    ]);

    d.send({
      v: 1,
      id: "s1",
      type: "send",
      from_ref: "ref-s",
      to_name: "b",
      body: "hello b",
    });
    expect((await waitFor(d, "receipt")).state).toBe("pending");
    const del = await waitFor(d, "deliver");
    expect(del.to_ref).toBe("ref-a");
    expect(del.body).toBe("hello b");

    // The old name is a former name (OpenBus #446): it still reaches the
    // agent for the grace.
    d.send({
      v: 1,
      id: "s2",
      type: "send",
      from_ref: "ref-s",
      to_name: "a",
      body: "hello a",
    });
    expect((await waitFor(d, "receipt")).state).toBe("pending");
    const del2 = await waitFor(d, "deliver");
    expect(del2.to_ref).toBe("ref-a");
    expect(del2.body).toBe("hello a");
    d.close();
  });
});
