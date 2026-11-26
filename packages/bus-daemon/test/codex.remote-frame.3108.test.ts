// #3108: the daemon answers a hub's codex_call_check only on a link whose
// hello_ok listed the cap, and only ever with yes or no. A thread this daemon
// does not hold as a live Codex agent is a no.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS, canonicalArgsSha256 } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { Proc } from "../src/codex-attest.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

const busHomeWas = process.env.OA_BUS_HOME;
afterEach(async () => {
  await stopAll();
  if (busHomeWas === undefined) delete process.env.OA_BUS_HOME;
  else process.env.OA_BUS_HOME = busHomeWas;
});

const THREAD = "01a21556-f785-7a31-910c-93c82a660472";
const check = (id: string) => ({
  id,
  type: "codex_call_check",
  thread_id: THREAD,
  tool: "add_comment",
  mode: {
    kind: "code",
    call_id: "exec-2da5d7ac-8b68-4ace-9b71-9d784565958d",
    item_id: "ctc_0a184e09e62a8c41016b0782d6f34887d2b4b55804fc562763",
  },
});
const helloOk = (caps: string[]) => ({
  id: "w",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.0",
  caps,
});

describe("codex_call_check frame (#3108)", () => {
  it("is ignored without the cap, and answered no for a thread it does not hold", async () => {
    const h = await daemonHarness();
    h.toDaemon(helloOk([BUS_CAPS.ids]));
    h.toDaemon(check("c1"));
    // The hub then lists the cap: the same frame is answered, in order.
    h.toDaemon(helloOk([BUS_CAPS.ids, BUS_CAPS.codexCheck]));
    h.toDaemon(check("c2"));
    const answer = await h.next("codex_call_checked");
    expect(answer).toMatchObject({ re: "c2", ok: false });
    expect(h.of("codex_call_checked")).toHaveLength(1);
  });

  it("drops a frame that fails the schemas, and the next one is still answered", async () => {
    const h = await daemonHarness();
    h.toDaemon(helloOk([BUS_CAPS.ids, BUS_CAPS.codexCheck]));
    h.toDaemon({ ...check("c3"), thread_id: "../x" });
    h.toDaemon(check("c4"));
    await h.next("codex_call_checked");
    expect(h.of("codex_call_checked").map((f) => f.re)).toEqual(["c4"]);
  });
});

describe("codex_call_check frame, a live codex thread (#3108)", () => {
  const TURN = "01a21556-fd54-78d0-9030-d8530307128c";
  const ITEM = "ctc_0a184e09e62a8c41016b0782d6f34887d2b4b55804fc562763";
  const DIRECT = "call_5e7f7a8c9c46411dbfd830e0a0f962ee";
  const START = "Mon Jan 05 00:00:00 2026";
  const line = (type: string, payload: object) =>
    `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
  const turn = {
    internal_chat_message_metadata_passthrough: { turn_id: TURN },
  };
  const rollout =
    line("session_meta", {
      id: THREAD,
      cwd: "/work/project",
      source: "exec",
      thread_source: "user",
    }) +
    line("event_msg", { type: "task_started", turn_id: TURN }) +
    // The adapter's own call: what admits the thread (a hello).
    line("response_item", {
      type: "function_call",
      name: "self",
      namespace: "mcp__oa_bus",
      arguments: "{}",
      call_id: "call_1",
      ...turn,
    }) +
    // An open exec naming the instance entry's tool, and a direct call.
    line("response_item", {
      type: "custom_tool_call",
      id: ITEM,
      call_id: "call_exec1",
      name: "exec",
      input:
        'text(await tools.mcp__open_artifacts__add_comment({body:"hi"}))\n',
      ...turn,
    }) +
    line("response_item", {
      type: "function_call",
      name: "list_artifacts",
      namespace: "mcp__open_artifacts",
      arguments: '{"limit":5}',
      call_id: DIRECT,
      ...turn,
    });

  it("answers ok once for a code-mode call and for a direct call, then no for the same call again", async () => {
    const busHome = mkdtempSync(join(tmpdir(), "ob-cx3108-bus-"));
    process.env.OA_BUS_HOME = busHome;
    // A CODEX_HOME with the thread's lock and rollout.
    const home = mkdtempSync(join(tmpdir(), "ob-cx3108-home-"));
    mkdirSync(join(home, "thread-writer-locks"));
    writeFileSync(join(home, "thread-writer-locks", `${THREAD}.lock`), "");
    const day = join(home, "sessions", "2026", "11", "26");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-11-26T01-52-30-${THREAD}.jsonl`),
      rollout,
    );
    // P = 100 is codex and holds the lock; the adapter 200 is its child.
    const table: Record<number, Proc> = {
      100: { ppid: 1, start: START, comm: "/opt/codex/bin/codex" },
      200: { ppid: 100, start: START, comm: "node" },
    };
    const h = await daemonHarness({
      attest: undefined,
      codex: {
        home,
        retryMs: 0,
        procs: (pids: number[]) =>
          new Map(
            pids.flatMap((p) =>
              table[p] ? [[p, table[p] as Proc] as const] : [],
            ),
          ),
        holding: (pairs: { pid: number }[]) => pairs.map((x) => x.pid === 100),
      },
    });
    await h.adapter(
      THREAD,
      hello({
        kind: "codex",
        agent_ref: THREAD,
        pid: 200,
        cwd: "/work/project",
        codex: {
          thread_id: THREAD,
          call_id: "call_1",
          ppid: 100,
          thread_source: "user",
        },
      }),
    );
    expect(h.daemon.agents.byRef(THREAD)?.live).toBe(true);
    // What install recorded: the entry key, for the origin the daemon dials (http, though the daemon dials ws://).
    const port = (h.wss.address() as { port: number }).port;
    writeFileSync(
      join(busHome, "codex-oa-entries.json"),
      JSON.stringify({
        instances: [
          { origin: `http://127.0.0.1:${port}`, names: ["open-artifacts"] },
        ],
      }),
    );
    h.toDaemon(helloOk([BUS_CAPS.ids, BUS_CAPS.codexCheck]));
    const codeCall = "exec-2da5d7ac-8b68-4ace-9b71-9d784565958d";
    const code = (id: string) => ({
      ...check(id),
      mode: { kind: "code", call_id: codeCall, item_id: ITEM },
    });
    const direct = async (id: string) => ({
      ...check(id),
      tool: "list_artifacts",
      mode: {
        kind: "direct",
        call_id: DIRECT,
        args_sha256: await canonicalArgsSha256({ limit: 5 }),
      },
    });
    const answers = () =>
      h.of("codex_call_checked").map((f) => [f.re, f.ok] as const);
    h.toDaemon(code("k1"));
    await h.next("codex_call_checked", 1);
    h.toDaemon(await direct("d1"));
    await h.next("codex_call_checked", 2);
    // The same two calls again: each links once.
    h.toDaemon(code("k2"));
    h.toDaemon(await direct("d2"));
    await h.next("codex_call_checked", 4);
    expect(answers()).toEqual([
      ["k1", true],
      ["d1", true],
      ["k2", false],
      ["d2", false],
    ]);
  });
});
