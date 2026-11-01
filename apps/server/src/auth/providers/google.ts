import {
  brokerNonce,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GoogleTokenError,
  brokerRedeemRequest as signedRedeemRequest,
  verifyGoogleIdToken,
} from "@oa/auth-core";
import { AUTH } from "@oa/shared";
import type { Env } from "../../env.js";
import { ApiError, appOrigin } from "../../http/errors.js";
import {
  BrokerGateRefusedError,
  BrokerGateStaleError,
  BrokerUnavailableError,
  brokerFetch,
} from "../broker-transport.js";
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

/**
 * The signed redeem request for the auth broker (POST /google/redeem). The
 * broker check (services/broker-check.ts) builds it too, with junk values,
 * so that probe signs exactly as a real sign-in does. The signing lives in
 * @oa/auth-core, shared with the Provisioning API's admin sign-in.
 */
export function brokerRedeemRequest(
  t: Extract<GoogleTransport, { kind: "broker" }>,
  a: { code: string; verifier: string; nonce: string; bstate?: string },
): Promise<Request> {
  return signedRedeemRequest(t, a);
}

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
    const req = await brokerRedeemRequest(t, a);
    // A service binding, else the invocation's AUTH_BROKER capability, else
    // public HTTPS (never hosted); the request is signed either way.
    try {
      res = await brokerFetch(env, "auth", req);
    } catch (e) {
      // No usable capability (none, or one past its invocation).
      if (
        e instanceof BrokerUnavailableError ||
        e instanceof BrokerGateStaleError
      )
        return fail("broker_unavailable");
      // The platform's gate refused it (never the broker's own 401).
      if (e instanceof BrokerGateRefusedError)
        return fail("broker_gate_refused");
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
