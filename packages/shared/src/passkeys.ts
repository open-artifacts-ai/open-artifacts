// Passkey-confirmed picks (#2263). The request and response schemas are in schemas.ts.

/** The WebAuthn challenge TTL, in seconds. */
export const PASSKEY_CHALLENGE_TTL_S = 120;
/** A passkey may confirm only once it is this old (ms). */
export const PASSKEY_COOLING_MS = 24 * 60 * 60 * 1000;
