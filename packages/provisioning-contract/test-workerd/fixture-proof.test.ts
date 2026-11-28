import { describe, expect, it } from "vitest";
import {
  fixtureOwnerKeyId,
  parseTestInstallActorKey,
  signFixtureDeleteProof,
  testInstallActorKey,
  testInstallDeleteActorKey,
  testInstallOwns,
  verifyFixtureDeleteProof,
} from "../src/authz.js";

function bytesToB64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("fixture Ed25519 ownership proof in workerd", () => {
  it("verifies signed delete proofs and isolates two same-repo fixtures", async () => {
    const mk = async () => {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const pub = bytesToB64u(
        new Uint8Array(
          (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
        ),
      );
      return {
        pub,
        privateKey: pair.privateKey,
        keyId: await fixtureOwnerKeyId(pub),
      };
    };
    const a = await mk();
    const b = await mk();
    const actorA = testInstallActorKey("42", "1001", a.keyId);
    const actorB = testInstallActorKey("42", "1002", b.keyId);
    const fA = {
      id: "i0123456789a",
      slug: "t-alpha",
      testHooks: true,
      createdBy: actorA,
    };
    const fB = {
      id: "i0123456789b",
      slug: "t-beta",
      testHooks: true,
      createdBy: actorB,
    };

    const now = Date.UTC(2026, 10, 28, 12, 0, 0);
    const expiresAt = now + 5 * 60_000;
    const proofA = await signFixtureDeleteProof(a.privateKey, {
      repositoryId: "42",
      installId: fA.id,
      expiresAt,
    });
    const verified = await verifyFixtureDeleteProof({
      ownerPublicKey: a.pub,
      proof: proofA,
      repositoryId: "42",
      now,
    });
    expect(verified).toEqual({
      installId: fA.id,
      expiresAt,
      ownerKeyId: a.keyId,
    });
    expect(
      await verifyFixtureDeleteProof({
        ownerPublicKey: b.pub,
        proof: proofA,
        repositoryId: "42",
        now,
      }),
    ).toBeNull();

    const delScopeA = parseTestInstallActorKey(
      testInstallDeleteActorKey("42", a.keyId, fA.id),
    );
    if (!delScopeA) throw new Error("expected delete scope");
    expect(testInstallOwns(fA, delScopeA)).toBe(true);
    expect(testInstallOwns(fB, delScopeA)).toBe(false);
  });
});
