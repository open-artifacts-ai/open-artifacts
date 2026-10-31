import { ipKey } from "@oa/auth-core";
import {
  AuthorizationError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { type TokenScope, TokenScopeSchema } from "@oa/shared/provisioning";
import type { Env } from "../../env.js";
import { ApiError } from "../../errors.js";
import { limit } from "../../limits.js";
import { isRefusal, type Principal } from "../../principal.js";
import { countRefusal } from "../../refuse.js";
import { mintAgentToken, oauthLabel, revokeToken } from "../../services/tokens.js";
import { hmac } from "../crypto.js";
import {
  adminOrigin,
  readCookie,
  SESSION_COOKIE,
  sessionPrincipal,
} from "../session.js";
import { oauthAudit } from "./audit.js";
import { capped } from "./endpoints.js";
import { bouncePage, consentPage, messagePage } from "./pages.js";
import { authServer, type GrantProps, revokeLibraryGrants } from "./server.js";

// GET and POST /oauth/authorize on the admin host (design v7 9A.3.2): the
// admin session cookie (SameSite=Strict, so a cross-site arrival gets a
// same-origin bounce first), PKCE S256, the server-rendered consent page,
// and on Allow the one token service mint (mintAgentToken) before the
// library's completeAuthorization.

/** Consent needs this much session left, so a grant never dies minutes after Allow. */
export const CONSENT_MIN_SESSION_MS = 3_600_000;

const isScope = (s: string): s is TokenScope =>
  TokenScopeSchema.safeParse(s).success;

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * HMAC-SHA256(ADMIN_SESSION_KEY, "consent\n" + sid + "\n" + handle), hex. It
 * lives as long as the library's handle (10 min, single use).
 */
export const consentToken = async (env: Env, sid: string, handle: string) =>
  hex(await hmac(env.ADMIN_SESSION_KEY, `consent\n${sid}\n${handle}`));

/** Constant-time check: HMAC both sides with a fresh key, compare those. */
async function consentTokenOk(
  env: Env,
  sid: string,
  handle: string,
  got: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(got) || !handle) return false;
  const want = await consentToken(env, sid, handle);
  const k = hex(crypto.getRandomValues(new Uint8Array(16)));
  return (
    hex(await hmac(k, want)) === hex(await hmac(k, got))
  );
}

/** RL_PV_OAUTH_IP by ipKey on the consent routes (9A.7); a refusal page or null. */
async function limited(req: Request, env: Env): Promise<Response | null> {
  const ip = ipKey(req);
  const r = await limit(env, "oauth_ip", ip);
  if (!r) return null;
  try {
    await countRefusal(env, "oauth", r.code, ip);
  } catch {
    // The refusal stands without its count.
  }
  return r.code === "rate_limited"
    ? messagePage(
        "Too many requests",
        "Wait a minute, then start connecting again from your agent.",
        429,
      )
    : messagePage(
        "Unavailable",
        "Try again in a few minutes.",
        503,
      );
}

/** The query without the bounce marker: what /auth/start returns to. */
function authorizeReturn(url: URL): string {
  // Verbatim (4.3), only the `b` pairs dropped.
  const s = url.search
    .slice(1)
    .split("&")
    .filter((kv) => kv !== "" && !/^b(=|$)/.test(kv))
    .join("&");
  return `${url.pathname}${s ? `?${s}` : ""}`;
}

const signIn = (env: Env, url: URL) =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${adminOrigin(env)}/auth/start?return=${encodeURIComponent(authorizeReturn(url))}`,
      "cache-control": "no-store",
    },
  });

/** parseAuthRequest/approve/deny failures: a redirect only when the library says it is safe. */
function authorizeError(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo)
      return new Response(null, {
        status: 302,
        headers: { location: e.redirectTo, "cache-control": "no-store" },
      });
    return messagePage(
      "Cannot connect this agent",
      `${e.description || e.code}. Start connecting again from your agent.`,
      400,
    );
  }
  // An unknown client and other parse failures throw plain errors.
  if (e instanceof Error)
    return messagePage(
      "Cannot connect this agent",
      "This request is not valid. Start connecting again from your agent.",
      400,
    );
  throw e;
}

const signedOut = () =>
  messagePage(
    "Signed out",
    "Your admin session ended. Start connecting again from your agent.",
    401,
  );

/** GET /oauth/authorize. */
export async function showConsent(req: Request, env: Env): Promise<Response> {
  const lim = await limited(req, env);
  if (lim) return lim;
  const url = new URL(req.url);
  const now = Date.now();
  const p = await sessionPrincipal(req, env, now);
  const sid = readCookie(req, SESSION_COOKIE);
  if (isRefusal(p) || !sid) {
    // No session cookie on a cross-site arrival (a link from claude.ai, or
    // the 303 at the end of the sign-in chain): bounce once, same-origin.
    const site = req.headers.get("sec-fetch-site");
    const sameSite = site === "same-origin" || site === "none";
    if (!sameSite && url.searchParams.get("b") !== "1") {
      const ret = authorizeReturn(url);
      return bouncePage(`${ret}${ret.includes("?") ? "&" : "?"}b=1`);
    }
    return signIn(env, url);
  }
  const endsAt = p.session?.expiresAt ?? 0;
  if (endsAt - now < CONSENT_MIN_SESSION_MS) return signIn(env, url);

  const oauth = authServer(env).getOAuthApi(env);
  try {
    const request = await oauth.parseAuthRequest(req);
    // The library requires PKCE only for public clients (9A.3.1).
    if (!request.codeChallenge || request.codeChallengeMethod !== "S256")
      return messagePage(
        "Cannot connect this agent",
        "invalid_request: PKCE S256 is required. Start connecting again from your agent.",
        400,
      );
    const d = await oauth.describeConsent(request);
    const client = await oauth.lookupClient(request.clientId);
    const tx = await oauth.beginConsent(request);
    const reg = client?.registrationDate;
    return consentPage(
      {
        prod: env.OA_ENV === "prod",
        clientName: d.clientName,
        clientId: d.clientId,
        registeredMinutesAgo:
          typeof reg === "number"
            ? Math.max(0, Math.floor((now / 1000 - reg) / 60))
            : null,
        redirectHost: d.redirectHost,
        loopback: d.redirectIsLoopback,
        endsAt,
        handle: tx.handle,
        consentToken: await consentToken(env, sid, tx.handle),
      },
      tx.headers,
    );
  } catch (e) {
    return authorizeError(e);
  }
}

/** POST /oauth/authorize: Allow or Deny. */
export async function decideConsent(
  req: Request,
  env: Env,
): Promise<Response> {
  // No Origin check: the page's no-referrer policy makes browsers send
  // `Origin: null`. The consent token and the Strict cookie cover CSRF.
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return messagePage("Cannot connect this agent", "Cross-site request.", 403);
  const lim = await limited(req, env);
  if (lim) return lim;
  const p = await sessionPrincipal(req, env, Date.now());
  const sid = readCookie(req, SESSION_COOKIE);
  if (isRefusal(p) || !sid) return signedOut();
  const body = await capped(req);
  if (!body)
    return messagePage("Cannot connect this agent", "Invalid form.", 400);
  let form: FormData;
  try {
    form = await body.formData();
  } catch {
    return messagePage("Cannot connect this agent", "Invalid form.", 400);
  }
  const handle = String(form.get("request") ?? "");
  if (!(await consentTokenOk(env, sid, handle, String(form.get("consent") ?? ""))))
    return messagePage(
      "This page expired",
      "Start connecting again from your agent.",
      403,
    );
  const oauth = authServer(env).getOAuthApi(env);
  try {
    if (form.get("decision") !== "approve") return await deny(env, oauth, p, req, handle);
    const scopes = form.getAll("scope").map(String).filter(isScope);
    // The library accepts [] ([].every is true): a grant with no scopes.
    if (scopes.length === 0)
      return messagePage(
        "Pick at least one permission",
        "Start connecting again from your agent and pick at least one.",
        400,
      );
    return await allow(env, oauth, p, req, handle, scopes);
  } catch (e) {
    return authorizeError(e);
  }
}

async function deny(
  env: Env,
  oauth: OAuthHelpers,
  p: Principal,
  req: Request,
  handle: string,
): Promise<Response> {
  const denied = await oauth.denyConsent(req, handle);
  const client = await oauth.lookupClient(denied.request.clientId);
  await oauthAudit(env, {
    action: "oauth.denied",
    actor: { kind: "admin", label: p.email ?? p.label },
    outcome: "ok",
    detail: {
      clientId: denied.request.clientId,
      clientName: oauthLabel(client?.clientName ?? null),
    },
  });
  return new Response(null, { status: 302, headers: denied.headers });
}

async function allow(
  env: Env,
  oauth: OAuthHelpers,
  p: Principal,
  req: Request,
  handle: string,
  scopes: TokenScope[],
): Promise<Response> {
  const approved = await oauth.approveConsent(req, handle, { scope: scopes });
  const request = approved.request;
  const client = await oauth.lookupClient(request.clientId);
  const clientName = client?.clientName ?? null;
  const redirect = new URL(request.redirectUri);
  let minted: Awaited<ReturnType<typeof mintAgentToken>>;
  try {
    minted = await mintAgentToken(env, p, {
      kind: "oauth",
      scopes: request.scope.filter(isScope),
      clientId: request.clientId,
      clientName,
      redirectHost: redirect.hostname,
    });
  } catch (e) {
    if (e instanceof ApiError) return mintRefused(e);
    throw e;
  }
  // The older grant of this client: D1 revoked it in the mint batch; the
  // library drops it too (revokeExistingGrants, the default).
  await revokeLibraryGrants(env, minted.superseded ?? []);
  const props: GrantProps = {
    tokenId: minted.tokenId,
    sessionHash: p.sessionHash ?? "",
  };
  let redirectTo: string;
  try {
    ({ redirectTo } = await oauth.completeAuthorization({
      request,
      userId: minted.oauthUser ?? "",
      metadata: {},
      scope: request.scope,
      props,
    }));
  } catch (e) {
    // No grant was written: the row must not count as live.
    await revokeToken(env, p.email ?? "", minted.tokenId).catch(() => null);
    throw e;
  }
  await env.PLATFORM_DB.prepare(
    "UPDATE oauth_clients SET first_grant_at = ?2 WHERE client_id = ?1 AND first_grant_at IS NULL",
  )
    .bind(request.clientId, Date.now())
    .run();
  approved.headers.set("location", redirectTo);
  approved.headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers: approved.headers });
}

function mintRefused(e: ApiError): Response {
  if (e.code === "token_limit")
    return messagePage(
      "Too many agent tokens",
      "5 agent tokens are live. Revoke one at /tokens.",
      409,
    );
  if (e.code === "rate_limited")
    return messagePage(
      "Too many new tokens",
      "This hour's token budget is spent. Try again later.",
      429,
    );
  if (e.code === "unauthenticated") return signedOut();
  return messagePage("Cannot connect this agent", "Try again later.", 500);
}

