// #1856: a Codex hello is one request. The proxy's link_proof is that request:
// it binds the hash to the attested thread's own agent, and the connection ends.
import { ADAPTER_CAPS } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TA = "01a184f2-14eb-73d0-9da0-ffd91d13abd3";
const TB = "01a184f2-14eb-73d0-9da0-ffd91d13abd4";
const codexHello = (thread: string, call: string) => ({
  kind: "codex" as const,
  pid: 4242,
  caps: [ADAPTER_CAPS.link],
  codex: { thread_id: thread, call_id: call, ppid: 4000 },
});

async function start() {
  const h = await daemonHarness();
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.link, BUS_CAPS.linkArg],
  });
  return h;
}

describe("codex link_proof (#1856)", () => {
  it("binds each thread's hash to that thread's own agent", async () => {
    const h = await start();
    const a = await h.adapter(TA, codexHello(TA, "call_a"));
    expect(a.welcome.caps).toContain(ADAPTER_CAPS.link);
    expect(
      await a.request({ type: "link_proof", hash: HASH_A } as never),
    ).toMatchObject({ type: "link_proofed", bound: true });
    const b = await h.adapter(TB, codexHello(TB, "call_b"));
    await b.request({ type: "link_proof", hash: HASH_B } as never);
    await h.next("link_bind", 2);
    expect(h.of("link_bind").map((f) => [f.agent_ref, f.hash])).toEqual([
      [TA, HASH_A],
      [TB, HASH_B],
    ]);
  });

  it("answers one request per hello: a second on the same connection is refused and binds nothing", async () => {
    const h = await start();
    const a = await h.adapter(TA, codexHello(TA, "call_a"));
    await a.request({ type: "link_proof", hash: HASH_A } as never);
    await h.next("link_bind");
    await a
      .request({ type: "link_proof", hash: HASH_B } as never)
      .catch(() => undefined);
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([HASH_A]);
  });

  it("lists link only for a hello that listed it", async () => {
    const h = await start();
    const c = await h.adapter(TA, {
      ...codexHello(TA, "call_a"),
      caps: [ADAPTER_CAPS.mailbox],
    });
    expect(c.welcome.caps ?? []).not.toContain(ADAPTER_CAPS.link);
  });
});
