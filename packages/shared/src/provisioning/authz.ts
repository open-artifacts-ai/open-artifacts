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
      { ...all, note: "3.3 field rules" },
      tok("installs:write", "3.3 field rules"),
      { ...own, note: "rl- slug, testHooks: true" },
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
        "failed creates only; deleting: 403 forbidden with details.needs admin_session",
      ),
      own,
      no,
    ),
    R12: opRow,
    R13: {
      ...adminOnly,
      admin: { ...all, note: "force needs a live lease, audited" },
    },
    R14: row(all, tok("installs:read"), own, own),
    R15: row(all, tok("installs:read"), own, {
      ...own,
      note: "sealed only to the creating OIDC caller",
    }),
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

/** The GitHub OIDC principal (4.4, Q1): staging only, own `rl-` test installs. */
export const OIDC_LIMITS = {
  envs: ["staging"] as readonly ProvisioningEnv[],
  slugPrefix: "rl-",
  testHooks: true,
} as const;

export const oidcMayCreate = (b: { slug: string; testHooks?: boolean }) =>
  b.slug.startsWith(OIDC_LIMITS.slugPrefix) && b.testHooks === true;
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

/** Field rules for R4 per principal (3.3). */
export type FieldRule =
  | "required"
  | "optional"
  | "forbidden"
  | "ignored"
  | "server_set";
export const CREATE_FIELD_RULES: Readonly<
  Record<
    | "ownerEmail"
    | "tier"
    | "auth"
    | "version"
    | "sendWelcome"
    | "testHooks"
    | "turnstile",
    Record<"admin" | "token" | "oidc" | "user", FieldRule>
  >
> = {
  ownerEmail: {
    admin: "required",
    token: "required",
    oidc: "required",
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
    user: "forbidden",
  },
  // Admin: forbidden in prod, allowed on staging. OIDC: required true.
  testHooks: {
    admin: "optional",
    token: "forbidden",
    oidc: "required",
    user: "forbidden",
  },
  turnstile: {
    admin: "ignored",
    token: "ignored",
    oidc: "ignored",
    user: "required",
  },
};

// TRANSITIONS (5.1): used by the API, re-checked by the provisioner. A =
// admin, agent token or OIDC within its scope; U = self-serve owner; S =
// scheduler. `cleanup` is compensation inserted by R25 and the sweep, never
// checked here.
export type TransitionActor = "A" | "U" | "S";
export type Transition = {
  actors: readonly TransitionActor[];
  to: readonly InstallState[];
};
export type TransitionFrom = InstallState | "none";

const t = (actors: TransitionActor[], ...to: InstallState[]): Transition => ({
  actors,
  to,
});
const lease = (s: InstallState) => ({ release_lease: t(["A"], s) });

export const TRANSITIONS: Readonly<
  Record<TransitionFrom, Partial<Record<JobKind, Transition>>>
> = {
  none: { create: t(["A", "U"], "provisioning") },
  provisioning: { ...lease("provisioning") },
  failed: {
    retry: t(["A"], "provisioning"),
    purge: t(["A"], "deleted"),
    discard: t(["A"], "deleted"),
    ...lease("failed"),
  },
  active: {
    upgrade: t(["A"], "active"),
    rollback: t(["A"], "active"),
    suspend: t(["A"], "suspended"),
    delete: t(["A", "U"], "deleting"),
    redline_creds: t(["A"], "active"),
    ...lease("active"),
  },
  suspended: {
    resume: t(["A"], "active"),
    upgrade: t(["A"], "suspended"),
    rollback: t(["A"], "suspended"),
    delete: t(["A"], "deleting"),
    ...lease("suspended"),
  },
  // Grace: restore goes back to active, or to suspended if it was. The
  // scheduler purges at purge_at unless suspended_at is set.
  deleting: {
    restore: t(["A", "U"], "active", "suspended"),
    purge: t(["A", "S"], "deleted"),
    ...lease("deleting"),
  },
  deleted: {},
};

/** Anything not in TRANSITIONS is 409 invalid_state. */
export function canTransition(
  from: TransitionFrom,
  kind: JobKind,
  actor: TransitionActor,
): boolean {
  return TRANSITIONS[from][kind]?.actors.includes(actor) ?? false;
}
