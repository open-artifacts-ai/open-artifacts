// #1748: a Codex thread that drops its lock (Codex unloads idle threads) or
// whose ps/lsof check failed is not lost for good. A lock miss keeps the proof
// and the same pinned process holding the lock again revives the thread; a
// failed check is unknown, never "dead"; a restarted process needs a hello.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hello } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_REFUSALS,
  codexAttestor,
  type Proc,
} from "../src/codex-attest.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

afterEach(stopAll);

const THREAD = "01a18536-7f07-7680-b17c-199e3dadf886";
const START = "Thu Oct 29 01:11:42 2026";
const P = 100;
const ADAPTER = 200;

const line = (type: string, payload: object) =>
  `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
const rollout =
  line("session_meta", {
    id: THREAD,
    session_id: THREAD,
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
    call_id: "call_1",
  });

function world() {
  const home = mkdtempSync(join(tmpdir(), "ob-d1748-"));
  mkdirSync(join(home, "thread-writer-locks"));
  writeFileSync(join(home, "thread-writer-locks", `${THREAD}.lock`), "");
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, `rollout-2026-10-29T02-11-43-${THREAD}.jsonl`),
    rollout,
  );
  const state = {
    start: START,
    holder: P as number | undefined,
    psUnknown: false,
    lsofUnknown: false,
  };
  const procs = (pids: number[]) => {
    if (state.psUnknown) return undefined;
    return new Map(
      pids.flatMap((pid): [number, Proc][] =>
        pid === P
          ? [[P, { ppid: 1, start: state.start, comm: "/opt/codex/bin/codex" }]]
          : pid === ADAPTER
            ? [[ADAPTER, { ppid: P, start: START, comm: "node" }]]
            : [],
      ),
    );
  };
  const holding = (pairs: { pid: number }[]) =>
    state.lsofUnknown
      ? undefined
      : pairs.map(({ pid }) => pid === state.holder);
  return { home, state, procs, holding };
}

const codexHello = (): Hello =>
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
  });

/** An attestor that has admitted the thread, plus the world it saw. */
function admitted() {
  const w = world();
  const check = codexAttestor({
    home: w.home,
    procs: w.procs,
    holding: w.holding,
    retryMs: 0,
  });
  expect(check.attestNow(codexHello())).toMatchObject({ ok: true });
  return { w, check };
}
const T = [{ thread: THREAD, pid: P }];
const down = [{ thread: THREAD, pid: P, live: false }];

describe("a dropped Codex thread comes back (#1748)", () => {
  it("a lock miss keeps the proof; the same process holding again revives it", () => {
    const { w, check } = admitted();
    w.state.holder = undefined;
    expect(check.sweep(T, true)).toEqual(new Set());
    // Not-live without a relock tick is never revived.
    expect(check.sweep(down, false)).toEqual(new Set());
    w.state.holder = P;
    expect(check.sweep(down, true)).toEqual(new Set([THREAD]));
  });

  it("a kept proof is not a free pass: a hello must show the lock again", () => {
    const { w, check } = admitted();
    w.state.holder = undefined;
    check.sweep(T, true);
    expect(check.attestNow(codexHello())).toMatchObject({
      reason: CODEX_REFUSALS.notLoaded,
    });
    w.state.holder = P;
    // The lock is shown again; only the spent call id refuses now.
    expect(check.attestNow(codexHello())).not.toMatchObject({
      reason: CODEX_REFUSALS.notLoaded,
    });
  });

  it("another process holding the lock does not revive it", () => {
    const { w, check } = admitted();
    w.state.holder = undefined;
    check.sweep(T, true);
    w.state.holder = 999;
    expect(check.sweep(down, true)).toEqual(new Set());
  });

  it("an lsof that could not run leaves live threads live", () => {
    const { w, check } = admitted();
    w.state.lsofUnknown = true;
    expect(check.sweep(T, true)).toEqual(new Set([THREAD]));
    expect(check.sweep(down, true)).toEqual(new Set());
  });

  it("a ps that could not run forgets nothing", () => {
    const { w, check } = admitted();
    w.state.psUnknown = true;
    expect(check.sweep(T, true)).toEqual(new Set([THREAD]));
    expect(check.startOf(P)).toBe(START);
    w.state.psUnknown = false;
    expect(check.sweep(T, true)).toEqual(new Set([THREAD]));
  });

  it("a restarted process (new start) stays down and needs a hello", () => {
    const { w, check } = admitted();
    w.state.holder = undefined;
    check.sweep(T, true);
    w.state.start = "Fri Oct 30 09:00:00 2026";
    w.state.holder = P;
    expect(check.sweep(down, true)).toEqual(new Set());
    expect(check.startOf(P)).toBeUndefined();
    // The old proof is gone: the same lock is not enough.
    w.state.start = START;
    expect(check.sweep(down, true)).toEqual(new Set());
  });

  it("the daemon marks the thread not live, then live again, and announces both", async () => {
    const w = world();
    const d = await daemonHarness({
      attest: undefined,
      claude: { syncMs: 20 },
      codex: {
        home: w.home,
        agentsFile: join(w.home, "codex-agents.json"),
        procs: w.procs,
        holding: w.holding,
        retryMs: 0,
        relockEvery: 1,
        resolveBin: () => undefined,
      },
    });
    await d.adapter(THREAD, codexHello());
    expect(d.daemon.agents.byRef(THREAD)?.live).toBe(true);
    w.state.holder = undefined;
    await vi.waitFor(() =>
      expect(d.daemon.agents.byRef(THREAD)?.live).toBe(false),
    );
    const ups = d.of("agent_up").length;
    w.state.holder = P;
    await vi.waitFor(() =>
      expect(d.daemon.agents.byRef(THREAD)?.live).toBe(true),
    );
    // The hub learns of the revival from a fresh agent_up.
    expect(d.of("agent_up").length).toBeGreaterThan(ups);
    expect(d.of("agent_up").at(-1)).toMatchObject({ agent_ref: THREAD });
  });
});
