// A leaf module (no imports): the plain-Node xt catalog reads it too, and
// send.ts pulls in modules that need the Workers runtime.

/** How long one email send may take before it is abandoned as timed out. */
export const EMAIL_TIMEOUT_MS = 3000;
