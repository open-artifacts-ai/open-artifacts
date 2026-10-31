import type {
  ApiErrorCode,
  PrincipalKind,
  TokenKind,
  TokenScope,
} from "@oa/shared/provisioning";

/**
 * An authenticated caller (design v7 4.1). Both bearer kinds (`oat_` and
 * OAuth) are `kind: "token"`; the surface goes only into audit detail.
 * - actorKey: idempotency and audit (`admin:<email>`, `token:<tokenId>`,
 *   `oidc:<repository_id>`, `user:<sub>`, `system:<name>`).
 * - rateKey: the rate-limit key; a token shares its admin's (`admin:<email>`).
 * - hd: self-serve users only (the verified Workspace domain, 4.2 policy);
 *   `test.invalid` marks an OIDC test user (4.4), refused outside staging.
 * - tokenKind, client, tokenExpiresAt: tokens only, from the row; audit
 *   `via` and `client` (9A.8), R1's token kind and expiry. `client` is the
 *   sanitized client name (oauth), null for `oat`.
 * - scopes: tokens only, always from the row, never the request.
 * - authAt: the session's sign-in time (R11 reauth); null for tokens.
 * - session: admin and user sessions only (W5a): the row's hash
 *   (agent_tokens.session_hash at mint), the CSRF token /me returns, and
 *   the session's end (/me sessionExpiresAt, the OAuth refresh cap).
 */
export type Principal = {
  kind: PrincipalKind;
  actorKey: string;
  rateKey: string;
  label: string;
  scopes: readonly TokenScope[];
  email?: string;
  hd?: string;
  tokenKind?: TokenKind;
  client?: string | null;
  tokenExpiresAt?: number;
  sub?: string;
  tokenId?: string;
  authAt?: number | null;
  session?: { hash: string; csrf: string; expiresAt: number };
};

/** A refusal before a handler runs; answered with the 3.5 envelope. */
export type Refusal = { refusal: true; code: ApiErrorCode; details?: unknown };

export const refusal = (code: ApiErrorCode, details?: unknown): Refusal =>
  details === undefined
    ? { refusal: true, code }
    : { refusal: true, code, details };

export const isRefusal = (x: Principal | Refusal | null): x is Refusal =>
  x !== null && "refusal" in x;
