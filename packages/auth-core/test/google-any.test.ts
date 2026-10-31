import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import * as core from "../src/index.js";
import {
  GoogleTokenError,
  verifyGoogleIdTokenAnyDomain,
} from "../src/google.js";

// The provisioning admin sign-in (design v7 4.3 step 4): every check of
// verifyGoogleIdToken except the hd one.

const CID = "cid.apps.googleusercontent.com";
const NOW = 1_800_000_000;
let key: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  key = kp.privateKey;
  const pub = (await exportJWK(kp.publicKey)) as JWK;
  jwks = createLocalJWKSet({ keys: [{ ...pub, kid: "k1", alg: "RS256" }] });
});

const base: JWTPayload & Record<string, unknown> = {
  iss: "https://accounts.google.com",
  aud: CID,
  azp: CID,
  sub: "S1",
  email: "me@gmail.com",
  email_verified: true,
  nonce: "n1",
  iat: NOW,
  exp: NOW + 3600,
};

const mint = (claims: Record<string, unknown> = {}) =>
  new SignJWT(
    Object.fromEntries(
      Object.entries({ ...base, ...claims }).filter(([, v]) => v !== undefined),
    ),
  )
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(key);

const verify = (token: string, nonce = "n1") =>
  verifyGoogleIdTokenAnyDomain(
    { clientId: CID, jwks, now: NOW * 1000 },
    token,
    nonce,
  );

const stageOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof GoogleTokenError) return e.stage;
    throw e;
  }
  return "ok";
};

describe("verifyGoogleIdTokenAnyDomain", () => {
  test("a consumer account (no hd) is accepted; hd is null", async () => {
    expect(await verify(await mint({ auth_time: NOW - 5 }))).toEqual({
      sub: "S1",
      email: "me@gmail.com",
      name: null,
      hd: null,
      authTime: (NOW - 5) * 1000,
    });
  });

  test("a Workspace account keeps its hd, any domain", async () => {
    expect((await verify(await mint({ hd: "b.com" }))).hd).toBe("b.com");
  });

  test("a non-string hd is reported as null, never trusted", async () => {
    expect((await verify(await mint({ hd: ["a.com"] }))).hd).toBeNull();
  });

  test.each([
    [{ email_verified: false }, "email_unverified"],
    [{ email_verified: "true" }, "email_unverified"],
    [{ aud: "other" }, "jwt_verify"],
    [{ aud: [CID, "other"] }, "aud"],
    [{ azp: "other" }, "azp"],
    [{ iss: "https://evil" }, "jwt_verify"],
    [{ exp: NOW - 120 }, "jwt_verify"],
    [{ iat: NOW - 3600 - 61 }, "jwt_verify"],
    [{ nonce: undefined }, "jwt_verify"],
    [{ nonce: "other" }, "nonce"],
    [{ email: "\u212Aim@a.com" }, "claims"],
  ])("still refuses %o with %s", async (claims, stage) => {
    expect(await stageOf(verify(await mint(claims)))).toBe(stage);
  });

  test("a separate export: verifyGoogleIdToken still requires hd", async () => {
    expect(
      await stageOf(
        core.verifyGoogleIdToken(
          { clientId: CID, domains: ["gmail.com"], jwks, now: NOW * 1000 },
          await mint(),
          "n1",
        ),
      ),
    ).toBe("tenant");
    expect(core.verifyGoogleIdTokenAnyDomain).toBe(
      verifyGoogleIdTokenAnyDomain,
    );
  });
});
