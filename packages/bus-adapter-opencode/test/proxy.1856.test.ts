// #1856: OpenCode sessions prove which bus agent they are on the instance's
// /mcp. The local proxy adds the proof header for the session that made the
// call, only once that session's own daemon link took the hash.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ADAPTER_CAPS, type DaemonClient, type Hello } from "@oa/bus-ipc";
import { LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpUrl, OpenCodeProxy } from "../src/proxy.ts";
import type { OpenCodeSession } from "../src/session.ts";
import { SESSION_META } from "../src/tools.ts";

const INSTANCE = "https://oa.example.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PROOF_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const ROOTS: Record<string, OpenCodeSession> = {
  ses_a: { root: "ses_a", directory: "/work/a", title: null },
  ses_b: { root: "ses_b", directory: "/work/b", title: null },
  ses_a_child: { root: "ses_a", directory: "/work/a", title: null },
};

type Seen = { url: string; init: RequestInit & { headers: Headers } };

function setup(
  over: {
    welcomeCaps?: string[];
    bound?: boolean | Error;
    connect?: (h: Hello) => Promise<DaemonClient>;
    resolve?: (id: string) => Promise<OpenCodeSession | null>;
    token?: () => string | undefined;
    respond?: (n: number) => Response;
    instance?: string;
    proofMs?: number;
  } = {},
) {
  const hellos: Hello[] = [];
  const hashes: { ref: string; hash: string }[] = [];
  const order: string[] = [];
  const closed: string[] = [];
  const seen: Seen[] = [];
  const connect =
    over.connect ??
    (async (hello: Hello) => {
      hellos.push(hello);
      order.push(`connect:${hello.agent_ref}`);
      return {
        welcome: { caps: over.welcomeCaps ?? [ADAPTER_CAPS.link] },
        state: "open",
        request: vi.fn(async (f: { type: string; hash?: string }) => {
          order.push(`${f.type}:${hello.agent_ref}`);
          if (over.bound instanceof Error) throw over.bound;
          hashes.push({ ref: hello.agent_ref, hash: f.hash as string });
          return {
            v: 1,
            id: "1",
            type: "link_proofed",
            bound: over.bound ?? true,
          };
        }),
        close: () => {
          order.push(`close:${hello.agent_ref}`);
          closed.push(hello.agent_ref);
        },
      } as unknown as DaemonClient;
    });
  let n = 0;
  const fetchFn = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      order.push("fetch");
      seen.push({
        url: String(url),
        init: { ...init, headers: new Headers(init?.headers) } as Seen["init"],
      });
      n += 1;
      return (
        over.respond?.(n) ??
        Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } })
      );
    },
  );
  const proxy = new OpenCodeProxy({
    instance: over.instance ?? INSTANCE,
    token: over.token ?? (() => "tok-file-value"),
    fetch: fetchFn as unknown as typeof fetch,
    connect,
    resolve: over.resolve ?? (async (id) => ROOTS[id] ?? null),
    ...(over.proofMs ? { proofMs: over.proofMs } : {}),
  });
  return { proxy, hellos, hashes, order, closed, seen, fetchFn };
}

const callArgs = (sessionID?: string) => ({
  name: "list_artifacts",
  arguments: { q: 1 },
  ...(sessionID ? { _meta: { [SESSION_META]: sessionID } } : {}),
});
const fail = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("resolved, wanted a failure");
    },
    (x: unknown) => x as Error & { code?: number },
  );
const proofOf = (s: Seen) => s.init.headers.get(LINK_PROOF_HEADER);

describe("OpenCode proxy: the proof header", () => {
  it("two sessions get different proofs and headers, each from its own link", async () => {
    const t = setup();
    await t.proxy.call(callArgs("ses_a"));
    await t.proxy.call(callArgs("ses_b"));
    const [a, b] = t.seen.map(proofOf);
    expect(a).toMatch(PROOF_SHAPE);
    expect(b).toMatch(PROOF_SHAPE);
    expect(a).not.toBe(b);
    expect(t.hashes).toEqual([
      { ref: "ses_a", hash: sha(a as string) },
      { ref: "ses_b", hash: sha(b as string) },
    ]);
    expect(
      t.hellos.map((h) => [h.agent_ref, h.cwd, h.attest.session_id]),
    ).toEqual([
      ["ses_a", "/work/a", "ses_a"],
      ["ses_b", "/work/b", "ses_b"],
    ]);
    expect(t.hellos[0]?.caps).toEqual([ADAPTER_CAPS.link]);
  });

  it("a session keeps its proof between calls, and a sub-agent shares its root's", async () => {
    const t = setup();
    await t.proxy.call(callArgs("ses_a"));
    await t.proxy.call(callArgs("ses_a_child"));
    await t.proxy.call(callArgs("ses_a"));
    const proofs = t.seen.map(proofOf);
    expect(new Set(proofs).size).toBe(1);
    expect(t.hashes.map((h) => h.ref)).toEqual(["ses_a", "ses_a", "ses_a"]);
  });

  it("no header before the daemon says it took the hash, and the hash goes first", async () => {
    const t = setup();
    await t.proxy.call(callArgs("ses_a"));
    expect(t.order).toEqual([
      "connect:ses_a",
      "link_proof:ses_a",
      "fetch",
      "close:ses_a",
    ]);
  });

  it("is unlinked when the daemon does not take the hash", async () => {
    const t = setup({ bound: false });
    const r = await t.proxy.call(callArgs("ses_a"));
    expect(r).toEqual({ content: [] });
    expect(t.seen).toHaveLength(1);
    expect(proofOf(t.seen[0] as Seen)).toBeNull();
    expect(t.closed).toEqual(["ses_a"]);
  });

  it("sends no link_proof and no header to a daemon whose welcome lacks the link cap", async () => {
    const t = setup({ welcomeCaps: [] });
    await t.proxy.call(callArgs("ses_a"));
    expect(t.hashes).toEqual([]);
    expect(proofOf(t.seen[0] as Seen)).toBeNull();
    expect(t.closed).toEqual(["ses_a"]);
  });

  it("never sends the proof on tools/list or when the call names no session", async () => {
    const t = setup();
    await t.proxy.list({});
    await t.proxy.call(callArgs());
    expect(t.hellos).toEqual([]);
    expect(t.seen.map(proofOf)).toEqual([null, null]);
  });

  const failures: [string, Parameters<typeof setup>[0]][] = [
    [
      "the daemon refuses the hello",
      {
        connect: async () => {
          throw new Error("no");
        },
      },
    ],
    ["the session cannot be found", { resolve: async () => null }],
    [
      "the lookup throws",
      {
        resolve: async () => {
          throw new Error("boom");
        },
      },
    ],
    [
      "the session has no directory",
      {
        resolve: async () => ({ root: "ses_a", directory: null, title: null }),
      },
    ],
    ["link_proof throws", { bound: new Error("closed") }],
  ];
  for (const [name, over] of failures)
    it(`the tool still works, unlinked, when ${name}`, async () => {
      const t = setup(over);
      const r = await t.proxy.call(callArgs("ses_a"));
      expect(r).toEqual({ content: [] });
      expect(t.seen).toHaveLength(1);
      expect(proofOf(t.seen[0] as Seen)).toBeNull();
    });

  it("is unlinked when the daemon is too slow with link_proof", async () => {
    const t = setup({
      proofMs: 10,
      connect: async () =>
        ({
          welcome: { caps: [ADAPTER_CAPS.link] },
          state: "open",
          request: () => new Promise(() => {}),
          close: () => {},
        }) as unknown as DaemonClient,
    });
    await t.proxy.call(callArgs("ses_a"));
    expect(proofOf(t.seen[0] as Seen)).toBeNull();
  });
});

describe("OpenCode proxy: where the proof and the token go", () => {
  it("posts only to the instance's /mcp, never following a redirect", async () => {
    const t = setup({
      respond: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/mcp" },
        }),
    });
    await expect(t.proxy.call(callArgs("ses_a"))).rejects.toThrow(/redirect/i);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    expect(t.seen[0]?.url).toBe(`${INSTANCE}/mcp`);
    expect(t.seen[0]?.init.redirect).toBe("manual");
    expect(t.closed).toEqual(["ses_a"]);
  });

  it("an opaque redirect (a runtime that hides the status) is refused too", async () => {
    const t = setup({
      respond: () =>
        ({
          type: "opaqueredirect",
          status: 0,
          ok: false,
        }) as unknown as Response,
    });
    await expect(t.proxy.list({})).rejects.toThrow(/redirect/i);
  });

  it("every request, list and call, goes to the same exact URL", async () => {
    const t = setup();
    await t.proxy.list({});
    await t.proxy.call(callArgs("ses_a"));
    expect(new Set(t.seen.map((s) => s.url))).toEqual(
      new Set([`${INSTANCE}/mcp`]),
    );
  });

  it("sends the token file's value as Authorization, read at each call", async () => {
    let v: string | undefined = "one";
    const t = setup({ token: () => v });
    await t.proxy.call(callArgs("ses_a"));
    v = "two";
    await t.proxy.call(callArgs("ses_a"));
    v = undefined;
    await t.proxy.call(callArgs("ses_a"));
    expect(t.seen.map((s) => s.init.headers.get("authorization"))).toEqual([
      "Bearer one",
      "Bearer two",
      null,
    ]);
  });

  it("an error never repeats the token or the proof", async () => {
    const t = setup({
      respond: () => new Response("nope tok-file-value", { status: 500 }),
    });
    const e = await fail(t.proxy.call(callArgs("ses_a")));
    expect(String(e.message)).not.toContain("tok-file-value");
    expect(String(e.message)).toMatch(/500/);
    expect(String(e.message)).not.toContain(
      proofOf(t.seen[0] as Seen) ?? "none",
    );
  });

  it("accepts only the instance origin", () => {
    expect(mcpUrl("https://oa.example.com").href).toBe(
      "https://oa.example.com/mcp",
    );
    expect(mcpUrl("https://oa.example.com/").href).toBe(
      "https://oa.example.com/mcp",
    );
    expect(mcpUrl("http://127.0.0.1:8787").href).toBe(
      "http://127.0.0.1:8787/mcp",
    );
    expect(mcpUrl("http://localhost:8787").href).toBe(
      "http://localhost:8787/mcp",
    );
    for (const bad of [
      "http://oa.example.com",
      "https://user:pw@oa.example.com",
      "https://oa.example.com/other",
      "https://oa.example.com/?x=1",
      "https://oa.example.com/#h",
      "ftp://oa.example.com",
      "not a url",
    ])
      expect(() => mcpUrl(bad), bad).toThrow();
  });
});

describe("OpenCode proxy: the wire", () => {
  it("posts one JSON-RPC message with the call's params", async () => {
    const t = setup();
    await t.proxy.call(callArgs("ses_a"));
    const s = t.seen[0] as Seen;
    expect(s.init.method).toBe("POST");
    expect(s.init.headers.get("accept")).toBe(
      "application/json, text/event-stream",
    );
    expect(JSON.parse(s.init.body as string)).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_artifacts", arguments: { q: 1 } },
    });
  });

  it("reads a server-sent-events answer", async () => {
    const t = setup({
      respond: () =>
        new Response(
          `event: message\ndata: {"jsonrpc":"2.0","id":9,"result":{"other":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"x"}]}}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    expect(await t.proxy.list({})).toEqual({ tools: [{ name: "x" }] });
  });

  it("turns a JSON-RPC error into an McpError", async () => {
    const t = setup({
      respond: () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "bad arg" },
        }),
    });
    const e = await fail(t.proxy.call(callArgs()));
    expect(e).toBeInstanceOf(McpError);
    expect(e.code).toBe(-32602);
  });
});

describe("OpenCode proxy: a real redirect leaves nothing behind", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const listen = (
    h: (req: IncomingMessage) => void,
    status?: number,
    location?: string,
  ) =>
    new Promise<string>((res) => {
      const s = createServer((req, rsp) => {
        h(req);
        rsp.writeHead(status ?? 200, location ? { location } : {});
        rsp.end("{}");
      });
      servers.push(s);
      s.listen(0, "127.0.0.1", () =>
        res(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
      );
    });

  it("the other origin receives no request at all", async () => {
    const other: IncomingMessage[] = [];
    const elsewhere = await listen((r) => other.push(r));
    const own: IncomingMessage[] = [];
    const instance = await listen((r) => own.push(r), 307, `${elsewhere}/mcp`);
    const proxy = new OpenCodeProxy({
      instance,
      token: () => "tok-file-value",
      connect: async () =>
        ({
          welcome: { caps: [ADAPTER_CAPS.link] },
          state: "open",
          request: async () => ({
            v: 1,
            id: "1",
            type: "link_proofed",
            bound: true,
          }),
          close: () => {},
        }) as unknown as DaemonClient,
      resolve: async (id) => ROOTS[id] ?? null,
    });
    await expect(proxy.call(callArgs("ses_a"))).rejects.toThrow(/redirect/i);
    expect(own).toHaveLength(1);
    expect(own[0]?.headers[LINK_PROOF_HEADER.toLowerCase()]).toMatch(
      PROOF_SHAPE,
    );
    expect(other).toHaveLength(0);
  });
});
