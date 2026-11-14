import type { Env } from "../../env.js";
import type { ProviderId } from "../config.js";

/** What a redirect provider vouches for, after every check passed. */
export type VerifiedIdentity = {
  provider: ProviderId;
  /** The provider's stable subject (Access `sub`, Google `sub`). */
  subject: string;
  email: string;
  name: string | null;
  /** Verified tenant (Google `hd`), or null when the provider has none. */
  tenant: string | null;
  /**
   * The signature-checked token's own `hd`, whatever the install's domains
   * (absent: tenant stands in). The only hd admit() judges evidence by.
   */
  hd?: string | null;
  /**
   * "email": admitted on strong evidence for its exact address although its
   * hd is not a listed domain (#2520). It may only match an existing active
   * row; it never creates one, never promotes a guest, never drifts.
   */
  bound?: "email";
  /** When the user last authenticated at the provider (ms), when it says. */
  authTime?: number | null;
};

/**
 * A redirect (OIDC) sign-in provider. oidc.ts owns the state cookie, PKCE
 * and nonce; a provider builds its authorize URL and redeems the code.
 */
export interface OidcProvider {
  id: ProviderId;
  /** The path its authorization response comes back to. */
  callbackPath: string;
  authorizeUrl(
    env: Env,
    a: {
      state: string;
      nonce: string;
      challenge: string;
      /** Force a fresh authentication at the provider (break-glass, P3 T18). */
      reauth?: boolean;
      /**
       * A silent-sign-in ticket (#2026) for the hosted broker to verify; the
       * broker decides, and anything it rejects gets the account picker.
       */
      silent?: string;
    },
  ): Promise<string> | string;
  /**
   * Exchanges the code and verifies the result (nonce included). Throws
   * ApiError("unauthorized") after logOidcFail(stage) on any failure.
   */
  redeem(
    env: Env,
    a: {
      code: string;
      verifier: string;
      nonce: string;
      /** The broker's own state, relayed back by the hosted broker. */
      bstate?: string;
    },
  ): Promise<VerifiedIdentity>;
}
