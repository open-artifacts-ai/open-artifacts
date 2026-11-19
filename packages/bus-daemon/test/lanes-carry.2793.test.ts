// #2793 S4: what #2869 keeps across a restart and a resume is kept per
// instance (lane). A saved entry, a pending proof and a resume sibling of one
// instance never reach a record homed on another, so a proof is never offered
// to two hubs. Waits are signals, never sleeps.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLinkProof } from "@oa/bus-ipc";
import { BUS_CAPS, PING, PONG } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { daemonHarness, stopAll, wsServer } from "./helpers.ts";

afterEach(stopAll);

const TOKEN_B = `oa_machine_${"b".repeat(28)}7f3a`;
const HASH_B = "b".repeat(64);
const HASH_A = "a".repeat(64);

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
  return {
    origin: url.replace(/\/hub$/, ""),
    raw,
    of: (type: string) =>
      raw
        .map((t) => JSON.parse(t) as { type: string; [k: string]: unknown })
        .filter((f) => f.type === type),
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

const file = (dir: string, pid: number, id: string, cwd: string) =>
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

async function setup(
  sessionFiles: [number, string, string][],
  saved?: object[],
) {
  const hubB = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), "ob-2793-lc-"));
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
  const sessions = mkdtempSync(join(tmpdir(), "ob-2793-lc-s-"));
  for (const [pid, id, cwd] of sessionFiles) file(sessions, pid, id, cwd);
  const linksFile = join(
    mkdtempSync(join(tmpdir(), "ob-2793-lc-l-")),
    "claude-links.json",
  );
  if (saved)
    writeFileSync(linksFile, JSON.stringify({ v: 1, links: saved }), {
      mode: 0o600,
    });
  const h = await daemonHarness({
    instancesHome: home,
    homeLookup: (cwd) =>
      cwd.startsWith("/b/") ? { instance: "b" } : { instance: "main" },
    claude: {
      sessionsDir: sessions,
      socketsDir: join(sessions, "r"),
      linksFile,
      syncMs: 20,
      procStart: () => "t0",
      isRunning: () => true,
    },
    transports: { "claude-code": async () => ({ ok: true }) },
  });
  await vi.waitFor(() => expect(h.daemon.hubs.get("b")?.open).toBe(true));
  h.toDaemon(helloOk);
  hubB.send(helloOk);
  return { h, hubB, sessions, linksFile };
}

describe("one proof is never offered to two hubs (#2793 S4)", () => {
  it("(a) a saved entry for instance b is never seeded into a record homed on main", async () => {
    const { h, hubB, linksFile } = await setup(
      [[4242, "sa", "/a/proj"]],
      [{ pid: 4242, procStart: "t0", hashes: [HASH_B], instance: "b" }],
    );
    const up = await h.next("agent_up");
    h.toDaemon({ id: up.id, type: "agent_ok", agent_ref: "sa", bus_name: "n" });
    // Let the sync tick run several times over the live record.
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("sa")?.procStart).toBe("t0"),
    );
    expect(h.daemon.agents.byRef("sa")?.linkHashes).toBeUndefined();
    expect(h.of("link_bind")).toEqual([]);
    expect(hubB.of("link_bind")).toEqual([]);
    expect(h.raw.join("\n")).not.toContain(HASH_B);
    // The entry waits for a b-homed session of that process: still saved.
    expect(readFileSync(linksFile, "utf8")).toContain(HASH_B);
  });

  it("(b) a pending proof for b is never claimed by a main-homed record", async () => {
    const { h, hubB, sessions } = await setup([]);
    expect(
      await daemonLinkProof({
        path: h.socketPath,
        pid: 4545,
        hash: HASH_B,
        instance: "b",
      }),
    ).toBe(true);
    file(sessions, 4545, "sc", "/a/other");
    const up = await h.next("agent_up");
    h.toDaemon({ id: up.id, type: "agent_ok", agent_ref: "sc", bus_name: "n" });
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("sc")?.procStart).toBe("t0"),
    );
    // The claim ran (a main proof for the same pid binds), and took nothing of b's.
    expect(
      await daemonLinkProof({ path: h.socketPath, pid: 4545, hash: HASH_A }),
    ).toBe(true);
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(1));
    expect(h.daemon.agents.byRef("sc")?.linkHashes).toEqual([HASH_A]);
    expect(h.raw.join("\n")).not.toContain(HASH_B);
    expect(hubB.of("link_bind")).toEqual([]);
  });

  it("(c) a resume sibling on another instance gets no hashes", async () => {
    const { h, hubB, sessions } = await setup([[4242, "sa", "/a/proj"]]);
    const up = await h.next("agent_up");
    h.toDaemon({ id: up.id, type: "agent_ok", agent_ref: "sa", bus_name: "n" });
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: HASH_A });
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(1));
    // The file switches to a session of the same process homed on b: it is
    // listed, so it is the sibling the leaving main session would carry to.
    file(sessions, 4242, "sx", "/b/proj");
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("sa")?.live).toBe(false),
    );
    expect(h.daemon.agents.byRef("sx")?.live).toBe(true);
    expect(h.daemon.agents.byRef("sx")?.instance).toBe("b");
    expect(h.daemon.agents.byRef("sx")?.linkHashes).toBeUndefined();
    expect(hubB.of("link_bind")).toEqual([]);
    expect(hubB.raw.join("\n")).not.toContain(HASH_A);
  });
});
