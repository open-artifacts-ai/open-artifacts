import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attest } from "../src/attest.ts";
import {
  type AttachDeps,
  attachedTo,
  cachedAttach,
  defaultAttachDeps,
  lsofEstablished,
  parseProcNetTcp,
} from "../src/presence/attached.ts";
import { openState } from "../src/presence/opencode.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

afterEach(stopAll);

const OC = "/opt/bin/opencode";
/** Both ends of one connection: the service's accepted socket and the TUI's. */
const link = (svc: string, tui: string) => ({
  svc: { local: svc, remote: tui },
  tui: { local: tui, remote: svc },
});
/** A world of pids: who runs what, who is whose parent, and each pid's established sockets. */
function world(w: {
  exe?: Record<number, string>;
  ppid?: Record<number, number>;
  sockets?: Record<number, { local: string; remote: string }[]>;
}): AttachDeps {
  return {
    exeOf: (p) => w.exe?.[p] ?? null,
    ppidOf: (p) => w.ppid?.[p] ?? 1,
    established: (p) => w.sockets?.[p] ?? null,
  };
}

describe("attachedTo (#1950)", () => {
  const exe = { 10: OC, 20: OC, 11: OC, 21: OC, 66: "/usr/bin/node" };
  const one = link("127.0.0.1:4001", "127.0.0.1:50001");
  const two = link("127.0.0.1:4002", "127.0.0.1:50002");
  const sockets = {
    10: [one.svc],
    20: [two.svc],
    11: [one.tui],
    21: [two.tui],
  };
  it("accepts the TUI holding the other end of the service's connection, refuses another service's TUI", () => {
    const a = attachedTo(10, world({ exe, sockets }));
    expect(a(11)).toBe(true);
    expect(a(21)).toBe(false);
  });
  it("refuses a socket pair whose ends do not match: same port, another loopback address", () => {
    // Service A at 127.0.0.2:4096, a TUI connected to 127.0.0.1:4096.
    const svcA = link("127.0.0.2:4096", "127.0.0.2:50001");
    const tui = link("127.0.0.1:4096", "127.0.0.1:50002");
    const a = attachedTo(
      10,
      world({ exe, sockets: { 10: [svcA.svc], 11: [tui.tui] } }),
    );
    expect(a(11)).toBe(false);
    // Right address, wrong client port: another TUI's connection.
    const b = attachedTo(
      10,
      world({
        exe,
        sockets: {
          10: [one.svc],
          11: [{ local: "127.0.0.1:50009", remote: "127.0.0.1:4001" }],
        },
      }),
    );
    expect(b(11)).toBe(false);
  });
  it("refuses a forged presence pid: right sockets, wrong executable", () => {
    const a = attachedTo(
      10,
      world({ exe, sockets: { 10: [one.svc], 66: [one.tui] } }),
    );
    expect(a(66)).toBe(false);
  });
  it("accepts a standalone TUI that is the service's parent, with the exe check", () => {
    const w = world({ exe, ppid: { 10: 11 } });
    expect(attachedTo(10, w)(11)).toBe(true);
    expect(attachedTo(10, w)(66)).toBe(false);
    expect(
      attachedTo(
        10,
        world({ exe: { ...exe, 11: "/usr/bin/node" }, ppid: { 10: 11 } }),
      )(11),
    ).toBe(false);
  });
  it("treats a binary replaced in place as the same program", () => {
    const d = world({
      exe: {
        10: "/x/opencode (deleted)",
        11: "/x/opencode",
        66: "/y/opencode",
      },
      sockets: { 10: [one.svc], 11: [one.tui], 66: [one.tui] },
    });
    expect(attachedTo(10, d)(11)).toBe(true);
    expect(attachedTo(10, d)(66)).toBe(false);
    const flipped = world({
      exe: { 10: "/x/opencode", 11: "/x/opencode (deleted)" },
      sockets: { 10: [one.svc], 11: [one.tui] },
    });
    expect(attachedTo(10, flipped)(11)).toBe(true);
  });
  it("answers unknown, never attached, on every read failure", () => {
    const ok = world({ exe, sockets });
    expect(attachedTo(10, ok)(11)).toBe(true);
    expect(attachedTo(10, { ...ok, exeOf: () => null })(11)).toBeNull();
    expect(
      attachedTo(10, { ...ok, exeOf: (p) => (p === 10 ? OC : null) })(11),
    ).toBeNull();
    expect(attachedTo(10, { ...ok, established: () => null })(11)).toBeNull();
    expect(
      attachedTo(10, { ...ok, established: (p) => (p === 10 ? [] : null) })(11),
    ).toBeNull();
    expect(
      attachedTo(10, {
        ...ok,
        established: (p) => (p === 10 ? ok.established(p) : null),
      })(11),
    ).toBeNull();
    // Sockets read fine but the parent could not be told: a standalone TUI is not ruled out.
    const noMatch = world({ exe, sockets: { 10: [one.svc], 11: [] } });
    expect(attachedTo(10, { ...noMatch, ppidOf: () => null })(11)).toBeNull();
    expect(attachedTo(10, noMatch)(11)).toBe(false);
  });
  it("reads the service once per hello, not once per TUI", () => {
    let reads = 0;
    const d = world({ exe, sockets });
    const a = attachedTo(10, {
      ...d,
      established: (p) => {
        if (p === 10) reads++;
        return d.established(p);
      },
    });
    a(11);
    a(21);
    a(11);
    expect(reads).toBe(1);
  });
});

describe("cachedAttach (#1950)", () => {
  const one = link("127.0.0.1:4001", "127.0.0.1:50001");
  it("reads the OS once within the TTL, and again after it", () => {
    let reads = 0;
    const d = world({
      exe: { 10: OC, 11: OC, 12: OC },
      sockets: { 10: [one.svc], 11: [one.tui], 12: [] },
    });
    const counted: AttachDeps = {
      ...d,
      established: (p) => {
        reads++;
        return d.established(p);
      },
    };
    let t = 0;
    const attached = cachedAttach(counted, () => t, 2000);
    expect(attached(10)(11)).toBe(true);
    expect(attached(10)(12)).toBe(false);
    t = 1999;
    expect(attached(10)(11)).toBe(true);
    expect(attached(10)(12)).toBe(false);
    expect(reads).toBe(3); // the service once, TUIs 11 and 12 once each
    t = 2000;
    expect(attached(10)(11)).toBe(true);
    expect(reads).toBe(5);
  });
  it("never caches unknown: the next hello reads the OS again", () => {
    let fail = true;
    let reads = 0;
    const d = world({
      exe: { 10: OC, 11: OC },
      sockets: { 10: [one.svc], 11: [one.tui] },
    });
    const flaky: AttachDeps = {
      ...d,
      established: (p) => {
        reads++;
        return p === 11 && fail ? null : d.established(p);
      },
    };
    const t = 0;
    const attached = cachedAttach(flaky, () => t, 2000);
    expect(attached(10)(11)).toBeNull();
    const after = reads;
    fail = false;
    expect(attached(10)(11)).toBe(true); // same instant, inside the TTL
    expect(reads).toBeGreaterThan(after);
  });
  it("a cached 'not attached' expires as fast as a cached 'attached'", () => {
    const sockets: Record<number, { local: string; remote: string }[]> = {
      10: [one.svc],
      11: [],
    };
    const d = world({ exe: { 10: OC, 11: OC }, sockets });
    let t = 0;
    const attached = cachedAttach(d, () => t, 2000);
    expect(attached(10)(11)).toBe(false);
    sockets[11] = [one.tui];
    t = 1000;
    expect(attached(10)(11)).toBe(false);
    t = 2000;
    expect(attached(10)(11)).toBe(true);
  });
});

describe("parsers", () => {
  it("reads /proc/net/tcp rows as exact endpoints, folding v4-mapped v6", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:C0DE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0 100 0",
      "   1: 0200007F:D431 0100007F:C0DE 01 00000000:00000000 00:00000000 00000000  1000        0 777 1 0 100 0",
      "   2: 0000000000000000FFFF00000100007F:C0DE 0000000000000000FFFF00000200007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 778 1 0 100 0",
      "   3: 00000000000000000000000001000000:1000 00000000000000000000000001000000:2000 01 00000000:00000000 00:00000000 00000000  1000        0 779 1 0 100 0",
    ].join("\n");
    expect(parseProcNetTcp(text)).toEqual([
      {
        state: "0A",
        local: "127.0.0.1:49374",
        remote: "0.0.0.0:0",
        inode: "12345",
      },
      {
        state: "01",
        local: "127.0.0.2:54321",
        remote: "127.0.0.1:49374",
        inode: "777",
      },
      {
        state: "01",
        local: "127.0.0.1:49374",
        remote: "127.0.0.2:54321",
        inode: "778",
      },
      {
        state: "01",
        local: "[0:0:0:0:0:0:0:1]:4096",
        remote: "[0:0:0:0:0:0:0:1]:8192",
        inode: "779",
      },
    ]);
  });
  it("reads lsof -Fn established pairs", () => {
    expect(
      lsofEstablished(
        "p2\nn127.0.0.1:5000->127.0.0.1:49374\nn[::ffff:127.0.0.1]:6000->[::ffff:127.0.0.1]:49374\nn*:80\n",
      ),
    ).toEqual([
      { local: "127.0.0.1:5000", remote: "127.0.0.1:49374" },
      { local: "127.0.0.1:6000", remote: "127.0.0.1:49374" },
    ]);
  });
});

describe("open sessions for one ref (#1950)", () => {
  it("skips rows that do not list the ref before any OS check, and stops at the first pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-only-"));
    for (const [pid, ids] of [
      [11, ["ses_A"]],
      [12, ["ses_B"]],
      [13, ["ses_B"]],
    ] as const)
      writeFileSync(
        join(dir, `${pid}.json`),
        JSON.stringify({ pid, sessionIDs: ids }),
      );
    const asked: number[] = [];
    const running: number[] = [];
    const open = openState(
      dir,
      {
        isRunning: (p) => {
          running.push(p);
          return true;
        },
        procStartEpoch: () => null,
        accept: (p) => {
          asked.push(p);
          return true;
        },
      },
      "ses_B",
    );
    expect(open).toBe(true);
    expect(running).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect([12, 13]).toContain(asked[0]);
    expect(
      openState(
        dir,
        { isRunning: () => true, procStartEpoch: () => null },
        "ses_none",
      ),
    ).toBe(false);
  });
});

describe("open state with an unknown candidate (#1950)", () => {
  it("is unknown when no row passes and one could not be told, true when another passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-unk-"));
    for (const pid of [12, 13])
      writeFileSync(
        join(dir, `${pid}.json`),
        JSON.stringify({ pid, sessionIDs: ["ses_B"] }),
      );
    const deps = (verdict: Record<number, boolean | null>) => ({
      isRunning: () => true,
      procStartEpoch: () => null,
      accept: (p: number) =>
        p in verdict ? (verdict[p] as boolean | null) : false,
    });
    expect(openState(dir, deps({ 12: null, 13: false }), "ses_B")).toBeNull();
    expect(openState(dir, deps({ 12: false, 13: false }), "ses_B")).toBe(false);
    expect(openState(dir, deps({ 12: null, 13: true }), "ses_B")).toBe(true);
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
    openSessions: (service: number, ref: string) =>
      openState(
        dir,
        {
          isRunning: () => true,
          procStartEpoch: () => null,
          accept: attachedTo(service, attach),
        },
        ref,
      )
        ? new Set([ref])
        : new Set<string>(),
  });
  const one = link("127.0.0.1:4001", "127.0.0.1:50001");
  const two = link("127.0.0.1:4002", "127.0.0.1:50002");
  it("a process under P1 cannot attest P2's session", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-att-"));
    presence(dir, 11, ["ses_A"]);
    presence(dir, 21, ["ses_B"]);
    const attach = world({
      exe: { 9001: OC, 9002: OC, 11: OC, 21: OC },
      sockets: {
        9001: [one.svc],
        9002: [two.svc],
        11: [one.tui],
        21: [two.tui],
      },
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
  it("P1's refused claim for B does not block P2's real hello for B", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-lock-"));
    for (const [pid, ids] of [
      [11, ["ses_A"]],
      [21, ["ses_B"]],
    ] as const)
      writeFileSync(
        join(dir, `${pid}.json`),
        JSON.stringify({ pid, sessionIDs: ids }),
      );
    const one = link("127.0.0.1:4001", "127.0.0.1:50001");
    const two = link("127.0.0.1:4002", "127.0.0.1:50002");
    const attach = world({
      exe: { 9001: OC, 9002: OC, 11: OC, 21: OC },
      sockets: {
        9001: [one.svc],
        9002: [two.svc],
        11: [one.tui],
        21: [two.tui],
      },
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
    expect((await as("ses_B", 9002)).welcome.bus_name).toBeTruthy();
    expect((await as("ses_A", 9001)).welcome.bus_name).toBeTruthy();
  });
});

describe.skipIf(process.platform !== "linux")("real /proc (#1950)", () => {
  const children: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill();
  });
  const start = (code: string) => {
    const c = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(c);
    return c;
  };
  const ready = (c: ReturnType<typeof spawn>) =>
    new Promise<void>((r) => c.stdout?.once("data", () => r()));

  it("a child connected to the listener is attached; the same port at another loopback address is not", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const tui = start(
      `require("net").connect(${port},"127.0.0.1",()=>console.log("up"));setTimeout(()=>{},20000)`,
    );
    await ready(tui);
    // A second "service" on the same port at 127.0.0.2, with a client of its own (this process).
    const other = start(
      `require("net").createServer(()=>{}).listen(${port},"127.0.0.2",()=>console.log("up"));setTimeout(()=>{},20000)`,
    );
    await ready(other);
    const client = connect(port, "127.0.0.2");
    await new Promise((r) => client.once("connect", r));
    try {
      const d = defaultAttachDeps;
      const tuiPid = tui.pid as number;
      expect(d.exeOf(tuiPid)).toBe(d.exeOf(process.pid));
      expect(d.ppidOf(tuiPid)).toBe(process.pid);
      // The test process is the service holding the accepted end.
      expect(attachedTo(process.pid, d)(tuiPid)).toBe(true);
      // Port equality would pass here; the socket pairs do not.
      expect(d.established(other.pid as number)?.length).toBeGreaterThan(0);
      expect(attachedTo(other.pid as number, d)(tuiPid)).toBe(false);
      expect(attachedTo(1, d)(tuiPid)).not.toBe(true);
    } finally {
      client.destroy();
      server.close();
    }
  });
});
