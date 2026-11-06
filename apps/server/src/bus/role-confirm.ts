import { BUS_ROUTES } from "@oa/bus-protocol";
import { AUTH, type Member, SIGN_IN_PAGE } from "@oa/shared";
import type { Context } from "hono";
import { canConnect } from "../auth/agents.js";
import { interactiveSession } from "../auth/authz.js";
import { isEmbedRequest } from "../http/embed.js";
import { appOrigin } from "../http/errors.js";
import { type AppEnv, BREAK_GLASS_MS } from "../http/middleware.js";
import {
  checkFormCsrf,
  formCsrf,
  messagePage,
  newNonce,
  pageResponse,
  sessionUser,
} from "../http/pages.js";
import { logError } from "../log.js";
import type { AppType } from "../routes/index.js";
import {
  busOn,
  decideBusRoleProposal,
  ROLE_CONFIRM_PATH,
  ROLE_TOKEN,
  viewBusRoleProposal,
} from "../services/bus.js";
import { sha256Hex } from "../util/crypto.js";
import {
  renderConfirmPage,
  renderDoneCard,
  renderRoleConfirm,
  renderRoleDone,
  renderRoleReauth,
  renderSignInCard,
  renderSignInHop,
} from "./approve-page.js";
import type { ProposalRefusalReason } from "./role-proposals.js";
import { busConfigRefusal } from "./cap.js";
import { busOff } from "./routes.js";

// #1372: the confirm link of an AI agent's role proposal
// (`<origin>/bus/roles/confirm#<secret>`, from MCP bus_role_propose). The
// secret is in the URL fragment (#1426), so no request, access log or
// referrer carries it: the page loads without it, and its script posts the
// secret in a body. The
// user's guardrail ("Let's do B", then "1, propose via MCP, I confirm by
// link"): a proposal applies only here, by the member, in a browser.
//
// Both routes take only an interactive cookie session (Google, an email code
// or Access; never a dev or test session) with no Authorization header: a
// PAT, an OAuth grant or a machine token is refused before anything is
// read. The secret finds the proposal in the signed-in member's own hub
// only, so another member's session finds nothing. GET serves the page;
// POST /view (with the page's token) shows the proposal; POST, with the
// card's form token (bound to the member and this link, valid
// FORM_CSRF_TTL_S), confirms or rejects it once. The hub re-checks it at
// decision time and refuses when the role moved since it was proposed.

/** The form token's scope (http/pages.ts formCsrf); its handle is the secret's sha256. */
export const ROLE_CONFIRM_SCOPE = "bus-role-confirm";
/** The page token's scope: it authorizes the details request, before the secret is known to the server. */
export const ROLE_CONFIRM_VIEW_SCOPE = "bus-role-confirm-view";
const MAX_FORM_BYTES = 8 * 1024;

/**
 * What the confirm page's script reads (#1426): the card to show (escaped
 * HTML), and whether the link is still open (`keep`: the script holds on to
 * the secret for a sign-in round trip), under the status that says why.
 */
export const cardResponse = (html: string, status: number, keep = false) =>
  new Response(JSON.stringify({ html, keep }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
    },
  });

/**
 * The JSON body of a confirm POST: its secret, its token and, to decide, the
 * decision. Fails closed: no content-length (a chunked body), anything but
 * plain digits, or a body that isn't a flat object of strings, is null.
 */
export async function readConfirmBody(
  c: Context<AppEnv>,
): Promise<Record<string, string> | null> {
  const cl = c.req.header("content-length") ?? "";
  if (!/^\d{1,9}$/.test(cl) || Number(cl) > MAX_FORM_BYTES) return null;
  if (!(c.req.header("content-type") ?? "").startsWith("application/json"))
    return null;
  try {
    const j: unknown = JSON.parse(await c.req.text());
    if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) {
      if (typeof v !== "string") return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** The page whose old, path-style link (before #1426) is gone: the secret is never read. */
export function oldFormatPage(c: Context<AppEnv>, what: string): Response {
  return pageResponse(
    renderRoleDone({
      instanceHost: c.env.APP_HOST,
      title: "This link format expired",
      message: `This link is in an old format and no longer works. Nothing changed. ${what}`,
      busUrl: `${appOrigin(c.env)}${BUS_ROUTES.page}`,
    }),
    410,
  );
}

const page = (
  c: Context<AppEnv>,
  title: string,
  message: string,
  status: number,
) =>
  cardResponse(
    renderDoneCard({
      title,
      message,
      busUrl: `${appOrigin(c.env)}${BUS_ROUTES.page}`,
    }),
    status,
  );

const GONE = {
  title: "This link doesn't work",
  message:
    "No role change waits behind this link for you. Check that you're signed in as the right person, or ask the agent to propose it again.",
};

/** Each refusal's page: nothing was changed. */
const REFUSED: Record<
  ProposalRefusalReason | "rejected",
  { title: string; message: string; status: number }
> = {
  unknown: { ...GONE, status: 404 },
  used: {
    title: "Already decided",
    message:
      "This role change was already confirmed or turned down. A link works once.",
    status: 410,
  },
  expired: {
    title: "This link expired",
    message:
      "Nothing changed. Ask the agent to propose the change again for a new link.",
    status: 410,
  },
  changed: {
    title: "The role changed",
    message:
      "This role changed after the agent proposed it, so nothing was applied. Ask the agent to propose it again.",
    status: 409,
  },
  invalid: {
    title: "Can't apply this change",
    message: "The role name or namespace isn't valid. Nothing changed.",
    status: 409,
  },
  name_taken: {
    title: "Can't apply this change",
    message:
      "An agent or a reserved name now uses that name there. Nothing changed.",
    status: 409,
  },
  agent_not_open: {
    title: "Can't apply this change",
    message:
      "The new holder isn't open in that namespace any more. Nothing changed.",
    status: 409,
  },
  role_limit: {
    title: "Can't apply this change",
    message: "You have too many role addresses. Nothing changed.",
    status: 409,
  },
  rejected: {
    title: "Change turned down",
    message: "Nothing changed. The link no longer works.",
    status: 200,
  },
};

const refused = (c: Context<AppEnv>, why: keyof typeof REFUSED) => {
  const r = REFUSED[why];
  return page(c, r.title, r.message, r.status);
};

const failed = () =>
  messagePage(
    "Something went wrong",
    "Nothing changed. Try again in a minute.",
    500,
  );

export type Who = { user: Member } | { response: Response };

/**
 * How recent the forced sign-in must be to load or post the form: the
 * break-glass window (10 minutes).
 */
export const ROLE_CONFIRM_FRESH_MS = BREAK_GLASS_MS;

/**
 * Whether this cookie session is a forced sign-in recent enough (see
 * ROLE_CONFIRM_FRESH_MS). One marker for every provider, the session's
 * re-auth time (`a`, set only by a forced flow): Google's auth_time after
 * max_age=0, an Access sign-in asked for with prompt=login (?reauth=1), or
 * an email code sign-in (every code is new and typed by the person). A
 * plain sign-in, such as silent Access or Google SSO, has none, so a fresh
 * iat alone never passes.
 */
function freshSignIn(c: Context<AppEnv>, now: number): boolean {
  const recent = (t: number | null) =>
    t !== null && t >= now - ROLE_CONFIRM_FRESH_MS && t <= now + 60_000;
  return (
    recent(c.var.sessionIat ?? null) && recent(c.var.sessionAuthAt ?? null)
  );
}

/**
 * The forced sign-in that brings the member back to this link: Google with
 * max_age=0 (?reauth=1), Access with prompt=login and max_age=0, an email
 * code through the sign-in page (every code sign-in is a new code).
 */
function reauthUrl(c: Context<AppEnv>, path: string): string {
  const next = encodeURIComponent(path);
  if (c.var.authMethod === "google")
    return `${AUTH.loginGoogle}?reauth=1&next=${next}`;
  if (c.var.authMethod === "access")
    return `${AUTH.login}?via=access&reauth=1&next=${next}`;
  return `${SIGN_IN_PAGE}?next=${next}`;
}

/**
 * The caller, or the page that refuses them: bus off, embed, any
 * Authorization header (a PAT, an OAuth grant, a machine token), signed out
 * (GET: to sign-in and back; POST: 401), not allowed to connect agents, or
 * not an interactive sign-in. `path` is the confirm page's own path, with no secret (where
 * sign-in returns to) and `what` names the change in the refusal copy; link
 * confirmations (bus/link-confirm.ts) use the same checks.
 */
export function confirmCaller(
  c: Context<AppEnv>,
  path: string,
  post: boolean,
  what = "a role change",
): Who {
  if (!busOn(c.env)) return { response: busOff() };
  if (isEmbedRequest(c.req.raw)) return { response: busOff() };
  if (c.req.header("authorization") !== undefined || c.var.tokenId)
    return {
      response: messagePage(
        "Use your browser",
        "Only you can confirm this, signed in in your browser. No token can.",
        401,
      ),
    };
  const user = sessionUser(c);
  if (!user) {
    // A card, kept: the script holds on to the secret so signing in again
    // brings the person back to this link.
    if (post)
      return {
        response: cardResponse(
          renderSignInCard({
            title: "Signed out",
            message: "Your session ended. Sign in, then confirm again.",
            href: `${AUTH.login}?next=${encodeURIComponent(path)}`,
            label: "Sign in",
          }),
          401,
          true,
        ),
      };
    // A 200 hop, not a 302: the browser would carry the fragment (the
    // secret) to the sign-in, and on to Google. The page keeps it in this
    // tab and goes to the sign-in without it.
    const nonce = newNonce();
    return {
      response: pageResponse(
        renderSignInHop({
          instanceHost: c.env.APP_HOST,
          base: path,
          go: `${AUTH.login}?next=${encodeURIComponent(path)}`,
          nonce,
        }),
        200,
        undefined,
        nonce,
      ),
    };
  }
  if (!canConnect(user)) return { response: busOff() };
  if (!interactiveSession(c))
    return {
      response: messagePage(
        "Sign in again",
        `Confirming ${what} takes a browser sign-in. Sign in again, then open the link.`,
        403,
      ),
    };
  // Fresh: the form is minted (GET) and decided (POST) only within 10
  // minutes of a real sign-in, so a cookie lifted from the browser can't
  // confirm long after.
  if (!freshSignIn(c, Date.now())) {
    if (post)
      return {
        response: cardResponse(
          renderSignInCard({
            title: "Sign in again",
            message: `To confirm ${what}, sign in again first. Your last sign-in is more than 10 minutes old.`,
            href: reauthUrl(c, path),
            label: "Sign in again",
          }),
          403,
          true,
        ),
      };
    const nonce = newNonce();
    return {
      response: pageResponse(
        renderRoleReauth({
          instanceHost: c.env.APP_HOST,
          userEmail: user.email,
          reauthUrl: reauthUrl(c, path),
          what,
          stash: { base: path, nonce },
        }),
        403,
        undefined,
        nonce,
      ),
    };
  }
  return { user };
}

/** The routes, literal for the red-line scan (tests/redline); ROLE_CONFIRM_PATH, its details and its decision. */
export function mountRoleConfirm(app: AppType): void {
  app.get("/bus/roles/confirm", async (c) => {
    const who = confirmCaller(c, ROLE_CONFIRM_PATH, false);
    if ("response" in who) return who.response;
    const nonce = newNonce();
    return pageResponse(
      renderConfirmPage({
        instanceHost: c.env.APP_HOST,
        title: "Confirm a role change",
        base: ROLE_CONFIRM_PATH,
        csrf: await formCsrf(
          c.env,
          ROLE_CONFIRM_VIEW_SCOPE,
          who.user.id,
          "page",
        ),
        nonce,
      }),
      200,
      undefined,
      nonce,
    );
  });

  // The path-style link of before #1426: a notice, the secret never read.
  app.get("/bus/roles/confirm/:token", (c) =>
    oldFormatPage(
      c,
      "Ask the agent to propose the change again for a new link.",
    ),
  );

  app.post("/bus/roles/confirm/view", async (c) => {
    if (busOn(c.env) && c.req.header("sec-fetch-site") === "cross-site")
      return messagePage("Not allowed", "Cross-site request.", 403);
    const who = confirmCaller(c, ROLE_CONFIRM_PATH, true);
    if ("response" in who) return who.response;
    const body = await readConfirmBody(c);
    if (body === null) return messagePage("Not saved", "Invalid request.", 400);
    const secret = body.secret ?? "";
    if (
      !(await checkFormCsrf(
        c.env,
        ROLE_CONFIRM_VIEW_SCOPE,
        who.user.id,
        "page",
        body.csrf ?? "",
      ))
    )
      return messagePage(
        "This page expired",
        "Nothing changed. Open the link again, then confirm.",
        403,
      );
    if (!ROLE_TOKEN.test(secret)) return refused(c, "unknown");
    try {
      const v = await viewBusRoleProposal(c.env, who.user.id, secret);
      if (v === null) return refused(c, "unknown");
      if (!v.ok) return refused(c, v.reason);
      const p = v.proposal;
      return cardResponse(
        renderRoleConfirm({
          instanceHost: c.env.APP_HOST,
          action: p.action,
          namespace: p.namespace,
          name: p.name,
          priorHolderName: p.priorHolderName,
          priorHolderGone:
            p.priorAgentId !== null && p.priorHolderName === null,
          agentName: p.agentName,
          minutesLeft: Math.max(
            1,
            Math.ceil((Date.parse(p.expiresAt) - Date.now()) / 60_000),
          ),
          userEmail: who.user.email,
          csrf: await formCsrf(
            c.env,
            ROLE_CONFIRM_SCOPE,
            who.user.id,
            await sha256Hex(secret),
          ),
          switchUrl: `${AUTH.login}?next=${encodeURIComponent(ROLE_CONFIRM_PATH)}`,
        }),
        200,
        true,
      );
    } catch (e) {
      logError("bus_role_confirm_failed", e);
      return failed();
    }
  });

  app.post("/bus/roles/confirm", async (c) => {
    // The page's no-referrer policy makes browsers send `Origin: null`: the
    // signed form token and the SameSite=Lax cookie carry CSRF.
    if (busOn(c.env) && c.req.header("sec-fetch-site") === "cross-site")
      return messagePage("Not allowed", "Cross-site request.", 403);
    const who = confirmCaller(c, ROLE_CONFIRM_PATH, true);
    if ("response" in who) return who.response;
    // #1299: confirming (or rejecting) new configuration is refused under a
    // plan cap; the GET pages and the view stay readable.
    const capped = busConfigRefusal(who.user);
    if (capped) return messagePage("Not saved", capped.message, 403);
    const body = await readConfirmBody(c);
    if (body === null) return messagePage("Not saved", "Invalid form.", 400);
    const secret = body.secret ?? "";
    if (!ROLE_TOKEN.test(secret)) return refused(c, "unknown");
    if (
      !(await checkFormCsrf(
        c.env,
        ROLE_CONFIRM_SCOPE,
        who.user.id,
        await sha256Hex(secret),
        body.csrf ?? "",
      ))
    )
      return messagePage(
        "This page expired",
        "Nothing changed. Open the link again, then confirm.",
        403,
      );
    const decision = body.decision;
    if (decision !== "confirm" && decision !== "reject")
      return messagePage("Not saved", "Invalid form.", 400);
    try {
      const r = await decideBusRoleProposal(
        c.env,
        who.user.id,
        secret,
        decision,
      );
      if (r === null) return refused(c, "unknown");
      if (!r.ok) return refused(c, r.reason);
      const p = r.proposal;
      const message =
        p.action === "clear"
          ? `Role ${p.name} in ${p.namespace} is removed.`
          : `Role ${p.name} in ${p.namespace} now points at ${p.agentName ?? "its new holder"}. Later messages to it go there.`;
      return page(c, "Role updated", message, 200);
    } catch (e) {
      logError("bus_role_confirm_failed", e);
      return failed();
    }
  });
}
