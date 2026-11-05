import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as PUBKEYS from "../../../scripts/ci/release-pubkeys.mjs";
import {
  PROD_UNLOCKED,
  RELEASE_PUBKEY,
  RELEASE_PUBKEY_PLACEHOLDER,
} from "../src/internal/gates.js";

// The key ceremony (2026-10-24): each env's release signing key is an Ed25519
// key whose private half lives only in that env's GitHub Environment secret.
// The public halves are pinned here and in scripts/ci/release-pubkeys.mjs.
describe("pinned release public keys", () => {
  for (const env of ["staging", "prod"] as const)
    it(`${env} is 32 bytes of base64url and a valid Ed25519 public key`, () => {
      const x = RELEASE_PUBKEY[env];
      expect(x).not.toBe(RELEASE_PUBKEY_PLACEHOLDER);
      expect(x).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(x, "base64url")).toHaveLength(32);
      const k = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x },
        format: "jwk",
      });
      expect(k.asymmetricKeyType).toBe("ed25519");
    });
  it("staging and prod differ", () => {
    expect(RELEASE_PUBKEY.staging).not.toBe(RELEASE_PUBKEY.prod);
  });
  it("the node:* copy pins the same keys", () => {
    expect({ ...PUBKEYS.RELEASE_PUBKEY }).toEqual({ ...RELEASE_PUBKEY });
  });
  // Prod unlocked in its own PR, after the red-line suite passed on staging.
  it("prod is unlocked", () => {
    expect(PROD_UNLOCKED).toBe(true);
  });
});
