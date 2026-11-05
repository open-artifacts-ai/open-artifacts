import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as PUBKEYS from "../../../scripts/ci/release-pubkeys.mjs";
import { acceptedKeys } from "../src/internal/accepted-keys.js";
import {
  FLOOR_DOMAIN,
  openFloor,
  openReleaseRecord,
  releaseRecordPayload,
} from "../src/release.js";

// Key rotation: verification accepts [current, ...retired]; signing accepts
// only the current key (docs/ops/hosted.md).
const pair = () => generateKeyPairSync("ed25519");
const xOf = (k: KeyObject) => String(k.export({ format: "jwk" }).x);
const OLD = pair();
const NEW = pair();
const OTHER = pair();

const floorString = JSON.stringify({
  env: "staging",
  minVersion: "0.1.0",
  revoked: [],
  seq: 1,
});
const signedFloor = (priv: KeyObject) => ({
  record: floorString,
  signature: sign(
    null,
    Buffer.from(`${FLOOR_DOMAIN}\nstaging\n${floorString}`),
    priv,
  ).toString("base64url"),
});

describe("provision verification accepts retired keys", () => {
  const accepted = [xOf(NEW.publicKey), xOf(OLD.publicKey)];
  it("a floor signed with a retired key still opens", () => {
    expect(
      openFloor(signedFloor(OLD.privateKey), accepted, "staging").seq,
    ).toBe(1);
  });
  it("a floor signed with the current key opens", () => {
    expect(
      openFloor(signedFloor(NEW.privateKey), accepted, "staging").seq,
    ).toBe(1);
  });
  it("a signature by an unknown key fails", () => {
    expect(() =>
      openFloor(signedFloor(OTHER.privateKey), accepted, "staging"),
    ).toThrow(/does not verify/);
  });
  it("a retired key alone is not enough once removed from the list", () => {
    expect(() =>
      openFloor(signedFloor(OLD.privateKey), [xOf(NEW.publicKey)], "staging"),
    ).toThrow(/does not verify/);
  });
  it("a malformed key in the list refuses everything", () => {
    expect(() =>
      openFloor(signedFloor(OLD.privateKey), [...accepted, "nope"], "staging"),
    ).toThrow(/does not verify/);
  });
  it("a release record signed with a retired key still opens (same verifier)", () => {
    const rec = "{}";
    const stored = {
      record: rec,
      signature: sign(
        null,
        releaseRecordPayload("staging", rec),
        OLD.privateKey,
      ).toString("base64url"),
    };
    // Verifies, then fails on the record's shape, not on the signature.
    expect(() => openReleaseRecord(stored, accepted, "staging")).toThrow(
      /release record has keys/,
    );
    expect(() =>
      openReleaseRecord(stored, [xOf(NEW.publicKey)], "staging"),
    ).toThrow(/does not verify/);
  });
});

describe("the node:* verifier and the signing-key check", () => {
  const pinned = {
    staging: xOf(NEW.publicKey),
    prod: xOf(OTHER.publicKey),
  };
  const retired = { staging: [xOf(OLD.publicKey)], prod: [] as string[] };
  const payload = Buffer.from("payload");
  const sig = (k: KeyObject) => sign(null, payload, k).toString("base64url");
  it("verifySignature accepts the current and a retired key, refuses an unknown one", () => {
    for (const k of [NEW, OLD])
      expect(
        PUBKEYS.verifySignature(
          "staging",
          payload,
          sig(k.privateKey),
          pinned,
          retired,
        ),
      ).toBe("verified");
    expect(() =>
      PUBKEYS.verifySignature(
        "staging",
        payload,
        sig(OTHER.privateKey),
        pinned,
        retired,
      ),
    ).toThrow(/does not verify/);
  });
  it("checkSigningKey accepts only the current key", () => {
    expect(
      PUBKEYS.checkSigningKey("staging", xOf(NEW.publicKey), pinned, retired),
    ).toBe("verified");
  });
  it("signing with a retired key is refused", () => {
    expect(() =>
      PUBKEYS.checkSigningKey("staging", xOf(OLD.publicKey), pinned, retired),
    ).toThrow(/retired .* can never sign/);
  });
  it("signing with an unknown key is refused", () => {
    expect(() =>
      PUBKEYS.checkSigningKey("staging", xOf(OTHER.publicKey), pinned, retired),
    ).toThrow(/not the pinned/);
  });
});

describe("retired keys never cross envs", () => {
  const prodFloor = JSON.stringify({
    env: "prod",
    minVersion: "0.1.0",
    revoked: [],
    seq: 1,
  });
  const signedProdFloor = (priv: KeyObject) => ({
    record: prodFloor,
    signature: sign(
      null,
      Buffer.from(`${FLOOR_DOMAIN}\nprod\n${prodFloor}`),
      priv,
    ).toString("base64url"),
  });
  // staging retired OLD; prod has no retired key.
  const retired = { staging: [xOf(OLD.publicKey)], prod: [] as string[] };

  it("acceptedKeys takes the env's own list only", () => {
    expect(acceptedKeys("staging", retired)).toContain(xOf(OLD.publicKey));
    expect(acceptedKeys("prod", retired)).not.toContain(xOf(OLD.publicKey));
  });
  it("a key retired in staging is refused for a prod verify (TS)", () => {
    expect(() =>
      openFloor(
        signedProdFloor(OLD.privateKey),
        acceptedKeys("prod", retired),
        "prod",
      ),
    ).toThrow(/does not verify/);
  });
  it("a key retired in staging is refused for a prod verify (mjs)", () => {
    const pinned = { staging: xOf(NEW.publicKey), prod: xOf(OTHER.publicKey) };
    const payload = Buffer.from("p");
    const sig = sign(null, payload, OLD.privateKey).toString("base64url");
    expect(
      PUBKEYS.verifySignature("staging", payload, sig, pinned, retired),
    ).toBe("verified");
    expect(() =>
      PUBKEYS.verifySignature("prod", payload, sig, pinned, retired),
    ).toThrow(/does not verify/);
  });
  it("verifyCurrentSignature takes the current key alone", () => {
    const pinned = { staging: xOf(NEW.publicKey), prod: xOf(OTHER.publicKey) };
    const payload = Buffer.from("p");
    const by = (k: KeyObject) => sign(null, payload, k).toString("base64url");
    expect(
      PUBKEYS.verifyCurrentSignature(
        "staging",
        payload,
        by(NEW.privateKey),
        pinned,
      ),
    ).toBe("verified");
    expect(() =>
      PUBKEYS.verifyCurrentSignature(
        "staging",
        payload,
        by(OLD.privateKey),
        pinned,
      ),
    ).toThrow(/does not verify/);
  });
});
