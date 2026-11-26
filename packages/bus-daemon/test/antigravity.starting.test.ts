// agy S2b: an agy process is on the bus from launch. agy runs no hook or MCP
// server before its first message, so the daemon lists each running agy it
// finds in the process table as "starting"; the conversation that joins at
// the first message takes over that address. Ticks are driven by syncNow on
// a fake process table: no real agy, ps or lsof runs.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type AgyConversation,
  agyHello,
  busHome,
} from "@oa/bus-adapter-claude-code";
import { connectDaemon } from "@oa/bus-ipc";
import { AGY_STARTING_LABEL, BUS_CAPS, PING, PONG } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgyPluginRoute,
  type AgyProc,
  agyPluginHome,
  agyStartingRef,
  parseAgyPids,
  parseAgyPluginHome,
  parseLsofCwd,
} from "../src/agy-procs.ts";
import { readAnnounced } from "../src/announced.ts";
import { attest } from "../src/attest.ts";
import { home as busHomeNow } from "../src/config.ts";
import type { DaemonDeps } from "../src/index.ts";
import { daemonHarness, stopAll, wsServer } from "./helpers.ts";

afterEach(async () => {
  vi.unstubAllEnvs();
  await stopAll();
});

const A = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const AGY = 4242;
const S0 = agyStartingRef(AGY, "t0");

/** The OS as the daemon sees it: which pids run, what, since when, where. */
const os = {
  alive: new Set<number>(),
  ppid: new Map<number, number>(),
  comm: new Map<number, string>(),
  start: new Map<number, string>(),
  cwd: new Map<number, string>(),
  home: new Map<number, string>(),
  /** ps cannot be read right now. */
  psDown: false,
  /** Where the agy plugin's hook sends sessions; undefined: this daemon's home, pinned (as install writes it). */
  plugin: undefined as AgyPluginRoute | null | undefined,
  /** With plugin undefined: this daemon's home in a legacy unpinned hook. */
  unpinned: false,
  /** A process's environment can't be read (macOS): procBusHome's null. */
  envUnreadable: false,
};
const agyRuns = (pid: number, start: string, cwd: string, ppid = 1) => {
  os.alive.add(pid);
  os.ppid.set(pid, ppid);
  os.comm.set(pid, "/Users/u/.local/bin/agy");
  os.start.set(pid, start);
  os.cwd.set(pid, cwd);
};

const byFolder = (cwd: string) =>
  cwd.startsWith("/u/")
    ? { unmapped: true as const }
    : cwd.startsWith("/b/")
      ? { instance: "b" }
      : { instance: "main" as const };

async function setup(
  over: Partial<DaemonDeps> & {
    /** "flag": the daemon's own default, from OA_BUS_EXPERIMENTAL_AGY. */
    discover?: boolean | "flag";
    agentsFile?: string;
    pids?: () => Promise<AgyProc[] | null>;
    /** This daemon's bus home, and where it reads the plugin's route. */
    home?: string;
    pluginHome?: () => AgyPluginRoute | null;
    /** Caps the fake hub lists in hello_ok. */
    caps?: string[];
  } = {},
  fresh = true,
) {
  if (fresh) {
    os.alive = new Set();
    os.ppid = new Map();
    os.comm = new Map();
    os.start = new Map();
    os.cwd = new Map();
    os.home = new Map();
    os.psDown = false;
    os.plugin = undefined;
    os.unpinned = false;
    os.envUnreadable = false;
    agyRuns(AGY, "t0", "/w/app");
  }
  const {
    discover = true,
    agentsFile,
    pids,
    home,
    pluginHome,
    caps = [BUS_CAPS.ids, BUS_CAPS.mailbox],
    ...rest
  } = over;
  const h = await daemonHarness({
    ...rest,
    homeLookup: byFolder,
    attest: (hello) =>
      attest(hello, {
        comm: (pid) => os.comm.get(pid) ?? null,
        procStart: (pid) => os.start.get(pid) ?? null,
      }),
    antigravity: {
      isRunning: (pid) => os.alive.has(pid),
      procStart: (pid) =>
        os.alive.has(pid) ? (os.start.get(pid) ?? null) : null,
      comm: (pid) => os.comm.get(pid) ?? null,
      procStartTtlMs: 0,
      // "flag": undefined overrides the harness's off, so the default runs.
      discover: discover === "flag" ? undefined : discover,
      pluginHome:
        pluginHome ??
        (() =>
          os.plugin === undefined
            ? { home: busHomeNow(), pinned: !os.unpinned }
            : os.plugin),
      ...(home !== undefined ? { home } : {}),
      pids:
        pids ??
        (() =>
          os.psDown
            ? null
            : [...os.alive]
                .filter((p) => basename(os.comm.get(p) ?? "") === "agy")
                .map((pid) => ({ pid, ppid: os.ppid.get(pid) ?? 1 }))),
      cwdOf: (pid) => os.cwd.get(pid) ?? null,
      homeOf: (pid) => (os.envUnreadable ? null : os.home.get(pid)),
      ...(agentsFile ? { agentsFile } : {}),
    },
    // No interval tick in a test's time: each tick is syncNow.
    claude: { syncMs: 3_600_000 },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps,
  });
  const hook = async (c: Partial<AgyConversation> = {}) => {
    const hello = agyHello({
      pid: AGY,
      procStart: "t0",
      conversationId: A,
      cwd: "/w/app",
      ...c,
    });
    if (!hello) throw new Error("no hello");
    const client = await connectDaemon({ path: h.socketPath, hello });
    client.close();
    return client.welcome;
  };
  return { h, hook };
}

type H = Awaited<ReturnType<typeof setup>>["h"];
const ups = (h: H, ref: string) =>
  h.of("agent_up").filter((u) => u.agent_ref === ref);
const upFor = async (h: H, ref: string) => {
  await vi.waitFor(() => expect(ups(h, ref).length).toBeGreaterThan(0));
  return ups(h, ref).at(-1);
};
const closedRef = (h: H, ref: string) =>
  vi.waitFor(() =>
    expect(h.of("sessions").some((f) => f.closed.includes(ref))).toBe(true),
  );
const deliver = (to_ref: string, msg_id: string) => ({
  id: `d-${msg_id}`,
  type: "deliver",
  msg_id,
  to_ref,
  from_name: "alice",
  namespace: "ns",
  body: "hi agy",
});
/** What the daemon answered for `msg_id`: an ack or a refuse, if any. */
const answered = (h: H, msg_id: string) =>
  [...h.of("ack"), ...h.of("refuse")].filter((f) => f.msg_id === msg_id);
/**
 * Waits until the daemon has handled every frame sent before: a deliver to a
 * ref it never met is refused at once, and frames are handled in order.
 */
let barriers = 0;
const settled = async (h: H) => {
  const n = ++barriers;
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const id = `zzzzzzzzzzzzzz${B58[Math.floor(n / 33) % 33]}${B58[n % 33]}`;
  h.toDaemon(deliver("nobody-here", id));
  await vi.waitFor(() => expect(answered(h, id).length).toBe(1));
};

describe("an agy process is listed at launch (agy S2b)", () => {
  it("is listed as a starting antigravity agent before any message, with a starting status", async () => {
    const { h } = await setup();
    h.daemon.syncNow();
    expect(await upFor(h, S0)).toMatchObject({
      kind: "antigravity",
      proposed_name: "agy",
    });
    expect(h.daemon.agents.byRef(S0)).toMatchObject({
      kind: "antigravity",
      pid: AGY,
      procStart: "t0",
      cwd: "/w/app",
      instance: "main",
      live: true,
      starting: true,
    });
    // The hub's answer is followed by the status every reader shows.
    h.toDaemon({ id: "ok1", type: "agent_ok", agent_ref: S0, bus_name: "agy" });
    await vi.waitFor(() =>
      expect(h.of("status").find((s) => s.from_ref === S0)).toMatchObject({
        state: "idle",
        label: AGY_STARTING_LABEL,
      }),
    );
    // Listed once: later ticks keep it.
    h.daemon.syncNow();
    h.daemon.syncNow();
    await settled(h);
    expect(ups(h, S0)).toHaveLength(1);
  });

  it("an agy whose parent is agy is never listed", async () => {
    const { h } = await setup();
    agyRuns(4243, "t-child", "/w/app", AGY);
    h.daemon.syncNow();
    h.daemon.syncNow();
    h.daemon.syncNow();
    await upFor(h, S0);
    await settled(h);
    expect(h.of("agent_up").map((u) => u.agent_ref)).toEqual([S0]);
    expect(
      h.daemon.agents.byRef(agyStartingRef(4243, "t-child")),
    ).toBeUndefined();
  });

  it("a process seen in only one scan is not listed; seen in two consecutive scans it is listed with the usual starting ref", async () => {
    const { h } = await setup();
    // Startup ran scan 1: AGY is remembered, not listed yet.
    await settled(h);
    expect(h.of("agent_up")).toEqual([]);
    expect(h.daemon.agents.byRef(S0)).toBeUndefined();
    // Scan 2 sees AGY again with the same start time: now listed.
    h.daemon.syncNow();
    expect(await upFor(h, S0)).toMatchObject({
      agent_ref: S0,
      kind: "antigravity",
      proposed_name: "agy",
    });
  });

  it("a process that disappears after one scan never appears and takes no name", async () => {
    const { h } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    // Short-lived helper appears for one scan, then exits before the next.
    agyRuns(4299, "t-short", "/w/app");
    h.daemon.syncNow();
    await settled(h);
    expect(
      h.daemon.agents.byRef(agyStartingRef(4299, "t-short")),
    ).toBeUndefined();
    os.alive.delete(4299);
    h.daemon.syncNow();
    h.daemon.syncNow();
    await settled(h);
    expect(h.of("agent_up").map((u) => u.agent_ref)).toEqual([S0]);
    expect(
      h.daemon.agents.byRef(agyStartingRef(4299, "t-short")),
    ).toBeUndefined();
  });

  it("lists only agy: another binary is not an agent", async () => {
    const { h } = await setup();
    os.alive.add(5000);
    os.comm.set(5000, "/bin/zsh");
    os.start.set(5000, "t5");
    os.cwd.set(5000, "/w/other");
    h.daemon.syncNow();
    h.daemon.syncNow();
    await upFor(h, S0);
    await settled(h);
    expect(h.of("agent_up").map((u) => u.agent_ref)).toEqual([S0]);
  });

  it("is homed by its cwd: a mapped folder on its instance's hub, an unmapped one on no hub", async () => {
    const { wss, url } = await wsServer();
    const hubB: { type: string; agent_ref?: string }[] = [];
    wss.on("connection", (ws) =>
      ws.on("message", (d) => {
        const t = String(d);
        if (t === PING) ws.send(PONG);
        else hubB.push(JSON.parse(t));
      }),
    );
    const home = mkdtempSync(join(tmpdir(), "ob-agsb-"));
    mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "instances", "b.json"),
      JSON.stringify({
        name: "b",
        hub: url.replace(/\/hub$/, ""),
        machine_id: "",
        label: "laptop",
        machine_token: `oa_machine_${"b".repeat(28)}7f3a`,
      }),
      { mode: 0o600 },
    );
    const { h } = await setup({ instancesHome: home });
    await vi.waitFor(() => expect(h.daemon.hubs.get("b")?.open).toBe(true));
    agyRuns(6000, "t6", "/b/proj");
    agyRuns(7000, "t7", "/u/elsewhere");
    h.daemon.syncNow();
    h.daemon.syncNow();
    const onB = agyStartingRef(6000, "t6");
    const off = agyStartingRef(7000, "t7");
    await vi.waitFor(() =>
      expect(
        hubB.some((f) => f.type === "agent_up" && f.agent_ref === onB),
      ).toBe(true),
    );
    expect(h.daemon.agents.byRef(onB)).toMatchObject({ instance: "b" });
    // Unmapped: a local record on no hub.
    expect(h.daemon.agents.byRef(off)).toMatchObject({
      live: true,
      starting: true,
    });
    expect(h.daemon.agents.byRef(off)?.instance).toBeUndefined();
    await settled(h);
    expect(h.of("agent_up").map((u) => u.agent_ref)).toEqual([S0]);
    expect(hubB.some((f) => f.agent_ref === off)).toBe(false);
  });

  it("lists nothing with discovery off, and skips an agy started for another home when the hook follows its environment", async () => {
    const two = await setup({ discover: false });
    two.h.daemon.syncNow();
    two.h.daemon.syncNow();
    await settled(two.h);
    expect(two.h.of("agent_up")).toEqual([]);
    expect(two.h.daemon.agents.all()).toEqual([]);
    await stopAll();

    const { h } = await setup();
    os.unpinned = true;
    h.daemon.syncNow();
    await upFor(h, S0);
    agyRuns(6000, "t6", "/w/two");
    os.home.set(6000, "/somewhere/else/.oa-bus");
    agyRuns(6001, "t61", "/w/three");
    h.daemon.syncNow();
    h.daemon.syncNow();
    await upFor(h, agyStartingRef(6001, "t61"));
    expect(h.daemon.agents.byRef(agyStartingRef(6000, "t6"))).toBeUndefined();
  });

  it("lists nothing when the agy plugin sends sessions to another home, or there is none; a session listed before closes", async () => {
    const elsewhere = await setup();
    elsewhere.h.daemon.syncNow();
    await upFor(elsewhere.h, S0);
    // The plugin is rewritten for another home (an --alongside install).
    os.plugin = { home: "/somewhere/else/.oa-bus", pinned: true };
    elsewhere.h.daemon.syncNow();
    await settled(elsewhere.h);
    await closedRef(elsewhere.h, S0);
    expect(elsewhere.h.daemon.agents.byRef(S0)?.live).toBe(false);
    agyRuns(6100, "t61", "/w/later");
    elsewhere.h.daemon.syncNow();
    elsewhere.h.daemon.syncNow();
    await settled(elsewhere.h);
    expect(
      elsewhere.h.daemon.agents.byRef(agyStartingRef(6100, "t61")),
    ).toBeUndefined();
    // No plugin at all: likewise nothing.
    os.plugin = null;
    agyRuns(6200, "t62", "/w/none");
    elsewhere.h.daemon.syncNow();
    elsewhere.h.daemon.syncNow();
    await settled(elsewhere.h);
    expect(
      elsewhere.h.daemon.agents.byRef(agyStartingRef(6200, "t62")),
    ).toBeUndefined();
    // The plugin routes here again: listed after two consecutive scans.
    os.plugin = undefined;
    elsewhere.h.daemon.syncNow();
    elsewhere.h.daemon.syncNow();
    await upFor(elsewhere.h, agyStartingRef(6200, "t62"));
  });

  it("runs one process scan at a time: a tick while ps runs starts none", async () => {
    let calls = 0;
    let finish: (p: AgyProc[] | null) => void = () => {};
    const { h } = await setup({
      pids: () => {
        calls++;
        return new Promise((r) => {
          finish = r;
        });
      },
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    h.daemon.syncNow();
    h.daemon.syncNow();
    await settled(h);
    expect(calls).toBe(1);
    expect(h.daemon.agents.byRef(S0)).toBeUndefined();
    finish([{ pid: AGY, ppid: 1 }]);
    await settled(h);
    expect(h.daemon.agents.byRef(S0)).toBeUndefined();
    h.daemon.syncNow();
    expect(calls).toBe(2);
    finish([{ pid: AGY, ppid: 1 }]);
    await upFor(h, S0);
  });

  it("the conversation that joins at the first message takes over the address: one session, not two", async () => {
    const { h, hook } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    h.toDaemon({
      id: "ok1",
      type: "agent_ok",
      agent_ref: S0,
      bus_name: "agy-2",
    });
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef(S0)?.busName).toBe("agy-2"),
    );
    const w = await hook();
    expect(w.bus_name).toBe("agy-2");
    expect(await upFor(h, A)).toMatchObject({
      agent_ref: A,
      kind: "antigravity",
      replaces: S0,
      proposed_name: "agy-2",
    });
    await closedRef(h, S0);
    expect(h.daemon.agents.byRef(S0)?.live).toBe(false);
    expect(h.daemon.agents.byRef(A)).toMatchObject({
      live: true,
      busName: "agy-2",
    });
    expect(h.daemon.agents.byRef(A)?.starting).toBeUndefined();
    // Never listed again while the process runs.
    h.daemon.syncNow();
    await settled(h);
    expect(ups(h, S0)).toHaveLength(1);
    // The joined conversation gets no starting status.
    h.toDaemon({
      id: "ok2",
      type: "agent_ok",
      agent_ref: A,
      bus_name: "agy-2",
    });
    await settled(h);
    expect(h.of("status").filter((s) => s.from_ref === A)).toEqual([]);
  });

  it('a joined agy that says "starting" itself is not shown as the bus\'s starting', async () => {
    const { h } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    const hello = agyHello({
      pid: AGY,
      procStart: "t0",
      conversationId: A,
      cwd: "/w/app",
    });
    if (!hello) throw new Error("no hello");
    const client = await connectDaemon({ path: h.socketPath, hello });
    try {
      await upFor(h, A);
      h.toDaemon({
        id: "ok3",
        type: "agent_ok",
        agent_ref: A,
        bus_name: "agy",
      });
      await settled(h);
      await client.request({
        type: "set_status",
        state: "idle",
        label: AGY_STARTING_LABEL,
      });
      await vi.waitFor(() =>
        expect(h.of("status").find((s) => s.from_ref === A)).toMatchObject({
          state: "idle",
          label: "Starting",
        }),
      );
    } finally {
      client.close();
    }
  });

  it("holds a message to a starting session (receipt pending), and holds it again for the joined conversation until S3 delivers", async () => {
    const { h, hook } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    h.toDaemon(deliver(S0, "mmmmmmmmmmmmmmm1"));
    await settled(h);
    // Neither delivered nor refused: the hub keeps it pending.
    expect(answered(h, "mmmmmmmmmmmmmmm1")).toEqual([]);
    expect(h.daemon.agents.byRef(S0)?.live).toBe(true);
    await hook();
    expect(await upFor(h, A)).toMatchObject({ replaces: S0 });
    // The hub hands the mail to the new ref and pushes it on that agent_up.
    h.toDaemon(deliver(A, "mmmmmmmmmmmmmmm1"));
    await settled(h);
    expect(answered(h, "mmmmmmmmmmmmmmm1")).toEqual([]);
    expect(h.daemon.agents.byRef(A)?.live).toBe(true);
  });

  it("closes when the agy process ends, joined or not", async () => {
    const { h } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    os.alive.delete(AGY);
    h.daemon.syncNow();
    await closedRef(h, S0);
    expect(h.daemon.agents.byRef(S0)?.live).toBe(false);
  });

  it("a starting agy whose process ends is sent as gone, so its hub ends its mail at once", async () => {
    const { h } = await setup({
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.sessionsGone],
    });
    await settled(h);
    h.daemon.syncNow();
    await upFor(h, S0);
    os.alive.delete(AGY);
    h.daemon.syncNow();
    await closedRef(h, S0);
    const closing = h
      .of("sessions")
      .filter((f) => f.closed.includes(S0))
      .at(-1);
    expect(closing?.gone).toEqual([S0]);
  });

  it("a starting agy closed because the plugin routes elsewhere is not gone (it may reopen)", async () => {
    const { h } = await setup({
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.sessionsGone],
    });
    await settled(h);
    h.daemon.syncNow();
    await upFor(h, S0);
    os.plugin = { home: "/somewhere/else/.oa-bus", pinned: true };
    h.daemon.syncNow();
    await closedRef(h, S0);
    const closing = h
      .of("sessions")
      .filter((f) => f.closed.includes(S0))
      .at(-1);
    expect(closing?.gone).toBeUndefined();
  });

  it("a joined agy whose process ends is not gone", async () => {
    const { h, hook } = await setup({
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.sessionsGone],
    });
    await settled(h);
    h.daemon.syncNow();
    await upFor(h, S0);
    await hook();
    await upFor(h, A);
    await closedRef(h, S0);
    os.alive.delete(AGY);
    h.daemon.syncNow();
    await closedRef(h, A);
    const closing = h
      .of("sessions")
      .filter((f) => f.closed.includes(A))
      .at(-1);
    expect(closing?.gone).toBeUndefined();
  });

  it("a hub that did not list sessions_gone never sees gone", async () => {
    const { h } = await setup({
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
    });
    await settled(h);
    h.daemon.syncNow();
    await upFor(h, S0);
    os.alive.delete(AGY);
    h.daemon.syncNow();
    await closedRef(h, S0);
    const closing = h
      .of("sessions")
      .filter((f) => f.closed.includes(S0))
      .at(-1);
    expect(closing).toBeDefined();
    expect("gone" in (closing as object)).toBe(false);
  });

  it("a starting agy that exits while the hub link is down is sent as gone after reconnect hello_ok, and not again on a later reconnect (#3208)", async () => {
    const caps = [BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.sessionsGone];
    let onDisconnect: (() => void) | undefined;
    const { h } = await setup({
      caps,
      events: (e) => {
        if (e === "hub_disconnect") {
          const fn = onDisconnect;
          onDisconnect = undefined;
          if (fn) queueMicrotask(fn);
        }
      },
    });
    await settled(h);
    h.daemon.syncNow();
    await upFor(h, S0);
    h.toDaemon({ id: "ok1", type: "agent_ok", agent_ref: S0, bus_name: "agy" });
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef(S0)?.busName).toBe("agy"),
    );
    const sessionsBefore = h.of("sessions").length;
    const upsBefore = h.of("agent_up").length;

    // Exit happens strictly while the link is down (between close and reconnect).
    const exitedDown = new Promise<void>((resolve) => {
      onDisconnect = () => {
        os.alive.delete(AGY);
        h.daemon.syncNow();
        resolve();
      };
    });
    h.hubSock()?.close();
    await exitedDown;

    // Reconnect: open-time sessions frame goes before hello_ok and carries no gone.
    await h.next("hello", 2);
    const openSessions = await h.next("sessions", sessionsBefore + 1);
    expect(openSessions.closed).toContain(S0);
    expect(openSessions.gone).toBeUndefined();

    // hello_ok with sessions_gone triggers a sessions frame carrying gone.
    h.toDaemon({
      id: "w2",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps,
    });
    const goneSessions = await h.next("sessions", sessionsBefore + 2);
    expect(goneSessions.closed).toContain(S0);
    expect(goneSessions.gone).toEqual([S0]);
    await settled(h);
    // No other session event (no agent_up, no extra close) for it.
    expect(h.of("agent_up")).toHaveLength(upsBefore);
    expect(h.of("sessions")).toHaveLength(sessionsBefore + 2);

    // A later reconnect + hello_ok does not send gone for it again.
    h.hubSock()?.close();
    await h.next("hello", 3);
    const reopenSessions = await h.next("sessions", sessionsBefore + 3);
    expect(reopenSessions.closed).toContain(S0);
    expect(reopenSessions.gone).toBeUndefined();
    h.toDaemon({
      id: "w3",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps,
    });
    await settled(h);
    expect(h.of("sessions")).toHaveLength(sessionsBefore + 3);
    expect(h.of("agent_up")).toHaveLength(upsBefore);
  });

  it("a starting agy that exits while the link is down stays gone across a daemon restart, and is cleared once taken (#3208)", async () => {
    const caps = [BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.sessionsGone];
    const dir = mkdtempSync(join(tmpdir(), "ob-agsg-"));
    const agentsFile = join(dir, "antigravity-agents.json");
    const announcedFile = join(dir, "announced.json");
    let onDisconnect: (() => void) | undefined;
    const one = await setup({
      caps,
      agentsFile,
      announcedFile,
      events: (e) => {
        if (e === "hub_disconnect") {
          const fn = onDisconnect;
          onDisconnect = undefined;
          if (fn) queueMicrotask(fn);
        }
      },
    });
    await settled(one.h);
    one.h.daemon.syncNow();
    await upFor(one.h, S0);
    one.h.toDaemon({
      id: "ok1",
      type: "agent_ok",
      agent_ref: S0,
      bus_name: "agy",
    });
    await vi.waitFor(() =>
      expect(one.h.daemon.agents.byRef(S0)?.busName).toBe("agy"),
    );

    const exitedDown = new Promise<void>((resolve) => {
      onDisconnect = () => {
        os.alive.delete(AGY);
        one.h.daemon.syncNow();
        resolve();
      };
    });
    one.h.hubSock()?.close();
    await exitedDown;
    await one.h.daemon.stop();
    expect(readAnnounced(announcedFile)).toContainEqual(
      expect.objectContaining({ ref: S0, gone: true }),
    );

    // Restart with the same announcedFile; hello_ok with sessions_gone receives gone.
    const two = await setup({ caps, agentsFile, announcedFile }, false);
    await vi.waitFor(() =>
      expect(
        two.h.of("sessions").some((f) => f.gone?.includes(S0) === true),
      ).toBe(true),
    );
    await settled(two.h);
    // Once taken, announced.json no longer marks it gone.
    const after = readAnnounced(announcedFile).find((e) => e.ref === S0);
    expect(after).toBeDefined();
    expect(after?.gone).toBeUndefined();
  });

  it("a reused pid is a new process: the old record closes, the new one is listed under a new ref", async () => {
    const { h } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    os.start.set(AGY, "t1");
    h.daemon.syncNow();
    await closedRef(h, S0);
    h.daemon.syncNow();
    const s1 = agyStartingRef(AGY, "t1");
    expect(s1).not.toBe(S0);
    expect(await upFor(h, s1)).toMatchObject({ kind: "antigravity" });
    expect(h.daemon.agents.byRef(s1)).toMatchObject({
      live: true,
      procStart: "t1",
    });
  });

  it("a process table that cannot be read lists and closes nothing", async () => {
    const { h } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    os.psDown = true;
    agyRuns(6000, "t6", "/w/two");
    h.daemon.syncNow();
    await settled(h);
    expect(h.daemon.agents.byRef(S0)?.live).toBe(true);
    expect(h.daemon.agents.byRef(agyStartingRef(6000, "t6"))).toBeUndefined();
    os.psDown = false;
    h.daemon.syncNow();
    h.daemon.syncNow();
    await upFor(h, agyStartingRef(6000, "t6"));
  });

  it("a cwd that cannot be read yet is tried again on a later tick", async () => {
    const { h } = await setup();
    h.daemon.syncNow();
    await upFor(h, S0);
    os.alive.add(6000);
    os.comm.set(6000, "agy");
    os.start.set(6000, "t6");
    h.daemon.syncNow();
    h.daemon.syncNow();
    await settled(h);
    expect(h.daemon.agents.byRef(agyStartingRef(6000, "t6"))).toBeUndefined();
    os.cwd.set(6000, "/w/late");
    h.daemon.syncNow();
    expect(await upFor(h, agyStartingRef(6000, "t6"))).toMatchObject({
      kind: "antigravity",
    });
  });

  it("is not saved for a restart: the next run lists it again under the same ref", async () => {
    const agentsFile = join(
      mkdtempSync(join(tmpdir(), "ob-agsr-")),
      "antigravity-agents.json",
    );
    const one = await setup({ agentsFile });
    one.h.daemon.syncNow();
    await upFor(one.h, S0);
    one.h.daemon.syncNow();
    let saved: unknown[] = [];
    try {
      saved = JSON.parse(readFileSync(agentsFile, "utf8")).agents;
    } catch {
      // Never written: nothing has joined.
    }
    expect(saved).toEqual([]);
    await stopAll();
    const two = await setup({ agentsFile }, false);
    two.h.daemon.syncNow();
    expect(await upFor(two.h, S0)).toMatchObject({ kind: "antigravity" });
  });
});

/**
 * The global plugin's hooks.json: as `agyHookCommand` writes it, pinned to
 * the home it was installed for, or (no home) the legacy unpinned hook an
 * earlier build wrote for the default home, which follows the agy process's
 * OA_BUS_HOME. bus-cli's antigravity-plugin test parses the real one.
 */
const HOOK_IF = `if [ -n "$ANTIGRAVITY_CONVERSATION_ID" ] && grep -qF "\\"conversationId\\":\\"$ANTIGRAVITY_CONVERSATION_ID\\"" "$f" 2>/dev/null; then echo '{}'; else exec '/bin/oa-bus' 'agy-hello'; fi`;
const LEGACY_HOOK = `f="\${OA_BUS_HOME:-$HOME/.oa-bus}/antigravity/$PPID.json"; ${HOOK_IF}`;
const pinnedHook = (home: string) =>
  `export OA_BUS_HOME='${home.replaceAll("'", `'\\''`)}'; f="$OA_BUS_HOME/antigravity/$PPID.json"; ${HOOK_IF}`;
/**
 * The bus home a hook command sends its join to, run in a real sh with the
 * agy process's environment: `oa-bus agy-hello` connects to
 * busHome(env), OA_BUS_HOME or ~/.oa-bus.
 */
const joinHomeOf = (command: string, env: Record<string, string>): string =>
  execFileSync(
    "/bin/sh",
    [
      "-c",
      command.replace(
        "exec '/bin/oa-bus' 'agy-hello'",
        'echo "${OA_BUS_HOME:-$HOME/.oa-bus}"',
      ),
    ],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env } },
  ).trim();
const pluginAt = (dir: string) => {
  const file = join(dir, "hooks.json");
  let command = "";
  return {
    route: () => agyPluginHome(file),
    /** The hook's command, as agy would run it. */
    command: () => command,
    write: (home?: string) => {
      const cmd = home === undefined ? LEGACY_HOOK : pinnedHook(home);
      command = cmd;
      writeFileSync(
        file,
        JSON.stringify({
          "oa-bus": {
            SessionStart: [{ type: "command", command: cmd }],
            PreInvocation: [{ type: "command", command: cmd }],
          },
        }),
      );
    },
  };
};

describe("exactly one daemon lists agy at launch: the home the plugin routes to (agy S2b)", () => {
  const DEFAULT = busHome({});
  const MOVED = "/tmp/oa-s2b-moved/.oa-bus";

  it("the default home owns it when the plugin is pinned there", async () => {
    const p = pluginAt(mkdtempSync(join(tmpdir(), "ob-agyp-")));
    p.write(DEFAULT);
    const { h } = await setup({ home: DEFAULT, pluginHome: p.route });
    h.daemon.syncNow();
    await upFor(h, S0);
  });

  it("a moved home owns it when the plugin is pinned there, whatever the agy's own environment says", async () => {
    const p = pluginAt(mkdtempSync(join(tmpdir(), "ob-agyp-")));
    p.write(MOVED);
    // The stock default: the flag turns discovery on in a moved home too.
    vi.stubEnv("OA_BUS_EXPERIMENTAL_AGY", "1");
    const { h } = await setup({
      home: MOVED,
      pluginHome: p.route,
      discover: "flag",
    });
    h.daemon.syncNow();
    await upFor(h, S0);
    // The pinned hook sends this agy here though its OA_BUS_HOME is unset
    // or names another home: it is still this home's.
    agyRuns(7000, "t7", "/w/env");
    os.home.set(7000, DEFAULT);
    h.daemon.syncNow();
    h.daemon.syncNow();
    await upFor(h, agyStartingRef(7000, "t7"));
  });

  it("no plugin installed: no home lists", async () => {
    const p = pluginAt(mkdtempSync(join(tmpdir(), "ob-agyp-")));
    const { h } = await setup({ home: DEFAULT, pluginHome: p.route });
    h.daemon.syncNow();
    h.daemon.syncNow();
    await settled(h);
    expect(h.of("agent_up")).toEqual([]);
    expect(h.daemon.agents.all()).toEqual([]);
  });

  it("a plugin of another home: this home lists nothing", async () => {
    const p = pluginAt(mkdtempSync(join(tmpdir(), "ob-agyp-")));
    p.write(MOVED);
    const { h } = await setup({ home: DEFAULT, pluginHome: p.route });
    h.daemon.syncNow();
    h.daemon.syncNow();
    await settled(h);
    expect(h.of("agent_up")).toEqual([]);
    expect(h.daemon.agents.all()).toEqual([]);
  });

  it("two daemons running at once on one plugin: only the owner lists, and ownership follows the plugin", async () => {
    const p = pluginAt(mkdtempSync(join(tmpdir(), "ob-agyp-")));
    p.write(MOVED);
    vi.stubEnv("OA_BUS_EXPERIMENTAL_AGY", "1");
    const def = await setup({
      home: DEFAULT,
      pluginHome: p.route,
      discover: "flag",
    });
    const moved = await setup(
      { home: MOVED, pluginHome: p.route, discover: "flag" },
      false,
    );
    def.h.daemon.syncNow();
    moved.h.daemon.syncNow();
    await upFor(moved.h, S0);
    await settled(def.h);
    expect(def.h.of("agent_up")).toEqual([]);
    expect(def.h.daemon.agents.all()).toEqual([]);
    // Reinstalled for the default home: the moved home closes its session
    // and the default home lists the same process under the same ref.
    p.write(DEFAULT);
    moved.h.daemon.syncNow();
    await closedRef(moved.h, S0);
    def.h.daemon.syncNow();
    def.h.daemon.syncNow();
    await upFor(def.h, S0);
    moved.h.daemon.syncNow();
    await settled(moved.h);
    expect(
      moved.h.daemon.agents.all().filter((a) => a.live && a.starting),
    ).toEqual([]);
  });
});

describe("launch and join always target the same home (agy S2b)", () => {
  const DEFAULT = busHome({});
  const ALT = "/tmp/oa-s2b-alt/.oa-bus";
  // The agy process was started with OA_BUS_HOME=ALT; its hook inherits it.
  const AGY_ENV = { HOME: homedir(), OA_BUS_HOME: ALT };

  /**
   * Both daemons on one plugin and one agy process that carries
   * OA_BUS_HOME=ALT. `mac`: its environment can't be read (procBusHome's
   * null); else it can (Linux). Returns the homes that list it at launch and
   * the home its hook sends the join to.
   */
  const run = async (plugin: string | undefined, mac: boolean) => {
    const p = pluginAt(mkdtempSync(join(tmpdir(), "ob-agyp-")));
    p.write(plugin);
    vi.stubEnv("OA_BUS_EXPERIMENTAL_AGY", "1");
    // No route until the process table is set up: no tick lists before.
    let ready = false;
    const route = () => (ready ? p.route() : null);
    const def = await setup({
      home: DEFAULT,
      pluginHome: route,
      discover: "flag",
    });
    const alt = await setup(
      { home: ALT, pluginHome: route, discover: "flag" },
      false,
    );
    os.home.set(AGY, ALT);
    os.envUnreadable = mac;
    ready = true;
    def.h.daemon.syncNow();
    alt.h.daemon.syncNow();
    def.h.daemon.syncNow();
    alt.h.daemon.syncNow();
    await settled(def.h);
    await settled(alt.h);
    const listing = [
      ...(def.h.daemon.agents.byRef(S0)?.live ? [DEFAULT] : []),
      ...(alt.h.daemon.agents.byRef(S0)?.live ? [ALT] : []),
    ];
    const joinsAt = joinHomeOf(p.command(), AGY_ENV);
    return { listing, joinsAt, joined: joinsAt === DEFAULT ? def : alt };
  };

  for (const mac of [true, false]) {
    const os_ = mac ? "macOS (env unreadable)" : "Linux (env readable)";

    it(`${os_}: a hook pinned to the default home lists and joins there, whatever the agy's OA_BUS_HOME`, async () => {
      const { listing, joinsAt, joined } = await run(DEFAULT, mac);
      expect(joinsAt).toBe(DEFAULT);
      expect(listing).toEqual([DEFAULT]);
      // The join takes the starting address over: the held mail moves with it.
      joined.h.toDaemon(deliver(S0, "mmmmmmmmmmmmmmm2"));
      await settled(joined.h);
      expect(answered(joined.h, "mmmmmmmmmmmmmmm2")).toEqual([]);
      await joined.hook();
      expect(await upFor(joined.h, A)).toMatchObject({ replaces: S0 });
    });

    it(`${os_}: a hook pinned to a moved home lists and joins there`, async () => {
      const { listing, joinsAt, joined } = await run(ALT, mac);
      expect(joinsAt).toBe(ALT);
      expect(listing).toEqual([ALT]);
      await joined.hook();
      expect(await upFor(joined.h, A)).toMatchObject({ replaces: S0 });
    });

    it(`${os_}: a legacy unpinned hook sends the join to the agy's ALT home; no home advertises a starting address it would miss`, async () => {
      const { listing, joinsAt } = await run(undefined, mac);
      expect(joinsAt).toBe(ALT);
      // ALT is not the plugin's route; DEFAULT is, but this agy's join goes
      // elsewhere (Linux reads that) or may (macOS can't tell): neither lists.
      expect(listing).toEqual([]);
    });
  }

  it("macOS, legacy unpinned hook: an agy with no OA_BUS_HOME is listed once the hook is pinned", async () => {
    const p = pluginAt(mkdtempSync(join(tmpdir(), "ob-agyp-")));
    p.write();
    let ready = false;
    const { h } = await setup({
      home: DEFAULT,
      pluginHome: () => (ready ? p.route() : null),
    });
    os.envUnreadable = true;
    ready = true;
    h.daemon.syncNow();
    h.daemon.syncNow();
    await settled(h);
    expect(h.daemon.agents.byRef(S0)).toBeUndefined();
    // The next install pins the hook: the same process is listed.
    p.write(DEFAULT);
    h.daemon.syncNow();
    await upFor(h, S0);
    expect(joinHomeOf(p.command(), { HOME: homedir() })).toBe(DEFAULT);
  });
});

describe("the process reads (agy S2b)", () => {
  it("finds agy by binary name in ps output", () => {
    expect(
      parseAgyPids(
        [
          "  1   0 /sbin/launchd",
          " 459   1 /Users/u/.local/bin/agy",
          " 460 459 agy",
          " 461   1 /usr/bin/agy-helper",
          " 462   1 /bin/zsh",
          " 463 /Users/u/.local/bin/agy",
          "bad line",
        ].join("\n"),
      ),
    ).toEqual([
      { pid: 459, ppid: 1 },
      { pid: 460, ppid: 459 },
    ]);
  });

  it("reads the bus home from the agy plugin's hook, as install writes it", () => {
    const hooks = (cmd: string) =>
      JSON.stringify({
        "oa-bus": {
          SessionStart: [{ type: "command", command: cmd }],
          PreInvocation: [{ type: "command", command: cmd }],
        },
      });
    // The shape agyHookCommand writes (bus-cli's antigravity-plugin test
    // checks the real one): no moved home is the default one.
    const tail = `f="\${OA_BUS_HOME:-$HOME/.oa-bus}/antigravity/$PPID.json"; then echo '{}'; else exec '/bin/oa-bus' 'agy-hello'; fi`;
    expect(parseAgyPluginHome(hooks(tail))).toEqual({
      home: busHome({}),
      pinned: false,
    });
    expect(
      parseAgyPluginHome(
        hooks(`export OA_BUS_HOME='/tmp/it'\\''s/.oa-bus-2'; ${tail}`),
      ),
    ).toEqual({ home: "/tmp/it's/.oa-bus-2", pinned: true });
    expect(parseAgyPluginHome(hooks(pinnedHook(busHome({}))))).toEqual({
      home: busHome({}),
      pinned: true,
    });
    // The same literal bus-cli's antigravity-plugin test pins agyHookCommand
    // to, so this copy can't drift from what install writes.
    expect(pinnedHook("/tmp/it's here/.oa-bus")).toBe(
      `export OA_BUS_HOME='/tmp/it'\\''s here/.oa-bus'; f="$OA_BUS_HOME/antigravity/$PPID.json"; if [ -n "$ANTIGRAVITY_CONVERSATION_ID" ] && grep -qF "\\"conversationId\\":\\"$ANTIGRAVITY_CONVERSATION_ID\\"" "$f" 2>/dev/null; then echo '{}'; else exec '/bin/oa-bus' 'agy-hello'; fi`,
    );
    expect(parseAgyPluginHome("{}")).toBeNull();
    expect(parseAgyPluginHome("not json")).toBeNull();
    expect(parseAgyPluginHome(hooks("echo something-else"))).toBeNull();
    expect(agyPluginHome("/nonexistent/hooks.json")).toBeNull();
  });

  it("reads the cwd from lsof -Fn", () => {
    expect(parseLsofCwd("p459\nfcwd\nn/Users/u/work\n")).toBe("/Users/u/work");
    expect(parseLsofCwd("p459\n")).toBeNull();
  });

  it("derives a stable ref per pid and start time, never a conversation id", () => {
    expect(agyStartingRef(1, "Thu Nov 26 05:53:15 2026")).toBe(
      agyStartingRef(1, "Thu Nov 26 05:53:15 2026"),
    );
    expect(agyStartingRef(1, "a")).not.toBe(agyStartingRef(1, "b"));
    expect(agyStartingRef(1, "a")).toMatch(/^agy-starting-1-[0-9a-f]{12}$/);
  });
});
