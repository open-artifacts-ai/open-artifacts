import { AUTH } from "@oa/shared";
import type { Env } from "../../env.js";
import { ApiError, appOrigin } from "../../http/errors.js";
import { authConfig } from "../config.js";
import { fail } from "../oidc.js";
import type { OidcProvider, VerifiedIdentity } from "./types.js";

// Sign in with GitHub (self-hosted direct transport only, #3087 slice 3).
// GitHub OAuth 2.0 is not OIDC and has no `nonce` parameter or ID token:
// the PKCE `code_verifier` and the HMAC-signed, single-use `state` cookie
// owned by oidc.ts are the binding for the authorization flow.

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";
export const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

const USER_AGENT = "open-artifacts";
const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callbackGithub}`;

/** The GitHub config, or 404 (sign-in not offered). */
function githubConfig(env: Env) {
  const cfg = authConfig(env);
  if (!cfg.github) throw new ApiError("not_found", "Not found");
  return cfg.github;
}

/** Trades `code` + PKCE `verifier` for a GitHub access token. */
async function exchange(
  env: Env,
  clientId: string,
  secret: string,
  a: { code: string; verifier: string },
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        code: a.code,
        redirect_uri: redirectUri(env),
        code_verifier: a.verifier,
      }),
      redirect: "manual",
    });
  } catch {
    return fail("token_fetch");
  }
  if (!res.ok) {
    await res.body?.cancel();
    return fail(`token_http_${res.status}`);
  }
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    return fail("token_bad_json");
  }
  const token = (out as { access_token?: unknown } | null)?.access_token;
  return typeof token === "string" && token.length > 0
    ? token
    : fail("no_access_token");
}

/** Fetches JSON from the GitHub REST API with the access token. */
async function githubApi(
  url: string,
  token: string,
  name: "user" | "emails",
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
      },
      redirect: "manual",
    });
  } catch {
    return fail(`${name}_fetch`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    return fail(`${name}_http_${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    return fail(`${name}_bad_json`);
  }
}

type GithubEmail = {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
};

export const githubProvider: OidcProvider = {
  id: "github",
  callbackPath: AUTH.callbackGithub,

  authorizeUrl(env, a) {
    const g = githubConfig(env);
    const u = new URL(GITHUB_AUTHORIZE_URL);
    // GitHub has no nonce: PKCE (code_challenge S256) and state bind the flow.
    u.search = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: redirectUri(env),
      scope: "read:user user:email",
      state: a.state,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  },

  async redeem(env, a): Promise<VerifiedIdentity> {
    const g = githubConfig(env);
    const token = await exchange(env, g.clientId, g.secret, a);
    const [userRaw, emailsRaw] = await Promise.all([
      githubApi(GITHUB_USER_URL, token, "user"),
      githubApi(GITHUB_EMAILS_URL, token, "emails"),
    ]);

    const user =
      userRaw && typeof userRaw === "object"
        ? (userRaw as { id?: unknown; name?: unknown })
        : null;
    if (
      !user ||
      typeof user.id !== "number" ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0
    )
      return fail("claims");

    if (!Array.isArray(emailsRaw)) return fail("claims");
    // Only the primary, verified email is accepted; never fall back to another address.
    const primary = emailsRaw.find(
      (e): e is GithubEmail =>
        e !== null &&
        typeof e === "object" &&
        (e as GithubEmail).primary === true,
    );
    if (
      !primary ||
      typeof primary.email !== "string" ||
      primary.email.trim() === ""
    )
      return fail("email");
    if (primary.verified !== true) return fail("email_unverified");

    return {
      provider: "github",
      // Numeric user id is stable; login can be renamed or recycled.
      subject: String(user.id),
      email: primary.email,
      emailVerified: true,
      name: typeof user.name === "string" ? user.name : null,
      tenant: null,
    };
  },
};
