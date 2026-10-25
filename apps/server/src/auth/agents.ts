import type { Member } from "@oa/shared";
import { callerOf, capOfCaller } from "./authz.js";
import { orgCan } from "./policy.js";

/**
 * Whether `user` may act through an agent credential (a PAT or an OAuth
 * grant): members only, never a capped caller (a guest, a code session
 * outside the domains, P3's restricted). Every place a PAT or grant
 * authenticates checks this, and so does minting a PAT.
 */
export const canConnect = (user: Member) =>
  orgCan(user, "mcp.connect", { cap: capOfCaller(callerOf(user)) });
