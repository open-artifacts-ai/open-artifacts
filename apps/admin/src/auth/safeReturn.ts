import {
  safeReturn as contractSafeReturn,
  RETURN_FALLBACK,
} from "@oa/shared/provisioning";

/** Where sign-in lands when the return path is missing or unsafe. */
export const DEFAULT_RETURN = RETURN_FALLBACK;

/** The contract's return rule (C1 return.ts), against this page's origin. */
export const safeReturn = (raw: unknown): string =>
  typeof raw === "string"
    ? contractSafeReturn(raw, globalThis.location?.origin ?? "http://localhost")
    : DEFAULT_RETURN;
