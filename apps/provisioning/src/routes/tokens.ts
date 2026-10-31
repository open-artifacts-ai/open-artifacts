import { MintTokenSchema, TokenIdSchema } from "@oa/shared/provisioning";
import { ApiError } from "../errors.js";
import {
  getToken,
  listTokens,
  mintAgentToken,
  revokeAllTokens,
  revokeToken,
  tokenView,
} from "../services/tokens.js";
import type { Handler } from "./handlers.js";

// R19-R21 (design v7 3.4, 4.1): admin session only (authz.ts); the bodies
// are the token service's, so the MCP consent mints through the same code.

// An admin session principal always carries its email (W5a); one without
// is a bug, not a caller's fault.
const adminEmail = (email: string | undefined) => {
  if (!email) throw new ApiError("internal");
  return email;
};

/** R19 POST /tokens: 201 with the bearer, shown once. */
export const mintToken: Handler = async ({ env, principal, input }) => {
  const b = MintTokenSchema.safeParse(input.body);
  if (!b.success) throw new ApiError("invalid_input");
  const m = await mintAgentToken(env, principal, { kind: "oat", ...b.data });
  const row = await getToken(env, m.tokenId);
  if (!row) throw new ApiError("internal");
  return {
    status: 201,
    body: { ...tokenView(row), token: m.token },
    headers: {},
  };
};

/** R20 GET /tokens: both kinds. */
export const listTokensHandler: Handler = async ({ env, principal }) => ({
  status: 200,
  body: { items: await listTokens(env, adminEmail(principal.email)) },
  headers: {},
});

/**
 * R21 DELETE /tokens/:id?: one (404 if not this admin's) or all, both kinds;
 * a malformed id is 400 `invalid_input` (the C1 params schema). The D1
 * revoke refuses an oauth row at its next call; ending its library grant in
 * KV is W13b's (the service returns the grants).
 */
export const revokeTokens: Handler = async ({ env, principal, input }) => {
  const email = adminEmail(principal.email);
  const id = input.params?.id;
  if (id === undefined || id === "") {
    await revokeAllTokens(env, email);
  } else {
    if (!TokenIdSchema.safeParse(id).success)
      throw new ApiError("invalid_input");
    if ((await revokeToken(env, email, id)) === null)
      throw new ApiError("not_found");
  }
  return { status: 204, body: null, headers: {} };
};
