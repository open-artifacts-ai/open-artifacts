// #2520: an owner's login-domain change on a hosted install. The instance has
// already checked the owner and the proof (their fresh Google login's hd equals
// every domain); this asks the platform to apply it (POST /login-domains over
// the LoginGate, ctx.props.LOGIN), which writes the install's vars and
// redeploys it in about a minute. Fails closed: nothing changes here unless the
// platform answers 202, and a refusal is a clear 4xx with its reason.
import {
  LOGIN_DOMAINS_PATH,
  LoginDomainsAcceptedSchema,
  type LoginDomainsError,
  LoginDomainsErrorSchema,
} from "@oa/provisioning-contract/login-domains";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logWarn } from "../log.js";
import { audit, userActor } from "./audit.js";
import { LoginGateError, loginGateCall } from "./login-gate.js";

/** What the owner asked: the marker an accepted change leaves until the redeploy shows it. */
export type LoginChange = {
  ownerUserId: string;
  /** The verified Workspace domain of the owner's fresh login, "" for none. */
  hd: string;
  domains: string[];
  autoJoin: boolean;
};

const MARKER = "login_apply";
/** A marker older than this is dropped: the platform applies in about a minute. */
const MARKER_TTL_MS = 10 * 60_000;

const normalized = (domains: string[]): string[] =>
  [...new Set(domains.map((d) => d.trim().toLowerCase()))].sort();

/** The refusals the platform sends, as the install answers them. */
function refusal(code: LoginDomainsError, change: LoginChange): ApiError {
  switch (code) {
    case "plan_required":
      return new ApiError(
        "forbidden",
        "Changing login domains is a Team feature.",
        { reason: "plan_required" },
      );
    case "rate_limited":
      return new ApiError(
        "rate_limited",
        "Too many login changes today. Try again tomorrow.",
        undefined,
        { "retry-after": "3600" },
      );
    case "apply_pending":
    case "replay":
    case "no_vars":
      return new ApiError(
        "apply_pending",
        "An earlier change is still applying. Try again in a minute.",
      );
    case "domain_unproven":
      return new ApiError(
        "domain_unproven",
        "Log in with Google as someone on that domain to add it.",
        { domain: change.domains[0] ?? "" },
      );
    case "too_many_domains":
    case "bad_domain":
    case "auto_join_needs_one_domain":
    case "vars_refused":
      return new ApiError(
        "bad_request",
        "The platform can't use those login domains.",
        {
          reason: code,
        },
      );
    case "google_required":
    case "email_codes_on":
    case "install_not_serving":
      return new ApiError(
        "forbidden",
        "Login domains can't be changed on this install right now.",
        {
          reason: code,
        },
      );
    default:
      return unavailable();
  }
}

const unavailable = () =>
  new ApiError(
    "login_unavailable",
    // We can't know whether the platform applied it (a hang or a 5xx may come after it did).
    "We couldn't confirm the change. It may still apply in a few minutes. Check back before trying again.",
  );

/**
 * Sends the change; resolves when the platform accepted it (202), after which
 * the redeploy is pending and a settings.change audit row is written. Throws
 * the ApiError to answer otherwise; any answer that isn't a clean 202 or a
 * known refusal is "login_unavailable": nothing is recorded here, but the
 * platform may still have applied it (a timeout or 5xx can follow an accept),
 * so the message says so.
 */
export async function applyLoginChange(
  env: Env,
  change: LoginChange,
): Promise<void> {
  const domains = normalized(change.domains);
  try {
    const out = LoginDomainsAcceptedSchema.safeParse(
      await loginGateCall(env, LOGIN_DOMAINS_PATH, {
        ownerUserId: change.ownerUserId,
        hd: change.hd,
        domains,
        autoJoin: change.autoJoin,
      }),
    );
    if (!out.success) throw new LoginGateError("bad_answer");
  } catch (e) {
    if (e instanceof LoginGateError && e.status !== undefined) {
      const code = LoginDomainsErrorSchema.safeParse(e.code);
      // 4xx the platform answered with a known code; anything else is no answer.
      if (code.success && e.status >= 400 && e.status < 500)
        throw refusal(code.data, change);
      if (code.success && code.data === "unavailable") throw unavailable();
    }
    logWarn("login_change_failed", e, {
      why: e instanceof LoginGateError ? e.why : "error",
    });
    throw unavailable();
  }
  // Accepted: the marker and the audit row (the owner is the actor), together.
  await env.DB.batch([
    stmt(
      env.DB,
      "insert into settings (key, value) values (?1, ?2) on conflict (key) do update set value = excluded.value",
    ).bind(
      MARKER,
      JSON.stringify({ at: Date.now(), domains, autoJoin: change.autoJoin }),
    ),
    audit(
      env,
      "settings.change",
      { type: "settings", id: "instance" },
      userActor(change.ownerUserId),
      { detail: { loginDomains: domains, autoJoin: change.autoJoin } },
    ),
  ]);
}

/**
 * Whether an accepted change is still being applied: the marker exists, is
 * young, and the install's own login settings don't yet show it. Clears it
 * once they do or it is stale.
 */
export async function loginApplying(
  env: Env,
  current: { domains: readonly string[]; autoJoin: boolean },
  now = Date.now(),
): Promise<boolean> {
  const row = await stmt(env.DB, "select value from settings where key = ?1")
    .bind(MARKER)
    .first<{ value: string }>();
  if (!row) return false;
  let m: { at: number; domains: string[]; autoJoin: boolean } | null = null;
  try {
    m = JSON.parse(row.value);
  } catch {
    m = null;
  }
  const shown =
    m !== null &&
    m.autoJoin === current.autoJoin &&
    JSON.stringify(m.domains) ===
      JSON.stringify(normalized([...current.domains]));
  if (!m || shown || now - m.at > MARKER_TTL_MS) {
    await stmt(env.DB, "delete from settings where key = ?1")
      .bind(MARKER)
      .run();
    return false;
  }
  return true;
}
