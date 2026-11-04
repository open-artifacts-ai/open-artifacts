import { BUS_ROUTES } from "@oa/bus-protocol";
import { AUTH, type Member } from "@oa/shared";
import type { Context } from "hono";
import { canConnect } from "../auth/agents.js";
import { interactiveSession } from "../auth/authz.js";
import { isEmbedRequest } from "../http/embed.js";
import { appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  checkFormCsrf,
  formCsrf,
  messagePage,
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
import { renderRoleConfirm, renderRoleDone } from "./approve-page.js";
import type { ProposalRefusalReason } from "./role-proposals.js";
import { busOff } from "./routes.js";

// #1372: the confirm link of an AI agent's role proposal
// (`<origin>/bus/roles/confirm/<secret>`, from MCP bus_role_propose). The
// user's guardrail ("Let's do B", then "1, propose via MCP, I confirm by
// link"): a proposal applies only here, by the member, in a browser.
//
// Both routes take only an interactive cookie session (Google, an email code
// or Access; never a dev or test session) with no Authorization header: a
// PAT, an OAuth grant or a machine token is refused before anything is
// read. The secret finds the proposal in the signed-in member's own hub
// only, so another member's session finds nothing. GET shows it; POST, with
// the page's form token (bound to the member and this link, valid
// FORM_CSRF_TTL_S), confirms or rejects it once. The hub re-checks it at
// decision time and refuses when the role moved since it was proposed.

/** The form token's scope (http/pages.ts formCsrf); its handle is the secret's sha256. */
export const ROLE_CONFIRM_SCOPE = "bus-role-confirm";
const MAX_FORM_BYTES = 8 * 1024;

const pathOf = (secret: string) => `${ROLE_CONFIRM_PATH}/${secret}`;

const page = (
  c: Context<AppEnv>,
  title: string,
  message: string,
  status: number,
) =>
  pageResponse(
    renderRoleDone({
      instanceHost: c.env.APP_HOST,
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

type Who = { user: Member } | { response: Response };

/**
 * The caller, or the page that refuses them: bus off, embed, any
 * Authorization header (a PAT, an OAuth grant, a machine token), signed out
 * (GET: to sign-in and back; POST: 401), not allowed to connect agents, or
 * not an interactive sign-in.
 */
function caller(c: Context<AppEnv>, secret: string, post: boolean): Who {
  if (!busOn(c.env)) return { response: busOff() };
  if (isEmbedRequest(c.req.raw)) return { response: busOff() };
  if (c.req.header("authorization") !== undefined || c.var.tokenId)
    return {
      response: messagePage(
        "Use your browser",
        "Only you can confirm this, signed in in your browser. No token or AI agent can.",
        401,
      ),
    };
  const user = sessionUser(c);
  if (!user) {
    if (post)
      return {
        response: messagePage(
          "Signed out",
          "Your session ended. Sign in, then open the link again.",
          401,
        ),
      };
    return {
      response: new Response(null, {
        status: 302,
        headers: {
          location: `${AUTH.login}?next=${encodeURIComponent(pathOf(secret))}`,
          "cache-control": "no-store",
        },
      }),
    };
  }
  if (!canConnect(user)) return { response: busOff() };
  if (!interactiveSession(c))
    return {
      response: messagePage(
        "Sign in again",
        "Confirming a role change takes a browser sign-in. Sign in again, then open the link.",
        403,
      ),
    };
  return { user };
}

/** The routes, literal for the red-line scan (tests/redline); ROLE_CONFIRM_PATH plus the secret. */
export function mountRoleConfirm(app: AppType): void {
  app.get("/bus/roles/confirm/:token", async (c) => {
    const secret = c.req.param("token");
    const who = caller(c, secret, false);
    if ("response" in who) return who.response;
    if (!ROLE_TOKEN.test(secret)) return refused(c, "unknown");
    try {
      const v = await viewBusRoleProposal(c.env, who.user.id, secret);
      if (v === null) return refused(c, "unknown");
      if (!v.ok) return refused(c, v.reason);
      const p = v.proposal;
      return pageResponse(
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
          formAction: pathOf(secret),
          csrf: await formCsrf(
            c.env,
            ROLE_CONFIRM_SCOPE,
            who.user.id,
            await sha256Hex(secret),
          ),
          switchUrl: `${AUTH.login}?next=${encodeURIComponent(pathOf(secret))}`,
        }),
        200,
      );
    } catch (e) {
      logError("bus_role_confirm_failed", e);
      return failed();
    }
  });

  app.post("/bus/roles/confirm/:token", async (c) => {
    const secret = c.req.param("token");
    // The page's no-referrer policy makes browsers send `Origin: null`: the
    // signed form token and the SameSite=Lax cookie carry CSRF.
    if (busOn(c.env) && c.req.header("sec-fetch-site") === "cross-site")
      return messagePage("Not allowed", "Cross-site request.", 403);
    const who = caller(c, secret, true);
    if ("response" in who) return who.response;
    // Fails closed: no content-length (a chunked body), or anything but
    // plain digits, is refused before the body is read.
    const cl = c.req.header("content-length") ?? "";
    if (!/^\d{1,9}$/.test(cl) || Number(cl) > MAX_FORM_BYTES)
      return messagePage("Not saved", "Invalid form.", 400);
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      return messagePage("Not saved", "Invalid form.", 400);
    }
    const one = (k: string): string | null => {
      const v = form.getAll(k);
      return v.length === 1 && typeof v[0] === "string" ? v[0] : null;
    };
    if (!ROLE_TOKEN.test(secret)) return refused(c, "unknown");
    const csrf = one("csrf");
    if (
      csrf === null ||
      !(await checkFormCsrf(
        c.env,
        ROLE_CONFIRM_SCOPE,
        who.user.id,
        await sha256Hex(secret),
        csrf,
      ))
    )
      return messagePage(
        "This page expired",
        "Nothing changed. Open the link again, then confirm.",
        403,
      );
    const decision = one("decision");
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
