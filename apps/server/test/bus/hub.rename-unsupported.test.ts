// R393a (#1325): the protocol decodes `rename` before BusHub handles it
// (R393b). Until then the hub must answer it, never drop it, so a client
// waiting on `renamed` gets `error bad_frame` and can fall back.
import { describe, expect, it } from "vitest";
import { machine, ns, ready, up, waitFor } from "./helpers.js";

describe("rename before R393b", () => {
  it("is answered error bad_frame with the frame id, socket open", async () => {
    const d = await ready((await machine("rename-unsupported")).token);
    d.send(up("u1", "ses_a", "Mine", ns("rename-unsupported")));
    await waitFor(d, "agent_ok");
    d.send({
      v: 1,
      id: "r1",
      type: "rename",
      agent_ref: "ses_a",
      proposed_name: "Other",
    });
    const err = await waitFor(d, "error");
    expect(err).toMatchObject({
      id: "r1",
      code: "bad_frame",
      message: "rename is not supported yet",
    });
    d.send({ v: 1, id: "l1", type: "list", from_ref: "ses_a" });
    const roster = await waitFor(d, "roster");
    expect(roster.id).toBe("l1");
    expect(roster.agents.map((a) => a.bus_name)).toEqual(["Mine"]);
    d.close();
  });
});
