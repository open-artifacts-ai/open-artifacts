import { describe, expect, it } from "vitest";
import {
  derToRaw,
  PasskeyError,
  verifyAssertion,
  verifyRegistration,
} from "../src/auth/webauthn.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { cborBytes, FakeAuthenticator } from "./passkey-helper.js";

const want = {
  challenge: "chal-1",
  origin: "https://oa.test",
  rpId: "oa.test",
};
const o = { ...want };

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PasskeyError) return e.reason;
    throw e;
  }
  return "ok";
};

async function registered() {
  const a = await FakeAuthenticator.create();
  const r = await verifyRegistration(await a.attest(o), want);
  return { a, r };
}

describe("verifyRegistration", () => {
  it("accepts a user-verified ES256 attestation and returns the key", async () => {
    const { a, r } = await registered();
    expect(r.credentialId).toBe(a.credentialId);
    expect(r.alg).toBe(-7);
    expect(r.signCount).toBe(0);
  });

  it.each([
    ["challenge", { challengeOverride: "other" }],
    ["origin", { originOverride: "https://evil.test" }],
    ["rp_id", { rpIdOverride: "evil.test" }],
    ["user_verification", { uv: false }],
    ["user_presence", { up: false }],
    ["type", { type: "webauthn.get" }],
  ])("refuses a bad %s", async (why, bad) => {
    const a = await FakeAuthenticator.create();
    expect(
      await reason(verifyRegistration(await a.attest({ ...o, ...bad }), want)),
    ).toBe(why);
  });

  it("refuses garbage", async () => {
    expect(
      await reason(
        verifyRegistration({ id: "x", rawId: "x", response: {} }, want),
      ),
    ).not.toBe("ok");
    expect(await reason(verifyRegistration(null, want))).not.toBe("ok");
  });
});

describe("verifyAssertion", () => {
  it("accepts a valid assertion and returns the new counter", async () => {
    const { a, r } = await registered();
    const out = await verifyAssertion(await a.assert(o), want, {
      publicKey: r.publicKey,
      signCount: r.signCount,
    });
    expect(out.signCount).toBe(1);
  });

  it.each([
    ["challenge", { challengeOverride: "other" }],
    ["origin", { originOverride: "https://evil.test" }],
    ["rp_id", { rpIdOverride: "evil.test" }],
    ["user_verification", { uv: false }],
    ["type", { type: "webauthn.create" }],
  ])("refuses a bad %s", async (why, bad) => {
    const { a, r } = await registered();
    expect(
      await reason(
        verifyAssertion(await a.assert({ ...o, ...bad }), want, {
          publicKey: r.publicKey,
          signCount: 0,
        }),
      ),
    ).toBe(why);
  });

  it("refuses a signature from another key", async () => {
    const { r } = await registered();
    const other = await FakeAuthenticator.create();
    expect(
      await reason(
        verifyAssertion(await other.assert(o), want, {
          publicKey: r.publicKey,
          signCount: 0,
        }),
      ),
    ).toBe("signature");
  });

  it("refuses a signCount that did not grow, and takes 0 with 0", async () => {
    const { a, r } = await registered();
    const stored = { publicKey: r.publicKey, signCount: 5 };
    expect(
      await reason(
        verifyAssertion(await a.assert({ ...o, signCount: 5 }), want, stored),
      ),
    ).toBe("sign_count");
    expect(
      await reason(
        verifyAssertion(await a.assert({ ...o, signCount: 3 }), want, stored),
      ),
    ).toBe("sign_count");
    expect(
      await reason(
        verifyAssertion(await a.assert({ ...o, signCount: 6 }), want, stored),
      ),
    ).toBe("ok");
    expect(
      await reason(
        verifyAssertion(await a.assert({ ...o, signCount: 0 }), want, {
          publicKey: r.publicKey,
          signCount: 0,
        }),
      ),
    ).toBe("ok");
  });

  it("refuses a tampered authenticator data", async () => {
    const { a, r } = await registered();
    const cred = await a.assert(o);
    const res = cred.response as Record<string, string>;
    res.authenticatorData = res.authenticatorData.replace(/.$/, (c) =>
      c === "A" ? "B" : "A",
    );
    expect(
      await reason(
        verifyAssertion(cred, want, { publicKey: r.publicKey, signCount: 0 }),
      ),
    ).not.toBe("ok");
  });
});

describe("derToRaw", () => {
  it("rejects malformed DER", () => {
    expect(() => derToRaw(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => derToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toThrow();
  });
});

describe("RSA keys", () => {
  const coseRsa = async (bits: number) => {
    const k = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: bits,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", k.publicKey);
    const dec = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
    return b64urlEncode(
      cborBytes(
        new Map<number, Uint8Array | number>([
          [1, 3],
          [3, -257],
          [-1, dec(jwk.n as string)],
          [-2, dec(jwk.e as string)],
        ]) as never,
      ),
    );
  };
  it("refuses a modulus under 2048 bits, takes 2048", async () => {
    const a = await FakeAuthenticator.create();
    const cred = await a.assert(o);
    const stored = (publicKey: string) => ({ publicKey, signCount: 0 });
    expect(
      await reason(verifyAssertion(cred, want, stored(await coseRsa(1024)))),
    ).toBe("algorithm");
    // 2048 is accepted as a key (the signature is then wrong: ES256 signed it).
    expect(
      await reason(verifyAssertion(cred, want, stored(await coseRsa(2048)))),
    ).toBe("signature");
  });
});
