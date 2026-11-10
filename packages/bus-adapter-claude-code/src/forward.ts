import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { LINK_PROOF_HEADER } from "@oa/bus-ipc";

/** The daemon gets this long to take a link_proof; later, the call goes unlinked. */
export const PROOF_MS = 2000;
/** The whole link step (session lookup, hello, link_proof) gets this long; later, the call goes unlinked. */
export const LINK_MS = 3000;
/** One request to the instance. */
export const UPSTREAM_MS = 60_000;
/** Proofs kept (one per session or thread); the oldest is dropped (it gets a new one next call). */
export const PROOFS_MAX = 1000;
/** An answer this large is refused. */
const MAX_BODY = 16 * 1024 * 1024;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The one URL a local proxy ever sends to: `<instance origin>/mcp`. https, or
 * http for a loopback dev instance only; no credentials, path, query or
 * fragment in the instance, so nothing but the origin is trusted from the config.
 */
export function mcpUrl(instance: string): URL {
  const u = new URL(instance);
  const local = u.protocol === "http:" && LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !local)
    throw new Error("the instance must be an https address");
  if (u.username || u.password)
    throw new Error("the instance address must not carry credentials");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    throw new Error("the instance address must be an origin, with no path");
  return new URL("/mcp", u.origin);
}

type Rpc = { id?: unknown; result?: unknown; error?: unknown };

/** The JSON-RPC message with `id` 1 from a JSON or server-sent-events body. */
function parseAnswer(text: string, sse: boolean): Rpc | undefined {
  if (!sse) return JSON.parse(text) as Rpc;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const m = JSON.parse(data) as Rpc;
      if (m.id === 1 && (m.result !== undefined || m.error !== undefined))
        return m;
    } catch {}
  }
  return undefined;
}

export type ForwardDeps = {
  /** The instance's origin. */
  instance: string;
  /** The token, read at each request; undefined sends no Authorization. */
  token: () => string | undefined;
  fetch?: typeof fetch;
  upstreamMs?: number;
  /** Shown to the instance at initialize. */
  clientName: string;
  /** What to tell the user when /mcp redirects (names the harness's config). */
  redirectHint: string;
};

/**
 * The part every local proxy shares (#1856): one JSON-RPC request to the
 * instance's /mcp. The URL is fixed at construction and a redirect is never
 * followed, so neither the token nor a proof can reach another address.
 */
export class Forwarder {
  private readonly url: URL;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: ForwardDeps) {
    this.url = mcpUrl(deps.instance);
    this.fetchFn = deps.fetch ?? fetch;
  }

  /** What the instance says at initialize (its instructions), or undefined. */
  async hello(signal?: AbortSignal): Promise<{ instructions?: string }> {
    const r = (await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: this.deps.clientName, version: "0.1.0" },
      },
      signal,
    )) as { instructions?: unknown };
    return typeof r?.instructions === "string"
      ? { instructions: r.instructions }
      : {};
  }

  list(params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.rpc("tools/list", params, signal);
  }

  /** A tools/call; `proof` becomes the proof header of this one request. */
  call(
    params: unknown,
    signal?: AbortSignal,
    proof?: string,
  ): Promise<unknown> {
    return this.rpc("tools/call", params, signal, proof);
  }

  private async rpc(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    proof?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const token = this.deps.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (proof) headers[LINK_PROOF_HEADER] = proof;
    const timeout = AbortSignal.timeout(this.deps.upstreamMs ?? UPSTREAM_MS);
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (
      res.type === "opaqueredirect" ||
      (res.status >= 300 && res.status < 400)
    )
      throw new Error(
        `Open Artifacts answered with a redirect, but /mcp never redirects. ${this.deps.redirectHint}`,
      );
    if (!res.ok)
      throw new Error(`Open Artifacts answered with HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY)
      throw new Error("Open Artifacts' answer is too large");
    let msg: Rpc | undefined;
    try {
      msg = parseAnswer(
        text,
        (res.headers.get("content-type") ?? "").includes("text/event-stream"),
      );
    } catch {}
    if (!msg)
      throw new Error("Open Artifacts' answer was not a JSON-RPC message");
    if (msg.error !== undefined) {
      const e = msg.error as {
        code?: number;
        message?: string;
        data?: unknown;
      };
      throw new McpError(e.code ?? -32603, e.message ?? "error", e.data);
    }
    return msg.result;
  }
}

/**
 * Runs `open` under one time cap. `st.late` is set when the cap fires, and
 * `st.client` (if open by then) is closed through `close`: a link that opens
 * after the cap is never used. Resolves undefined at the cap.
 */
export async function within<T extends { close: () => void }, R>(
  ms: number,
  open: (st: { client?: T; late?: boolean }) => Promise<R>,
): Promise<R | undefined> {
  const st: { client?: T; late?: boolean } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<undefined>((res) => {
    timer = setTimeout(() => {
      st.late = true;
      st.client?.close();
      res(undefined);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([open(st), cap]);
  } finally {
    clearTimeout(timer);
  }
}
