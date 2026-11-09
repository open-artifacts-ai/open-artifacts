// The daemon's one HTTP call (#1346): ask the hub, with this machine's token,
// that the role the calling agent holds reach more namespaces. The route is
// POST BUS_ROUTES.reachProposals; it only records a proposal and returns the
// one-time link the member confirms in a browser. Everything here is
// deliberately narrow: the URL is the configured hub's and nothing a frame or
// a tool names, a redirect is an error (the token must not follow it), the
// call is bounded in time, and the token never reaches a log, an error or a
// tool result. Not a general client.
import { BUS_ROUTES } from "@oa/bus-protocol";

/** How long the hub gets to answer before the tool says it did not. */
export const REACH_TIMEOUT_MS = 10_000;
/** A reply bigger than this is not the route's. */
const MAX_REPLY_CHARS = 16_384;

export type ReachResult =
  | { ok: true; confirmUrl: string; expiresAt: string }
  | { ok: false; code: string; message: string };

/** What an agent sees for each way the proposal can fail. Plain words; nothing changed. */
export const REACH_COPY = {
  down: "The hub did not answer. Nothing changed. Try again in a moment.",
  unauthorized:
    "The hub did not accept this machine's token. Ask the user to run oa-bus login. Nothing changed.",
  old_hub:
    "This Open Artifacts hub is too old to ask for reach. Ask the user to update it. Nothing changed.",
  bad_reply:
    "The hub gave an answer this oa-bus could not use. Nothing changed. Ask the user to update oa-bus.",
  no_role:
    "You hold no role, so there is nothing to extend. Ask the person to give you a role first, then ask again. Nothing changed.",
  ambiguous:
    "You hold more than one role, so it is not clear which should reach. Nothing changed. Ask the person to leave you one role.",
  rate_limited:
    "This machine asked for too many reach changes. Nothing changed. Try again later.",
  proposal_limit:
    "Too many reach changes are waiting for the person. Nothing changed. They can confirm or let them expire, then you can ask again.",
  no_bus:
    "The hub has no connected machine for this person yet. Nothing changed.",
  refused: "The hub refused the request. Nothing changed.",
} as const;

const fail = (
  code: string,
  message: string,
): { ok: false; code: string; message: string } => ({
  ok: false,
  code,
  message,
});

/** The hub's http(s) base from its configured ws(s) or http(s) url, like the socket's own. */
export const reachUrl = (hub: string): string =>
  `${hub.replace(/^ws/, "http").replace(/\/+$/, "")}${BUS_ROUTES.reachProposals}`;

/** Only the instance's own confirm page is ever returned. */
function ownConfirmUrl(raw: unknown, hub: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const u = new URL(raw);
    const own = new URL(reachUrl(hub));
    if (
      u.origin === own.origin &&
      u.pathname === "/bus/reach/confirm" &&
      !u.search &&
      /^#[A-Za-z0-9_-]{43}$/.test(u.hash)
    )
      return u.href;
  } catch {}
  return undefined;
}

/** Control characters out; capped. For the hub's own message on a plan refusal. */
const shown = (s: string, token: string): string =>
  s
    .split(token)
    .join("")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips them
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);

export async function proposeReach(o: {
  /** The configured hub url (ws, wss, http or https), never from a frame. */
  hub: string;
  /** This machine's token. */
  token: string;
  /** The calling session's ref, from its attested connection. */
  nativeRef: string;
  namespaces: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** A line for the daemon log: never the token, the link or a namespace. */
  log?: (line: string) => void;
}): Promise<ReachResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? REACH_TIMEOUT_MS);
  try {
    let res: Response;
    let text: string;
    try {
      res = await (o.fetch ?? fetch)(reachUrl(o.hub), {
        method: "POST",
        redirect: "error",
        signal: ctl.signal,
        headers: {
          authorization: `Bearer ${o.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          nativeRef: o.nativeRef,
          namespaces: o.namespaces,
        }),
      });
      text = await res.text();
    } catch (e) {
      // The error's own text is never used: it may carry the url or headers.
      o.log?.(
        `reach proposal failed: ${e instanceof Error ? e.name : "error"}`,
      );
      return fail("hub_unavailable", REACH_COPY.down);
    }
    if (text.length > MAX_REPLY_CHARS)
      return fail("bad_reply", REACH_COPY.bad_reply);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {}
    const body = (json ?? {}) as {
      confirmUrl?: unknown;
      expiresAt?: unknown;
      error?: { message?: unknown; details?: { reason?: unknown } };
    };
    if (res.status === 200) {
      const url = ownConfirmUrl(body.confirmUrl, o.hub);
      if (
        !url ||
        typeof body.expiresAt !== "string" ||
        Number.isNaN(Date.parse(body.expiresAt))
      )
        return fail("bad_reply", REACH_COPY.bad_reply);
      return { ok: true, confirmUrl: url, expiresAt: body.expiresAt };
    }
    if (res.status === 401)
      return fail("unauthorized", REACH_COPY.unauthorized);
    if (res.status === 404) return fail("unsupported", REACH_COPY.old_hub);
    if (res.status === 409) {
      const why = body.error?.details?.reason;
      if (
        why === "no_role" ||
        why === "ambiguous" ||
        why === "rate_limited" ||
        why === "proposal_limit" ||
        why === "no_bus"
      )
        return fail(why, REACH_COPY[why]);
      return fail("refused", REACH_COPY.refused);
    }
    // 402/403 (a plan cap), 400, 429, 5xx: the hub's own words, when it has some.
    const msg =
      typeof body.error?.message === "string"
        ? shown(body.error.message, o.token)
        : "";
    return fail(
      res.status === 429 ? "rate_limited" : "refused",
      `${msg || REACH_COPY.refused} (HTTP ${res.status}) Nothing changed.`,
    );
  } finally {
    clearTimeout(timer);
  }
}
