// agy S2b: an agy process is on the bus from launch. agy runs no hook or MCP
// server before its first message, so the daemon lists each running agy it
// finds in the process table as "starting"; the conversation that joins at
// the first message takes over that address. Ticks are driven by syncNow on
// a fake process table: no real agy, ps or lsof runs.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type AgyConversation, agyHello } from "@oa/bus-adapter-claude-code";
import { connectDaemon } from "@oa/bus-ipc";
import { AGY_STARTING_LABEL, BUS_CAPS, PING, PONG } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agyStartingRef,
  parseAgyPids,
  parseLsofCwd,
} from "../src/agy-procs.ts";
import { attest } from "../src/attest.ts";
import type { DaemonDeps } from "../src/index.ts";
import { daemonHarness, stopAll, wsServer } from "./helpers.ts";

afterEach(stopAll);

const A = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const AGY = 4242;
const S0 = agyStartingRef(AGY, "t0");

/** The OS as the daemon sees it: which pids run, what, since when, where. */
const os = {
  alive: new Set<number>(),
  comm: new Map<number, string>(),
  start: new Map<number, string>(),
  cwd: new Map<number, string>(),
  home: new Map<number, string>(),
  /** ps cannot be read right now. */
  psDown: false,
};
const agyRuns = (pid: number, start: string, cwd: string) => {
  os.alive.add(pid);
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
    discover?: boolean;
    agentsFile?: string;
  } = {},
  fresh = true,
) {
  if (fresh) {
    os.alive = new Set();
    os.comm = new Map();
    os.start = new Map();
    os.cwd = new Map();
    os.home = new Map();
    os.psDown = false;
    agyRuns(AGY, "t0", "/w/app");
  }
  const { discover = true, agentsFile, ...rest } = over;
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
      discover,
      pids: () =>
        os.psDown
          ? null
          : [...os.alive].filter(
              (p) => basename(os.comm.get(p) ?? "") === "agy",
            ),
      cwdOf: (pid) => os.cwd.get(pid) ?? null,
      homeOf: (pid) => os.home.get(pid),
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
    caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
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

  it("lists only agy: another binary is not an agent", async () => {
    const { h } = await setup();
    os.alive.add(5000);
    os.comm.set(5000, "/bin/zsh");
    os.start.set(5000, "t5");
    os.cwd.set(5000, "/w/other");
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

  it("a second bus home lists nothing, and an agy started for another home is skipped", async () => {
    const two = await setup({ discover: false });
    two.h.daemon.syncNow();
    await settled(two.h);
    expect(two.h.of("agent_up")).toEqual([]);
    expect(two.h.daemon.agents.all()).toEqual([]);
    await stopAll();

    const { h } = await setup();
    await upFor(h, S0);
    agyRuns(6000, "t6", "/w/two");
    os.home.set(6000, "/somewhere/else/.oa-bus");
    agyRuns(6001, "t61", "/w/three");
    h.daemon.syncNow();
    await upFor(h, agyStartingRef(6001, "t61"));
    expect(h.daemon.agents.byRef(agyStartingRef(6000, "t6"))).toBeUndefined();
  });

  it("the conversation that joins at the first message takes over the address: one session, not two", async () => {
    const { h, hook } = await setup();
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

  it("holds a message to a starting session (receipt pending), and holds it again for the joined conversation until S3 delivers", async () => {
    const { h, hook } = await setup();
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
    await upFor(h, S0);
    os.alive.delete(AGY);
    h.daemon.syncNow();
    await closedRef(h, S0);
    expect(h.daemon.agents.byRef(S0)?.live).toBe(false);
  });

  it("a reused pid is a new process: the old record closes, the new one is listed under a new ref", async () => {
    const { h } = await setup();
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
    await upFor(h, S0);
    os.psDown = true;
    agyRuns(6000, "t6", "/w/two");
    h.daemon.syncNow();
    await settled(h);
    expect(h.daemon.agents.byRef(S0)?.live).toBe(true);
    expect(h.daemon.agents.byRef(agyStartingRef(6000, "t6"))).toBeUndefined();
    os.psDown = false;
    h.daemon.syncNow();
    await upFor(h, agyStartingRef(6000, "t6"));
  });

  it("a cwd that cannot be read yet is tried again on a later tick", async () => {
    const { h } = await setup();
    await upFor(h, S0);
    os.alive.add(6000);
    os.comm.set(6000, "agy");
    os.start.set(6000, "t6");
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
    expect(await upFor(two.h, S0)).toMatchObject({ kind: "antigravity" });
  });
});

describe("the process reads (agy S2b)", () => {
  it("finds agy by binary name in ps output", () => {
    expect(
      parseAgyPids(
        [
          "  1 /sbin/launchd",
          " 459 /Users/u/.local/bin/agy",
          " 460 agy",
          " 461 /usr/bin/agy-helper",
          " 462 /bin/zsh",
          "bad line",
        ].join("\n"),
      ),
    ).toEqual([459, 460]);
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
