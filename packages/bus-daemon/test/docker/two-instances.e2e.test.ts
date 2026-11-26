// #2793 S6: the whole "two instances, one bus" done list, end to end, in
// process (it runs in the normal suite, and again in the container). One daemon, two fake hubs, a scratch home with main and an added
// instance b (key files written directly: approval needs a browser), the real
// folder map (folders.json) and the real default lookup. Waits are signals.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLinkProof, daemonStatus } from "@oa/bus-ipc";
import { BUS_CAPS, PING, PONG } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { writeFolders } from "../../src/folders.ts";
import { daemonHarness, deliverFrame, stopAll, wsServer } from "../helpers.ts";

const TOKEN_A = "oa_machine_SECRETSECRETSECRET";
const TOKEN_B = `oa_machine_${"b".repeat(28)}7f3a`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const M = (c: string) => c.repeat(16);
const FUTURE = "2999-01-01T07:00:00Z";

afterEach(stopAll);

async function fakeHub() {
  const { wss, url } = await wsServer();
  const upgrades: (string | undefined)[] = [];
  const raw: string[] = [];
  let sock: WebSocket | undefined;
  wss.on("connection", (ws, req) => {
    upgrades.push(req.headers.authorization);
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
    upgrades,
    raw,
    of: (type: string) => frames().filter((f) => f.type === type),
    send: (f: object) =>
      (sock as WebSocket).send(JSON.stringify({ v: 1, ...f })),
    close: (code: number) => (sock as WebSocket).close(code),
    everything: () => [...upgrades, ...raw].join("\n"),
  };
}

const helloOk = (over: object = {}) => ({
  id: "w",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.0",
  caps: [BUS_CAPS.ids, BUS_CAPS.link],
  ...over,
});

const sessionFile = (dir: string, pid: number, id: string, cwd: string) =>
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

const scratch = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** Marks a link settled: frames are read in order, so a later ack means the earlier ones were handled. */
let marks = 0;
async function settled(
  hub: { of: (t: string) => unknown[]; send: (f: object) => void },
  ref: string,
) {
  const before = hub.of("ack").length;
  hub.send(deliverFrame(`mark${++marks}`.padEnd(16, "k"), ref));
  await vi.waitFor(() => expect(hub.of("ack")).toHaveLength(before + 1));
}

async function setup() {
  const hubB = await fakeHub();
  const home = scratch("oa-e2e-home-");
  // Main is logged in (machine.json); b is an added instance with its own key file.
  writeFileSync(
    join(home, "machine.json"),
    JSON.stringify({
      hub: "https://a.example.test",
      machine_id: "m1",
      label: "laptop",
      machine_token: TOKEN_A,
    }),
    { mode: 0o600 },
  );
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
  const dirA = scratch("oa-e2e-A-");
  const dirB = scratch("oa-e2e-B-");
  writeFolders(
    { map: { [dirA]: "main", [dirB]: "b" }, no: {}, seen: {} },
    home,
  );
  const sessions = scratch("oa-e2e-sessions-");
  sessionFile(sessions, 4242, "sa", dirA);
  sessionFile(sessions, 4343, "sb", dirB);
  const mail: string[] = [];
  const logs: string[] = [];
  const h = await daemonHarness({
    instancesHome: home,
    // No homeLookup: the real folder map decides.
    statusRosterMs: 10,
    log: (m) => logs.push(m),
    claude: {
      sessionsDir: sessions,
      socketsDir: join(sessions, "r"),
      syncMs: 20,
      procStart: () => "t0",
      isRunning: () => true,
    },
    transports: {
      "claude-code": async (a) => {
        mail.push(a.ref);
        return { ok: true };
      },
    },
  });
  await vi.waitFor(() => expect(h.daemon.hubs.get("b")?.open).toBe(true));
  await vi.waitFor(() => expect(hubB.upgrades).toHaveLength(1));
  h.toDaemon(helloOk());
  hubB.send(helloOk());
  await vi.waitFor(() => expect(hubB.of("agent_up")).toHaveLength(1));
  await h.next("agent_up");
  return { h, hubB, home, dirA, dirB, logs, mail, sessions };
}

describe("two instances, one bus (#2793)", () => {
  it("a session registers on exactly one hub, chosen by its folder", async () => {
    const { h, hubB } = await setup();
    expect(h.of("agent_up").map((f) => f.agent_ref)).toEqual(["sa"]);
    expect(hubB.of("agent_up").map((f) => f.agent_ref)).toEqual(["sb"]);
    expect(h.daemon.agents.byRef("sa")?.instance).toBe("main");
    expect(h.daemon.agents.byRef("sb")?.instance).toBe("b");
  });

  it("key A never appears toward B, and key B never toward A", async () => {
    const { h, hubB } = await setup();
    await settled(hubB, "sb");
    expect(h.upgrades.map((u) => u.auth)).toEqual([`Bearer ${TOKEN_A}`]);
    expect(hubB.upgrades).toEqual([`Bearer ${TOKEN_B}`]);
    expect(h.raw.join("\n")).not.toContain(TOKEN_B);
    expect(hubB.everything()).not.toContain(TOKEN_A);
  });

  it("a B-folder session is absent from A's roster, and the other way round", async () => {
    const { h, hubB } = await setup();
    const open = (frames: { open?: unknown }[]) =>
      frames.flatMap((f) => (f.open as string[]) ?? []);
    expect(open(h.of("sessions") as { open?: unknown }[])).toEqual(["sa"]);
    expect(open(hubB.of("sessions") as { open?: unknown }[])).toEqual(["sb"]);
  });

  it("a frame from hub B naming an A agent is dropped", async () => {
    const { h, hubB, mail } = await setup();
    hubB.send(deliverFrame(M("x"), "sa"));
    hubB.send(deliverFrame(M("k"), "sb"));
    await vi.waitFor(() => expect(hubB.of("ack")).toHaveLength(1));
    expect(hubB.of("ack").map((f) => f.msg_id)).toEqual([M("k")]);
    expect(mail).toEqual(["sb"]);
    expect(h.of("ack")).toEqual([]);
  });

  it("revoking on B leaves A connected and delivering", async () => {
    const { h, hubB, home } = await setup();
    hubB.close(4403);
    await vi.waitFor(() =>
      expect(existsSync(join(home, "instances", "b.revoked"))).toBe(true),
    );
    expect(h.daemon.hubs.get("b")?.open).toBe(false);
    expect(h.daemon.hub.open).toBe(true);
    h.toDaemon(deliverFrame(M("e"), "sa"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
  });

  it("a daemon-wide command from B is ignored; from A it works", async () => {
    const { h, hubB } = await setup();
    const away = async () =>
      (await daemonStatus({ path: h.socketPath, timeoutMs: 3000 }))
        .owner_away_until;
    hubB.send({ id: "o1", type: "owner_away", until: FUTURE });
    await settled(hubB, "sb");
    expect(await away()).toBeUndefined();
    h.toDaemon({ id: "o2", type: "owner_away", until: FUTURE });
    await vi.waitFor(async () => expect(await away()).toBe(FUTURE));
  });

  it("status lists both instances with their agent counts", async () => {
    const { h } = await setup();
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.instances).toEqual([
      { name: "main", link: "connected", revoked: false, agents: 1 },
      { name: "b", link: "connected", revoked: false, agents: 1 },
    ]);
  });

  it("a proof for B never reaches A", async () => {
    const { h, hubB } = await setup();
    const proof = (pid: number, hash: string, instance?: string) =>
      daemonLinkProof({
        path: h.socketPath,
        pid,
        hash,
        ...(instance === undefined ? {} : { instance }),
      });
    expect(await proof(4343, HASH_B, "b")).toBe(true);
    expect(await proof(4242, HASH_B, "b")).toBe(false);
    expect(await proof(4242, HASH_A)).toBe(true);
    await vi.waitFor(() => expect(hubB.of("link_bind")).toHaveLength(1));
    await h.next("link_bind");
    await settled(hubB, "sb");
    expect(h.raw.join("\n")).not.toContain(HASH_B);
    expect(hubB.raw.join("\n")).not.toContain(HASH_A);
  });

  it("an unmapped folder registers on no hub and its session is told how to answer", async () => {
    const { h, hubB, sessions } = await setup();
    const dirU = scratch("oa-e2e-U-");
    sessionFile(sessions, 4444, "su", dirU);
    await vi.waitFor(() => expect(h.daemon.agents.byRef("su")).toBeDefined());
    expect(h.daemon.agents.byRef("su")?.instance).toBeUndefined();
    const c = await h.adapter("su2", { cwd: dirU });
    expect(c.welcome.bus_name).toBeDefined();
    await settled(hubB, "sb");
    expect(h.raw.join("\n")).not.toContain('"su"');
    expect(hubB.raw.join("\n")).not.toContain('"su"');
    expect(h.raw.join("\n")).not.toContain('"su2"');
    expect(hubB.raw.join("\n")).not.toContain('"su2"');
    const me = await c.request({ type: "self", row: true });
    expect(me).toMatchObject({
      type: "agent",
      agent: {
        live: false,
        config_files: [
          expect.objectContaining({
            reason: expect.stringContaining("use in this folder"),
          }),
        ],
      },
    });
  });
});

describe("one instance, as today (#2793)", () => {
  it("every folder uses main, with no map and no extra links", async () => {
    const home = scratch("oa-e2e-single-");
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({
        hub: "https://a.example.test",
        machine_id: "m1",
        label: "laptop",
        machine_token: TOKEN_A,
      }),
      { mode: 0o600 },
    );
    const h = await daemonHarness({
      instancesHome: home,
      transports: { "claude-code": async () => ({ ok: true }) },
    });
    const c = await h.adapter("only", { cwd: scratch("oa-e2e-any-") });
    expect(c.welcome.bus_name).toBeDefined();
    expect(await h.next("agent_up")).toMatchObject({ agent_ref: "only" });
    expect([...h.daemon.hubs.keys()]).toEqual(["main"]);
    expect(h.daemon.agents.byRef("only")?.instance).toBe("main");
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.instances).toBeUndefined();
    expect(existsSync(join(home, "folders.json"))).toBe(false);
  });
});
