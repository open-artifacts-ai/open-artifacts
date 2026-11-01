import { fixtureMe } from "@oa/shared/provisioning/fixtures";

/** GET /me as an admin session with this CSRF token. */
export const adminMe = (csrf: string) =>
  fixtureMe({
    principal: "admin",
    email: "a@example.com",
    csrf,
    tokenId: null,
    tokenKind: null,
    tokenExpiresAt: null,
  });

/** The contract's error envelope. */
export const apiError = (code: string, message = "No.") => ({
  error: { code, message },
});
