// "Don't email me again" in the outside share email (#2590). The token names
// one address (as a keyed hash, so the link never carries the address and a
// dictionary can't reverse it) and one purpose; the only thing it can do is add
// that address to the suppression table (idempotent). No expiry: a link in an
// old email still works.
//
// #2716: the table stores `k1:` + HMAC-SHA256(key "oa:optout", normalized
// address), base64url. Rows and v1 tokens written before it hold the plain
// SHA-256 hex of the address: they still match (a lookup tries both) and are
// rewritten to keyed the next time that address is shared (we have the address
// then). Until none are left the table is NOT anonymous: a legacy row can be
// reversed by a dictionary. A v1 link can only write a legacy row (it carries
// no address to key), so an old email's button still works.
import { normalizeEmail } from "@oa/auth-core";
import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { hmacSign, hmacVerify, sha256Hex } from "../util/crypto.js";

/** The page: GET shows a button and changes nothing; POST suppresses. */
export const SHARE_OPTOUT_PATH = "/auth/unsubscribe/shares";

const TOKEN_V1 = "v1";
const TOKEN_V2 = "v2";
const PURPOSE = "share-email-off";
const LEGACY = /^[0-9a-f]{64}$/;
const KEYED = /^[A-Za-z0-9_-]{43}$/;
/** The prefix that tells a keyed row from a legacy one. */
export const KEYED_PREFIX = "k1:";

/** The legacy key: the plain SHA-256 of the address. Reversible by a dictionary; only for matching and rewriting old rows. */
export async function legacyAddressHash(email: string): Promise<string | null> {
  const e = normalizeEmail(email);
  return e ? sha256Hex(e) : null;
}

/** The key the suppression table and the v2 token use for an address: `k1:` + HMAC under oa:optout. */
export async function addressHash(
  env: Pick<Env, "SESSION_SECRET">,
  email: string,
): Promise<string | null> {
  const e = normalizeEmail(email);
  return e
    ? `${KEYED_PREFIX}${await hmacSign(await deriveKey(env, "oa:optout"), e)}`
    : null;
}

const payload = (version: string, hash: string) =>
  `${version}:${PURPOSE}:${hash}`;

/** `v2.<keyed hash>.<hmac>`: one address, one purpose. */
export async function signOptoutToken(
  env: Pick<Env, "SESSION_SECRET">,
  email: string,
): Promise<string> {
  const hash = await addressHash(env, email);
  if (!hash) throw new Error("invalid address");
  const bare = hash.slice(KEYED_PREFIX.length);
  const sig = await hmacSign(
    await deriveKey(env, "oa:share-optout"),
    payload(TOKEN_V2, bare),
  );
  return `${TOKEN_V2}.${bare}.${sig}`;
}

/**
 * The table key the token names (`k1:...` for v2, the legacy hex for v1), or
 * null when malformed, tampered or another version.
 */
export async function verifyOptoutToken(
  env: Pick<Env, "SESSION_SECRET">,
  token: string,
): Promise<string | null> {
  const [v, hash, sig, ...rest] = token.split(".");
  if (!v || !hash || !sig || rest.length) return null;
  if (v === TOKEN_V2 ? !KEYED.test(hash) : v !== TOKEN_V1 || !LEGACY.test(hash))
    return null;
  const ok = await hmacVerify(
    await deriveKey(env, "oa:share-optout"),
    payload(v, hash),
    sig,
  );
  if (!ok) return null;
  return v === TOKEN_V2 ? `${KEYED_PREFIX}${hash}` : hash;
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
  badTitle: "This link is not valid",
  badBody:
    "This link doesn't work. Open the most recent email from us and use the link there.",
} as const;
