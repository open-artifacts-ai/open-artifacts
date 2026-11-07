import { createHash } from "node:crypto";

/** What a hook or a tool factory knows about the caller. All of it is optional on the wire. */
export type Caller = {
  agentId?: string;
  sessionKey?: string;
  trigger?: string;
  modelProviderId?: string;
  modelId?: string;
  workspaceDir?: string;
};

export type Root = {
  /** The bus agent_ref: a digest of state dir + agent id + lowercased session key. */
  ref: string;
  agentId: string;
  sessionKey: string;
  cwd: string;
  proposedName: string;
};

export type Resolved = { ok: true; root: Root } | { ok: false; reason: string };

/**
 * Provider ids whose runs this adapter does not claim, until a live run proves
 * the hooks cover them. Sources in OpenClaw 2026.6.5:
 * - "claude-cli": isClaudeCliProvider, dist/attempt-execution-CgTGShuY.js:224.
 * - "openai-codex" and "codex-cli": the legacy Codex provider and runtime ids
 *   (LEGACY_OPENAI_CODEX_PROVIDER_ID, LEGACY_CODEX_CLI_RUNTIME_ID in the
 *   dist/ doctor and model-selection code).
 * - "codex": the Codex harness id (docs/plugins/codex-harness.md).
 * The native Codex harness normally runs under the "openai" provider
 * (`openai/gpt-5.5` with runtime `codex`), which hook contexts do not tell
 * apart from direct OpenAI traffic: that case is not detected here.
 */
export const REFUSED_PROVIDERS: ReadonlySet<string> = new Set([
  "claude-cli",
  "codex-cli",
  "openai-codex",
  "codex",
]);

const KEY = /^agent:([^:]+):(.+)$/;

const SLUG_MAX = 64;
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");

export const refusal = {
  noKey:
    "oa-bus: OpenClaw did not say which session made this call, so it cannot be placed on the bus.",
  badKey:
    "oa-bus: this session's key is not one the bus knows, so it is not on the bus.",
  subagent:
    "oa-bus: a subagent is not on the bus; only the main OpenClaw session can use Open Artifacts bus.",
  acp: "oa-bus: an ACP session is not on the bus.",
  cron: "oa-bus: a cron run is not on the bus.",
  trigger:
    "oa-bus: only a run started by a user message is on the bus, not a scheduled or automatic one.",
  runtime: "oa-bus: this model runtime is not supported on the bus yet.",
};

/**
 * Which bus agent a call belongs to, or why it is none. Refused, never guessed:
 * a wrong root would be a second agent on the bus.
 * `trigger` is only checked when `needTrigger` (hooks carry it; tool
 * factories do not).
 */
export function resolveRoot(
  c: Caller,
  stateDir: string,
  opts: { needTrigger: boolean },
): Resolved {
  const raw = c.sessionKey;
  if (typeof raw !== "string" || raw.trim() === "")
    return { ok: false, reason: refusal.noKey };
  const key = raw.trim().toLowerCase();
  if (key.includes(":subagent:"))
    return { ok: false, reason: refusal.subagent };
  if (key.includes(":acp:")) return { ok: false, reason: refusal.acp };
  if (key.includes(":cron:")) return { ok: false, reason: refusal.cron };
  const m = KEY.exec(key);
  if (!m) return { ok: false, reason: refusal.badKey };
  if (opts.needTrigger && c.trigger !== "user")
    return { ok: false, reason: refusal.trigger };
  const provider = c.modelProviderId?.trim().toLowerCase();
  if (provider && REFUSED_PROVIDERS.has(provider))
    return { ok: false, reason: refusal.runtime };
  // The key carries the agent id; a hook's ctx.agentId agrees with it.
  const agentId = m[1] as string;
  const tail = m[2] as string;
  const ref =
    "oa-" +
    createHash("sha256")
      .update(JSON.stringify([stateDir, agentId, key]))
      .digest("hex")
      .slice(0, 40);
  const name =
    slug(
      tail === "main" ? `openclaw-${agentId}` : `openclaw-${agentId}-${tail}`,
    ) || "openclaw";
  return {
    ok: true,
    root: {
      ref,
      agentId,
      sessionKey: key,
      cwd: c.workspaceDir || process.cwd(),
      proposedName: name,
    },
  };
}
