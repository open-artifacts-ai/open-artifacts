// The hosted-wide email opt-out list (open-artifacts#2652): what an install
// sends the platform through the LoginGate binding, and what comes back. One
// definition both repos use; the cloud routes (apps/provisioning optouts.ts)
// switch to these once pinned.
//
// The platform never receives an address. The install sends h1 =
// HMAC-SHA256(OPTOUT_HASH_KEY, lowercased trimmed address), lowercase hex;
// OPTOUT_HASH_KEY is held by hosted installs only. The platform stores a
// second HMAC of h1 and never h1 itself. The body names no install: the gate
// stamps it. The body is signed with one of the install's registry keys (the
// x-oa-kid and x-oa-sig headers over path, kid and the exact body text).
import { z } from "zod";

/** The gate's fixed routes for the list (POST, JSON; nothing else under /optouts/). */
export const OPTOUT_CHECK_PATH = "/optouts/check";
export const OPTOUT_MINT_PATH = "/optouts/mint";
/** The platform's public page on the sign-up host an unsubscribe link opens (?t=<token>); GET shows a button, POST redeems. */
export const OPTOUT_UNSUBSCRIBE_PATH = "/unsubscribe";

/** h1: 64 lowercase hex characters. */
export const OPTOUT_H1_RE = /^[0-9a-f]{64}$/;
/** A request nonce: 16 to 64 URL-safe characters, never reused by an install. */
export const OPTOUT_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** A minted token: `<payload>.<mac>`, both base64url. */
export const OPTOUT_TOKEN_RE = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/;

/** POST /optouts/check and POST /optouts/mint: one hash per call, exactly these keys. */
export const OptoutBodySchema = z.strictObject({
  /** ms since the epoch; the platform refuses a skew past ASSERTION_SKEW_MS. */
  ts: z.number().finite(),
  nonce: z.string().regex(OPTOUT_NONCE_RE),
  h1: z.string().regex(OPTOUT_H1_RE),
});
export type OptoutBody = z.infer<typeof OptoutBodySchema>;

/** POST /optouts/check -> 200. An install treats any other answer as "don't send". */
export const OptoutCheckResponseSchema = z.strictObject({
  optedOut: z.boolean(),
});
export type OptoutCheckResponse = z.infer<typeof OptoutCheckResponseSchema>;

/** POST /optouts/mint -> 200. 429 (the install's daily mint cap) means don't email. */
export const OptoutMintResponseSchema = z.strictObject({
  token: z.string().regex(OPTOUT_TOKEN_RE),
});
export type OptoutMintResponse = z.infer<typeof OptoutMintResponseSchema>;
