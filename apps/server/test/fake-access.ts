import { env } from "cloudflare:workers";
import { AUTH } from "@oa/shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, vi } from "vitest";
import { createApp } from "../src/app.js";

// A fake Access (token and JWKS behind a fetch spy) answers the OIDC
// exchange, so a test drives the real Access callback. Callers restore the
// fetch spy (vi.restoreAllMocks) after each test.
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
export const ACCESS_ISSUER = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}`;

// One key per isolate: the verifier caches the issuer's JWKS at module scope.
let signing: Promise<{ kp: CryptoKeyPair; jwk: object }> | undefined;
const signingKey = () =>
  (signing ??= (async () => {
    const kp = await generateKeyPair("RS256", { extractable: true });
    return {
      kp,
      jwk: { ...(await exportJWK(kp.publicKey)), kid: "a1", alg: "RS256" },
    };
  })());

async function fakeAccess(email: string, nonce: string) {
  const { kp, jwk } = await signingKey();
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === `${ACCESS_ISSUER}/jwks`)
      return Response.json({ keys: [jwk] });
    if (req.url === `${ACCESS_ISSUER}/token` && req.method === "POST") {
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        iss: ACCESS_ISSUER,
        aud: env.ACCESS_CLIENT_ID,
        sub: `access-${email}`,
        email,
        nonce,
        iat: now,
        exp: now + 600,
      })
        .setProtectedHeader({ alg: "RS256", kid: "a1" })
        .sign(kp.privateKey);
      return Response.json({ id_token: idToken, token_type: "Bearer" });
    }
    return realFetch(input, init);
  });
}

/** A full Access sign-in for `email` (state cookie, fake token exchange). */
export async function accessSignIn(email: string): Promise<Response> {
  const start = await app.fetch(
    new Request(`http://app.localhost${AUTH.login}?next=/`),
    env,
    ctx,
  );
  const u = new URL(start.headers.get("location") ?? "");
  expect(u.origin + u.pathname).toBe(`${ACCESS_ISSUER}/authorization`);
  const cookie =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  await fakeAccess(email, u.searchParams.get("nonce") ?? "");
  return app.fetch(
    new Request(
      `http://app.localhost${AUTH.callback}?state=${u.searchParams.get("state")}&code=c1`,
      { headers: { cookie } },
    ),
    env,
    ctx,
  );
}
