// #2029: mail held for an away Codex thread wakes it once per app-server start,
// with one fixed bus-written text, and admits nothing.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hello } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Proc } from "../src/codex-attest.ts";
import { readCodexAway, writeCodexAway } from "../src/codex-away.ts";
import { CODEX_WAKE_TEXT, execCodex } from "../src/transports/codex.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

afterEach(stopAll);

const THREAD = "01a18536-7f07-7680-b17c-199e3dadf886";
const ASKER = "01a18536-7f07-7680-b17c-199e3dadf887";
const START = "Thu Oct 29 01:11:42 2026";
const START2 = "Fri Oct 30 09:00:00 2026";
const P = 100;
const P2 = 101;
const A1 = 200;
const A2 = 201;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const line = (type: string, payload: object) =>
  `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
const rollout = (id: string, call: string) =>
  line("session_meta", {
    id,
    session_id: id,
    cwd: "/work/project",
    originator: "codex_exec",
    cli_version: "0.165.0",
    source: "exec",
    thread_source: "user",
  }) +
  line("response_item", {
    type: "function_call",
    id: "fc",
    name: "send_message",
    namespace: "mcp__oa_bus",
    arguments: "{}",
    call_id: call,
  });

function world() {
  const home = tmp("ob-w2029-");
  mkdirSync(join(home, "thread-writer-locks"));
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  for (const id of [THREAD, ASKER]) {
    writeFileSync(join(home, "thread-writer-locks", `${id}.lock`), "");
    writeFileSync(
      join(day, `rollout-2026-10-29T02-11-43-${id}.jsonl`),
      rollout(id, "call_1"),
    );
  }
  const state = {
    /** Which pids hold each thread's lock. */
    locks: new Map<string, number[]>([
      [THREAD, [P]],
      [ASKER, [P]],
    ]),
    alive: new Set<number>([P]),
    comm2: "/opt/codex/bin/codex",
  };
  const procs = (pids: number[]) =>
    new Map(
      pids.flatMap((pid): [number, Proc][] => {
        if (pid === P && state.alive.has(P))
          return [[P, { ppid: 1, start: START, comm: "/opt/codex/bin/codex" }]];
        if (pid === P2 && state.alive.has(P2))
          return [[P2, { ppid: 1, start: START2, comm: state.comm2 }]];
        if (pid === A1) return [[A1, { ppid: P, start: START, comm: "node" }]];
        if (pid === A2) return [[A2, { ppid: P, start: START, comm: "node" }]];
        return [];
      }),
    );
  const fileOf = (f: string) => f.split("/").pop()?.replace(".lock", "") ?? "";
  const dir = tmp("ob-w2029h-");
  const files = {
    agentsFile: join(dir, "codex-agents.json"),
    awayFile: join(dir, "codex-away.json"),
    wokenFile: join(dir, "codex-woken.json"),
  };
  const out = join(dir, "runs.jsonl");
  const bin = join(dir, "codex");
  const exit = join(dir, "exit");
  writeFileSync(exit, "0");
  writeFileSync(
    bin,
    `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)) + "\\n");process.exit(Number(fs.readFileSync(${JSON.stringify(exit)},"utf8")));\n`,
  );
  chmodSync(bin, 0o755);
  const runs = () => {
    try {
      return readFileSync(out, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const codex = {
    home,
    ...files,
    procs,
    holding: (pairs: { pid: number; file: string }[]) =>
      pairs.map(
        (p) => state.locks.get(fileOf(p.file))?.includes(p.pid) ?? false,
      ),
    holdersOf: (fs: string[]) =>
      new Map(fs.map((f) => [f, state.locks.get(fileOf(f)) ?? []])),
    retryMs: 0,
    relockEvery: 1,
    wakeAskMs: 0,
    resolveBin: () => ({ path: bin, from: "path" as const }),
    run: execCodex(5_000),
    wakes: async () => true,
  };
  return { home, state, files, codex, runs, exit };
}

const codexHello = (
  id: string,
  pid: number,
  over: Partial<Hello> = {},
): Hello =>
  hello({
    kind: "codex",
    agent_ref: id,
    pid,
    cwd: "/adapter/guess",
    proposed_name: id === THREAD ? "my-codex" : "asker",
    codex: { thread_id: id, call_id: "call_1", ppid: P, thread_source: "user" },
    ...over,
  });

type H = Awaited<ReturnType<typeof daemonHarness>>;
/** Answers each `list` with a roster naming `my-codex` away, `waiting` mails (or none). */
function answerLists(h: H, waiting: () => number | undefined) {
  const done = new Set<string>();
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
  });
  const t = setInterval(() => {
    for (const f of h.of("list")) {
      if (done.has(f.id)) continue;
      done.add(f.id);
      const w = waiting();
      h.toDaemon({
        id: f.id,
        type: "roster",
        agents: [
          {
            bus_name: "my-codex",
            kind: "codex",
            namespace: "ns",
            global: false,
            state: "away",
            since: new Date().toISOString(),
            ...(w === undefined ? {} : { waiting: w }),
          },
        ],
      });
    }
  }, 5);
  return () => clearInterval(t);
}

/** Daemon 1 admits both threads, then stops; the app restarts: P2 holds THREAD, P holds ASKER. */
async function restarted(w: ReturnType<typeof world>, extra = {}) {
  const one = await daemonHarness({ attest: undefined, codex: w.codex });
  await one.adapter(THREAD, codexHello(THREAD, A1));
  await one.adapter(ASKER, codexHello(ASKER, A2));
  await stopAll();
  w.state.alive.add(P2);
  w.state.locks.set(THREAD, [P2]);
  const logs: string[] = [];
  const two = await daemonHarness({
    attest: undefined,
    codex: { ...w.codex, ...extra },
    claude: { syncMs: 20 },
    log: (m: string) => logs.push(m),
  });
  return { two, logs };
}

describe("waking an away Codex thread (#2029)", () => {
  it("keeps the proved threads in a 0600 map", async () => {
    const w = world();
    const one = await daemonHarness({ attest: undefined, codex: w.codex });
    await one.adapter(THREAD, codexHello(THREAD, A1));
    await vi.waitFor(() =>
      expect(readCodexAway(w.files.awayFile, Date.now())).toMatchObject([
        { ref: THREAD, name: "my-codex", namespace: "ns" },
      ]),
    );
    expect(statSync(w.files.awayFile).mode & 0o777).toBe(0o600);
  });

  it("queues one fixed text when mail waits, once per app-server start, even after a daemon restart", async () => {
    const w = world();
    const { two, logs } = await restarted(w);
    const stop = answerLists(two, () => 3);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    expect(JSON.parse(w.runs()[0] as string)).toEqual([
      "queue",
      `--thread=${THREAD}`,
      `--message=${CODEX_WAKE_TEXT}`,
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(w.runs()).toHaveLength(1);
    expect(logs.filter((l) => /codex wake .* sent/.test(l))).toHaveLength(1);
    stop();
    await stopAll();
    // A third daemon, same app-server: still no second wake.
    const { two: three } = await (async () => {
      const t = await daemonHarness({
        attest: undefined,
        codex: { ...w.codex },
        claude: { syncMs: 20 },
      });
      return { two: t };
    })();
    const stop3 = answerLists(three, () => 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(w.runs()).toHaveLength(1);
    stop3();
  });

  it("wakes again for a new app-server start", async () => {
    const w = world();
    const { two } = await restarted(w);
    const stop = answerLists(two, () => 1);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    stop();
    await stopAll();
    w.state.alive.delete(P2);
    w.state.alive.add(102);
    // A new process (new pid) holds the lock.
    const procs = w.codex.procs;
    const three = await daemonHarness({
      attest: undefined,
      codex: {
        ...w.codex,
        procs: (pids: number[]) => {
          const m = procs(pids.filter((p) => p !== 102));
          if (pids.includes(102))
            m.set(102, {
              ppid: 1,
              start: "Sat Oct 31 09:00:00 2026",
              comm: "codex",
            });
          return m;
        },
        holdersOf: (fs: string[]) => new Map(fs.map((f) => [f, [102]])),
      },
      claude: { syncMs: 20 },
    });
    const stop3 = answerLists(three, () => 1);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(2));
    stop3();
  });

  it("does nothing without waiting mail", async () => {
    const w = world();
    const { two, logs } = await restarted(w);
    const stop = answerLists(two, () => undefined);

    await vi.waitFor(() =>
      expect(logs.some((l) => /skipped: no mail waiting/.test(l))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(w.runs()).toHaveLength(0);
    stop();
  });

  it("never tries again after a refusal", async () => {
    const w = world();
    writeFileSync(w.exit, "1");
    const { two, logs } = await restarted(w);
    const stop = answerLists(two, () => 2);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(w.runs()).toHaveLength(1);
    expect(logs.some((l) => /codex wake .* failed/.test(l))).toBe(true);
    stop();
  });

  it("skips a holder that is not codex, and a host that does not wake", async () => {
    const w = world();
    w.state.comm2 = "/usr/bin/node";
    const { two } = await restarted(w);
    const stop = answerLists(two, () => 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(w.runs()).toHaveLength(0);
    expect(two.of("list")).toHaveLength(0);
    stop();
    await stopAll();
    const w2 = world();
    const { two: t2, logs } = await restarted(w2, { wakes: async () => false });
    const stop2 = answerLists(t2, () => 2);
    await vi.waitFor(() =>
      expect(logs.some((l) => /does not wake/.test(l))).toBe(true),
    );
    expect(w2.runs()).toHaveLength(0);
    stop2();
  });

  it("skips a row idle past 24 h", async () => {
    const w = world();
    const { two } = await restarted(w);
    await stopAll();
    writeCodexAway(w.files.awayFile, [
      {
        ref: THREAD,
        name: "my-codex",
        namespace: "ns",
        lastLive: Date.now() - 25 * 3_600_000,
      },
    ]);
    const three = await daemonHarness({
      attest: undefined,
      codex: { ...w.codex },
      claude: { syncMs: 20 },
    });
    const stop = answerLists(three, () => 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(w.runs()).toHaveLength(0);
    stop();
    void two;
  });

  it("caps the map at 64 rows", () => {
    const f = join(tmp("ob-w2029c-"), "away.json");
    const rows = Array.from({ length: 80 }, (_, i) => ({
      ref: `01a18536-7f07-7680-b17c-${String(i).padStart(12, "0")}`,
      name: `n${i}`,
      namespace: "ns",
      lastLive: Date.now() - i * 1000,
    }));
    writeCodexAway(f, rows);
    expect(readCodexAway(f, Date.now())).toHaveLength(64);
  });
});
