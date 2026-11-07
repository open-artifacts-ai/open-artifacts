// Server-issued `Mcp-Session-Id`, for legacy-era clients only (#539 viewer
// presence). The 2025 handshake defines protocol-level sessions; MCP
// 2026-07-28 removed them and says a server receiving the header should ignore
// it and must not mint or echo a session id. The SDK's stateless handler
// can't issue one, so it is added here, outside the SDK. Tools never see the
// raw header: `withMcpSession` hands them the verified random part.

import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { type AgentAttr, viaKey } from "../services/agent-usage.js";
import { b64urlEncode, hmacSign } from "../util/crypto.js";

export const MCP_SESSION_HEADER = "Mcp-Session-Id";
const PROTOCOL_HEADER = "MCP-Protocol-Version";
/** The protocol revisions that define `Mcp-Session-Id`. */
export const LEGACY_SESSION_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
] as const;
const MODERN_VERSION = "2026-07-28";
const ENVELOPE_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SESSION_MAX = 128;
/** An initialize body is tiny; past this a headerless request is not read for its era. */
const PEEK_MAX_BYTES = 16 * 1024;

const first = (body: unknown): unknown =>
  Array.isArray(body) ? body[0] : body;
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

/**
 * "modern" when the request is the 2026-07-28 era: its `MCP-Protocol-Version`
 * header (the SDK requires it on every modern request POST) or its body's
 * per-request `_meta` envelope says so; otherwise "legacy".
 */
export function mcpEra(req: Request, body: unknown): "legacy" | "modern" {
  if (req.headers.get(PROTOCOL_HEADER) === MODERN_VERSION) return "modern";
  const params = asRecord(asRecord(first(body))?.params);
  const claimed = asRecord(params?._meta)?.[ENVELOPE_VERSION_KEY];
  return typeof claimed === "string" ? "modern" : "legacy";
}

const sign = async (
  env: Pick<Env, "SESSION_SECRET">,
  userId: string,
  rand: string,
) =>
  (
    await hmacSign(await deriveKey(env, "oa:mcp-session"), `${userId}\0${rand}`)
  ).slice(0, 16);

/** `ms_<22 random base64url>.<16 char hmac>`, bound to the user. */
export async function issueMcpSession(
  env: Pick<Env, "SESSION_SECRET">,
  userId: string,
): Promise<string> {
  const rand = `ms_${b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))}`;
  return `${rand}.${await sign(env, userId, rand)}`;
}

/**
 * The random part of a session id issued to `userId`, or null (absent, over
 * 128 characters, malformed, another user's or tampered).
 */
export async function verifyMcpSession(
  env: Pick<Env, "SESSION_SECRET">,
  userId: string,
  value: string | null,
): Promise<string | null> {
  if (value === null || value.length > SESSION_MAX) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const rand = value.slice(0, dot);
  const got = value.slice(dot + 1);
  if (!rand.startsWith("ms_")) return null;
  const want = await sign(env, userId, rand);
  if (got.length !== want.length) return null;
  // Constant time over the whole value.
  let diff = 0;
  for (let i = 0; i < want.length; i++)
    diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 ? rand : null;
}

/** The legacy-era initialize this request is, if it is one of a supported revision. */
const isLegacyInitialize = (body: unknown): boolean => {
  const m = asRecord(body);
  if (!m || m.method !== "initialize") return false;
  const v = asRecord(m.params)?.protocolVersion;
  return (
    typeof v === "string" &&
    (LEGACY_SESSION_VERSIONS as readonly string[]).includes(v)
  );
};

/** The request's JSON body when its era is not already settled by a header; null otherwise. */
async function peekBody(req: Request): Promise<unknown> {
  if (req.method !== "POST" || !req.body) return null;
  if (Number(req.headers.get("content-length") ?? 0) > PEEK_MAX_BYTES)
    return null;
  try {
    return JSON.parse(await req.clone().text());
  } catch {
    return null;
  }
}

/**
 * Runs `run` with the request's verified session (null when none).
 * - modern era: session null, any incoming `Mcp-Session-Id` ignored, and the
 *   response never carries one;
 * - legacy era: the request's header is verified for `userId`; an
 *   `initialize` of a legacy revision gets a fresh id added to the response
 *   headers. Nothing else issues one.
 */
export async function withMcpSession(
  req: Request,
  env: Env,
  userId: string,
  run: (session: string | null) => Promise<Response>,
): Promise<Response> {
  // A header settles the era without reading the body (a publish can be
  // megabytes); an initialize carries none and is small.
  const header = req.headers.get(PROTOCOL_HEADER);
  const body = header === null ? await peekBody(req) : null;
  if (mcpEra(req, body) === "modern") return run(null);
  const session = await verifyMcpSession(
    env,
    userId,
    req.headers.get(MCP_SESSION_HEADER),
  );
  const res = await run(session);
  if (!isLegacyInitialize(body) || !res.ok) return res;
  const out = new Response(res.body, res);
  out.headers.set(MCP_SESSION_HEADER, await issueMcpSession(env, userId));
  return out;
}

/**
 * Which connection an MCP request belongs to when the client sent no session:
 * `t:<tokenId>` (a PAT), `g:<grantId>` (an OAuth grant) or, for a grant with
 * no parseable id, `c:<userId>` (one face for that user's grantless
 * connections).
 */
export const connectionOf = (
  agent: AgentAttr | null,
  userId: string,
): string => (agent?.via ? viaKey(agent.via) : `c:${userId}`);
