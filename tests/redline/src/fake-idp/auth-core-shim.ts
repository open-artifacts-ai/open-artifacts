// LOCAL RED-LINE BUILDS ONLY. src/local-pair.ts aliases `@oa/auth-core` to
// this file in the wrangler configs it generates for a fake-IdP pair (its
// installs and its local broker); no release config does (test/fake-idp.test.ts
// checks). It is the real @oa/auth-core with Google's three URLs pointed at
// the rehearsal's fake IdP (src/fake-idp/server.ts) and Google ID tokens
// verified against that run's throwaway public key, both baked in at build
// time with `define`. Without those defines it refuses to load.
import { verifyGoogleIdToken as realVerify } from "../../../../packages/auth-core/src/index.ts";

export * from "../../../../packages/auth-core/src/index.ts";

declare const __OA_FAKE_IDP__: string;
declare const __OA_FAKE_IDP_JWK__: string;

const ORIGIN = typeof __OA_FAKE_IDP__ === "string" ? __OA_FAKE_IDP__ : "";
const JWK = typeof __OA_FAKE_IDP_JWK__ === "string" ? __OA_FAKE_IDP_JWK__ : "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ORIGIN) || !JWK)
  throw new Error("fake IdP shim: not a local fake-IdP build");

export const GOOGLE_AUTHORIZE_URL = `${ORIGIN}/o/oauth2/v2/auth`;
export const GOOGLE_TOKEN_URL = `${ORIGIN}/token`;
export const GOOGLE_JWKS_URL = `${ORIGIN}/oauth2/v3/certs`;

let key: Promise<CryptoKey> | undefined;
const fakeKey = () => {
  key ??= crypto.subtle.importKey(
    "jwk",
    JSON.parse(JWK) as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return key;
};

/** The real verifier, against this run's fake-IdP key instead of Google's JWKS. */
export const verifyGoogleIdToken: typeof realVerify = (opts, idToken, nonce) =>
  realVerify({ ...opts, jwks: fakeKey }, idToken, nonce);
