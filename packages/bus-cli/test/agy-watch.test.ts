// agy S3: `oa-bus agy-watch` against a real daemon (the bus-daemon test
// harness, a fake hub) and a fake agy: `send` records each agentapi
// send-message call, the process table is a map. No sleeps: every wait is
// a signal with a deadline.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgyConversation,
  agyStateDir,
  readAgyWatch,
  writeAgyConversation,
  writeAgyWatch,
} from "@oa/bus-adapter-claude-code";
import { connectDaemon, type DaemonClient } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../../bus-daemon/src/attest.ts";
import { daemonHarness, stopAll } from "../../bus-daemon/test/helpers.ts";
import { agyWatchStep } from "../src/commands/agy-hello.ts";
import {
  AGY_MESSAGE_TITLE,
  type AgyWatchDeps,
  agyWatch,
  type SendResult,
} from "../src/commands/agy-watch.ts";
import { fakeCtx } from "./fake.ts";

afterEach(stopAll);

const A = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const AGY = 4242;
const SHELL = 5150;
const W1 = 5151;
const W2 = 5152;
const ENV = {
  ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
  ANTIGRAVITY_CSRF_TOKEN: "test-token-not-a-secret",
};

const table: Record<number, { ppid: number; name: string }> = {
  [W1]: { ppid: SHELL, name: "node" },
  [W2]: { ppid: SHELL, name: "node" },
  [SHELL]: { ppid: AGY, name: "/bin/zsh" },
  [AGY]: { ppid: 1, name: "/Users/u/.local/bin/agy" },
};
const starts = new Map<number, string>();
const chain = (pid: number) => {
  const out: number[] = [];
  for (
    let p: number | undefined = pid;
    p && p > 1 && out.length < 12;
    p = table[p]?.ppid
  )
    out.push(p);
  return out;
};

async function setup() {
  starts.clear();
  starts.set(AGY, "t0");
  starts.set(W1, "w1");
  starts.set(W2, "w2");
  const h = await daemonHarness({
    homeLookup: () => ({ instance: "main" as const }),
    attest: (hello) =>
      attest(hello, {
        comm: (pid) => table[pid]?.name ?? null,
        procStart: (pid) => starts.get(pid) ?? null,
        ancestors: chain,
      }),
    antigravity: {
      isRunning: (pid) => starts.has(pid),
      procStart: (pid) => starts.get(pid) ?? null,
    },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
  });
  const ctx = fakeCtx();
  const conv: AgyConversation = {
    pid: AGY,
    procStart: "t0",
    conversationId: A,
    cwd: "/w/app",
  };
  // What the S2 hook leaves behind at the first message.
  writeAgyConversation(ctx.home, conv, () => true);
  const calls: { bin: string; conversation: string; text: string }[] = [];
  /** One watcher process: its own pid, its own link, its own liveness tick. */
  const start = (pid: number, send?: AgyWatchDeps["send"]) => {
    let tick: (() => void) | undefined;
    const clients: DaemonClient[] = [];
    const logs: string[] = [];
    const run = agyWatch(ctx, {
      proc: (p) => table[p] ?? null,
      procStart: (p) => starts.get(p) ?? null,
      ppid: SHELL,
      pid,
      env: ENV,
      send:
        send ??
        (async (bin, conversation, text): Promise<SendResult> => {
          calls.push({ bin, conversation, text });
          return { ok: true };
        }),
      connect: async (hello) => {
        const c = await connectDaemon({ path: h.socketPath, hello });
        clients.push(c);
        return c;
      },
      rejoin: async (hello) => {
        (await connectDaemon({ path: h.socketPath, hello })).close();
      },
      sleep: (_ms, abort) =>
        new Promise((r) => {
          setImmediate(r);
          abort.addEventListener("abort", () => r());
        }),
      every: (_ms, fn) => {
        tick = fn;
        return () => {
          tick = undefined;
        };
      },
      log: (l) => logs.push(l),
    });
    return { run, clients, logs, tick: () => tick?.() };
  };
  let n = 0;
  const send = (body = "hello there") => {
    n += 1;
    const msg_id = `${"m".repeat(15)}${"123456789ABC"[n]}`;
    h.toDaemon({
      id: `d${n}`,
      type: "deliver",
      msg_id,
      to_ref: A,
      from_name: "peer",
      namespace: "ns",
      body,
    });
    return msg_id;
  };
  const acked = (id: string) =>
    h.of("ack").filter((f) => f.msg_id === id).length;
  const up = () =>
    vi.waitFor(
      () => expect(h.of("agent_up").some((u) => u.agent_ref === A)).toBe(true),
      { timeout: 5000, interval: 5 },
    );
  return { h, ctx, start, send, acked, calls, up };
}

const until = (fn: () => void) =>
  vi.waitFor(fn, { timeout: 5000, interval: 5 });

describe("oa-bus agy-watch (agy S3)", () => {
  it("joins the session's conversation again, then hands each message to agentapi send-message, once, and acks it", async () => {
    const { ctx, start, send, acked, calls, up } = await setup();
    const w = start(W1);
    await up();
    await until(() => expect(w.clients).toHaveLength(1));
    const id = send("run the tests please");
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      bin: "/Users/u/.local/bin/agy",
      conversation: A,
    });
    expect(calls[0]?.text).toContain("[oa-bus] Message from peer to you (agy)");
    expect(calls[0]?.text).toContain(`(msg_id ${id})`);
    expect(calls[0]?.text).toContain("run the tests please");
    // The watcher said who it is, and never wrote agy's token anywhere.
    expect(readAgyWatch(ctx.home, AGY)).toMatchObject({
      pid: W1,
      agyStart: "t0",
    });
    expect(w.logs.join("\n")).not.toContain(ENV.ANTIGRAVITY_CSRF_TOKEN);
    expect(AGY_MESSAGE_TITLE).toBe("Open Artifacts bus");
    // agy exits: the watcher stops and clears its file.
    starts.delete(AGY);
    w.tick();
    expect(await w.run).toBe(0);
    expect(readAgyWatch(ctx.home, AGY)).toBeUndefined();
  });

  it("never hands an id to agy twice across a watcher restart", async () => {
    const { start, send, acked, calls, up } = await setup();
    // The first watcher dies inside its call to agy (it never answers).
    let entered!: () => void;
    const inCall = new Promise<void>((r) => {
      entered = r;
    });
    const w1 = start(W1, async (bin, conversation, text) => {
      calls.push({ bin, conversation, text });
      entered();
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    // Its process is gone: the link drops, and its liveness check sees it.
    starts.delete(W1);
    for (const c of w1.clients) c.close();
    // A second watcher for the same agy process takes over.
    const w2 = start(W2);
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    starts.delete(AGY);
    w1.tick();
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("gives agy back a message it refused, and tries again", async () => {
    const { start, send, acked, calls, up } = await setup();
    let first = true;
    const w = start(W1, async (bin, conversation, text) => {
      calls.push({ bin, conversation, text });
      if (first) {
        first = false;
        return { ok: false, detail: "conversation is loading" };
      }
      return { ok: true };
    });
    await up();
    await until(() => expect(w.clients).toHaveLength(1));
    const id = send();
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(2);
    starts.delete(AGY);
    w.tick();
    await w.run;
  });

  it("a second start for the same agy process is a no-op", async () => {
    const { ctx, start } = await setup();
    writeAgyWatch(ctx.home, AGY, { pid: W1, procStart: "w1", agyStart: "t0" });
    const w = start(W2);
    expect(await w.run).toBe(0);
    expect(w.clients).toHaveLength(0);
    expect(w.logs.join("\n")).toMatch(/already running/);
    // The first one's file is left alone.
    expect(readAgyWatch(ctx.home, AGY)?.pid).toBe(W1);
  });

  it("refuses to run outside an agy session or without agy's agentapi env", async () => {
    const ctx = fakeCtx();
    const base = {
      proc: (p: number) => table[p] ?? null,
      procStart: (p: number) => (p === AGY ? "t0" : null),
      pid: W1,
      log: () => {},
    };
    expect(await agyWatch(ctx, { ...base, ppid: 999, env: ENV })).toBe(1);
    expect(await agyWatch(ctx, { ...base, ppid: SHELL, env: {} })).toBe(1);
    expect(existsSync(join(agyStateDir(ctx.home), `${AGY}.watch.json`))).toBe(
      false,
    );
  });

  it("the session is told the fixed line only, with nothing of a message in it", () => {
    const line = "/h/.oa-bus/bin/oa-bus agy-watch";
    expect(agyWatchStep(line)).toContain("BypassSandbox: true");
    expect(agyWatchStep(line).endsWith(line)).toBe(true);
  });
});
