// set_status in the shared MCP tools (Claude Code, OpenCode, Codex). The agent card is gone.
import {
  type DaemonClient,
  type DaemonFrame,
  STATUS_COPY,
  earlierStatusText,
  statusLabelTooLong,
  statusSetText,
} from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, TOOLS } from "../src/tools.ts";


type Frame = { type: string } & Record<string, unknown>;

/** A daemon that answers every frame with `answer`, recording them. */
function daemon(answer: (f: Frame) => Record<string, unknown>) {
  const frames: Frame[] = [];
  const request = vi.fn(async (f: Frame) => {
    frames.push(f);
    return { v: 1, id: "1", ...answer(f) } as DaemonFrame;
  });
  return { frames, client: { request } as unknown as DaemonClient };
}

const ok = (_f: Frame) => ({ type: "status_set" });

const call = (
  name: string,
  args: Record<string, unknown>,
  d: ReturnType<typeof daemon>,
) => callTool(name, args, d.client);

describe("set_status: shape", () => {
  it("adds set_status after the four, vendor-neutral, and no card tool", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
      "set_status",
    ]);
    for (const t of TOOLS) expect(t.description).not.toMatch(/claude/i);
  });

  it("set_status: one of four states and an optional label of at most 64", () => {
    const t = TOOLS.find((x) => x.name === "set_status");
    expect(t?.inputSchema).toEqual({
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["working", "idle", "blocked", "waiting_on_owner"],
        },
        label: {
          type: "string",
          maxLength: 64,
          description: "What you are on, in a few words.",
        },
      },
      required: ["state"],
      additionalProperties: false,
    });
    expect(t?.description).toMatch(/user sees it labelled as your own report/);
  });

});

describe("set_status: one request", () => {
  it("is one request, no self", async () => {
    const d = daemon(ok);
    const r = await call("set_status", { state: "working" }, d);
    expect(r.isError).toBe(false);
    expect(d.frames.map((f) => f.type)).toEqual(["set_status"]);
  });

  it("a daemon's bad_frame shows the bad_frame copy", async () => {
    const d = daemon(() => ({
      type: "error",
      code: "bad_frame",
      message: "Invalid input",
    }));
    expect(
      (await call("set_status", { state: "working" }, d)).content[0]?.text,
    ).toBe(STATUS_COPY.bad_frame);
  });
});

describe("set_status", () => {
  it("sends the state and label, opted in to late notices, and says what the user sees", async () => {
    const d = daemon(ok);
    const r = await call(
      "set_status",
      { state: "working", label: "writing tests", from: "spoofed" },
      d,
    );
    expect(d.frames[0]).toEqual({
      type: "set_status",
      state: "working",
      label: "writing tests",
      late: true,
    });
    expect(r).toEqual({
      content: [
        { type: "text", text: statusSetText("working", "writing tests") },
      ],
      isError: false,
    });
    expect(r.content[0]?.text).toBe(
      'Your status is now working: "writing tests". The user sees it as your own report.',
    );
  });

  it("shows the state as its raw token (Design)", async () => {
    const r = await call(
      "set_status",
      { state: "waiting_on_owner", label: "your review" },
      daemon(ok),
    );
    expect(r.content[0]?.text).toBe(
      'Your status is now waiting_on_owner: "your review". The user sees it as your own report.',
    );
  });

  it("an empty label is no label", async () => {
    const d = daemon(ok);
    const r = await call("set_status", { state: "idle", label: "" }, d);
    expect(d.frames[0]).toEqual({
      type: "set_status",
      state: "idle",
      late: true,
    });
    expect(r.content[0]?.text).toBe(
      "Your status is now idle. The user sees it as your own report.",
    );
  });

  it("shows an earlier refusal after this call's result", async () => {
    const d = daemon(() => ({
      type: "status_set",
      earlier: { code: "not_registered", message: STATUS_COPY.not_registered },
    }));
    const r = await call("set_status", { state: "blocked" }, d);
    expect(r.isError).toBe(false);
    expect(r.content[0]?.text).toBe(
      `${statusSetText("blocked")}\n\n${earlierStatusText(STATUS_COPY.not_registered)}`,
    );
    expect(earlierStatusText("X")).toBe(
      "Your previous status did not reach the user. X",
    );
  });

  it.each(["rate_limited", "not_registered", "bad_frame", "unsupported"])(
    "a %s refusal is the daemon's copy, as-is",
    async (code) => {
      const message = STATUS_COPY[code as keyof typeof STATUS_COPY];
      const d = daemon(() => ({ type: "error", code, message }));
      expect(await call("set_status", { state: "idle" }, d)).toEqual({
        content: [{ type: "text", text: message }],
        isError: true,
      });
    },
  );

  it.each([
    [{ state: "sleeping" }, /^oa-bus: state: /],
    [{}, /^oa-bus: state: /],
  ])("refuses bad arguments before the daemon: %j", async (args, msg) => {
    const d = daemon(ok);
    const r = await call("set_status", args, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(msg);
    expect(d.frames).toEqual([]);
  });

  it.each([
    ["  writing tests  ", "writing tests"],
    ["writing\n\ttests\r\n", "writing tests"],
    ["writing\u202e tests\u200b", "writing tests"],
    ["\u00a0lane\u00a06 ", "lane 6"],
  ])("cleans the label as a machine label: %j", async (label, sent) => {
    const d = daemon(ok);
    const r = await call("set_status", { state: "working", label }, d);
    expect(d.frames[0]).toEqual({
      type: "set_status",
      state: "working",
      label: sent,
      late: true,
    });
    expect(r.content[0]?.text).toBe(statusSetText("working", sent));
  });

  it.each([" ", "\n\t", "\u200b\u202e"])(
    "a label with nothing left is no label: %j",
    async (label) => {
      const d = daemon(ok);
      await call("set_status", { state: "idle", label }, d);
      expect(d.frames[0]).toEqual({
        type: "set_status",
        state: "idle",
        late: true,
      });
    },
  );

  it("a label over 64 once cleaned is refused as a status label, before the daemon", async () => {
    const d = daemon(ok);
    const r = await call(
      "set_status",
      { state: "idle", label: `  ${"é".repeat(65)} ` },
      d,
    );
    expect(r).toEqual({
      content: [{ type: "text", text: statusLabelTooLong(65) }],
      isError: true,
    });
    // Design's line, verbatim; N is the cleaned length in code points.
    expect(r.content[0]?.text).toBe(
      "oa-bus: that label is 65 characters, and the limit is 64. Your status did not change. Send a shorter one.",
    );
    expect(d.frames).toEqual([]);
    // Spaces that cleaning removes do not count.
    const ok64 = await call(
      "set_status",
      { state: "idle", label: ` ${"x".repeat(64)}\n` },
      d,
    );
    expect(ok64.isError).toBe(false);
  });

  it("a 64-character label passes", async () => {
    const d = daemon(ok);
    const r = await call(
      "set_status",
      { state: "idle", label: "é".repeat(64) },
      d,
    );
    expect(r.isError).toBe(false);
  });
});
