// Sealed gates. NOT exported from the package index and not reachable from
// any options object: only a code change here opens them. Tests override
// them with vi.mock("../src/internal/gates.js").

/** Not a key. create refuses while RELEASE_PUBKEY[env] holds this. */
export const RELEASE_PUBKEY_PLACEHOLDER =
  "PLACEHOLDER-not-a-key-T3b-sets-the-release-signing-public-key";

/**
 * Prod creates were refused (ProdLocked) until the T3b release-record writer
 * existed and the red-line suite passed on staging. Both hold (hosted prod
 * bring-up, 2026-10-28), so prod is open.
 */
export const PROD_UNLOCKED: boolean = true;

/** Live envs always use the dispatch namespace; the account target is tests only. */
export const ALLOW_ACCOUNT_TARGET: boolean = false;

/**
 * The release workflow's Ed25519 public key per env: base64url of the raw
 * 32 bytes (JWK `x`). TODO(T3b): set the real keys, one per env (they must
 * differ); the private keys live only in the release workflow's secrets.
 */
export const RELEASE_PUBKEY: Readonly<Record<"staging" | "prod", string>> =
  Object.freeze({
    // Key ceremony 2026-10-24: the private halves live only in the GitHub
    // Environment secrets hosted-staging / hosted-prod RELEASE_SIGNING_KEY.
    staging: "octk3ysmW5j0Fw8hPs1ex3POLXmYH8l6nLoms8Rrb8c",
    prod: "tfSgv1PLRZlYQfVNpy9Vp1ohxdfZihz2WgPCYcCQyJg",
  });

/**
 * The anchor of the signed release floor (releases/floor.json): create and
 * publishRelease refuse a floor whose seq is below this, whatever the
 * platform D1 cache says (the provisioning token can write D1). Every
 * revocation bumps it here in the same change (docs/ops/hosted.md).
 */
export const FLOOR_MIN_SEQ: Readonly<Record<"staging" | "prod", number>> =
  Object.freeze({
    staging: 1,
    prod: 1,
  });
