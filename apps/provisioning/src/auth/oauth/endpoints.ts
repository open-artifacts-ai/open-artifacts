import { ipKey } from "@oa/auth-core";
import {
  OAUTH_CLIENT_TTL_MS,
  OAUTH_CLIENT_UNCLAIMED_MS,
} from "@oa/shared/provisioning/constants";
import type { Env } from "../../env.js";
import { limit } from "../../limits.js";
import { countRefusal } from "../../refuse.js";
import {
  oauthLabel,
  revokeClientGrants,
  revokeGrantRow,
} from "../../services/tokens.js";
import { bump } from "../counters.js";
import { hmac16 } from "../crypto.js";
import { oauthAudit } from "./audit.js";
import { authServer, redirectHosts, revokeLibraryGrants } from "./server.js";

// The api-host AS endpoints in front of the library (design v7 9A.3.1,
// 9A.7): RL_PV_OAUTH_IP by ipKey, the 16 KiB body cap, the DCR per-IP daily
// cap and the MCP client sweep (also hourly by cron), and the oauth_clients bookkeeping the
// scheduler's oauth_register_flood alert reads.

/** Token and registration bodies are small (9A.7). */
export const MAX_OAUTH_BODY = 16 * 1024;
/** DCR registrations per ipKey per UTC day (4.7). */
export const DCR_PER_IP_PER_DAY = 10;
const DAY_MS = 86_400_000;
/** At most this many per registration. */
export const SWEEP_BATCH = 10;
/** Per batch in the hourly cron. */
export const CRON_SWEEP_BATCH = 50;

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
  const revoking = await revocationOf(r, env);
  const res = await authServer(env).fetch(r, env, ctx);
  if (revoking && res.status === 200) await endRevokedGrant(env, revoking);
  return res;
}

/**
 * An RFC 7009 request (no grant_type, as the library tells them apart)
 * whose token names a grant KV holds for the requesting client. The library
 * answers 200 for every token (foreign and garbage ones too), so only a
 * grant that was there before, and is gone after, was its revoke.
 */
type Revocation = { grantId: string; oauthUser: string; clientId: string };
async function revocationOf(r: Request, env: Env): Promise<Revocation | null> {
  if (
    !(r.headers.get("content-type") ?? "").startsWith(
      "application/x-www-form-urlencoded",
    )
  )
    return null;
  let f: URLSearchParams;
  try {
    f = new URLSearchParams(await r.clone().text());
  } catch {
    return null;
  }
  const token = f.get("token");
  if (f.get("grant_type") || !token) return null;
  const [oauthUser, grantId, secret, extra] = token.split(":");
  if (!oauthUser || !grantId || !secret || extra !== undefined) return null;
  const clientId = requestClientId(r, f);
  if (!clientId) return null;
  const g = await env.OAUTH_KV.get<{ clientId?: unknown }>(
    `grant:${oauthUser}:${grantId}`,
    "json",
  );
  return g?.clientId === clientId ? { grantId, oauthUser, clientId } : null;
}

/** The client of a token-endpoint request: Basic auth, else the form's client_id. */
function requestClientId(r: Request, f: URLSearchParams): string | null {
  const auth = r.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const id = atob(auth.slice(6).trim()).split(":")[0];
      return id ? decodeURIComponent(id) : null;
    } catch {
      return null;
    }
  }
  return f.get("client_id") || null;
}

/**
 * After the library answered a revocation: when the grant it named is now
 * gone from KV (a refresh token ends the grant; an access token alone does
 * not), its D1 row is revoked too, if that client's.
 */
async function endRevokedGrant(env: Env, g: Revocation): Promise<void> {
  if ((await env.OAUTH_KV.get(`grant:${g.oauthUser}:${g.grantId}`)) !== null)
    return;
  await revokeGrantRow(env, g);
}

/** Gives back a slot bump reserved in `key`'s current window. */
const refund = (env: Env, key: string, now: number) =>
  env.PLATFORM_DB.prepare(
    "UPDATE rate_counters SET count = count - 1 WHERE key = ?1 AND window_start = ?2 AND count > 0",
  )
    .bind(key, now - (now % DAY_MS))
    .run()
    .catch(() => null);

const dcrKey = async (env: Env, ip: string) =>
  `dcr:${await hmac16(env.ADMIN_SESSION_KEY, `dcr\n${ip}`)}`;

/**
 * The one MCP client sweep (8.3, 9A.7), from each /oauth/register (up to
 * SWEEP_BATCH) and the hourly cron: a client that never completed a grant
 * within OAUTH_CLIENT_UNCLAIMED_MS, and any client older than
 * OAUTH_CLIENT_TTL_MS. Its live grants end first (D1 row with token.revoke,
 * then the KV grant), then the KV client and its row, audited
 * `oauth.client_expired`. Idempotent: a swept client has no row left.
 */
export async function sweepOAuthClients(
  env: Env,
  now: number = Date.now(),
  batch: number = SWEEP_BATCH,
): Promise<number> {
  const { results } = await env.PLATFORM_DB.prepare(
    `SELECT client_id, client_name, first_grant_at FROM oauth_clients
     WHERE (first_grant_at IS NULL AND registered_at < ?1) OR registered_at < ?2
     ORDER BY registered_at LIMIT ?3`,
  )
    .bind(now - OAUTH_CLIENT_UNCLAIMED_MS, now - OAUTH_CLIENT_TTL_MS, batch)
    .all<{
      client_id: string;
      client_name: string;
      first_grant_at: number | null;
    }>();
  const oauth = authServer(env).getOAuthApi(env);
  let done = 0;
  for (const c of results) {
    const grants = await revokeClientGrants(env, c.client_id, now);
    await revokeLibraryGrants(env, grants);
    await oauth.deleteClient(c.client_id);
    const del = await env.PLATFORM_DB.prepare(
      "DELETE FROM oauth_clients WHERE client_id = ?1",
    )
      .bind(c.client_id)
      .run();
    // A concurrent sweep already took it: one audit row per client.
    if ((del.meta.changes ?? 0) === 0) continue;
    await oauthAudit(
      env,
      {
        action: "oauth.client_expired",
        actor: { kind: "system", label: "sweep" },
        outcome: "ok",
        detail: {
          clientId: c.client_id,
          clientName: c.client_name,
          reason: c.first_grant_at === null ? "unclaimed" : "expired",
          grantsRevoked: grants.length,
        },
      },
      now,
    );
    done++;
  }
  return done;
}

/** Cron: sweep in batches until none is due, at most 10 batches a run. */
export async function sweepOAuthClientsAll(
  env: Env,
  now: number = Date.now(),
): Promise<number> {
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const n = await sweepOAuthClients(env, now, CRON_SWEEP_BATCH);
    total += n;
    if (n < CRON_SWEEP_BATCH) break;
  }
  return total;
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
  const r = await capped(req);
  if (!r) return tooLarge();
  const now = Date.now();
  const key = await dcrKey(env, ip);
  // Reserve the slot atomically, so concurrent registrations cannot all
  // pass a read; a refused attempt gives it back (it does not spend the cap).
  if ((await bump(env.PLATFORM_DB, key, DAY_MS, now)) > DCR_PER_IP_PER_DAY) {
    await refund(env, key, now);
    await count(env, "oauth_register", "rate_limited", ip);
    return oauthError(
      429,
      "temporarily_unavailable",
      "Registration limit reached; try tomorrow",
    );
  }
  let res: Response;
  try {
    await sweepOAuthClients(env, now);
    res = await authServer(env).fetch(r, env, ctx);
  } catch (e) {
    await refund(env, key, now);
    throw e;
  }
  if (res.status !== 201) {
    await refund(env, key, now);
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
    const uris = Array.isArray(c.redirect_uris)
      ? c.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    try {
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
    } catch (e) {
      // No oauth_clients row: the sweep, the flood count and this cap would
      // never see the client, so it must not stay in KV either.
      await authServer(env).getOAuthApi(env).deleteClient(c.client_id);
      await refund(env, key, now);
      throw e;
    }
  }
  return res;
}
