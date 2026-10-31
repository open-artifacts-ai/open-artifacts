import { ipKey } from "@oa/auth-core";
import type { Env } from "../../env.js";
import { limit } from "../../limits.js";
import { countRefusal } from "../../refuse.js";
import { oauthLabel } from "../../services/tokens.js";
import { bump, peek } from "../counters.js";
import { hmac16 } from "../crypto.js";
import { authServer, redirectHosts } from "./server.js";

// The api-host AS endpoints in front of the library (design v7 9A.3.1,
// 9A.7): RL_PV_OAUTH_IP by ipKey, the 16 KiB body cap, the DCR per-IP daily
// cap and the unclaimed-client sweep, and the oauth_clients bookkeeping the
// scheduler's oauth_register_flood alert reads.

/** Token and registration bodies are small (9A.7). */
export const MAX_OAUTH_BODY = 16 * 1024;
/** DCR registrations per ipKey per UTC day (4.7). */
export const DCR_PER_IP_PER_DAY = 10;
const DAY_MS = 86_400_000;
/** Unclaimed clients older than this are swept (8.3). */
export const UNCLAIMED_CLIENT_MS = DAY_MS;
/** At most this many per registration. */
export const SWEEP_BATCH = 10;

/** RFC 6749 5.2 error body. */
export const oauthError = (
  status: number,
  error: string,
  description: string,
) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(status === 429 ? { "retry-after": "60" } : {}),
    },
  });

async function count(
  env: Env,
  bucket: "oauth" | "oauth_register",
  code: string,
  ip: string,
) {
  try {
    await countRefusal(env, bucket, code, ip);
  } catch {
    // The refusal stands without its count.
  }
}

/** RL_PV_OAUTH_IP by ipKey; unbound fails closed (503). */
async function ipLimited(
  env: Env,
  ip: string,
  bucket: "oauth" | "oauth_register",
): Promise<Response | null> {
  const r = await limit(env, "oauth_ip", ip);
  if (!r) return null;
  await count(env, bucket, r.code, ip);
  return r.code === "rate_limited"
    ? oauthError(
        429,
        "temporarily_unavailable",
        "Too many requests; try again in a minute",
      )
    : oauthError(503, "temporarily_unavailable", "Temporarily unavailable");
}

/** The body, at most MAX_OAUTH_BODY bytes, re-attached; null when over. */
export async function capped(req: Request): Promise<Request | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared))
    return Number(declared) > MAX_OAUTH_BODY ? null : req;
  const reader = req.body?.getReader();
  if (!reader) return req;
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_OAUTH_BODY) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const body = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    body.set(p, o);
    o += p.byteLength;
  }
  return new Request(req, { body });
}

const tooLarge = () =>
  oauthError(413, "invalid_request", "Request body is too large");

/** POST /oauth/token (code, refresh, RFC 7009 revocation). */
export async function tokenEndpoint(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const ip = ipKey(req);
  const lim = await ipLimited(env, ip, "oauth");
  if (lim) return lim;
  const r = await capped(req);
  if (!r) return tooLarge();
  return authServer(env).fetch(r, env, ctx);
}

const dcrKey = async (env: Env, ip: string) =>
  `dcr:${await hmac16(env.ADMIN_SESSION_KEY, `dcr\n${ip}`)}`;

/**
 * Deletes up to SWEEP_BATCH clients that never completed a grant within a
 * day, from KV and D1 (install pattern, apps/server/src/mcp/registrations.ts).
 */
export async function sweepUnclaimedClients(
  env: Env,
  now: number = Date.now(),
): Promise<number> {
  const { results } = await env.PLATFORM_DB.prepare(
    `SELECT client_id FROM oauth_clients WHERE first_grant_at IS NULL AND registered_at < ?1
     ORDER BY registered_at LIMIT ?2`,
  )
    .bind(now - UNCLAIMED_CLIENT_MS, SWEEP_BATCH)
    .all<{ client_id: string }>();
  const oauth = authServer(env).getOAuthApi(env);
  let done = 0;
  for (const { client_id } of results) {
    await oauth.deleteClient(client_id);
    await env.PLATFORM_DB.prepare(
      "DELETE FROM oauth_clients WHERE client_id = ?1 AND first_grant_at IS NULL",
    )
      .bind(client_id)
      .run();
    done++;
  }
  return done;
}

/** POST /oauth/register (RFC 7591 DCR). */
export async function registerEndpoint(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const ip = ipKey(req);
  const lim = await ipLimited(env, ip, "oauth_register");
  if (lim) return lim;
  const now = Date.now();
  const key = await dcrKey(env, ip);
  // Read only: refused attempts do not spend the day's cap.
  if ((await peek(env.PLATFORM_DB, key, DAY_MS, now)) >= DCR_PER_IP_PER_DAY) {
    await count(env, "oauth_register", "rate_limited", ip);
    return oauthError(
      429,
      "temporarily_unavailable",
      "Registration limit reached; try tomorrow",
    );
  }
  const r = await capped(req);
  if (!r) return tooLarge();
  await sweepUnclaimedClients(env, now);
  const res = await authServer(env).fetch(r, env, ctx);
  if (res.status !== 201) {
    let code = "invalid_client_metadata";
    try {
      const e = ((await res.clone().json()) as { error?: unknown }).error;
      if (typeof e === "string" && /^[a-z_]{1,40}$/.test(e)) code = e;
    } catch {
      // Not JSON: keep the default code.
    }
    await count(env, "oauth_register", code, ip);
    return res;
  }
  const c = (await res.clone().json()) as {
    client_id?: unknown;
    client_name?: unknown;
    redirect_uris?: unknown;
  };
  if (typeof c.client_id === "string") {
    await bump(env.PLATFORM_DB, key, DAY_MS, now);
    const uris = Array.isArray(c.redirect_uris)
      ? c.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    await env.PLATFORM_DB.prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_hosts, ip_hmac, registered_at)
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (client_id) DO NOTHING`,
    )
      .bind(
        c.client_id,
        oauthLabel(typeof c.client_name === "string" ? c.client_name : null),
        JSON.stringify(redirectHosts(uris)),
        await hmac16(env.ADMIN_SESSION_KEY, ip),
        now,
      )
      .run();
  }
  return res;
}
