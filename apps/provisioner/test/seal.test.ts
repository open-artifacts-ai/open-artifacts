import { describe, expect, it } from "vitest";
import { openSealed, sealTo } from "../src/seal.js";

// redline_creds' sealed delivery (design v7 10.1) in workerd: X25519, HKDF,
// AES-GCM through the runtime's WebCrypto.

const keyPair = async () =>
  (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
const pubOf = async (k: CryptoKeyPair) => {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer,
  );
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

describe("sealTo / openSealed", () => {
  it("only the recipient's key opens it; each seal is fresh", async () => {
    const me = await keyPair();
    const other = await keyPair();
    const pub = await pubOf(me);
    expect(pub).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    const a = await sealTo(pub, '{"pat":"oa_pat_x"}');
    const b = await sealTo(pub, '{"pat":"oa_pat_x"}');
    expect(a).not.toBe(b);
    expect(a).not.toContain("oa_pat_x");
    expect(await openSealed(me, a)).toBe('{"pat":"oa_pat_x"}');
    await expect(openSealed(other, a)).rejects.toThrow();
    const [p, e, i, c] = a.split(".");
    await expect(
      openSealed(me, [p, e, i, `${(c as string).slice(0, -2)}AA`].join(".")),
    ).rejects.toThrow();
    await expect(sealTo("AAAA", "x")).rejects.toThrow(/32 bytes/);
  });
});
