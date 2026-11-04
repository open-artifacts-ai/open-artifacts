// C23b: an omp session is a Pi session to the daemon (attested by start time,
// delivered on its connection); a hub older than the omp kind gets it as pi,
// as one older than codex gets codex (C26a).
import type { DaemonFrame } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

afterEach(async () => {
  vi.unstubAllEnvs();
  await stopAll();
});

const ID = "mmmmmmmmmmmmmmm1";
type Deliver = Extract<DaemonFrame, { type: "deliver" }>;
const badFrame = (id: string) => ({
  id,
  type: "error",
  code: "bad_frame",
  message: "Unreadable frame",
});
const FALLBACK =
  "the hub does not know the omp kind; omp agents register there as pi";

describe("omp in the daemon", () => {
  it("registers as omp and receives on its connection", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A", { kind: "omp" });
    expect(await h.next("agent_up")).toMatchObject({
      agent_ref: "A",
      kind: "omp",
    });
    const got: Deliver[] = [];
    a.onDeliver((f) => {
      got.push(f);
      a.ack(f.msg_id);
    });
    h.toDaemon(deliverFrame(ID));
    expect(await h.next("ack")).toMatchObject({ msg_id: ID });
    expect(got).toEqual([expect.objectContaining({ msg_id: ID })]);
  });

  it("closes with its connection, like pi", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A", { kind: "omp" });
    await h.next("agent_up");
    const before = h.of("sessions").length;
    a.close();
    expect(await h.next("sessions", before + 1)).toMatchObject({
      closed: ["A"],
    });
  });
});

describe("a hub that refuses a kind", () => {
  it("leaves pi and other kinds' bad_frame refusals alone", async () => {
    const logs: string[] = [];
    const h = await daemonHarness({ log: (m) => logs.push(m) });
    await h.adapter("P", { kind: "pi" });
    h.toDaemon(badFrame((await h.next("agent_up")).id));
    await vi.waitFor(() =>
      expect(logs).toContain("the hub refused to register P: bad_frame"),
    );
    expect(h.of("agent_up")).toHaveLength(1);
    expect(logs).not.toContain(FALLBACK);
  });
});

describe("a successful attestation (C25)", () => {
  it("is not logged by default", async () => {
    const logs: string[] = [];
    const h = await daemonHarness({ log: (m) => logs.push(m), debug: false });
    await h.adapter("0123456789abcdef", { kind: "omp", pid: 4242 });
    await h.next("agent_up");
    expect(logs.some((l) => l.startsWith("attested "))).toBe(false);
  });

  it("with OA_BUS_DEBUG=1: the kind, pid and a short ref, nothing secret", async () => {
    vi.stubEnv("OA_BUS_DEBUG", "1");
    const logs: string[] = [];
    const h = await daemonHarness({ log: (m) => logs.push(m) });
    await h.adapter("0123456789abcdef", {
      kind: "omp",
      pid: 4242,
      attest: { session_id: "SECRET-session", proc_start: "SECRET-start" },
    });
    await h.next("agent_up");
    const line = logs.find((l) => l.startsWith("attested "));
    expect(line).toBe("attested omp pid 4242 ref 01234567");
    expect(logs.join("\n")).not.toContain("SECRET");
  });
});
