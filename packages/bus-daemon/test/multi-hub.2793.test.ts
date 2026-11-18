// #2793 S3: one daemon, several hubs. Two fake hubs in process; a scratch home
// holds the added instance. Plain vitest, no host dependencies.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_CAPS, daemonLinkProof, daemonStatus } from "@oa/bus-ipc";
import { BUS_CAPS, PING, PONG } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { writeFolders } from "../src/folders.ts";
import { credentialsFor } from "../src/instances.ts";
import { daemonHarness, deliverFrame, stopAll, wsServer } from "./helpers.ts";

afterEach(stopAll);

const TOKEN_A = "oa_machine_SECRETSECRETSECRET";
const TOKEN_B = `oa_machine_${"b".repeat(28)}7f3a`;
/** A valid message id: sixteen base58 characters. */
const M = (c: string) => c.repeat(16);
const FUTURE = "2999-01-01T07:00:00Z";

/** A hub that records every upgrade header and every frame the daemon writes. */
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
    frames,
    of: (type: string) => frames().filter((f) => f.type === type),
    send: (f: object) =>
      (sock as WebSocket).send(JSON.stringify({ v: 1, ...f })),
    close: (code: number) => (sock as WebSocket).close(code),
    everything: () => [...upgrades, ...raw].join("\n"),
  };
}

/**
 * Frames on one link are read in order: once a delivery sent after them is
 * acked, every earlier frame has been handled. A signal, not a sleep.
 */
let marks = 0;
async function settled(hub: Awaited<ReturnType<typeof fakeHub>>) {
  const before = hub.of("ack").length;
  hub.send(deliverFrame(`mark${++marks}`.padEnd(16, "k"), "refB"));
  await vi.waitFor(() => expect(hub.of("ack")).toHaveLength(before + 1));
}

const helloOk = (over: object = {}) => ({
  id: "w",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.0",
  ...over,
});

const byFolder = (cwd: string) =>
  cwd.startsWith("/b/")
    ? { instance: "b" }
    : cwd.startsWith("/u/")
      ? { unmapped: true as const }
      : { instance: "main" };

async function setup(over: Parameters<typeof daemonHarness>[0] = {}) {
  const hubB = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), "ob-2793-"));
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
  const mail: { ref: string; body: string }[] = [];
  const logs: string[] = [];
  const h = await daemonHarness({
    instancesHome: home,
    homeLookup: byFolder,
    statusRosterMs: 10,
    log: (m) => logs.push(m),
    transports: {
      "claude-code": async (a, m) => {
        mail.push({ ref: a.ref, body: m.body });
        return { ok: true };
      },
    },
    ...over,
  });
  const hubB2 = h.daemon.hubs.get("b");
  await vi.waitFor(() => expect(hubB2?.open).toBe(true));
  await vi.waitFor(() => expect(hubB.upgrades).toHaveLength(1));
  const a = await h.adapter("refA", { cwd: "/a/proj" });
  const b = await h.adapter("refB", { cwd: "/b/proj" });
  return { h, hubB, home, mail, logs, a, b };
}

describe("one daemon, two hubs (#2793 S3)", () => {
  it("each key goes only to its own hub, in every upgrade header and every frame", async () => {
    const { h, hubB } = await setup();
    await h.next("agent_up");
    await vi.waitFor(() => expect(hubB.of("agent_up")).toHaveLength(1));
    expect(h.upgrades.map((u) => u.auth)).toEqual([`Bearer ${TOKEN_A}`]);
    expect(hubB.upgrades).toEqual([`Bearer ${TOKEN_B}`]);
    expect(h.raw.join("\n")).not.toContain(TOKEN_B);
    expect(hubB.everything()).not.toContain(TOKEN_A);
    expect(h.raw.join("\n")).not.toContain("b".repeat(28));
  });

  it("a session registers on its folder's hub only", async () => {
    const { h, hubB } = await setup();
    await vi.waitFor(() => expect(hubB.of("agent_up")).toHaveLength(1));
    expect(h.of("agent_up").map((f) => f.agent_ref)).toEqual(["refA"]);
    expect(hubB.of("agent_up").map((f) => f.agent_ref)).toEqual(["refB"]);
    const listed = (frames: { open?: unknown }[]) =>
      frames.flatMap((f) => (f.open as string[]) ?? []);
    expect(listed(h.of("sessions"))).not.toContain("refB");
    expect(listed(hubB.of("sessions") as { open?: unknown }[])).not.toContain(
      "refA",
    );
    expect(h.daemon.agents.byRef("refB")?.instance).toBe("b");
  });

  it("a folder with no mapping registers on no hub, and is noted once", async () => {
    const { h, hubB, logs } = await setup();
    const u = await h.adapter("refU", { cwd: "/u/proj" });
    await h.adapter("refU2", { cwd: "/u/proj" });
    expect(u.welcome.bus_name).toBeDefined();
    await vi.waitFor(() => expect(hubB.of("agent_up")).toHaveLength(1));
    const everyone = [...h.frames, ...hubB.frames()].map(
      (f) => (f as { agent_ref?: string }).agent_ref,
    );
    expect(everyone).not.toContain("refU");
    expect(everyone).not.toContain("refU2");
    expect(logs.filter((l) => l.includes("/u/proj"))).toHaveLength(1);
  });

  it("delivers on the hub its agent is on, and acks there", async () => {
    const { h, hubB, mail } = await setup();
    await vi.waitFor(() => expect(hubB.of("agent_up")).toHaveLength(1));
    hubB.send(deliverFrame(M("b"), "refB"));
    await vi.waitFor(() => expect(hubB.of("ack")).toHaveLength(1));
    h.toDaemon(deliverFrame(M("a"), "refA"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
    expect(mail.map((m) => m.ref)).toEqual(["refB", "refA"]);
    expect(h.of("ack").map((f) => f.msg_id)).toEqual([M("a")]);
    expect(hubB.of("ack").map((f) => f.msg_id)).toEqual([M("b")]);
  });

  it("drops a frame from hub B that names an agent of hub A, or of none", async () => {
    const { h, hubB, mail, logs } = await setup();
    await h.adapter("refU", { cwd: "/u/proj" });
    hubB.send(deliverFrame(M("x"), "refA"));
    hubB.send(deliverFrame(M("y"), "refU"));
    hubB.send(deliverFrame(M("z"), "nobody"));
    // A frame that does arrive after them proves the others were read.
    hubB.send(deliverFrame(M("k"), "refB"));
    await vi.waitFor(() => expect(hubB.of("ack")).toHaveLength(1));
    expect(mail.map((m) => m.ref)).toEqual(["refB"]);
    expect(hubB.of("ack").map((f) => f.msg_id)).toEqual([M("k")]);
    // A ref nobody registered is refused on the link that asked, as with one hub.
    expect(hubB.of("refuse").map((f) => f.msg_id)).toEqual([M("z")]);
    expect(h.of("ack")).toEqual([]);
    expect(h.of("refuse")).toEqual([]);
    expect(logs.some((l) => l.includes("dropped a deliver frame from b"))).toBe(
      true,
    );
    // And the same the other way round.
    h.toDaemon(deliverFrame(M("c"), "refB"));
    h.toDaemon(deliverFrame(M("d"), "refA"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
    expect(h.of("ack").map((f) => f.msg_id)).toEqual([M("d")]);
    expect(mail.map((m) => m.ref)).toEqual(["refB", "refA"]);
  });

  it("an answer on hub B to a request made on hub A is dropped", async () => {
    const { h, hubB, a } = await setup();
    const call = a.request({ type: "list" } as never).catch(() => undefined);
    const req = (await h.next("list")) as { id: string };
    hubB.send({
      id: req.id,
      type: "roster",
      agents: [{ name: "from-b" }],
    });
    // B's frame was dropped: the request still waits for A.
    await settled(hubB);
    h.toDaemon({ id: req.id, type: "roster", agents: [] });
    const r = (await call) as { type?: string; agents?: unknown[] } | undefined;
    expect(r?.type).toBe("roster");
    expect(JSON.stringify(r)).not.toContain("from-b");
  });

  it("revoking hub B closes B only, writes its marker, and A still delivers", async () => {
    const { h, hubB, home, mail } = await setup();
    const bHub = h.daemon.hubs.get("b");
    hubB.close(4403);
    await vi.waitFor(() =>
      expect(existsSync(join(home, "instances", "b.revoked"))).toBe(true),
    );
    expect(bHub?.open).toBe(false);
    expect(h.daemon.hub.open).toBe(true);
    h.toDaemon(deliverFrame(M("e"), "refA"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
    expect(mail.map((m) => m.ref)).toEqual(["refA"]);
    // The marker holds a hash, never the token.
    const marker = (await import("node:fs")).readFileSync(
      join(home, "instances", "b.revoked"),
      "utf8",
    );
    expect(marker).not.toContain(TOKEN_B);
  });

  it("a revoke of main keeps today's behaviour (the daemon is told, B is not closed by it)", async () => {
    const onRevoked = vi.fn();
    const revokedFile = join(
      mkdtempSync(join(tmpdir(), "ob-2793-rv-")),
      "revoked",
    );
    const { h, hubB } = await setup({ onRevoked, revokedFile });
    h.hubSock()?.close(4403);
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalled());
    expect(h.daemon.hubs.get("b")?.open).toBe(true);
    expect(hubB.upgrades).toHaveLength(1);
  });

  it("an owner_away command from B is ignored; from main it works", async () => {
    const { h, hubB } = await setup({ statusRosterMs: 10 });
    const away = async () =>
      (await daemonStatus({ path: h.socketPath, timeoutMs: 3000 }))
        .owner_away_until;
    hubB.send({ id: "o1", type: "owner_away", until: FUTURE });
    hubB.send(helloOk({ owner_away_until: FUTURE }));
    await settled(hubB);
    expect(await away()).toBeUndefined();
    h.toDaemon({ id: "o2", type: "owner_away", until: FUTURE });
    await vi.waitFor(async () => expect(await away()).toBe(FUTURE));
  });

  it("an update instruction from B never reaches the updater; from main it does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-2793-up-"));
    const prevHome = process.env.OA_BUS_HOME;
    process.env.OA_BUS_HOME = dir;
    try {
      const { h, hubB } = await setup({
        update: {
          entryFile: join(dir, "bin/dist/index.js"),
          exit: vi.fn(),
          every: () => () => {},
        },
      });
      const spy = vi
        .spyOn(
          h.daemon.updater as never as {
            instructFromInstance: () => Promise<unknown>;
          },
          "instructFromInstance",
        )
        .mockResolvedValue({ kind: "disabled" });
      hubB.send(helloOk({ caps: ["run_version"], run_version: "1.1.0" }));
      hubB.send({ id: "p0", type: "run_version", run_version: "1.1.0" });
      hubB.send({ id: "p1", type: "install_now" });
      await settled(hubB);
      expect(spy).not.toHaveBeenCalled();
      h.toDaemon(helloOk({ caps: ["run_version"], run_version: "1.3.0" }));
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("1.3.0"));
    } finally {
      process.env.OA_BUS_HOME = prevHome;
    }
  });
});

describe("a session's reach call goes to its own hub (#2793 S3)", () => {
  it("uses the instance key and address, and fails closed for an unmapped folder", async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchStub = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)
          ?.authorization,
      });
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const s = await setup({ fetch: fetchStub });
    const portB = new URL(s.hubB.origin.replace(/^ws/, "http")).port;
    const portA = String((s.h.wss.address() as { port: number }).port);
    const ask = async (ref: string, cwd: string) => {
      const c = await s.h.adapter(ref, { cwd, caps: [ADAPTER_CAPS.reach] });
      return c.request({ type: "propose_reach", namespaces: ["a"] } as never);
    };
    await ask("rB", "/b/x");
    await ask("rA", "/a/x");
    const un = (await ask("rU", "/u/x")) as { code?: string };
    expect(calls).toHaveLength(2);
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN_B}`);
    expect(calls[0]?.url).toContain(`:${portB}/`);
    expect(calls[1]?.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(calls[1]?.url).toContain(`:${portA}/`);
    expect(un.code).toBe("hub_unavailable");
  });
});

describe("a single instance behaves as before (#2793 S3)", () => {
  it("one link, every session on main, no routing marks", async () => {
    const h = await daemonHarness({
      transports: { "claude-code": async () => ({ ok: true }) },
    });
    const c = await h.adapter("only", { cwd: "/anywhere" });
    expect(c.welcome.bus_name).toBeDefined();
    expect(await h.next("agent_up")).toMatchObject({ agent_ref: "only" });
    expect([...h.daemon.hubs.keys()]).toEqual(["main"]);
    expect(h.daemon.hubs.get("main")).toBe(h.daemon.hub);
    expect(h.daemon.agents.byRef("only")?.instance).toBe("main");
    expect(h.upgrades.map((u) => u.auth)).toEqual([`Bearer ${TOKEN_A}`]);
    expect(h.of("sessions").at(-1)).toMatchObject({ open: [], closed: [] });
    h.toDaemon(deliverFrame(M("m"), "only"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
  });

  it("an added instance whose file cannot be used is skipped, and main carries on", async () => {
    const home = mkdtempSync(join(tmpdir(), "ob-2793-bad-"));
    mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "instances", "bad.json"), "{", { mode: 0o600 });
    const logs: string[] = [];
    const h = await daemonHarness({
      instancesHome: home,
      homeLookup: () => ({ instance: "main" }),
      log: (m) => logs.push(m),
    });
    await h.adapter("only", { cwd: "/anywhere" });
    expect(await h.next("agent_up")).toMatchObject({ agent_ref: "only" });
    expect([...h.daemon.hubs.keys()]).toEqual(["main"]);
    expect(logs.some((l) => l.includes("bad is not connected"))).toBe(true);
    expect(logs.join("\n")).not.toContain("machine_token");
  });
});

describe("routing fails closed when an added instance has no link (#2793 S3)", () => {
  it("a folder mapped to it, and an unmapped one, never register on main", async () => {
    const home = mkdtempSync(join(tmpdir(), "ob-2793-open-"));
    mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "instances", "b.json"),
      JSON.stringify({
        name: "b",
        hub: "https://b.example.test",
        machine_id: "",
        label: "laptop",
        machine_token: TOKEN_B,
      }),
      { mode: 0o644 },
    );
    const logs: string[] = [];
    const h = await daemonHarness({
      instancesHome: home,
      homeLookup: byFolder,
      log: (m) => logs.push(m),
    });
    expect([...h.daemon.hubs.keys()]).toEqual(["main"]);
    await h.adapter("refB", { cwd: "/b/proj" });
    await h.adapter("refU", { cwd: "/u/proj" });
    const refA = await h.adapter("refA", { cwd: "/a/proj" });
    expect(refA.welcome.bus_name).toBeDefined();
    expect(await h.next("agent_up")).toMatchObject({ agent_ref: "refA" });
    expect(h.of("agent_up").map((f) => f.agent_ref)).toEqual(["refA"]);
    expect(h.daemon.agents.byRef("refB")?.instance).toBeUndefined();
    expect(h.daemon.agents.byRef("refU")?.instance).toBeUndefined();
  });
});

describe("review fixes (#2793 S3)", () => {
  it("update_ack and install_now from B are dropped: updates come from main only", async () => {
    const { hubB, logs } = await setup();
    hubB.send({ id: "u1", type: "update_ack", ok: true });
    hubB.send({ id: "u2", type: "install_now" });
    await settled(hubB);
    expect(
      logs.some((l) => l.includes("dropped a update_ack frame from b")),
    ).toBe(true);
    expect(
      logs.some((l) => l.includes("dropped a install_now frame from b")),
    ).toBe(true);
  });

  it("a receipt_update from B for a message of main is ignored", async () => {
    const { h, hubB, logs } = await setup();
    h.toDaemon(deliverFrame(M("a"), "refA"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
    hubB.send({
      id: "r1",
      type: "receipt_update",
      msg_id: M("a"),
      state: "delivered",
    });
    await settled(hubB);
    expect(
      logs.some((l) => l.includes("dropped a receipt_update frame from b")),
    ).toBe(true);
  });

  it("a msg_id that hub B reuses from main does not re-point it", async () => {
    const { h, hubB, mail, logs } = await setup();
    h.toDaemon(deliverFrame(M("a"), "refA"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
    hubB.send(deliverFrame(M("a"), "refB"));
    await settled(hubB);
    // B's copy was neither delivered nor acked under that id.
    expect(mail.filter((m) => m.ref === "refB")).toHaveLength(1);
    expect(hubB.of("ack").map((f) => f.msg_id)).not.toContain(M("a"));
    expect(logs.some((l) => l.includes("msg_id is another instance's"))).toBe(
      true,
    );
  });

  it("a restart after B's revoke does not dial B with the revoked key", async () => {
    const hubB = await fakeHub();
    const home = mkdtempSync(join(tmpdir(), "ob-2793-rv-"));
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
    writeFileSync(
      join(home, "instances", "b.revoked"),
      JSON.stringify({
        at: new Date().toISOString(),
        token_sha256: createHash("sha256").update(TOKEN_B).digest("hex"),
      }),
    );
    const logs: string[] = [];
    const h = await daemonHarness({
      instancesHome: home,
      homeLookup: byFolder,
      log: (m) => logs.push(m),
    });
    await h.adapter("refA", { cwd: "/a/proj" });
    await h.next("agent_up");
    expect(h.daemon.hubs.get("b")).toBeUndefined();
    expect(hubB.upgrades).toEqual([]);
    expect(logs.some((l) => l.includes("revoked by its hub"))).toBe(true);
    // A marker for an older key is stale: a newer key is used.
    writeFileSync(
      join(home, "instances", "b.revoked"),
      JSON.stringify({ at: "x", token_sha256: "0".repeat(64) }),
    );
    expect(credentialsFor("b", home).machine_token).toBe(TOKEN_B);
  });

  it("with no homeLookup given, the daemon reads the folder map", async () => {
    const { h, hubB, home } = await setup({ homeLookup: undefined });
    // No map yet: neither session is tied to an instance, so none registers.
    expect(h.of("agent_up")).toEqual([]);
    expect(hubB.of("agent_up")).toEqual([]);
    writeFolders({ map: { "/a": "main", "/b": "b" }, no: {}, seen: {} }, home);
    await h.adapter("refC", { cwd: "/b/other" });
    await vi.waitFor(() =>
      expect(hubB.of("agent_up").map((f) => f.agent_ref)).toEqual(["refC"]),
    );
    expect(h.of("agent_up")).toEqual([]);
  });

  it("a Codex ack is replayed on the link that owns it only", async () => {
    const takenFile = join(mkdtempSync(join(tmpdir(), "ob-ct-")), "p.json");
    writeFileSync(
      takenFile,
      JSON.stringify({
        [M("c")]: {
          state: "taken",
          thread: "019a0000-0000-7000-8000-000000000001",
          at: Date.now(),
          head: "[oa-bus] from peer",
        },
      }),
    );
    const { h, hubB } = await setup({ codex: { takenFile } as never });
    // The mail came in on main: main owns its id.
    h.toDaemon(deliverFrame(M("c"), "refA"));
    await vi.waitFor(() => expect(h.of("ack")).toHaveLength(1));
    // B's hello_ok lists ack_confirm: main's record is not B's to replay,
    // and B's link must not make main send it again either.
    hubB.send(helloOk({ caps: [BUS_CAPS.ackConfirm] }));
    await settled(hubB);
    expect(hubB.of("ack").map((f) => f.msg_id)).not.toContain(M("c"));
    expect(h.of("ack")).toHaveLength(1);
    h.toDaemon(helloOk({ caps: [BUS_CAPS.ackConfirm] }));
    await vi.waitFor(() => expect(h.of("ack").length).toBeGreaterThan(1), {
      timeout: 15_000,
    });
    expect(h.of("ack").every((f) => f.msg_id === M("c"))).toBe(true);
  }, 30_000);

  it("link_bind goes only on the session's own hub", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-lb-"));
    writeFileSync(
      join(d, "4242.json"),
      JSON.stringify({
        pid: 4242,
        sessionId: "s-b",
        procStart: "t0",
        name: "b-session",
        messagingSocketPath: "",
        cwd: "/b/proj",
      }),
    );
    const { h, hubB } = await setup({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 20,
        procStart: () => "t0",
        isRunning: () => true,
      },
    });
    const caps = [BUS_CAPS.ids, BUS_CAPS.link];
    hubB.send(helloOk({ caps }));
    h.toDaemon(helloOk({ caps }));
    await vi.waitFor(() =>
      expect(hubB.of("agent_up").map((f) => f.agent_ref)).toContain("s-b"),
    );
    const up = hubB.of("agent_up").find((f) => f.agent_ref === "s-b");
    hubB.send({
      id: up?.id,
      type: "agent_ok",
      agent_ref: "s-b",
      bus_name: "b-session",
    });
    await daemonLinkProof({
      path: h.socketPath,
      pid: 4242,
      hash: "a".repeat(64),
    });
    await vi.waitFor(() => expect(hubB.of("link_bind")).toHaveLength(1));
    expect(h.of("link_bind")).toEqual([]);
  });
});
