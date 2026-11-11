// A Hermes plugin is a Pi-style adapter: attested by start time, it receives
// on its connection. One Hermes process holds one link per root session, so
// several refs share a pid and a proc_start.
import type { DaemonFrame } from "@oa/bus-ipc";
import { afterEach, describe, expect, it } from "vitest";
import { attest } from "../src/attest.ts";
import { daemonHarness, deliverFrame, hello, stopAll } from "./helpers.ts";

afterEach(stopAll);

type Deliver = Extract<DaemonFrame, { type: "deliver" }>;

describe("hermes in the daemon", () => {
  it("is attested by process start time", () => {
    const h = (proc_start?: string) =>
      hello({
        kind: "hermes",
        agent_ref: "s1",
        attest: proc_start ? { proc_start } : {},
      });
    expect(attest(h("t"), { procStart: () => "t" })).toEqual({ ok: true });
    expect(attest(h("old"), { procStart: () => "new" })).toEqual({
      ok: false,
      reason: "hermes process start time moved",
    });
    expect(attest(h(), { procStart: () => "t" })).toMatchObject({ ok: false });
    expect(attest(h("t"), { procStart: () => null })).toEqual({
      ok: false,
      reason: "hermes process is not running",
    });
  });

  it("admits two roots from one pid and start time, each receiving its own mail", async () => {
    const h = await daemonHarness();
    const same = {
      kind: "hermes" as const,
      pid: 4242,
      attest: { proc_start: "t" },
    };
    const a = await h.adapter("A", same);
    const b = await h.adapter("B", same);
    expect(h.of("agent_up").map((f) => f.agent_ref)).toEqual(["A", "B"]);
    const got: Record<string, Deliver[]> = { A: [], B: [] };
    for (const [ref, c] of [
      ["A", a],
      ["B", b],
    ] as const)
      c.onDeliver((f) => {
        got[ref].push(f);
        c.ack(f.msg_id);
      });
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "A"));
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm2", "B"));
    await h.next("ack", 2);
    expect(got.A.map((f) => f.msg_id)).toEqual(["mmmmmmmmmmmmmmm1"]);
    expect(got.B.map((f) => f.msg_id)).toEqual(["mmmmmmmmmmmmmmm2"]);
  });

  it("closing one root leaves the other live", async () => {
    const h = await daemonHarness();
    const same = {
      kind: "hermes" as const,
      pid: 4242,
      attest: { proc_start: "t" },
    };
    const a = await h.adapter("A", same);
    await h.adapter("B", same);
    await h.next("agent_up", 2);
    const before = h.of("sessions").length;
    a.close();
    expect(await h.next("sessions", before + 1)).toMatchObject({
      closed: ["A"],
    });
  });
});
