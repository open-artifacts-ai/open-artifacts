import { createHash, randomBytes } from "node:crypto";
import {
  Forwarder,
  LINK_MS,
  mcpUrl,
  PROOF_MS,
  PROOFS_MAX,
  UPSTREAM_MS,
  within,
} from "@oa/bus-adapter-claude-code";
import { ADAPTER_CAPS, type DaemonClient, type Hello } from "@oa/bus-ipc";
import type { OpenCodeSession } from "./session.ts";
import { helloFor, SESSION_META } from "./tools.ts";

export { LINK_MS, mcpUrl, PROOF_MS, PROOFS_MAX, UPSTREAM_MS };

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

/**
 * A local stand-in for the instance's /mcp (#1856). OpenCode sends the calling
 * session's id with every tools/call; the proxy asks that session's own daemon
 * link to take a fresh proof's hash, and only then adds the proof header to
 * that one request. Nothing is ever shared across sessions, and any failure
 * leaves the call unlinked but working.
 */
export class OpenCodeProxy {
  private readonly fwd: Forwarder;
  /** root session -> its proof; in memory only, never written or logged. */
  private readonly proofs = new Map<string, string>();

  constructor(private readonly deps: ProxyDeps) {
    this.fwd = new Forwarder({
      instance: deps.instance,
      token: deps.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.upstreamMs ? { upstreamMs: deps.upstreamMs } : {}),
      clientName: "oa-bus-opencode-proxy",
      redirectHint: "Check the instance URL in OpenCode's config.",
    });
  }

  /** What the instance says at initialize (its instructions), or undefined. */
  hello(signal?: AbortSignal): Promise<{ instructions?: string }> {
    return this.fwd.hello(signal);
  }

  list(params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.fwd.list(params, signal);
  }

  async call(
    params: { _meta?: Record<string, unknown> } & Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const link = await this.link(params?._meta);
    try {
      return await this.fwd.call(params, signal, link?.proof);
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
    return within<
      DaemonClient,
      { client: DaemonClient; proof?: string } | undefined
    >(this.deps.linkMs ?? LINK_MS, (st) => this.openLink(meta, st));
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
}
