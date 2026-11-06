import { BUS_ROUTES } from "@oa/bus-protocol";
import { AUTH } from "@oa/shared";
import type { Context } from "hono";
import { appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  checkFormCsrf,
  formCsrf,
  messagePage,
  pageResponse,
} from "../http/pages.js";
import { logError } from "../log.js";
import type { AppType } from "../routes/index.js";
import {
  decideBusLinkProposal,
  LINK_CONFIRM_PATH,
  ROLE_TOKEN,
  viewBusLinkProposal,
} from "../services/bus.js";
import { sha256Hex } from "../util/crypto.js";
import { renderLinkConfirm, renderRoleDone } from "./approve-page.js";
import type { LinkRefusalReason } from "./link-proposals.js";
import { confirmCaller } from "./role-confirm.js";

// #1567: the confirm link of `oa-bus link` / `oa-bus unlink`
// (`<origin>/bus/links/confirm/<secret>`). The CLI holds only a machine
// token, which must never mint reach, so a link or unlink applies only here,
// by the member, in a browser: the same checks as the role confirm page
// (bus/role-confirm.ts confirmCaller: an interactive cookie session, no
// Authorization header, a sign-in under 10 minutes old; a POST also takes
// the page's form token). The secret finds the proposal in the signed-in
// member's own hub only, and works once.

/** The form token's scope (http/pages.ts formCsrf); its handle is the secret's sha256. */
export const LINK_CONFIRM_SCOPE = "bus-link-confirm";
const MAX_FORM_BYTES = 8 * 1024;
const WHAT = "a link change";

const pathOf = (secret: string) => `${LINK_CONFIRM_PATH}/${secret}`;

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

const REFUSED: Record<
  LinkRefusalReason,
  { title: string; message: string; status: number }
> = {
  unknown: {
    title: "This link doesn't work",
    message:
      "No link change waits behind this link for you. Check that you're signed in as the right person, or run the command again.",
    status: 404,
  },
  used: {
    title: "Already decided",
    message:
      "This link change was already confirmed or turned down. A link works once.",
    status: 410,
  },
  expired: {
    title: "This link expired",
    message: "Nothing changed. Run the command again for a new link.",
    status: 410,
  },
  link_limit: {
    title: "Can't apply this change",
    message: "You have too many links. Nothing changed.",
    status: 409,
  },
  rejected: {
    title: "Change turned down",
    message: "Nothing changed. The link no longer works.",
    status: 200,
  },
};

const refused = (c: Context<AppEnv>, why: LinkRefusalReason) => {
  const r = REFUSED[why];
  return page(c, r.title, r.message, r.status);
};

const failed = () =>
  messagePage(
    "Something went wrong",
    "Nothing changed. Try again in a minute.",
    500,
  );

/** The routes, literal for the red-line scan (tests/redline); LINK_CONFIRM_PATH plus the secret. */
export function mountLinkConfirm(app: AppType): void {
  app.get("/bus/links/confirm/:token", async (c) => {
    const secret = c.req.param("token");
    const who = confirmCaller(c, pathOf(secret), false, WHAT);
    if ("response" in who) return who.response;
    if (!ROLE_TOKEN.test(secret)) return refused(c, "unknown");
    try {
      const v = await viewBusLinkProposal(c.env, who.user.id, secret);
      if (v === null) return refused(c, "unknown");
      if (!v.ok) return refused(c, v.reason);
      const p = v.proposal;
      return pageResponse(
        renderLinkConfirm({
          instanceHost: c.env.APP_HOST,
          action: p.action,
          a: p.a,
          b: p.b,
          noop: v.noop,
          machineLabel: p.machineLabel,
          proposedAt: p.createdAt,
          minutesLeft: Math.max(
            1,
            Math.ceil((p.expiresAt - Date.now()) / 60_000),
          ),
          userEmail: who.user.email,
          formAction: pathOf(secret),
          csrf: await formCsrf(
            c.env,
            LINK_CONFIRM_SCOPE,
            who.user.id,
            await sha256Hex(secret),
          ),
          switchUrl: `${AUTH.login}?next=${encodeURIComponent(pathOf(secret))}`,
        }),
        200,
      );
    } catch (e) {
      logError("bus_link_confirm_failed", e);
      return failed();
    }
  });

  app.post("/bus/links/confirm/:token", async (c) => {
    const secret = c.req.param("token");
    // The page sends no referrer (Origin: null): the signed form token and
    // the SameSite=Lax cookie carry CSRF, as the role confirm page.
    if (c.req.header("sec-fetch-site") === "cross-site")
      return messagePage("Not allowed", "Cross-site request.", 403);
    const who = confirmCaller(c, pathOf(secret), true, WHAT);
    if ("response" in who) return who.response;
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
        LINK_CONFIRM_SCOPE,
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
      const r = await decideBusLinkProposal(
        c.env,
        who.user.id,
        secret,
        decision,
      );
      if (r === null) return refused(c, "unknown");
      if (!r.ok) return refused(c, r.reason);
      const p = r.proposal;
      const link = p.action === "link";
      const message = r.noop
        ? link
          ? `${p.a} and ${p.b} were already linked. Nothing changed.`
          : `${p.a} and ${p.b} were not linked. Nothing changed.`
        : link
          ? `${p.a} and ${p.b} are linked. Their agents can see and message each other.`
          : `${p.a} and ${p.b} are unlinked.`;
      return page(c, link ? "Linked" : "Unlinked", message, 200);
    } catch (e) {
      logError("bus_link_confirm_failed", e);
      return failed();
    }
  });
}
