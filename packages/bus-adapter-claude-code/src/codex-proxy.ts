import { createHash, randomBytes } from "node:crypto";
import { ADAPTER_CAPS, type DaemonClient, type Hello } from "@oa/bus-ipc";
import { codexCall, codexHello } from "./codex.ts";
import { Forwarder, LINK_MS, PROOF_MS, PROOFS_MAX, within } from "./forward.ts";

/** The call id Codex mints for each call an `exec` makes (the daemon's own test). */
const EXEC_CALL = /^exec-[0-9a-f-]{36}$/;

export type CodexProxyDeps = {
  /** The instance's origin. */
  instance: string;
  /** The token, read at each request; undefined sends no Authorization. */
  token: () => string | undefined;
  fetch?: typeof fetch;
  connect: (hello: Hello) => Promise<DaemonClient>;
  /** This process, and Codex (its parent): the daemon checks both. */
  pid?: number;
  ppid?: number;
  /** Test seam: 32 random bytes for a proof. */
  random?: () => Buffer;
  proofMs?: number;
  /** Test seam: LINK_MS. */
  linkMs?: number;
  upstreamMs?: number;
};

/**
 * A local stand-in for the instance's /mcp, for Codex (#1856). Codex sends
 * the calling thread's id and call id with every tools/call. For each call
 * the proxy opens that thread's own daemon link (a codex hello the daemon
 * attests against the rollout), asks it to take the thread's proof hash, and
 * only then adds the proof header to that one request. The proof is per
 * thread and in memory only; the bind is redone on every call, so a thread
 * never rides on another's link. Any failure leaves the call unlinked but
 * working. It never lists the `codex/connection-lease` capability: Codex
 * keeps one proxy per chat.
 */
export class CodexProxy {
  private readonly fwd: Forwarder;
  /** thread -> its proof; in memory only, never written or logged. */
  private readonly proofs = new Map<string, string>();

  constructor(private readonly deps: CodexProxyDeps) {
    this.fwd = new Forwarder({
      instance: deps.instance,
      token: deps.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.upstreamMs ? { upstreamMs: deps.upstreamMs } : {}),
      clientName: "oa-bus-codex-proxy",
      redirectHint: "Check the instance URL in Codex's config.toml.",
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
    params: { _meta?: unknown } & Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const proof = await this.link(params?._meta);
    return this.fwd.call(params, signal, proof);
  }

  private proofFor(thread: string): string {
    let p = this.proofs.get(thread);
    if (p === undefined) {
      p = (this.deps.random?.() ?? randomBytes(32)).toString("base64url");
      if (this.proofs.size >= PROOFS_MAX) {
        const oldest = this.proofs.keys().next().value;
        if (oldest !== undefined) this.proofs.delete(oldest);
      }
      this.proofs.set(thread, p);
    }
    return p;
  }

  /**
   * This call's thread's proof, once the daemon says that thread's link took
   * its hash; undefined otherwise. Never throws, and has one time cap: a link
   * that opens after it is closed and never used.
   */
  private async link(meta: unknown): Promise<string | undefined> {
    return within<DaemonClient, string | undefined>(
      this.deps.linkMs ?? LINK_MS,
      (st) => this.openLink(meta, st),
    );
  }

  private async openLink(
    meta: unknown,
    st: { client?: DaemonClient; late?: boolean },
  ): Promise<string | undefined> {
    try {
      // A subagent, or a call without the thread's identity: unlinked.
      const call = codexCall(meta);
      if ("refuse" in call) return undefined;
      // Code mode (the call id is an exec's `exec-<uuid>`): a proxied call
      // would use up the exec's one bus slot, so it goes unlinked. A plain
      // call carries an item id too (Codex 0.165 capture), so the id's shape decides.
      if (EXEC_CALL.test(call.callId)) return undefined;
      const hello = codexHello(
        call,
        this.deps.pid ?? process.pid,
        this.deps.ppid ?? process.ppid,
        [ADAPTER_CAPS.link],
      );
      if (!hello || st.late) return undefined;
      const client = await this.deps.connect(hello);
      st.client = client;
      if (st.late) {
        client.close();
        return undefined;
      }
      const caps = client.welcome.caps;
      if (!Array.isArray(caps) || !caps.includes(ADAPTER_CAPS.link))
        return undefined;
      const proof = this.proofFor(call.threadId);
      const hash = createHash("sha256").update(proof).digest("hex");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A Codex hello is one request: the daemon ends the connection after
        // this answer, so the link's state is not checked afterwards.
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
        return r.type === "link_proofed" && r.bound && !st.late
          ? proof
          : undefined;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return undefined;
    } finally {
      st.client?.close();
    }
  }
}
