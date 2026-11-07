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
  /** The bus agent_ref: a digest of state dir + agent id + normalized session key. */
  ref: string;
  agentId: string;
  sessionKey: string;
  cwd: string;
  proposedName: string;
};

export type Resolved = { ok: true; root: Root } | { ok: false; reason: string };

/**
 * Provider ids whose runs this adapter does not claim, until a live run proves
 * the hooks cover them. Sources in OpenClaw 2026.6.5 (dist/):
 * - "claude-cli": isClaudeCliProvider, attempt-execution-CgTGShuY.js:224.
 * - "openai-codex" and "codex-cli": the legacy Codex provider and runtime ids.
 * - "codex": the Codex harness id (docs/plugins/codex-harness.md).
 */
export const REFUSED_PROVIDERS: ReadonlySet<string> = new Set([
  "claude-cli",
  "codex-cli",
  "openai-codex",
  "codex",
]);

const lower = (s: string): string => s.trim().toLowerCase();

/**
 * Whether the OpenAI provider is the stock one. Mirrors isOfficialOpenAIBaseUrl,
 * openai-routing-DXJmS9CT.js:11-19: no base URL, or https://api.openai.com
 * (/ or /v1). A custom OpenAI-compatible URL "intentionally bypasses
 * Codex-runtime defaults" (openai-routing-DXJmS9CT.js:5).
 */
function officialOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return true;
  try {
    const u = new URL(baseUrl.trim());
    return (
      u.protocol === "https:" &&
      u.hostname.toLowerCase() === "api.openai.com" &&
      ["", "/", "/v1", "/v1/"].includes(u.pathname)
    );
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The OpenAI provider's config entry, matched as OpenClaw does (openai-routing-DXJmS9CT.js:21-27). */
function openaiProviderConfig(config: unknown): Json | undefined {
  const providers =
    isObj(config) && isObj(config.models) ? config.models.providers : undefined;
  if (!isObj(providers)) return undefined;
  for (const [id, v] of Object.entries(providers))
    if (lower(id) === "openai" && isObj(v)) return v;
  return undefined;
}

/** Whether any `agentRuntime.id` in the config names the Codex runtime (a bounded walk). */
function configNamesCodexRuntime(config: unknown): boolean {
  let budget = 5000;
  const walk = (v: unknown, depth: number): boolean => {
    if (budget-- <= 0 || depth > 10 || (!isObj(v) && !Array.isArray(v)))
      return false;
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    const rt = v.agentRuntime;
    if (isObj(rt) && typeof rt.id === "string" && lower(rt.id) === "codex")
      return true;
    return Object.values(v).some((x) => walk(x, depth + 1));
  };
  return walk(config, 0);
}

/**
 * Whether this model route may run on a runtime whose hooks this adapter
 * cannot ack on, so mail would be re-injected every turn and never acked.
 *
 * OpenClaw sends stock `openai` to the Codex runtime by default
 * (resolveAgentHarnessPolicy, harness-runtimes-DJm6gsbE.js:19-31, with
 * openAIProviderUsesCodexRuntimeByDefault, openai-routing-DXJmS9CT.js:35).
 * model_call_* hooks only fire in the embedded runner
 * (selection-But6hGR0.js:8497-8503), so on that path nothing acks.
 * The route is refused when:
 * - the provider is one of REFUSED_PROVIDERS;
 * - the provider is `openai` and its base URL is the official one, or the
 *   config is not known (it cannot be told);
 * - the config names the Codex runtime anywhere (agentRuntime.id "codex").
 * A custom OpenAI-compatible base URL is allowed.
 */
export function runtimeRefused(
  provider: string | undefined,
  config: unknown,
): boolean {
  const p = provider ? lower(provider) : "";
  if (REFUSED_PROVIDERS.has(p)) return true;
  if (config !== undefined && configNamesCodexRuntime(config)) return true;
  if (p === "openai") {
    if (config === undefined) return true;
    return officialOpenAIBaseUrl(openaiProviderConfig(config)?.baseUrl);
  }
  return false;
}

/**
 * The key normalized as OpenClaw does it, keeping the case of provider-owned
 * opaque peer ids. Ported from normalizeSessionKeyPreservingOpaquePeerIds and
 * its helpers, session-key-utils-Bx3apsJ3.js:3-141 (OpenClaw 2026.6.5).
 */
const CASE_PRESERVING_PEERS = [
  { channel: "signal", peerKinds: ["group"], span: "segment", unscoped: true },
  {
    channel: "matrix",
    peerKinds: ["channel", "group"],
    span: "tail",
    unscoped: true,
  },
] as const;
const escapeRegExp = (v: string): string =>
  v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function collectCasePreservedSpans(raw: string) {
  const spans: { start: number; end: number; trim: boolean }[] = [];
  for (const d of CASE_PRESERVING_PEERS) {
    const channel = escapeRegExp(d.channel);
    for (const peerKind of d.peerKinds) {
      const kind = escapeRegExp(peerKind);
      if (d.span === "segment") {
        const re = new RegExp(`(^|:)${channel}:${kind}:([^:]+)`, "gi");
        for (const m of raw.matchAll(re)) {
          const matched = m[0] ?? "";
          const seg = m[2] ?? "";
          const start = (m.index ?? 0) + matched.length - seg.length;
          spans.push({ start, end: start + seg.length, trim: true });
        }
        continue;
      }
      const tail = (tailStart: number) => {
        if (tailStart >= raw.length) return;
        const marker = lower(raw.slice(tailStart)).lastIndexOf(":thread:");
        if (marker === -1) {
          spans.push({ start: tailStart, end: raw.length, trim: false });
          return;
        }
        spans.push({ start: tailStart, end: tailStart + marker, trim: false });
        const threadIdStart = tailStart + marker + 8;
        if (threadIdStart < raw.length)
          spans.push({ start: threadIdStart, end: raw.length, trim: false });
      };
      const scoped = new RegExp(`^agent:[^:]+:${channel}:${kind}:`, "i").exec(
        raw,
      );
      if (scoped) {
        tail(scoped[0].length);
        continue;
      }
      if (d.unscoped) {
        const un = new RegExp(`^${channel}:${kind}:`, "i").exec(raw);
        if (un) tail(un[0].length);
      }
    }
  }
  return spans;
}

export function normalizeSessionKey(sessionKey: string): string {
  const raw = sessionKey.trim();
  if (!raw) return "";
  const folded = raw.toLowerCase();
  if (!CASE_PRESERVING_PEERS.some((d) => folded.includes(`${d.channel}:`)))
    return folded;
  const spans = collectCasePreservedSpans(raw)
    .filter((sp) => sp.end > sp.start)
    .sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start < cursor) continue;
    out += lower(raw.slice(cursor, sp.start));
    const kept = raw.slice(sp.start, sp.end);
    out += sp.trim ? kept.trim() : kept;
    cursor = sp.end;
  }
  return out + lower(raw.slice(cursor));
}

/**
 * A name as typed, like Pi's (#1703): control characters stripped, trimmed, cut
 * to 64 without splitting a surrogate pair; the kind when nothing is left. The
 * hub's own name rules do the rest. Never lowercased: only the identity key is.
 */
export function nameOf(title: string, kind = "openclaw"): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  let cut = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  cut = cut.slice(0, 64);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = (cut as string & { toWellFormed(): string }).toWellFormed().trim();
  return cut || kind;
}

export const refusal = {
  noKey:
    "oa-bus: OpenClaw did not say which session made this call, so it cannot be placed on the bus.",
  badKey:
    "oa-bus: only the main session and direct chats are on the bus; this session is not one of them.",
  subagent:
    "oa-bus: a subagent is not on the bus; only the main OpenClaw session can use Open Artifacts bus.",
  acp: "oa-bus: an ACP session is not on the bus.",
  cron: "oa-bus: a cron run is not on the bus.",
  trigger:
    "oa-bus: only a run started by a user message is on the bus, not a scheduled or automatic one.",
  runtime: "oa-bus: this model runtime is not supported on the bus yet.",
};

/** Peer kinds that are never a direct chat (buildAgentPeerSessionKey, session-key-B_NoIfpX.js:118-130). */
const NOT_DIRECT = new Set(["group", "channel", "room", "thread"]);

/**
 * Whether the part of a key after `agent:<id>:` is the main session or a
 * direct chat. An allowlist over the shapes buildAgentPeerSessionKey makes
 * (session-key-B_NoIfpX.js:100-130, OpenClaw 2026.6.5):
 *   <mainKey>                                 the main session (default "main")
 *   direct:<peer>                             dmScope per-peer
 *   <channel>:direct:<peer>                   dmScope per-channel-peer
 *   <channel>:<account>:direct:<peer>         dmScope per-account-channel-peer
 * Groups, channels and rooms are `<channel>:<group|channel|...>:<peer>`, and a
 * thread adds `:thread:<id>`: none of them match. In v1 only these are on the
 * bus, so a third party in a group cannot drive send_message, and peer mail
 * is never injected into a group.
 */
export function directShape(rest: string, mainKey = "main"): boolean {
  if (rest.includes(":thread:")) return false;
  const parts = rest.split(":");
  const peer = (from: number) => parts.slice(from).join(":").length > 0;
  if (parts.length === 1)
    return parts[0] === "main" || parts[0] === lower(mainKey);
  if (parts[0] === "direct") return peer(1);
  if (parts[1] === "direct")
    return !NOT_DIRECT.has(parts[0] as string) && peer(2);
  if (parts[2] === "direct")
    return (
      !NOT_DIRECT.has(parts[0] as string) &&
      !NOT_DIRECT.has(parts[1] as string) &&
      peer(3)
    );
  return false;
}

export type ResolveOpts = {
  /** Hooks carry ctx.trigger; a tool factory has none. */
  needTrigger: boolean;
  /**
   * Whether the model route may refuse the root. At prompt time and for tools;
   * never for the ack hooks, so a mid-run fallback to another runtime keeps
   * its ack (those resolve by session key only).
   */
  runtime: boolean;
  /** The OpenClaw config, when known (the stock-openai rule and session.mainKey). */
  config?: unknown;
};

/**
 * Which bus agent a call belongs to, or why it is none. Refused, never guessed:
 * a wrong root would be a second agent on the bus.
 */
export function resolveRoot(
  c: Caller,
  stateDir: string,
  opts: ResolveOpts,
): Resolved {
  const raw = c.sessionKey;
  if (typeof raw !== "string" || raw.trim() === "")
    return { ok: false, reason: refusal.noKey };
  const key = normalizeSessionKey(raw);
  if (key.includes(":subagent:"))
    return { ok: false, reason: refusal.subagent };
  if (key.includes(":acp:")) return { ok: false, reason: refusal.acp };
  if (key.includes(":cron:")) return { ok: false, reason: refusal.cron };
  const m = /^agent:([^:]+):(.+)$/.exec(key);
  const cfg = opts.config;
  const mainKey =
    isObj(cfg) && isObj(cfg.session) && typeof cfg.session.mainKey === "string"
      ? cfg.session.mainKey
      : "main";
  if (!m || !directShape(m[2] as string, mainKey))
    return { ok: false, reason: refusal.badKey };
  if (opts.needTrigger && c.trigger !== "user")
    return { ok: false, reason: refusal.trigger };
  if (opts.runtime && runtimeRefused(c.modelProviderId, cfg))
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
  // The display name keeps the key's own case; the ref above does not.
  const shown = /^agent:([^:]+):(.+)$/i.exec(raw.trim());
  const name = nameOf(
    tail === "main"
      ? `openclaw-${shown?.[1] ?? agentId}`
      : `openclaw-${shown?.[1] ?? agentId}-${shown?.[2] ?? tail}`,
  );
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
