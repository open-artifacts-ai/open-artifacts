// #3108: Codex's OAuth entry sends no link proof, only its own call ids in
// `_meta`. linkRequest builds a check from them and the member's own hub asks
// the member's own daemons (only those that listed codex_check). Real hubs and
// daemon sockets; the daemon's answers are frames, the time cap is a fake timer.
import { runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  canonicalArgsSha256,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import { linkRequest, PROOF_LOOKUP_MS } from "../../src/services/bus.js";
import { MCP_URL } from "../mcp-helpers.js";
import {
  type Daemon,
  daemon,
  e,
  framesSeen,
  hello,
  hubOf,
  machine,
  member,
  ns,
  waitFor,
} from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const hex = (n: number) =>
  Array.from({ length: n }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
const uuid = () => crypto.randomUUID();
const execCall = () => `exec-${uuid()}`;
const directCall = () => `call_${hex(24)}`;
const itemId = () => `ctc_${hex(40)}`;

const CAPS = [BUS_CAPS.link, BUS_CAPS.ids, BUS_CAPS.codexCheck];

type Check = {
  type: "codex_call_check";
  id: string;
  thread_id: string;
  tool: string;
  mode: Record<string, string>;
};

/** A member, a machine, a daemon that listed codex_check and a live codex session `thread`. */
async function scene(caps: string[] = CAPS, thread = uuid()) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(id("h")), caps } as ClientFrame);
  const ok = await waitFor(d, "hello_ok");
  d.send({
    v: 1,
    id: id("u"),
    type: "agent_up",
    agent_ref: thread,
    kind: "codex",
    proposed_name: `Cx${seq}`,
    namespace: ns("cx"),
    global: false,
  } as ClientFrame);
  await waitFor(d, "agent_ok");
  return { m, mach, d, thread, ok };
}

const checksOf = (d: Daemon) =>
  framesSeen(d).filter(
    (f) => f.type === "codex_call_check",
  ) as unknown as Check[];

const reply = (d: Daemon, re: string, ok: boolean) =>
  d.send({ v: 1, id: id("r"), type: "codex_call_checked", re, ok } as never);

type Meta = Record<string, unknown>;
const body = (name: string, meta: Meta, args: unknown = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args, _meta: meta },
});
const req = (b: unknown) =>
  new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer x",
    },
    body: JSON.stringify(b),
  });
const turn = (thread: string, extra: Meta = {}) => ({
  session_id: thread,
  thread_id: thread,
  turn_id: uuid(),
  thread_source: "user",
  ...extra,
});
const codeMeta = (thread: string, over: Meta = {}): Meta => ({
  callId: execCall(),
  threadId: thread,
  itemId: itemId(),
  "x-codex-turn-metadata": turn(thread),
  ...over,
});
const directMeta = (thread: string, over: Meta = {}): Meta => ({
  callId: directCall(),
  threadId: thread,
  "x-codex-turn-metadata": turn(thread),
  ...over,
});

/** Runs the call; the daemon `d` answers the first check it gets with `ok` (or never, when null). */
async function run(
  userId: string,
  d: Daemon | null,
  b: unknown,
  ok: boolean | null,
) {
  const p = linkRequest(e as never, userId, req(b));
  if (d && ok !== null) {
    const f = await waitFor(d, "codex_call_check");
    reply(d, f.id, ok);
  }
  return p;
}

afterEach(() => vi.restoreAllMocks());

describe("hello (#3108)", () => {
  it("lists codex_check only to a hello that listed it", async () => {
    const a = await scene();
    expect(a.ok.caps).toContain(BUS_CAPS.codexCheck);
    const b = await scene([BUS_CAPS.link, BUS_CAPS.ids]);
    expect(b.ok.caps).not.toContain(BUS_CAPS.codexCheck);
  });
});

describe("a Codex call with no proof (#3108)", () => {
  it("code mode: links to the codex session of the thread when the daemon says yes", async () => {
    const { m, d, thread } = await scene();
    const meta = codeMeta(thread);
    const r = await run(m.userId, d, body("ping", meta), true);
    expect(r.identity).toMatchObject({ kind: "codex" });
    const [c] = checksOf(d);
    expect(c).toMatchObject({
      thread_id: thread,
      tool: "ping",
      mode: { kind: "code", call_id: meta.callId, item_id: meta.itemId },
    });
  });

  it("direct mode: sends the canonical hash of the arguments", async () => {
    const { m, d, thread } = await scene();
    const args = { b: 2, a: { z: 1, y: [1, 2] } };
    const meta = directMeta(thread);
    const r = await run(m.userId, d, body("add_comment", meta, args), true);
    expect(r.identity).toMatchObject({ kind: "codex" });
    expect(checksOf(d)[0]?.mode).toEqual({
      kind: "direct",
      call_id: meta.callId,
      args_sha256: await canonicalArgsSha256({ a: { y: [1, 2], z: 1 }, b: 2 }),
    });
  });

  it("accepts the turn metadata as JSON text", async () => {
    const { m, d, thread } = await scene();
    const meta = codeMeta(thread, {
      "x-codex-turn-metadata": JSON.stringify(turn(thread)),
    });
    const r = await run(m.userId, d, body("ping", meta), true);
    expect(r.identity).toBeDefined();
  });

  it("is unlinked, and asks nobody, for a thread id the turn metadata contradicts", async () => {
    const { m, d, thread } = await scene();
    const meta = codeMeta(thread, { "x-codex-turn-metadata": turn(uuid()) });
    const r = await run(m.userId, d, body("ping", meta), null);
    expect(r.identity).toBeUndefined();
    expect(checksOf(d)).toEqual([]);
  });

  it("is unlinked, and asks nobody, when the turn metadata is missing or has no thread_id", async () => {
    const { m, d, thread } = await scene();
    const noMeta = codeMeta(thread);
    delete noMeta["x-codex-turn-metadata"];
    const noThread = codeMeta(thread, {
      "x-codex-turn-metadata": { turn_id: uuid(), thread_source: "user" },
    });
    for (const meta of [noMeta, noThread]) {
      const r = await run(m.userId, d, body("ping", meta), null);
      expect(r.identity).toBeUndefined();
    }
    expect(checksOf(d)).toEqual([]);
  });

  it("is unlinked, and asks nobody, for a subagent thread", async () => {
    const { m, d, thread } = await scene();
    for (const source of [
      "subagent",
      "guardian_review",
      "memory_consolidation",
    ]) {
      const meta = codeMeta(thread, {
        "x-codex-turn-metadata": turn(thread, { thread_source: source }),
      });
      const r = await run(m.userId, d, body("ping", meta), null);
      expect(r.identity).toBeUndefined();
    }
    expect(checksOf(d)).toEqual([]);
  });

  it("is unlinked, and asks nobody, for a batch", async () => {
    const { m, d, thread } = await scene();
    const one = body("ping", codeMeta(thread));
    const r = await run(m.userId, d, [one, one], null);
    expect(r.identity).toBeUndefined();
    expect(checksOf(d)).toEqual([]);
  });

  it("is unlinked, and asks nobody, for malformed ids", async () => {
    const { m, d, thread } = await scene();
    const bad: Meta[] = [
      codeMeta(thread, { callId: "exec-nope" }),
      codeMeta(thread, { itemId: "ctc_zz" }),
      codeMeta(thread, { threadId: "not-a-uuid" }),
      directMeta(thread, { callId: "call_" }),
      directMeta(thread, { callId: 42 }),
      codeMeta(thread, { "x-codex-turn-metadata": "{" }),
      codeMeta(thread, { "x-codex-turn-metadata": 7 }),
    ];
    for (const meta of bad) {
      const r = await run(m.userId, d, body("ping", meta), null);
      expect(r.identity).toBeUndefined();
    }
    const r = await run(m.userId, d, body("Bad Tool", codeMeta(thread)), null);
    expect(r.identity).toBeUndefined();
    expect(checksOf(d)).toEqual([]);
  });

  it("is unlinked when the daemon says no", async () => {
    const { m, d, thread } = await scene();
    const r = await run(m.userId, d, body("ping", codeMeta(thread)), false);
    expect(r.identity).toBeUndefined();
  });

  it("is unlinked when the daemon says yes but holds no live codex session for the thread", async () => {
    const { m, d } = await scene();
    const r = await run(m.userId, d, body("ping", codeMeta(uuid())), true);
    expect(r.identity).toBeUndefined();
  });

  it("is unlinked when the daemon never answers, after the time cap (fake timer)", async () => {
    const { m, d, thread } = await scene();
    const hub = await hubOf(m.userId);
    const meta = codeMeta(thread);
    const out = await runInDurableObject(hub, async (inst: BusHub) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const p = inst.codexCallCheck({
          thread_id: thread,
          tool: "ping",
          mode: { kind: "code", call_id: meta.callId, item_id: meta.itemId },
        });
        await vi.advanceTimersByTimeAsync(PROOF_LOOKUP_MS);
        return await p;
      } finally {
        vi.useRealTimers();
      }
    });
    expect(out).toBeNull();
    expect(checksOf(d)).toHaveLength(1);
  });

  it("an answer from another socket never vouches: identity comes from the answering socket's own session", async () => {
    const { m, d, thread } = await scene();
    // A second machine of the same member holds no session for the thread.
    const mach2 = await machine("Desktop", m.userId);
    const other = await daemon(mach2.token);
    other.send({ ...hello(id("h")), caps: CAPS } as ClientFrame);
    await waitFor(other, "hello_ok");
    const hub = await hubOf(m.userId);
    const meta = codeMeta(thread);
    const p = hub.codexCallCheck({
      thread_id: thread,
      tool: "ping",
      mode: { kind: "code", call_id: meta.callId, item_id: meta.itemId },
    });
    const mine = await waitFor(d, "codex_call_check");
    const theirs = await waitFor(other, "codex_call_check");
    // A made-up re and the other socket's frame id, sent from this socket, are ignored.
    reply(other, "made-up-id", true);
    reply(other, mine.id, true);
    // The other machine says yes for its own frame: it holds no such session.
    reply(other, theirs.id, true);
    reply(d, mine.id, false);
    expect(await p).toBeNull();
  });

  it("a call naming another member's thread asks only the caller's own daemons", async () => {
    const a = await scene();
    const b = await scene();
    // A's request names B's live thread; linkRequest routes by A's user id
    // (busHub(env, userId)), so B's daemon is never asked and A's says no.
    const r = await run(
      a.m.userId,
      a.d,
      body("ping", codeMeta(b.thread)),
      false,
    );
    expect(r.identity).toBeUndefined();
    expect(checksOf(a.d)).toHaveLength(1);
    expect(checksOf(b.d)).toEqual([]);
  });

  it("never asks a daemon that did not list codex_check", async () => {
    const { m, d, thread } = await scene([BUS_CAPS.link, BUS_CAPS.ids]);
    const r = await run(m.userId, d, body("ping", codeMeta(thread)), null);
    expect(r.identity).toBeUndefined();
    expect(checksOf(d)).toEqual([]);
  });

  it("links a (thread, call) once: the second use is unlinked and asks nobody", async () => {
    const { m, d, thread } = await scene();
    const meta = codeMeta(thread);
    expect(
      (await run(m.userId, d, body("ping", meta), true)).identity,
    ).toBeDefined();
    const again = await run(m.userId, d, body("ping", meta), null);
    expect(again.identity).toBeUndefined();
    expect(checksOf(d)).toHaveLength(1);
  });

  it("remembers a miss for a short while: no second ask", async () => {
    const { m, d, thread } = await scene();
    const meta = codeMeta(thread);
    await run(m.userId, d, body("ping", meta), false);
    const again = await run(m.userId, d, body("ping", meta), null);
    expect(again.identity).toBeUndefined();
    expect(checksOf(d)).toHaveLength(1);
  });

  it("asks once for the same check in flight, and links only the first", async () => {
    const { m, d, thread } = await scene();
    const meta = codeMeta(thread);
    const a = linkRequest(e as never, m.userId, req(body("ping", meta)));
    const b = linkRequest(e as never, m.userId, req(body("ping", meta)));
    const f = await waitFor(d, "codex_call_check");
    reply(d, f.id, true);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.identity).toBeDefined();
    expect(rb.identity).toBeUndefined();
    expect(checksOf(d)).toHaveLength(1);
  });

  it("other args on a running (thread, call) never join its check", async () => {
    const { m, d, thread } = await scene();
    const meta = directMeta(thread);
    const real = { body: "mine" };
    const realHash = await canonicalArgsSha256(real);
    const a = linkRequest(
      e as never,
      m.userId,
      req(body("add_comment", meta, real)),
    );
    const b = linkRequest(
      e as never,
      m.userId,
      req(body("add_comment", meta, { body: "theirs" })),
    );
    const f1 = await waitFor(d, "codex_call_check");
    const f2 = await waitFor(d, "codex_call_check");
    for (const f of [f1, f2]) {
      const mode = (f as unknown as Check).mode as { args_sha256?: string };
      reply(d, f.id, mode.args_sha256 === realHash);
    }
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.identity).toBeDefined();
    expect(rb.identity).toBeUndefined();
  });

  it("another tool on a running (thread, call) never links too, even if its daemon says yes", async () => {
    const { m, d, thread } = await scene();
    const meta = codeMeta(thread);
    const a = linkRequest(e as never, m.userId, req(body("ping", meta)));
    const b = linkRequest(e as never, m.userId, req(body("add_comment", meta)));
    reply(d, (await waitFor(d, "codex_call_check")).id, true);
    reply(d, (await waitFor(d, "codex_call_check")).id, true);
    const rs = await Promise.all([a, b]);
    expect(rs.filter((r) => r.identity !== undefined)).toHaveLength(1);
  });

  it("a miss for other args does not hold back the real call", async () => {
    const { m, d, thread } = await scene();
    const meta = directMeta(thread);
    const wrong = await run(
      m.userId,
      d,
      body("add_comment", meta, { body: "theirs" }),
      false,
    );
    expect(wrong.identity).toBeUndefined();
    const real = await run(
      m.userId,
      d,
      body("add_comment", meta, { body: "mine" }),
      true,
    );
    expect(real.identity).toBeDefined();
    expect(checksOf(d)).toHaveLength(2);
  });
});

describe("limits (#3108)", () => {
  /** Answers every check on `d` with yes, as each frame arrives; returns the stop. */
  function autoYes(d: Daemon) {
    const on = (ev: MessageEvent) => {
      try {
        const f = JSON.parse(String(ev.data)) as { type?: string; id?: string };
        if (f.type === "codex_call_check" && f.id) reply(d, f.id, true);
      } catch {
        // Not a frame (a PONG).
      }
    };
    d.ws.addEventListener("message", on);
    return async () => d.ws.removeEventListener("message", on);
  }

  const setClock = async (userId: string, ms: number | null) =>
    runInDurableObject(await hubOf(userId), (inst: BusHub) =>
      BusHub.setTestClock(inst, ms),
    );

  it("links at most 50 times per item: the 51st is unlinked and asks nobody", async () => {
    const { m, d, thread } = await scene();
    const stop = autoYes(d);
    const item = itemId();
    let t = Date.now();
    const hub = await hubOf(m.userId);
    for (let i = 0; i < 50; i++) {
      // Stay under the rate limit: a new minute every 20 checks.
      if (i % 100 === 0) {
        t += 61_000;
        await setClock(m.userId, t);
      }
      const r = await hub.codexCallCheck({
        thread_id: thread,
        tool: "ping",
        mode: { kind: "code", call_id: execCall(), item_id: item },
      });
      expect(r).not.toBeNull();
    }
    t += 61_000;
    await setClock(m.userId, t);
    const before = checksOf(d).length;
    const r = await hub.codexCallCheck({
      thread_id: thread,
      tool: "ping",
      mode: { kind: "code", call_id: execCall(), item_id: item },
    });
    expect(r).toBeNull();
    expect(checksOf(d)).toHaveLength(before);
    await setClock(m.userId, null);
    await stop();
  });

  it("rate limits checks per hub: past the limit nothing is asked", async () => {
    const { m, d, thread } = await scene();
    const stop = autoYes(d);
    await setClock(m.userId, Date.now() + 1_000_000);
    const hub = await hubOf(m.userId);
    const results: unknown[] = [];
    for (let i = 0; i < 130; i++)
      results.push(
        await hub.codexCallCheck({
          thread_id: thread,
          tool: "ping",
          mode: { kind: "code", call_id: execCall(), item_id: itemId() },
        }),
      );
    expect(results.filter((r) => r !== null)).toHaveLength(120);
    expect(checksOf(d)).toHaveLength(120);
    await setClock(m.userId, null);
    await stop();
  });
});

describe("logging (#3108)", () => {
  it("no _meta value and no hash reaches any log line", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const { m, d, thread } = await scene();
    const code = codeMeta(thread);
    const direct = directMeta(thread);
    const args = { secret: "s3cr3t-value" };
    const hash = await canonicalArgsSha256(args);
    await run(m.userId, d, body("ping", code), false);
    await run(m.userId, d, body("ping", code), null);
    await run(m.userId, d, body("add_comment", direct, args), true);
    await run(m.userId, d, body("ping", codeMeta(thread)), true);
    const bad = codeMeta(thread, { "x-codex-turn-metadata": turn(uuid()) });
    await run(m.userId, d, body("ping", bad), null);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const v of [
      thread,
      code.callId,
      code.itemId,
      direct.callId,
      bad.callId,
      hash,
      "s3cr3t-value",
    ])
      expect(logged).not.toContain(v);
  });
});
