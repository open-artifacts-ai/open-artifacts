import type { TokenKind } from "@oa/shared/provisioning";
import type { Principal } from "./principal.js";

/**
 * The Principal fields W5a and W5b add to C4's type, by their branches'
 * names: `session` (W5a: admin and user sessions), `hd`, `tokenKind` and
 * `client` (W5b). Absent until those merge, then this cast is a no-op.
 */
export type PrincipalFacts = {
  session?: { csrf: string; expiresAt: number };
  hd?: string;
  tokenKind?: TokenKind;
  client?: string | null;
};

export const factsOf = (p: Principal): Principal & PrincipalFacts => p;

/** W5b's staging OIDC test users (`x-oa-test-user`) carry this sub prefix. */
export const TEST_USER_SUB_PREFIX = "rl-test-";

/** A staging OIDC test user (4.2 `test-users`); a Google sub is digits only. */
export const isTestUser = (p: Principal, env: { OA_ENV: string }) =>
  env.OA_ENV === "staging" &&
  p.kind === "user" &&
  (p.sub ?? "").startsWith(TEST_USER_SUB_PREFIX);
