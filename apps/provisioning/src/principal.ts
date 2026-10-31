import type {
  ApiErrorCode,
  PrincipalKind,
  TokenScope,
} from "@oa/shared/provisioning";

/**
 * An authenticated caller (design v7 4.1). Both bearer kinds (`oat_` and
 * OAuth) are `kind: "token"`; the surface goes only into audit detail.
 * - actorKey: idempotency and audit (`admin:<email>`, `token:<tokenId>`,
 *   `oidc:<repository_id>`, `user:<sub>`, `system:<name>`).
 * - rateKey: the rate-limit key; a token shares its admin's (`admin:<email>`).
 * - scopes: tokens only, always from the row, never the request.
 * - authAt: the session's sign-in time (R11 reauth); null for tokens. For a
 *   session it always equals `session.authAt` (kept top-level so authz and
 *   /me read one field for every kind).
 * - session: admin and user sessions only; W5a owns this shape and W5b
 *   adopts it. Absent for every bearer and OIDC principal.
 *   - hash: `sessions.id_hash` (sha256 of the sid, 4.5); mintAgentToken and
 *     the OAuth grant bind to it, logout revokes by it.
 *   - csrf: the session's CSRF token (HMAC of the sid, 4.5), the one /me
 *     returns and checkCsrf compares.
 *   - expiresAt: the session's end (ms; /me sessionExpiresAt, the OAuth
 *     refresh cap).
 *   - authAt: the last Google sign-in for this session (ms; a reauth moves
 *     it, the sid and expiry stay).
 */
export type Principal = {
  kind: PrincipalKind;
  actorKey: string;
  rateKey: string;
  label: string;
  scopes: readonly TokenScope[];
  email?: string;
  sub?: string;
  tokenId?: string;
  authAt?: number | null;
  session?: PrincipalSession;
};

/** A browser session behind a principal (see Principal.session). */
export type PrincipalSession = {
  hash: string;
  csrf: string;
  expiresAt: number;
  authAt: number;
};

/** A refusal before a handler runs; answered with the 3.5 envelope. */
export type Refusal = { refusal: true; code: ApiErrorCode; details?: unknown };

export const refusal = (code: ApiErrorCode, details?: unknown): Refusal =>
  details === undefined
    ? { refusal: true, code }
    : { refusal: true, code, details };

export const isRefusal = (x: Principal | Refusal | null): x is Refusal =>
  x !== null && "refusal" in x;
