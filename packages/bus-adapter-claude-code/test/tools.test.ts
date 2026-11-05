import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_VERSION,
  connectDaemon,
  type DaemonClient,
  excerptOf,
  Hello,
  receiptText,
  serveDaemon,
  unconfirmedText,
} from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, TOOLS } from "../src/tools.ts";

const client = (request: DaemonClient["request"]) =>
  ({ request }) as unknown as DaemonClient;

describe("claude mcp tools", () => {
  it("exposes the five vendor-neutral tools, and no card", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
      "set_status",
    ]);
    for (const t of TOOLS) expect(t.description).not.toMatch(/claude/i);
  });

  it("never takes the sender from tool arguments", async () => {
    const request = vi.fn(async (f: { id?: string }) => ({
      v: 1 as const,
      id: f.id ?? "1",
      type: "receipt" as const,
      msg_id: "mmmmmmmmmmmmmmm1",
      state: "pending" as const,
    }));
    const r = await callTool(
      "send_message",
      { to: "peer", text: "hi", from: "spoofed", from_ref: "B" },
      client(request),
    );
    // A tool call opts in to late-delivery notices.
    expect(request).toHaveBeenCalledWith({
      type: "send",
      to: "peer",
      body: "hi",
      late: true,
    });
    expect(r).toEqual({
      content: [
        {
          type: "text",
          text: "○  Queued for peer. Not delivered yet; expires in 1 hour.",
        },
      ],
      isError: false,
    });
  });

  it("reports a refusal with its reason", async () => {
    const r = await callTool(
      "send_message",
      { to: "peer", text: "hi" },
      client(async () => ({
        v: 1,
        id: "1",
        type: "receipt",
        msg_id: "mmmmmmmmmmmmmmm1",
        state: "refused",
        reason: "unknown_agent",
      })),
    );
    expect(r).toMatchObject({ isError: true });
    // The transcript's layout, from the one renderer, so it cannot drift.
    expect(r.content[0].text).toBe(
      receiptText(
        { state: "refused", reason: "unknown_agent" },
        "peer",
        undefined,
        excerptOf("hi"),
      ),
    );
    expect(r.content[0].text).toBe(
      '×  Refused (unknown_agent): your message to peer, "hi",\n   was not delivered.\n   No agent has that name here.\n   Run the oa_bus list_agents tool to see who is in this namespace.',
    );
  });

  it("forwards to_namespace as the target namespace", async () => {
    const request = vi.fn(async () => ({
      v: 1 as const,
      id: "1",
      type: "receipt" as const,
      msg_id: "mmmmmmmmmmmmmmm1",
      state: "pending" as const,
    }));
    await callTool(
      "send_message",
      { to: "peer", text: "hi", to_namespace: "github.com/acme/app" },
      client(request),
    );
    expect(request).toHaveBeenCalledWith({
      type: "send",
      to: "peer",
      body: "hi",
      namespace: "github.com/acme/app",
      late: true,
    });
    const send = TOOLS.find((t) => t.name === "send_message");
    expect(send?.inputSchema.properties).toHaveProperty("to_namespace");
  });

  it("names how many namespaces hold an ambiguous name", async () => {
    const roster = (name: string, namespace: string) => ({
      name,
      namespace,
      kind: "pi" as const,
      live: true,
      state: "live" as const,
      global: false,
    });
    const request = vi.fn(async (f: { type: string }) =>
      f.type === "send"
        ? {
            v: 1 as const,
            id: "1",
            type: "receipt" as const,
            msg_id: "mmmmmmmmmmmmmmm1",
            state: "refused" as const,
            reason: "ambiguous" as const,
          }
        : {
            v: 1 as const,
            id: "2",
            type: "roster" as const,
            agents: [
              roster("docs-writer", "a"),
              roster("docs-writer", "b"),
              roster("other", "c"),
            ],
          },
    );
    const r = await callTool(
      "send_message",
      { to: "docs-writer", text: "hi" },
      client(request as unknown as DaemonClient["request"]),
    );
    expect(r).toEqual({
      content: [
        {
          type: "text",
          text: receiptText(
            { state: "refused", reason: "ambiguous" },
            "docs-writer",
            2,
            excerptOf("hi"),
          ),
        },
      ],
      isError: true,
    });
  });

  it("lists the roster", async () => {
    const r = await callTool(
      "list_agents",
      {},
      client(async () => ({
        v: 1,
        id: "1",
        type: "roster",
        agents: [
          {
            name: "alpha",
            kind: "pi",
            namespace: "ns",
            live: true,
            state: "live",
            global: false,
          },
          {
            name: "beta",
            kind: "claude-code",
            namespace: "ns",
            live: false,
            state: "queued",
            global: false,
          },
        ],
      })),
    );
    expect(r.content[0].text).toBe(
      "- alpha (pi, ns)\n- beta (claude-code, ns) (queued)",
    );
  });

  it("shows the machine when the roster names one", async () => {
    const r = await callTool(
      "list_agents",
      {},
      client(async () => ({
        v: 1,
        id: "1",
        type: "roster",
        agents: [
          {
            name: "alpha",
            kind: "pi",
            namespace: "ns",
            live: true,
            state: "live",
            global: false,
            machine_label: "desktop",
          },
        ],
      })),
    );
    expect(r.content[0].text).toBe("- alpha (pi, ns, desktop)");
  });

  it("returns isError instead of throwing when the daemon is down", async () => {
    const r = await callTool(
      "list_agents",
      {},
      client(async () => {
        throw new Error("daemon connection closed");
      }),
    );
    expect(r).toEqual({
      content: [{ type: "text", text: "oa-bus: daemon connection closed" }],
      isError: true,
    });
  });

  it("answers an unknown tool or a daemon error as isError", async () => {
    const err = client(async () => ({
      v: 1,
      id: "1",
      type: "error",
      code: "hub_unavailable",
      message: "the hub is not connected",
    }));
    expect(await callTool("nope", {}, err)).toMatchObject({ isError: true });
    const r = await callTool("fetch", { msg_id: "mmmmmmmmmmmmmmm1" }, err);
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0].text).toMatch(/the hub is not connected/);
  });
});

describe("late deliveries (C17)", () => {
  const LATE =
    '✓  Delivered: your message to peer, "hi",\n   was delivered after all.';

  it("appends each after the result, separated by a blank line", async () => {
    const r = await callTool(
      "send_message",
      { to: "e0", text: "yo" },
      client(async () => ({
        v: 1,
        id: "1",
        type: "receipt",
        msg_id: "mmmmmmmmmmmmmmm1",
        state: "delivered",
        late: [LATE, LATE.replace("peer", "qa")],
      })),
    );
    expect(r.content).toEqual([
      {
        type: "text",
        text: `✓  Delivered to e0.\n\n${LATE}\n\n${LATE.replace("peer", "qa")}`,
      },
    ]);
  });

  it("rides on an error result, and is absent when there is none", async () => {
    const err = await callTool(
      "fetch",
      { msg_id: "m" },
      client(async () => ({
        v: 1,
        id: "1",
        type: "error",
        code: "not_found",
        message: "gone",
        late: [LATE],
      })),
    );
    expect(err).toEqual({
      content: [{ type: "text", text: `oa-bus: gone\n\n${LATE}` }],
      isError: true,
    });
    const plain = await callTool(
      "self",
      {},
      client(async () => ({
        v: 1,
        id: "1",
        type: "agent",
        agent: null,
      })),
    );
    expect(plain.content[0]?.text).toBe("null");
  });
});

describe("a cancelled tool call (C17)", () => {
  it("closes its daemon connection, so the daemon tells a refusal as a notice", async () => {
    const ac = new AbortController();
    const close = vi.fn();
    let answer: (f: unknown) => void = () => {};
    const c = {
      request: () => new Promise((r) => (answer = r)),
      close,
    } as unknown as DaemonClient;
    const out = callTool(
      "send_message",
      { to: "peer", text: "hi" },
      c,
      ac.signal,
    );
    expect(close).not.toHaveBeenCalled();
    ac.abort();
    expect(close).toHaveBeenCalledOnce();
    answer({ v: 1, id: "1", type: "receipt", msg_id: "m", state: "pending" });
    await out;
  });

  it("an already-cancelled call never opens a request", async () => {
    const ac = new AbortController();
    ac.abort();
    const request = vi.fn();
    const close = vi.fn();
    await callTool(
      "self",
      {},
      { request, close } as unknown as DaemonClient,
      ac.signal,
    );
    expect(request).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("a send the daemon gave up on mid-call (C16)", () => {
  it("shows the daemon's text verbatim: no prefix, not an error", async () => {
    const copy = unconfirmedText("e0", "yo");
    const r = await callTool(
      "send_message",
      { to: "e0", text: "yo" },
      client(async () => ({
        v: 1,
        id: "1",
        type: "receipt",
        msg_id: "fffffffffffffff1",
        state: "pending",
        held: true,
        text: copy,
      })),
    );
    expect(r.content).toEqual([{ type: "text", text: copy }]);
    expect(r.isError).toBeFalsy();
  });
});

describe("an unknown kind over the socket (C26h)", () => {
  const open: { close: () => unknown }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((o) => o.close()));
  });

  const row = (name: string, kind: string) => ({
    name,
    namespace: "ns",
    kind,
    live: true,
    state: "live" as const,
    global: false,
  });
  /** A daemon whose roster and self carry the made-up kind `zz`; a client with or without the IPC marker. */
  async function connected(marker: boolean) {
    const path = join(mkdtempSync(join(tmpdir(), "ob-kind-")), "d.sock");
    open.push(
      await serveDaemon({
        path,
        onHello: () => ({ bus_name: "me", namespace: "ns", global: false }),
        onFrame: (f) =>
          f.type === "list"
            ? { type: "roster", agents: [row("alpha", "zz"), row("b", "omp")] }
            : f.type === "self"
              ? { type: "agent", agent: row("me", "zz") }
              : undefined,
      }),
    );
    const c = await connectDaemon({
      path,
      hello: Hello.parse({
        v: 1,
        id: "h",
        type: "hello",
        kind: "claude-code",
        agent_ref: "s1",
        pid: process.pid,
        cwd: process.cwd(),
        attest: {},
        ...(marker ? { client_version: CLIENT_VERSION } : {}),
      }),
    });
    open.push(c);
    return c;
  }
  const say = async (c: DaemonClient, tool: string) =>
    (await callTool(tool, {}, c)).content[0]?.text;

  it("list_agents and self show zz unchanged", async () => {
    const c = await connected(true);
    expect(await say(c, "list_agents")).toBe("- alpha (zz, ns)\n- b (omp, ns)");
    expect(JSON.parse((await say(c, "self")) ?? "").kind).toBe("zz");
  });
});
