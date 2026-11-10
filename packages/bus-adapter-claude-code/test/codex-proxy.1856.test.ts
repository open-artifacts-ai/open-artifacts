// #1856: Codex threads prove which bus agent they are on the instance's /mcp.
// The proxy re-proves the calling thread on every call: its own hello (the
// daemon attests the call id in the rollout), its own proof, and the header
// only after that thread's link took the hash. Never one proof per connection.
import { createHash } from "node:crypto";
import {
  ADAPTER_CAPS,
  type DaemonClient,
  type Hello,
  LINK_PROOF_HEADER,
} from "@oa/bus-ipc";
import { describe, expect, it, vi } from "vitest";
import { TURN_META } from "../src/codex.ts";
import { CodexProxy } from "../src/codex-proxy.ts";

const INSTANCE = "https://oa.example.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PROOF_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const TA = "01a184f2-14eb-73d0-9da0-ffd91d13abd3";
const TB = "01a184f2-14eb-73d0-9da0-ffd91d13abd4";

const meta = (
  thread: string,
  call: string,
  over: { source?: string; item?: string } = {},
) => ({
  callId: call,
  threadId: thread,
  sessionId: thread,
  itemId: over.item ?? "fc_1",
  [TURN_META]: {
    thread_id: thread,
    turn_id: "turn-1",
    thread_source: over.source ?? "user",
    workspaces: { "/work/a": { has_changes: false } },
  },
});

type Seen = { url: string; headers: Headers; body: string };

function setup(
  over: {
    welcomeCaps?: string[];
    /** Per thread: whether the daemon says it took the hash. */
    bound?: (thread: string) => boolean | Error;
    connect?: (h: Hello) => Promise<DaemonClient>;
    token?: () => string | undefined;
    respond?: (n: number) => Response;
    linkMs?: number;
    proofMs?: number;
  } = {},
) {
  const hellos: Hello[] = [];
  const hashes: { thread: string; hash: string }[] = [];
  const order: string[] = [];
  const seen: Seen[] = [];
  const connect =
    over.connect ??
    (async (hello: Hello) => {
      hellos.push(hello);
      order.push(`connect:${hello.agent_ref}`);
      return {
        welcome: { caps: over.welcomeCaps ?? [ADAPTER_CAPS.link] },
        state: "closed",
        request: vi.fn(async (f: { type: string; hash?: string }) => {
          order.push(`${f.type}:${hello.agent_ref}`);
          const b = over.bound?.(hello.agent_ref) ?? true;
          if (b instanceof Error) throw b;
          hashes.push({ thread: hello.agent_ref, hash: f.hash as string });
          return { v: 1, id: "1", type: "link_proofed", bound: b };
        }),
        close: () => order.push(`close:${hello.agent_ref}`),
      } as unknown as DaemonClient;
    });
  let n = 0;
  const fetchFn = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      order.push("fetch");
      seen.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      n += 1;
      return (
        over.respond?.(n) ??
        Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } })
      );
    },
  );
  const proxy = new CodexProxy({
    instance: INSTANCE,
    token: over.token ?? (() => "tok-env-value"),
    fetch: fetchFn as unknown as typeof fetch,
    connect,
    pid: 5000,
    ppid: 4000,
    ...(over.linkMs ? { linkMs: over.linkMs } : {}),
    ...(over.proofMs ? { proofMs: over.proofMs } : {}),
  });
  return { proxy, hellos, hashes, order, seen, fetchFn };
}

const call = (m?: unknown) => ({
  name: "list_artifacts",
  arguments: { q: 1 },
  ...(m ? { _meta: m } : {}),
});
const proofOf = (s: Seen) => s.headers.get(LINK_PROOF_HEADER);

describe("Codex proxy: a proof per thread, bound on every call (#1856)", () => {
  it("gives two threads on one proxy different proofs, each hashed to its own thread's link", async () => {
    const t = setup();
    await t.proxy.call(call(meta(TA, "call_a")));
    await t.proxy.call(call(meta(TB, "call_b")));
    const [a, b] = t.seen;
    expect(proofOf(a as Seen)).toMatch(PROOF_SHAPE);
    expect(proofOf(b as Seen)).toMatch(PROOF_SHAPE);
    expect(proofOf(a as Seen)).not.toBe(proofOf(b as Seen));
    expect(t.hashes).toEqual([
      { thread: TA, hash: sha(proofOf(a as Seen) as string) },
      { thread: TB, hash: sha(proofOf(b as Seen) as string) },
    ]);
  });

  it("opens a hello for the call's own thread and call id each time, with only the link capability", async () => {
    const t = setup();
    await t.proxy.call(call(meta(TA, "call_a")));
    await t.proxy.call(call(meta(TA, "call_a2")));
    expect(t.hellos.map((h) => [h.agent_ref, h.codex?.call_id])).toEqual([
      [TA, "call_a"],
      [TA, "call_a2"],
    ]);
    for (const h of t.hellos) {
      expect(h.kind).toBe("codex");
      expect(h.pid).toBe(5000);
      expect(h.codex?.ppid).toBe(4000);
      expect(h.caps).toEqual([ADAPTER_CAPS.link]);
      expect(h.caps).not.toContain("codex/connection-lease");
    }
    // One thread keeps one proof across its calls; each call is bound again.
    expect(proofOf(t.seen[0] as Seen)).toBe(proofOf(t.seen[1] as Seen));
    expect(t.hashes).toHaveLength(2);
  });

  it("never lends the first thread's proof to a second thread whose own link was not bound", async () => {
    const t = setup({ bound: (th) => th === TA });
    await t.proxy.call(call(meta(TA, "call_a")));
    await t.proxy.call(call(meta(TB, "call_b")));
    expect(proofOf(t.seen[0] as Seen)).toMatch(PROOF_SHAPE);
    expect(proofOf(t.seen[1] as Seen)).toBeNull();
    // And a later call of thread B with a bound link gets its own, not A's.
    const t2 = setup({ bound: (th) => th === TA });
    await t2.proxy.call(call(meta(TA, "c1")));
    await t2.proxy.call(call(meta(TB, "c2")));
    expect(t2.seen[1]?.headers.has(LINK_PROOF_HEADER)).toBe(false);
  });

  it("interleaved calls keep each thread's proof apart", async () => {
    const t = setup();
    await t.proxy.call(call(meta(TA, "1")));
    await t.proxy.call(call(meta(TB, "2")));
    await t.proxy.call(call(meta(TA, "3")));
    await t.proxy.call(call(meta(TB, "4")));
    const p = t.seen.map(proofOf);
    expect(p[0]).toBe(p[2]);
    expect(p[1]).toBe(p[3]);
    expect(p[0]).not.toBe(p[1]);
  });

  it("sends the header only after the link was bound: link_proof comes before the fetch, per call", async () => {
    const t = setup();
    await t.proxy.call(call(meta(TA, "call_a")));
    expect(t.order).toEqual([
      `connect:${TA}`,
      `link_proof:${TA}`,
      `close:${TA}`,
      "fetch",
    ]);
  });

  it("sends no header when the daemon did not take the hash, was slow, or failed", async () => {
    for (const t of [
      setup({ bound: () => false }),
      setup({ bound: () => new Error("boom") }),
      setup({ welcomeCaps: [] }),
      setup({
        connect: () => Promise.reject(new Error("no daemon")),
      }),
    ]) {
      const r = await t.proxy.call(call(meta(TA, "call_a")));
      expect(r).toEqual({ content: [] });
      expect(t.seen).toHaveLength(1);
      expect(t.seen[0]?.headers.has(LINK_PROOF_HEADER)).toBe(false);
      expect(t.seen[0]?.headers.get("authorization")).toBe(
        "Bearer tok-env-value",
      );
    }
  });

  it("caps the link step: a daemon that never answers leaves the call unlinked", async () => {
    const closed: string[] = [];
    const t = setup({
      linkMs: 20,
      connect: (h) =>
        new Promise((res) => {
          setTimeout(
            () =>
              res({
                welcome: { caps: [ADAPTER_CAPS.link] },
                request: async () => ({ type: "link_proofed", bound: true }),
                close: () => closed.push(h.agent_ref),
              } as unknown as DaemonClient),
            60,
          );
        }),
    });
    await t.proxy.call(call(meta(TA, "call_a")));
    expect(t.seen[0]?.headers.has(LINK_PROOF_HEADER)).toBe(false);
    await vi.waitFor(() => expect(closed).toContain(TA));
  });

  it("goes unlinked for a subagent: no hello at all, the call still works", async () => {
    const t = setup();
    for (const source of ["subagent", "guardian_review"]) {
      const r = await t.proxy.call(call(meta(TA, "call_s", { source })));
      expect(r).toEqual({ content: [] });
    }
    expect(t.hellos).toEqual([]);
    expect(t.seen.every((s) => !s.headers.has(LINK_PROOF_HEADER))).toBe(true);
  });

  it("goes unlinked, still working, with no thread identity in _meta", async () => {
    const t = setup();
    await t.proxy.call(call());
    await t.proxy.call(call({ threadId: TA }));
    await t.proxy.call(
      call({ ...meta(TA, "c"), [TURN_META]: { thread_id: TB } }),
    );
    expect(t.hellos).toEqual([]);
    expect(t.seen).toHaveLength(3);
    expect(t.seen.every((s) => !s.headers.has(LINK_PROOF_HEADER))).toBe(true);
  });

  it("does not link a code-mode call (an exec- call id): no hello, no header, so the exec's one bus slot stays free", async () => {
    const t = setup();
    const id = "exec-0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f";
    const r = await t.proxy.call(call(meta(TA, id, { item: "ctc_77" })));
    expect(r).toEqual({ content: [] });
    expect(t.hellos).toEqual([]);
    expect(t.seen[0]?.headers.has(LINK_PROOF_HEADER)).toBe(false);
  });

  it("forwards the call to /mcp only, redirect never followed", async () => {
    const t = setup({
      respond: () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.example/mcp" },
        }),
    });
    await expect(t.proxy.call(call(meta(TA, "c")))).rejects.toThrow(/redirect/);
    expect(t.seen[0]?.url).toBe(`${INSTANCE}/mcp`);
    expect(t.fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses an instance that is not an https origin", () => {
    expect(
      () =>
        new CodexProxy({
          instance: "http://oa.example.com",
          token: () => undefined,
          connect: async () => {
            throw new Error("x");
          },
        }),
    ).toThrow(/https/);
  });

  it("reads the token at each request", async () => {
    let tok = "one";
    const t = setup({ token: () => tok });
    await t.proxy.call(call(meta(TA, "1")));
    tok = "two";
    await t.proxy.call(call(meta(TA, "2")));
    expect(t.seen.map((s) => s.headers.get("authorization"))).toEqual([
      "Bearer one",
      "Bearer two",
    ]);
  });
});
