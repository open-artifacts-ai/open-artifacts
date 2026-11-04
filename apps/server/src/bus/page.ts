import {
  AUTH,
  type BusAddress,
  type BusAgent,
  type BusMachine,
  type Member,
} from "@oa/shared";
import type { Context } from "hono";
import { canConnect } from "../auth/agents.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  checkFormCsrf,
  formCsrf,
  html,
  messagePage,
  pageResponse,
  type SafeHtml,
  sessionUser,
} from "../http/pages.js";
import { logError } from "../log.js";
import type { AppType } from "../routes/index.js";
import type { BusView } from "../services/bus.js";
import {
  BUS_PAGE_TEMPLATE,
  BUS_REVOKE_TEMPLATE,
  BUS_SNIPPETS,
} from "./page-template.js";

// The member's /bus page (#1300): their machines (revoke) and share notices,
// server-rendered from Design's design/screens/bus*.html. No script runs
// (PAGE_CSP), so every action is a plain form: revoke is a confirm page and a
// POST, share notices are checkboxes plus Save, and Remove forms. Every POST
// answers 303 to /bus?done=... or /bus?error=... (post-redirect-get).

// ---------------------------------------------------------------- deps
// The page's deps are the real services (services/bus.ts, services/follows.ts);
// tests inject fakes of the same shape.

/** What the page calls: services/bus.ts and services/follows.ts in the app. */
export type BusPageDeps = {
  /** One hub read. */
  busView(env: Env, userId: string): Promise<BusView>;
  /** False for an unknown or another member's machine; true (idempotent) for the caller's own. Throws ApiError internal when closing its sockets fails after the revoke. */
  revokeBusMachine(env: Env, userId: string, id: string): Promise<boolean>;
  getShareNotices(env: Env, userId: string): Promise<BusAddress[]>;
  /** Validates `agents`; bad input throws ApiError bad_request with details {path, reason}. */
  setShareNotices(
    env: Env,
    userId: string,
    agents: unknown,
  ): Promise<BusAddress[]>;
};

// ---------------------------------------------------------------- routes

export const BUS_PAGE = "/bus";
export const BUS_SHARE_NOTICES = "/bus/share-notices";
const revokePath = (id: string) =>
  `/bus/machines/${encodeURIComponent(id)}/revoke`;

const CSRF_REVOKE = "bus-revoke";
const CSRF_SHARE = "bus-share-notices";
/** The share form's CSRF handle (it decides on no one object). */
const SHARE_HANDLE = "share-notices";
/** Room for the cap of picks plus every checkbox a member could tick. */
const MAX_FORM_BYTES = 16 * 1024;
const MACHINE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------- copy

const ERRORS = {
  not_found: "That machine isn't on your list.",
  expired: "This page expired. Reload it and try again.",
  too_many: "You can pick up to 10 agents. Remove one, then save.",
  bad_form: "That didn't save. Reload the page and try again.",
  not_allowed:
    "You can't change share notices. You can still revoke machines here.",
  failed: "Something went wrong and nothing changed. Try again in a minute.",
} as const;
type ErrorCode = keyof typeof ERRORS;
/** Revoked in D1, but its open connection didn't close (shown with `m`, the machine). */
const REVOKE_FAILED = "revoke_failed";

// ---------------------------------------------------------------- rendering

type Slot = Parameters<typeof html>[1];

/**
 * Fills a Design template through the escaping `html` tag: every string is
 * escaped, only `html` results stay markup. `blocks` names the
 * `<!-- block:NAME -->` sections kept; every other block is removed whole.
 * Throws on a placeholder without a value or an unknown kept block.
 */
export function renderTemplate(
  template: string,
  values: Record<string, Slot>,
  blocks: readonly string[] = [],
): SafeHtml {
  const keep = new Set(blocks);
  const seen = new Set<string>();
  let t = template;
  const block = /<!-- block:([a-z_]+) -->([\s\S]*?)<!-- \/block:\1 -->/g;
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(block, (_, name: string, body: string) => {
      seen.add(name);
      return keep.has(name) ? body : "";
    });
  }
  for (const b of keep)
    if (!seen.has(b)) throw new Error(`template block ${b} not found`);
  const parts = t.split(/\{\{([a-z_]+)\}\}/);
  const strings: string[] = [];
  const slots: Slot[] = [];
  for (const [i, p] of parts.entries()) {
    if (i % 2 === 0) strings.push(p);
    else if (Object.hasOwn(values, p)) slots.push(values[p]);
    else throw new Error(`template placeholder {{${p}}} has no value`);
  }
  return html(
    Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray,
    ...slots,
  );
}

const snippet = (
  name: keyof typeof BUS_SNIPPETS,
  values: Record<string, Slot>,
) => renderTemplate(BUS_SNIPPETS[name], values);

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "numeric",
  minute: "2-digit",
});
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** "Oct 21", or "Oct 21, 2025" outside this year (UTC: the server has no viewer zone). */
export function dayOf(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? DAY.format(d)
    : DAY_YEAR.format(d);
}

/** "Never", "today at 9:41 AM UTC" or "Nov 2 at 6:10 PM UTC"; "today" is the UTC day. */
export function lastUsedOf(iso: string | null, now = new Date()): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  const day = ymd(d) === ymd(now) ? "today" : dayOf(iso, now);
  return `${day} at ${TIME.format(d)} UTC`;
}

/** An address as a form value: base64url of JSON [namespace, name]. */
export function encodeAddress(a: BusAddress): string {
  const bytes = new TextEncoder().encode(JSON.stringify([a.namespace, a.name]));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The inverse of encodeAddress, or null for anything else. */
export function decodeAddress(v: string): BusAddress | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(v)) return null;
  try {
    const bin = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const j: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      Array.isArray(j) &&
      j.length === 2 &&
      typeof j[0] === "string" &&
      typeof j[1] === "string"
    )
      return { namespace: j[0], name: j[1] };
  } catch {
    // fall through
  }
  return null;
}

const keyOf = (a: BusAddress) => JSON.stringify([a.namespace, a.name]);

function machineRow(m: BusMachine, live: boolean, now: Date): SafeHtml {
  const base = {
    label: m.label,
    added: dayOf(m.createdAt, now),
    last_used: lastUsedOf(m.lastUsedAt, now),
  };
  if (m.revokedAt)
    return snippet("machine-row-revoked", {
      ...base,
      revoked_on: dayOf(m.revokedAt, now),
    });
  const row =
    !live || m.connected === null
      ? "machine-row-unknown"
      : m.connected
        ? "machine-row-live"
        : "machine-row-offline";
  return snippet(row, { ...base, revoke_url: revokePath(m.id) });
}

function summaryOf(view: BusView): string {
  const n = view.machines.length;
  if (n === 0) return "";
  const count = `${n} ${n === 1 ? "machine" : "machines"}`;
  if (!view.live) return count;
  const on = view.machines.filter((m) => !m.revokedAt && m.connected).length;
  return `${count} · ${on} live`;
}

function messageOf(url: URL, view: BusView): SafeHtml | "" {
  const done = url.searchParams.get("done");
  if (done === "saved")
    return snippet("message-ok", { text: "Share notices saved." });
  if (done === "revoked") {
    const id = url.searchParams.get("m");
    const m = view.machines.find((x) => x.id === id);
    return snippet("message-ok", {
      text: m ? `${m.label} revoked.` : "Machine revoked.",
    });
  }
  const err = url.searchParams.get("error");
  if (err === REVOKE_FAILED) {
    const id = url.searchParams.get("m");
    const m = view.machines.find((x) => x.id === id);
    return m
      ? snippet("message-revoke-partial", {
          label: m.label,
          retry_url: revokePath(m.id),
        })
      : snippet("message-error", { text: ERRORS.failed });
  }
  if (err && Object.hasOwn(ERRORS, err))
    return snippet("message-error", { text: ERRORS[err as ErrorCode] });
  return "";
}

type Access = "full" | "revoke";

/** canConnect: the whole page. Otherwise, with an unrevoked machine: revoke only. Else none (404). */
function accessOf(user: Member, view: BusView | null): Access | null {
  if (canConnect(user)) return "full";
  return view?.machines.some((m) => !m.revokedAt) ? "revoke" : null;
}

/** One of the caller's own machines, revoked or not. */
const ownMachine = (view: BusView, id: string | null | undefined) =>
  id && MACHINE_ID.test(id)
    ? view.machines.find((m) => m.id === id)
    : undefined;

async function renderPage(
  c: Context<AppEnv>,
  deps: BusPageDeps,
  user: Member,
  view: BusView,
  access: Access,
): Promise<Response> {
  const env = c.env;
  const now = new Date();
  const hasMachines = view.machines.length > 0;
  const blocks: string[] = [];
  if (!view.live && hasMachines) blocks.push("hub_line");
  if (access === "revoke") blocks.push("machines_note");
  blocks.push(hasMachines ? "machines_table" : "machines_empty");
  const values: Record<string, Slot> = {
    instance_host: env.APP_HOST,
    message: messageOf(new URL(c.req.url), view),
    machines_summary: summaryOf(view),
    machine_rows: view.machines.map((m) => machineRow(m, view.live, now)),
    agent_rows: "",
    gone_rows: "",
    picked_rows: "",
    share_action: BUS_SHARE_NOTICES,
    csrf_token: "",
  };
  if (access === "full") {
    blocks.push("share_card");
    const picked = await deps.getShareNotices(env, user.id);
    const csrf = await formCsrf(env, CSRF_SHARE, user.id, SHARE_HANDLE);
    values.csrf_token = csrf;
    const rowOf = (a: BusAddress) => ({
      address: encodeAddress(a),
      name: a.name,
      namespace: a.namespace,
      share_action: BUS_SHARE_NOTICES,
      csrf_token: csrf,
    });
    if (hasMachines && !view.live) {
      blocks.push("share_hub_unknown");
      values.picked_rows = picked.map((a) =>
        snippet("agent-picked-row", rowOf(a)),
      );
    } else {
      const running = new Map<string, BusAgent>();
      for (const a of view.agents)
        if (a.running && !running.has(keyOf(a))) running.set(keyOf(a), a);
      const pickedKeys = new Set(picked.map(keyOf));
      values.gone_rows = picked
        .filter((a) => !running.has(keyOf(a)))
        .map((a) => snippet("agent-gone-row", rowOf(a)));
      if (running.size > 0) {
        blocks.push("share_picker");
        values.agent_rows = [...running.values()].map((a) =>
          snippet("agent-row", {
            address: encodeAddress(a),
            name: a.name,
            namespace: a.namespace,
            machine_label: a.machineLabel,
            checked: pickedKeys.has(keyOf(a)) ? "checked" : "",
          }),
        );
      } else blocks.push("share_none");
    }
  }
  return pageResponse(
    renderTemplate(BUS_PAGE_TEMPLATE, values, blocks).value,
    200,
  );
}

// ---------------------------------------------------------------- handlers

const notFoundPage = () =>
  messagePage(
    "Page not found",
    "This page doesn't exist, or you don't have access to it.",
    404,
  );
const tokenRefused = () =>
  messagePage(
    "Use your browser",
    "This page needs a browser session, not a token.",
    401,
  );
const failedPage = () =>
  messagePage(
    "Something went wrong",
    "Nothing changed. Reload the page to try again.",
    500,
  );
const redirect = (location: string, status: 302 | 303) =>
  new Response(null, {
    status,
    headers: { location, "cache-control": "no-store" },
  });
const back = (q: string) => redirect(`${BUS_PAGE}?${q}`, 303);
const backError = (code: ErrorCode) => back(`error=${code}`);

type Signed = { user: Member } | { response: Response };

/** A GET's caller: 404 on hosted, 401 for a token, a sign-in redirect without a session. */
function getCaller(c: Context<AppEnv>): Signed {
  if (c.env.HOSTED === "1") return { response: notFoundPage() };
  if (c.var.tokenId) return { response: tokenRefused() };
  const user = sessionUser(c);
  if (!user) {
    const url = new URL(c.req.url);
    const next = encodeURIComponent(`${url.pathname}${url.search}`);
    return { response: redirect(`${AUTH.login}?next=${next}`, 302) };
  }
  return { user };
}

type Posted = { user: Member; form: FormData } | { response: Response };

/** A POST's caller and form: hosted, cross-site, token, session, size, then the form's CSRF. */
async function postCaller(
  c: Context<AppEnv>,
  scope: string,
  handle: string,
): Promise<Posted> {
  if (c.env.HOSTED === "1") return { response: notFoundPage() };
  // No sameOrigin(): the page's no-referrer policy makes browsers send
  // `Origin: null`. The signed token and the SameSite=Lax cookie cover CSRF.
  if (c.req.header("sec-fetch-site") === "cross-site")
    return {
      response: messagePage("Not allowed", "Cross-site request.", 403),
    };
  if (c.var.tokenId) return { response: tokenRefused() };
  const user = sessionUser(c);
  if (!user)
    return {
      response: messagePage(
        "Signed out",
        "Your session ended. Sign in and try again.",
        401,
      ),
    };
  // Fails closed: no content-length (a chunked body), or anything but plain
  // digits, is refused before the body is read.
  const cl = c.req.header("content-length") ?? "";
  if (!/^\d{1,9}$/.test(cl) || Number(cl) > MAX_FORM_BYTES)
    return { response: messagePage("Not saved", "Invalid form.", 400) };
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return { response: messagePage("Not saved", "Invalid form.", 400) };
  }
  const csrf = form.get("csrf");
  if (
    typeof csrf !== "string" ||
    !(await checkFormCsrf(c.env, scope, user.id, handle, csrf))
  )
    return { response: backError("expired") };
  return { user, form };
}

const reasonOf = (e: unknown): string | undefined => {
  if (!(e instanceof ApiError) || e.code !== "bad_request") return undefined;
  const d = e.details as { reason?: unknown } | undefined;
  return typeof d?.reason === "string" ? d.reason : undefined;
};

export function mountBusPage(app: AppType, deps: BusPageDeps): void {
  app.get(BUS_PAGE, async (c) => {
    const who = getCaller(c);
    if ("response" in who) return who.response;
    try {
      const view = await deps.busView(c.env, who.user.id);
      const url = new URL(c.req.url);
      // A capped caller whose last machine is revoked has nothing to revoke,
      // except right after a revoke of one of theirs: a partial one shows its
      // retry line, a successful one (the retry) its "revoked" line.
      const after =
        url.searchParams.get("error") === REVOKE_FAILED ||
        url.searchParams.get("done") === "revoked";
      const retry =
        after && ownMachine(view, url.searchParams.get("m")) !== undefined;
      const access = accessOf(who.user, view) ?? (retry ? "revoke" : null);
      if (!access) return notFoundPage();
      return await renderPage(c, deps, who.user, view, access);
    } catch (e) {
      logError("bus_page_failed", e);
      return failedPage();
    }
  });

  app.get("/bus/machines/:id/revoke", async (c) => {
    const who = getCaller(c);
    if ("response" in who) return who.response;
    const id = c.req.param("id");
    try {
      const view = await deps.busView(c.env, who.user.id);
      // An own machine that's already revoked still loads: revoke is
      // idempotent, and it's how a partial revoke is retried. A capped
      // caller's access is about the machine: one of theirs, or 404.
      const m = ownMachine(view, id);
      if (!m)
        return canConnect(who.user) ? backError("not_found") : notFoundPage();
      const page = renderTemplate(BUS_REVOKE_TEMPLATE, {
        label: m.label,
        instance_host: c.env.APP_HOST,
        form_action: revokePath(id),
        csrf_token: await formCsrf(c.env, CSRF_REVOKE, who.user.id, id),
        cancel_url: BUS_PAGE,
      });
      return pageResponse(page.value, 200);
    } catch (e) {
      logError("bus_page_failed", e);
      return failedPage();
    }
  });

  app.post("/bus/machines/:id/revoke", async (c) => {
    const id = c.req.param("id");
    const p = await postCaller(c, CSRF_REVOKE, id);
    if ("response" in p) return p.response;
    if (!canConnect(p.user)) {
      // A capped caller may revoke any machine of their own, revoked or not
      // (the retry after a partial revoke); anything else is 404.
      const view = await deps.busView(c.env, p.user.id);
      if (!ownMachine(view, id)) return notFoundPage();
    }
    if (!MACHINE_ID.test(id)) return backError("not_found");
    try {
      if (!(await deps.revokeBusMachine(c.env, p.user.id, id)))
        return backError("not_found");
    } catch (e) {
      logError("bus_revoke_failed", e);
      return e instanceof ApiError && e.code === "internal"
        ? back(`error=${REVOKE_FAILED}&m=${encodeURIComponent(id)}`)
        : backError("failed");
    }
    return back(`done=revoked&m=${encodeURIComponent(id)}`);
  });

  app.post(BUS_SHARE_NOTICES, async (c) => {
    const p = await postCaller(c, CSRF_SHARE, SHARE_HANDLE);
    if ("response" in p) return p.response;
    if (!canConnect(p.user)) {
      const view = await deps.busView(c.env, p.user.id);
      return accessOf(p.user, view) ? backError("not_allowed") : notFoundPage();
    }
    const decode = (vs: FormDataEntryValue[]) => {
      const out = new Map<string, BusAddress>();
      for (const v of vs) {
        const a = typeof v === "string" ? decodeAddress(v) : null;
        if (!a) return null;
        out.set(keyOf(a), a);
      }
      return out;
    };
    try {
      let next: Map<string, BusAddress> | null;
      const remove = p.form.getAll("remove");
      if (remove.length > 0) {
        const gone = decode(remove);
        if (gone?.size !== 1) return backError("bad_form");
        const stored = await deps.getShareNotices(c.env, p.user.id);
        next = new Map(
          stored.filter((a) => !gone.has(keyOf(a))).map((a) => [keyOf(a), a]),
        );
      } else next = decode(p.form.getAll("address"));
      if (!next) return backError("bad_form");
      await deps.setShareNotices(c.env, p.user.id, [...next.values()]);
    } catch (e) {
      const reason = reasonOf(e);
      if (reason === "too_many") return backError("too_many");
      if (reason === "invalid" || reason === "reserved")
        return backError("bad_form");
      logError("bus_share_notices_failed", e);
      return backError("failed");
    }
    return back("done=saved");
  });
}
