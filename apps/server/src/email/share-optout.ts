// "Don't email me again" in the outside share email (#2590). The token names
// one address (as its SHA-256, so the link never carries the address) and one
// purpose; the only thing it can do is add that address to the suppression
// table (idempotent). No expiry: a link in an old email still works.
import { normalizeEmail } from "@oa/auth-core";
import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { hmacSign, hmacVerify, sha256Hex } from "../util/crypto.js";

/** The page: GET shows a button and changes nothing; POST suppresses. */
export const SHARE_OPTOUT_PATH = "/auth/unsubscribe/shares";

const TOKEN_VERSION = "v1";
const PURPOSE = "share-email-off";
const HASH = /^[0-9a-f]{64}$/;

/** The key the suppression table and the token use for an address. */
export async function addressHash(email: string): Promise<string | null> {
  const e = normalizeEmail(email);
  return e ? sha256Hex(e) : null;
}

const payload = (hash: string) => `${TOKEN_VERSION}:${PURPOSE}:${hash}`;

/** `v1.<sha256 of the address>.<hmac>`: one address, one purpose. */
export async function signOptoutToken(
  env: Pick<Env, "SESSION_SECRET">,
  email: string,
): Promise<string> {
  const hash = await addressHash(email);
  if (!hash) throw new Error("invalid address");
  const sig = await hmacSign(
    await deriveKey(env, "oa:share-optout"),
    payload(hash),
  );
  return `${TOKEN_VERSION}.${hash}.${sig}`;
}

/** The address hash the token names, or null when malformed, tampered or another version. */
export async function verifyOptoutToken(
  env: Pick<Env, "SESSION_SECRET">,
  token: string,
): Promise<string | null> {
  const [v, hash, sig, ...rest] = token.split(".");
  if (v !== TOKEN_VERSION || !hash || !sig || rest.length) return null;
  if (!HASH.test(hash)) return null;
  const ok = await hmacVerify(
    await deriveKey(env, "oa:share-optout"),
    payload(hash),
    sig,
  );
  return ok ? hash : null;
}

/** The absolute link in the email and the List-Unsubscribe headers. */
export const optoutUrl = (appHost: string, token: string): string =>
  `https://${appHost}${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(token)}`;

/**
 * OA Product's wording when the platform's hosted-wide list is on (#2652): the
 * opt-out covers every team on Open Artifacts, so no {org}.
 */
export const OPTOUT_COPY_HOSTED = {
  link: "Don't email me again",
  confirmTitle: "Stop these emails?",
  confirmBody:
    "We won't email you again when someone shares a page with you, from any team on Open Artifacts.",
  confirmButton: "Don't email me again",
  doneTitle: "You won't get these emails again.",
  doneBody:
    "Pages shared with you still open when you log in. We just won't email you about them.",
  badTitle: "This link is not valid",
  badBody:
    "This link doesn't work. Open the most recent email from us and use the link there.",
} as const;

/**
 * OA Product's wording (one place). {org} is the instance's name (its host
 * when it has none): the opt-out covers this install only.
 */
export const OPTOUT_COPY = {
  link: "Don't email me from {{org}} again",
  confirmTitle: "Stop emails from {{org}}?",
  confirmBody:
    "We won't email you again when someone at {{org}} shares a page with you. Other teams on Open Artifacts can still email you.",
  confirmButton: "Stop emails from {{org}}",
  doneTitle: "You won't get emails from {{org}} again.",
  doneBody:
    "Pages shared with you still open when you log in. We just won't email you about them.",
  undoButton: "Undo",
  undoneTitle: "You'll get these emails again.",
  undoneBody: "We'll email you when someone at {{org}} shares a page with you.",
  badTitle: "This link is not valid",
  badBody:
    "This link doesn't work. Open the most recent email from us and use the link there.",
} as const;
