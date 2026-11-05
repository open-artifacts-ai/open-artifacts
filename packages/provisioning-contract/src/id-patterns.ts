// The id patterns (design v7 3.1) with no zod: ids.ts builds the schemas
// from these, and state.ts and system.ts check ids with them (one copy).

/** "i" + 11 base32 chars (@oa/provision newInstallId). */
export const INSTALL_ID_RE = /^i[a-z0-9]{11}$/;
/** Crockford base32 ULID; the first char caps the 48-bit time. */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** Client-chosen idempotency key, scoped to the principal's actorKey. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
