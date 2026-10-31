import type {
  InstallState,
  JobKind,
  PrincipalKind,
  ProvisioningEnv,
  TokenScope,
} from "./enums.js";
import type { RouteId } from "./routes.js";

// The authz table (design v7 4.2): one data table, one enforcement function.
// An MCP tool has no row of its own: it uses its route's row.

export const AUTHZ_COLUMNS = [
  "admin",
  "token",
  "oidc",
  "user",
  "none",
] as const;
export type AuthzColumn = (typeof AUTHZ_COLUMNS)[number];

/**
 * allow: `reach` "all" or "own" (the handler scopes to the principal's
 * installs: O own `rl-` test installs, U its own; outside it is 404), and for
 * tokens the one `scope` the row needs. `note` is the business rule the
 * handler adds after authz.
 */
export type AuthzRule =
  | { allow: false; code: "unauthenticated" | "forbidden" }
  | { allow: true; reach: "all" | "own"; scope?: TokenScope; note?: string };

const all = { allow: true, reach: "all" } as const;
const own = { allow: true, reach: "own" } as const;
const no = { allow: false, code: "forbidden" } as const;
const unauth = { allow: false, code: "unauthenticated" } as const;
const tok = (scope: TokenScope, note?: string): AuthzRule => ({
  allow: true,
  reach: "all",
  scope,
  ...(note ? { note } : {}),
});
const row = (
  admin: AuthzRule,
  token: AuthzRule,
  oidc: AuthzRule,
  user: AuthzRule,
  noAuth: AuthzRule = unauth,
): Record<AuthzColumn, AuthzRule> => ({
  admin,
  token,
  oidc,
  user,
  none: noAuth,
});

const opRow = row(all, tok("installs:write"), own, no);
const adminOnly = row(all, no, no, no);

export const AUTHZ: Readonly<Record<RouteId, Record<AuthzColumn, AuthzRule>>> =
  {
    R1: row(all, all, all, all),
    R2: row(all, tok("installs:read"), own, own),
    R3: row(
      all,
      tok("installs:read", "ownerEmail needs installs:pii"),
      own,
      own,
    ),
    R4: row(
      { ...all, note: "3.3 field rules (checkCreateFields)" },
      tok("installs:write", "3.3 field rules (checkCreateFields)"),
      {
        ...own,
        note: "rl- slug, testHooks: true, @STAGING_TEST_DOMAIN owner (oidcMayCreate)",
      },
      { ...own, note: "self-serve policy (4.2)" },
    ),
    R5: opRow,
    R6: opRow,
    R7: opRow,
    R8: opRow,
    R9: row(all, tok("installs:delete"), own, {
      ...own,
      note: "not while suspended",
    }),
    R10: row(all, tok("installs:delete"), own, own),
    R11: row(
      { ...all, note: "deleting needs authAt within 10 min (reauth_required)" },
      tok(
        "installs:delete",
        "failed creates only (TRANSITIONS actor T); deleting: 403 forbidden with details.needs admin_session; skipDirectoryRevoke: PURGE_FIELD_RULES",
      ),
      { ...own, note: "skipDirectoryRevoke: PURGE_FIELD_RULES" },
      no,
    ),
    R12: opRow,
    R13: {
      ...adminOnly,
      admin: { ...all, note: "force needs a live lease, audited" },
    },
    R14: row(all, tok("installs:read"), own, own),
    R15: row(
      all,
      tok("installs:read"),
      { ...own, note: "sealed only to the creating OIDC caller, once" },
      own,
    ),
    R16: row(all, tok("installs:read"), all, no),
    R17: row(
      all,
      tok("audit:read", "email detail fields need installs:pii"),
      { ...own, note: "own actor rows" },
      no,
    ),
    R18: row(all, tok("installs:read"), all, { ...all, note: "RL_PV_SLUG_IP" }),
    R19: adminOnly,
    R20: adminOnly,
    R21: adminOnly,
    // Browser hosts; a bearer there is 401 (host policy).
    R22: row(all, all, all, all, all),
    R23: row(all, all, all, all, all),
    R24: row(all, unauth, unauth, all),
    R25: { ...adminOnly, admin: { ...all, note: "typed slug, audited" } },
    R26: row(no, no, { ...own, note: "staging, rl- and testHooks" }, no),
    R27: row(all, tok("installs:read"), no, no),
  };

export type AuthzPrincipal = {
  kind: PrincipalKind;
  scopes?: readonly TokenScope[];
} | null;
export type AuthzDecision =
  | { ok: true; reach: "all" | "own" }
  | { ok: false; code: "unauthenticated" | "forbidden" };

/**
 * The enforcement function (the authz step of the 4.2 check order). `null` is
 * no credential. Prod refuses OIDC outright (Q1); system principals never
 * call a route.
 */
export function authorize(
  route: RouteId,
  principal: AuthzPrincipal,
  env: ProvisioningEnv,
): AuthzDecision {
  if (principal?.kind === "system") return { ok: false, code: "forbidden" };
  if (principal?.kind === "oidc" && !OIDC_LIMITS.envs.includes(env))
    return { ok: false, code: "unauthenticated" };
  const rule = AUTHZ[route][principal ? principal.kind : "none"];
  if (!rule.allow) return { ok: false, code: rule.code };
  if (rule.scope && !principal?.scopes?.includes(rule.scope))
    return { ok: false, code: "forbidden" };
  return { ok: true, reach: rule.reach };
}

const emailDomain = (e: string | undefined) =>
  e?.includes("@") ? e.slice(e.lastIndexOf("@") + 1).toLowerCase() : null;

/** The GitHub OIDC principal (4.4, Q1): staging only, own `rl-` test installs. */
export const OIDC_LIMITS = {
  envs: ["staging"] as readonly ProvisioningEnv[],
  slugPrefix: "rl-",
  testHooks: true,
} as const;

/** O's R4 limits (3.3): `rl-` slug, testHooks true, owner @STAGING_TEST_DOMAIN. */
export const oidcMayCreate = (
  b: { slug: string; testHooks?: boolean; ownerEmail?: string },
  stagingTestDomain: string,
) =>
  b.slug.startsWith(OIDC_LIMITS.slugPrefix) &&
  b.testHooks === true &&
  emailDomain(b.ownerEmail) === stagingTestDomain.toLowerCase();
export const oidcOwns = (i: { slug: string; testHooks: boolean }) =>
  i.slug.startsWith(OIDC_LIMITS.slugPrefix) && i.testHooks;

/** Protocol routes' rows (4.2): transport and consent, not API routes. */
export const PROTOCOL_AUTHZ = {
  "/mcp": {
    admin: "admin host 404",
    token: "yes; each tool uses its route's row",
    oidc: "staging only; each tool uses its route's O row",
    user: "401",
    none: "401",
  },
  "/oauth/authorize": {
    admin: "yes (session required)",
    token: "api host 404",
    oidc: "n/a",
    user: "403",
    none: "bounce page, then 302 to /auth/start",
  },
} as const satisfies Record<string, Record<AuthzColumn, string>>;

/**
 * Field rules for R4 per principal (3.3), enforced by checkCreateFields in
 * the policy step:
 * - `forbidden`: 403 forbidden if present.
 * - `server_set`: 403 forbidden if present; the server then sets it.
 * - `ignored`: accepted and dropped.
 * - `required`: missing is 400 invalid_input.
 * - `required_true`: missing is 400; anything but true is 403.
 * - `required_in_auth_domains`: required, and the email's domain must be in
 *   `auth.domains` (403).
 * - `required_staging_test_domain`: required, and the email must be
 *   `@<STAGING_TEST_DOMAIN>` (403).
 * - `{ staging, prod }`: the rule differs by environment.
 */
export type FieldRule =
  | "required"
  | "required_true"
  | "required_in_auth_domains"
  | "required_staging_test_domain"
  | "optional"
  | "forbidden"
  | "ignored"
  | "server_set";
export type EnvFieldRule =
  | FieldRule
  | Readonly<Record<ProvisioningEnv, FieldRule>>;
export const CREATE_FIELDS = [
  "ownerEmail",
  "tier",
  "auth",
  "version",
  "sendWelcome",
  "testHooks",
  "turnstile",
] as const;
export type CreateField = (typeof CREATE_FIELDS)[number];
export type CreatePrincipal = "admin" | "token" | "oidc" | "user";

export const CREATE_FIELD_RULES: Readonly<
  Record<CreateField, Record<CreatePrincipal, EnvFieldRule>>
> = {
  ownerEmail: {
    admin: "required",
    token: "required_in_auth_domains",
    oidc: "required_staging_test_domain",
    user: "server_set",
  },
  tier: {
    admin: "required",
    token: "required",
    oidc: "required",
    user: "server_set",
  },
  auth: {
    admin: "required",
    token: "required",
    oidc: "required",
    user: "server_set",
  },
  version: {
    admin: "optional",
    token: "optional",
    oidc: "optional",
    user: "forbidden",
  },
  sendWelcome: {
    admin: "optional",
    token: "forbidden",
    oidc: "forbidden",
    // Always true for self-serve.
    user: "server_set",
  },
  // Prod refuses TEST_DOMAIN in the API too, not only in wfp.ts.
  testHooks: {
    admin: { staging: "optional", prod: "forbidden" },
    token: "forbidden",
    oidc: "required_true",
    user: "forbidden",
  },
  // U's token is checked in its own step (turnstile_failed, 4.2).
  turnstile: {
    admin: "ignored",
    token: "ignored",
    oidc: "ignored",
    user: "required",
  },
};

/** The rule for one field, principal and environment. */
export function createFieldRule(
  field: CreateField,
  principal: CreatePrincipal,
  env: ProvisioningEnv,
): FieldRule {
  const r = CREATE_FIELD_RULES[field][principal];
  return typeof r === "string" ? r : r[env];
}

export type CreateFieldRefusal = {
  field: CreateField;
  code: "forbidden" | "invalid_input";
};

/**
 * The 3.3 field rules on a parsed R4 body, in the 4.2 order: any present
 * forbidden or server-set field first (403), then missing required fields
 * (400), then value rules (403). U's turnstile is left to its own step. O's
 * slug prefix is oidcMayCreate's. Null when the body passes.
 */
export function checkCreateFields(
  body: Readonly<Partial<Record<CreateField, unknown>>> & {
    auth?: { domains: readonly string[] };
  },
  principal: CreatePrincipal,
  env: ProvisioningEnv,
  stagingTestDomain: string,
): CreateFieldRefusal | null {
  const rules = CREATE_FIELDS.map(
    (f) => [f, createFieldRule(f, principal, env)] as const,
  );
  const has = (f: CreateField) => body[f] !== undefined;
  for (const [f, r] of rules)
    if ((r === "forbidden" || r === "server_set") && has(f))
      return { field: f, code: "forbidden" };
  for (const [f, r] of rules)
    if (r.startsWith("required") && !has(f) && f !== "turnstile")
      return { field: f, code: "invalid_input" };
  for (const [f, r] of rules) {
    const v = body[f];
    if (r === "required_true" && v !== true)
      return { field: f, code: "forbidden" };
    if (
      r === "required_in_auth_domains" &&
      !(body.auth?.domains ?? [])
        .map((d) => d.toLowerCase())
        .includes(emailDomain(v as string) ?? "")
    )
      return { field: f, code: "forbidden" };
    if (
      r === "required_staging_test_domain" &&
      emailDomain(v as string) !== stagingTestDomain.toLowerCase()
    )
      return { field: f, code: "forbidden" };
  }
  return null;
}

/**
 * Field rules for R11 per principal (3.4, 4.2): `skipDirectoryRevoke` is
 * admin session only; any other principal sending it is 403 forbidden. The
 * purge_install tool leaves it out of its input (9A.5), so on /mcp it is
 * -32602 before policy runs.
 */
export const PURGE_FIELDS = ["skipDirectoryRevoke"] as const;
export type PurgeField = (typeof PURGE_FIELDS)[number];
export const PURGE_FIELD_RULES: Readonly<
  Record<PurgeField, Record<CreatePrincipal, "optional" | "forbidden">>
> = {
  skipDirectoryRevoke: {
    admin: "optional",
    token: "forbidden",
    oidc: "forbidden",
    user: "forbidden",
  },
};

/** The R11 field rules on a parsed body. Null when the body passes. */
export function checkPurgeFields(
  body: Readonly<Partial<Record<PurgeField, unknown>>>,
  principal: CreatePrincipal,
): { field: PurgeField; code: "forbidden" } | null {
  for (const f of PURGE_FIELDS)
    if (
      PURGE_FIELD_RULES[f][principal] === "forbidden" &&
      body[f] !== undefined
    )
      return { field: f, code: "forbidden" };
  return null;
}

// TRANSITIONS (5.1): used by the API, re-checked by the provisioner. A =
// admin session or OIDC within its scope; T = agent token (4.1: A's rows
// except purging a soft-deleted install, and the admin-only R13 and R26 rows
// its authz row already refuses); U = self-serve owner; S = scheduler.
// `cleanup` is compensation inserted by R25 and the sweep, never checked here.
export type TransitionActor = "A" | "T" | "U" | "S";
export type Transition = {
  actors: readonly TransitionActor[];
  to: readonly InstallState[];
};
export type TransitionFrom = InstallState | "none";

const t = (actors: TransitionActor[], ...to: InstallState[]): Transition => ({
  actors,
  to,
});
// Beyond the 5.1 table, which lists state changes only: R13 release-lease
// (any non-deleted state, no change) and R26 redline_creds (active, no
// change). Without these rows both routes would always be invalid_state.
const lease = (s: InstallState) => ({ release_lease: t(["A"], s) });

export const TRANSITIONS: Readonly<
  Record<TransitionFrom, Partial<Record<JobKind, Transition>>>
> = {
  none: { create: t(["A", "T", "U"], "provisioning") },
  provisioning: { ...lease("provisioning") },
  failed: {
    retry: t(["A", "T"], "provisioning"),
    purge: t(["A", "T"], "deleted"),
    discard: t(["A", "T"], "deleted"),
    ...lease("failed"),
  },
  active: {
    upgrade: t(["A", "T"], "active"),
    rollback: t(["A", "T"], "active"),
    suspend: t(["A", "T"], "suspended"),
    delete: t(["A", "T", "U"], "deleting"),
    redline_creds: t(["A"], "active"),
    ...lease("active"),
  },
  suspended: {
    resume: t(["A", "T"], "active"),
    upgrade: t(["A", "T"], "suspended"),
    rollback: t(["A", "T"], "suspended"),
    delete: t(["A", "T"], "deleting"),
    ...lease("suspended"),
  },
  // Grace: restore goes back to active, or to suspended if it was. The
  // scheduler purges at purge_at unless suspended_at is set. A token may not
  // purge here (4.1): the API answers 403 forbidden with
  // details.needs admin_session (TOKEN_DELETING_PURGE), not invalid_state.
  deleting: {
    restore: t(["A", "T", "U"], "active", "suspended"),
    purge: t(["A", "S"], "deleted"),
    ...lease("deleting"),
  },
  deleted: {},
};

/**
 * R11 by a token on a `deleting` install (4.1, 4.2): 403 forbidden with these
 * details instead of 409 invalid_state, on /v1 and /mcp alike.
 */
export const TOKEN_DELETING_PURGE = {
  code: "forbidden",
  details: (adminOrigin: string, installId: string) => ({
    needs: "admin_session" as const,
    url: `${adminOrigin}/installs/${installId}`,
  }),
} as const;

/** Anything not in TRANSITIONS is 409 invalid_state. */
export function canTransition(
  from: TransitionFrom,
  kind: JobKind,
  actor: TransitionActor,
): boolean {
  return TRANSITIONS[from][kind]?.actors.includes(actor) ?? false;
}
