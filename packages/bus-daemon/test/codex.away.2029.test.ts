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
import {
  CODEX_WAKE_TEXT,
  execCodex,
  hostWakes,
} from "../src/transports/codex.ts";
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
const A3 = 202;
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
        if (pid === A3)
          return [[A3, { ppid: P2, start: START2, comm: "node" }]];
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
    wakeCheckMs: 0,
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
function answerLists(
  h: H,
  waiting: () => number | undefined,
  extra: object[] = [],
) {
  const done = new Set<string>();
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: ["ids", "mailbox", "waiting"],
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
            machine_label: "laptop",
            ...(w === undefined ? {} : { waiting: w }),
          },
          ...extra,
        ],
      });
    }
  }, 5);
  return () => clearInterval(t);
}

/** Daemon 1 admits both threads, then stops; the app restarts: P2 holds THREAD, P holds ASKER. */
async function restarted(
  w: ReturnType<typeof world>,
  extra = {},
  deps: Record<string, unknown> = {},
) {
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
    ...deps,
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

  it("logs wake_unanswered when the thread never calls self; the mail stays held, nothing is delivered", async () => {
    const w = world();
    const { two, logs } = await restarted(w, { wakeAnswerMs: 0 });
    const stop = answerLists(two, () => 2);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    await vi.waitFor(() =>
      expect(logs.some((l) => /wake_unanswered/.test(l))).toBe(true),
    );
    // The sender still sees held: no ack, and the thread is not admitted.
    expect(two.of("ack")).toHaveLength(0);
    expect(two.daemon.agents.byRef(THREAD)).toBeUndefined();
    expect(logs.filter((l) => /wake_unanswered/.test(l))).toHaveLength(1);
    stop();
  });

  it("wakes again only for newer mail, an hour on, at most 3 times per app-server start", async () => {
    const w = world();
    // Same mail count: never again.
    const a = await restarted(w, { wakeAgainMs: 0 });
    const stopA = answerLists(a.two, () => 2);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(w.runs()).toHaveLength(1);
    stopA();
    await stopAll();

    const w2 = world();
    let waiting = 1;
    const b = await restarted(w2, { wakeAgainMs: 0 });
    const stopB = answerLists(b.two, () => waiting++);
    await vi.waitFor(() => expect(w2.runs()).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 300));
    expect(w2.runs()).toHaveLength(3);
    stopB();
    await stopAll();

    // Too soon (the default hour): newer mail does not wake it.
    const w3 = world();
    let n3 = 1;
    const c = await restarted(w3);
    const stopC = answerLists(c.two, () => n3++);
    await vi.waitFor(() => expect(w3.runs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(w3.runs()).toHaveLength(1);
    stopC();
  });

  it("the wake text names the tool by its literal name", () => {
    expect(CODEX_WAKE_TEXT).toBe(
      "Open Artifacts bus: messages are waiting for this thread. Call the tool mcp__oa_bus__self once, by that literal name (do not look it up from a tool list), to receive them.",
    );
  });

  it("a refused dynamic lookup does not stop the thread's own retry by literal name", async () => {
    const w = world();
    const { two } = await restarted(w);
    const stop = answerLists(two, () => 2);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    const EXEC = "exec-0b5c2a8e-3f1d-4c6a-9e2b-7d4f1a3c5e6b";
    const file = join(
      w.home,
      "sessions",
      "2026",
      "10",
      "29",
      `rollout-2026-10-29T02-11-43-${THREAD}.jsonl`,
    );
    // The woken turn looks the tool up dynamically in a code-mode exec.
    writeFileSync(
      file,
      rollout(THREAD, "call_1") +
        line("event_msg", { type: "task_started", turn_id: "turn-1" }) +
        line("response_item", {
          type: "custom_tool_call",
          id: "ctc_lookup",
          status: "completed",
          call_id: EXEC,
          name: "exec",
          input: "await tools[name]({});",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        }),
    );
    await expect(
      two.adapter(
        THREAD,
        codexHello(THREAD, A3, {
          codex: {
            thread_id: THREAD,
            call_id: EXEC,
            item_id: "ctc_lookup",
            turn_id: "turn-1",
            ppid: P2,
            thread_source: "user",
          },
        }),
      ),
    ).rejects.toThrow(/exact name/);
    expect(two.daemon.agents.byRef(THREAD)).toBeUndefined();
    // Then it calls mcp__oa_bus__self by name: admitted by today's rules.
    writeFileSync(
      file,
      rollout(THREAD, "call_1") +
        line("response_item", {
          type: "function_call",
          id: "fc2",
          name: "self",
          namespace: "mcp__oa_bus",
          arguments: "{}",
          call_id: "call_2",
        }),
    );
    await two.adapter(
      THREAD,
      codexHello(THREAD, A3, {
        codex: {
          thread_id: THREAD,
          call_id: "call_2",
          ppid: P2,
          thread_source: "user",
        },
      }),
    );
    expect(two.daemon.agents.byRef(THREAD)).toMatchObject({
      live: true,
      pid: P2,
    });
    // One wake was spent; nothing else was.
    const spent = readFileSync(w.files.wokenFile, "utf8");
    expect(spent).toContain("#1");
    expect(spent).not.toContain("#2");
    stop();
  });

  it("a refused `codex queue` ends the wakes for this start, whatever the mail count does after an hour", async () => {
    const w = world();
    writeFileSync(w.exit, "1");
    let t = Date.now();
    let count = 2;
    const { two } = await restarted(
      w,
      { wakeAgainMs: 3_600_000 },
      {
        bindingNow: () => t,
      },
    );
    const stop = answerLists(two, () => count);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    // All three wake slots are spent by the refusal.
    await vi.waitFor(() => {
      const spent = readFileSync(w.files.wokenFile, "utf8");
      for (const n of [1, 2, 3]) expect(spent).toContain(`#${n}`);
    });
    // Two hours on, new mail: a sync runs (the asker's hour row is rewritten) and nothing wakes.
    const before = readFileSync(w.files.awayFile, "utf8");
    t += 2 * 3_600_000;
    count = 7;
    await vi.waitFor(() =>
      expect(readFileSync(w.files.awayFile, "utf8")).not.toBe(before),
    );
    expect(w.runs()).toHaveLength(1);
    expect(two.of("list")).toHaveLength(1);
    stop();
  });

  it("a managed app-server daemon (ppid 1, outlives the TUI) holds the lock: it is woken, and its own call is attested", async () => {
    const w = world();
    // codex app-server --listen unix:// --managed-daemon is P2.
    const argsOf = (pid: number) =>
      pid === P2
        ? ["app-server", "--listen", "unix://", "--managed-daemon"]
        : ["exec", "x"];
    const wakesLog: number[] = [];
    const { two } = await restarted(w, {
      wakes: async (pid: number) => {
        wakesLog.push(pid);
        return hostWakes(argsOf(pid));
      },
    });
    const stop = answerLists(two, () => 2);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    expect(wakesLog).toContain(P2);
    // The daemon is the lock holder and the adapter's parent.
    await two.adapter(
      THREAD,
      codexHello(THREAD, A3, {
        codex: {
          thread_id: THREAD,
          call_id: "call_1",
          ppid: P2,
          thread_source: "user",
        },
      }),
    );
    expect(two.daemon.agents.byRef(THREAD)).toMatchObject({
      live: true,
      pid: P2,
    });
    stop();
  });

  it("re-wakes when the count changes either way, or sits at the cap; not when unchanged", async () => {
    const w = world();
    const seq = [5, 5, 3, 3, 3];
    let i = 0;
    const { two } = await restarted(w, { wakeAgainMs: 0 });
    const stop = answerLists(two, () => seq[Math.min(i++, seq.length - 1)]);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 300));
    expect(w.runs()).toHaveLength(2);
    stop();
    await stopAll();
    const w2 = world();
    const c = await restarted(w2, { wakeAgainMs: 0 });
    const stop2 = answerLists(c.two, () => 100);
    await vi.waitFor(() => expect(w2.runs()).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 300));
    expect(w2.runs()).toHaveLength(3);
    stop2();
  });

  it("ignores an away row of another machine, and does not ask a hub that cannot count", async () => {
    const w = world();
    const { two } = await restarted(w);
    // Our row has no mail; another machine's row of the same name has some.
    const stop = answerLists(two, () => undefined, [
      {
        bus_name: "my-codex",
        kind: "codex",
        namespace: "ns",
        global: false,
        state: "away",
        machine_label: "elsewhere",
        waiting: 9,
      },
    ]);
    await new Promise((r) => setTimeout(r, 400));
    expect(w.runs()).toHaveLength(0);
    stop();
  });

  it("spends the wake before codex queue runs, so a timeout or crash cannot wake twice", async () => {
    const w = world();
    const seen: boolean[] = [];
    const run = async () => {
      seen.push(readFileSync(w.files.wokenFile, "utf8").includes("#1"));
      return { code: null, stderr: "" };
    };
    const { two } = await restarted(w, { run });
    const stop = answerLists(two, () => 2);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual([true]);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(1);
    stop();
    await stopAll();
    // And a restarted daemon on the same app-server does not try again.
    const three = await daemonHarness({
      attest: undefined,
      codex: { ...w.codex, run },
      claude: { syncMs: 20 },
    });
    const stop3 = answerLists(three, () => 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(1);
    stop3();
  });

  it("rows come only from this daemon's own proofs: an unproved thread under CODEX_HOME is never woken", async () => {
    const w = world();
    const OTHER = "01a18536-7f07-7680-b17c-199e3dadf888";
    writeFileSync(join(w.home, "thread-writer-locks", `${OTHER}.lock`), "");
    writeFileSync(
      join(
        w.home,
        "sessions",
        "2026",
        "10",
        "29",
        `rollout-2026-10-29T02-11-43-${OTHER}.jsonl`,
      ),
      rollout(OTHER, "call_1"),
    );
    w.state.locks.set(OTHER, [P2]);
    const { two } = await restarted(w);
    const stop = answerLists(two, () => 2);
    await vi.waitFor(() => expect(w.runs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(w.runs().map((r) => JSON.parse(r)[1])).toEqual([
      `--thread=${THREAD}`,
    ]);
    expect(
      readCodexAway(w.files.awayFile, Date.now()).map((r) => r.ref),
    ).not.toContain(OTHER);
    stop();
  });

  it("skips a mapped thread that is now a subagent", async () => {
    const w = world();
    const { two } = await (async () => {
      const one = await daemonHarness({ attest: undefined, codex: w.codex });
      await one.adapter(THREAD, codexHello(THREAD, A1));
      await one.adapter(ASKER, codexHello(ASKER, A2));
      await stopAll();
      writeFileSync(
        join(
          w.home,
          "sessions",
          "2026",
          "10",
          "29",
          `rollout-2026-10-29T02-11-43-${THREAD}.jsonl`,
        ),
        rollout(THREAD, "call_1").replace(
          '"source":"exec"',
          '"source":"subagent"',
        ),
      );
      w.state.alive.add(P2);
      w.state.locks.set(THREAD, [P2]);
      return {
        two: await daemonHarness({
          attest: undefined,
          codex: { ...w.codex },
          claude: { syncMs: 20 },
        }),
      };
    })();
    const stop = answerLists(two, () => 2);
    await new Promise((r) => setTimeout(r, 400));
    expect(w.runs()).toHaveLength(0);
    expect(two.of("list")).toHaveLength(0);
    stop();
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
