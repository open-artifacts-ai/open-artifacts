// agy S5: `oa-bus mcp-proxy --for antigravity` tells the daemon a proof hash
// for an agy pid and the conversation agy put in the call's `_meta`. Only a
// live antigravity record with that ref (the conversation), pid and process
// start takes it, on its own instance's hub. Waits are signals (a frame
// arriving), never sleeps.
import { daemonLinkProof } from "@oa/bus-ipc";
import { agyCallDigest, BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
});

const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);
const CONV = "de77814a-7977-4ceb-b099-379ea43f490c";

async function start(
  opts: {
    caps?: string[];
    comm?: string | null;
    procStart?: string | null;
    logs?: string[];
  } = {},
) {
  const h = await daemonHarness({
    ...(opts.logs ? { log: (m: string) => opts.logs?.push(m) } : {}),
    antigravity: {
      comm: () =>
        opts.comm === undefined ? "/Users/x/.local/bin/agy" : opts.comm,
      procStart: () => (opts.procStart === undefined ? "t0" : opts.procStart),
    },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: opts.caps ?? [BUS_CAPS.ids, BUS_CAPS.link],
  });
  return h;
}

/** The session S2 registers: agent_ref the conversation, pid the agy process. */
const session = (h: Awaited<ReturnType<typeof start>>, ref = CONV) =>
  h.adapter(ref, {
    kind: "antigravity",
    pid: 4242,
    attest: { proc_start: "t0" },
  });

const proof = (
  h: { socketPath: string },
  over: {
    pid?: number;
    conversation?: string;
    hash?: string;
    instance?: string;
  } = {},
) =>
  daemonLinkProof({
    path: h.socketPath,
    pid: over.pid ?? 4242,
    conversation: over.conversation ?? CONV,
    hash: over.hash ?? HASH,
    ...(over.instance === undefined ? {} : { instance: over.instance }),
  });

describe("antigravity link_proof (agy S5)", () => {
  it("binds the hash to the live session of that agy pid and conversation, once", async () => {
    const h = await start();
    await session(h);
    await h.next("agent_up");
    expect(await proof(h)).toBe(true);
    expect(await h.next("link_bind")).toMatchObject({
      agent_ref: CONV,
      hash: HASH,
    });
    // The proxy asks on every call: the hub hears of a hash once.
    expect(await proof(h)).toBe(true);
    expect(await proof(h, { hash: HASH2 })).toBe(true);
    await h.next("link_bind", 2);
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([HASH, HASH2]);
  });

  it("binds nothing for another conversation, pid, or a session not yet registered", async () => {
    const h = await start();
    expect(await proof(h)).toBe(false);
    await session(h);
    await session(h, "other-conversation");
    await vi.waitFor(() => expect(h.of("agent_up").length).toBe(2));
    expect(await proof(h, { conversation: "no-such-conversation" })).toBe(
      false,
    );
    expect(await proof(h, { pid: 5151 })).toBe(false);
    // The other conversation's own call binds to it alone.
    expect(await proof(h, { conversation: "other-conversation" })).toBe(true);
    await h.next("link_bind");
    expect(h.of("link_bind").map((f) => f.agent_ref)).toEqual([
      "other-conversation",
    ]);
  });

  it("binds nothing when the pid does not run agy or its start time moved", async () => {
    for (const over of [
      { comm: "node" },
      { procStart: "t1" },
      { procStart: null },
    ]) {
      const h = await start(over);
      await session(h);
      await h.next("agent_up");
      expect(await proof(h)).toBe(false);
      expect(h.of("link_bind")).toHaveLength(0);
      await stopAll();
    }
  });

  it("never binds to a session of another kind with that ref", async () => {
    const h = await start();
    await h.adapter(CONV, {
      kind: "hermes",
      pid: 4242,
      attest: { proc_start: "t0" },
    });
    await h.next("agent_up");
    expect(await proof(h)).toBe(false);
    expect(h.of("link_bind")).toHaveLength(0);
  });

  it("drops a proof for another instance than the session's home, logged once per hash", async () => {
    const logs: string[] = [];
    const h = await start({ logs });
    await session(h);
    await h.next("agent_up");
    // The proxy asks on every tools/call: the drop is logged once.
    for (let i = 0; i < 3; i++)
      expect(await proof(h, { instance: "mit-ai" })).toBe(false);
    expect(await proof(h, { instance: "mit-ai", hash: HASH2 })).toBe(false);
    expect(h.of("link_bind")).toHaveLength(0);
    expect(logs.filter((l) => l.includes("dropped a proof"))).toHaveLength(2);
  });

  it("says not bound to a hub that takes no proofs", async () => {
    const h = await start({ caps: [BUS_CAPS.ids] });
    await session(h);
    await h.next("agent_up");
    expect(await proof(h)).toBe(false);
    expect(h.of("link_bind")).toHaveLength(0);
  });

  it("replays the session's hash after the hub reconnects", async () => {
    const h = await start();
    await session(h);
    await h.next("agent_up");
    expect(await proof(h)).toBe(true);
    await h.next("link_bind");
    h.hubSock()?.close();
    await vi.waitFor(() => expect(h.of("agent_up").length).toBeGreaterThan(1));
    h.toDaemon({
      id: "w2",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: [BUS_CAPS.ids, BUS_CAPS.link],
    });
    await vi.waitFor(() => expect(h.of("agent_up").length).toBeGreaterThan(1));
    h.toDaemon({
      id: h.of("agent_up").at(-1)?.id as string,
      type: "agent_ok",
      agent_ref: CONV,
      bus_name: CONV,
    });
    await h.next("link_bind", 2);
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([HASH, HASH]);
  });
});

it("consumes a native hook witness once for the exact origin, call, tool and arguments", async () => {
  const h = await start({
    caps: [BUS_CAPS.ids, BUS_CAPS.codexCheck, BUS_CAPS.agyCheck],
  });
  await session(h);
  await h.next("agent_up");
  const origin = `http://127.0.0.1:${(h.wss.address() as { port: number }).port}`;
  const call = "call_123456789abc";
  const bind = async (o: string) =>
    daemonLinkProof({
      path: h.socketPath,
      pid: 4242,
      conversation: CONV,
      agyCallSeen: true,
      hash: (await agyCallDigest(o, CONV, call, "get_artifact", HASH))!,
    });
  const check = async (id: string, tool = "get_artifact", hash = HASH) => {
    const answered = new Promise<boolean>((resolve) => {
      const off = h.onFrame((f) => {
        if (f.type === "codex_call_checked" && f.re === id) {
          off();
          resolve(f.ok === true);
        }
      });
    });
    h.toDaemon({
      type: "codex_call_check",
      id,
      harness: "antigravity",
      thread_id: CONV,
      tool,
      mode: { kind: "direct", call_id: call, args_sha256: hash },
    });
    return answered;
  };
  expect(await bind("https://unrelated.example")).toBe(true);
  expect(await check("origin")).toBe(false);
  expect(await bind(origin)).toBe(true);
  expect(await check("tool", "list_agents")).toBe(false);
  expect(await check("args", "get_artifact", HASH2)).toBe(false);
  expect(await check("good")).toBe(true);
  expect(await check("again")).toBe(false);
  expect(h.of("link_bind")).toHaveLength(0);
});
