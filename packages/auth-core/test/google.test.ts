import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { GoogleTokenError, verifyGoogleIdToken } from "../src/google.js";

const CID = "cid.apps.googleusercontent.com";
const NOW = 1_800_000_000; // seconds
let key: CryptoKey;
let other: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  key = kp.privateKey;
  other = (await generateKeyPair("RS256")).privateKey;
  const pub = (await exportJWK(kp.publicKey)) as JWK;
  jwks = createLocalJWKSet({ keys: [{ ...pub, kid: "k1", alg: "RS256" }] });
});

const base: JWTPayload & Record<string, unknown> = {
  iss: "https://accounts.google.com",
  aud: CID,
  azp: CID,
  sub: "S1",
  email: "bob@a.com",
  email_verified: true,
  hd: "a.com",
  nonce: "n1",
  iat: NOW,
  exp: NOW + 3600,
};

async function mint(
  claims: Record<string, unknown>,
  o: { key?: CryptoKey; kid?: string } = {},
): Promise<string> {
  const body = Object.fromEntries(
    Object.entries({ ...base, ...claims }).filter(([, v]) => v !== undefined),
  );
  return new SignJWT(body)
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "k1" })
    .sign(o.key ?? key);
}

/** An unsigned or differently signed token with the given header alg. */
function forge(alg: string, claims: Record<string, unknown> = {}): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg, kid: "k1" })}.${enc({ ...base, ...claims })}.${alg === "none" ? "" : "c2ln"}`;
}

const verify = (token: string, nonce = "n1") =>
  verifyGoogleIdToken(
    { clientId: CID, domains: ["a.com"], jwks, now: NOW * 1000 },
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

describe("verifyGoogleIdToken", () => {
  test("accepts the baseline", async () => {
    expect(await verify(await mint({ name: "Bob" }))).toEqual({
      sub: "S1",
      email: "bob@a.com",
      name: "Bob",
      hd: "a.com",
      authTime: null,
    });
  });

  test("auth_time (s) is returned in ms; a non-number is null", async () => {
    expect((await verify(await mint({ auth_time: NOW - 30 }))).authTime).toBe(
      (NOW - 30) * 1000,
    );
    expect(
      (await verify(await mint({ auth_time: "soon" }))).authTime,
    ).toBeNull();
  });

  test("the email is normalized (trimmed, lowercased); non-ASCII is refused", async () => {
    expect((await verify(await mint({ email: " Bob@A.COM " }))).email).toBe(
      "bob@a.com",
    );
    expect(await stageOf(verify(await mint({ email: "Kim@a.com" })))).toBe(
      "claims",
    );
  });

  test("a token issued over an hour ago is refused even if exp is later", async () => {
    const old = { iat: NOW - 3600 - 61, exp: NOW + 3600 };
    expect(await stageOf(verify(await mint(old)))).toBe("jwt_verify");
    const fresh = { iat: NOW - 3600 + 30, exp: NOW + 3600 };
    expect(await stageOf(verify(await mint(fresh)))).toBe("ok");
  });

  test("accepts the short issuer form", async () => {
    expect((await verify(await mint({ iss: "accounts.google.com" }))).sub).toBe(
      "S1",
    );
  });

  test("accepts an alias email when hd matches (email domain never consulted)", async () => {
    expect((await verify(await mint({ email: "bob@alias.com" }))).hd).toBe(
      "a.com",
    );
  });

  test("accepts a one-element aud array and a missing azp", async () => {
    expect((await verify(await mint({ aud: [CID], azp: undefined }))).sub).toBe(
      "S1",
    );
  });

  test.each([
    [{ hd: undefined }, "tenant"],
    [{ hd: "b.com" }, "tenant"],
    [{ hd: "A.com" }, "tenant"],
    [{ hd: "a.com." }, "tenant"],
    [{ hd: "x.a.com" }, "tenant"],
    [{ hd: ["a.com"] }, "tenant"],
    [{ email_verified: undefined }, "email_unverified"],
    [{ email_verified: "true" }, "email_unverified"],
    [{ email_verified: false }, "email_unverified"],
    [{ aud: "other" }, "jwt_verify"],
    [{ aud: [CID, "other"] }, "aud"],
    [{ azp: "other" }, "azp"],
    [{ iss: "https://evil" }, "jwt_verify"],
    [{ exp: NOW - 120 }, "jwt_verify"],
    [{ iat: undefined }, "jwt_verify"],
    [{ sub: undefined }, "jwt_verify"],
    [{ nonce: undefined }, "jwt_verify"],
    [{ email: undefined }, "jwt_verify"],
    [{ email: "no-at-sign" }, "claims"],
  ])("rejects %o with %s", async (claims, stage) => {
    expect(await stageOf(verify(await mint(claims)))).toBe(stage);
  });

  test("a validly signed token carrying another flow's nonce is refused", async () => {
    expect(await stageOf(verify(await mint({ nonce: "other-flow" })))).toBe(
      "nonce",
    );
  });

  test.each(["HS256", "none", "ES256", "PS256"])(
    "wrong alg %s is refused",
    async (alg) => {
      expect(await stageOf(verify(forge(alg)))).toBe("jwt_verify");
    },
  );

  test("a token signed by an unknown key is refused", async () => {
    expect(await stageOf(verify(await mint({}, { key: other })))).toBe(
      "jwt_verify",
    );
  });

  test("garbage is refused", async () => {
    expect(await stageOf(verify("not.a.jwt"))).toBe("jwt_verify");
  });

  test("an empty domain list admits nobody", async () => {
    expect(
      await stageOf(
        verifyGoogleIdToken(
          { clientId: CID, domains: [], jwks, now: NOW * 1000 },
          await mint({}),
          "n1",
        ),
      ),
    ).toBe("tenant");
  });

  test("name is trimmed, capped at 200, null when blank", async () => {
    expect((await verify(await mint({ name: "  " }))).name).toBeNull();
    expect((await verify(await mint({ name: "x".repeat(300) }))).name).toBe(
      "x".repeat(200),
    );
  });
});
