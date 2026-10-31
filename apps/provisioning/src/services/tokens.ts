import { normalizeEmail } from "@oa/auth-core";
import {
  type RouteId,
  type Token,
  type TokenKind,
  type TokenScope,
  TokenScopeSchema,
} from "@oa/shared/provisioning";
import { hmac16, sameString, sha256Hex } from "../auth/crypto.js";
import { isAdminIdentity } from "../auth/identities.js";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { countD1, D1_LIMITS } from "../limits.js";
import type { Principal, Refusal } from "../principal.js";
import { countRateLimited } from "../refuse.js";
import type { Surface } from "../routes/invoke.js";
import { ulid } from "../ulid.js";

// The one token service for both kinds (design v7 9A.4): R19 and the MCP
// consent mint through mintAgentToken; authenticate() (both bearer kinds)
// and the OAuth refresh callback check through tokenPrincipal. No other
// module inserts into agent_tokens (test/node/layout.test.ts). W5b builds
// both bodies.
//
// These signatures are the 9A.4 contract (amended to match): both take `env`
// (this app has no global env; mintAgentToken's is first, like
// invokeRoute's), tokenPrincipal takes the session as nullable (a missing
// row is a refusal, not a caller's branch), and it takes the expected token
// kind as a fourth argument: the caller names the path (authenticate()'s
// `oat_` bearer: "oat"; `/mcp` and the refresh callback: "oauth"), and a row
// of the other kind is refused `wrong_kind` before any other check.

/** At most this many live tokens per admin, both kinds together (4.1). */
export const TOKEN_LIVE_LIMIT = 5;
/** oat lifetimes (4.1): 15 min default (the R19 schema), 5 to 60. */
export const OAT_TTL_MIN_MINUTES = 5;
export const OAT_TTL_MAX_MINUTES = 60;
/** An OAuth grant chain ends with the admin session, at most 8 h (Q3). */
export const OAUTH_GRANT_MAX_MS = 8 * 3_600_000;
/** OAuth access tokens (the library's accessTokenTTL, W13b): 15 minutes. */
export const OAUTH_ACCESS_TTL_S = 15 * 60;
/** `oat_` + 32 random bytes, base64url (43 chars). */
export const OAT_RE = /^oat_[A-Za-z0-9_-]{43}$/;
const OAUTH_LABEL_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const MINUTE = 60_000;

/** An agent_tokens row (0008). */
export type AgentTokenRow = {
  id: string;
  kind: TokenKind;
  /** oat only. */
  token_hash: string | null;
  session_hash: string;
  admin_email: string;
  label: string;
  /** JSON array of TokenScope. */
  scopes: string;
  /** oauth only. */
  client_id: string | null;
  client_name: string | null;
  /** oauth only: the library userId (`adm_<hex>`), never an email. */
  oauth_user: string | null;
  /** oauth only: set at code exchange. */
  grant_id: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
};

/** A sessions row (0008). */
export type SessionRow = {
  id_hash: string;
  kind: "admin" | "user";
  host: string;
  email: string;
  sub: string;
  auth_at: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
};

export type MintOpts =
  | {
      kind: "oat";
      scopes: readonly TokenScope[];
      label: string;
      ttlMinutes: number;
      /**
       * R19's body requestId. The replay check lives here, in the same D1
       * batch as the insert, so two concurrent retries cannot both mint.
       * 3.1 defines replay for jobs only; W5b fixes a token replay's answer
       * (never the bearer a second time).
       */
      requestId: string;
    }
  | {
      kind: "oauth";
      scopes: readonly TokenScope[];
      clientId: string;
      /** DCR `client_name` is optional (TokenSchema.clientName nullable). */
      clientName: string | null;
    };

/**
 * An `oauth` row whose D1 revoke must also end its library grant in
 * OAUTH_KV (3.4 R21, 4.6): the library's `revokeGrant(grantId, userId)`.
 * W13b owns that KV revoke (src/auth/oauth, one function for R21, R24 and a
 * superseding consent); the token service only returns the grants. The
 * per-call D1 check refuses the token either way.
 */
export type RevokedGrant = { grantId: string; oauthUser: string };
const GRANTS_SELECT =
  'SELECT grant_id AS "grantId", oauth_user AS "oauthUser" FROM agent_tokens';

/**
 * oat: the bearer, shown once. oauth: the library userId for
 * completeAuthorization (9A.4), and the older grants of the same client this
 * consent revoked in D1 (4.6), for the consent path to end in KV.
 */
export type Minted = {
  tokenId: string;
  expiresAt: number;
  token?: string;
  oauthUser?: string;
  superseded?: RevokedGrant[];
};

/** An `oauth` row's label (9A.3.3): the DCR client_name if it fits, else `unnamed`. */
export const oauthLabel = (clientName: string | null) =>
  clientName !== null && OAUTH_LABEL_RE.test(clientName)
    ? clientName
    : "unnamed";

const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** The bearer's stored form: sha256 hex (agent_tokens.token_hash). */
export const tokenHash = (bearer: string) => sha256Hex(bearer);

/** ADMIN_IDENTITIES still lists this `(email, sub)` (W5a's matcher). */
const listed = (
  env: Pick<Env, "ADMIN_IDENTITIES">,
  email: string,
  sub: string,
) => isAdminIdentity(env.ADMIN_IDENTITIES, normalizeEmail(email) ?? "", sub);

/**
 * The live session behind an admin principal, re-read from D1: the row its
 * `session.hash` (W5a's PrincipalSession) names, of kind admin, not revoked, unexpired, for the same
 * `(email, sub)`, which is still in ADMIN_IDENTITIES.
 */
async function liveAdminSession(
  env: Env,
  p: Principal,
  now: number,
): Promise<SessionRow> {
  if (p.kind !== "admin") throw new ApiError("forbidden");
  const hash = p.session?.hash;
  if (!hash || !p.email || !p.sub) throw new ApiError("unauthenticated");
  const s = await env.PLATFORM_DB.prepare(
    "SELECT * FROM sessions WHERE id_hash = ?1",
  )
    .bind(hash)
    .first<SessionRow>();
  if (
    !s ||
    !sameString(s.id_hash, hash) ||
    s.kind !== "admin" ||
    s.revoked_at !== null ||
    s.expires_at <= now ||
    s.email.toLowerCase() !== p.email.toLowerCase() ||
    s.sub !== p.sub ||
    !listed(env, s.email, s.sub)
  )
    throw new ApiError("unauthenticated");
  return s;
}

const AUDIT_INSERT = `INSERT INTO admin_audit (at, actor_kind, actor_label, token_id, action, request_id, outcome, detail)`;

/**
 * Mints one token for an admin session principal: the per-admin mint counter
 * (4.7), the 5-live limit across both kinds (`token_limit`), and one D1 batch
 * (supersession of an older oauth row of the same client, the row, audit).
 * Throws `ApiError("token_limit")` (409) at the limit, which R19 renders and
 * the consent page detects; `rate_limited` over the mint counter;
 * `idempotency_conflict` (details.tokenId) on a replayed oat requestId,
 * which never shows a bearer twice; `forbidden` for any principal but an
 * admin session (tokens cannot mint tokens); `unauthenticated` when the
 * session has ended.
 */
export async function mintAgentToken(
  env: Env,
  principal: Principal,
  opts: MintOpts,
): Promise<Minted> {
  const now = Date.now();
  const s = await liveAdminSession(env, principal, now);
  const email = s.email;
  const requestId = opts.kind === "oat" ? opts.requestId : null;
  const clientId = opts.kind === "oauth" ? opts.clientId : null;
  const db = env.PLATFORM_DB;
  // Replays and token_limit answer before the mint counter, so they never
  // spend the admin's mint budget. The batch below re-checks both
  // atomically; this read only decides what to charge.
  if (requestId !== null) await refuseReplay(env, principal, email, requestId);
  const live = await db
    .prepare(
      `SELECT count(*) AS n FROM agent_tokens WHERE admin_email = ?1 AND revoked_at IS NULL AND expires_at > ?2 AND NOT (kind = 'oauth' AND client_id IS ?3)`,
    )
    .bind(email, now, clientId)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= TOKEN_LIVE_LIMIT) throw new ApiError("token_limit");
  const over = await countD1(
    env,
    `mint:${await hmac16(env.ADMIN_SESSION_KEY, `mint\n${email.toLowerCase()}`)}`,
    D1_LIMITS.mint.limit,
    D1_LIMITS.mint.windowMs,
    now,
  );
  if (over) {
    await countRateLimited(env, principal.rateKey);
    throw new ApiError(over.code);
  }

  const id = ulid(now);
  const scopes = JSON.stringify([...new Set(opts.scopes)]);
  let token: string | undefined;
  let oauthUser: string | undefined;
  let row: Omit<AgentTokenRow, "revoked_at" | "last_used_at">;
  if (opts.kind === "oat") {
    token = `oat_${b64u(crypto.getRandomValues(new Uint8Array(32)))}`;
    const ttl = Math.min(
      OAT_TTL_MAX_MINUTES,
      Math.max(OAT_TTL_MIN_MINUTES, Math.floor(opts.ttlMinutes)),
    );
    row = {
      id,
      kind: "oat",
      token_hash: await tokenHash(token),
      session_hash: s.id_hash,
      admin_email: email,
      label: opts.label,
      scopes,
      client_id: null,
      client_name: null,
      oauth_user: null,
      grant_id: null,
      created_at: now,
      expires_at: Math.min(s.expires_at, now + ttl * MINUTE),
    };
  } else {
    // Stable per admin, so the library can list one admin's grants; never
    // the email itself.
    oauthUser = `adm_${await hmac16(env.ADMIN_SESSION_KEY, `oauth_user\n${email.toLowerCase()}`)}`;
    const label = oauthLabel(opts.clientName);
    row = {
      id,
      kind: "oauth",
      token_hash: null,
      session_hash: s.id_hash,
      admin_email: email,
      label,
      scopes,
      client_id: opts.clientId,
      client_name: opts.clientName === null ? null : label,
      oauth_user: oauthUser,
      grant_id: null,
      created_at: now,
      expires_at: Math.min(s.expires_at, now + OAUTH_GRANT_MAX_MS),
    };
  }
  // oat: `token.mint` (4.9). oauth: `oauth.grant` with the 9A.8 fields; the
  // redirect host is not in the 9A.4 opts, so it is null until C4 adds it.
  const action = opts.kind === "oauth" ? "oauth.grant" : "token.mint";
  const detail = JSON.stringify(
    opts.kind === "oauth"
      ? {
          tokenId: id,
          clientId: opts.clientId,
          clientName: row.client_name,
          scopes: JSON.parse(scopes),
          redirectHost: null,
          grantEnd: row.expires_at,
        }
      : {
          tokenId: id,
          kind: row.kind,
          label: row.label,
          scopes: JSON.parse(scopes),
          expiresAt: row.expires_at,
        },
  );

  const stmts: D1PreparedStatement[] = [];
  if (opts.kind === "oauth") {
    // A newer consent of the same client ends the older grant (4.6). This
    // runs first, so a superseding consent always fits under the limit, and
    // only when the insert below will fit: the guard counts the live rows
    // other than this client's, as the insert does after this revoke, so a
    // concurrent mint that fills the limit leaves the old grant alone.
    const where = `WHERE admin_email = ?1 AND kind = 'oauth' AND client_id = ?2 AND revoked_at IS NULL
      AND (SELECT count(*) FROM agent_tokens WHERE admin_email = ?1 AND revoked_at IS NULL AND expires_at > ?3 AND NOT (kind = 'oauth' AND client_id = ?2)) < ?4`;
    stmts.push(
      db
        .prepare(`${GRANTS_SELECT} ${where} AND grant_id IS NOT NULL`)
        .bind(email, opts.clientId, now, TOKEN_LIVE_LIMIT),
      db
        .prepare(
          `${AUDIT_INSERT} SELECT ?3, 'admin', ?1, id, 'token.revoke', NULL, 'ok', json_object('tokenId', id, 'label', label, 'scopes', json(scopes), 'reason', 'superseded', 'supersededBy', ?5) FROM agent_tokens ${where}`,
        )
        .bind(email, opts.clientId, now, TOKEN_LIVE_LIMIT, id),
      db
        .prepare(`UPDATE agent_tokens SET revoked_at = ?3 ${where}`)
        .bind(email, opts.clientId, now, TOKEN_LIVE_LIMIT),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO agent_tokens (id, kind, token_hash, session_hash, admin_email, label, scopes, client_id, client_name, oauth_user, grant_id, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
         WHERE (SELECT count(*) FROM agent_tokens WHERE admin_email = ?5 AND revoked_at IS NULL AND expires_at > ?12) < ?14
           AND (?15 IS NULL OR NOT EXISTS (SELECT 1 FROM admin_audit WHERE action = 'token.mint' AND actor_label = ?5 AND request_id = ?15))
           AND (?15 IS NULL OR NOT EXISTS (SELECT 1 FROM jobs WHERE actor_key = ?16 AND request_id = ?15))`,
      )
      .bind(
        row.id,
        row.kind,
        row.token_hash,
        row.session_hash,
        row.admin_email,
        row.label,
        row.scopes,
        row.client_id,
        row.client_name,
        row.oauth_user,
        row.grant_id,
        row.created_at,
        row.expires_at,
        TOKEN_LIVE_LIMIT,
        requestId,
        principal.actorKey,
      ),
    db
      .prepare(
        `${AUDIT_INSERT} SELECT ?1, 'admin', ?2, ?3, ?6, ?4, 'ok', ?5 WHERE EXISTS (SELECT 1 FROM agent_tokens WHERE id = ?3)`,
      )
      .bind(now, email, id, requestId, detail, action),
  );
  const res = await db.batch(stmts);
  const inserted = res[stmts.length - 2]?.meta.changes ?? 0;
  if (inserted === 0) {
    if (requestId !== null)
      await refuseReplay(env, principal, email, requestId);
    throw new ApiError("token_limit");
  }
  return {
    tokenId: id,
    expiresAt: row.expires_at,
    ...(token ? { token } : {}),
    ...(oauthUser ? { oauthUser } : {}),
    ...(opts.kind === "oauth"
      ? { superseded: (res[0]?.results ?? []) as RevokedGrant[] }
      : {}),
  };
}

/**
 * R19's requestId is the admin's actorKey's, as on every write (3.1): one
 * already used for a mint (details.tokenId; the bearer is never shown twice)
 * or for a job is 409 `idempotency_conflict`.
 */
async function refuseReplay(
  env: Env,
  principal: Principal,
  email: string,
  requestId: string,
): Promise<void> {
  const db = env.PLATFORM_DB;
  const prior = await db
    .prepare(
      "SELECT token_id FROM admin_audit WHERE action = 'token.mint' AND actor_label = ?1 AND request_id = ?2",
    )
    .bind(email, requestId)
    .first<{ token_id: string }>();
  if (prior)
    throw new ApiError("idempotency_conflict", "idempotency_conflict", {
      tokenId: prior.token_id,
    });
  const job = await db
    .prepare("SELECT 1 FROM jobs WHERE actor_key = ?1 AND request_id = ?2")
    .bind(principal.actorKey, requestId)
    .first();
  if (job) throw new ApiError("idempotency_conflict");
}

/**
 * Why tokenPrincipal refused. authenticate() answers every one with 401
 * `unauthenticated`; the W13b refresh callback maps it onto the
 * `oauth.refresh_refused` audit reason (9A.8: `revoked`, `session_ended`,
 * `identity_removed`; `chain_ended` is the refresh TTL, which the library
 * enforces before this runs).
 */
export type TokenRefusalReason =
  | "wrong_kind"
  | "revoked"
  | "expired"
  | "session_ended"
  | "identity_removed";
export type TokenRefusal = Refusal & {
  code: "unauthenticated";
  reason: TokenRefusalReason;
};

/**
 * The token principal for a row and its minting session (9A.3.3): row of the
 * `expected` kind (else `wrong_kind`, checked first), not revoked, unexpired; session not revoked, unexpired; its
 * `(email, sub)` still in ADMIN_IDENTITIES. Any failure: unauthenticated,
 * with the reason.
 */
export function tokenPrincipal(
  row: AgentTokenRow,
  session: SessionRow | null,
  env: Pick<Env, "ADMIN_IDENTITIES">,
  expected: TokenKind,
): Principal | TokenRefusal {
  const no = (reason: TokenRefusalReason): TokenRefusal => ({
    refusal: true,
    code: "unauthenticated",
    reason,
  });
  if (row.kind !== expected) return no("wrong_kind");
  const now = Date.now();
  if (row.revoked_at !== null) return no("revoked");
  if (row.expires_at <= now) return no("expired");
  if (
    !session ||
    !sameString(session.id_hash, row.session_hash) ||
    session.kind !== "admin" ||
    session.revoked_at !== null ||
    session.expires_at <= now ||
    session.email.toLowerCase() !== row.admin_email.toLowerCase()
  )
    return no("session_ended");
  if (!listed(env, session.email, session.sub)) return no("identity_removed");
  return {
    kind: "token",
    actorKey: `token:${row.id}`,
    rateKey: `admin:${row.admin_email}`,
    label: row.label,
    scopes: rowScopes(row),
    email: row.admin_email,
    sub: session.sub,
    tokenId: row.id,
    tokenKind: row.kind,
    client: row.kind === "oauth" ? row.label : null,
    tokenExpiresAt: row.expires_at,
    authAt: null,
  };
}

/** The row's scopes; anything the enum does not know is dropped. */
function rowScopes(row: Pick<AgentTokenRow, "scopes">): TokenScope[] {
  let v: unknown;
  try {
    v = JSON.parse(row.scopes);
  } catch {
    return [];
  }
  return Array.isArray(v)
    ? v.filter((x): x is TokenScope => TokenScopeSchema.safeParse(x).success)
    : [];
}

async function principalWhere(
  env: Env,
  where: "id" | "token_hash",
  value: string,
  expected: TokenKind,
): Promise<Principal | TokenRefusal> {
  // Read on every call: KV grant revocation may lag, this D1 check does not.
  const row = await env.PLATFORM_DB.prepare(
    `SELECT * FROM agent_tokens WHERE ${where} = ?1`,
  )
    .bind(value)
    .first<AgentTokenRow>();
  // The lookup finds the row; the constant-time compare decides (4.1).
  if (
    !row ||
    (where === "token_hash" && !sameString(row.token_hash ?? "", value))
  )
    return { refusal: true, code: "unauthenticated", reason: "revoked" };
  const session = await env.PLATFORM_DB.prepare(
    "SELECT * FROM sessions WHERE id_hash = ?1",
  )
    .bind(row.session_hash)
    .first<SessionRow>();
  return tokenPrincipal(row, session, env, expected);
}

/** The `oauth` path (/mcp after validateToken, the refresh callback): by row id. */
export const principalByTokenId = (
  env: Env,
  tokenId: string,
  expected: TokenKind,
) => principalWhere(env, "id", tokenId, expected);

/** The `oat_` path: by the bearer's hash. A malformed bearer is `revoked`. */
export async function principalByBearer(
  env: Env,
  bearer: string,
): Promise<Principal | TokenRefusal> {
  if (!OAT_RE.test(bearer))
    return { refusal: true, code: "unauthenticated", reason: "revoked" };
  return principalWhere(env, "token_hash", await tokenHash(bearer), "oat");
}

/** R20 keeps a token this long after it ends (revoked or expired). */
export const TOKEN_LIST_KEEP_MS = 24 * 3_600_000;

/** A row as the API shows it (TokenSchema): never the hash or oauth_user. */
export const tokenView = (r: AgentTokenRow): Token => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  clientName: r.client_name,
  scopes: rowScopes(r),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
});

/** R20: this admin's tokens of both kinds, live or ended within 24 h, newest first. */
export async function listTokens(env: Env, email: string): Promise<Token[]> {
  const now = Date.now();
  const r = await env.PLATFORM_DB.prepare(
    `SELECT * FROM agent_tokens
     WHERE admin_email = ?1 AND min(expires_at, coalesce(revoked_at, expires_at)) > ?2
     ORDER BY created_at DESC, id DESC LIMIT 100`,
  )
    .bind(email, now - TOKEN_LIST_KEEP_MS)
    .all<AgentTokenRow>();
  return r.results.map(tokenView);
}

export async function getToken(
  env: Env,
  id: string,
): Promise<AgentTokenRow | null> {
  return env.PLATFORM_DB.prepare("SELECT * FROM agent_tokens WHERE id = ?1")
    .bind(id)
    .first<AgentTokenRow>();
}

/**
 * R21 with an id: revokes one of this admin's tokens (either kind) and
 * audits `token.revoke` in the same batch. Null when the admin has no such
 * token (404); revoking an ended token again is a no-op. The D1 row is what
 * every call checks, so an OAuth grant still in KV is refused at once; the
 * result is the grant to end in KV too (empty for oat).
 */
export async function revokeToken(
  env: Env,
  email: string,
  id: string,
): Promise<RevokedGrant[] | null> {
  const now = Date.now();
  const db = env.PLATFORM_DB;
  const where = "WHERE id = ?1 AND admin_email = ?2 AND revoked_at IS NULL";
  const res = await db.batch([
    db
      .prepare("SELECT 1 FROM agent_tokens WHERE id = ?1 AND admin_email = ?2")
      .bind(id, email),
    db
      .prepare(
        `${GRANTS_SELECT} ${where} AND kind = 'oauth' AND grant_id IS NOT NULL`,
      )
      .bind(id, email),
    db
      .prepare(
        `${AUDIT_INSERT} SELECT ?3, 'admin', ?2, id, 'token.revoke', NULL, 'ok', json_object('tokenId', id, 'kind', kind, 'label', label, 'scopes', json(scopes)) FROM agent_tokens ${where}`,
      )
      .bind(id, email, now),
    db
      .prepare(`UPDATE agent_tokens SET revoked_at = ?3 ${where}`)
      .bind(id, email, now),
  ]);
  if ((res[0]?.results.length ?? 0) === 0) return null;
  return (res[1]?.results ?? []) as RevokedGrant[];
}

/**
 * R21 without an id: revokes all of this admin's tokens, both kinds; one
 * `token.revoke_all` row. Returns the oauth grants to end in KV.
 */
export async function revokeAllTokens(
  env: Env,
  email: string,
): Promise<RevokedGrant[]> {
  const now = Date.now();
  const db = env.PLATFORM_DB;
  const where = "WHERE admin_email = ?1 AND revoked_at IS NULL";
  const res = await db.batch([
    db
      .prepare(
        `${GRANTS_SELECT} ${where} AND kind = 'oauth' AND grant_id IS NOT NULL`,
      )
      .bind(email),
    db
      .prepare(
        `${AUDIT_INSERT} VALUES (?2, 'admin', ?1, NULL, 'token.revoke_all', NULL, 'ok', json_object('count', (SELECT count(*) FROM agent_tokens ${where})))`,
      )
      .bind(email, now),
    db
      .prepare(`UPDATE agent_tokens SET revoked_at = ?2 ${where}`)
      .bind(email, now),
  ]);
  return (res[0]?.results ?? []) as RevokedGrant[];
}

/** `token.used` dedup window (4.1): one row per token per route per 10 min. */
export const TOKEN_USED_WINDOW_MS = 10 * 60_000;

/**
 * Records a token principal's use of a route after authz passed: the first
 * use per token, route and 10-minute window writes one `token.used` row
 * (detail: the minting admin, route, surface, `via` and `client`; MCP adds
 * tool and clientVersion, 9A.8) and bumps `last_used_at`. One D1 batch, so
 * concurrent first uses write one row. Other principals: nothing.
 */
export async function recordTokenUse(
  env: Env,
  principal: Principal,
  route: RouteId,
  surface: Surface,
): Promise<void> {
  if (principal.kind !== "token" || !principal.tokenId) return;
  const now = Date.now();
  const windowStart = now - (now % TOKEN_USED_WINDOW_MS);
  const key = `used:${principal.tokenId}:${route}`;
  const detail = JSON.stringify({
    admin: principal.email ?? null,
    route,
    surface: surface.kind,
    via: principal.tokenKind ?? null,
    client: principal.client ?? null,
    ...(surface.kind === "mcp"
      ? { tool: surface.tool, clientVersion: surface.clientVersion }
      : {}),
  });
  const first = `(SELECT count FROM rate_counters WHERE key = ?1 AND window_start = ?2) = 1`;
  const db = env.PLATFORM_DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1`,
      )
      .bind(key, windowStart),
    db
      .prepare(
        `${AUDIT_INSERT} SELECT ?3, 'token', ?4, ?5, 'token.used', NULL, 'ok', ?6 WHERE ${first}`,
      )
      .bind(key, windowStart, now, principal.label, principal.tokenId, detail),
    db
      .prepare(
        `UPDATE agent_tokens SET last_used_at = ?3 WHERE id = ?4 AND ${first}`,
      )
      .bind(key, windowStart, now, principal.tokenId),
  ]);
}
