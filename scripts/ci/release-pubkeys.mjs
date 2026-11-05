// @ts-check
// The release workflow's Ed25519 public keys, a node:* readable copy of
// RELEASE_PUBKEY in packages/provision/src/internal/gates.ts (a test pins
// them equal: the key ceremony's one-line PR must change both). The key
// jobs use it to refuse a wrong or swapped Environment secret (L11).
import { createPublicKey, verify } from "node:crypto";

/** @typedef {"staging" | "prod"} Env */

export const RELEASE_PUBKEY_PLACEHOLDER =
  "PLACEHOLDER-not-a-key-T3b-sets-the-release-signing-public-key";

/** @type {Readonly<Record<Env, string>>} */
export const RELEASE_PUBKEY = Object.freeze({
  staging: "octk3ysmW5j0Fw8hPs1ex3POLXmYH8l6nLoms8Rrb8c",
  prod: "tfSgv1PLRZlYQfVNpy9Vp1ohxdfZihz2WgPCYcCQyJg",
});

const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

/**
 * The pinned key for env, or null while it is the placeholder.
 * @param {Env} env
 * @param {Readonly<Record<Env, string>>} pinned
 * @returns {string | null}
 */
const pinnedOf = (env, pinned) => {
  if (env !== "staging" && env !== "prod")
    throw new Error("env must be staging or prod");
  const k = pinned[env];
  if (k === RELEASE_PUBKEY_PLACEHOLDER) return null;
  if (typeof k !== "string" || !PUBKEY_RE.test(k))
    throw new Error(`RELEASE_PUBKEY.${env} is malformed`);
  return k;
};

/**
 * A key or signature with no pinned key is refused, never warned past: the
 * gap between generating the keys and pinning them must not sign or attach.
 * @param {Env} env
 */
const notPinned = (env) =>
  new Error(`key set but RELEASE_PUBKEY.${env} not pinned`);

/**
 * The signing key's public x must be the pinned one; refused while the pin
 * is still the placeholder.
 * @param {Env} env
 * @param {string} x
 * @param {Readonly<Record<Env, string>>} [pinned]
 * @returns {"verified"}
 */
export function checkSigningKey(env, x, pinned = RELEASE_PUBKEY) {
  const k = pinnedOf(env, pinned);
  if (k === null) throw notPinned(env);
  if (x !== k)
    throw new Error(
      `the signing key is not the pinned RELEASE_PUBKEY.${env} (wrong or swapped secret)`,
    );
  return "verified";
}

/**
 * Verifies `signature` over `payload` with the pinned key; refused while the
 * pin is still the placeholder.
 * @param {Env} env
 * @param {Uint8Array} payload
 * @param {string} signature
 * @param {Readonly<Record<Env, string>>} [pinned]
 * @returns {"verified"}
 */
export function verifySignature(
  env,
  payload,
  signature,
  pinned = RELEASE_PUBKEY,
) {
  if (!SIG_RE.test(signature))
    throw new Error("the signature is not 86 base64url characters");
  const k = pinnedOf(env, pinned);
  if (k === null) throw notPinned(env);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: k },
    format: "jwk",
  });
  if (!verify(null, payload, key, Buffer.from(signature, "base64url")))
    throw new Error(
      `the signature does not verify against RELEASE_PUBKEY.${env}`,
    );
  return "verified";
}

/**
 * Before the key ceremony (this env's pinned key is still the placeholder) a
 * release has no signing key yet: the sign job skips with a notice instead of
 * failing every release (v0.35.0). Once pinned, a missing key fails.
 * @param {Env} env
 * @param {string} stdin
 * @param {Readonly<Record<Env, string>>} [pinned]
 * @returns {boolean}
 */
export const skipUnsigned = (env, stdin, pinned = RELEASE_PUBKEY) =>
  stdin.trim() === "" && pinnedOf(env, pinned) === null;
