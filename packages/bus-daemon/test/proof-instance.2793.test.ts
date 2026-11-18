// #2793 S4: a sign-in proof is for one instance. It binds only on that
// instance's hub, only for a session homed there, and never reaches two hubs.
// Two fake hubs; two Claude session files (one in an A folder, one in a B
// folder). Waits are signals (a frame arriving), never sleeps.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLinkProof } from "@oa/bus-ipc";
import { BUS_CAPS, PING, PONG } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { daemonHarness, deliverFrame, stopAll, wsServer } from "./helpers.ts";

afterEach(stopAll);

const TOKEN_B = `oa_machine_${"b".repeat(28)}7f3a`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const M = (c: string) => c.repeat(16);

async function fakeHub() {
  const { wss, url } = await wsServer();
  const raw: string[] = [];
  let sock: WebSocket | undefined;
  wss.on("connection", (ws) => {
    sock = ws;
    ws.on("message", (d) => {
      const text = String(d);
      if (text === PING) ws.send(PONG);
      else raw.push(text);
    });
  });
  const frames = () =>
    raw.map((t) => JSON.parse(t) as { type: string; [k: string]: unknown });
  return {
    origin: url.replace(/\/hub$/, ""),
    raw,
    of: (type: string) => frames().filter((f) => f.type === type),
    send: (f: object) =>
      (sock as WebSocket).send(JSON.stringify({ v: 1, ...f })),
  };
}

const helloOk = {
  id: "w",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.0",
  caps: [BUS_CAPS.ids, BUS_CAPS.link],
};

const session = (dir: string, pid: number, id: string, cwd: string) =>
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: id,
      procStart: "t0",
      name: `name-${id}`,
      messagingSocketPath: "",
      cwd,
    }),
  );

async function setup() {
  const hubB = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), "ob-2793-s4-"));
  mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "instances", "b.json"),
    JSON.stringify({
      name: "b",
      hub: hubB.origin,
      machine_id: "",
      label: "laptop",
      machine_token: TOKEN_B,
    }),
    { mode: 0o600 },
  );
  const sessions = mkdtempSync(join(tmpdir(), "ob-2793-s4-s-"));
  session(sessions, 4242, "sa", "/a/proj");
  session(sessions, 4343, "sb", "/b/proj");
  const logs: string[] = [];
  const h = await daemonHarness({
    instancesHome: home,
    homeLookup: (cwd) =>
      cwd.startsWith("/b/") ? { instance: "b" } : { instance: "main" },
    log: (m) => logs.push(m),
    claude: {
      sessionsDir: sessions,
      socketsDir: join(sessions, "r"),
      syncMs: 20,
      procStart: () => "t0",
      isRunning: () => true,
    },
    transports: { "claude-code": async () => ({ ok: true }) },
  });
  await vi.waitFor(() => expect(h.daemon.hubs.get("b")?.open).toBe(true));
  h.toDaemon(helloOk);
  hubB.send(helloOk);
  await vi.waitFor(() => expect(hubB.of("agent_up")).toHaveLength(1));
  await h.next("agent_up");
  return { h: Object.assign(h, { sessionsDir: sessions }), hubB, logs };
}

/** Both links read in order: once a delivery sent after the proofs is acked, they were handled. */
async function settled(
  h: Awaited<ReturnType<typeof setup>>["h"],
  hubB: Awaited<ReturnType<typeof fakeHub>>,
) {
  h.toDaemon(deliverFrame(M("m"), "sa"));
  hubB.send(deliverFrame(M("n"), "sb"));
  await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
  await vi.waitFor(() => expect(hubB.of("ack")).toHaveLength(1));
}

const proof = (
  h: { socketPath: string },
  pid: number,
  hash: string,
  instance?: string,
) =>
  daemonLinkProof({
    path: h.socketPath,
    pid,
    hash,
    ...(instance === undefined ? {} : { instance }),
  });

describe("one proof per instance (#2793 S4)", () => {
  it("a B proof binds on hub B only, for the B-homed session", async () => {
    const { h, hubB } = await setup();
    expect(await proof(h, 4343, HASH_B, "b")).toBe(true);
    await vi.waitFor(() => expect(hubB.of("link_bind")).toHaveLength(1));
    expect(hubB.of("link_bind")[0]).toMatchObject({
      agent_ref: "sb",
      hash: HASH_B,
    });
    await settled(h, hubB);
    expect(h.of("link_bind")).toEqual([]);
  });

  it("a proof with no instance is main's: it binds on main for the main-homed session", async () => {
    const { h, hubB } = await setup();
    expect(await proof(h, 4242, HASH_A)).toBe(true);
    const bind = await h.next("link_bind");
    expect(bind).toMatchObject({ agent_ref: "sa", hash: HASH_A });
    await settled(h, hubB);
    expect(hubB.of("link_bind")).toEqual([]);
  });

  it("a B proof for an A-homed session reaches no hub, and is logged", async () => {
    const { h, hubB, logs } = await setup();
    expect(await proof(h, 4242, HASH_B, "b")).toBe(false);
    // And a main proof for the B-homed session.
    expect(await proof(h, 4343, HASH_A)).toBe(false);
    // The right ones still bind, each on its own hub.
    expect(await proof(h, 4242, HASH_A)).toBe(true);
    expect(await proof(h, 4343, HASH_B, "b")).toBe(true);
    await vi.waitFor(() => expect(hubB.of("link_bind")).toHaveLength(1));
    await h.next("link_bind");
    await settled(h, hubB);
    const everything = [...h.raw, ...hubB.raw].join("\n");
    // Each hash appears once, on its own hub only.
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([HASH_A]);
    expect(hubB.of("link_bind").map((f) => f.hash)).toEqual([HASH_B]);
    expect(h.raw.join("\n")).not.toContain(HASH_B);
    expect(hubB.raw.join("\n")).not.toContain(HASH_A);
    expect(everything.split(HASH_A)).toHaveLength(2);
    expect(everything.split(HASH_B)).toHaveLength(2);
    expect(logs.filter((l) => l.includes("dropped a proof"))).toHaveLength(2);
    // The log names instances and the session, never a hash.
    expect(logs.join("\n")).not.toContain(HASH_A);
    expect(logs.join("\n")).not.toContain(HASH_B);
  });

  it("a proof for an instance that does not exist reaches no hub", async () => {
    const { h, hubB } = await setup();
    expect(await proof(h, 4343, HASH_B, "nope")).toBe(false);
    await settled(h, hubB);
    expect(h.of("link_bind")).toEqual([]);
    expect(hubB.of("link_bind")).toEqual([]);
  });

  it("a bad instance name is refused by the frame schema", async () => {
    const { h } = await setup();
    await expect(proof(h, 4343, HASH_B, "B/../x")).rejects.toBeDefined();
  });

  it("a proof held for a session that appears later is dropped if it is homed elsewhere", async () => {
    const { h, hubB, logs } = await setup();
    // No record for this pid yet: the B proof waits.
    expect(await proof(h, 4545, HASH_B, "b")).toBe(true);
    session(h.sessionsDir, 4545, "sc", "/a/other");
    await vi.waitFor(() =>
      expect(logs.some((l) => l.includes("dropped a proof"))).toBe(true),
    );
    await settled(h, hubB);
    expect(hubB.of("link_bind")).toEqual([]);
    expect(h.of("link_bind")).toEqual([]);
  });
});
