// #1748: a Codex thread the daemon attested survives a daemon restart. The
// daemon keeps each live thread in its home; a restart takes it back only when
// its process start is the one pinned and it still holds the thread's lock.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hello } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexAgent,
  readCodexAgents,
  writeCodexAgents,
} from "../src/codex-agents.ts";
import type { Proc } from "../src/codex-attest.ts";
import { execCodex } from "../src/transports/codex.ts";
import { daemonHarness, deliverFrame, hello, stopAll } from "./helpers.ts";

afterEach(stopAll);

const THREAD = "01a18536-7f07-7680-b17c-199e3dadf886";
const CWD = "/work/project";
const START = "Thu Oct 29 01:11:42 2026";
const P = 100;
const ADAPTER = 200;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

const line = (type: string, payload: object) =>
  `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
const meta = line("session_meta", {
  id: THREAD,
  session_id: THREAD,
  cwd: CWD,
  originator: "codex_exec",
  cli_version: "0.165.0",
  source: "exec",
  thread_source: "user",
});
const call = (call_id: string) =>
  line("response_item", {
    type: "function_call",
    id: "fc",
    name: "send_message",
    namespace: "mcp__oa_bus",
    arguments: "{}",
    call_id,
  });

/** A temp CODEX_HOME, a fake process table and lock holders, and a daemon home file. */
function world() {
  const home = tmp("ob-r1748-");
  mkdirSync(join(home, "thread-writer-locks"));
  writeFileSync(join(home, "thread-writer-locks", `${THREAD}.lock`), "");
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, `rollout-2026-10-29T02-11-43-${THREAD}.jsonl`),
    meta + call("call_1"),
  );
  const state = {
    start: START,
    alive: true,
    holder: P as number | undefined,
  };
  const procs = (pids: number[]) =>
    new Map(
      pids.flatMap((pid): [number, Proc][] =>
        pid === P && state.alive
          ? [[P, { ppid: 1, start: state.start, comm: "/opt/codex/bin/codex" }]]
          : pid === ADAPTER
            ? [[ADAPTER, { ppid: P, start: START, comm: "node" }]]
            : [],
      ),
    );
  const agentsFile = join(tmp("ob-r1748h-"), "codex-agents.json");
  const codex = {
    home,
    agentsFile,
    procs,
    holding: (pairs: { pid: number }[]) =>
      pairs.map(({ pid }) => pid === state.holder),
    retryMs: 0,
    relockEvery: 1,
    resolveBin: () => undefined,
  };
  return { home, state, agentsFile, codex };
}

const codexHello = (over: Partial<Hello> = {}): Hello =>
  hello({
    kind: "codex",
    agent_ref: THREAD,
    pid: ADAPTER,
    cwd: "/adapter/guess",
    proposed_name: "my-codex",
    codex: {
      thread_id: THREAD,
      call_id: "call_1",
      ppid: P,
      thread_source: "user",
    },
    ...over,
  });

/** A first daemon admits the thread; then it stops, as on a restart. */
async function attestedThenStopped(w: ReturnType<typeof world>) {
  const one = await daemonHarness({ attest: undefined, codex: w.codex });
  await one.adapter(THREAD, codexHello());
  expect(existsSync(w.agentsFile)).toBe(true);
  await stopAll();
}
const restarted = (w: ReturnType<typeof world>, codex = {}) =>
  daemonHarness({ attest: undefined, codex: { ...w.codex, ...codex } });

describe("a Codex session survives a daemon restart (#1748)", () => {
  it("persists the minimum, 0600, then restores the thread and announces it by name", async () => {
    const w = world();
    await attestedThenStopped(w);
    const file = JSON.parse(readFileSync(w.agentsFile, "utf8"));
    expect(file).toEqual({
      v: 1,
      agents: [
        {
          ref: THREAD,
          pid: P,
          procStart: START,
          proposedName: "my-codex",
          busName: "my-codex",
          namespace: "ns",
          global: false,
          cwd: CWD,
        },
      ],
    });
    expect((await import("node:fs")).statSync(w.agentsFile).mode & 0o777).toBe(
      0o600,
    );
    const two = await restarted(w);
    expect(two.daemon.agents.byRef(THREAD)).toMatchObject({
      kind: "codex",
      live: true,
      pid: P,
      busName: "my-codex",
      proposedName: "my-codex",
      cwd: CWD,
    });
    expect(await two.next("agent_up")).toMatchObject({
      agent_ref: THREAD,
      kind: "codex",
      proposed_name: "my-codex",
      namespace: "ns",
    });
    // Still the live record when the adapter's next call arrives: same name.
    expect(two.of("agent_up")).toHaveLength(1);
  });

  it("keeps the thread across the first sync and the next hello keeps its record", async () => {
    const w = world();
    await attestedThenStopped(w);
    const two = await daemonHarness({
      attest: undefined,
      codex: { ...w.codex },
      claude: { syncMs: 20 },
    });
    // The file still holds it after syncs ran.
    await vi.waitFor(() =>
      expect(readCodexAgents(w.agentsFile).map((a) => a.ref)).toEqual([THREAD]),
    );
    writeFileSync(
      join(
        w.home,
        "sessions",
        "2026",
        "10",
        "29",
        `rollout-2026-10-29T02-11-43-${THREAD}.jsonl`,
      ),
      meta + call("call_1") + call("call_2"),
    );
    await two.adapter(
      THREAD,
      codexHello({
        codex: {
          thread_id: THREAD,
          call_id: "call_2",
          ppid: P,
          thread_source: "user",
        },
        proposed_name: "other",
      }),
    );
    expect(two.daemon.agents.byRef(THREAD)?.busName).toBe("my-codex");
  });

  it("delivers to a restored thread through `codex queue`", async () => {
    const w = world();
    const dir = tmp("ob-r1748b-");
    const out = join(dir, "runs.jsonl");
    const bin = join(dir, "codex");
    writeFileSync(
      bin,
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    chmodSync(bin, 0o755);
    await attestedThenStopped(w);
    const two = await restarted(w, {
      resolveBin: () => ({ path: bin, from: "path" as const }),
      run: execCodex(5_000),
      wakes: async () => true,
    });
    two.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", THREAD));
    expect(await two.next("ack")).toMatchObject({ msg_id: "mmmmmmmmmmmmmmm1" });
    const runs = readFileSync(out, "utf8").trim().split("\n");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0] as string).slice(0, 2)).toEqual([
      "queue",
      `--thread=${THREAD}`,
    ]);
  });

  it.each([
    [
      "a dead process",
      (w: ReturnType<typeof world>) => (w.state.alive = false),
    ],
    [
      "a reused pid (another start time)",
      (w: ReturnType<typeof world>) =>
        (w.state.start = "Fri Oct 30 09:00:00 2026"),
    ],
    [
      "a process that lost the thread's lock",
      (w: ReturnType<typeof world>) => (w.state.holder = undefined),
    ],
    [
      "another process holding the lock",
      (w: ReturnType<typeof world>) => (w.state.holder = 999),
    ],
  ])("drops a record whose process is %s", async (_n, break_) => {
    const w = world();
    await attestedThenStopped(w);
    break_(w);
    const two = await restarted(w);
    expect(two.daemon.agents.byRef(THREAD)).toBeUndefined();
    expect(two.daemon.agents.all()).toEqual([]);
  });

  it("does not restore a session that closed before the restart", async () => {
    const w = world();
    const one = await daemonHarness({
      attest: undefined,
      codex: w.codex,
      claude: { syncMs: 20 },
    });
    await one.adapter(THREAD, codexHello());
    w.state.holder = undefined;
    await vi.waitFor(() =>
      expect(one.daemon.agents.byRef(THREAD)?.live).toBe(false),
    );
    await vi.waitFor(() => expect(readCodexAgents(w.agentsFile)).toEqual([]));
    await stopAll();
    w.state.holder = P;
    const two = await restarted(w);
    expect(two.daemon.agents.byRef(THREAD)).toBeUndefined();
  });

  it.each([
    [
      "corrupt JSON",
      (f: string) => writeFileSync(f, "{not json", { mode: 0o600 }),
    ],
    [
      "another schema",
      (f: string) =>
        writeFileSync(f, JSON.stringify({ v: 2, agents: [] }), { mode: 0o600 }),
    ],
    [
      "extra keys",
      (f: string) => {
        const j = JSON.parse(readFileSync(f, "utf8"));
        j.agents[0].extra = 1;
        writeFileSync(f, JSON.stringify(j), { mode: 0o600 });
      },
    ],
    ["writable by others", (f: string) => chmodSync(f, 0o666)],
    [
      "a symlink",
      (f: string) => {
        const real = `${f}.real`;
        writeFileSync(real, readFileSync(f), { mode: 0o600 });
        writeFileSync(`${f}.x`, "");
        return symlinkSync(real, `${f}.link`);
      },
    ],
  ])("ignores a file that is %s, and starts fine", async (name, spoil) => {
    const w = world();
    await attestedThenStopped(w);
    spoil(w.agentsFile);
    const target = name === "a symlink" ? `${w.agentsFile}.link` : w.agentsFile;
    const two = await daemonHarness({
      attest: undefined,
      codex: { ...w.codex, agentsFile: target },
    });
    expect(two.daemon.agents.all()).toEqual([]);
  });

  it("ignores a file owned by another user", async () => {
    const w = world();
    await attestedThenStopped(w);
    const mine = process.getuid?.() as number;
    expect(readCodexAgents(w.agentsFile, mine)).toHaveLength(1);
    expect(readCodexAgents(w.agentsFile, mine + 1)).toEqual([]);
  });

  it("one bad record loses only itself; duplicates keep the first", () => {
    const f = join(tmp("ob-r1748c-"), "a.json");
    const good: CodexAgent = {
      ref: "a",
      pid: 5,
      procStart: START,
      proposedName: "n",
      busName: "n",
      namespace: "ns",
      global: false,
      cwd: CWD,
    };
    writeFileSync(
      f,
      JSON.stringify({
        v: 1,
        agents: [{ ref: "bad" }, good, { ...good, busName: "dup" }],
      }),
      { mode: 0o600 },
    );
    expect(readCodexAgents(f)).toEqual([good]);
    writeCodexAgents(f, [good]);
    expect(readCodexAgents(f)).toEqual([good]);
  });
});
