// #1856: an omp session proves which bus agent it is on the instance's /mcp.
// omp has no way to set a header per server, so the extension wraps the global
// fetch: only a request to this instance's /mcp gets the header, and only while
// this process's one session has a link the daemon bound the proof to.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oa_bus from "../assets/oa-bus.ts";

type Frame = Record<string, unknown> & { type: string; id: string };
const servers: Server[] = [];
const sockets: Socket[] = [];
const shutdowns: (() => Promise<void>)[] = [];
let home: string;
const realFetch = globalThis.fetch;

type Answer = (n: number) => Record<string, unknown> | undefined;
const bound: Answer = () => ({ type: "link_proofed", bound: true });

async function daemon(caps: string[] | undefined, answer: Answer = bound) {
  const frames: Frame[] = [];
  let proofs = 0;
  const server = createServer((sock) => {
    sockets.push(sock);
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        const f = JSON.parse(buf.slice(0, i)) as Frame;
        buf = buf.slice(i + 1);
        frames.push(f);
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
          const a = answer(proofs++);
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
    proofs: () => frames.filter((f) => f.type === "link_proof"),
    drop: () => sockets.at(-1)?.destroy(),
  };
}

const ORIGIN = "https://oa.example.com";
const writeOrigin = (v: unknown = { origin: ORIGIN }) =>
  writeFileSync(join(home, "omp-mcp-origin.json"), JSON.stringify(v));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Seen = { url: string; init?: RequestInit };
let seen: Seen[];
/** What the stand-in for omp's global fetch answers, by call. */
let reply: (s: Seen, n: number) => Response;
const headerOf = (s: Seen) =>
  new Headers(s.init?.headers).get(LINK_PROOF_HEADER);

const ctx = (id: string, kind = "main", mode = "tui") => ({
  mode,
  cwd: "/work/repo",
  sessionManager: { getSessionId: () => id, getSessionName: () => "My omp" },
  agent: { kind },
});
type C = ReturnType<typeof ctx>;

/** One omp session's extension; `agent: false` is a Pi session. */
function omp(sid = "omp-sess-1", opts: { agent?: boolean } = {}) {
  const handlers = new Map<string, ((e: unknown, c: C) => unknown)[]>();
  oa_bus({
    registerTool: () => {},
    on: (e: string, h: (e: unknown, c: C) => unknown) =>
      handlers.set(e, [...(handlers.get(e) ?? []), h]),
    sendMessage: () => {},
  } as never);
  const emit = async (e: string, c: C | Record<string, unknown> = ctx(sid)) => {
    const full = (opts.agent === false ? { ...c, agent: undefined } : c) as C;
    for (const h of handlers.get(e) ?? []) await h({}, full);
  };
  shutdowns.push(() => emit("session_shutdown"));
  return { emit };
}
/** omp's MCP client: a plain global fetch of the URL string. */
const call = (url: string, init?: RequestInit) =>
  (globalThis.fetch as (u: string, i?: RequestInit) => Promise<Response>)(
    url,
    init,
  );
const MCP = `${ORIGIN}/mcp`;
const OWN = { Authorization: "Bearer t", "Content-Type": "application/json" };
const bind = async (d: Awaited<ReturnType<typeof daemon>>, s = omp()) => {
  await s.emit("session_start");
  await vi.waitFor(() => expect(d.proofs().length).toBeGreaterThanOrEqual(1));
  // The answer is in once the header shows.
  await vi.waitFor(async () => {
    await call(MCP, { headers: OWN });
    expect(headerOf(seen.at(-1) as Seen)).not.toBeNull();
  });
  return s;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ob-omp1856-"));
  vi.stubEnv("OA_BUS_HOME", home);
  seen = [];
  reply = () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    seen.push({ url: String(u), init });
    return reply(seen.at(-1) as Seen, seen.length - 1);
  }) as typeof fetch;
  writeOrigin();
});
afterEach(async () => {
  for (const s of shutdowns.splice(0)) await s();
  vi.useRealTimers();
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("omp session proof on /mcp (#1856)", () => {
  it("sends the proof header on the instance's /mcp once the daemon bound it, beside the entry's own headers", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    const last = seen.at(-1) as Seen;
    const proof = headerOf(last) as string;
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const h = new Headers(last.init?.headers);
    expect(h.get("authorization")).toBe("Bearer t");
    expect(h.get("content-type")).toBe("application/json");
    const [frame] = d.proofs();
    expect(frame.hash).toBe(sha(proof));
    expect(frame).not.toHaveProperty("pid");
    expect(JSON.stringify(d.frames)).not.toContain(proof);
  });

  it("sends no header before the daemon has answered", async () => {
    const d = await daemon(["link"], () => undefined);
    const s = omp();
    await s.emit("session_start");
    await vi.waitFor(() => expect(d.proofs()).toHaveLength(1));
    await call(MCP, { headers: OWN });
    expect(headerOf(seen.at(-1) as Seen)).toBeNull();
  });

  it("sends no header when the daemon says it did not bind", async () => {
    const d = await daemon(["link"], () => ({
      type: "link_proofed",
      bound: false,
    }));
    const s = omp();
    await s.emit("session_start");
    await vi.waitFor(() => expect(d.proofs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    await call(MCP, { headers: OWN });
    expect(headerOf(seen.at(-1) as Seen)).toBeNull();
  });

  it("offers no proof to a daemon that does not list link, and the wrap adds nothing", async () => {
    const d = await daemon(["mailbox"]);
    const s = omp();
    await s.emit("session_start");
    await vi.waitFor(() => expect(d.frames.length).toBeGreaterThan(0));
    await call(MCP, { headers: OWN });
    expect(d.proofs()).toHaveLength(0);
    expect(headerOf(seen.at(-1) as Seen)).toBeNull();
  });

  it("two sessions, one after the other, get different proofs", async () => {
    const d = await daemon(["link"]);
    const a = await bind(d, omp("omp-a"));
    const first = headerOf(seen.at(-1) as Seen);
    await a.emit("session_shutdown");
    seen = [];
    await bind(d, omp("omp-b"));
    const second = headerOf(seen.at(-1) as Seen);
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(d.proofs().map((f) => f.hash)).toEqual([
      sha(first as string),
      sha(second as string),
    ]);
  });

  it("wraps only in the interactive TUI: not in RPC (which ACP reports), print, or an unknown mode", async () => {
    const before = globalThis.fetch;
    const d = await daemon(["link"]);
    for (const mode of ["rpc", "rpc-ui", "acp", "print", "", undefined]) {
      const s = omp("m-1");
      await s.emit("session_start", { ...ctx("m-1"), mode });
      expect(globalThis.fetch).toBe(before);
      await s.emit("session_shutdown");
    }
    const s = omp("m-2");
    await s.emit("session_start", {
      ...ctx("m-2"),
      mode: undefined,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(d.proofs()).toHaveLength(0);
  });

  it("gives the header only to this instance's /mcp, and leaves other requests untouched", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    seen = [];
    const init = { headers: OWN };
    const others = [
      "https://oa.example.com/mcp/extra",
      "https://oa.example.com/mcpx",
      "https://oa.example.com/api",
      "http://oa.example.com/mcp",
      "https://oa.example.com:8443/mcp",
      "https://oa.example.com.evil.test/mcp",
      "https://elsewhere.test/mcp",
      "https://oa.example.com@evil.test/mcp",
      "not a url",
    ];
    for (const u of others) await call(u, init).catch(() => {});
    expect(seen).toHaveLength(others.length);
    for (const s of seen) {
      expect(s.init).toBe(init);
      expect(new Headers(s.init?.headers).has(LINK_PROOF_HEADER)).toBe(false);
    }
    // The same endpoint with a trailing slash or a query is still the instance's.
    await call(`${MCP}/`, init);
    await call(`${MCP}?x=1`, init);
    expect(headerOf(seen.at(-2) as Seen)).not.toBeNull();
    expect(headerOf(seen.at(-1) as Seen)).not.toBeNull();
  });

  it("leaves a Request or URL object it cannot read as an instance call alone", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    seen = [];
    const req = new Request("https://elsewhere.test/mcp");
    await (globalThis.fetch as typeof fetch)(req);
    expect(seen[0]?.init).toBeUndefined();
  });

  it("drops a proof header the user set in mcp.json, bound or not", async () => {
    const d = await daemon(["link"], () => undefined);
    const s = omp();
    await s.emit("session_start");
    await vi.waitFor(() => expect(d.proofs()).toHaveLength(1));
    await call(MCP, {
      headers: { ...OWN, "x-oa-agent-proof-token": "static-shared-value" },
    });
    const h = new Headers((seen.at(-1) as Seen).init?.headers);
    expect(h.has(LINK_PROOF_HEADER)).toBe(false);
    expect(h.get("authorization")).toBe("Bearer t");
  });

  it("does not wrap for Pi, a subagent, or an install that wrote no origin", async () => {
    const before = globalThis.fetch;
    const d = await daemon(["link"]);
    const pi = omp("pi-1", { agent: false });
    await pi.emit("session_start");
    expect(globalThis.fetch).toBe(before);
    await pi.emit("session_shutdown");
    const sub = omp("sub-1");
    await sub.emit("session_start", ctx("sub-1", "sub"));
    expect(globalThis.fetch).toBe(before);
    writeFileSync(join(home, "omp-mcp-origin.json"), "{ not json");
    const s = omp("omp-1");
    await s.emit("session_start");
    expect(globalThis.fetch).toBe(before);
    expect(d.proofs()).toHaveLength(0);
  });

  it("keeps the header across a lost link and replaces it at the next bind", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    const first = headerOf(seen.at(-1) as Seen);
    d.drop();
    // While the link is down the last header stays.
    await call(MCP, { headers: OWN });
    expect(headerOf(seen.at(-1) as Seen)).toBe(first);
    // The link comes back after the retry delay (3 s) with a new proof.
    await vi.waitFor(
      async () => {
        await call(MCP, { headers: OWN });
        const now = headerOf(seen.at(-1) as Seen);
        expect(now).not.toBeNull();
        expect(now).not.toBe(first);
      },
      { timeout: 8000 },
    );
    const second = headerOf(seen.at(-1) as Seen) as string;
    expect(d.proofs().map((f) => f.hash)).toEqual([
      sha(first as string),
      sha(second),
    ]);
  });

  it("/new, /resume and fork drop the old proof and a fresh link brings a new one", async () => {
    const d = await daemon(["link"]);
    const s = await bind(d);
    const before = headerOf(seen.at(-1) as Seen) as string;
    for (const [n, ev] of [
      [2, "session_switch"],
      [3, "session_branch"],
    ] as const) {
      await s.emit(ev, ctx(`omp-sess-${n}`));
      await vi.waitFor(() => expect(d.proofs()).toHaveLength(n));
      await vi.waitFor(async () => {
        await call(MCP, { headers: OWN });
        const now = headerOf(seen.at(-1) as Seen);
        expect(now).not.toBeNull();
        expect(now).not.toBe(before);
        expect(d.proofs().at(-1)?.hash).toBe(sha(now as string));
      });
      // The old proof is gone for good.
      expect(d.proofs()[0]?.hash).toBe(sha(before));
    }
    expect(new Set(d.proofs().map((f) => f.hash)).size).toBe(3);
  });

  it("a switch to the same session id changes nothing", async () => {
    const d = await daemon(["link"]);
    const s = await bind(d);
    const before = headerOf(seen.at(-1) as Seen);
    await s.emit("session_switch", ctx("omp-sess-1"));
    await call(MCP, { headers: OWN });
    expect(headerOf(seen.at(-1) as Seen)).toBe(before);
    expect(d.proofs()).toHaveLength(1);
  });

  it("the old proof never goes out between the switch and the new bind", async () => {
    const d = await daemon(["link"], (n) =>
      n === 0 ? { type: "link_proofed", bound: true } : undefined,
    );
    const s = await bind(d);
    await s.emit("session_switch", ctx("omp-sess-2"));
    await vi.waitFor(() => expect(d.proofs()).toHaveLength(2));
    await call(MCP, { headers: OWN });
    expect(headerOf(seen.at(-1) as Seen)).toBeNull();
  });

  it("takes the header away and puts fetch back at shutdown", async () => {
    const stand = globalThis.fetch;
    const d = await daemon(["link"]);
    const s = await bind(d);
    expect(globalThis.fetch).not.toBe(stand);
    await s.emit("session_shutdown");
    expect(globalThis.fetch).toBe(stand);
  });

  it("goes inert, not over someone else's wrap, when fetch was wrapped again on top", async () => {
    const d = await daemon(["link"]);
    const s = await bind(d);
    const inner = globalThis.fetch;
    const outer = (async (u: unknown, i?: RequestInit) =>
      inner(u as string, i)) as typeof fetch;
    globalThis.fetch = outer;
    await s.emit("session_shutdown");
    expect(globalThis.fetch).toBe(outer);
    seen = [];
    await call(MCP, { headers: OWN });
    expect(headerOf(seen.at(-1) as Seen)).toBeNull();
  });

  it("never follows a redirect itself: the proof stays on /mcp and Authorization never reaches another origin", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    seen = [];
    reply = (_s, n) =>
      n === 0
        ? new Response(null, {
            status: 307,
            headers: { location: "https://evil.test/collect" },
          })
        : new Response("{}", { status: 200 });
    const r = await call(MCP, { method: "POST", body: "{}", headers: OWN });
    expect(r.status).toBe(200);
    // First the proofed call, held at the redirect.
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe(MCP);
    expect((seen[0].init as RequestInit).redirect).toBe("manual");
    expect(headerOf(seen[0])).not.toBeNull();
    // Then the caller's own request through the native fetch: no proof, its own redirect handling.
    expect(seen[1].url).toBe(MCP);
    expect(headerOf(seen[1])).toBeNull();
    expect((seen[1].init as RequestInit).redirect).toBeUndefined();
    expect(new Headers(seen[1].init?.headers).get("authorization")).toBe(
      "Bearer t",
    );
    expect(seen[1].init?.body).toBe("{}");
    expect(seen.map((x) => x.url)).not.toContain("https://evil.test/collect");
  });

  it("returns the redirect as it is when the body cannot be sent twice", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    seen = [];
    reply = () =>
      new Response(null, { status: 307, headers: { location: `${MCP}/` } });
    const body = new ReadableStream();
    const r = await call(MCP, {
      method: "POST",
      body,
      headers: OWN,
      // biome-ignore lint/suspicious/noExplicitAny: Bun's duplex option
      duplex: "half",
    } as any);
    expect(r.status).toBe(307);
    expect(seen).toHaveLength(1);
  });

  it("passes a caller's own redirect mode through", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    seen = [];
    await call(MCP, { headers: OWN, redirect: "error" });
    expect((seen[0].init as RequestInit).redirect).toBe("error");
    expect(headerOf(seen[0])).not.toBeNull();
  });

  it("falls back to the plain call when the wrap itself fails", async () => {
    const d = await daemon(["link"]);
    await bind(d);
    seen = [];
    const bad = {
      get headers(): never {
        throw new Error("boom");
      },
    } as unknown as RequestInit;
    await call(MCP, bad);
    expect(seen).toHaveLength(1);
    expect(seen[0].init).toBe(bad);
  });
});
