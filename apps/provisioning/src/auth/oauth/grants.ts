import type { Env } from "../../env.js";

// Library grant revocation for R21 and R24 (design v7 4.6, 9A.3.1). W13b
// fills it with the library's `revokeGrant(grantId, userId)` on OAUTH_KV.
// Until then the D1 row's revoked_at already ends the grant at the next
// /mcp call or refresh (tokenPrincipal, 9A.3.3), so this is a no-op.

export type LibraryGrant = { grantId: string; oauthUser: string };

export async function revokeLibraryGrant(
  _env: Env,
  _grant: LibraryGrant,
): Promise<void> {}
