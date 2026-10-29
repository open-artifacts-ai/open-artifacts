import { inDomains } from "@oa/auth-core";
import {
  ARTIFACT_SANDBOX_ATTR,
  AUTH,
  type AuthMethod,
  type BreakGlassRequiredDetails,
  type Member,
  R,
  SIGN_IN_PAGE,
} from "@oa/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { callerOf, capOfCaller, planOfMember, withCap } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { sessionCredId, setCred } from "../auth/cred.js";
import { verifyPat } from "../auth/pat.js";
import { isGuestRole, orgCan } from "../auth/policy.js";
import {
  readSession,
  type Session,
  sessionCookieName,
} from "../auth/session.js";
import { planError } from "../billing/plan.js";
import { BANNER_AFTER_MS } from "../directory/health.js";
import { type Cap, refundAll, sendEmail, takeAll } from "../email/send.js";
import { directoryAlertEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import { audit, userActor } from "../services/audit.js";
import { getSettings } from "../services/members.js";
import {
  getMismatchOwner,
  getUserWithEpoch,
  type UserWithEpoch,
} from "../services/users.js";
import { frameOpts, isEmbedRequest } from "./embed.js";
import { ApiError, appOrigin, toErrorResponse } from "./errors.js";

/** Hono Variables set by `session()`; use as `Hono<{ Bindings: Env; Variables: AppVariables }>`. */
export type AppVariables = {
  user: Member | null;
  /** PAT label when authenticated by Bearer token (agent attribution), else null. */
  tokenLabel: string | null;
  tokenId: string | null;
  /** Set once the session has been read (the policy gate may read it first). */
  sessionResolved?: boolean;
  /** How this request authenticated (Me.auth.method); null when anonymous. */
  authMethod: AuthMethod | null;
  /** Session expiry (ms) for a cookie session; null otherwise. */
  sessionExp: number | null;
  /** The user's session_epoch, read with the user row (content-url binds it, P3 T11); null when anonymous. */
  sessionEpoch: number | null;
  /**
   * When this request's authorization began (ms): stamped by the policy gate
   * before the session read, so a revocation written after any access read
   * has revokedAt >= authzAt (UserPresence.touch on socket accept).
   */
  authzAt?: number;
};
export type AppEnv = { Bindings: Env; Variables: AppVariables };

export const CONTENT_CSP = `sandbox ${ARTIFACT_SANDBOX_ATTR}`;

/**
 * Sign-in pages a client may open in a popup (web MCP connectors run OAuth in
 * one and read the result through window.opener): no COOP there, or the
 * popup loses its opener. Exact pathnames only, never prefixes.
 */
export const COOP_EXEMPT: ReadonlySet<string> = new Set([
  "/oauth/authorize", // GET consent page, POST consent decision
  "/auth/login",
  "/auth/callback",
  "/auth/dev-login",
  SIGN_IN_PAGE,
  AUTH.loginGoogle,
  AUTH.callbackGoogle,
]);

/**
 * OAuth/OIDC callbacks: their URL carries a code and state, so the page they
 * land on (or an error page) must not send it on as a Referer.
 * Exact pathnames only.
 */
export const NO_REFERRER: ReadonlySet<string> = new Set([
  AUTH.callback,
  AUTH.callbackGoogle,
  R.directoryCallback,
]);

/**
 * `frameAncestors` (a pre-validated source list from frameOpts) replaces
 * X-Frame-Options with `Content-Security-Policy: frame-ancestors …` (merged
 * into `csp`, when given, as one header); it wins over `frameDeny`.
 */
type SecurityOpts = {
  frameDeny?: boolean;
  frameAncestors?: string;
  csp?: string;
  /** Cross-Origin-Opener-Policy: same-origin (app host only; see appHostOpts). */
  coop?: boolean;
  /** Referrer-Policy: no-referrer instead of strict-origin-when-cross-origin. */
  noReferrer?: boolean;
};

/**
 * App-host security options for a request: framing per frameOpts, plus
 * `Cross-Origin-Opener-Policy: same-origin` (a popup opened from an artifact
 * can't reach back into our pages) except on COOP_EXEMPT. Never on the
 * content host.
 */
export const appHostOpts = (
  env: Env,
  method: string,
  pathname: string,
): SecurityOpts => ({
  ...frameOpts(env, method, pathname),
  coop: !COOP_EXEMPT.has(pathname),
  noReferrer: NO_REFERRER.has(pathname),
});

/** `res` with the standard security headers; a copy when its headers are immutable. */
export function withSecurityHeaders(
  res: Response,
  opts: SecurityOpts = {},
): Response {
  if (res.status === 101) return res;
  // Most responses (c.json, new Response) have mutable headers: set them in
  // place. Immutable ones (fetch(), Response.redirect()) throw on the first
  // set, before any change, and are re-wrapped.
  try {
    setSecurityHeaders(res.headers, opts);
    return res;
  } catch {
    const out = new Response(res.body, res);
    setSecurityHeaders(out.headers, opts);
    return out;
  }
}

function setSecurityHeaders(h: Headers, opts: SecurityOpts): void {
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("X-Content-Type-Options", "nosniff");
  h.set(
    "Referrer-Policy",
    opts.noReferrer ? "no-referrer" : "strict-origin-when-cross-origin",
  );
  if (opts.coop) h.set("Cross-Origin-Opener-Policy", "same-origin");
  else h.delete("Cross-Origin-Opener-Policy");
  if (opts.frameAncestors) {
    h.delete("X-Frame-Options");
    const fa = `frame-ancestors ${opts.frameAncestors}`;
    h.set("Content-Security-Policy", opts.csp ? `${opts.csp}; ${fa}` : fa);
  } else {
    if (opts.frameDeny) h.set("X-Frame-Options", "DENY");
    if (opts.csp) h.set("Content-Security-Policy", opts.csp);
  }
}

/** App-host security headers; framing per frameOpts (DENY except /a/:id/full with EMBED_ORIGINS). */
export const securityHeaders =
  (): MiddlewareHandler<AppEnv> => async (c, next) => {
    await next();
    // Responses from fetch()/Response.redirect() have immutable headers: re-wrap.
    c.res = withSecurityHeaders(
      c.res,
      appHostOpts(c.env, c.req.method, new URL(c.req.url).pathname),
    );
  };

const BEARER = /^\s*Bearer(?:\s+(.*?))?\s*$/i;

/**
 * A signed session is still good for this user and install: its epoch is the
 * user's current one (a bump ends every session), its tenant, if any, is
 * still a verified domain, and a domain-code session ends once Google is on.
 */
export function sessionStillValid(
  env: Env,
  s: Session,
  sessionEpoch: number,
): boolean {
  if ((s.e ?? 0) !== sessionEpoch) return false;
  if (s.t === undefined) return true;
  const cfg = authConfig(env);
  if (!inDomains(cfg.domains, s.t)) return false;
  return !(s.p === "code" && cfg.providers.has("google"));
}

/**
 * Sets c.var.user (Member | null), tokenLabel, tokenId, authMethod, sessionExp.
 * An `Authorization: Bearer …` header is authoritative: a valid PAT sets the
 * user, anything else yields null with no cookie fallback. Any other (or no)
 * Authorization header falls through to the session cookie (sessionCookieName). The user row is
 * loaded on every request, so deleted users resolve to null, and a cookie
 * session must pass sessionStillValid.
 * `X-OA-Embed: 1` or `?embed=1` (isEmbedRequest) forces anonymous.
 */
/** A guest while the guest cap is on, however they authenticated (session or PAT). */
export const session = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await resolveSession(c);
  await next();
};

/** Reads the session once per request (idempotent); see `session()`. */
export async function resolveSession(c: Context<AppEnv>): Promise<void> {
  if (c.get("sessionResolved")) return;
  c.set("sessionResolved", true);
  c.set("user", null);
  c.set("tokenLabel", null);
  c.set("tokenId", null);
  c.set("authMethod", null);
  c.set("sessionExp", null);
  c.set("sessionEpoch", null);
  // Embed mode: anonymous regardless of cookie or Bearer (a downgrade only).
  if (isEmbedRequest(c.req.raw)) return;
  const bearer = BEARER.exec(c.req.header("authorization") ?? "");
  if (bearer) {
    let ctx: Pick<ExecutionContext, "waitUntil"> | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }
    const pat = await verifyPat(c.env, bearer[1] ?? "", ctx);
    const row = pat ? await getUserWithEpoch(c.env, pat.userId) : null;
    // Review item 34: a restricted member's PAT is refused on REST, as at
    // /mcp. Only restricted: a guest's PAT keeps today's capped, read-only
    // REST access (#609 is a post-M1 product call).
    if (pat && row && capOfCaller(callerOf(row.user)) !== "restricted") {
      c.set("user", row.user);
      c.set("tokenLabel", pat.label);
      c.set("tokenId", pat.tokenId);
      c.set("authMethod", "pat");
      setCred({ kind: "pat", id: pat.tokenId });
      c.set("sessionEpoch", row.sessionEpoch);
    }
  } else {
    const s = await readSession(c.env, getCookie(c, sessionCookieName(c.env)));
    const row = s
      ? await getUserWithEpoch(c.env, s.uid, { cookie: true })
      : null;
    if (s && !row && isBreakGlassRoute(c.req.method, c.req.path))
      await breakGlass(c, s);
    else if (s && !row && c.req.method === "GET" && c.req.path === R.me)
      await meBreakGlass(c, s);
    else if (
      s &&
      row &&
      sessionStillValid(c.env, s, row.sessionEpoch) &&
      !sessionCapped(row.capSince, s.iat, Date.now())
    ) {
      // The cap travels on the member itself (authz CAP, set once by getUser
      // from authConfig.guestsReadOnly and P3's restriction); a code session
      // outside the verified domains is capped on top, whatever the env says.
      // An existing cap (P3's "restricted") is kept; no cap becomes "guest".
      if (s.p === "code" && s.t === undefined)
        c.set(
          "user",
          withCap(row.user, capOfCaller(callerOf(row.user)) ?? "guest"),
        );
      else c.set("user", row.user);
      c.set("authMethod", s.p);
      setCred({ kind: "session", id: sessionCredId(s) });
      c.set("sessionExp", s.exp);
      c.set("sessionEpoch", row.sessionEpoch);
    }
  }
}

/** A browser session older than this is refused while sync is unhealthy over 1 h (T18). */
export const SESSION_CAP_MS = 24 * 3600_000;
/** Break-glass needs a Google sign-in at most this old (T18). */
export const BREAK_GLASS_MS = 10 * 60_000;
/** Break-glass uses are audited at most once per this, per session and route. */
const BREAK_GLASS_AUDIT_MS = 60_000;

/**
 * The 24 h browser session cap (P3 T18): directory sync unhealthy for over
 * 1 h (capSince, set for synced users only) and a cookie session issued over
 * 24 h ago. PATs and MCP OAuth grants are exempt (decided).
 */
export const sessionCapped = (
  capSince: number | null,
  iat: number,
  now: number,
): boolean =>
  capSince !== null &&
  capSince < now - BANNER_AFTER_MS &&
  iat < now - SESSION_CAP_MS;

/**
 * The routes an org owner locked out by customer_mismatch may reach with a
 * fresh Google sign-in (T18): directory status, connect (with its confirm
 * and cancel steps) and sync. Exact method and path.
 */
const BREAK_GLASS_ROUTES: ReadonlySet<string> = new Set([
  `GET ${R.directory}`,
  `GET ${R.directoryConnect}`,
  `GET ${R.directoryCallback}`,
  `POST ${R.directoryConfirm}`,
  `POST ${R.directoryCancel}`,
  `POST ${R.directorySync}`,
]);

export const isBreakGlassRoute = (method: string, path: string) =>
  BREAK_GLASS_ROUTES.has(`${method} ${path}`);

/**
 * The session meets break-glass: a verified-hd Google sign-in under 10 min
 * old whose Google authentication was forced and is under 10 min old too.
 */
const breakGlassFresh = (s: Session, now: number): boolean =>
  s.p === "google" &&
  s.t !== undefined &&
  s.iat >= now - BREAK_GLASS_MS &&
  s.a !== undefined &&
  s.a >= now - BREAK_GLASS_MS;

/**
 * directory.break_glass for this request's route, at most once a minute per
 * session (iat) and route; the first use always. One statement (D1 runs them
 * one at a time), so parallel uses in the same minute write one row.
 */
const auditBreakGlass = (
  c: Context<AppEnv>,
  uid: string,
  s: Session,
  now: number,
) => {
  const route = `${c.req.method} ${c.req.path}`;
  return audit(
    c.env,
    "directory.break_glass",
    { type: "directory", id: "google" },
    userActor(uid),
    {
      detail: { route, iat: s.iat },
      when: {
        sql: `not exists (select 1 from audit_events where at >= ? and action = 'directory.break_glass'
          and actor_id = ? and json_extract(detail, '$.iat') = ? and json_extract(detail, '$.route') = ?)`,
        args: [now - BREAK_GLASS_AUDIT_MS, uid, s.iat, route],
      },
    },
  ).run();
};

/**
 * GET R.me for a cookie that getUserWithEpoch refused: when it is the org
 * owner refused for customer_mismatch, 401 break_glass_required { fresh }
 * (fresh: the session meets break-glass), audited as a break-glass use
 * (throttled as above; no email). Anyone else falls through to a plain 401.
 */
async function meBreakGlass(c: Context<AppEnv>, s: Session): Promise<void> {
  const row = await getMismatchOwner(c.env, s.uid);
  if (!row || !sessionStillValid(c.env, s, row.sessionEpoch)) return;
  const now = Date.now();
  // The 401 still names the session that asked: its use is audited as such.
  setCred({ kind: "session", id: sessionCredId(s) });
  await auditBreakGlass(c, row.user.id, s, now);
  throw new ApiError(
    "break_glass_required",
    "Directory sync is blocked by a Google Workspace mismatch",
    { fresh: breakGlassFresh(s, now) } satisfies BreakGlassRequiredDetails,
  );
}

/**
 * Break-glass (T18), on BREAK_GLASS_ROUTES only, for a cookie that
 * getUserWithEpoch refused: an org owner refused for customer_mismatch is
 * resolved when the session is a verified-hd Google sign-in under 10 min old
 * whose Google authentication was forced and is under 10 min old too
 * (?reauth=1: max_age=0, auth_time checked at the callback); else 401
 * reauth_required. Uses are audited (directory.break_glass, with the
 * session's iat) at most once a minute per session and route, the first use
 * always; that owner gets one email per break-glass session, on its first
 * use. Anyone else stays anonymous, as on every other route.
 */
async function breakGlass(c: Context<AppEnv>, s: Session): Promise<void> {
  const row = await getMismatchOwner(c.env, s.uid);
  if (!row || !sessionStillValid(c.env, s, row.sessionEpoch)) return;
  const now = Date.now();
  if (!breakGlassFresh(s, now))
    throw new ApiError(
      "reauth_required",
      "Sign in with Google again to manage the directory",
    );
  setCookieUser(c, s, row);
  await auditBreakGlass(c, row.user.id, s, now);
  const mail = (async () => {
    // One email per session (keyed on its iat): an atomic counter upsert, so
    // parallel first requests can't both send. Swept by the daily cron. A
    // failed send gives the slot back, so the next use retries.
    const caps: Cap[] = [
      [
        `email:bg:${row.user.id}:${s.iat}`,
        1,
        new Date(s.iat).toISOString().slice(0, 10),
      ],
    ];
    if ((await takeAll(c.env, caps)) !== -1) return;
    const instance = (await getSettings(c.env)).name;
    const sent = await sendEmail(
      c.env,
      null,
      row.user.email,
      () =>
        directoryAlertEmail({
          instance,
          recipient: row.user.email,
          appHost: c.env.APP_HOST,
          why: "break_glass",
        }),
      { kind: "directory", instance },
    );
    if (!sent) {
      logError("break_glass_email_unsent");
      await refundAll(c.env, caps);
    }
  })().catch((e) => logError("break_glass_email", e));
  const ctx = execCtx(c);
  if (ctx) ctx.waitUntil(mail);
  else await mail;
}

function setCookieUser(c: Context<AppEnv>, s: Session, row: UserWithEpoch) {
  c.set("user", row.user);
  c.set("authMethod", s.p);
  setCred({ kind: "session", id: sessionCredId(s) });
  c.set("sessionExp", s.exp);
  c.set("sessionEpoch", row.sessionEpoch);
}

export const CSRF_HEADER = "X-OA-Request";

/**
 * The non-GET routes a capped caller keeps, matched exactly (method and whole
 * path, never a prefix): their own display name, a data query (a read sent as
 * POST), and revoking their own tokens and agent grants (both routes check
 * ownership).
 */
const CAPPED_ALLOWED: readonly (readonly [string, RegExp])[] = [
  ["PATCH", /^\/api\/v1\/me$/],
  ["POST", /^\/api\/v1\/artifacts\/[^/]+\/data\/[^/]+\/query$/],
  ["DELETE", /^\/api\/v1\/tokens\/[^/]+$/],
  ["DELETE", /^\/api\/v1\/oauth-clients\/[^/]+$/],
];

/** The billing routes a plan-capped owner or admin may still POST. */
const BILLING_POSTS: ReadonlySet<string> = new Set([
  R.billingCheckout,
  R.billingPortal,
  R.billingUsage,
]);

/**
 * A capped caller (CapReason on the member: a guest while the guest cap is on,
 * any code session outside the verified domains, a P3 restricted member) is
 * read-only on the whole API, as defence in depth behind P3's can():
 * every mutation is refused here, before any route, so no write path can be
 * missed (artifacts, versions, shares, data, storage, uploads, tokens). Only
 * CAPPED_ALLOWED passes. Creating an artifact is 403 space_forbidden (#359);
 * everything else 404 (never 403).
 */
export const readOnlyCap = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const m = c.req.method;
  const cap =
    m !== "GET" && m !== "HEAD" ? capOfCaller(callerOf(c.var.user)) : null;
  if (cap) {
    const path = c.req.path;
    if (CAPPED_ALLOWED.some(([am, re]) => am === m && re.test(path)))
      return next();
    // Hosted billing's plan cap: the owner and admins can still pay
    // (Checkout, Portal, the usage report; orgCan billing.manage). Members
    // cannot.
    if (
      cap === "plan" &&
      m === "POST" &&
      BILLING_POSTS.has(path) &&
      c.var.user &&
      orgCan(c.var.user, "billing.manage", { cap })
    )
      return next();
    // Otherwise a clear 403 (the caller can see what they can't change),
    // never a 404.
    const lock = cap === "plan" ? planOfMember(c.var.user)?.lock : null;
    if (lock) return toErrorResponse(planError(lock));
    if (m === "POST" && path === R.artifacts)
      return toErrorResponse(
        new ApiError("space_forbidden", "Guests can't publish here"),
      );
    return toErrorResponse(new ApiError("not_found", "Not found"));
  }
  await next();
};

/**
 * Mutating requests (anything but GET/HEAD) that authenticate by session cookie
 * (no `Authorization: Bearer`, and a sessionCookieName(env) cookie present) must send
 * `X-OA-Request: 1`, else 403 csrf. Bearer/PAT requests are exempt. Mount on
 * `/api/v1/*` and `/auth/logout`.
 */
export const csrf = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD") {
    const bearer = BEARER.test(c.req.header("authorization") ?? "");
    const cookie = getCookie(c, sessionCookieName(c.env)) !== undefined;
    if (!bearer && cookie && c.req.header(CSRF_HEADER) !== "1")
      return toErrorResponse(
        new ApiError("csrf", `Missing ${CSRF_HEADER}: 1 header`),
      );
  }
  await next();
};

/**
 * Rejects cross-site requests (403 csrf): `Sec-Fetch-Site: cross-site`, or an
 * `Origin` header that differs from the app origin. Used for POST /auth/logout,
 * which must not be triggerable by another site.
 */
export const sameOrigin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  if (
    site === "cross-site" ||
    (origin !== undefined && origin !== appOrigin(c.env))
  )
    return toErrorResponse(new ApiError("csrf", "Cross-site request"));
  await next();
};

/** c.executionCtx, or undefined where there is none (direct app.fetch in tests). */
export const execCtx = (c: Context<AppEnv>) => {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
};
