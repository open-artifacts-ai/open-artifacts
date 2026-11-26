// #1635: a pi session renamed while live reaches the daemon once, and a
// reconnect proposes the new name. The frame goes only to a daemon whose
// welcome listed `rename`.
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusNameSchema } from "@oa/bus-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oa_bus from "../assets/oa-bus.ts";

type Frame = Record<string, unknown> & { type: string; id: string };
const servers: Server[] = [];
const sockets: Socket[] = [];
let home: string;
const shutdowns: (() => Promise<void>)[] = [];

async function daemon(caps: string[] | undefined, holdWelcome = false) {
  const frames: Frame[][] = [];
  // With holdWelcome the welcome waits for releaseWelcome(), not for a clock.
  const heldWelcomes: (() => void)[] = [];
  let settledSeq = 0;
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
        if (f.type === "hello") {
          const welcome = `${JSON.stringify({ v: 1, id: f.id, type: "welcome", agent_ref: f.agent_ref, bus_name: "x", namespace: "ns", global: false, bind_token: "bind-token-0123456789abcdef", ...(caps ? { caps } : {}) })}\n`;
          if (holdWelcome) heldWelcomes.push(() => sock.write(welcome));
          else sock.write(welcome);
        }
        if (f.type === "self")
          sock.write(
            `${JSON.stringify({ v: 1, id: f.id, type: "agent", agent: { name: "x", global: false } })}\n`,
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
    releaseWelcome: () => {
      for (const w of heldWelcomes.splice(0)) w();
    },
    /**
     * Ends an absence check on an event, not a wait: a delivery is pushed to
     * the session and its ack comes back on the same link, after every frame
     * the session wrote before it. Whatever it would have sent has arrived.
     */
    settled: async (n: number) => {
      const msg_id = `settle-${++settledSeq}`;
      sockets
        .at(-1)
        ?.write(
          `${JSON.stringify({ v: 1, id: "0", type: "deliver", msg_id, from_name: "p", namespace: "ns", body: "settle" })}\n`,
        );
      await vi.waitFor(() =>
        expect(
          frames[n].some((f) => f.type === "ack" && f.msg_id === msg_id),
        ).toBe(true),
      );
    },
  };
}

/** Advances the faked clock until the session has reconnected. */
async function reconnected(d: { frames: Frame[][] }, n: number) {
  const t0 = Date.now();
  await vi.waitFor(
    async () => {
      await vi.advanceTimersByTimeAsync(500);
      expect(d.frames[n]?.length).toBeGreaterThan(0);
    },
    { timeout: 5_000, interval: 5 },
  );
  // The 3 s reconnect timer, well inside the 10 s bound.
  expect(Date.now() - t0).toBeLessThanOrEqual(10_000);
}

let name: string | undefined;
let agent: { kind: string } | undefined;
let editorText: string;
let terminalInput: ((data: string) => void) | undefined;
const ctx = (id = "pi-sess-r") => ({
  cwd: "/work/repo",
  sessionManager: { getSessionId: () => id, getSessionName: () => name },
  ui: {
    getEditorText: () => editorText,
    onTerminalInput: (handler: (data: string) => void) => {
      terminalInput = handler;
      return () => {
        terminalInput = undefined;
      };
    },
  },
  ...(agent ? { agent } : {}),
});
type C = ReturnType<typeof ctx>;

async function pi(awaitStart = true) {
  const handlers = new Map<string, ((e: unknown, c: C) => unknown)[]>();
  oa_bus({
    registerTool: () => {},
    on: (e: string, h: (e: unknown, c: C) => unknown) =>
      handlers.set(e, [...(handlers.get(e) ?? []), h]),
    sendMessage: () => {},
  } as never);
  const emit = async (e: string, c: C = ctx()) => {
    for (const h of handlers.get(e) ?? []) await h({}, c);
  };
  shutdowns.push(() => emit("session_shutdown"));
  const started = Promise.all(
    (handlers.get("session_start") ?? []).map((h) =>
      h({ reason: "startup" }, ctx()),
    ),
  );
  if (awaitStart) await started;
  return emit;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ob-pir-"));
  vi.stubEnv("OA_BUS_HOME", home);
  name = "First Name";
  agent = undefined;
  editorText = "";
  terminalInput = undefined;
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

  it("marks a submitted /name chosen and sends it only once", async () => {
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    await emit("session_info_changed");
    await emit("turn_start");
    expect(d.renames(0)).toHaveLength(0);
    editorText = "/name Second Name";
    terminalInput?.("\r");
    name = "Second Name";
    await emit("session_info_changed");
    await emit("turn_start");
    await vi.waitFor(() => expect(d.renames(0)).toHaveLength(1));
    expect(d.renames(0)[0]).toMatchObject({
      name: "Second Name",
      name_chosen: true,
    });
    await d.settled(0);
    expect(d.renames(0)).toHaveLength(1);
  });

  it("forwards setSessionName without marking it chosen", async () => {
    const d = await daemon(["rename"]);
    const emit = await pi();
    // An unsubmitted command in the editor is not evidence of a choice.
    editorText = "/name Extension Title";
    name = "Extension Title";
    await emit("session_info_changed");
    await d.settled(0);
    expect(d.renames(0)).toHaveLength(1);
    expect(d.renames(0)[0]).toMatchObject({ name: "Extension Title" });
    expect(d.renames(0)[0]).not.toHaveProperty("name_chosen");
  });

  it.each(["--name", "-n"])(
    "marks the startup %s chosen in hello",
    async (flag) => {
      const d = await daemon(["rename"]);
      const argv = process.argv;
      process.argv = [...argv.slice(0, 2), flag, "First Name"];
      try {
        await pi();
        expect(d.frames[0][0]).toMatchObject({
          proposed_name: "First Name",
          name_chosen: true,
        });
      } finally {
        process.argv = argv;
      }
    },
  );

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
    name = " \u0001\u007f ";
    await emit("session_info_changed");
    await d.settled(0);
    expect(d.renames(0)).toHaveLength(0);
  });

  it("keeps the name as typed: case, spaces, unicode, punctuation; strips controls; fits 64", async () => {
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    const sent = async (n: string) => {
      const before = d.renames(0).length;
      name = n;
      await emit("session_info_changed");
      await vi.waitFor(() => expect(d.renames(0)).toHaveLength(before + 1));
      return d.renames(0)[before].name as string;
    };
    expect(await sent("OA Agent Experience Renamed")).toBe(
      "OA Agent Experience Renamed",
    );
    expect(await sent("  Caf\u00e9 \u00fcber (v2)!\u0007 ")).toBe(
      "Cafe uber v2",
    );
    expect(await sent("Backend: #1583")).toBe("Backend 1583");
    expect(await sent("OA Backend's lead")).toBe("OA Backend-s lead");
    expect(await sent("docs/readme")).toBe("docs-readme");
    const long = await sent(`${"ab ".repeat(30)}tail`);
    expect(long).toHaveLength(64);
    expect(long.startsWith("ab ab")).toBe(true);
    const emoji = await sent(`${"a".repeat(63)}\u{1F600}`);
    expect(emoji).toBe("a".repeat(63));
    let seq = 0;
    for (const n of [
      "OA Agent Experience Renamed",
      "Backend: #1583",
      "x.",
      "..a..",
      "- - -",
      "!!! b !!!",
    ]) {
      const out = await sent(`${n} ${++seq}`);
      expect(BusNameSchema.safeParse(out).success, out).toBe(true);
    }
  });

  it("sends nothing to a daemon whose welcome lacks the cap", async () => {
    const d = await daemon(undefined);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    name = "Renamed";
    await emit("session_info_changed");
    await d.settled(0);
    expect(d.renames(0)).toHaveLength(0);
  });

  it("proposes the new name after a reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    editorText = "/name After Rename";
    terminalInput?.("\x1b[13u");
    name = "After Rename";
    await emit("session_info_changed");
    d.drop();
    // Faked time passes while the real socket close and reconnect settle.
    await reconnected(d, 1);
    expect(d.frames[1][0]).toMatchObject({
      proposed_name: "After Rename",
      name_chosen: true,
    });
  });

  it("a reconnect echoes the binding token the first welcome issued (#1608)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = await daemon(["rename"]);
    await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    d.drop();
    await reconnected(d, 1);
    expect(d.frames[1][0].bind_token).toBe("bind-token-0123456789abcdef");
  });

  it("a rename while the hello is in flight is sent once the link is welcomed", async () => {
    const d = await daemon(["rename"], true);
    // Not awaited: session_start resolves only once the welcome arrives.
    const emit = await pi(false);
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    editorText = "/name Typed During Hello";
    terminalInput?.("\r");
    name = "Typed During Hello";
    // Another extension can delay Pi's metadata event by a microtask.
    await Promise.resolve();
    await emit("session_info_changed");
    d.releaseWelcome();
    await vi.waitFor(() => expect(d.renames(0)).toHaveLength(1));
    expect(d.renames(0)[0]).toMatchObject({
      name: "Typed During Hello",
      name_chosen: true,
    });
  });

  it("an event from another session neither renames nor changes what a reconnect proposes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    name = "Other Session Name";
    await emit("session_info_changed", ctx("some-other-session"));
    await d.settled(0);
    expect(d.renames(0)).toHaveLength(0);
    name = "First Name";
    d.drop();
    await reconnected(d, 1);
    expect(d.frames[1][0].proposed_name).toBe("First Name");
  });

  it("omp never renames on the hub: its auto titles cannot be told from typed ones", async () => {
    agent = { kind: "main" };
    const d = await daemon(["rename"]);
    const emit = await pi();
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    expect(d.frames[0][0]).not.toHaveProperty("name_chosen");
    name = "Auto Title";
    await emit("session_info_changed");
    await emit("turn_start");
    await d.settled(0);
    expect(d.renames(0)).toHaveLength(0);
  });

  it("omp: a title that changes while the hello is in flight is not sent", async () => {
    agent = { kind: "main" };
    const d = await daemon(["rename"], true);
    const emit = await pi(false);
    await vi.waitFor(() => expect(d.frames[0]?.length).toBeGreaterThan(0));
    // omp titles the session itself; a second session_start sees the new title.
    name = "Auto Title";
    void emit("session_start");
    d.releaseWelcome();
    await d.settled(0);
    expect(d.renames(0)).toHaveLength(0);
  });
});
