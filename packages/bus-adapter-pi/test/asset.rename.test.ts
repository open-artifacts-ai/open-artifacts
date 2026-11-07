// #1635: a pi session renamed while live reaches the daemon once, and a
// reconnect proposes the new name. The frame goes only to a daemon whose
// welcome listed `rename`.
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oa_bus from "../assets/oa-bus.ts";

type Frame = Record<string, unknown> & { type: string; id: string };
const servers: Server[] = [];
const sockets: Socket[] = [];
let home: string;
const shutdowns: (() => Promise<void>)[] = [];

async function daemon(caps: string[] | undefined) {
  const frames: Frame[][] = [];
  const server = createServer((sock) => {
    const mine: Frame[] = [];
    frames.push(mine);
    sockets.push(sock);
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        const f = JSON.parse(buf.slice(0, i)) as Frame;
        buf = buf.slice(i + 1);
        mine.push(f);
        if (f.type === "hello")
          sock.write(
            `${JSON.stringify({ v: 1, id: f.id, type: "welcome", agent_ref: f.agent_ref, bus_name: "x", namespace: "ns", global: false, ...(caps ? { caps } : {}) })}\n`,
          );
      }
    });
  });
  await new Promise<void>((r) =>
    server.listen(join(home, "daemon.sock"), () => r()),
  );
  servers.push(server);
  return {
    frames,
    renames: (n: number) => frames[n].filter((f) => f.type === "rename"),
    drop: () => sockets.at(-1)?.destroy(),
  };
}

let name: string | undefined;
const ctx = () => ({
  cwd: "/work/repo",
  sessionManager: {
    getSessionId: () => "pi-sess-r",
    getSessionName: () => name,
  },
});
type C = ReturnType<typeof ctx>;

async function pi() {
  const handlers = new Map<string, ((e: unknown, c: C) => unknown)[]>();
  oa_bus({
    registerTool: () => {},
    on: (e: string, h: (e: unknown, c: C) => unknown) =>
      handlers.set(e, [...(handlers.get(e) ?? []), h]),
    sendMessage: () => {},
  } as never);
  const emit = async (e: string) => {
    for (const h of handlers.get(e) ?? []) await h({}, ctx());
  };
  shutdowns.push(() => emit("session_shutdown"));
  await emit("session_start");
  return emit;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ob-pir-"));
  vi.stubEnv("OA_BUS_HOME", home);
  name = "First Name";
});
afterEach(async () => {
  for (const s of shutdowns.splice(0)) await s();
  vi.useRealTimers();
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
  vi.unstubAllEnvs();
});

describe("pi rename (#1635)", () => {
  it("lists the rename cap in hello", async () => {
    const d = await daemon(["rename"]);
    await pi();
    await vi.waitFor(() => expect(d.frames).toHaveLength(1));
    expect((d.frames[0][0].caps as string[]).includes("rename")).toBe(true);
  });

  it("sends one rename per change and nothing when unchanged", async () => {
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    await emit("session_info_changed");
    await emit("turn_start");
    expect(d.renames(0)).toHaveLength(0);
    name = "Second Name";
    await emit("session_info_changed");
    await emit("turn_start");
    await vi.waitFor(() => expect(d.renames(0)).toHaveLength(1));
    expect(d.renames(0)[0].name).toBe("second-name");
  });

  it("a turn start catches a rename when the event is missing", async () => {
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    name = "Third";
    await emit("turn_start");
    await vi.waitFor(() => expect(d.renames(0)).toHaveLength(1));
  });

  it("skips empty and fallback names", async () => {
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    name = undefined;
    await emit("session_info_changed");
    name = "!!!";
    await emit("session_info_changed");
    await new Promise((r) => setTimeout(r, 100));
    expect(d.renames(0)).toHaveLength(0);
  });

  it("sends nothing to a daemon whose welcome lacks the cap", async () => {
    const d = await daemon(undefined);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    name = "Renamed";
    await emit("session_info_changed");
    await new Promise((r) => setTimeout(r, 100));
    expect(d.renames(0)).toHaveLength(0);
  });

  it("proposes the new name after a reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    name = "After Rename";
    await emit("session_info_changed");
    d.drop();
    // The 3 s reconnect timer, well inside the 10 s bound: faked time passes
    // while the real socket close and reconnect settle.
    const t0 = Date.now();
    await vi.waitFor(
      async () => {
        await vi.advanceTimersByTimeAsync(500);
        expect(d.frames[1]?.length).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 5 },
    );
    expect(Date.now() - t0).toBeLessThanOrEqual(10_000);
    expect(d.frames[1][0].proposed_name).toBe("after-rename");
  });
});
