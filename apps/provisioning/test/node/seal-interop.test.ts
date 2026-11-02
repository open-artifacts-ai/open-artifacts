import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSealedNode } from "../../../../scripts/ops/staging-test-admin.js";
import {
  isLowOrderKey,
  openSealed,
  SEAL_INFO,
  sealTo,
} from "../../src/auth/seal.js";

// R28 seals with WebCrypto (src/auth/seal.ts); the agent's helper opens with
// node:crypto (scripts/ops/staging-test-admin.ts). Both must agree (#1053).

describe("oa-seal-v1 interop", () => {
  it("a value R28 seals opens with the helper's node:crypto opener", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const pub = publicKey.export({ format: "jwk" }).x as string;
    const sealed = await sealTo(pub, "the-sid", SEAL_INFO.testAdminSession);
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

  it("one info per use: R28's value never opens as R26's, nor the reverse", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const pub = publicKey.export({ format: "jwk" }).x as string;
    expect(SEAL_INFO.testAdminSession).toBe("oa-test-admin-session-v1");
    expect(SEAL_INFO.redlineCreds).toBe("oa-redline-creds-v1");
    const r28 = await sealTo(pub, "sid", SEAL_INFO.testAdminSession);
    const r26 = await sealTo(pub, "pat");
    expect(() =>
      openSealedNode(privateKey, r28, SEAL_INFO.redlineCreds),
    ).toThrow();
    expect(() => openSealedNode(privateKey, r26)).toThrow();
    expect(openSealedNode(privateKey, r26, SEAL_INFO.redlineCreds)).toBe("pat");
  });

  it("refuses every small-order public key, either value of the top bit", async () => {
    const LOW = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for (const h of LOW)
      for (const top of [0, 0x80]) {
        const b = Buffer.from(h, "hex");
        b[31] = ((b[31] ?? 0) & 0x7f) | top;
        expect(isLowOrderKey(b), `${h}/${top}`).toBe(true);
        await expect(
          sealTo(b.toString("base64url"), "sid", SEAL_INFO.testAdminSession),
          h,
        ).rejects.toThrow(/small-order/);
      }
    const { publicKey } = generateKeyPairSync("x25519");
    const ok = Buffer.from(
      publicKey.export({ format: "jwk" }).x as string,
      "base64url",
    );
    expect(isLowOrderKey(ok)).toBe(false);
  });
});
