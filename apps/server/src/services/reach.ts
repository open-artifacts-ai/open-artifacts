// Can this address sign in here? Review items 11 and 37. Derived from the
// rules the sign-in paths themselves apply, never a copy of them:
// - the offered methods: authProviders (Google only when fully configured,
//   email only when codes can be sent);
// - Access: upsertOnLogin admits an active row, or a share's address as a
//   guest (who passes the Access policy is the operator's, unknowable here);
// - Google: admit's rules (googleTenantOk, googleNewRowOk);
// - codes: codeRule, the rule codeEligibility applies.
// One D1 read at most (the share lookup codeRule may ask for).
import { inDomains } from "@oa/auth-core";
import type { ShareRecipient } from "@oa/shared";
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
};

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
  if (offered.has("google") && active && (row || googleNewRowOk(cfg, false))) {
    // Accepted assumption (review #799): an address in a verified domain is
    // treated as certain, as if its Google tenant (hd) were that domain. A
    // consumer Google account registered with a work address has no hd and
    // would get "tenant"; we don't flag that rare case. Outside the domains,
    // only a Workspace secondary domain could pass, so that is "uncertain".
    if (googleTenantOk(cfg, domain)) methods.push("google");
    else googleUncertain = true;
  }
  if (
    offered.has("email") &&
    (await codeRule(cfg, email, row, shared)).kind !== "none"
  )
    methods.push("email");
  return {
    methods,
    googleUncertain,
    inDomain: inDomains(cfg.domains, domain),
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
 * person is out of scope here. Google that only might admit them (outside
 * AUTH_DOMAINS) isn't flagged, and the email names Google for them, so the
 * flag and the email agree.
 */
export async function shareReach(
  env: Env,
  email: string,
): Promise<{ methods: SignInProvider[]; recipient?: ShareRecipient }> {
  const row = await stmt(env.DB, ELIGIBILITY).bind(email).first<CodeRow>();
  const r = await reachOf(env, email, row, async () => true);
  if (r.methods.length > 0) return { methods: r.methods };
  if (r.googleUncertain) return { methods: ["google"] };
  if (row && row.status !== "active") return { methods: [] };
  // In a verified domain: an invite as a member would let them in, unless
  // no offered method admits a member there either.
  const reason: ShareRecipient["reason"] = !r.inDomain
    ? "outside_domains"
    : (await inviteReach(env, email, "member")).methods.length > 0
      ? "needs_invite"
      : "no_sign_in_method";
  return { methods: [], recipient: { canSignIn: false, reason } };
}
