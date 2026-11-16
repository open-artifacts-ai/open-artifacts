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

/**
 * What the platform's opt-out list needs at unsubscribe time (hosted only,
 * #2652): the address's HMAC (the install never sends the address) and the
 * per-email token the platform minted for it.
 */
export type PlatformOptout = { h: string; p: string };
const PART = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * `v1.<sha256 of the address>.<hmac>`: one address, one purpose. On hosted,
 * `v2.<sha256>.<address HMAC>.<platform token>.<hmac>`: the same, carrying
 * what the platform's list needs, so the unsubscribe page never needs the address.
 */
export async function signOptoutToken(
  env: Pick<Env, "SESSION_SECRET">,
  email: string,
  platform?: PlatformOptout,
): Promise<string> {
  const hash = await addressHash(email);
  if (!hash) throw new Error("invalid address");
  const key = await deriveKey(env, "oa:share-optout");
  if (!platform) {
    return `${TOKEN_VERSION}.${hash}.${await hmacSign(key, payload(hash))}`;
  }
  if (!PART.test(platform.h) || !PART.test(platform.p))
    throw new Error("invalid platform opt-out parts");
  const sig = await hmacSign(key, payload2(hash, platform));
  return `v2.${hash}.${platform.h}.${platform.p}.${sig}`;
}

const payload2 = (hash: string, p: PlatformOptout) =>
  `v2:${PURPOSE}:${hash}:${p.h}:${p.p}`;

/** The address hash and, from a v2 token, the platform parts; null when malformed, tampered or another version. */
export async function verifyOptoutTokenFull(
  env: Pick<Env, "SESSION_SECRET">,
  token: string,
): Promise<{ hash: string; platform?: PlatformOptout } | null> {
  const parts = token.split(".");
  const key = await deriveKey(env, "oa:share-optout");
  if (parts[0] === TOKEN_VERSION && parts.length === 3) {
    const [, hash, sig] = parts as [string, string, string];
    if (!HASH.test(hash)) return null;
    return (await hmacVerify(key, payload(hash), sig)) ? { hash } : null;
  }
  if (parts[0] === "v2" && parts.length === 5) {
    const [, hash, h, p, sig] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!HASH.test(hash) || !PART.test(h) || !PART.test(p)) return null;
    const platform = { h, p };
    return (await hmacVerify(key, payload2(hash, platform), sig))
      ? { hash, platform }
      : null;
  }
  return null;
}

/** The address hash the token names, or null when malformed, tampered or another version. */
export async function verifyOptoutToken(
  env: Pick<Env, "SESSION_SECRET">,
  token: string,
): Promise<string | null> {
  return (await verifyOptoutTokenFull(env, token))?.hash ?? null;
}

/** The absolute link in the email and the List-Unsubscribe headers. */
export const optoutUrl = (appHost: string, token: string): string =>
  `https://${appHost}${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(token)}`;

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
