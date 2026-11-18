// "Don't email me again" in the outside share email (#2590). The token names
// one address (as a hash, so the link never carries the address) and one
// purpose; the only thing it can do is add that address to the suppression
// table (idempotent). No expiry: a link in an old email still works.
//
// #2820: with INSTALL_OPTOUT_KEY set (48 random bytes, base64url, minted once
// per install, never rotated), new rows and new tokens (v2) use `k1:` + the
// HMAC-SHA256 of the normalized address under that key, so a dictionary can't
// reverse them. Without it nothing changes: the plain SHA-256 and v1 tokens.
// Rows and links from before it are plain SHA-256 and stay valid for good:
// sends check both hashes, a v1 link still opts out (writing a legacy row) and
// still undoes (deleting it), and nothing is rewritten. While any legacy row
// remains the table is NOT anonymous. The key is never logged or sent anywhere.
import { normalizeEmail } from "@oa/auth-core";
import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
  sha256Hex,
} from "../util/crypto.js";

/** The page: GET shows a button and changes nothing; POST suppresses. */
export const SHARE_OPTOUT_PATH = "/auth/unsubscribe/shares";

const TOKEN_V1 = "v1";
const TOKEN_V2 = "v2";
const PURPOSE = "share-email-off";
const LEGACY = /^[0-9a-f]{64}$/;
const KEYED = /^[A-Za-z0-9_-]{43}$/;
/** The prefix that tells a keyed row from a legacy one. */
export const KEYED_PREFIX = "k1:";
/** The key's length in bytes (the platform mints 48). */
const KEY_MIN_BYTES = 32;

/** The legacy key: the plain SHA-256 of the address. Reversible by a dictionary; kept for matching old rows and for installs with no key. */
export async function addressHash(email: string): Promise<string | null> {
  const e = normalizeEmail(email);
  return e ? sha256Hex(e) : null;
}

/** The install's opt-out key bytes, or null when it isn't set (or can't be decoded: treated as not set). */
export function optoutKey(
  env: Pick<Env, "INSTALL_OPTOUT_KEY">,
): Uint8Array<ArrayBuffer> | null {
  const raw = env.INSTALL_OPTOUT_KEY?.trim();
  if (!raw) return null;
  const bytes = b64urlDecode(raw);
  return bytes && bytes.length >= KEY_MIN_BYTES ? bytes : null;
}

/** `k1:` + base64url(HMAC-SHA256(key bytes, normalized address)), or null with no key or no address. */
export async function keyedAddressHash(
  env: Pick<Env, "INSTALL_OPTOUT_KEY">,
  email: string,
): Promise<string | null> {
  const key = optoutKey(env);
  const e = normalizeEmail(email);
  if (!key || !e) return null;
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(e));
  return `${KEYED_PREFIX}${b64urlEncode(new Uint8Array(mac))}`;
}

/** The hash a new row and a new token use for an address: keyed with the key, else the plain SHA-256. */
export async function currentAddressHash(
  env: Pick<Env, "INSTALL_OPTOUT_KEY">,
  email: string,
): Promise<string | null> {
  return (await keyedAddressHash(env, email)) ?? (await addressHash(email));
}

const payload = (version: string, hash: string) =>
  `${version}:${PURPOSE}:${hash}`;

/** `v2.<keyed hash>.<hmac>` with the key, else `v1.<sha256>.<hmac>`: one address, one purpose. */
export async function signOptoutToken(
  env: Pick<Env, "SESSION_SECRET" | "INSTALL_OPTOUT_KEY">,
  email: string,
): Promise<string> {
  const hash = await currentAddressHash(env, email);
  if (!hash) throw new Error("invalid address");
  const keyed = hash.startsWith(KEYED_PREFIX);
  const version = keyed ? TOKEN_V2 : TOKEN_V1;
  const bare = keyed ? hash.slice(KEYED_PREFIX.length) : hash;
  const sig = await hmacSign(
    await deriveKey(env, "oa:share-optout"),
    payload(version, bare),
  );
  return `${version}.${bare}.${sig}`;
}

/**
 * The table key the token names (`k1:...` for v2, the plain SHA-256 hex for
 * v1), or null when malformed, tampered or another version.
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
  doneTitle: "You won't get share emails from {{org}} anymore.",
  doneBody:
    "Pages shared with you still open when you log in. We just won't email you about them.",
  undoButton: "Undo",
  undoneTitle: "You'll get share emails from {{org}} again.",
  badTitle: "This link is not valid",
  badBody:
    "This link doesn't work. Open the most recent email from us and use the link there.",
} as const;
