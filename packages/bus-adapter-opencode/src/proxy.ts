import { createHash, randomBytes } from "node:crypto";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ADAPTER_CAPS, type DaemonClient, type Hello } from "@oa/bus-ipc";
import { LINK_PROOF_HEADER } from "@oa/bus-protocol";
import type { OpenCodeSession } from "./session.ts";
import { helloFor, SESSION_META } from "./tools.ts";

/** The daemon gets this long to take a link_proof; later, the call goes unlinked. */
export const PROOF_MS = 2000;
/** The whole link step (session lookup, hello, link_proof) gets this long; later, the call goes unlinked. */
export const LINK_MS = 3000;
/** One request to the instance. */
export const UPSTREAM_MS = 60_000;
/** Sessions whose proof is kept; the oldest is dropped (it gets a new one next call). */
export const PROOFS_MAX = 1000;
/** An answer this large is refused. */
const MAX_BODY = 16 * 1024 * 1024;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The one URL the proxy ever sends to: `<instance origin>/mcp`. https, or http
 * for a loopback dev instance only; no credentials, path, query or fragment in
 * the instance, so nothing but the origin is trusted from the config.
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

export type ProxyDeps = {
  /** The instance's origin. */
  instance: string;
  /** The token, read at each request; undefined sends no Authorization. */
  token: () => string | undefined;
  fetch?: typeof fetch;
  connect: (hello: Hello) => Promise<DaemonClient>;
  resolve: (sessionId: string) => Promise<OpenCodeSession | null>;
  /** Test seam: 32 random bytes for a proof. */
  random?: () => Buffer;
  proofMs?: number;
  /** Test seam: LINK_MS. */
  linkMs?: number;
  upstreamMs?: number;
};

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

/**
 * A local stand-in for the instance's /mcp (#1856). OpenCode sends the calling
 * session's id with every tools/call; the proxy asks that session's own daemon
 * link to take a fresh proof's hash, and only then adds the proof header to
 * that one request. Nothing is ever shared across sessions, and any failure
 * leaves the call unlinked but working.
 */
export class OpenCodeProxy {
  private readonly url: URL;
  private readonly fetchFn: typeof fetch;
  /** root session -> its proof; in memory only, never written or logged. */
  private readonly proofs = new Map<string, string>();

  constructor(private readonly deps: ProxyDeps) {
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
        clientInfo: { name: "oa-bus-opencode-proxy", version: "0.1.0" },
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

  async call(
    params: { _meta?: Record<string, unknown> } & Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const link = await this.link(params?._meta);
    try {
      return await this.rpc("tools/call", params, signal, link?.proof);
    } finally {
      link?.client.close();
    }
  }

  private proofFor(root: string): string {
    let p = this.proofs.get(root);
    if (p === undefined) {
      p = (this.deps.random?.() ?? randomBytes(32)).toString("base64url");
      if (this.proofs.size >= PROOFS_MAX) {
        const oldest = this.proofs.keys().next().value;
        if (oldest !== undefined) this.proofs.delete(oldest);
      }
      this.proofs.set(root, p);
    }
    return p;
  }

  /**
   * The caller's own daemon link, held open until the request is answered, and
   * its proof once the daemon says it took the hash. Never throws: no proof
   * means an unlinked call. The whole step has one time cap; a link that opens
   * after it is closed and never used.
   */
  private async link(
    meta: Record<string, unknown> | undefined,
  ): Promise<{ client: DaemonClient; proof?: string } | undefined> {
    const st: { client?: DaemonClient; late?: boolean } = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<undefined>((res) => {
      timer = setTimeout(() => {
        st.late = true;
        st.client?.close();
        res(undefined);
      }, this.deps.linkMs ?? LINK_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.openLink(meta, st), cap]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async openLink(
    meta: Record<string, unknown> | undefined,
    st: { client?: DaemonClient; late?: boolean },
  ): Promise<{ client: DaemonClient; proof?: string } | undefined> {
    try {
      const sessionId = meta?.[SESSION_META];
      if (typeof sessionId !== "string" || !sessionId) return undefined;
      const session = await this.deps.resolve(sessionId);
      if (!session?.directory || st.late) return undefined;
      const client = await this.deps.connect(
        helloFor(sessionId, session, [ADAPTER_CAPS.link]),
      );
      st.client = client;
      if (st.late) {
        client.close();
        return undefined;
      }
      const caps = client.welcome.caps;
      if (!Array.isArray(caps) || !caps.includes(ADAPTER_CAPS.link))
        return { client };
      const proof = this.proofFor(session.root);
      const hash = createHash("sha256").update(proof).digest("hex");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([
          client.request({ type: "link_proof", hash }),
          new Promise<never>((_, rej) => {
            timer = setTimeout(
              () => rej(new Error("slow")),
              this.deps.proofMs ?? PROOF_MS,
            );
            timer.unref?.();
          }),
        ]);
        return r.type === "link_proofed" && r.bound && client.state === "open"
          ? { client, proof }
          : { client };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return st.client ? { client: st.client } : undefined;
    }
  }

  /**
   * One JSON-RPC request to the instance's /mcp. The URL is fixed at
   * construction and a redirect is never followed, so neither the token nor
   * the proof can reach another address.
   */
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
        "Open Artifacts answered with a redirect, but /mcp never redirects. Check the instance URL in OpenCode's config.",
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
