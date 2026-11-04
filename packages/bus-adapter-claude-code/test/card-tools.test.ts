// AC5b: set_status and card in the shared MCP tools (Claude Code, OpenCode, Codex).
import {
  CARD_COPY,
  type DaemonClient,
  type DaemonFrame,
  earlierStatusText,
  statusLabelTooLong,
  statusSetText,
} from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, TOOLS } from "../src/tools.ts";

const JWS = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const NONCE = "n0nce-n0nce-n0nce";
const AUD = "https://artifacts.example.com";

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

const ok = (f: Frame) =>
  f.type === "set_status" ? { type: "status_set" } : { type: "card", jwt: JWS };

const call = (
  name: string,
  args: Record<string, unknown>,
  d: ReturnType<typeof daemon>,
) => callTool(name, args, d.client);

describe("set_status and card: shapes", () => {
  it("adds both tools after the four, vendor-neutral", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
      "set_status",
      "card",
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

  it("card: audience and nonce, only for an app the user linked", () => {
    const t = TOOLS.find((x) => x.name === "card");
    expect(t?.inputSchema).toMatchObject({
      properties: {
        audience: { type: "string" },
        nonce: { type: "string" },
      },
      required: ["audience", "nonce"],
      additionalProperties: false,
    });
    expect(t?.description).toMatch(/only for that/);
    expect(t?.description).toMatch(/Open Artifacts/);
    expect(t?.description).toMatch(/present_card/);
  });
});

describe("set_status and card: the gate is the daemon's reply", () => {
  it.each([
    ["set_status", { state: "working" }],
    ["card", { audience: AUD, nonce: NONCE }],
  ])("%s at the gate is one request, no self", async (name, args) => {
    const d = daemon(ok);
    const r = await call(name, args, d);
    expect(r.isError).toBe(false);
    expect(d.frames.map((f) => f.type)).toEqual([name]);
  });

  it.each([
    ["set_status", { state: "working" }],
    ["card", { audience: AUD, nonce: NONCE }],
  ])(
    "%s below the gate: the daemon's unsupported refusal, as-is",
    async (name, args) => {
      const d = daemon(() => ({
        type: "error",
        code: "unsupported",
        message: CARD_COPY.unsupported,
      }));
      expect(await call(name, args, d)).toEqual({
        content: [{ type: "text", text: CARD_COPY.unsupported }],
        isError: true,
      });
    },
  );

  it("a daemon from before AC5a refuses the unknown type: the unsupported copy", async () => {
    const d = daemon(() => ({
      type: "error",
      code: "bad_frame",
      message: "Invalid input",
    }));
    for (const [name, args] of [
      ["set_status", { state: "working" }],
      ["card", { audience: AUD, nonce: NONCE }],
    ] as const)
      expect(await call(name, args, d)).toEqual({
        content: [{ type: "text", text: CARD_COPY.unsupported }],
        isError: true,
      });
  });

  it("the hub's bad_frame (AC5a's copy) stays as-is", async () => {
    const d = daemon(() => ({
      type: "error",
      code: "bad_frame",
      message: CARD_COPY.bad_frame,
    }));
    expect(
      (await call("card", { audience: AUD, nonce: NONCE }, d)).content[0]?.text,
    ).toBe(CARD_COPY.bad_frame);
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
      earlier: { code: "not_registered", message: CARD_COPY.not_registered },
    }));
    const r = await call("set_status", { state: "blocked" }, d);
    expect(r.isError).toBe(false);
    expect(r.content[0]?.text).toBe(
      `${statusSetText("blocked")}\n\n${earlierStatusText(CARD_COPY.not_registered)}`,
    );
    expect(earlierStatusText("X")).toBe(
      "Your previous status did not reach the user. X",
    );
  });

  it.each(["rate_limited", "not_registered", "bad_frame", "unsupported"])(
    "a %s refusal is the daemon's copy, as-is",
    async (code) => {
      const message = CARD_COPY[code as keyof typeof CARD_COPY];
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

describe("card", () => {
  it("sends audience as aud with the nonce, and returns the JWS alone", async () => {
    const d = daemon(ok);
    const r = await call("card", { audience: AUD, nonce: NONCE }, d);
    expect(d.frames[0]).toEqual({
      type: "card",
      aud: AUD,
      nonce: NONCE,
      late: true,
    });
    expect(r).toEqual({
      content: [{ type: "text", text: JWS }],
      isError: false,
    });
  });

  it.each(Object.keys(CARD_COPY))(
    "a %s refusal is the daemon's copy, as-is",
    async (code) => {
      const message = CARD_COPY[code as keyof typeof CARD_COPY];
      const d = daemon(() => ({ type: "error", code, message }));
      expect(await call("card", { audience: AUD, nonce: NONCE }, d)).toEqual({
        content: [{ type: "text", text: message }],
        isError: true,
      });
    },
  );

  it("a nonce that cannot be one is bad_nonce, before the daemon", async () => {
    const d = daemon(ok);
    expect(await call("card", { audience: AUD, nonce: "short" }, d)).toEqual({
      content: [{ type: "text", text: CARD_COPY.bad_nonce }],
      isError: true,
    });
    expect(d.frames).toEqual([]);
  });

  it.each(["http://artifacts.example.com", "https://a.example.com/path", ""])(
    "an audience that is not an exact https origin is refused before the daemon: %j",
    async (audience) => {
      const d = daemon(ok);
      const r = await call("card", { audience, nonce: NONCE }, d);
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/^oa-bus: aud: /);
      expect(d.frames).toEqual([]);
    },
  );

  it("a daemon that is down is a tool error, not a throw", async () => {
    const request = vi.fn(async () => {
      throw new Error("the daemon connection closed");
    });
    const r = await callTool("card", { audience: AUD, nonce: NONCE }, {
      request,
    } as unknown as DaemonClient);
    expect(r).toEqual({
      content: [
        { type: "text", text: "oa-bus: the daemon connection closed" },
      ],
      isError: true,
    });
  });
});

describe("the card's JWS is never logged", () => {
  afterEach(() => vi.restoreAllMocks());

  it("nothing the adapter writes to the console or stderr holds it", async () => {
    const written: string[] = [];
    const keep = (...a: unknown[]) => {
      written.push(a.map(String).join(" "));
    };
    for (const m of ["log", "error", "warn", "info", "debug"] as const)
      vi.spyOn(console, m).mockImplementation(keep);
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      keep(c);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      keep(c);
      return true;
    });
    const r = await call("card", { audience: AUD, nonce: NONCE }, daemon(ok));
    expect(r.content[0]?.text).toBe(JWS);
    const parts = JWS.split(".");
    for (const w of written) for (const p of parts) expect(w).not.toContain(p);
  });
});
