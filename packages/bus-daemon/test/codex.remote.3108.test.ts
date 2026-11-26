// #3108: a call the server saw at /mcp from a Codex entry that signs in by
// itself (OAuth) is linked when the daemon finds it open in a live Codex
// thread. The rollout lines have the shapes of the capture of codex-cli 0.171
// (HTTP entry, code mode): task_started, a custom_tool_call `exec` with an
// item id, an item_completed per call (id `exec-<uuid>`), then the exec's
// custom_tool_call_output. Fixtures are built in a temp CODEX_HOME; no clock.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArgsSha256 } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_OA_ENTRIES_FILE,
  type CodexAttestDeps,
  codexAttestor,
  codexEntryNamespace,
  codexOaEntries,
  instanceOrigin,
  type Proc,
} from "../src/codex-attest.ts";

const THREAD = "01a21556-f785-7a31-910c-93c82a660472";
const TURN = "01a21556-fd54-78d0-9030-d8530307128c";
const ITEM = "ctc_0a184e09e62a8c41016b0782d6f34887d2b4b55804fc562763";
const EXEC_CALL = "exec-2da5d7ac-8b68-4ace-9b71-9d784565958d";
const DIRECT = "call_5e7f7a8c9c46411dbfd830e0a0f962ee";
const NS = "mcp__open_artifacts";
const START = "Mon Jan 05 00:00:00 2026";
const PID = 100;

const line = (type: string, payload: object) =>
  `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
const meta = (over: object = {}) =>
  line("session_meta", {
    id: THREAD,
    cwd: "/work/project",
    source: "exec",
    thread_source: "user",
    ...over,
  });
const started = (turn = TURN) =>
  line("event_msg", { type: "task_started", turn_id: turn });
const execCall = (input: string, item = ITEM, call = "call_exec1") =>
  line("response_item", {
    type: "custom_tool_call",
    id: item,
    status: "completed",
    call_id: call,
    name: "exec",
    input,
    internal_chat_message_metadata_passthrough: { turn_id: TURN },
  });
const execOutput = (call = "call_exec1") =>
  line("response_item", {
    type: "custom_tool_call_output",
    id: "ctco_1",
    call_id: call,
    output: [],
  });
const mcpDone = (id: string) =>
  line("event_msg", {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: TURN,
    item: { type: "McpToolCall", id, server: "open_artifacts", tool: "x" },
  });
const fnCall = (
  call_id: string,
  args: string,
  name = "add_comment",
  namespace: string | null = NS,
) =>
  line("response_item", {
    type: "function_call",
    id: "fc_1",
    name,
    ...(namespace === null ? {} : { namespace }),
    arguments: args,
    call_id,
    internal_chat_message_metadata_passthrough: { turn_id: TURN },
  });
const fnOutput = (call_id: string) =>
  line("response_item", { type: "function_call_output", call_id, output: [] });

/** The nth distinct exec call id. */
const execId = (n: number) =>
  `exec-00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;

function setup(rollout: string, over: Partial<CodexAttestDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "ob-cx3108-"));
  mkdirSync(join(home, "thread-writer-locks"));
  writeFileSync(join(home, "thread-writer-locks", `${THREAD}.lock`), "");
  const day = join(home, "sessions", "2026", "11", "26");
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-11-26T01-52-30-${THREAD}.jsonl`);
  writeFileSync(file, rollout);
  const procs = vi.fn(
    (pids: number[]) =>
      new Map<number, Proc>(
        pids.includes(PID)
          ? [[PID, { ppid: 1, start: START, comm: "/opt/codex/bin/codex" }]]
          : [],
      ),
  );
  const holding = vi.fn((pairs: { pid: number; file: string }[]) =>
    pairs.map(({ pid }) => pid === PID),
  );
  const check = codexAttestor({
    home,
    procs,
    holding,
    retryMs: 0,
    sleep: async () => {},
    ...over,
  });
  return { home, file, check, procs, holding };
}

type Mode =
  | { kind: "direct"; call_id: string; args_sha256: string }
  | { kind: "code"; call_id: string; item_id: string };
const frame = (mode: Mode, tool = "add_comment", thread_id = THREAD) => ({
  v: 1,
  id: "f1",
  type: "codex_call_check",
  thread_id,
  tool,
  mode,
});
const direct = async (args: unknown, call_id = DIRECT): Promise<Mode> => ({
  kind: "direct",
  call_id,
  args_sha256: (await canonicalArgsSha256(args)) as string,
});
const code = (call_id = EXEC_CALL, item_id = ITEM): Mode => ({
  kind: "code",
  call_id,
  item_id,
});
const run = (
  s: ReturnType<typeof setup>,
  f: unknown,
  namespaces: readonly string[] = [NS],
  pid = PID,
) => s.check.remote(f, { pid, namespaces });

const SCRIPT = `text(await tools.${NS}__add_comment({ body: "hi" }))\n`;

describe("codex remote call check (#3108), direct mode", () => {
  const rollout = (args = '{"b":2,"a":"x"}') =>
    meta() + started() + fnCall(DIRECT, args);

  it("links an unanswered call whose tool and canonical args match", async () => {
    const s = setup(rollout());
    // Key order differs from the rollout text: the hash is canonical.
    expect(await run(s, frame(await direct({ a: "x", b: 2 })))).toEqual({
      ns: NS,
    });
  });

  it("links a call written with the namespace in its name", async () => {
    const s = setup(
      meta() + started() + fnCall(DIRECT, "{}", `${NS}__add_comment`, null),
    );
    expect(await run(s, frame(await direct({})))).toEqual({ ns: NS });
  });

  it("refuses a different args hash", async () => {
    const s = setup(rollout());
    expect(await run(s, frame(await direct({ a: "x", b: 3 })))).toBe(false);
  });

  it("refuses another tool name", async () => {
    const s = setup(rollout());
    expect(
      await run(s, frame(await direct({ a: "x", b: 2 }), "delete_artifact")),
    ).toBe(false);
  });

  it("refuses a call under another namespace", async () => {
    const s = setup(rollout());
    expect(
      await run(s, frame(await direct({ a: "x", b: 2 })), ["mcp__elsewhere"]),
    ).toBe(false);
  });

  it("refuses a call already answered", async () => {
    const s = setup(rollout() + fnOutput(DIRECT));
    expect(await run(s, frame(await direct({ a: "x", b: 2 })))).toBe(false);
  });

  it("refuses arguments that are not JSON", async () => {
    const s = setup(rollout("{nope"));
    expect(await run(s, frame(await direct({})))).toBe(false);
  });

  it("links a call once", async () => {
    const s = setup(rollout());
    const f = frame(await direct({ a: "x", b: 2 }));
    expect(await run(s, f)).toEqual({ ns: NS });
    expect(await run(s, f)).toBe(false);
  });

  it("two checks at once for one call link once", async () => {
    const s = setup(rollout());
    const f = frame(await direct({ a: "x", b: 2 }));
    const both = await Promise.all([run(s, f), run(s, f)]);
    expect(both.filter((r) => r !== false)).toHaveLength(1);
  });
});

describe("codex remote call check (#3108), code mode", () => {
  const open = () => meta() + started() + execCall(SCRIPT);

  it("links a call of an open exec in the latest turn whose script names the tool", async () => {
    const s = setup(open());
    expect(await run(s, frame(code()))).toEqual({ ns: NS });
  });

  it("refuses once the call's item_completed is in the rollout", async () => {
    const s = setup(open() + mcpDone(EXEC_CALL));
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("refuses once the exec has its output", async () => {
    const s = setup(open() + execOutput());
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("refuses an exec of an earlier turn", async () => {
    const s = setup(open() + started("01a21556-aaaa-78d0-9030-d8530307128c"));
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("refuses a dynamic lookup with no literal name", async () => {
    const s = setup(
      meta() +
        started() +
        execCall(`const n = "add_comment"; await tools[NS + n]({})\n`),
    );
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("refuses a script that names another tool, or only a longer name", async () => {
    const s = setup(
      meta() + started() + execCall(`await tools.${NS}__add_comment_all({})\n`),
    );
    expect(await run(s, frame(code()))).toBe(false);
    const t = setup(
      meta() + started() + execCall(`await tools.${NS}__list_artifacts({})\n`),
    );
    expect(await run(t, frame(code()))).toBe(false);
  });

  it("refuses an item that is not in the rollout", async () => {
    const s = setup(open());
    expect(await run(s, frame(code(EXEC_CALL, `ctc_${"ab".repeat(12)}`)))).toBe(
      false,
    );
  });

  it("links a call id once", async () => {
    const s = setup(open());
    expect(await run(s, frame(code()))).toEqual({ ns: NS });
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("links at most 50 calls of one exec", async () => {
    const s = setup(open());
    for (let n = 1; n <= 50; n++)
      expect(await run(s, frame(code(execId(n))))).toEqual({ ns: NS });
    expect(await run(s, frame(code(execId(51))))).toBe(false);
  });
});

describe("codex remote call check (#3108), hostile input and the thread", () => {
  const hostile: [string, unknown][] = [
    ["a path in the thread id", frame(code(), "add_comment", "../x")],
    [
      "an overlong thread id",
      frame(code(), "add_comment", `${THREAD}${"0".repeat(500)}`),
    ],
    ["a thread id with a slash", frame(code(), "add_comment", `${THREAD}/..`)],
    ["a path as the tool", frame(code(), "../add_comment")],
    ["an overlong tool", frame(code(), `a${"b".repeat(200)}`)],
    ["an exec call id with a path", frame(code("exec-../../x"))],
    ["an overlong item id", frame(code(EXEC_CALL, `ctc_${"a".repeat(500)}`))],
    [
      "a direct call id with a path",
      frame({
        kind: "direct",
        call_id: "call_../x",
        args_sha256: "0".repeat(64),
      }),
    ],
    [
      "a short hash",
      frame({
        kind: "direct",
        call_id: DIRECT,
        args_sha256: "abc",
      }),
    ],
    ["an unknown mode", { ...frame(code()), mode: { kind: "other" } }],
    ["no mode", { ...frame(code()), mode: undefined }],
    ["not an object", "codex_call_check"],
    ["null", null],
  ];
  for (const [what, f] of hostile)
    it(`rejects ${what} before any process or file access`, async () => {
      const s = setup(meta() + started() + execCall(SCRIPT));
      expect(await run(s, f)).toBe(false);
      expect(s.procs).not.toHaveBeenCalled();
      expect(s.holding).not.toHaveBeenCalled();
    });

  it("refuses with no namespaces, before any access", async () => {
    const s = setup(meta() + started() + execCall(SCRIPT));
    expect(await run(s, frame(code()), [])).toBe(false);
    expect(s.procs).not.toHaveBeenCalled();
  });

  it("refuses a subagent thread", async () => {
    const s = setup(
      meta({ source: { subagent: "review" }, thread_source: "subagent" }) +
        started() +
        execCall(SCRIPT),
    );
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("refuses when no live codex holds the thread's lock", async () => {
    const s = setup(meta() + started() + execCall(SCRIPT), {
      holding: () => [false],
    });
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("refuses when the process is not codex, or is gone", async () => {
    const s = setup(meta() + started() + execCall(SCRIPT), {
      procs: (pids) =>
        new Map(
          pids.map((p) => [
            p,
            { ppid: 1, start: START, comm: "/bin/zsh" } satisfies Proc,
          ]),
        ),
    });
    expect(await run(s, frame(code()))).toBe(false);
    const t = setup(meta() + started() + execCall(SCRIPT), {
      procs: () => new Map(),
    });
    expect(await run(t, frame(code()))).toBe(false);
    const u = setup(meta() + started() + execCall(SCRIPT), {
      procs: () => undefined,
    });
    expect(await run(u, frame(code()))).toBe(false);
  });

  it("refuses a call written before the process started", async () => {
    const s = setup(meta() + started() + execCall(SCRIPT), {
      procs: (pids) =>
        new Map(
          pids.map((p) => [
            p,
            {
              ppid: 1,
              start: "Fri Dec 31 00:00:00 2100",
              comm: "/opt/codex/bin/codex",
            } satisfies Proc,
          ]),
        ),
    });
    expect(await run(s, frame(code()))).toBe(false);
  });

  it("refuses a thread with no rollout", async () => {
    const s = setup("");
    const other = "01a21556-0000-7a31-910c-93c82a660472";
    writeFileSync(join(s.home, "thread-writer-locks", `${other}.lock`), "");
    expect(await run(s, frame(code(), "add_comment", other))).toBe(false);
  });
});

describe("the recorded entries the daemon reads (#3108)", () => {
  const write = (v: unknown) => {
    const home = mkdtempSync(join(tmpdir(), "ob-cx3108-e-"));
    writeFileSync(
      join(home, CODEX_OA_ENTRIES_FILE),
      typeof v === "string" ? v : JSON.stringify(v),
    );
    return home;
  };
  it("lists the names for the instance's origin only", () => {
    const home = write({
      instances: [
        { origin: "https://a.test", names: ["open-artifacts", "second"] },
        { origin: "https://b.test", names: ["other"] },
      ],
    });
    expect(codexOaEntries(home, "https://a.test")).toEqual([
      "open-artifacts",
      "second",
    ]);
    expect(codexOaEntries(home, "https://c.test")).toEqual([]);
  });
  it("is empty for a missing, broken or odd file", () => {
    expect(
      codexOaEntries(mkdtempSync(join(tmpdir(), "ob-cx3108-m-")), "x"),
    ).toEqual([]);
    expect(codexOaEntries(write("{nope"), "x")).toEqual([]);
    expect(
      codexOaEntries(write({ instances: [{ origin: "x", names: [1] }] }), "x"),
    ).toEqual([]);
  });
  it("reads a ws or wss hub as the http or https origin install records", () => {
    expect(instanceOrigin("wss://h")).toBe("https://h");
    expect(instanceOrigin("wss://h:8443/hub")).toBe("https://h:8443");
    expect(instanceOrigin("ws://127.0.0.1:5")).toBe("http://127.0.0.1:5");
    expect(instanceOrigin("https://h/")).toBe("https://h");
    const home = write({
      instances: [{ origin: "https://h", names: ["open-artifacts"] }],
    });
    expect(codexOaEntries(home, instanceOrigin("wss://h"))).toEqual([
      "open-artifacts",
    ]);
  });
  it("names the tool namespace as Codex does", () => {
    expect(codexEntryNamespace("open-artifacts")).toBe(NS);
  });
});
