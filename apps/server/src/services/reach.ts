// Can this address sign in here? Review items 11 and 37. Derived from the
// rules the sign-in paths themselves apply, never a copy of them:
// - the offered methods: authProviders (Google only when fully configured,
//   email only when codes can be sent);
// - Access: upsertOnLogin admits an active row, or a share's address as a
//   guest (who passes the Access policy is the operator's, unknowable here);
// - Google: admit's rules (googleTenantOk, googleNewRowOk);
// - codes: codeRule, the rule codeEligibility applies.
// One D1 read at most (the share lookup codeRule may ask for).
import { inDomains, noDomainIdentityOk } from "@oa/auth-core";
import {
  type LoginWay,
  orderSignInMethods,
  type ShareRecipient,
} from "@oa/shared";
import {
  type AuthConfig,
  authConfig,
  type SignInProvider,
} from "../auth/config.js";
import { authProviders } from "../auth/sign-in.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import {
  type CodeRow,
  codeRule,
  ELIGIBILITY,
  googleNewRowOk,
  googleTenantOk,
} from "./identity.js";

export type Reach = {
  /** Offered methods that admit the address, in the order sign-in lists them. */
  methods: SignInProvider[];
  /**
   * Only Google might admit it: the address is outside AUTH_DOMAINS, so it
   * works only for a Workspace account whose primary domain (hd) is verified
   * (a secondary domain). The server can't tell before they try.
   */
  googleUncertain: boolean;
  /** The address's domain is one of AUTH_DOMAINS. */
  inDomain: boolean;
  /**
   * Google admits them, but not on its own evidence: a consumer account on a
   * custom address (or a Workspace one) is let in after an emailed code,
   * first login only (#2590 G2). Only where Google and codes are both offered.
   * A Google client of type Internal (no outside account can log in) isn't
   * visible to config; the sharer's warning can't tell it apart.
   */
  googleAfterCode: boolean;
};

/** LoginWay order, as the schema lists them. */
const WAY_ORDER: readonly LoginWay[] = [
  "google",
  "google_workspace",
  "google_after_code",
  "email_code",
];

/**
 * The ways in from what reachOf found.
 */
export function waysOf(r: Reach): LoginWay[] {
  const ways = new Set<LoginWay>();
  if (r.methods.includes("google")) ways.add("google");
  else if (r.googleUncertain) ways.add("google_workspace");
  if (r.googleAfterCode) ways.add("google_after_code");
  if (r.methods.includes("email")) ways.add("email_code");
  return WAY_ORDER.filter((w) => ways.has(w));
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/**
 * Which offered sign-in methods would admit `email` (normalized) given its
 * user row (null: none) and whether a share names it.
 */
export async function reachOf(
  env: Env,
  email: string,
  row: CodeRow | null,
  shared: () => Promise<boolean>,
  cfg: AuthConfig = authConfig(env),
): Promise<Reach> {
  const offered = new Set(authProviders(env).providers.map((p) => p.id));
  const domain = domainOf(email);
  const active = row === null || row.status === "active";
  const methods: SignInProvider[] = [];
  let googleUncertain = false;
  if (offered.has("access") && (row ? row.status === "active" : await shared()))
    methods.push("access");
  // admit: a removed or suspended row is refused; no row needs a join rule.
  // A share to the exact address makes a guest on strong evidence (#2590), so
  // Google admits a recipient with no row too, on any install.
  let googleAfterCode = false;
  if (
    offered.has("google") &&
    active &&
    (row || googleNewRowOk(cfg, false) || (await shared()))
  ) {
    // Accepted assumption (review #799): an address in a verified domain is
    // treated as certain, as if its Google tenant (hd) were that domain. A
    // consumer Google account registered with a work address has no hd and
    // would get "tenant"; we don't flag that rare case. Outside the domains,
    // only a Workspace secondary domain could pass, so that is "uncertain".
    // No domains: only a Gmail address is certain; any other might be a
    // Workspace whose hd matches its domain.
    // A Gmail address is certain either way: an invitee signs in with it
    // bound to the exact address (#2520).
    const certain =
      noDomainIdentityOk(email, null) ||
      (cfg.domains.length > 0 && googleTenantOk(cfg, domain));
    if (certain) methods.push("google");
    else {
      googleUncertain = true;
      googleAfterCode = offered.has("email");
    }
  }
  if (
    offered.has("email") &&
    (await codeRule(cfg, email, row, shared)).kind !== "none"
  )
    methods.push("email");
  return {
    methods: orderSignInMethods(methods),
    googleUncertain,
    inDomain: inDomains(cfg.domains, domain),
    googleAfterCode,
  };
}

/**
 * Who can only view, for the share rows and the share email alike: `role` is
 * the org role, null with no user row. No row: a guest if any offered sign-in
 * path would make them one, Access (upsertOnLogin) or a code (codeRule). The
 * server can't know which path they'll use, so they may end up with more than
 * promised, never less. No guest path isn't a guest: they join as a member, or
 * an invite would make them one. One config read, no D1, so a list can ask per
 * row.
 */
export function guestRecipients(env: Env) {
  const cfg = authConfig(env);
  const offered = new Set(authProviders(env).providers.map((p) => p.id));
  return async (email: string, role: string | null): Promise<boolean> => {
    if (role !== null) return role === "guest";
    if (offered.has("access")) return true;
    if (!offered.has("email")) return false;
    const code = await codeRule(cfg, email, null, async () => true);
    return code.kind === "guest";
  };
}

/** reachOf for an invite: the active, unlinked row the invite is about to create. */
export const inviteReach = (
  env: Env,
  email: string,
  role: CodeRow["role"],
): Promise<Reach> =>
  reachOf(
    env,
    email,
    { id: null, role, status: "active", linked: false },
    async () => false,
  );

/**
 * A share recipient (review item 37), after the share is written: which
 * methods admit them, and ShareResult.recipient when none could (the share
 * still applies). Only for no row or an active one: a removed or suspended
 * person is out of scope here. A way is certain only when it surely admits
 * them today: Google for Gmail or an address in the login domains, codes where
 * on. Google that only might admit them (outside AUTH_DOMAINS: a Workspace
 * account) is flagged "workspace_only", and the email names Google for them.
 */
export async function shareReach(
  env: Env,
  email: string,
): Promise<{
  methods: SignInProvider[];
  recipient?: ShareRecipient;
  /** The address's org role, null with no user row (guestRecipients takes it). */
  role: string | null;
  /** The ways in for the address, [] when none (#2590). */
  ways: LoginWay[];
}> {
  const row = await stmt(env.DB, ELIGIBILITY).bind(email).first<CodeRow>();
  const role = row?.role ?? null;
  const r = await reachOf(env, email, row, async () => true);
  const ways = waysOf(r);
  if (r.methods.length > 0) return { methods: r.methods, role, ways };
  // Only Google as a Workspace account might admit them (#2590): the email
  // names Google, and the sharer is warned it works only if the address is a
  // Google Workspace account (a consumer account waits for the code step).
  // Where codes are on, a consumer account is let in after a code, so the
  // warning only applies where they are off.
  if (r.googleUncertain)
    return {
      methods: ["google"],
      ...(r.googleAfterCode
        ? {}
        : {
            recipient: { canSignIn: false, reason: "workspace_only" } as const,
          }),
      role,
      ways,
    };
  if (row && row.status !== "active") return { methods: [], role, ways };
  // In a verified domain: an invite as a member would let them in, unless
  // no offered method admits a member there either.
  // No domains at all: nothing is "outside" them, only an invite admits.
  const noDomains = authConfig(env).domains.length === 0;
  const inv = noDomains ? await inviteReach(env, email, "member") : null;
  const reason: ShareRecipient["reason"] =
    !r.inDomain && !noDomains
      ? "outside_domains"
      : (inv ?? (await inviteReach(env, email, "member"))).methods.length > 0 ||
          inv?.googleUncertain
        ? "needs_invite"
        : "no_sign_in_method";
  return {
    methods: [],
    recipient: { canSignIn: false, reason },
    role,
    ways,
  };
}
