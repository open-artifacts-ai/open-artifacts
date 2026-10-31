import type { TokenKind, TokenScope } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { NotImplemented } from "../errors.js";
import { type Principal, type Refusal, refusal } from "../principal.js";

// The one token service for both kinds (design v7 9A.4): R19 and the MCP
// consent mint through mintAgentToken; authenticate() (both bearer kinds)
// and the OAuth refresh callback check through tokenPrincipal. No other
// module inserts into agent_tokens (test/node/layout.test.ts). W5b builds
// both bodies.
//
// Deviations from the 9A.4 text, on purpose: both take `env` (this app has no
// global env; mintAgentToken's is first, like invokeRoute's), and
// tokenPrincipal takes the session as nullable (a missing row is a refusal,
// not a caller's branch). The W13b refresh callback passes env.

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
 * Throws `ApiError("token_limit")` (409) at the limit, which R19 renders and
 * the consent page detects; `rate_limited` over the mint counter.
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
