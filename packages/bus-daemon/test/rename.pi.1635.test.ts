import { ADAPTER_CAPS, type Hello } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentTable } from "../src/agents.ts";
import { Pending, type RouteCtx, routeLocal } from "../src/routes.ts";

const hello = (caps?: string[]): Hello =>
  ({
    v: 1,
    id: "hello",
    type: "hello",
    kind: "pi",
    agent_ref: "A",
    pid: 1,
    attest: {},
    ...(caps ? { caps } : {}),
  }) as unknown as Hello;

const setup = () => {
  const agents = new AgentTable();
  agents.up({
    ref: "A",
    kind: "pi",
    proposedName: "a",
    busName: "a",
    namespace: "ns",
    global: false,
    pid: 1,
    cwd: "/x",
    live: true,
  });
  const names: string[] = [];
  const ctx = {
    agents,
    pending: new Pending(),
    hub: { send: () => true },
    renamed: (_ref: string, n: string) => names.push(n),
  } as unknown as RouteCtx;
  return { ctx, names };
};
const frame = { v: 1, id: "7", type: "rename", name: "new-name" } as never;

describe("pi rename frame (#1635)", () => {
  it("reaches the daemon only for an adapter that listed the cap", () => {
    const a = setup();
    expect(
      routeLocal(frame, hello([ADAPTER_CAPS.rename]), () => true, a.ctx),
    ).toBeUndefined();
    expect(a.names).toEqual(["new-name"]);
    const b = setup();
    const out = routeLocal(frame, hello(["mailbox"]), () => true, b.ctx);
    expect(out).toMatchObject({ type: "error", code: "bad_frame" });
    expect(b.names).toEqual([]);
  });

  it("an older strict welcome decoder is never sent caps", async () => {
    // Frozen copy of the decoder before #1635: strict, no caps.
    const OldWelcome = z.strictObject({
      v: z.literal(1),
      id: z.string(),
      type: z.literal("welcome"),
      agent_ref: z.string(),
      bus_name: z.string(),
      namespace: z.string(),
      global: z.boolean(),
    });
    const { Welcome } = await import("@oa/bus-ipc");
    const base = {
      v: 1,
      id: "h",
      type: "welcome",
      agent_ref: "A",
      bus_name: "x",
      namespace: "n",
      global: false,
    };
    expect(OldWelcome.safeParse(base).success).toBe(true);
    // The daemon adds caps only when the hello listed rename (see capsFor).
    expect(Welcome.safeParse({ ...base, caps: ["rename"] }).success).toBe(true);
  });
});

// The daemon end to end: a pi extension's rename frame becomes one hub rename.
describe("pi rename through the daemon (#1635)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 120));
  async function up(caps: string[] | undefined, name = "first") {
    const { daemonHarness, hello: mk } = await import("./helpers.ts");
    const { connect } = await import("node:net");
    const h = await daemonHarness();
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: ["ids", "mailbox"],
    });
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
    const helloFrame = {
      ...mk({ kind: "pi", agent_ref: "P1", proposed_name: name }),
      ...(caps ? { caps } : {}),
    };
    sock.write(`${JSON.stringify(helloFrame)}\n`);
    await vi.waitFor(() =>
      expect(lines.some((l) => l.type === "welcome")).toBe(true),
    );
    await vi.waitFor(() => expect(h.of("agent_up")).toHaveLength(1));
    const rename = (n: string, id = "r1") =>
      sock.write(`${JSON.stringify({ v: 1, id, type: "rename", name: n })}\n`);
    return { h, lines, rename, sock, mk };
  }
  const socks: { destroy(): void }[] = [];
  afterEach(async () => {
    for (const s of socks.splice(0)) s.destroy();
    const { stopAll } = await import("./helpers.ts");
    await stopAll();
  });

  it("welcome lists the cap only for an adapter that listed it", async () => {
    const a = await up(["mailbox", "rename"]);
    expect(a.lines.find((l) => l.type === "welcome")?.caps).toEqual(["rename"]);
    const b = await up(["mailbox"]);
    expect(b.lines.find((l) => l.type === "welcome")).not.toHaveProperty(
      "caps",
    );
  });

  it("sends one hub rename per change; unchanged, empty and fallback send none", async () => {
    const { h, rename } = await up(["rename"]);
    rename("pi");
    rename("first");
    await settle();
    expect(h.of("rename")).toHaveLength(0);
    rename("second");
    rename("second", "r2");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    await settle();
    expect(h.of("rename")).toHaveLength(1);
    expect(h.of("rename")[0]).toMatchObject({
      agent_ref: "P1",
      proposed_name: "second",
      name_kind: "chosen",
    });
  });

  it("a frame without the cap is refused and sends nothing", async () => {
    const { h, lines, rename } = await up(undefined);
    rename("second");
    await vi.waitFor(() =>
      expect(
        lines.some((l) => l.type === "error" && l.code === "bad_frame"),
      ).toBe(true),
    );
    expect(h.of("rename")).toHaveLength(0);
  });

  it("a hello after a reconnect with a new name sends the rename", async () => {
    const { h, mk, sock } = await up(["rename"]);
    sock.destroy();
    const { connect } = await import("node:net");
    const s2 = connect(h.socketPath);
    s2.on("error", () => {});
    socks.push(s2);
    s2.write(
      `${JSON.stringify({ ...mk({ kind: "pi", agent_ref: "P1", proposed_name: "renamed-offline" }), caps: ["rename"] })}\n`,
    );
    // Either the record survived (a rename) or it was re-announced (an agent_up): the hub hears the new name.
    await vi.waitFor(() => {
      const heard = [
        ...h.of("rename").map((f) => f.proposed_name),
        ...h.of("agent_up").map((f) => f.proposed_name),
      ];
      expect(heard).toContain("renamed-offline");
    });
  });
});
