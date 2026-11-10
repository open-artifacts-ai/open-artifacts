// #1856: a Pi session proves which bus agent it is on the instance's /mcp.
// The extension registers the /mcp server with pi.registerMcpServer(), with
// the proof header only once the daemon says its own link took the proof hash.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oa_bus from "../assets/oa-bus.ts";
import { PI_EXTENSION } from "../src/index.ts";

type Frame = Record<string, unknown> & { type: string; id: string };
const servers: Server[] = [];
const sockets: Socket[] = [];
const shutdowns: (() => Promise<void>)[] = [];
let home: string;

/** What a `link_proof` is answered with, by call number (0-based) across the daemon. */
type Answer = (n: number, hash: string) => Record<string, unknown> | undefined;
const bound: Answer = () => ({ type: "link_proofed", bound: true });

async function daemon(caps: string[] | undefined, answer: Answer = bound) {
  const frames: Frame[][] = [];
  let proofs = 0;
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
        const send = (o: object) =>
          sock.write(`${JSON.stringify({ v: 1, id: f.id, ...o })}\n`);
        if (f.type === "hello")
          send({
            type: "welcome",
            agent_ref: f.agent_ref,
            bus_name: "x",
            namespace: "ns",
            global: false,
            ...(caps ? { caps } : {}),
          });
        else if (f.type === "link_proof") {
          const a = answer(proofs++, String(f.hash));
          if (a) send(a);
        }
      }
    });
  });
  await new Promise<void>((r) =>
    server.listen(join(home, "daemon.sock"), () => r()),
  );
  servers.push(server);
  return {
    frames,
    proofFrames: () =>
      frames.flatMap((c) => c.filter((f) => f.type === "link_proof")),
    drop: () => sockets.at(-1)?.destroy(),
  };
}

const ENTRY = {
  name: "open-artifacts",
  config: {
    type: "http",
    url: "https://oa.example.com/mcp",
    headers: { Authorization: "Bearer ${OA_TOKEN}" },
    exposure: "direct",
  },
};
const writeEntry = (entry: unknown = ENTRY) =>
  writeFileSync(join(home, "pi-mcp-entry.json"), JSON.stringify(entry));

type Reg = { name: string; config: Record<string, unknown> };
const proofOf = (r: Reg) =>
  (r.config.headers as Record<string, string> | undefined)?.[LINK_PROOF_HEADER];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let session = "pi-sess-1";
const ctx = (id = session) => ({
  cwd: "/work/repo",
  sessionManager: { getSessionId: () => id, getSessionName: () => "My Pi" },
});
type C = ReturnType<typeof ctx>;

/** A fake Pi; `mcp: false` is one without registerMcpServer (omp, older Pi). */
function pi(opts: { mcp?: boolean; agent?: { kind: string } } = {}) {
  const handlers = new Map<string, ((e: unknown, c: C) => unknown)[]>();
  const regs: Reg[] = [];
  const unregs: string[] = [];
  oa_bus({
    registerTool: () => {},
    on: (e: string, h: (e: unknown, c: C) => unknown) =>
      handlers.set(e, [...(handlers.get(e) ?? []), h]),
    sendMessage: () => {},
    ...(opts.mcp === false
      ? {}
      : {
          registerMcpServer: (name: string, config: Reg["config"]) =>
            regs.push({ name, config: structuredClone(config) }),
          unregisterMcpServer: (name: string) => unregs.push(name),
        }),
  } as never);
  const emit = async (e: string, c: C | Record<string, unknown> = ctx()) => {
    const full = { ...c, ...(opts.agent ? { agent: opts.agent } : {}) } as C;
    for (const h of handlers.get(e) ?? []) await h({}, full);
  };
  shutdowns.push(() => emit("session_shutdown"));
  return { emit, regs, unregs };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ob-pi1856-"));
  vi.stubEnv("OA_BUS_HOME", home);
  session = "pi-sess-1";
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

describe("pi session proof on /mcp (#1856)", () => {
  it("keeps the proof header name the server reads", () => {
    expect(readFileSync(PI_EXTENSION, "utf8")).toContain(
      `"${LINK_PROOF_HEADER}"`,
    );
  });

  it("lists the link cap in hello", async () => {
    const d = await daemon(["link"]);
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(d.frames[0]?.[0]?.caps).toContain("link"));
  });

  it("registers the entry with no header first, then with the proof once the daemon bound it", async () => {
    writeEntry();
    const d = await daemon(["link"]);
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(p.regs.length).toBeGreaterThanOrEqual(2));
    const [first, second] = p.regs;
    // The first one is the plain entry: the server works unlinked.
    expect(first.name).toBe("open-artifacts");
    expect(first.config).toEqual(ENTRY.config);
    // The second adds the header beside the entry's own, and nothing else changes.
    const proof = proofOf(second);
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.config).toEqual({
      ...ENTRY.config,
      headers: { ...ENTRY.config.headers, [LINK_PROOF_HEADER]: proof },
    });
    // One helloed frame: the hash only, no pid, never the proof itself.
    const [frame] = d.proofFrames();
    expect(frame.type).toBe("link_proof");
    expect(frame.hash).toBe(sha(proof as string));
    expect(frame).not.toHaveProperty("pid");
    expect(JSON.stringify(d.frames)).not.toContain(proof as string);
  });

  it("registers no header before the daemon has answered", async () => {
    writeEntry();
    // The daemon takes the frame and never answers.
    await daemon(["link"], () => undefined);
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(p.regs.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 150));
    for (const r of p.regs) expect(proofOf(r)).toBeUndefined();
  });

  it("registers no header when the daemon says it did not bind, and retries at most once a minute", async () => {
    writeEntry();
    vi.useFakeTimers({ toFake: ["Date"] });
    const d = await daemon(["link"], (n) =>
      n === 0
        ? { type: "link_proofed", bound: false }
        : { type: "link_proofed", bound: true },
    );
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(d.proofFrames()).toHaveLength(1));
    // Turns inside the minute do not offer again.
    vi.setSystemTime(Date.now() + 30_000);
    await p.emit("turn_start");
    await p.emit("turn_start");
    expect(d.proofFrames()).toHaveLength(1);
    for (const r of p.regs) expect(proofOf(r)).toBeUndefined();
    // After it, one more offer of the same proof; once bound, the header appears.
    vi.setSystemTime(Date.now() + 31_000);
    await p.emit("turn_start");
    await vi.waitFor(() => expect(d.proofFrames()).toHaveLength(2));
    expect(d.proofFrames()[1].hash).toBe(d.proofFrames()[0].hash);
    await vi.waitFor(() => expect(p.regs.some(proofOf)).toBe(true));
    // Bound: later turns do not offer again.
    vi.setSystemTime(Date.now() + 120_000);
    await p.emit("turn_start");
    expect(d.proofFrames()).toHaveLength(2);
  });

  it("an older daemon (no link in welcome) gets no frame and no header", async () => {
    writeEntry();
    const d = await daemon(undefined);
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(p.regs.length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(d.frames).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(d.proofFrames()).toHaveLength(0);
    for (const r of p.regs) expect(proofOf(r)).toBeUndefined();
  });

  it("registers the plain entry with no daemon at all", async () => {
    writeEntry();
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(p.regs).toHaveLength(1));
    expect(p.regs[0].config).toEqual(ENTRY.config);
  });

  it("a reconnect takes the header off, then gives a new proof", async () => {
    writeEntry();
    const d = await daemon(["link"]);
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(p.regs.some(proofOf)).toBe(true));
    const first = p.regs.map(proofOf).find(Boolean) as string;
    const before = p.regs.length;
    d.drop();
    await vi.waitFor(
      () => expect(p.regs.slice(before).map(proofOf)).toContain(undefined),
      { timeout: 2000 },
    );
    // The link is back after the retry delay (3 s): wait for its proof.
    await vi.waitFor(
      () => expect(p.regs.map(proofOf).filter(Boolean).length).toBe(2),
      { timeout: 8000 },
    );
    const second = p.regs.map(proofOf).filter(Boolean)[1] as string;
    expect(second).not.toBe(first);
    expect(d.proofFrames().map((f) => f.hash)).toEqual([
      sha(first),
      sha(second),
    ]);
    // Between the two, the header was off.
    const seq = p.regs.map((r) => proofOf(r) ?? "-");
    expect(seq.indexOf("-", seq.indexOf(first))).toBeLessThan(
      seq.indexOf(second),
    );
  }, 15_000);

  it("two sessions in one process get different proofs, each hashed to its own link", async () => {
    writeEntry();
    const d = await daemon(["link"]);
    const a = pi();
    const b = pi();
    await a.emit("session_start", ctx("pi-sess-A"));
    await b.emit("session_start", ctx("pi-sess-B"));
    await vi.waitFor(() => expect(a.regs.some(proofOf)).toBe(true));
    await vi.waitFor(() => expect(b.regs.some(proofOf)).toBe(true));
    const pa = a.regs.map(proofOf).find(Boolean) as string;
    const pb = b.regs.map(proofOf).find(Boolean) as string;
    expect(pa).not.toBe(pb);
    // Each proof's hash went on the connection of the session that holds it.
    const owner = (hash: string) =>
      d.frames.findIndex((c) =>
        c.some((f) => f.type === "link_proof" && f.hash === hash),
      );
    const ha = d.frames.findIndex((c) =>
      c.some((f) => f.type === "hello" && f.agent_ref === "pi-sess-A"),
    );
    const hb = d.frames.findIndex((c) =>
      c.some((f) => f.type === "hello" && f.agent_ref === "pi-sess-B"),
    );
    expect(owner(sha(pa))).toBe(ha);
    expect(owner(sha(pb))).toBe(hb);
  });

  it("one session that switches to another gets a new proof and drops the old header", async () => {
    writeEntry();
    await daemon(["link"]);
    const p = pi();
    await p.emit("session_start", ctx("pi-sess-A"));
    await vi.waitFor(() => expect(p.regs.some(proofOf)).toBe(true));
    const a = p.regs.map(proofOf).find(Boolean) as string;
    await p.emit("session_shutdown", ctx("pi-sess-A"));
    await p.emit("session_start", ctx("pi-sess-B"));
    await vi.waitFor(() =>
      expect(p.regs.map(proofOf).filter(Boolean)).toHaveLength(2),
    );
    expect(p.regs.map(proofOf).filter(Boolean)[1]).not.toBe(a);
  });

  it("a proof answered after the link closed is never registered", async () => {
    writeEntry();
    const d = await daemon(["link"], () => undefined);
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(d.proofFrames()).toHaveLength(1));
    d.drop();
    await new Promise((r) => setTimeout(r, 150));
    for (const r of p.regs) expect(proofOf(r)).toBeUndefined();
  });

  it("shutdown puts the plain entry back, so no proof outlives the session", async () => {
    writeEntry();
    await daemon(["link"]);
    const p = pi();
    await p.emit("session_start");
    await vi.waitFor(() => expect(p.regs.some(proofOf)).toBe(true));
    await p.emit("session_shutdown");
    expect(proofOf(p.regs.at(-1) as Reg)).toBeUndefined();
  });

  it("does nothing without the install's entry file, on omp, or on a Pi with no registerMcpServer", async () => {
    // No entry file.
    const d = await daemon(["link"]);
    const none = pi();
    await none.emit("session_start");
    await vi.waitFor(() => expect(d.frames).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(none.regs).toHaveLength(0);
    expect(d.proofFrames()).toHaveLength(0);
    // The entry exists: omp and an old Pi still link and send no proof.
    writeEntry();
    const omp = pi({ agent: { kind: "main" } });
    await omp.emit("session_start", ctx("omp-1"));
    const old = pi({ mcp: false });
    await old.emit("session_start", ctx("old-1"));
    await vi.waitFor(() => expect(d.frames).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 100));
    expect(omp.regs).toHaveLength(0);
    expect(d.proofFrames()).toHaveLength(0);
  });

  it("an entry file it cannot use leaves Pi as it was", async () => {
    await daemon(["link"]);
    for (const bad of [
      "not json",
      JSON.stringify({ name: "bad name!", config: {} }),
      JSON.stringify({ name: "x", config: "nope" }),
    ]) {
      writeFileSync(join(home, "pi-mcp-entry.json"), bad);
      const p = pi();
      await p.emit("session_start");
      await new Promise((r) => setTimeout(r, 50));
      expect(p.regs).toHaveLength(0);
    }
  });

  it("a registerMcpServer that throws does not break the link", async () => {
    writeEntry();
    const d = await daemon(["link"]);
    const handlers = new Map<string, ((e: unknown, c: C) => unknown)[]>();
    oa_bus({
      registerTool: () => {},
      on: (e: string, h: (e: unknown, c: C) => unknown) =>
        handlers.set(e, [...(handlers.get(e) ?? []), h]),
      sendMessage: () => {},
      registerMcpServer: () => {
        throw new Error("conflict");
      },
    } as never);
    for (const h of handlers.get("session_start") ?? []) await h({}, ctx());
    await vi.waitFor(() => expect(d.frames).toHaveLength(1));
    for (const h of handlers.get("session_shutdown") ?? []) await h({}, ctx());
  });
});
