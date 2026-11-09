// #1856 (part of #1822): a harness adapter (Hermes, OpenClaw) tells the daemon
// its root's proof hash on its own hello'd link. The frame names no agent: the
// daemon binds it to that connection's agent only, and only when the hello
// listed `link`. Waits are signals (a frame arriving), never sleeps.
import { connect } from "node:net";
import { ADAPTER_CAPS, LineDecoder } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
});

const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);
const same = {
  kind: "hermes" as const,
  pid: 4242,
  attest: { proc_start: "t" },
};
const listed = { ...same, caps: [ADAPTER_CAPS.link] };

async function start(
  hubCaps: string[] = [BUS_CAPS.ids, BUS_CAPS.link, BUS_CAPS.linkArg],
) {
  const h = await daemonHarness();
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: hubCaps,
  });
  return h;
}

describe("helloed link_proof (#1856)", () => {
  it("lists link in the welcome only for an adapter that listed it", async () => {
    const h = await start();
    const a = await h.adapter("A", listed);
    const b = await h.adapter("B", same);
    expect(a.welcome.caps).toContain(ADAPTER_CAPS.link);
    expect(b.welcome.caps ?? []).not.toContain(ADAPTER_CAPS.link);
  });

  it("binds the hash to the connection's own agent, and a new one replaces it", async () => {
    const h = await start();
    const a = await h.adapter("A", listed);
    await h.adapter("B", listed);
    const r = await a.request({ type: "link_proof", hash: HASH } as never);
    expect(r).toMatchObject({ type: "link_proofed", bound: true });
    const bind = await h.next("link_bind");
    expect(bind).toMatchObject({ agent_ref: "A", hash: HASH });
    await a.request({ type: "link_proof", hash: HASH2 } as never);
    await h.next("link_bind", 2);
    expect(h.of("link_bind").map((f) => [f.agent_ref, f.hash])).toEqual([
      ["A", HASH],
      ["A", HASH2],
    ]);
  });

  it("cannot name another agent: agent_ref or pid in the frame is refused and binds nothing", async () => {
    const h = await start();
    const a = await h.adapter("A", listed);
    await h.adapter("B", listed);
    for (const extra of [{ agent_ref: "B" }, { pid: 4242 }]) {
      const r = await a.request({
        type: "link_proof",
        hash: HASH,
        ...extra,
      } as never);
      expect(r).toMatchObject({ type: "error", code: "bad_frame" });
    }
    const bad = await a.request({ type: "link_proof", hash: "zz" } as never);
    expect(bad).toMatchObject({ type: "error", code: "bad_frame" });
    // A later good frame is the first bind: nothing leaked before it.
    await a.request({ type: "link_proof", hash: HASH2 } as never);
    await h.next("link_bind");
    expect(h.of("link_bind")).toHaveLength(1);
    expect(h.of("link_bind")[0]).toMatchObject({ agent_ref: "A" });
  });

  it("is refused on a link whose hello did not list link (an older adapter's shape)", async () => {
    const h = await start();
    const b = await h.adapter("B", same);
    const r = await b.request({ type: "link_proof", hash: HASH } as never);
    expect(r).toMatchObject({ type: "error", code: "bad_frame" });
    await h
      .adapter("C", listed)
      .then((c) => c.request({ type: "link_proof", hash: HASH2 } as never));
    await h.next("link_bind");
    expect(h.of("link_bind").map((f) => f.agent_ref)).toEqual(["C"]);
  });

  it("is refused before a hello", async () => {
    const h = await start();
    const frames: { type?: string; code?: string }[] = [];
    const sock = connect(h.socketPath);
    const dec = new LineDecoder();
    const closed = new Promise<void>((res) => sock.once("close", () => res()));
    sock.on("data", (c) => {
      for (const f of dec.push(c)) frames.push(f as never);
    });
    await new Promise<void>((res) => sock.once("connect", () => res()));
    sock.write(
      `${JSON.stringify({ v: 1, id: "x", type: "link_proof", hash: HASH })}\n`,
    );
    await closed;
    expect(frames[0]).toMatchObject({ type: "error", code: "unauthorized" });
    expect(h.of("link_bind")).toHaveLength(0);
  });

  it("says not bound, and sends nothing, to a hub that did not list link", async () => {
    const h = await start([BUS_CAPS.ids, BUS_CAPS.linkArg]);
    const a = await h.adapter("A", listed);
    const r = await a.request({ type: "link_proof", hash: HASH } as never);
    expect(r).toMatchObject({ type: "link_proofed", bound: false });
    await vi.waitFor(() => expect(h.of("agent_up").length).toBe(1));
    expect(h.of("link_bind")).toHaveLength(0);
  });

  it("says not bound, and sends nothing, to a hub that lists link but not link_arg (its /mcp would refuse the argument)", async () => {
    const h = await start([BUS_CAPS.ids, BUS_CAPS.link]);
    const a = await h.adapter("A", listed);
    const r = await a.request({ type: "link_proof", hash: HASH } as never);
    expect(r).toMatchObject({ type: "link_proofed", bound: false });
    await vi.waitFor(() => expect(h.of("agent_up").length).toBe(1));
    expect(h.of("link_bind")).toHaveLength(0);
  });

  it("says not bound while the hub link is down", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A", listed);
    const r = await a.request({ type: "link_proof", hash: HASH } as never);
    expect(r).toMatchObject({ type: "link_proofed", bound: false });
  });
});
