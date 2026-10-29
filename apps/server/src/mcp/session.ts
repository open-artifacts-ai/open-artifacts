import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { b64urlEncode, hmacSign } from "../util/crypto.js";

/**
 * Server-issued MCP session ids, for legacy-era clients only.
 *
 * The legacy revisions (2025-03-26 through 2025-11-25) define Mcp-Session-Id,
 * assigned at initialize. MCP 2026-07-28 removed protocol-level sessions: a
 * server receiving Mcp-Session-Id should ignore it and must not mint or echo
 * one. Our handler is stateless (the SDK ignores the header), so the header is
 * issued and verified here, outside the SDK. Tools never see the raw header:
 * only the verified random part, bound to the user by an HMAC.
 */

export const MCP_SESSION_HEADER = "Mcp-Session-Id";

/** The protocol revisions that define Mcp-Session-Id. */
export const LEGACY_SESSION_VERSIONS: readonly string[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];

const MODERN_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const MAX_SESSION_LEN = 128;
const SESSION = /^ms_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** True when one JSON-RPC message carries the 2026-07-28 per-request envelope. */
const hasEnvelope = (m: unknown): boolean => {
  const meta = isObj(m) && isObj(m.params) ? m.params._meta : undefined;
  return isObj(meta) && PROTOCOL_VERSION_META in meta;
};

/**
 * "modern" when the MCP-Protocol-Version header names 2026-07-28 (required on
 * every modern request POST) or any message in the body carries the
 * per-request `_meta` envelope; otherwise "legacy".
 */
export function mcpEra(req: Request, body: unknown): "legacy" | "modern" {
  if (req.headers.get("mcp-protocol-version")?.trim() === MODERN_VERSION)
    return "modern";
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some(hasEnvelope) ? "modern" : "legacy";
}

const sign = async (env: Pick<Env, "SESSION_SECRET">, u: string, r: string) =>
  (await hmacSign(await deriveKey(env, "oa:mcp-session"), `${u}\0${r}`)).slice(
    0,
    16,
  );

/** `ms_<22 random base64url>.<hmac16>`, bound to `userId`. */
export async function issueMcpSession(
  env: Pick<Env, "SESSION_SECRET">,
  userId: string,
): Promise<string> {
  const random = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  return `ms_${random}.${await sign(env, userId, random)}`;
}

/** Equal-length strings compared without an early exit. */
const sameString = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** The random part, or null when absent, over 128 chars, malformed or not signed for `userId`. */
export async function verifyMcpSession(
  env: Pick<Env, "SESSION_SECRET">,
  userId: string,
  value: string | null,
): Promise<string | null> {
  if (!value || value.length > MAX_SESSION_LEN) return null;
  const m = SESSION.exec(value);
  if (!m?.[1] || !m[2]) return null;
  return sameString(m[2], await sign(env, userId, m[1])) ? m[1] : null;
}

/** The parsed body of a capped request, read from a clone (undefined if none or not JSON). */
async function bodyOf(req: Request): Promise<unknown> {
  if (!req.body) return undefined;
  try {
    return JSON.parse(await req.clone().text());
  } catch {
    return undefined;
  }
}

/** A single legacy JSON-RPC initialize naming a revision that defines sessions. */
const isLegacyInitialize = (body: unknown): boolean => {
  if (!isObj(body) || Array.isArray(body)) return false;
  const v = isObj(body.params) ? body.params.protocolVersion : undefined;
  return (
    body.method === "initialize" &&
    typeof v === "string" &&
    LEGACY_SESSION_VERSIONS.includes(v)
  );
};

/** `res` with Mcp-Session-Id set to `sid` (or removed when null). */
function withHeader(res: Response, sid: string | null): Response {
  if (sid === null && !res.headers.has(MCP_SESSION_HEADER)) return res;
  const out = new Response(res.body, res);
  if (sid === null) out.headers.delete(MCP_SESSION_HEADER);
  else out.headers.set(MCP_SESSION_HEADER, sid);
  return out;
}

/**
 * Runs an MCP request with its verified session (`req` is the capped request;
 * its body is read from a clone). Modern era: session null, any incoming
 * header ignored, never one on the response. Legacy era: the request header
 * verified for `userId`; a fresh id on the response of a single legacy
 * initialize that succeeded.
 */
export async function withMcpSession(
  req: Request,
  env: Env,
  userId: string,
  run: (session: string | null) => Promise<Response>,
): Promise<Response> {
  // The header alone settles the modern era: no need to parse the body.
  const body =
    mcpEra(req, undefined) === "modern" ? undefined : await bodyOf(req);
  if (mcpEra(req, body) === "modern") return withHeader(await run(null), null);
  const session = await verifyMcpSession(
    env,
    userId,
    req.headers.get(MCP_SESSION_HEADER),
  );
  const res = await run(session);
  const issued =
    res.ok && isLegacyInitialize(body)
      ? await issueMcpSession(env, userId)
      : null;
  return withHeader(res, issued);
}
