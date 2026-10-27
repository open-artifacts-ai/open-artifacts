import {
  brokerNonce,
  flowHash,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GoogleTokenError,
  keyId,
  publicFromPkcs8,
  signRedeem,
  verifyGoogleIdToken,
} from "@oa/auth-core";
import { AUTH } from "@oa/shared";
import type { Env } from "../../env.js";
import { ApiError, appOrigin } from "../../http/errors.js";
import { b64urlEncode } from "../../util/crypto.js";
import { BrokerUnavailableError, brokerFetch } from "../broker-transport.js";
import { authConfig, type GoogleTransport } from "../config.js";
import { fail } from "../oidc.js";
import type { OidcProvider, VerifiedIdentity } from "./types.js";

// Sign in with Google. The install verifies the ID token itself (signature,
// iss, aud, azp, exp, its own nonce, email_verified, hd in AUTH_DOMAINS),
// whichever transport fetched it:
// - direct: this install holds its own client secret (self-hosted, or a
//   dedicated client) and exchanges the code itself;
// - broker (hosted): the shared client's secret lives only in the auth
//   broker. Google redirects to the broker, the broker relays the code to this
//   install's registered origin, and this install trades it for Google's raw
//   ID token through a request signed with its own Ed25519 key.

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callbackGoogle}`;

/** The Google config, or 404 (sign-in not offered). */
function googleConfig(env: Env) {
  const cfg = authConfig(env);
  if (!cfg.google) throw new ApiError("not_found", "Not found");
  return { ...cfg.google, domains: cfg.domains };
}

const kids = new Map<string, Promise<string>>();
/** This install's key id: derived from its public key, never configured (N3). */
const kidOf = (signingKey: string) => {
  let k = kids.get(signingKey);
  if (!k) {
    k = publicFromPkcs8(signingKey).then(keyId);
    k.catch(() => kids.delete(signingKey));
    kids.set(signingKey, k);
  }
  return k;
};

/** The PKCE S256 challenge of `verifier`. */
const s256 = async (verifier: string) =>
  b64urlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );

/** Google's raw ID token for `code`, by this install's transport. */
async function exchange(
  env: Env,
  clientId: string,
  t: GoogleTransport,
  a: { code: string; verifier: string; nonce: string; bstate?: string },
): Promise<string> {
  let res: Response;
  if (t.kind === "direct") {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: redirectUri(env),
        client_id: clientId,
        client_secret: t.secret,
        code_verifier: a.verifier,
      }),
      redirect: "manual",
    });
  } else {
    const body = JSON.stringify({
      install: t.installId,
      code: a.code,
      verifier: a.verifier,
      ts: Date.now(),
      // The broker refuses unless its state binds this exact flow.
      bstate: a.bstate ?? "",
      h: await flowHash(a.nonce, await s256(a.verifier)),
    });
    const kid = await kidOf(t.signingKey);
    const req = new Request(`${t.url}/google/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-kid": kid,
        "x-oa-sig": await signRedeem(t.signingKey, kid, body),
      },
      body,
      redirect: "manual",
    });
    // A service binding, else the invocation's AUTH_BROKER capability, else
    // public HTTPS (never hosted); the request is signed either way.
    try {
      res = await brokerFetch(env, "auth", req);
    } catch (e) {
      if (e instanceof BrokerUnavailableError)
        return fail("broker_unavailable");
      throw e;
    }
  }
  if (!res.ok) {
    await res.body?.cancel();
    return fail(
      `${t.kind === "direct" ? "token" : "broker"}_http_${res.status}`,
    );
  }
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    return fail("token_bad_json");
  }
  const idToken = (out as { id_token?: unknown } | null)?.id_token;
  return typeof idToken === "string" ? idToken : fail("no_id_token");
}

export const googleProvider: OidcProvider = {
  id: "google",
  callbackPath: AUTH.callbackGoogle,

  authorizeUrl(env, a) {
    const g = googleConfig(env);
    if (g.transport.kind === "broker") {
      const u = new URL(`${g.transport.url}/google/authorize`);
      u.search = new URLSearchParams({
        install: g.transport.installId,
        state: a.state,
        nonce: a.nonce,
        code_challenge: a.challenge,
        // The broker adds max_age=0 (T18 break-glass).
        ...(a.reauth ? { reauth: "1" } : {}),
      }).toString();
      return u.toString();
    }
    const u = new URL(GOOGLE_AUTHORIZE_URL);
    u.search = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: redirectUri(env),
      response_type: "code",
      scope: "openid email profile",
      state: a.state,
      nonce: a.nonce,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
      // A hint for the account chooser only; the hd claim is what's checked.
      hd: g.domains[0] as string,
      // Break-glass (T18): Google must re-authenticate; the callback checks
      // auth_time, so a silent SSO can't stand in for it.
      ...(a.reauth ? { max_age: "0" } : {}),
    }).toString();
    return u.toString();
  },

  async redeem(env, a): Promise<VerifiedIdentity> {
    const g = googleConfig(env);
    let idToken: string;
    try {
      idToken = await exchange(env, g.clientId, g.transport, a);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return fail("token_fetch");
    }
    try {
      // On the broker transport Google saw the install-derived nonce, not the
      // client nonce this flow generated. Recompute it with this install's id:
      // a token minted through another install (even with this flow's client
      // nonce) can't satisfy it.
      const expectNonce =
        g.transport.kind === "broker"
          ? await brokerNonce(g.transport.installId, a.nonce)
          : a.nonce;
      const id = await verifyGoogleIdToken(
        { clientId: g.clientId, domains: g.domains },
        idToken,
        expectNonce,
      );
      return {
        provider: "google",
        subject: id.sub,
        email: id.email,
        name: id.name,
        tenant: id.hd,
        authTime: id.authTime,
      };
    } catch (e) {
      if (e instanceof GoogleTokenError) return fail(e.stage);
      return fail("jwt_verify");
    }
  },
};
