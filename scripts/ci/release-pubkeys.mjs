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

/**
 * Retired keys per env, still accepted when verifying, never for signing. A
 * node:* readable copy of RELEASE_RETIRED_PUBKEYS in gates.ts (a test pins
 * them equal). Rotation steps: docs/ops/hosted.md.
 * @type {Readonly<Record<Env, readonly string[]>>}
 */
export const RELEASE_RETIRED_PUBKEYS = Object.freeze({
  staging: Object.freeze(/** @type {string[]} */ ([])),
  prod: Object.freeze(/** @type {string[]} */ ([])),
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
 * Verifies a FRESH signature (attach, a new floor): the current pinned key
 * alone, never a retired one. Refused while the pin is the placeholder.
 * @param {Env} env
 * @param {Uint8Array} payload
 * @param {string} signature
 * @param {Readonly<Record<Env, string>>} [pinned]
 * @param {Readonly<Record<Env, readonly string[]>>} [_retired] accepted and
 *   ignored by construction, so a caller (or a test) can prove no retired key
 *   is ever consulted here.
 * @returns {"verified"}
 */
export function verifyCurrentSignature(
  env,
  payload,
  signature,
  pinned = RELEASE_PUBKEY,
  _retired = RELEASE_RETIRED_PUBKEYS,
) {
  return verifySignature(env, payload, signature, pinned, {
    staging: [],
    prod: [],
  });
}

/**
 * A key or signature with no pinned key is refused, never warned past: the
 * gap between generating the keys and pinning them must not sign or attach.
 * @param {Env} env
 */
const notPinned = (env) =>
  new Error(`key set but RELEASE_PUBKEY.${env} not pinned`);

/**
 * The signing key's public x must be the current pinned one (the first key);
 * a retired key can never sign. Refused while the pin is still the placeholder.
 * @param {Env} env
 * @param {string} x
 * @param {Readonly<Record<Env, string>>} [pinned]
 * @param {Readonly<Record<Env, readonly string[]>>} [retired]
 * @returns {"verified"}
 */
export function checkSigningKey(
  env,
  x,
  pinned = RELEASE_PUBKEY,
  retired = RELEASE_RETIRED_PUBKEYS,
) {
  const k = pinnedOf(env, pinned);
  if (k === null) throw notPinned(env);
  if (x !== k && (retired[env] ?? []).includes(x))
    throw new Error(
      `the signing key is a retired RELEASE_PUBKEY.${env} key; a retired key can never sign`,
    );
  if (x !== k)
    throw new Error(
      `the signing key is not the pinned RELEASE_PUBKEY.${env} (wrong or swapped secret)`,
    );
  return "verified";
}

/**
 * Verifies `signature` over `payload` with the current pinned key or a retired
 * one still accepted; refused while the current pin is still the placeholder.
 * @param {Env} env
 * @param {Uint8Array} payload
 * @param {string} signature
 * @param {Readonly<Record<Env, string>>} [pinned]
 * @param {Readonly<Record<Env, readonly string[]>>} [retired]
 * @returns {"verified"}
 */
export function verifySignature(
  env,
  payload,
  signature,
  pinned = RELEASE_PUBKEY,
  retired = RELEASE_RETIRED_PUBKEYS,
) {
  if (!SIG_RE.test(signature))
    throw new Error("the signature is not 86 base64url characters");
  const k = pinnedOf(env, pinned);
  if (k === null) throw notPinned(env);
  const accepted = [k, ...(retired[env] ?? [])];
  if (!accepted.every((x) => typeof x === "string" && PUBKEY_RE.test(x)))
    throw new Error(`RELEASE_RETIRED_PUBKEYS.${env} is malformed`);
  const sig = Buffer.from(signature, "base64url");
  const ok = accepted.some((x) =>
    verify(
      null,
      payload,
      createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x },
        format: "jwk",
      }),
      sig,
    ),
  );
  if (!ok)
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
