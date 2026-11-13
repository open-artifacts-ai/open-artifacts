// #2263: the WebAuthn JSON fallbacks (the browser lacks parse*FromJSON / toJSON).
import { PasskeyAssertionSchema, PasskeyCredentialSchema } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  b64urlToBytes,
  bytesToB64url,
  credentialToJSON,
  decodeCreationOptions,
  decodeRequestOptions,
} from "../src/auth/webauthn";

afterEach(() => vi.unstubAllGlobals());

const buf = (...n: number[]) => new Uint8Array(n).buffer;

describe("base64url", () => {
  it("round-trips every length and the url-safe alphabet", () => {
    for (let len = 0; len < 40; len++) {
      const bytes = Uint8Array.from(
        { length: len },
        (_, i) => (i * 37 + 250) % 256,
      );
      const s = bytesToB64url(bytes);
      expect(s).not.toMatch(/[+/=]/);
      expect(Array.from(b64urlToBytes(s))).toEqual(Array.from(bytes));
    }
    expect(bytesToB64url(buf(251, 255, 254))).toBe("-__-");
  });
});

describe("option decoding (no native parse)", () => {
  it("decodes creation options: challenge, user.id, excludeCredentials ids", () => {
    const o = decodeCreationOptions({
      challenge: "AQID",
      rp: { name: "OA", id: "x.test" },
      user: { id: "BAUG", name: "a", displayName: "A" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: "BwgJ" }],
    });
    expect(Array.from(new Uint8Array(o.challenge as ArrayBuffer))).toEqual([
      1, 2, 3,
    ]);
    expect(Array.from(new Uint8Array(o.user.id as ArrayBuffer))).toEqual([
      4, 5, 6,
    ]);
    expect(o.rp.id).toBe("x.test");
    const ex = o.excludeCredentials?.[0];
    expect(ex?.type).toBe("public-key");
    expect(Array.from(new Uint8Array(ex?.id as ArrayBuffer))).toEqual([
      7, 8, 9,
    ]);
  });

  it("decodes request options, with and without allowCredentials", () => {
    const o = decodeRequestOptions({
      challenge: "AQID",
      rpId: "x.test",
      allowCredentials: [{ type: "public-key", id: "BAUG" }],
    });
    expect(Array.from(new Uint8Array(o.challenge as ArrayBuffer))).toEqual([
      1, 2, 3,
    ]);
    expect(
      Array.from(new Uint8Array(o.allowCredentials?.[0]?.id as ArrayBuffer)),
    ).toEqual([4, 5, 6]);
    expect(
      decodeRequestOptions({ challenge: "AQID" }).allowCredentials,
    ).toEqual([]);
  });
});

describe("credentialToJSON (no native toJSON)", () => {
  it("encodes a registration so the shared schema accepts it", () => {
    const json = credentialToJSON({
      id: "AQID",
      rawId: buf(1, 2, 3),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: buf(1, 1),
        attestationObject: buf(2, 2),
        getTransports: () => ["internal"],
      },
    } as unknown as PublicKeyCredential);
    const r = PasskeyCredentialSchema.safeParse(json);
    expect(r.success).toBe(true);
    expect(json.rawId).toBe("AQID");
    expect((json.response as { transports: string[] }).transports).toEqual([
      "internal",
    ]);
  });

  it("encodes an assertion so the shared schema accepts it", () => {
    const json = credentialToJSON({
      id: "AQID",
      rawId: buf(1, 2, 3),
      type: "public-key",
      authenticatorAttachment: null,
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: buf(1),
        authenticatorData: buf(2),
        signature: buf(3),
        userHandle: buf(4),
      },
    } as unknown as PublicKeyCredential);
    expect(PasskeyAssertionSchema.safeParse(json).success).toBe(true);
  });

  it("an assertion with no userHandle still parses", () => {
    const json = credentialToJSON({
      id: "AQID",
      rawId: buf(1, 2, 3),
      type: "public-key",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: buf(1),
        authenticatorData: buf(2),
        signature: buf(3),
        userHandle: null,
      },
    } as unknown as PublicKeyCredential);
    expect(PasskeyAssertionSchema.safeParse(json).success).toBe(true);
  });

  it("prefers the browser's own toJSON", () => {
    expect(
      credentialToJSON({
        toJSON: () => ({ id: "native" }),
      } as unknown as PublicKeyCredential),
    ).toEqual({ id: "native" });
  });
});
