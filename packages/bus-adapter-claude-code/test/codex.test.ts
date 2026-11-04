// The Codex mode (C26b): a fake MCP client sends probe-shaped `_meta` to a fake daemon.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CLIENT_VERSION,
  connectDaemon,
  type Hello,
  STATUS_COPY,
  serveDaemon,
  statusSetText,
} from "@oa/bus-ipc";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexCall,
  codexServer,
  RESTART_REFUSAL,
  SUBAGENT_REFUSAL,
  TURN_META,
} from "../src/codex.ts";
import { sessionHello } from "../src/session.ts";
import { TOOLS } from "../src/tools.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const THREAD = "01a184f2-14eb-73d0-9da0-ffd91d13abd3";
const WORK = "/private/tmp/work";

/** A `_meta` as Codex 0.165 sends it (docs/probes/codex.md §1). */
const meta = (over: { thread?: string; call?: string; turn?: object } = {}) => {
  const thread = over.thread ?? THREAD;
  return {
    callId: over.call ?? "call_3",
    [TURN_META]: {
      session_id: thread,
      thread_id: thread,
      model: "stub-1",
      turn_id: "01a184f2-1569-79a2-8399-f0ac163ff023",
      thread_source: "user",
      turn_trigger: "exec",
      sandbox: "none",
      workspaces: { [WORK]: { has_changes: false } },
      codex_version: "0.165.0",
      ...over.turn,
    },
    threadId: thread,
    sessionId: thread,
    windowId: `${thread}:0`,
    itemId: "fc_3",
    progressToken: 1,
  };
};

/** A daemon that records each hello and answers `list` with an empty roster. */
async function fakeDaemon(refuse?: string) {
  const path = join(mkdtempSync(join(tmpdir(), "ob-codex-")), "d.sock");
  const hellos: Hello[] = [];
  const served = await serveDaemon({
    path,
    onHello: (h) => {
      hellos.push(h);
      if (refuse) return { error: refuse };
      return { bus_name: "codex", namespace: "ns", global: false };
    },
    onFrame: (f) => ({ id: f.id, type: "roster", agents: [] }),
  });
  closers.push(served.close);
  return { path, hellos };
}

async function codex(path: string) {
  const server = codexServer({
    connect: (hello) => connectDaemon({ path, hello }),
    pid: 4321,
    ppid: 4000,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "codex-mcp-client", version: "0.165.0" });
  await client.connect(b);
  closers.push(() => client.close());
  const call = async (m: unknown, name = "list_agents") =>
    (await client.callTool({
      name,
      arguments: {},
      ...(m === undefined ? {} : { _meta: m as Record<string, unknown> }),
    })) as { content: { text: string }[]; isError?: boolean };
  return { client, call };
}

/** A daemon from before this adapter: its Hello schema rejects the frame. */
async function olderDaemon() {
  const path = join(mkdtempSync(join(tmpdir(), "ob-codex-")), "d.sock");
  const server = createServer((sock) =>
    sock.once("data", () =>
      sock.end(
        `${JSON.stringify({ v: 1, id: "hello", type: "error", code: "bad_frame", message: "Invalid input: expected string, received undefined" })}\n`,
      ),
    ),
  );
  await new Promise<void>((r) => server.listen(path, r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { path };
}

describe("the codex MCP adapter", () => {
  it("asks for a restart when an older daemon rejects the hello's shape (C26j)", async () => {
    const d = await olderDaemon();
    const { call } = await codex(d.path);
    const r = await call(meta({ turn: { workspaces: undefined } }));
    expect(r).toMatchObject({
      isError: true,
      content: [{ text: RESTART_REFUSAL }],
    });
    expect(RESTART_REFUSAL).toBe(
      "Open Artifacts bus did not accept this thread: the update is half done. Ask the user to run npx @open-artifacts/bus install.",
    );
  });

  it("says nothing to the daemon until the first tools/call", async () => {
    const d = await fakeDaemon();
    const { client } = await codex(d.path);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
      "set_status",
    ]);
    expect(d.hellos).toEqual([]);
  });

  it("hellos per call with the thread, the call, pid, ppid and the thread's cwd", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const r = await call(meta());
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toBe("No agents in your namespace.");
    await call(meta({ call: "call_4" }));
    expect(d.hellos).toEqual([
      {
        v: 1,
        id: "hello",
        type: "hello",
        kind: "codex",
        client_version: CLIENT_VERSION,
        agent_ref: THREAD,
        pid: 4321,
        cwd: WORK,
        proposed_name: "codex",
        attest: {},
        codex: {
          thread_id: THREAD,
          call_id: "call_3",
          ppid: 4000,
          thread_source: "user",
          item_id: "fc_3",
          turn_id: "01a184f2-1569-79a2-8399-f0ac163ff023",
        },
      },
      expect.objectContaining({
        codex: expect.objectContaining({ call_id: "call_4" }),
      }),
    ]);
  });

  it("a code-mode call sends its exec item id and turn; none when Codex sent none (C27)", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const exec = "exec-0b5c2a8e-3f1d-4c6a-9e2b-7d4f1a3c5e6b";
    await call({ ...meta({ call: exec }), itemId: "ctc_synthetic01" });
    const { itemId: _, ...bare } = meta({ call: exec });
    await call(bare);
    expect(d.hellos.map((h) => h.codex)).toEqual([
      {
        thread_id: THREAD,
        call_id: exec,
        ppid: 4000,
        thread_source: "user",
        item_id: "ctc_synthetic01",
        turn_id: "01a184f2-1569-79a2-8399-f0ac163ff023",
      },
      {
        thread_id: THREAD,
        call_id: exec,
        ppid: 4000,
        thread_source: "user",
        turn_id: "01a184f2-1569-79a2-8399-f0ac163ff023",
      },
    ]);
  });

  it.each(["subagent", "guardian_review", "memory_consolidation"])(
    "a %s thread opens no link and every tool refuses",
    async (source) => {
      const d = await fakeDaemon();
      const { call } = await codex(d.path);
      for (const tool of TOOLS)
        expect(
          await call(meta({ turn: { thread_source: source } }), tool.name),
        ).toMatchObject({
          isError: true,
          content: [{ text: SUBAGENT_REFUSAL }],
        });
      expect(SUBAGENT_REFUSAL).toBe(
        "oa-bus: a subagent is not on the bus; only the main Codex thread can use Open Artifacts bus",
      );
      expect(d.hellos).toEqual([]);
    },
  );

  it("a thread_source it does not know goes to the daemon to decide", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    // A codex-rs `ThreadSource::Feature(String)`, or a later build's main thread.
    expect(
      (await call(meta({ turn: { thread_source: "vscode" } }))).isError,
    ).toBeFalsy();
    expect(d.hellos.map((h) => h.codex?.thread_source)).toEqual(["vscode"]);
  });

  it("no thread_source goes to the daemon without one, to decide from Codex's state (C26j)", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const r = await call(meta({ turn: { thread_source: undefined } }));
    expect(r.isError).toBeFalsy();
    expect(d.hellos).toHaveLength(1);
    expect(d.hellos[0]?.codex).not.toHaveProperty("thread_source");
  });

  it.each<[string, unknown]>([
    ["no _meta", undefined],
    ["an empty _meta", {}],
    ["no turn metadata", { ...meta(), [TURN_META]: undefined }],
    ["turn metadata that is not JSON", { ...meta(), [TURN_META]: "{nope" }],
    ["turn metadata that is an array", { ...meta(), [TURN_META]: [] }],
    ["no threadId", { ...meta(), threadId: undefined }],
    ["a numeric callId", { ...meta(), callId: 3 }],
    ["a thread_id that disagrees", meta({ turn: { thread_id: "other" } })],
  ])("%s is refused cleanly, with no hello", async (_, m) => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const r = await call(m);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      "oa-bus: this Codex version did not send the thread's identity.",
    );
    expect(d.hellos).toEqual([]);
    // Still serving.
    expect((await call(meta())).isError).toBeFalsy();
  });

  it.each<[string, unknown]>([
    ["a callId too long for the wire", { ...meta(), callId: "c".repeat(300) }],
    ["a threadId that is not a ref", meta({ thread: "../etc/passwd" })],
  ])("%s is refused with the clean copy, not a schema dump", async (_, m) => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const r = await call(m);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      "oa-bus: this Codex version did not send the thread's identity.",
    );
    expect(d.hellos).toEqual([]);
  });

  it.each([
    ["no workspaces key (a woken turn)", undefined],
    ["no workspace", {}],
    ["two workspaces", { [WORK]: {}, "/elsewhere": {} }],
    ["a relative workspace", { work: {} }],
  ])(
    "%s sends a hello without cwd: the daemon reads the rollout's (C26j)",
    async (_, workspaces) => {
      const d = await fakeDaemon();
      const { call } = await codex(d.path);
      const r = await call(meta({ turn: { workspaces } }));
      expect(r.isError).toBeFalsy();
      expect(d.hellos).toHaveLength(1);
      expect(d.hellos[0]).not.toHaveProperty("cwd");
    },
  );

  it("refuses a second thread in the same process rather than re-identifying", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    expect((await call(meta())).isError).toBeFalsy();
    const other = "01a184f2-0000-7000-8000-000000000000";
    const r = await call(meta({ thread: other }));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      `oa-bus: this Open Artifacts bus server belongs to Codex thread ${THREAD}, not ${other}.`,
    );
    expect(d.hellos.map((h) => h.agent_ref)).toEqual([THREAD]);
    // The first thread keeps working.
    expect((await call(meta({ call: "call_9" }))).isError).toBeFalsy();
  });

  it("a first call whose hello is invalid does not pin its thread", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    expect((await call(meta({ thread: "../etc/passwd" }))).isError).toBe(true);
    expect((await call(meta())).isError).toBeFalsy();
    expect(d.hellos.map((h) => h.agent_ref)).toEqual([THREAD]);
  });

  it("a refused hello shows the daemon's reason in the approved wrapper (C26c)", async () => {
    const d = await fakeDaemon("Codex restarted. Call the tool again.");
    const { call } = await codex(d.path);
    const r = await call(meta());
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      "Open Artifacts bus did not accept this thread: Codex restarted. Call the tool again.",
    );
  });

  it("a daemon that is down is a tool error, not a crash", async () => {
    const { call } = await codex(join(tmpdir(), "ob-codex-none", "d.sock"));
    const r = await call(meta());
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(
      /^Open Artifacts bus did not accept this thread: /,
    );
  });

  it("takes a `cwd` key over workspaces, and turn metadata sent as JSON text", () => {
    expect(
      codexCall(meta({ turn: { cwd: "/repo/sub", workspaces: {} } })),
    ).toEqual({
      threadId: THREAD,
      callId: "call_3",
      threadSource: "user",
      cwd: "/repo/sub",
      itemId: "fc_3",
      turnId: "01a184f2-1569-79a2-8399-f0ac163ff023",
    });
    const m = meta();
    expect(
      codexCall({ ...m, [TURN_META]: JSON.stringify(m[TURN_META]) }),
    ).toEqual({
      threadId: THREAD,
      callId: "call_3",
      threadSource: "user",
      cwd: WORK,
      itemId: "fc_3",
      turnId: "01a184f2-1569-79a2-8399-f0ac163ff023",
    });
  });

  it("leaves Claude's hello as it was: no codex facts", () => {
    const h = sessionHello(
      { pid: 1, sessionId: "s1", socketPath: null, peerToken: null, name: "x" },
      1,
      "/",
    );
    expect(h.kind).toBe("claude-code");
    expect(h).not.toHaveProperty("codex");
  });
});

describe("set_status in codex mode", () => {
  /** A daemon with Codex's one-request rule, recording each connection's hello and frames. */
  async function statusDaemon() {
    const path = join(mkdtempSync(join(tmpdir(), "ob-codex-")), "d.sock");
    const conns: { hello: Hello; frames: { type: string }[] }[] = [];
    const served = await serveDaemon({
      path,
      oneRequest: (h) => h.kind === "codex",
      onHello: (h) => {
        conns.push({ hello: h, frames: [] });
        return { bus_name: "codex", namespace: "ns", global: false };
      },
      onFrame: (f, h) => {
        conns.find((c) => c.hello === h)?.frames.push(f);
        return f.type === "set_status"
          ? { id: f.id, type: "status_set" }
          : { id: f.id, type: "roster", agents: [] };
      },
    });
    closers.push(served.close);
    return { path, conns };
  }

  const callWith = async (
    path: string,
    name: string,
    args: Record<string, unknown>,
    m: unknown,
  ) => {
    const { client } = await codex(path);
    return (await client.callTool({
      name,
      arguments: args,
      _meta: m as Record<string, unknown>,
    })) as { content: { text: string }[]; isError?: boolean };
  };

  it("each call is attested by its own call id and is the connection's one request", async () => {
    const d = await statusDaemon();
    const { client } = await codex(d.path);
    const r1 = (await client.callTool({
      name: "set_status",
      arguments: { state: "working", label: "tests" },
      _meta: meta({ call: "call_7" }),
    })) as { content: { text: string }[]; isError?: boolean };
    const r2 = (await client.callTool({
      name: "set_status",
      arguments: { state: "idle" },
      _meta: meta({ call: "call_8" }),
    })) as { content: { text: string }[]; isError?: boolean };
    expect(r1).toMatchObject({
      isError: false,
      content: [{ text: statusSetText("working", "tests") }],
    });
    expect(r2).toMatchObject({
      isError: false,
      content: [{ text: statusSetText("idle") }],
    });
    expect(d.conns.map((c) => c.hello.codex)).toEqual([
      {
        thread_id: THREAD,
        call_id: "call_7",
        ppid: 4000,
        thread_source: "user",
        item_id: "fc_3",
        turn_id: "01a184f2-1569-79a2-8399-f0ac163ff023",
      },
      {
        thread_id: THREAD,
        call_id: "call_8",
        ppid: 4000,
        thread_source: "user",
        item_id: "fc_3",
        turn_id: "01a184f2-1569-79a2-8399-f0ac163ff023",
      },
    ]);
    expect(d.conns.map((c) => c.frames.map((f) => f.type))).toEqual([
      ["set_status"],
      ["set_status"],
    ]);
  });

  it("a subagent thread is refused before any hello", async () => {
    const d = await statusDaemon();
    const r = await callWith(
      d.path,
      "set_status",
      { state: "idle" },
      meta({ turn: { thread_source: "subagent" } }),
    );
    expect(r).toMatchObject({
      isError: true,
      content: [{ text: SUBAGENT_REFUSAL }],
    });
    expect(d.conns).toEqual([]);
  });

  it("a daemon's bad_frame answers with the bad_frame copy", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ob-codex-")), "d.sock");
    // Today's server with an onFrame that cannot know the frame: as an older
    // daemon's AdapterFrame refuses the unknown type.
    const served = await serveDaemon({
      path,
      oneRequest: () => true,
      onHello: () => ({ bus_name: "codex", namespace: "ns", global: false }),
      onFrame: (f) => ({
        id: f.id,
        type: "error",
        code: "bad_frame",
        message: "Invalid input",
      }),
    });
    closers.push(served.close);
    expect(
      await callWith(
        path,
        "set_status",
        { state: "idle" },
        meta({ call: "call_set_status" }),
      ),
    ).toMatchObject({
      isError: true,
      content: [{ text: STATUS_COPY.bad_frame }],
    });
  });
});
