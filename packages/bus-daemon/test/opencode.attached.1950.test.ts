import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attest } from "../src/attest.ts";
import {
  type AttachDeps,
  attachedTo,
  cachedAttach,
  defaultAttachDeps,
  lsofConnectedPorts,
  lsofListenPorts,
  parseProcNetTcp,
} from "../src/presence/attached.ts";
import { openSessions } from "../src/presence/opencode.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

afterEach(stopAll);

const OC = "/opt/bin/opencode";
/** A world of pids: who runs what, who is whose parent, who listens and who is connected. */
function world(w: {
  exe?: Record<number, string>;
  ppid?: Record<number, number>;
  listen?: Record<number, number[]>;
  conn?: Record<number, number[]>;
}): AttachDeps {
  return {
    exeOf: (p) => w.exe?.[p] ?? null,
    ppidOf: (p) => w.ppid?.[p] ?? null,
    listenPorts: (p) => (w.listen?.[p] ? new Set(w.listen[p]) : null),
    connectedPorts: (p) => (w.conn?.[p] ? new Set(w.conn[p]) : null),
  };
}

describe("attachedTo (#1950)", () => {
  const base = {
    exe: { 10: OC, 20: OC, 11: OC, 21: OC, 66: "/usr/bin/node" },
    listen: { 10: [4001], 20: [4002] },
  };
  it("accepts a TUI connected to the service's port, refuses another service's", () => {
    const a = attachedTo(
      10,
      world({ ...base, conn: { 11: [4001], 21: [4002] } }),
    );
    expect(a(11)).toBe(true);
    expect(a(21)).toBe(false);
  });
  it("refuses a forged presence pid: right socket, wrong executable", () => {
    const a = attachedTo(10, world({ ...base, conn: { 66: [4001] } }));
    expect(a(66)).toBe(false);
  });
  it("accepts a standalone TUI that is the service's parent, with the exe check", () => {
    const w = world({ ...base, ppid: { 10: 11 } });
    expect(attachedTo(10, w)(11)).toBe(true);
    expect(attachedTo(10, w)(66)).toBe(false);
    expect(
      attachedTo(
        10,
        world({
          ...base,
          exe: { ...base.exe, 11: "/usr/bin/node" },
          ppid: { 10: 11 },
        }),
      )(11),
    ).toBe(false);
  });
  it("fails closed on every read failure", () => {
    const ok = world({ ...base, conn: { 11: [4001] } });
    expect(attachedTo(10, { ...ok, exeOf: () => null })(11)).toBe(false);
    expect(
      attachedTo(10, { ...ok, exeOf: (p) => (p === 10 ? OC : null) })(11),
    ).toBe(false);
    expect(attachedTo(10, { ...ok, listenPorts: () => null })(11)).toBe(false);
    expect(attachedTo(10, { ...ok, listenPorts: () => new Set() })(11)).toBe(
      false,
    );
    expect(attachedTo(10, { ...ok, connectedPorts: () => null })(11)).toBe(
      false,
    );
  });
  it("treats a binary replaced in place as the same program", () => {
    const d = world({
      exe: {
        10: "/x/opencode (deleted)",
        11: "/x/opencode",
        66: "/y/opencode",
      },
      listen: { 10: [4001] },
      conn: { 11: [4001], 66: [4001] },
    });
    expect(attachedTo(10, d)(11)).toBe(true);
    expect(attachedTo(10, d)(66)).toBe(false);
    const flipped = world({
      exe: { 10: "/x/opencode", 11: "/x/opencode (deleted)" },
      listen: { 10: [4001] },
      conn: { 11: [4001] },
    });
    expect(attachedTo(10, flipped)(11)).toBe(true);
  });
  it("reads the service once per hello, not once per TUI", () => {
    let listens = 0;
    const d = world({ ...base, conn: { 11: [4001], 21: [4002] } });
    const a = attachedTo(10, {
      ...d,
      listenPorts: (p) => {
        listens++;
        return d.listenPorts(p);
      },
    });
    a(11);
    a(21);
    a(11);
    expect(listens).toBe(1);
  });
});

describe("cachedAttach (#1950)", () => {
  it("reads the OS once within the TTL, and again after it", () => {
    let reads = 0;
    const d = world({
      exe: { 10: OC, 11: OC, 12: OC },
      listen: { 10: [4001] },
      conn: { 11: [4001], 12: [] },
    });
    const counted: AttachDeps = {
      ...d,
      connectedPorts: (p) => {
        reads++;
        return d.connectedPorts(p);
      },
    };
    let t = 0;
    const attached = cachedAttach(counted, () => t, 2000);
    expect(attached(10)(11)).toBe(true);
    expect(attached(10)(12)).toBe(false);
    t = 1999;
    expect(attached(10)(11)).toBe(true);
    expect(attached(10)(12)).toBe(false);
    expect(reads).toBe(2); // 11 and 12 once each
    t = 2000;
    expect(attached(10)(11)).toBe(true);
    expect(reads).toBe(3);
  });
  it("a cached 'not attached' expires as fast as a cached 'attached'", () => {
    const conn: Record<number, number[]> = {};
    const d = world({ exe: { 10: OC, 11: OC }, listen: { 10: [4001] }, conn });
    let t = 0;
    const attached = cachedAttach(d, () => t, 2000);
    expect(attached(10)(11)).toBe(false);
    conn[11] = [4001];
    t = 1000;
    expect(attached(10)(11)).toBe(false);
    t = 2000;
    expect(attached(10)(11)).toBe(true);
  });
});

describe("parsers", () => {
  it("reads /proc/net/tcp rows", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:C0DE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0 100 0",
      "   1: 0100007F:D431 0100007F:C0DE 01 00000000:00000000 00:00000000 00000000  1000        0 777 1 0 100 0",
    ].join("\n");
    expect(parseProcNetTcp(text)).toEqual([
      {
        state: "0A",
        localPort: 49374,
        remote: "00000000:0000",
        inode: "12345",
      },
      { state: "01", localPort: 54321, remote: "0100007F:C0DE", inode: "777" },
    ]);
  });
  it("reads lsof -Fn output", () => {
    expect(lsofListenPorts("p1\nn127.0.0.1:49374\nn*:5000\n")).toEqual(
      new Set([49374, 5000]),
    );
    expect(
      lsofConnectedPorts(
        "p2\nn127.0.0.1:5000->127.0.0.1:49374\nn10.0.0.2:5->10.0.0.9:443\n",
      ),
    ).toEqual(new Set([49374]));
  });
});

describe("attest scopes presence to the attested service", () => {
  const presence = (dir: string, pid: number, ids: string[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionIDs: ids }),
    );
  };
  const comms: Record<number, string> = { 9001: "opencode", 9002: "opencode" };
  const deps = (dir: string, attach: AttachDeps) => ({
    ancestors: (pid: number) => [pid],
    comm: (pid: number) => comms[pid] ?? null,
    openSessions: (service: number) =>
      openSessions(dir, {
        isRunning: () => true,
        procStartEpoch: () => null,
        accept: attachedTo(service, attach),
      }),
  });
  it("a process under P1 cannot attest P2's session", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-att-"));
    presence(dir, 11, ["ses_A"]);
    presence(dir, 21, ["ses_B"]);
    const attach = world({
      exe: { 9001: OC, 9002: OC, 11: OC, 21: OC },
      listen: { 9001: [4001], 9002: [4002] },
      conn: { 11: [4001], 21: [4002] },
    });
    const h = (ref: string, pid: number) =>
      hello({
        kind: "opencode",
        agent_ref: ref,
        pid,
        attest: { session_id: ref },
      });
    expect(attest(h("ses_B", 9001), deps(dir, attach)).ok).toBe(false);
    expect(attest(h("ses_B", 9002), deps(dir, attach))).toEqual({
      ok: true,
      pid: 9002,
    });
    expect(attest(h("ses_A", 9001), deps(dir, attach))).toEqual({
      ok: true,
      pid: 9001,
    });
  });
});

describe("lock-out (#1950)", () => {
  it("P1 claims B first; P2's real hello for B still succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-lock-"));
    mkdirSync(dir, { recursive: true });
    for (const [pid, ids] of [
      [11, ["ses_A"]],
      [21, ["ses_B"]],
    ] as const)
      writeFileSync(
        join(dir, `${pid}.json`),
        JSON.stringify({ pid, sessionIDs: ids }),
      );
    const attach = world({
      exe: { 9001: OC, 9002: OC, 11: OC, 21: OC },
      listen: { 9001: [4001], 9002: [4002] },
      conn: { 11: [4001], 21: [4002] },
    });
    const h = await daemonHarness({
      attest: undefined,
      opencode: {
        presenceDir: dir,
        ancestors: (pid) => [pid],
        comm: (pid) => (pid === 9001 || pid === 9002 ? OC : null),
        isRunning: () => true,
        procStart: () => null,
        attach,
      },
    });
    const as = (ref: string, pid: number) =>
      h.adapter(ref, { kind: "opencode", pid, attest: { session_id: ref } });
    await expect(as("ses_B", 9001)).rejects.toThrow(
      /not open in a TUI attached/,
    );
    const b = await as("ses_B", 9002);
    expect(b.welcome.bus_name).toBeTruthy();
    expect((await as("ses_A", 9001)).welcome.bus_name).toBeTruthy();
  });
});

describe.skipIf(process.platform !== "linux")("real /proc (#1950)", () => {
  it("sees a listening process and the child connected to it", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("net").connect(${port},"127.0.0.1");setTimeout(()=>{},20000)`,
      ],
      { stdio: "ignore" },
    );
    try {
      const pid = child.pid as number;
      await new Promise((r) => server.once("connection", r));
      const d = defaultAttachDeps;
      expect(d.listenPorts(process.pid)?.has(port)).toBe(true);
      expect(d.connectedPorts(pid)?.has(port)).toBe(true);
      expect(d.exeOf(pid)).toBe(d.exeOf(process.pid));
      expect(d.ppidOf(pid)).toBe(process.pid);
      const a = attachedTo(process.pid, d);
      expect(a(pid)).toBe(true);
      expect(attachedTo(1, d)(pid)).toBe(false);
    } finally {
      child.kill();
      server.close();
    }
  });
});
