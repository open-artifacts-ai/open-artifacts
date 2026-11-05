import type { Env } from "../env.js";
import { b64urlEncode } from "../util/crypto.js";

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
  "oa:audit-cursor": "session",
  // P3 directory connect: the state cookie binding a consent to its browser.
  "oa:directory-state": "session",
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

async function derive(secret: string, label: KeyLabel): Promise<string> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(HKDF_SALT),
      info: enc.encode(label),
    },
    ikm,
    256,
  );
  return b64urlEncode(new Uint8Array(bits));
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
