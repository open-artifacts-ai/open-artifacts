import {
  brokerNonce,
  brokerRedeemRequest,
  GoogleTokenError,
  ipKey,
  pkceChallenge,
  signBrokerTicket,
  verifyGoogleIdTokenAnyDomain,
} from "@oa/auth-core";
import { type BrowserRouteId, safeReturn } from "@oa/shared/provisioning";
import { type AuditEntry, audit } from "../audit.js";
import type { Env } from "../env.js";
import { errorResponse } from "../errors.js";
import { limit } from "../limits.js";
import { isRefusal } from "../principal.js";
import { refuse } from "../refuse.js";
import { bump, peek, SIGNIN_REFUSALS } from "./counters.js";
import { hmac16, randomToken, sameString } from "./crypto.js";
import { checkCsrf } from "./csrf.js";
import {
  clearFlowCookie,
  FLOW_COOKIE,
  FLOW_TTL_MS,
  flowCookie,
  readFlow,
  writeFlow,
} from "./flow.js";
import { BROKER_GOOGLE_CLIENT_ID } from "./google.js";
import { matchIdentity } from "./identities.js";
import { type LibraryGrant, revokeLibraryGrant } from "./oauth/grants.js";
import { REAUTH_MAX_AGE_MS } from "./reauth.js";
import {
  adminOrigin,
  clearSessionCookie,
  createSession,
  readCookie,
  revokeSession,
  sessionCookie,
  sessionPrincipal,
} from "./session.js";

// Sign-in through the auth broker (design v7 4.3): R22 /auth/start, R23
// /auth/callback/google, R24 /auth/logout, on the admin host only. The
// provisioning Worker is the broker registry entry `i000000admin` (no hd
// hint); the ID token is checked without the hd rule and the identity is
// pinned to an exact ADMIN_IDENTITIES (email, sub) pair instead.

export const ADMIN_PRINCIPAL_ID = "i000000admin";
/** The broker charges this install's gate bucket (broker-core rateKeyOf). */
const GATE_INSTALL_HEADER = "x-oa-gate-install";
/**
 * The ticket only has to survive the redirect to the broker, which refuses
 * an exp beyond its own now + 10 min; half that leaves room for clock skew.
 */
const TICKET_LIFETIME_MS = 5 * 60_000;

/** What the sign-in routes take from outside; tests pin the clock and keys. */
export type SigninDeps = {
  now: () => number;
  audit: (env: Env, e: AuditEntry) => Promise<void>;
  /** Google's JWKS unless set. */
  jwks?: Parameters<typeof verifyGoogleIdTokenAnyDomain>[0]["jwks"];
  revokeGrant: (env: Env, g: LibraryGrant) => Promise<void>;
};
const DEFAULTS: SigninDeps = {
  now: () => Date.now(),
  audit,
  revokeGrant: revokeLibraryGrant,
};

const brokerOrigin = (env: Env) => `https://auth.${env.APP_DOMAIN}`;

/** The Sign-in screen's states (9.2). */
type SignInError = "expired" | "denied" | "rate_limited";

function redirect(
  location: string,
  status: 302 | 303,
  cookies: string[] = [],
): Response {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status, headers: h });
}

const signInError = (env: Env, why: SignInError) =>
  redirect(`${adminOrigin(env)}/sign-in?error=${why}`, 303, [
    clearFlowCookie(),
  ]);

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

/**
 * The No access page (9.2), server-rendered: a refused identity never gets
 * a session, so the SPA has nothing to call. For `unknown_sub` it shows the
 * account id, which the admin sends for the first pin (4.3 step 5).
 */
function noAccess(sub: string | null): Response {
  const id = sub
    ? `<p>Send this to the platform owner to be added: Account id: ${escapeHtml(sub)}</p>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No access</title></head><body><main><h1>No access</h1><p>This Google account cannot sign in to Open Artifacts admin.</p>${id}<p><a href="/auth/start">Use another account</a></p></main></body></html>`;
  const h = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  h.append("set-cookie", clearFlowCookie());
  return new Response(html, { status: 403, headers: h });
}

/** RL_PV_SIGNIN_IP; null when allowed, else the response. */
async function signinLimited(req: Request, env: Env): Promise<Response | null> {
  const r = await limit(env, "signin_ip", ipKey(req));
  if (!r) return null;
  if (r.code !== "rate_limited") return errorResponse(r.code);
  // refuse() counts it (audit_refusals, 4.9); the browser gets the screen.
  await refuse(env, "signin_ip", r.code, req);
  return signInError(env, "rate_limited");
}

/** R22: the flow cookie, then 302 to the broker. */
async function start(req: Request, env: Env, d: SigninDeps): Promise<Response> {
  const limited = await signinLimited(req, env);
  if (limited) return limited;
  const q = new URL(req.url).searchParams;
  const now = d.now();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = await pkceChallenge(verifier);
  const reauth = q.get("reauth") === "1";
  const flow = await writeFlow(env, {
    state,
    nonce,
    verifier,
    return: safeReturn(q.get("return"), adminOrigin(env)),
    reauth,
    exp: now + FLOW_TTL_MS,
  });
  const ticket = await signBrokerTicket(env.ADMIN_BROKER_KEY, {
    install: ADMIN_PRINCIPAL_ID,
    state,
    challenge,
    exp: now + TICKET_LIFETIME_MS,
  });
  const u = new URL(`${brokerOrigin(env)}/google/authorize`);
  u.search = new URLSearchParams({
    install: ADMIN_PRINCIPAL_ID,
    state,
    nonce,
    code_challenge: challenge,
    ticket,
    // The broker sends Google max_age=0; the callback checks auth_time.
    ...(reauth ? { reauth: "1" } : {}),
  }).toString();
  return redirect(u.toString(), 302, [flowCookie(flow)]);
}

/** Google's raw ID token through the broker, or null. */
async function redeem(
  env: Env,
  a: { code: string; verifier: string; nonce: string; bstate: string },
  now: number,
): Promise<string | null> {
  try {
    const req = await brokerRedeemRequest(
      {
        url: brokerOrigin(env),
        installId: ADMIN_PRINCIPAL_ID,
        signingKey: env.ADMIN_BROKER_KEY,
      },
      a,
      now,
    );
    // Charges gate:i000000admin at the broker, not the shared ip:unknown.
    req.headers.set(GATE_INSTALL_HEADER, ADMIN_PRINCIPAL_ID);
    const res = await env.AUTH_BROKER.fetch(req);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const out = (await res.json().catch(() => null)) as {
      id_token?: unknown;
    } | null;
    return typeof out?.id_token === "string" ? out.id_token : null;
  } catch {
    return null;
  }
}

/** R23: flow, redeem, verify, identity, session, 303 to `return`. */
async function callback(
  req: Request,
  env: Env,
  d: SigninDeps,
): Promise<Response> {
  const limited = await signinLimited(req, env);
  if (limited) return limited;
  const now = d.now();
  const q = new URL(req.url).searchParams;
  const flow = await readFlow(env, readCookie(req, FLOW_COOKIE), now);
  if (!flow || !sameString(q.get("state") ?? "", flow.state)) {
    await refuse(env, "signin_flow", "unauthenticated", req);
    return signInError(env, "expired");
  }
  const code = q.get("code");
  const err = q.get("error");
  if (err || !code)
    return signInError(env, err === "access_denied" ? "denied" : "expired");

  const ip = ipKey(req);
  const db = env.PLATFORM_DB;
  const ipCounter = `signin_refused:ip:${await hmac16(env.ADMIN_SESSION_KEY, ip)}`;
  const { email: byEmail, ip: byIp } = SIGNIN_REFUSALS;
  if ((await peek(db, ipCounter, byIp.windowMs, now)) >= byIp.limit) {
    await refuse(env, "signin_ip", "rate_limited", req);
    return signInError(env, "rate_limited");
  }

  const idToken = await redeem(
    env,
    {
      code,
      verifier: flow.verifier,
      nonce: flow.nonce,
      bstate: q.get("bstate") ?? "",
    },
    now,
  );
  if (!idToken) return signInError(env, "expired");

  let id: Awaited<ReturnType<typeof verifyGoogleIdTokenAnyDomain>>;
  try {
    id = await verifyGoogleIdTokenAnyDomain(
      { clientId: BROKER_GOOGLE_CLIENT_ID[env.OA_ENV], jwks: d.jwks, now },
      idToken,
      await brokerNonce(ADMIN_PRINCIPAL_ID, flow.nonce),
    );
  } catch (e) {
    if (!(e instanceof GoogleTokenError)) throw e;
    await d.audit(env, {
      action: "signin.refused",
      actor: { kind: "signin" },
      outcome: "refused",
      route: "R23",
      code: "token_invalid",
      ip,
      detail: { stage: e.stage },
    });
    await bump(db, ipCounter, byIp.windowMs, now);
    return signInError(env, "denied");
  }

  // Exactly one (email, sub) pair; nothing reads hd or the email domain.
  const match = matchIdentity(env.ADMIN_IDENTITIES, id.email, id.sub);
  if (match !== "ok") {
    await d.audit(
      env,
      match === "unknown_sub"
        ? {
            action: "signin.refused",
            actor: { kind: "signin", email: id.email, sub: id.sub },
            outcome: "refused",
            route: "R23",
            code: "unknown_sub",
            ip,
            email: id.email,
            detail: { sub: id.sub },
          }
        : {
            // The email HMAC only: an unlisted address is never stored.
            action: "signin.refused",
            actor: { kind: "signin" },
            outcome: "refused",
            route: "R23",
            code: "not_listed",
            ip,
            email: id.email,
          },
    );
    const emailCounter = `signin_refused:email:${await hmac16(env.ADMIN_SESSION_KEY, id.email)}`;
    const [ne, ni] = await Promise.all([
      bump(db, emailCounter, byEmail.windowMs, now),
      bump(db, ipCounter, byIp.windowMs, now),
    ]);
    if (ne > byEmail.limit || ni > byIp.limit)
      return signInError(env, "rate_limited");
    return noAccess(match === "unknown_sub" ? id.sub : null);
  }

  // A fresh sign-in (R11 purge): Google must have authenticated just now.
  if (
    flow.reauth &&
    !(id.authTime !== null && now - id.authTime <= REAUTH_MAX_AGE_MS)
  ) {
    await d.audit(env, {
      action: "signin.refused",
      actor: { kind: "signin", email: id.email, sub: id.sub },
      outcome: "refused",
      route: "R23",
      code: "reauth_required",
      ip,
    });
    return signInError(env, "expired");
  }

  const s = await createSession(
    env,
    { email: id.email, sub: id.sub, authAt: id.authTime ?? now },
    now,
  );
  await d.audit(env, {
    action: "signin.ok",
    actor: { kind: "signin", email: id.email, sub: id.sub },
    outcome: "ok",
    route: "R23",
    ip,
  });
  const origin = adminOrigin(env);
  return redirect(`${origin}${safeReturn(flow.return, origin)}`, 303, [
    sessionCookie(s.sid),
    clearFlowCookie(),
  ]);
}

/** R24: revokes the session, its oat_ tokens and its OAuth grants. */
async function logout(
  req: Request,
  env: Env,
  d: SigninDeps,
): Promise<Response> {
  const now = d.now();
  const p = await sessionPrincipal(req, env, now);
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  const c = checkCsrf(req, env, p);
  if (c || !p.session) return refuse(env, "csrf", "csrf_failed", req);
  const ip = ipKey(req);
  for (const t of await revokeSession(env, p.session.hash, now)) {
    if (t.kind === "oauth" && t.grant_id && t.oauth_user)
      await d.revokeGrant(env, {
        grantId: t.grant_id,
        oauthUser: t.oauth_user,
      });
    await d.audit(env, {
      action: "token.revoke",
      actor: p,
      outcome: "ok",
      route: "R24",
      ip,
      detail: {
        tokenId: t.id,
        kind: t.kind,
        label: t.label,
        scopes: JSON.parse(t.scopes) as unknown,
        via: "logout",
      },
    });
  }
  await d.audit(env, {
    action: "session.logout",
    actor: p,
    outcome: "ok",
    route: "R24",
    ip,
  });
  const h = new Headers({ "cache-control": "no-store" });
  h.append("set-cookie", clearSessionCookie());
  return new Response(null, { status: 204, headers: h });
}

/** The browser routes (R22-R24); the adapter has run host policy and Origin. */
export function browserRoute(
  req: Request,
  env: Env,
  route: BrowserRouteId,
  deps: Partial<SigninDeps> = {},
): Promise<Response> {
  const d = { ...DEFAULTS, ...deps };
  if (route === "R22") return start(req, env, d);
  if (route === "R23") return callback(req, env, d);
  return logout(req, env, d);
}
