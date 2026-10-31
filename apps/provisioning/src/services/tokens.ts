import type { TokenKind, TokenScope } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { NotImplemented } from "../errors.js";
import { type Principal, type Refusal, refusal } from "../principal.js";

// The one token service for both kinds (design v7 9A.4): R19 and the MCP
// consent mint through mintAgentToken; authenticate() (both bearer kinds)
// and the OAuth refresh callback check through tokenPrincipal. No other
// module inserts into agent_tokens. W5b builds both bodies.

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
    }
  | {
      kind: "oauth";
      scopes: readonly TokenScope[];
      clientId: string;
      clientName: string;
    };

/** oat: the bearer, shown once. oauth: the library userId for completeAuthorization. */
export type Minted = {
  tokenId: string;
  expiresAt: number;
  token?: string;
  oauthUser?: string;
};

/**
 * Mints one token for an admin session principal: the per-admin mint counter
 * (4.7), the 5-live limit across both kinds (`token_limit`), and one D1 batch
 * (row, supersession of an older oauth row of the same client, audit).
 */
export async function mintAgentToken(
  _env: Env,
  _principal: Principal,
  _opts: MintOpts,
): Promise<Minted> {
  throw new NotImplemented("mintAgentToken");
}

/**
 * The token principal for a row and its minting session (9A.3.3): row of the
 * right kind, not revoked, unexpired; session not revoked, unexpired; its
 * `(email, sub)` still in ADMIN_IDENTITIES. Any failure: unauthenticated.
 */
export function tokenPrincipal(
  _row: AgentTokenRow,
  _session: SessionRow | null,
  _env: Pick<Env, "ADMIN_IDENTITIES">,
): Principal | Refusal {
  return refusal("unauthenticated");
}
