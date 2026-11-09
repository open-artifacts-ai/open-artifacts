// #1317 step 2: follow, unfollow and following from an adapter. The agent is
// the connection's attested one (the frame names none); the hub gets the
// frame only when its hello_ok listed `follow`; the adapter must have listed
// the cap. Waits are signals (a frame arriving), never sleeps.
import { ADAPTER_CAPS, type Hello } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTable } from "../src/agents.ts";
import { Pending, type RouteCtx, routeLocal } from "../src/routes.ts";

const hello = (caps?: string[], kind = "claude-code"): Hello =>
  ({
    v: 1,
    id: "hello",
    type: "hello",
    kind,
    agent_ref: "A",
    pid: 1,
    attest: {},
    ...(caps ? { caps } : {}),
  }) as unknown as Hello;

const setup = (support: "ok" | "old_hub" | "down" = "ok") => {
  const agents = new AgentTable();
  agents.up({
    ref: "A",
    kind: "claude-code",
    proposedName: "a",
    busName: "a",
    namespace: "ns",
    global: false,
    pid: 1,
    cwd: "/x",
    live: true,
  });
  const sent: Record<string, unknown>[] = [];
  const replies: Record<string, unknown>[] = [];
  const pending = new Pending();
  const ctx = {
    agents,
    pending,
    hub: {
      send: (f: Record<string, unknown>) => {
        sent.push(f);
        return true;
      },
    },
    followSupport: () => support,
  } as unknown as RouteCtx;
  const route = (
    frame: Record<string, unknown>,
    h = hello([ADAPTER_CAPS.follow]),
  ) =>
    routeLocal(
      { v: 1, id: "7", ...frame } as never,
      h,
      (f) => replies.push(f as never) > 0,
      ctx,
    );
  return { route, sent, replies, pending };
};

describe("follow frames in routeLocal", () => {
  it("forwards each as the attested agent, never an address from the frame", () => {
    const c = setup();
    expect(c.route({ type: "follow", artifact: "abc" })).toBeUndefined();
    expect(c.route({ type: "unfollow", artifact: "abc" })).toBeUndefined();
    expect(c.route({ type: "following" })).toBeUndefined();
    expect(c.sent.map(({ id: _i, ...f }) => f)).toEqual([
      { v: 1, type: "follow", from_ref: "A", artifact: "abc" },
      { v: 1, type: "unfollow", from_ref: "A", artifact: "abc" },
      { v: 1, type: "following", from_ref: "A" },
    ]);
    // Extra fields on the adapter frame never reach the hub wire.
    const d = setup();
    d.route({
      type: "follow",
      artifact: "abc",
      from_ref: "B",
      name: "other",
      namespace: "other-ns",
    });
    expect(d.sent[0]).not.toHaveProperty("name");
    expect(d.sent[0]).not.toHaveProperty("namespace");
    expect(d.sent[0]).toMatchObject({ from_ref: "A" });
  });

  it("the hub's answer returns under the adapter's own frame id", () => {
    const c = setup();
    c.route({ type: "follow", artifact: "abc" });
    const hubId = String(c.sent[0]?.id);
    expect(
      c.pending.settle({
        v: 1,
        id: hubId,
        type: "followed",
        artifact_id: "abc",
        url: "https://x.test/a/abc",
        followed_at: "2026-11-09T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(c.replies[0]).toMatchObject({ id: "7", type: "followed" });
  });

  it("is refused for an adapter that did not list the cap, and sends nothing", () => {
    for (const caps of [undefined, ["mailbox", "pending"]]) {
      const c = setup();
      expect(
        c.route({ type: "follow", artifact: "abc" }, hello(caps)),
      ).toMatchObject({
        type: "error",
        code: "bad_frame",
      });
      expect(c.sent).toEqual([]);
    }
  });

  it("says why when the hub is old or not connected, and sends nothing", () => {
    const old = setup("old_hub");
    expect(old.route({ type: "following" })).toMatchObject({
      type: "error",
      code: "unsupported",
    });
    const down = setup("down");
    expect(down.route({ type: "following" })).toMatchObject({
      type: "error",
      code: "hub_unavailable",
    });
    expect(old.sent).toEqual([]);
    expect(down.sent).toEqual([]);
  });

  it("refuses an artifact the hub's decoder would refuse", () => {
    const c = setup();
    expect(
      c.route({ type: "follow", artifact: "x".repeat(2049) }),
    ).toMatchObject({
      type: "error",
      code: "bad_frame",
    });
    expect(c.sent).toEqual([]);
  });
});

// The daemon end to end, over its real socket and a fake hub.
describe("follow through the daemon", () => {
  const socks: { destroy(): void }[] = [];
  afterEach(async () => {
    for (const s of socks.splice(0)) s.destroy();
    const { stopAll } = await import("./helpers.ts");
    await stopAll();
  });

  async function up(hubCaps: string[], adapterCaps: string[]) {
    const { daemonHarness, hello: mk } = await import("./helpers.ts");
    const { connect } = await import("node:net");
    const h = await daemonHarness({ claude: { syncMs: 20 } });
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: hubCaps,
    } as never);
    const sock = connect(h.socketPath);
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    sock.on("error", () => {});
    socks.push(sock);
    sock.write(
      `${JSON.stringify({ ...mk({ kind: "pi", agent_ref: "P1", proposed_name: "first" }), caps: adapterCaps })}\n`,
    );
    await vi.waitFor(() =>
      expect(lines.some((l) => l.type === "welcome")).toBe(true),
    );
    await vi.waitFor(() => expect(h.of("agent_up")).toHaveLength(1));
    const send = (f: Record<string, unknown>) =>
      sock.write(`${JSON.stringify({ v: 1, ...f })}\n`);
    return { h, lines, send };
  }

  it("welcome lists follow only to an adapter that listed it", async () => {
    const a = await up([BUS_CAPS.follow], [ADAPTER_CAPS.follow]);
    expect(a.lines.find((l) => l.type === "welcome")?.caps).toEqual(["follow"]);
    const b = await up([BUS_CAPS.follow], ["mailbox"]);
    expect(b.lines.find((l) => l.type === "welcome")).not.toHaveProperty(
      "caps",
    );
  });

  it("a follow reaches a hub that lists the cap as the session's agent, and its answer comes back", async () => {
    const c = await up([BUS_CAPS.follow], [ADAPTER_CAPS.follow]);
    c.send({ id: "f1", type: "follow", artifact: "abc" });
    await vi.waitFor(() => expect(c.h.of("follow")).toHaveLength(1));
    const f = c.h.of("follow")[0] as unknown as { id: string };
    expect(f).toMatchObject({ from_ref: "P1", artifact: "abc" });
    c.h.toDaemon({
      v: 1,
      id: f.id,
      type: "error",
      code: "follow_limit",
      message: "At most 200 follows per member; unfollow one first",
    } as never);
    await vi.waitFor(() =>
      expect(c.lines.find((l) => l.id === "f1")).toMatchObject({
        type: "error",
        code: "follow_limit",
      }),
    );
  });

  it("a hub that does not list the cap gets no frame; the adapter is told", async () => {
    const c = await up(["ids", "mailbox"], [ADAPTER_CAPS.follow]);
    c.send({ id: "f1", type: "following" });
    await vi.waitFor(() =>
      expect(c.lines.find((l) => l.id === "f1")).toMatchObject({
        type: "error",
        code: "unsupported",
      }),
    );
    expect(c.h.of("following")).toHaveLength(0);
  });
});
