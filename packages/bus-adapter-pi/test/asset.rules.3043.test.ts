import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oa_bus from "../assets/oa-bus.ts";

type Frame = Record<string, unknown> & { type: string; id: string };
type Conn = { sock: Socket; frames: Frame[] };

type Ctx = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionName?(): string | undefined;
  };
  agent?: { kind?: string };
};

const rootCtx = (sessionId = "pi-sess-1"): Ctx => ({
  cwd: "/work/repo",
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionName: () => "My Pi",
  },
});

const subCtx = (sessionId = "omp-sub-1"): Ctx => ({
  cwd: "/work/repo",
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionName: () => "Sub",
  },
  agent: { kind: "sub" },
});

const servers: Server[] = [];
const sockets: Socket[] = [];
const homes: string[] = [];
const shutdowns: (() => Promise<void>)[] = [];

async function fakeDaemon(
  home: string,
  answer: (f: Frame) => Record<string, unknown> | undefined,
) {
  const conns: Conn[] = [];
  const server: Server = createServer((sock) => {
    const conn: Conn = { sock, frames: [] };
    conns.push(conn);
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i = buf.indexOf("\n");
      while (i !== -1) {
        const f = JSON.parse(buf.slice(0, i)) as Frame;
        buf = buf.slice(i + 1);
        i = buf.indexOf("\n");
        conn.frames.push(f);
        const out =
          f.type === "hello"
            ? {
                type: "welcome",
                agent_ref: f.agent_ref,
                bus_name: "pi-agent",
                namespace: "ns",
                global: false,
              }
            : (answer(f) ??
              (f.type === "self"
                ? {
                    type: "agent",
                    agent: {
                      name: "pi-agent",
                      namespace: "ns",
                      kind: "pi",
                      live: true,
                      global: false,
                    },
                  }
                : undefined));
        if (out) sock.write(`${JSON.stringify({ v: 1, id: f.id, ...out })}\n`);
      }
    });
  });
  await new Promise<void>((r) =>
    server.listen(join(home, "daemon.sock"), () => r()),
  );
  servers.push(server);
  return { conns };
}

type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: Ctx,
  ) => Promise<{ content: { type: string; text: string }[] }>;
};

function fakePi() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, ((e: unknown, c: Ctx) => unknown)[]>();
  const pi = {
    registerTool: (t: Tool) => tools.set(t.name, t),
    on: (event: string, h: (e: unknown, c: Ctx) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), h]),
    sendMessage: () => {},
  };
  const emit = async (event: string, c: Ctx, e: unknown = {}) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? []) last = await h(e, c);
    return last;
  };
  const call = async (
    name: string,
    params: Record<string, unknown>,
    c: Ctx = rootCtx(),
  ) => {
    const tool = tools.get(`oabus_${name}`);
    if (!tool) throw new Error(`no tool oabus_${name}`);
    const r = await tool.execute("call-1", params, undefined, undefined, c);
    return r.content.map((x) => x.text).join("");
  };
  shutdowns.push(async () => {
    await emit("session_shutdown", rootCtx());
  });
  return { pi, emit, call };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ob-pi-rules-"));
  homes.push(home);
  vi.stubEnv("OA_BUS_HOME", home);
});

afterEach(async () => {
  for (const fn of shutdowns.splice(0)) await fn();
  vi.useRealTimers();
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
  for (const dir of homes.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("pi extension bus rules (#3043)", () => {
  it("appends daemon rules on before_agent_start and does not duplicate them", async () => {
    await fakeDaemon(home, (f) =>
      f.type === "habits" ? { type: "habits", rules: "RULES v1" } : undefined,
    );
    const p = fakePi();
    oa_bus(p.pi as never);
    const c = rootCtx();
    await p.emit("session_start", c, { reason: "startup" });

    const out = await p.emit("before_agent_start", c, { systemPrompt: "BASE" });
    expect(out).toEqual({ systemPrompt: "BASE\n\nRULES v1" });

    // Already containing the rules must not append them a second time.
    const dup = await p.emit("before_agent_start", c, {
      systemPrompt: "BASE\n\nRULES v1",
    });
    expect(dup).toBeUndefined();
  });

  it("appends daemon rules on omp (systemPrompt: string[]) and does not duplicate them", async () => {
    await fakeDaemon(home, (f) =>
      f.type === "habits" ? { type: "habits", rules: "RULES v1" } : undefined,
    );
    const o = fakePi();
    Object.assign(o.pi, { arktype: () => {}, zod: {}, typebox: {} });
    oa_bus(o.pi as never);
    const c: Ctx = { ...rootCtx("omp-root-1"), agent: { kind: "main" } };
    await o.emit("session_start", c, { reason: "startup" });

    const out = await o.emit("before_agent_start", c, {
      systemPrompt: ["BASE"],
    });
    expect(out).toEqual({ systemPrompt: ["BASE", "RULES v1"] });

    // Already containing the rules must not append them a second time.
    const dup = await o.emit("before_agent_start", c, {
      systemPrompt: ["BASE", "RULES v1"],
    });
    expect(dup).toBeUndefined();
  });

  it("picks up updated rules in a fresh session after a simulated auto-update", async () => {
    let currentRules = "RULES v1";
    await fakeDaemon(home, (f) =>
      f.type === "habits" ? { type: "habits", rules: currentRules } : undefined,
    );

    const p1 = fakePi();
    oa_bus(p1.pi as never);
    await p1.emit("session_start", rootCtx("pi-sess-1"), { reason: "startup" });
    expect(
      await p1.emit("before_agent_start", rootCtx("pi-sess-1"), {
        systemPrompt: "BASE",
      }),
    ).toEqual({ systemPrompt: "BASE\n\nRULES v1" });
    await p1.emit("session_shutdown", rootCtx("pi-sess-1"));

    // Daemon now serves v2; a fresh session gets v2, not v1.
    currentRules = "RULES v2";
    const p2 = fakePi();
    oa_bus(p2.pi as never);
    await p2.emit("session_start", rootCtx("pi-sess-2"), { reason: "startup" });
    expect(
      await p2.emit("before_agent_start", rootCtx("pi-sess-2"), {
        systemPrompt: "BASE",
      }),
    ).toEqual({ systemPrompt: "BASE\n\nRULES v2" });
  });

  it("returns undefined when the daemon answers rules: null (opted out)", async () => {
    await fakeDaemon(home, (f) =>
      f.type === "habits" ? { type: "habits", rules: null } : undefined,
    );
    const p = fakePi();
    oa_bus(p.pi as never);
    const c = rootCtx();
    await p.emit("session_start", c, { reason: "startup" });

    expect(
      await p.emit("before_agent_start", c, { systemPrompt: "BASE" }),
    ).toBeUndefined();
  });

  it("handles an error frame (bad_frame) without throwing and keeps the link usable", async () => {
    await fakeDaemon(home, (f) =>
      f.type === "habits"
        ? { type: "error", code: "bad_frame", message: "unknown type" }
        : undefined,
    );
    const p = fakePi();
    oa_bus(p.pi as never);
    const c = rootCtx();
    await p.emit("session_start", c, { reason: "startup" });

    expect(
      await p.emit("before_agent_start", c, { systemPrompt: "BASE" }),
    ).toBeUndefined();

    // The link remains open and usable for tool calls.
    const selfOut = await p.call("self", {}, c);
    expect(selfOut).toContain("pi-agent");
  });

  it("gives subagent contexts no rules", async () => {
    await fakeDaemon(home, (f) =>
      f.type === "habits" ? { type: "habits", rules: "RULES v1" } : undefined,
    );
    const p = fakePi();
    oa_bus(p.pi as never);
    await p.emit("session_start", rootCtx(), { reason: "startup" });

    expect(
      await p.emit("before_agent_start", subCtx(), { systemPrompt: "BASE" }),
    ).toBeUndefined();
  });

  it("does not delay session_start when the daemon never answers habits, and gives up on the turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let habitsSeen!: () => void;
    const gotHabits = new Promise<void>((r) => {
      habitsSeen = r;
    });
    await fakeDaemon(home, (f) => {
      if (f.type === "habits") habitsSeen();
      return undefined;
    });
    const p = fakePi();
    oa_bus(p.pi as never);
    const c = rootCtx();

    const order: string[] = [];
    const started = p
      .emit("session_start", c, { reason: "startup" })
      .then(() => {
        order.push("session_start");
      });
    const habitsArrived = gotHabits.then(() => {
      order.push("habits_received");
    });
    // session_start resolves before the daemon answers anything (and without advancing timers).
    await started;
    await habitsArrived;
    expect(order[0]).toBe("session_start");

    // The turn awaits the in-flight fetch until SELF_TIMEOUT_MS, then gets no rules.
    let turnDone = false;
    const turn = p
      .emit("before_agent_start", c, { systemPrompt: "BASE" })
      .then((res) => {
        turnDone = true;
        return res;
      });
    await Promise.resolve();
    expect(turnDone).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await turn).toBeUndefined();
    expect(turnDone).toBe(true);
  });
});
