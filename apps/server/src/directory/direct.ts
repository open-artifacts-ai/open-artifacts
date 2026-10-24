import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_DIRECTORY_SCOPES,
  GOOGLE_TOKEN_URL,
} from "@oa/auth-core";
import { R } from "@oa/shared";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import { open } from "./crypto.js";
import {
  type ConsentCallback,
  type DirectoryClient,
  type DirectoryTransport,
  grantOf,
  TransportError,
} from "./transport.js";

// The direct transport (self-host without our broker): the install's own
// Google app. Its secret lives in this install's env, which is fine: it is
// their app. Same scopes, offline consent and hd hint as the broker.

type Direct = Extract<DirectoryTransport, { kind: "direct" }>;

/** Google redirects straight back to R.directoryCallback on this install. */
export const directRedirectUri = (env: Env) =>
  `${appOrigin(env)}${R.directoryCallback}`;

async function token(form: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  } catch {
    throw new TransportError("exchange");
  }
  const out = await res.json().catch(() => null);
  if (res.ok) return out;
  if ((out as { error?: unknown } | null)?.error === "invalid_grant")
    throw new TransportError("invalid_grant");
  throw new TransportError("exchange");
}

export function directClient(env: Env, t: Direct): DirectoryClient {
  return {
    kind: "direct",
    beginConsent({ state, challenge, hd }) {
      const u = new URL(GOOGLE_AUTHORIZE_URL);
      u.search = new URLSearchParams({
        client_id: t.clientId,
        redirect_uri: directRedirectUri(env),
        response_type: "code",
        scope: GOOGLE_DIRECTORY_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        // A hint for the account chooser only; the callback checks hd.
        hd,
      }).toString();
      return u.toString();
    },
    async completeConsent(cb: ConsentCallback) {
      return grantOf(
        await token({
          grant_type: "authorization_code",
          code: cb.code,
          redirect_uri: directRedirectUri(env),
          client_id: t.clientId,
          client_secret: t.secret,
          code_verifier: cb.verifier,
        }),
        t.clientId,
      );
    },
    async accessToken(sealedRefresh) {
      const out = (await token({
        grant_type: "refresh_token",
        refresh_token: await open(env, sealedRefresh),
        client_id: t.clientId,
        client_secret: t.secret,
      })) as { access_token?: unknown } | null;
      if (typeof out?.access_token !== "string")
        throw new TransportError("exchange");
      return out.access_token;
    },
  };
}
