import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSealedNode } from "../../../../scripts/ops/staging-test-admin.js";
import { openSealed, sealTo } from "../../src/auth/seal.js";

// R28 seals with WebCrypto (src/auth/seal.ts); the agent's helper opens with
// node:crypto (scripts/ops/staging-test-admin.ts). Both must agree (#1053).

describe("oa-seal-v1 interop", () => {
  it("a value R28 seals opens with the helper's node:crypto opener", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const pub = publicKey.export({ format: "jwk" }).x as string;
    const sealed = await sealTo(pub, "the-sid");
    expect(openSealedNode(privateKey, sealed)).toBe("the-sid");
  });

  it("a wrong key or a changed byte fails", async () => {
    const a = generateKeyPairSync("x25519");
    const b = generateKeyPairSync("x25519");
    const sealed = await sealTo(
      a.publicKey.export({ format: "jwk" }).x as string,
      "s",
    );
    expect(() => openSealedNode(b.privateKey, sealed)).toThrow();
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3] as string, "base64url");
    ct[0] = (ct[0] ?? 0) ^ 1;
    parts[3] = ct.toString("base64url");
    expect(() => openSealedNode(a.privateKey, parts.join("."))).toThrow();
  });

  it("the WebCrypto opener agrees", async () => {
    const k = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = Buffer.from(
      (await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer,
    ).toString("base64url");
    expect(await openSealed(k, await sealTo(raw, "x"))).toBe("x");
  });
});
