import type { Env } from "../env.js";
import { b64urlDecode, b64urlEncode } from "../util/crypto.js";

/**
 * Per-purpose HMAC keys derived from SESSION_SECRET, so a key used for one
 * cookie or table can never verify another's values:
 * base64url(HKDF-SHA256(ikm = SESSION_SECRET, salt = HKDF_SALT, info = label, 32 bytes)).
 * The result is the `key` string for util/crypto's hmacSign/hmacVerify.
 *
 * Each label names the secret that owns it. deriveKey is an allowlist: it
 * derives only "session" labels, so a new label is refused until marked so.
 */
const KEY_OWNERS = {
  "oa:session": "session",
  "oa:oidc-state": "session",
  "oa:code-cookie": "session",
  "oa:login-codes": "session",
  "oa:code-email": "session",
  // #2590 G2: the cookie that holds a Google account waiting for its code.
  "oa:glink-cookie": "session",
  "oa:audit-cursor": "session",
  // #1467 the unsubscribe link in comment emails.
  "oa:comment-unsub": "session",
  // #2632 the "Don't remind me" link in the setup reminder email.
  "oa:setup-remind-off": "session",
  // #2590 the "Don't email me again" link in outside share emails.
  "oa:share-optout": "session",
  // P3 directory connect: the state cookie binding a consent to its browser.
  "oa:directory-state": "session",
  // #2879: the anonymous per-member id sent to PostHog (analytics.ts).
  "oa:analytics-member": "session",
  // From CONTENT_SIGNING_KEY instead (contentKey below), so a content token
  // and an upload signature can never verify as each other.
  "oa:content-url": "content",
  "oa:upload": "content",
  // From DIRECTORY_TOKEN_KEY instead (directoryKey below): the AES-GCM key
  // sealing the directory refresh token at rest.
  "oa:directory-token": "directory",
} as const satisfies Record<string, KeyOwner>;
type KeyOwner = "session" | "content" | "directory";
export type KeyLabel = keyof typeof KEY_OWNERS;
type LabelsOf<O extends KeyOwner> = {
  [L in KeyLabel]: (typeof KEY_OWNERS)[L] extends O ? L : never;
}[KeyLabel];
/** The labels keyed by CONTENT_SIGNING_KEY (contentKey); oa:directory-token is DIRECTORY_TOKEN_KEY's; every other label is SESSION_SECRET's. */
export type ContentKeyLabel = LabelsOf<"content">;
type SessionKeyLabel = LabelsOf<"session">;

const labelsOf = <O extends KeyOwner>(o: O) =>
  KEY_LABELS.filter((l): l is LabelsOf<O> => KEY_OWNERS[l] === o);
export const KEY_LABELS = Object.keys(KEY_OWNERS) as KeyLabel[];
export const CONTENT_KEY_LABELS: readonly ContentKeyLabel[] =
  labelsOf("content");
/** The only labels deriveKey accepts. */
const SESSION_LABELS: ReadonlySet<string> = new Set(labelsOf("session"));
/** The function that derives each non-session owner's labels, for deriveKey's error. */
const OWNER_FN: Readonly<Record<string, string>> = {
  content: "contentKey",
  directory: "directoryKey",
};

const HKDF_SALT = "open-artifacts/hkdf/v1";
const enc = new TextEncoder();
const cache = new Map<string, Promise<string>>();

/**
 * The one HKDF-SHA256 call (v1 salt) behind every derived key here: `bytes`
 * of output for `info`. The caller owns the returned buffer.
 */
async function hkdfBits(
  secret: string,
  info: string,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: enc.encode(HKDF_SALT),
        info: enc.encode(info),
      },
      ikm,
      bytes * 8,
    ),
  );
}

async function derive(secret: string, label: KeyLabel): Promise<string> {
  return b64urlEncode(await hkdfBits(secret, label, 32));
}

/**
 * HKDF accepts a secret of any length, so a short SESSION_SECRET still gets
 * derived keys (cookieKeys logs a one-time warning; it must not break
 * sign-in). Empty or missing is the error for the secret. Only "session"
 * labels derive (typed, and checked at runtime too): content and
 * directory-token keys only come from contentKey or directoryKey, and an
 * unknown label is refused.
 */
export function deriveKey(
  env: Pick<Env, "SESSION_SECRET">,
  label: SessionKeyLabel,
): Promise<string> {
  if (!SESSION_LABELS.has(label)) {
    const owner = Object.hasOwn(KEY_OWNERS, label)
      ? OWNER_FN[KEY_OWNERS[label as KeyLabel]]
      : undefined;
    return Promise.reject(
      new Error(
        `${label} is not a SESSION_SECRET label${owner ? `; use ${owner}` : ""}`,
      ),
    );
  }
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length === 0)
    return Promise.reject(new Error("SESSION_SECRET is not set"));
  return cached(secret, label);
}

/**
 * A per-purpose key derived from CONTENT_SIGNING_KEY (same HKDF as
 * deriveKey): "oa:content-url" for content tokens and capture headers,
 * "oa:upload" for upload URLs. The raw secret signs nothing.
 */
export function contentKey(
  env: Pick<Env, "CONTENT_SIGNING_KEY">,
  label: ContentKeyLabel,
): Promise<string> {
  const k = env.CONTENT_SIGNING_KEY;
  if (typeof k !== "string" || k.length < 32)
    return Promise.reject(
      new Error("CONTENT_SIGNING_KEY must be at least 32 characters"),
    );
  return cached(k, label);
}

const VAPID_LABEL = "oa:push-vapid";
/** 48 bytes: the bias of reducing 384 bits mod the 256-bit P-256 order is negligible. */
const P256_HKDF_BYTES = 48;
/**
 * The order n of the P-256 group (NIST SP 800-186 section 3.2.1.3, secp256r1;
 * SEC 2 section 2.4.2). A fixed constant, not a parameter.
 */
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/**
 * PKCS#8 PrivateKeyInfo (RFC 5208) for id-ecPublicKey / prime256v1 around an
 * RFC 5915 ECPrivateKey (version 1, the 32-byte scalar, no public key); the
 * scalar follows. Fixed DER, so no ASN.1 code is needed.
 */
const P256_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
]);
const P256_ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The scalar for `label`: 48 HKDF bytes mod n, retried as `label\0<counter>` on a (practically never) zero result. Big-endian, 32 bytes. */
async function p256Scalar(secret: string): Promise<Uint8Array> {
  for (let counter = 0; counter < 8; counter++) {
    const bits = await hkdfBits(
      secret,
      counter === 0 ? VAPID_LABEL : `${VAPID_LABEL}\u0000${counter}`,
      P256_HKDF_BYTES,
    );
    let n = 0n;
    for (const b of bits) n = (n << 8n) | BigInt(b);
    bits.fill(0);
    n %= P256_ORDER;
    if (n === 0n) continue;
    const out = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return out;
  }
  throw new Error("p256 derivation failed");
}

/**
 * A P-256 signing pair derived from SESSION_SECRET (same HKDF, v1 salt),
 * with WebCrypto only: the scalar is wrapped in fixed PKCS#8 and imported
 * once extractable, to read the public point from its JWK x/y, and once
 * non-extractable for signing. Returns the 65-byte SEC1 uncompressed public
 * key (04|x|y) and the non-extractable signing key; nothing private is kept
 * or put in an error, and the private byte buffers are zeroed on the way out.
 */
export async function deriveVapidPair(
  env: Pick<Env, "SESSION_SECRET">,
): Promise<{ publicKey: Uint8Array<ArrayBuffer>; signKey: CryptoKey }> {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length === 0)
    throw new Error("SESSION_SECRET is not set");
  let scalar: Uint8Array | undefined;
  const der = new Uint8Array(P256_PKCS8_PREFIX.length + 32);
  try {
    scalar = await p256Scalar(secret);
    der.set(P256_PKCS8_PREFIX, 0);
    der.set(scalar, P256_PKCS8_PREFIX.length);
    let x: Uint8Array | null;
    let y: Uint8Array | null;
    try {
      const probe = await crypto.subtle.importKey(
        "pkcs8",
        der,
        P256_ALG,
        true,
        ["sign"],
      );
      const jwk = await crypto.subtle.exportKey("jwk", probe);
      x = typeof jwk.x === "string" ? b64urlDecode(jwk.x) : null;
      y = typeof jwk.y === "string" ? b64urlDecode(jwk.y) : null;
    } catch {
      throw new Error("p256 key import failed");
    }
    if (x?.length !== 32 || y?.length !== 32)
      throw new Error("p256 public coordinates invalid");
    const publicKey = new Uint8Array(65);
    publicKey[0] = 4;
    publicKey.set(x, 1);
    publicKey.set(y, 33);
    let signKey: CryptoKey;
    try {
      signKey = await crypto.subtle.importKey("pkcs8", der, P256_ALG, false, [
        "sign",
      ]);
    } catch {
      throw new Error("p256 key import failed");
    }
    return { publicKey, signKey };
  } finally {
    scalar?.fill(0);
    der.fill(0);
  }
}

/** DIRECTORY_TOKEN_KEY's minimum length (setup and provisioning generate 32 random bytes). */
export const MIN_DIRECTORY_KEY_LENGTH = 32;

/**
 * The refresh-token sealing key (P3 directory sync), derived from
 * DIRECTORY_TOKEN_KEY with the same HKDF ("oa:directory-token"); the raw
 * secret seals nothing. Missing or short: rejects.
 */
export function directoryKey(
  env: Pick<Env, "DIRECTORY_TOKEN_KEY">,
): Promise<string> {
  const k = env.DIRECTORY_TOKEN_KEY;
  if (typeof k !== "string" || k.length < MIN_DIRECTORY_KEY_LENGTH)
    return Promise.reject(
      new Error("DIRECTORY_TOKEN_KEY must be at least 32 characters"),
    );
  return cached(k, "oa:directory-token");
}

function cached(secret: string, label: KeyLabel): Promise<string> {
  const id = `${label}\u0000${secret}`;
  let k = cache.get(id);
  if (!k) {
    k = derive(secret, label);
    k.catch(() => cache.delete(id));
    cache.set(id, k);
  }
  return k;
}

/**
 * Shorter secrets are weak and warned about (a one-time log line), but they
 * still key HKDF: it accepts any length, so there is no raw-secret
 * fallback for them. A pre-P2 cookie signed with a short raw secret is simply
 * invalid after the upgrade (signs in once).
 */
export const MIN_SECRET_LENGTH = 32;

/**
 * Until then, cookies signed with the raw SESSION_SECRET (state and session,
 * from before the per-purpose keys) are still accepted. A follow-up removes
 * it; an install that upgrades after this date signs everyone out once.
 */
export const LEGACY_KEY_UNTIL = Date.UTC(2026, 11, 1);

export const SHORT_SECRET_PROBLEM =
  "SESSION_SECRET shorter than 32 characters; rotate it";

/**
 * Install-level problems for setup and admins only (never public /healthz).
 * TODO(P2 T12): nothing reports this yet; setup's selftest should surface it.
 */
export function secretProblems(env: Pick<Env, "SESSION_SECRET">): string[] {
  const s = env.SESSION_SECRET;
  return typeof s === "string" && s.length > 0 && s.length < MIN_SECRET_LENGTH
    ? [SHORT_SECRET_PROBLEM]
    : [];
}

let warned = false;

/**
 * Keys for a cookie that predates the per-purpose keys (session, OIDC
 * state): `key` signs and verifies, `legacy` (if not null) also verifies.
 * - The derived key always signs and verifies (HKDF accepts any length, a
 *   short secret included); the raw secret also verifies until
 *   LEGACY_KEY_UNTIL, for cookies from before the per-purpose keys.
 * - A short secret is warned about once in the log, never an error: the
 *   install keeps signing people in (secretProblems is for setup; see TODO).
 * - Missing or empty: throws (the install is misconfigured).
 */
export async function cookieKeys(
  env: Pick<Env, "SESSION_SECRET">,
  label: "oa:session" | "oa:oidc-state",
  now = Date.now(),
): Promise<{ key: string; legacy: string | null }> {
  const s = env.SESSION_SECRET;
  if (typeof s !== "string" || s.length === 0)
    throw new Error("SESSION_SECRET is not set");
  if (s.length < MIN_SECRET_LENGTH && !warned) {
    warned = true;
    console.warn(JSON.stringify({ evt: "session_secret_short" }));
  }
  return {
    key: await deriveKey(env, label),
    // Raw-secret cookies only ever existed on installs with a 32+ char
    // secret; a short one gets no legacy path (see the block above).
    legacy: s.length >= MIN_SECRET_LENGTH && now < LEGACY_KEY_UNTIL ? s : null,
  };
}
