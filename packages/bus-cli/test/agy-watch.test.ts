// agy S3: `oa-bus agy-watch` against a real daemon (the bus-daemon test
// harness, a fake hub) and a fake agy: `send` records each agentapi
// send-message call and writes what agy took into a fake agy data folder,
// laid out as agy keeps its mailbox, read by the real mailbox reader; the
// process table is a map. No sleeps: every wait is a signal with a deadline.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgyConversation,
  agyMailboxHas,
  agyStateDir,
  agyWatchLive,
  readAgyWatch,
  writeAgyConversation,
  writeAgyWatch,
} from "@oa/bus-adapter-claude-code";
import { connectDaemon, type DaemonClient } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../../bus-daemon/src/attest.ts";
import { daemonHarness, stopAll } from "../../bus-daemon/test/helpers.ts";
import { agyHello, agyWatchStep } from "../src/commands/agy-hello.ts";
import {
  AGY_MESSAGE_TITLE,
  type AgyWatchDeps,
  agyChildState,
  agyErrorLine,
  agyWatch,
  execSend,
  type SendResult,
} from "../src/commands/agy-watch.ts";
import { fakeCtx } from "./fake.ts";

afterEach(stopAll);

const A = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const AGY = 4242;
const SHELL = 5150;
const W1 = 5151;
const W2 = 5152;
/** The `agy agentapi` process a hand-off starts. */
const CALL = 6161;
const ENV = {
  ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
  ANTIGRAVITY_CSRF_TOKEN: "test-token-not-a-secret",
};

const table: Record<number, { ppid: number; name: string }> = {
  [W1]: { ppid: SHELL, name: "node" },
  [W2]: { ppid: SHELL, name: "node" },
  [CALL]: { ppid: W1, name: "/Users/u/.local/bin/agy" },
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
      // #3205: an unknown hand-off is pushed again after a short pause.
      recheckMs: [5],
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
  /** agy's data folder: its mailbox holds every message agentapi took. */
  const appData = mkdtempSync(join(tmpdir(), "ob-agy-app-"));
  const mailDir = join(appData, "brain", A, ".system_generated", "messages");
  mkdirSync(join(appData, "brain", A, ".system_generated"), {
    recursive: true,
  });
  const box = { readable: true };
  /** Whether an earlier call's process can be read (gap B: it may not be). */
  const procs = { readable: true };
  const took = () =>
    existsSync(mailDir)
      ? readdirSync(mailDir).map(
          (n) =>
            JSON.parse(readFileSync(join(mailDir, n), "utf8"))
              .content as string,
        )
      : [];
  const inBox = (id: string) =>
    took().filter((t) => t.includes(`(msg_id ${id})`)).length;
  /** agy takes it: what a real agentapi send-message does before it returns. */
  const agyTakes = (bin: string, conversation: string, text: string) => {
    calls.push({ bin, conversation, text });
    mkdirSync(mailDir, { recursive: true });
    const uuid = randomUUID();
    writeFileSync(
      join(mailDir, `${uuid}.json`),
      JSON.stringify({
        id: uuid,
        recipient: conversation,
        sender: conversation,
        renderDetails: { messageTitle: AGY_MESSAGE_TITLE },
        content: text,
      }),
    );
  };
  /** One watcher process: its own pid, its own link, its own liveness tick. */
  const start = (pid: number, send?: AgyWatchDeps["send"]) => {
    let tick: (() => void) | undefined;
    const clients: DaemonClient[] = [];
    const logs: string[] = [];
    const failed: string[] = [];
    const unknown: string[] = [];
    const slept: number[] = [];
    /** The text of each push the daemon made to this watcher. */
    const pushes: string[] = [];
    const run = agyWatch(ctx, {
      proc: (p) => table[p] ?? null,
      procStart: (p) => starts.get(p) ?? null,
      childState: (p, start) =>
        !procs.readable
          ? "unknown"
          : !starts.has(p)
            ? "gone"
            : start === "" || starts.get(p) === start
              ? start === ""
                ? "unknown"
                : "running"
              : "gone",
      ppid: SHELL,
      pid,
      env: ENV,
      send:
        send ??
        (async (bin, conversation, text): Promise<SendResult> => {
          agyTakes(bin, conversation, text);
          return { ok: true };
        }),
      mailbox: (conversation, msgId) =>
        box.readable
          ? agyMailboxHas(appData, conversation, AGY_MESSAGE_TITLE, msgId)
          : "unreadable",
      now: () => 1_000_000,
      connect: async (hello) => {
        // A killed watcher process never reaches the daemon again.
        if (!starts.has(pid)) throw new Error("this watcher was killed");
        const c = await connectDaemon({ path: h.socketPath, hello });
        const giveBack = c.agyFailed;
        c.agyFailed = (id) => {
          failed.push(id);
          giveBack(id);
        };
        const notSure = c.agyUnknown;
        c.agyUnknown = (id) => {
          unknown.push(id);
          notSure(id);
        };
        const on = c.onAgyDeliver;
        c.onAgyDeliver = (cb) =>
          on((f) => {
            pushes.push(f.text);
            cb(f);
          });
        clients.push(c);
        return c;
      },
      rejoin: async (hello) => {
        (await connectDaemon({ path: h.socketPath, hello })).close();
      },
      sleep: (ms, abort) =>
        new Promise((r) => {
          slept.push(ms);
          // A killed one just waits for the end of the test.
          if (starts.has(pid)) setImmediate(r);
          abort.addEventListener("abort", () => r());
        }),
      every: (_ms, fn) => {
        tick = fn;
        return () => {
          tick = undefined;
        };
      },
      log: (l) => logs.push(l),
      onStop: () => {},
    });
    return {
      run,
      clients,
      logs,
      failed,
      unknown,
      slept,
      pushes,
      tick: () => tick?.(),
    };
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
  /** The hub delivers an id again (its receipt is still pending). */
  const again = (msg_id: string, body = "hello there") =>
    h.toDaemon({
      id: `again-${msg_id}`,
      type: "deliver",
      msg_id,
      to_ref: A,
      from_name: "peer",
      namespace: "ns",
      body,
    });
  /** A watcher process dies (SIGKILL): its link drops, nothing else runs. */
  const kill = (w: { clients: DaemonClient[] }, pid: number) => {
    starts.delete(pid);
    for (const c of w.clients) c.close();
  };
  /** The hub renamed the session (it got a title): later pushes say the new name. */
  const rename = (bus_name: string) =>
    h.toDaemon({
      v: 1,
      id: `rn-${bus_name}`,
      type: "renamed",
      agent_ref: A,
      bus_name,
    });
  return {
    h,
    ctx,
    conv,
    start,
    send,
    again,
    rename,
    kill,
    acked,
    calls,
    box,
    procs,
    inBox,
    agyTakes,
    up,
  };
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

  // A watcher can die at any step of a hand-off. Whatever the step, agy ends
  // up with the message exactly once, and the receipt says delivered only
  // when agy said it took it.
  /** A hand-off that never reaches agy and never comes back. */
  const neverReaches =
    (reached: () => void) => async (): Promise<SendResult> => {
      reached();
      return new Promise<SendResult>(() => {});
    };

  it("dies before the hand-off reached agy: the next watcher sees agy's mailbox without it and sends it once", async () => {
    const { start, send, kill, acked, calls, inBox, up } = await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    // The mark is written, then the process dies before agy is called.
    const w1 = start(W1, neverReaches(reached));
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    expect(inBox(id)).toBe(0);
    const w2 = start(W2);
    await until(() => expect(acked(id)).toBe(1));
    expect(inBox(id)).toBe(1);
    expect(calls).toHaveLength(1);
    // It first let the dead watcher's agy call run out.
    expect(w2.slept).toContain(20_000);
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("dies after agy took it, before the watcher wrote that down: the next watcher finds it in agy's mailbox and only acks", async () => {
    const { start, send, kill, acked, calls, inBox, agyTakes, up } =
      await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    const w1 = start(W1, async (bin, conversation, text) => {
      agyTakes(bin, conversation, text);
      reached();
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    const w2 = start(W2);
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    expect(w2.logs.join("\n")).toContain(
      `delivered ${id} (agy already had it)`,
    );
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("dies after it wrote agy's yes down, before the ack: the next watcher only acks", async () => {
    const { start, send, kill, acked, calls, inBox, up } = await setup();
    const w1 = start(W1);
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    // The process dies the moment it would ack.
    let reached!: () => void;
    const atAck = new Promise<void>((r) => {
      reached = r;
    });
    for (const c of w1.clients)
      c.ack = () => {
        reached();
      };
    const id = send();
    await atAck;
    kill(w1, W1);
    expect(acked(id)).toBe(0);
    expect(inBox(id)).toBe(1);
    const w2 = start(W2);
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("when agy's mailbox cannot be read after a watcher died mid hand-off, the receipt stays pending: never sent again, never called delivered", async () => {
    const { start, send, again, kill, acked, calls, box, inBox, agyTakes, up } =
      await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    const w1 = start(W1, async (bin, conversation, text) => {
      agyTakes(bin, conversation, text);
      reached();
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    box.readable = false;
    const w2 = start(W2);
    await until(() => expect(w2.unknown).toContain(id));
    expect(acked(id)).toBe(0);
    expect(calls).toHaveLength(1);
    // The mailbox reads again; the daemon pushes it again: now it is acked.
    box.readable = true;
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("the session is renamed between a hand-off that reached agy and the next push: only acked, never sent again", async () => {
    const {
      start,
      send,
      again,
      rename,
      kill,
      acked,
      calls,
      box,
      inBox,
      agyTakes,
      up,
    } = await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    const w1 = start(W1, async (bin, conversation, text) => {
      agyTakes(bin, conversation, text);
      reached();
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    // The next watcher cannot tell yet: the receipt stays pending.
    box.readable = false;
    const w2 = start(W2);
    await until(() => expect(w2.unknown).toContain(id));
    // agy titled the conversation; the hub renamed the session.
    rename("release-prep");
    // Readable once the rename landed: the next recheck push says the new name.
    await until(() =>
      expect(w2.pushes.some((t) => t.includes("to you (release-prep)"))).toBe(
        true,
      ),
    );
    box.readable = true;
    await until(() => expect(acked(id)).toBe(1));
    // The push carried the new name, agy's copy the old: still the same message.
    expect(w2.pushes.at(-1)).toContain("to you (release-prep)");
    expect(calls[0]?.text).toContain("to you (agy)");
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    expect(w2.logs.join("\n")).toContain(
      `delivered ${id} (agy already had it)`,
    );
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("a watcher killed outright leaves its agentapi call running: the next one waits for that call to end, then sends only if agy lacks it", async () => {
    const { start, send, kill, acked, calls, inBox, up } = await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    // The call starts, then hangs: agy has not taken the message yet.
    const w1 = start(W1, async (_bin, _conversation, _text, started) => {
      starts.set(CALL, "c1");
      started?.(CALL);
      reached();
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    expect(inBox(id)).toBe(0);
    // The orphaned call still runs: it may yet reach agy.
    const w2 = start(W2);
    await until(() => expect(w2.unknown).toContain(id));
    expect(acked(id)).toBe(0);
    expect(calls).toHaveLength(0);
    // It ends without reaching agy; the daemon pushes it again: sent once.
    starts.delete(CALL);
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("#3205: the orphaned call reaches agy after the next watcher answered unknown: acked then, without the hub, and never sent again", async () => {
    const { start, send, kill, acked, calls, inBox, agyTakes, up } =
      await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    let resume!: () => void;
    const w1 = start(W1, async (bin, conversation, text, started) => {
      starts.set(CALL, "c1");
      started?.(CALL);
      reached();
      // Frozen at birth; it reaches agy only when resumed.
      await new Promise<void>((r) => {
        resume = r;
      });
      agyTakes(bin, conversation, text);
      starts.delete(CALL);
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    const w2 = start(W2);
    await until(() => expect(w2.unknown).toContain(id));
    expect(acked(id)).toBe(0);
    // The orphan resumes and agy takes the message from it.
    resume();
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    expect(w2.logs.join("\n")).toContain(
      `delivered ${id} (agy already had it)`,
    );
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("gap A: a watcher that dies between starting its agy call and writing the call down never let it reach agy: the next watcher sends once", async () => {
    const { start, send, kill, acked, calls, inBox, up } = await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    // The call process exists, but the watcher dies before `started` wrote
    // it down: its gate never opens (execSend), so it never runs agy.
    const w1 = start(W1, async () => {
      starts.set(CALL, "c1");
      reached();
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    const w2 = start(W2);
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("gap B: an earlier call whose process can't be read is unclear: unknown, never sent again, until it is provably gone", async () => {
    const { start, send, kill, acked, calls, inBox, procs, up } = await setup();
    let reached!: () => void;
    const inCall = new Promise<void>((r) => {
      reached = r;
    });
    const w1 = start(W1, async (_bin, _conversation, _text, started) => {
      starts.set(CALL, "c1");
      started?.(CALL);
      reached();
      return new Promise<SendResult>(() => {});
    });
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    const id = send();
    await inCall;
    kill(w1, W1);
    procs.readable = false;
    const w2 = start(W2);
    // Pushed again and again (rechecks), unknown each time, never sent.
    await until(() =>
      expect(w2.unknown.filter((x) => x === id).length).toBeGreaterThan(2),
    );
    expect(calls).toHaveLength(0);
    expect(acked(id)).toBe(0);
    expect(w2.logs.join("\n")).toContain("an earlier agy call may still run");
    // Readable again, and the call is gone without reaching agy: sent once.
    starts.delete(CALL);
    procs.readable = true;
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(inBox(id)).toBe(1);
    starts.delete(AGY);
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("agy said no but its mailbox cannot be read after: unknown, not given back for a retry", async () => {
    const { start, send, acked, calls, box, up } = await setup();
    const w = start(W1, async (bin, conversation, text) => {
      calls.push({ bin, conversation, text });
      box.readable = false;
      return { ok: false, detail: "exit status 1" };
    });
    await up();
    await until(() => expect(w.clients).toHaveLength(1));
    const id = send();
    await until(() => expect(w.unknown).toContain(id));
    expect(w.failed).not.toContain(id);
    expect(acked(id)).toBe(0);
    expect(calls).toHaveLength(1);
    starts.delete(AGY);
    w.tick();
    await w.run;
  });

  it("a hand-off that timed out is delivered only if agy's mailbox has it, else unknown", async () => {
    const { start, send, acked, calls, inBox, agyTakes, up } = await setup();
    let n = 0;
    const w = start(W1, async (bin, conversation, text, started) => {
      n += 1;
      // The first call times out after agy took it; the second before.
      if (n === 1) agyTakes(bin, conversation, text);
      else {
        calls.push({ bin, conversation, text });
        // Its call still runs (SIGTERM ignored): a recheck can't send again.
        starts.set(CALL, "c1");
        started?.(CALL);
      }
      return { ok: false, unknown: true, detail: "timed out" };
    });
    await up();
    await until(() => expect(w.clients).toHaveLength(1));
    const took = send();
    await until(() => expect(acked(took)).toBe(1));
    expect(inBox(took)).toBe(1);
    const lost = send();
    await until(() => expect(w.unknown).toContain(lost));
    expect(acked(lost)).toBe(0);
    expect(inBox(lost)).toBe(0);
    await until(() =>
      expect(w.unknown.filter((x) => x === lost).length).toBeGreaterThan(1),
    );
    expect(calls).toHaveLength(2);
    starts.delete(AGY);
    w.tick();
    await w.run;
  });

  it("gives agy back a message it refused, and tries again", async () => {
    const { start, send, acked, calls, inBox, agyTakes, up } = await setup();
    let first = true;
    const w = start(W1, async (bin, conversation, text) => {
      if (first) {
        first = false;
        calls.push({ bin, conversation, text });
        return { ok: false, detail: "conversation is loading" };
      }
      agyTakes(bin, conversation, text);
      return { ok: true };
    });
    await up();
    await until(() => expect(w.clients).toHaveLength(1));
    const id = send();
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(2);
    expect(inBox(id)).toBe(1);
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

  for (const [what, change] of [
    [
      "another conversation than the one the hook recorded",
      { conversationId: "5d1c9e2a-3b4f-4a6d-8e7f-0a1b2c3d4e5f" },
    ],
    ["a record of an earlier agy process with this pid", { procStart: "t-1" }],
  ] as const)
    it(`never hands agy a message for ${what}`, async () => {
      const { ctx, conv, start, send, calls, up } = await setup();
      const w = start(W1);
      await up();
      await until(() => expect(w.clients).toHaveLength(1));
      // The hook now records something else for this agy process.
      writeAgyConversation(ctx.home, { ...conv, ...change }, () => true);
      const id = send();
      await until(() => expect(w.failed).toContain(id));
      expect(calls).toHaveLength(0);
      expect(w.logs.join("\n")).toContain(`${id} is for another conversation`);
      starts.delete(AGY);
      w.tick();
      await w.run;
    });

  it("a watcher that died is asked for again at the next model call, and the message held meanwhile arrives once", async () => {
    const { ctx, start, send, acked, calls, up } = await setup();
    const w1 = start(W1);
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    await until(() => expect(readAgyWatch(ctx.home, AGY)?.pid).toBe(W1));
    // SIGKILL: no cleanup, its watch file stays behind.
    starts.delete(W1);
    for (const c of w1.clients) c.close();
    const id = send();
    // The next PreInvocation: the hook sees no live watcher and asks again.
    const hook = fakeCtx({ home: ctx.home });
    await agyHello(hook, {
      stdin: async () =>
        JSON.stringify({
          conversationId: A,
          cwd: "/w/app",
          workspacePaths: [],
        }),
      proc: (p) => table[p] ?? null,
      procStart: (p) => starts.get(p) ?? null,
      title: async () => undefined,
      hello: async () => ({ name: "agy" }),
      ppid: SHELL,
      watcherLive: (agy, s) =>
        agyWatchLive(ctx.home, agy, s, (p) => starts.get(p) ?? null),
      watchLine: () => "/h/.oa-bus/bin/oa-bus agy-watch",
    });
    const out = JSON.parse(hook.out()[0] as string);
    expect(out.injectSteps[0].systemMessage.systemMessage).toBe(
      agyWatchStep("/h/.oa-bus/bin/oa-bus agy-watch"),
    );
    expect(calls).toHaveLength(0);
    // The session starts it: the held message drains, once.
    const w2 = start(W2);
    await until(() => expect(acked(id)).toBe(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(`(msg_id ${id})`);
    expect(readAgyWatch(ctx.home, AGY)?.pid).toBe(W2);
    starts.delete(AGY);
    w1.tick();
    w2.tick();
    expect(await w2.run).toBe(0);
  });

  it("a start the daemon refuses (another watcher runs) leaves the running one's file", async () => {
    const { ctx, start, up } = await setup();
    const w1 = start(W1);
    await up();
    await until(() => expect(w1.clients).toHaveLength(1));
    await until(() => expect(readAgyWatch(ctx.home, AGY)?.pid).toBe(W1));
    // Two starts raced: the second got past the file check.
    writeAgyWatch(ctx.home, AGY, {
      pid: W1,
      procStart: "stale",
      agyStart: "t0",
    });
    const w2 = start(W2);
    expect(await w2.run).toBe(0);
    expect(w2.logs.join("\n")).toMatch(/already running/);
    expect(readAgyWatch(ctx.home, AGY)?.pid).toBe(W1);
    starts.delete(AGY);
    w1.tick();
    await w1.run;
  });

  it("agy's error line never carries its agentapi address or token", () => {
    expect(
      agyErrorLine(
        `dial ${ENV.ANTIGRAVITY_LS_ADDRESS} failed (token ${ENV.ANTIGRAVITY_CSRF_TOKEN})\nmore`,
        ENV,
      ),
    ).toBe(
      "dial <ANTIGRAVITY_LS_ADDRESS> failed (token <ANTIGRAVITY_CSRF_TOKEN>)",
    );
  });

  it("refuses to run outside an agy session or without agy's agentapi env", async () => {
    const ctx = fakeCtx();
    const base = {
      proc: (p: number) => table[p] ?? null,
      procStart: (p: number) => (p === AGY ? "t0" : null),
      pid: W1,
      log: () => {},
      onStop: () => {},
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

describe("the agy call's gate (#3205 review, gap A)", () => {
  /** A fake agy that writes its arguments to $MARK. */
  const fakeAgy = () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-agy-gate-"));
    const bin = join(dir, "agy");
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$MARK"\n');
    chmodSync(bin, 0o755);
    return { bin, mark: join(dir, "ran") };
  };

  it("runs agy only after the call was written down, with the arguments as given", async () => {
    const { bin, mark } = fakeAgy();
    const seen: number[] = [];
    const r = await execSend({ PATH: process.env.PATH, MARK: mark })(
      bin,
      A,
      "line one\n(msg_id x) $HOME `id`",
      (pid) => {
        // Not yet run: it waits for this to return.
        expect(existsSync(mark)).toBe(false);
        seen.push(pid);
        return true;
      },
    );
    expect(r).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(readFileSync(mark, "utf8")).toBe(
      `agentapi\nsend-message\n--title=${AGY_MESSAGE_TITLE}\n${A}\nline one\n(msg_id x) $HOME \`id\`\n`,
    );
  });

  for (const [what, started] of [
    ["could not be written down", () => false],
    [
      "threw while being written down",
      (): boolean => {
        throw new Error("disk full");
      },
    ],
  ] as const)
    it(`never runs agy when the call ${what}: a plain refusal, not unknown`, async () => {
      const { bin, mark } = fakeAgy();
      const r = await execSend({ PATH: process.env.PATH, MARK: mark })(
        bin,
        A,
        "hello",
        started,
      );
      expect(r).toEqual({ ok: false, detail: "stopped before agy was called" });
      expect(existsSync(mark)).toBe(false);
    });
});

describe("agyChildState (#3205 review, gap B)", () => {
  const yes = () => true;
  it("is gone only when provably so", () => {
    expect(
      agyChildState(
        1,
        "s",
        () => "s",
        () => false,
      ),
    ).toBe("gone");
    expect(agyChildState(1, "s", () => "other", yes)).toBe("gone");
    expect(agyChildState(1, "s", () => "s", yes)).toBe("running");
  });
  it("is unknown when the start time can't be read, or never was", () => {
    expect(
      agyChildState(
        1,
        "s",
        () => {
          throw new Error("ps timed out");
        },
        yes,
      ),
    ).toBe("unknown");
    expect(agyChildState(1, "s", () => null, yes)).toBe("unknown");
    expect(agyChildState(1, "", () => "s", yes)).toBe("unknown");
    // ps found nothing because it had just ended: gone.
    let n = 0;
    expect(
      agyChildState(
        1,
        "s",
        () => null,
        () => n++ === 0,
      ),
    ).toBe("gone");
  });
});
