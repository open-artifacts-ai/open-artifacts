import { BUS_ROUTES } from "@oa/bus-protocol";
import { AUTH } from "@oa/shared";
import type { Context } from "hono";
import { appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  checkFormCsrf,
  formCsrf,
  messagePage,
  newNonce,
  pageResponse,
} from "../http/pages.js";
import { logError } from "../log.js";
import type { AppType } from "../routes/index.js";
import {
  decideBusReachProposal,
  REACH_CONFIRM_PATH,
  ROLE_TOKEN,
  viewBusReachProposal,
} from "../services/bus.js";
import { sha256Hex } from "../util/crypto.js";
import {
  renderConfirmPage,
  renderDoneCard,
  renderReachConfirm,
} from "./approve-page.js";
import { busConfigRefusal } from "./cap.js";
import type { ReachRefusalReason } from "./reach-proposals.js";
import {
  cardResponse,
  confirmCaller,
  oldFormatPage,
  readConfirmBody,
} from "./role-confirm.js";

// #1346: the confirm link of a reach proposal
// (`<origin>/bus/reach/confirm#<secret>`; the secret is in the URL fragment,
// so no request, log or referrer carries it, #1426: the page loads without
// it and its script posts it in a body). The agent holds only its machine's
// token, which must never mint reach, so a grant applies only here, by the
// member, in a browser: the same checks as the role confirm page
// (bus/role-confirm.ts confirmCaller: an interactive cookie session, no
// Authorization header, a sign-in under 10 minutes old; a POST also takes
// the page's form token). The secret finds the proposal in the signed-in
// member's own hub only, and works once.

/** The form token's scope (http/pages.ts formCsrf); its handle is the secret's sha256. */
export const REACH_CONFIRM_SCOPE = "bus-reach-confirm";
/** The page token's scope: it authorizes the details request. */
export const REACH_CONFIRM_VIEW_SCOPE = "bus-reach-confirm-view";
const WHAT = "a reach change";

const page = (
  c: Context<AppEnv>,
  title: string,
  message: string,
  status: number,
  /** Keep the link's secret in the page: the member can still open it again. */
  keep = false,
) =>
  cardResponse(
    renderDoneCard({
      title,
      message,
      busUrl: `${appOrigin(c.env)}${BUS_ROUTES.page}`,
    }),
    status,
    keep,
  );

const REFUSED: Record<
  ReachRefusalReason,
  { title: string; message: string; status: number }
> = {
  unknown: {
    title: "This link doesn't work",
    message:
      "No reach change waits behind this link for you. Check that you're logged in as the right person, or ask the agent again.",
    status: 404,
  },
  used: {
    title: "Already decided",
    message:
      "This reach change was already confirmed or turned down. A link works once.",
    status: 410,
  },
  expired: {
    title: "This link expired",
    message: "Nothing changed. Ask the agent again for a new link.",
    status: 410,
  },
  changed: {
    title: "The role changed",
    message:
      "The role or its holder is not what this link was made for. Nothing changed. Ask the agent again.",
    status: 409,
  },
  reach_limit: {
    title: "Can't apply this change",
    message:
      "This role or your bus has too many reach grants. Nothing changed.",
    status: 409,
  },
  rejected: {
    title: "Change turned down",
    message: "Nothing changed. The link no longer works.",
    status: 200,
  },
};

const refused = (c: Context<AppEnv>, why: ReachRefusalReason) => {
  const r = REFUSED[why];
  return page(c, r.title, r.message, r.status);
};

/** "a", "a and b", "a, b and c". */
const joined = (ns: string[]) =>
  ns.length < 2
    ? (ns[0] ?? "")
    : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;

/** A card (JSON, which the page's script renders), not a bare page: the grant may have applied. */
const unsure = (c: Context<AppEnv>) =>
  page(
    c,
    "Something went wrong",
    "We could not confirm this finished. Check the role's reach before trying again.",
    500,
    true,
  );

const failed = () =>
  messagePage(
    "Something went wrong",
    "Nothing changed. Try again in a minute.",
    500,
  );

/** The routes, literal for the red-line scan (tests/redline); REACH_CONFIRM_PATH, its details and its decision. */
export function mountReachConfirm(app: AppType): void {
  app.get("/bus/reach/confirm", async (c) => {
    const who = confirmCaller(c, REACH_CONFIRM_PATH, false, WHAT);
    if ("response" in who) return who.response;
    const nonce = newNonce();
    return pageResponse(
      renderConfirmPage({
        instanceHost: c.env.APP_HOST,
        title: "Confirm a reach change",
        base: REACH_CONFIRM_PATH,
        csrf: await formCsrf(
          c.env,
          REACH_CONFIRM_VIEW_SCOPE,
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
  app.get("/bus/reach/confirm/:token", (c) =>
    oldFormatPage(c, "Ask the agent again for a new link."),
  );

  app.post("/bus/reach/confirm/view", async (c) => {
    if (c.req.header("sec-fetch-site") === "cross-site")
      return messagePage("Not allowed", "Cross-site request.", 403);
    const who = confirmCaller(c, REACH_CONFIRM_PATH, true, WHAT);
    if ("response" in who) return who.response;
    const body = await readConfirmBody(c);
    if (body === null) return messagePage("Not saved", "Invalid request.", 400);
    const secret = body.secret ?? "";
    if (
      !(await checkFormCsrf(
        c.env,
        REACH_CONFIRM_VIEW_SCOPE,
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
      const v = await viewBusReachProposal(c.env, who.user.id, secret);
      if (v === null) return refused(c, "unknown");
      if (!v.ok) return refused(c, v.reason);
      const p = v.proposal;
      return cardResponse(
        renderReachConfirm({
          instanceHost: c.env.APP_HOST,
          roleName: p.roleName,
          roleNamespace: p.roleNamespace,
          holderName: p.agentName,
          namespaces: p.namespaces,
          unknown: v.unknown,
          noop: v.noop,
          machineLabel: p.machineLabel,
          proposedAt: p.createdAt,
          minutesLeft: Math.max(
            1,
            Math.ceil((p.expiresAt - Date.now()) / 60_000),
          ),
          userEmail: who.user.email,
          csrf: await formCsrf(
            c.env,
            REACH_CONFIRM_SCOPE,
            who.user.id,
            await sha256Hex(secret),
          ),
          switchUrl: `${AUTH.login}?next=${encodeURIComponent(REACH_CONFIRM_PATH)}`,
        }),
        200,
        true,
      );
    } catch (e) {
      logError("bus_reach_confirm_failed", e);
      return failed();
    }
  });

  app.post("/bus/reach/confirm", async (c) => {
    // The page sends no referrer (Origin: null): the signed form token and
    // the SameSite=Lax cookie carry CSRF, as the role confirm page.
    if (c.req.header("sec-fetch-site") === "cross-site")
      return messagePage("Not allowed", "Cross-site request.", 403);
    const who = confirmCaller(c, REACH_CONFIRM_PATH, true, WHAT);
    if ("response" in who) return who.response;
    // #1299: confirming (or rejecting) new configuration is refused under a
    // plan cap; the GET pages and the view stay readable.
    const capped = busConfigRefusal(who.user);
    if (capped) return page(c, "Not saved", capped.message, 403, true);
    const body = await readConfirmBody(c);
    if (body === null) return messagePage("Not saved", "Invalid form.", 400);
    const secret = body.secret ?? "";
    if (!ROLE_TOKEN.test(secret)) return refused(c, "unknown");
    if (
      !(await checkFormCsrf(
        c.env,
        REACH_CONFIRM_SCOPE,
        who.user.id,
        await sha256Hex(secret),
        body.csrf ?? "",
      ))
    )
      return page(
        c,
        "This page expired",
        "Nothing changed. Open the link again, then confirm.",
        403,
        true,
      );
    const decision = body.decision;
    if (decision !== "confirm" && decision !== "reject")
      return messagePage("Not saved", "Invalid form.", 400);
    try {
      const r = await decideBusReachProposal(
        c.env,
        who.user.id,
        secret,
        decision,
      );
      if (r === null) return refused(c, "unknown");
      if (!r.ok) return refused(c, r.reason);
      const p = r.proposal;
      const message = r.noop
        ? `${p.roleName} already reached ${joined(p.namespaces)}. Nothing changed.`
        : `${p.roleName} can now message agents in ${joined(p.namespaces)}. They can reply.`;
      return page(c, "Reach updated", message, 200);
    } catch (e) {
      logError("bus_reach_confirm_failed", e);
      // The grant may have landed before the failure (the hub answered late,
      // or only the audit write failed): never say nothing changed.
      return unsure(c);
    }
  });
}
