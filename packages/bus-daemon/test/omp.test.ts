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

describe("a hub that refuses the omp kind", () => {
  it("gets omp agents as pi, logged once", async () => {
    const logs: string[] = [];
    const h = await daemonHarness({ log: (m) => logs.push(m) });
    await h.adapter("A", { kind: "omp" });
    await h.adapter("B", { kind: "omp" });
    const a = await h.next("agent_up");
    const b = await h.next("agent_up", 2);
    expect([a.kind, b.kind]).toEqual(["omp", "omp"]);
    h.toDaemon(badFrame(a.id));
    h.toDaemon(badFrame(b.id));
    await h.next("agent_up", 4);
    expect(
      h
        .of("agent_up")
        .slice(2)
        .map((f) => [f.agent_ref, f.kind])
        .sort(),
    ).toEqual([
      ["A", "pi"],
      ["B", "pi"],
    ]);
    expect(logs.filter((l) => l === FALLBACK)).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("the hub refused to register"))).toBe(
      false,
    );
    // A new agent goes straight to pi; the record stays omp.
    await h.adapter("C", { kind: "omp" });
    expect(await h.next("agent_up", 5)).toMatchObject({
      agent_ref: "C",
      kind: "pi",
    });
    expect(h.daemon.agents.byRef("C")?.kind).toBe("omp");
  });

  it("offers omp again on the next hub link", async () => {
    const logs: string[] = [];
    const h = await daemonHarness({ log: (m) => logs.push(m) });
    await h.adapter("A", { kind: "omp" });
    h.toDaemon(badFrame((await h.next("agent_up")).id));
    expect(await h.next("agent_up", 2)).toMatchObject({ kind: "pi" });
    h.hubSock()?.close();
    expect(await h.next("agent_up", 3)).toMatchObject({
      agent_ref: "A",
      kind: "omp",
    });
    h.toDaemon(badFrame(h.of("agent_up")[2]?.id as string));
    expect(await h.next("agent_up", 4)).toMatchObject({ kind: "pi" });
    expect(logs.filter((l) => l === FALLBACK)).toHaveLength(1);
  });

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

describe("a hub that refuses the codex kind (C26a)", () => {
  const CODEX =
    "the hub does not know the codex kind; codex agents register there as pi";

  it("gets codex agents as pi, logged once per kind", async () => {
    const logs: string[] = [];
    const h = await daemonHarness({ log: (m) => logs.push(m) });
    await h.adapter("X", { kind: "codex" });
    await h.adapter("O", { kind: "omp" });
    const x = await h.next("agent_up");
    const o = await h.next("agent_up", 2);
    expect([x.kind, o.kind]).toEqual(["codex", "omp"]);
    h.toDaemon(badFrame(x.id));
    expect(await h.next("agent_up", 3)).toMatchObject({
      agent_ref: "X",
      kind: "pi",
    });
    // omp is offered as itself until the hub refuses it too.
    h.toDaemon(badFrame(o.id));
    expect(await h.next("agent_up", 4)).toMatchObject({
      agent_ref: "O",
      kind: "pi",
    });
    await h.adapter("Y", { kind: "codex" });
    expect(await h.next("agent_up", 5)).toMatchObject({
      agent_ref: "Y",
      kind: "pi",
    });
    expect(h.daemon.agents.byRef("Y")?.kind).toBe("codex");
    expect(logs.filter((l) => l === CODEX)).toHaveLength(1);
    expect(logs.filter((l) => l === FALLBACK)).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("the hub refused to register"))).toBe(
      false,
    );
  });

  it("offers codex again on the next hub link", async () => {
    const h = await daemonHarness();
    await h.adapter("X", { kind: "codex" });
    h.toDaemon(badFrame((await h.next("agent_up")).id));
    expect(await h.next("agent_up", 2)).toMatchObject({ kind: "pi" });
    h.hubSock()?.close();
    expect(await h.next("agent_up", 3)).toMatchObject({
      agent_ref: "X",
      kind: "codex",
    });
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
