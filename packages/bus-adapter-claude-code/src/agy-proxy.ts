import { createHash, randomBytes } from "node:crypto";
import { Forwarder, LINK_MS, PROOFS_MAX, within } from "./forward.ts";

/** Where agy names the calling conversation in a tools/call (agy 1.5.17 capture). */
export const AGY_CONVERSATION_META = "antigravity.google/conversation_id";
/** The conversation a subagent's call belongs to: the session the user sees. */
export const AGY_ROOT_META = "antigravity.google/root_conversation_id";

/** A conversation id as the bus takes an agent ref. */
const REF = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The session a call comes from: its root conversation, else its own; undefined when agy sent neither. */
export function agyConversation(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  for (const k of [AGY_ROOT_META, AGY_CONVERSATION_META]) {
    const v = m[k];
    if (typeof v === "string" && REF.test(v)) return v;
  }
  return undefined;
}

export type AgyProxyDeps = {
  /** The instance's origin. */
  instance: string;
  /** #2793 S4: the added instance's local name; undefined is main. */
  instanceName?: string;
  /** The token, read at each request; undefined sends no Authorization. */
  token: () => string | undefined;
  fetch?: typeof fetch;
  /** The agy process this proxy runs under; undefined when none is found. */
  agyPid: () => number | undefined;
  /** Tells the daemon; true when the live session of that pid and conversation took the hash. */
  link: (req: {
    pid: number;
    conversation: string;
    hash: string;
    instance?: string;
  }) => Promise<boolean>;
  /** Test seam: 32 random bytes for a proof. */
  random?: () => Buffer;
  /** Test seam: LINK_MS. */
  linkMs?: number;
  upstreamMs?: number;
};

/**
 * agy S5: a local stand-in for the instance's /mcp, for Antigravity. agy's
 * http entries take static headers only, and it runs one MCP server per agy
 * process for all its conversations, with no session env. But every
 * tools/call carries the conversation in `_meta`. So for each call the proxy
 * asks the daemon to bind that conversation's proof to the agy session of
 * this process and conversation, and adds the proof header to that one
 * request only when the daemon took it. Proofs are per conversation and in
 * memory only. Any failure leaves the call unlinked but working.
 */
export class AgyProxy {
  private readonly fwd: Forwarder;
  /** conversation -> its proof; in memory only, never written or logged. */
  private readonly proofs = new Map<string, string>();

  constructor(private readonly deps: AgyProxyDeps) {
    this.fwd = new Forwarder({
      instance: deps.instance,
      token: deps.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.upstreamMs ? { upstreamMs: deps.upstreamMs } : {}),
      clientName: "oa-bus-antigravity-proxy",
      redirectHint:
        "Check the instance URL in Antigravity's mcp_config.json (oa-bus install wrote it).",
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

  private proofFor(conversation: string): string {
    let p = this.proofs.get(conversation);
    if (p === undefined) {
      p = (this.deps.random?.() ?? randomBytes(32)).toString("base64url");
      if (this.proofs.size >= PROOFS_MAX) {
        const oldest = this.proofs.keys().next().value;
        if (oldest !== undefined) this.proofs.delete(oldest);
      }
      this.proofs.set(conversation, p);
    }
    return p;
  }

  /** This call's proof once the daemon took its hash; undefined otherwise. Never throws. */
  private link(meta: unknown): Promise<string | undefined> {
    return within<{ close: () => void }, string | undefined>(
      this.deps.linkMs ?? LINK_MS,
      async (st) => {
        try {
          const conversation = agyConversation(meta);
          if (conversation === undefined) return undefined;
          const pid = this.deps.agyPid();
          if (pid === undefined) return undefined;
          const proof = this.proofFor(conversation);
          const hash = createHash("sha256").update(proof).digest("hex");
          const bound = await this.deps.link({
            pid,
            conversation,
            hash,
            ...(this.deps.instanceName === undefined
              ? {}
              : { instance: this.deps.instanceName }),
          });
          return bound && !st.late ? proof : undefined;
        } catch {
          return undefined;
        }
      },
    );
  }
}
