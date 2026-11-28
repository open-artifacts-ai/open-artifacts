import type {
  InstallState,
  JobKind,
  PrincipalKind,
  ProvisioningEnv,
  TokenKind,
  TokenScope,
} from "./enums.js";
import { INSTALL_ID_RE } from "./id-patterns.js";
import type { RouteId } from "./routes.js";

// The authz table (design v7 4.2): one data table, one enforcement function.
// An MCP tool has no row of its own: it uses its route's row.

export const AUTHZ_COLUMNS = [
  "admin",
  "token",
  "oidc",
  "user",
  "test-admin",
  "none",
] as const;
export type AuthzColumn = (typeof AUTHZ_COLUMNS)[number];

/**
 * allow: `reach` "all" or "own" (the handler scopes to the principal's
 * installs: O own `rl-` test installs, U its own; outside it is 404), and for
 * tokens the one `scope` the row needs and, where set, the one `tokenKind`
 * that may use it (anything else, unset included, is forbidden). `note` is the
 * business rule the handler adds after authz.
 */
export type AuthzRule =
  | { allow: false; code: "unauthenticated" | "forbidden" }
  | {
      allow: true;
      reach: "all" | "own";
      scope?: TokenScope;
      tokenKind?: TokenKind;
      note?: string;
    };

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
  // Staging's test admin (#1053): refused unless its row says otherwise.
  testAdmin: AuthzRule = no,
): Record<AuthzColumn, AuthzRule> => ({
  admin,
  token,
  oidc,
  user,
  "test-admin": testAdmin,
  none: noAuth,
});
/** A row with the test admin's own rule (#1053: reads, create, upgrade). */
const withTestAdmin = (
  r: Record<AuthzColumn, AuthzRule>,
  testAdmin: AuthzRule,
): Record<AuthzColumn, AuthzRule> => ({ ...r, "test-admin": testAdmin });
/** The test admin's reach: the `rl-` test installs, as O's (oidcOwns). */
const taOwn = { ...own, note: "rl- and testHooks (oidcOwns)" } as const;

const opRow = row(all, tok("installs:write"), own, no);
const adminOnly = row(all, no, no, no);
/**
 * Admin MCP only (#1008): an OAuth grant with installs:write, which /mcp alone
 * authenticates (authenticate() answers it 401 on /v1). Not the admin session,
 * not an `oat_` token. It stays this one rule: tested, and on these routes only.
 */
const adminMcpOnly = row(
  no,
  { allow: true, reach: "all", scope: "installs:write", tokenKind: "oauth" },
  no,
  no,
);

export const AUTHZ: Readonly<Record<RouteId, Record<AuthzColumn, AuthzRule>>> =
  {
    R1: row(all, all, all, all, unauth, all),
    R2: row(all, tok("installs:read"), own, own, unauth, taOwn),
    R3: row(
      all,
      tok("installs:read", "ownerEmail needs installs:pii"),
      own,
      own,
      unauth,
      taOwn,
    ),
    R4: row(
      { ...all, note: "3.3 field rules (checkCreateFields)" },
      tok("installs:write", "3.3 field rules (checkCreateFields)"),
      {
        ...own,
        note: "rl- slug, testHooks: true, @STAGING_TEST_DOMAIN owner (checkCreateFields)",
      },
      { ...own, note: "self-serve policy (4.2)" },
      unauth,
      { ...taOwn, note: "O's field rules (checkCreateFields)" },
    ),
    R5: withTestAdmin(opRow, taOwn),
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
    R14: row(all, tok("installs:read"), own, own, unauth, taOwn),
    R15: row(
      all,
      tok("installs:read"),
      { ...own, note: "sealed only to the creating OIDC caller, once" },
      own,
      unauth,
      taOwn,
    ),
    R16: row(all, tok("installs:read"), all, no, unauth, all),
    R17: row(
      all,
      tok("audit:read", "email detail fields need installs:pii"),
      { ...own, note: "own actor rows" },
      no,
      unauth,
      { ...own, note: "own actor rows" },
    ),
    R18: row(
      all,
      tok("installs:read"),
      all,
      { ...all, note: "RL_PV_SLUG_IP" },
      unauth,
      all,
    ),
    R19: adminOnly,
    R20: adminOnly,
    R21: adminOnly,
    // Browser hosts; a bearer there is 401 (host policy).
    R22: row(all, all, all, all, all, all),
    R23: row(all, all, all, all, all, all),
    R24: row(all, unauth, unauth, all, unauth, all),
    R25: { ...adminOnly, admin: { ...all, note: "typed slug, audited" } },
    R26: row(no, no, { ...own, note: "staging, rl- and testHooks" }, no),
    R27: row(all, tok("installs:read"), no, no),
    // Only the pinned staging-test-admin.yml caller (authorize, oidcWorkflow).
    R28: row(no, no, { ...own, note: "staging-test-admin.yml only" }, no),
    // #1008: each flip is one person's yes for that install and env.
    R29: adminMcpOnly,
    R30: adminMcpOnly,
  };

export type AuthzPrincipal = {
  kind: PrincipalKind;
  scopes?: readonly TokenScope[];
  /** Tokens: "oat" or "oauth", from the row (AuthzRule.tokenKind). */
  tokenKind?: TokenKind;
  /**
   * OIDC only: which pinned workflow minted the JWT. "test-admin" may call
   * R28 and nothing else; any other OIDC caller never calls R28 (#1053).
   * "test-member" may call only TEST_MEMBER.routes, on TEST_MEMBER.slug.
   * "test-install" uses `testInstallMode` ("create" by default; "delete" for
   * a signed later cleanup run, which never reaches R4 or R26).
   */
  oidcWorkflow?: OidcWorkflow;
  testInstallMode?: "create" | "delete";
} | null;
/** The pinned workflows an OIDC JWT may come from (authorize). */
export type OidcWorkflow =
  | "redline"
  | "test-admin"
  | "test-member"
  | "test-install";

/**
 * The staging test member's workflow (staging-test-member.yml): R26 on the
 * one install `rl-agents` (mint or revoke), R15 to read that job's sealed
 * result, and R2 to find the install's id by its slug. R3 and R5 read
 * rl-agents and upgrade it to a release, so it follows staging's release
 * (the fleet skips installs with test hooks; cloud #264). Every other route
 * is 403, and reach is that one slug (model.ts reachSql and inReach; the
 * provisioner's checkOidcScope holds its jobs to it too).
 */
export const TEST_MEMBER = {
  slug: "rl-agents",
  routes: ["R2", "R3", "R5", "R15", "R26"] as readonly RouteId[],
  /** Suffix of its actorKey and rateKey (`oidc:<repository_id>:test-member`). */
  actorSuffix: ":test-member",
} as const;
/** The test member's reach: exactly `rl-agents`, with test hooks. */
export const testMemberOwns = (i: { slug: string; testHooks: boolean }) =>
  i.slug === TEST_MEMBER.slug && i.testHooks === true;
/**
 * A separate pinned staging workflow (staging-test-install.yml) uses the same
 * OIDC mechanism to manage disposable test installs. Its jobs never have reach
 * over rl-agents or over another fixture in the same repository.
 *
 * Ownership is authenticated independently of any caller-supplied target ID:
 * - On create (`mode: "create"`), `actorKey` binds GitHub-signed `repository_id`
 *   and `run_id` plus `ownerKeyId = sha256(ownerPublicKey)` (raw 32-byte
 *   Ed25519 public key from `ownerKeyHeader`). Every follow-up call during the
 *   create run (R3, R15, R26, R9, R11) matches `install.createdBy === actorKey`.
 * - On later cleanup (`mode: "delete"`), the caller proves possession of the
 *   fixture's Ed25519 private key via a short-lived signature in
 *   `deleteProofHeader` over `(domain, repositoryId, installId, expiresAt)`.
 *   Verified cleanup callers may call only `deleteRoutes` (never R4 or R26)
 *   and match only installs created by that same `(repositoryId, ownerKeyId)`
 *   and exact signed `installId`.
 */
export const TEST_INSTALL = {
  slugPrefix: "t-",
  actorSuffix: ":test-install",
  deleteActorSuffix: ":test-install-delete",
  ownerKeyHeader: "x-oa-fixture-owner-key",
  deleteProofHeader: "x-oa-fixture-delete-proof",
  deleteProofDomain: "oa-fixture-delete-v1",
  deleteProofMaxTtlMs: 30 * 60_000,
  routes: ["R3", "R4", "R9", "R11", "R15", "R26"] as readonly RouteId[],
  deleteRoutes: ["R3", "R9", "R11", "R15"] as readonly RouteId[],
} as const;

const NUMERIC_ID_RE = /^\d{1,32}$/;
const FIXTURE_KEY_B64U_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const FIXTURE_SIG_B64U_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const FIXTURE_CREATE_KEY_RE =
  /^oidc:(\d{1,32}):test-install:(\d{1,32}):([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const FIXTURE_DELETE_KEY_RE =
  /^oidc:(\d{1,32}):test-install-delete:([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]):(i[a-z0-9]{11})$/;

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isFixtureOwnerPublicKey = (v: unknown): v is string =>
  typeof v === "string" && FIXTURE_KEY_B64U_RE.test(v);

/** Base64url SHA-256 fingerprint of a raw 32-byte Ed25519 owner public key. */
export async function fixtureOwnerKeyId(
  ownerPublicKey: string,
): Promise<string> {
  if (!isFixtureOwnerPublicKey(ownerPublicKey))
    throw new Error("invalid fixture owner public key");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", b64uToBytes(ownerPublicKey)),
  );
  return bytesToB64u(digest);
}

export function fixtureDeleteProofPayload(input: {
  repositoryId: string;
  installId: string;
  expiresAt: number;
}): string {
  if (!NUMERIC_ID_RE.test(input.repositoryId))
    throw new Error("invalid repositoryId");
  if (!INSTALL_ID_RE.test(input.installId))
    throw new Error("invalid installId");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0)
    throw new Error("invalid expiresAt");
  return `${TEST_INSTALL.deleteProofDomain}\n${input.repositoryId}\n${input.installId}\n${input.expiresAt}`;
}

export async function signFixtureDeleteProof(
  privateKey: CryptoKey,
  input: { repositoryId: string; installId: string; expiresAt: number },
): Promise<string> {
  const payload = new TextEncoder().encode(fixtureDeleteProofPayload(input));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, payload),
  );
  return `${input.installId}.${input.expiresAt}.${bytesToB64u(sig)}`;
}

export async function verifyFixtureDeleteProof(input: {
  ownerPublicKey: string;
  proof: string;
  repositoryId: string;
  now?: number;
}): Promise<{
  installId: string;
  expiresAt: number;
  ownerKeyId: string;
} | null> {
  if (
    !isFixtureOwnerPublicKey(input.ownerPublicKey) ||
    !NUMERIC_ID_RE.test(input.repositoryId) ||
    typeof input.proof !== "string"
  )
    return null;
  const parts = input.proof.split(".");
  if (parts.length !== 3) return null;
  const [installId, rawExp, sigB64] = parts as [string, string, string];
  if (
    !INSTALL_ID_RE.test(installId) ||
    !/^\d{1,16}$/.test(rawExp) ||
    !FIXTURE_SIG_B64U_RE.test(sigB64)
  )
    return null;
  const expiresAt = Number(rawExp);
  const now = input.now ?? Date.now();
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now ||
    expiresAt - now > TEST_INSTALL.deleteProofMaxTtlMs
  )
    return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64uToBytes(input.ownerPublicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const payload = new TextEncoder().encode(
      fixtureDeleteProofPayload({
        repositoryId: input.repositoryId,
        installId,
        expiresAt,
      }),
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64uToBytes(sigB64),
      payload,
    );
    if (!ok) return null;
    return {
      installId,
      expiresAt,
      ownerKeyId: await fixtureOwnerKeyId(input.ownerPublicKey),
    };
  } catch {
    return null;
  }
}

export function testInstallActorKey(
  repositoryId: string,
  runId: string,
  ownerKeyId: string,
): string {
  if (
    !NUMERIC_ID_RE.test(repositoryId) ||
    !NUMERIC_ID_RE.test(runId) ||
    !FIXTURE_KEY_B64U_RE.test(ownerKeyId)
  )
    throw new Error("invalid fixture create actor key parts");
  return `oidc:${repositoryId}${TEST_INSTALL.actorSuffix}:${runId}:${ownerKeyId}`;
}

export function testInstallDeleteActorKey(
  repositoryId: string,
  ownerKeyId: string,
  installId: string,
): string {
  if (
    !NUMERIC_ID_RE.test(repositoryId) ||
    !FIXTURE_KEY_B64U_RE.test(ownerKeyId) ||
    !INSTALL_ID_RE.test(installId)
  )
    throw new Error("invalid fixture delete actor key parts");
  return `oidc:${repositoryId}${TEST_INSTALL.deleteActorSuffix}:${ownerKeyId}:${installId}`;
}

export type TestInstallActorScope =
  | {
      mode: "create";
      actorKey: string;
      repositoryId: string;
      runId: string;
      ownerKeyId: string;
    }
  | {
      mode: "delete";
      actorKey: string;
      repositoryId: string;
      ownerKeyId: string;
      installId: string;
    };

export function parseTestInstallActorKey(
  actorKey: string,
): TestInstallActorScope | null {
  const c = FIXTURE_CREATE_KEY_RE.exec(actorKey);
  if (c) {
    const [, repositoryId, runId, ownerKeyId] = c as unknown as [
      string,
      string,
      string,
      string,
    ];
    return { mode: "create", actorKey, repositoryId, runId, ownerKeyId };
  }
  const d = FIXTURE_DELETE_KEY_RE.exec(actorKey);
  if (d) {
    const [, repositoryId, ownerKeyId, installId] = d as unknown as [
      string,
      string,
      string,
      string,
    ];
    return { mode: "delete", actorKey, repositoryId, ownerKeyId, installId };
  }
  return null;
}

export function testInstallOwns(
  i: {
    id: string;
    slug: string;
    testHooks: boolean;
    createdBy?: string | null;
  },
  scope: TestInstallActorScope,
): boolean {
  if (
    !i.slug.startsWith(TEST_INSTALL.slugPrefix) ||
    i.testHooks !== true ||
    typeof i.createdBy !== "string"
  )
    return false;
  const created = parseTestInstallActorKey(i.createdBy);
  if (created?.mode !== "create") return false;
  if (scope.mode === "create") return i.createdBy === scope.actorKey;
  return (
    created.repositoryId === scope.repositoryId &&
    created.ownerKeyId === scope.ownerKeyId &&
    i.id === scope.installId
  );
}

export type RedlineCredsRefusal = {
  field: "hookKeyOnly" | "revoke";
  code: "forbidden";
};
/**
 * R26 policy per OIDC workflow: disposable fixtures (`test-install`, create
 * mode only) may only rotate and seal TEST_HOOK_KEY (`hookKeyOnly: true`),
 * never mint an admin PAT or run redline revoke. Cleanup callers and other
 * workflows cannot pass `hookKeyOnly: true`.
 */
export function checkRedlineCreds(
  body: { revoke?: boolean; hookKeyOnly?: boolean },
  workflow?: OidcWorkflow,
  testInstallMode?: "create" | "delete",
): RedlineCredsRefusal | null {
  if (workflow === "test-install") {
    if (testInstallMode === "delete")
      return { field: "hookKeyOnly", code: "forbidden" };
    if (body.revoke === true) return { field: "revoke", code: "forbidden" };
    if (body.hookKeyOnly !== true)
      return { field: "hookKeyOnly", code: "forbidden" };
    return null;
  }
  if (body.hookKeyOnly === true)
    return { field: "hookKeyOnly", code: "forbidden" };
  return null;
}

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
  if (
    (principal?.kind === "oidc" || principal?.kind === "test-admin") &&
    !OIDC_LIMITS.envs.includes(env)
  )
    return { ok: false, code: "unauthenticated" };
  if (principal?.kind === "oidc") {
    const testAdmin = principal.oidcWorkflow === "test-admin";
    if (testAdmin !== (route === "R28"))
      return { ok: false, code: "forbidden" };
    if (
      principal.oidcWorkflow === "test-member" &&
      !TEST_MEMBER.routes.includes(route)
    )
      return { ok: false, code: "forbidden" };
    if (principal.oidcWorkflow === "test-install") {
      const allowed =
        principal.testInstallMode === "delete"
          ? TEST_INSTALL.deleteRoutes
          : TEST_INSTALL.routes;
      if (!allowed.includes(route)) return { ok: false, code: "forbidden" };
    }
  }
  const rule = AUTHZ[route][principal ? principal.kind : "none"];
  if (!rule.allow) return { ok: false, code: rule.code };
  if (rule.scope && !principal?.scopes?.includes(rule.scope))
    return { ok: false, code: "forbidden" };
  if (rule.tokenKind && principal?.tokenKind !== rule.tokenKind)
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

/**
 * O's own R4 limits (3.3): `rl-` slug, testHooks true, owner
 * @STAGING_TEST_DOMAIN. checkCreateFields enforces the same (and staging
 * only) with every other field rule, so the policy step needs only that call.
 */
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
    "test-admin": "401 (an admin-host session, no bearer)",
    none: "401",
  },
  "/oauth/authorize": {
    admin: "yes (session required)",
    token: "api host 404",
    oidc: "n/a",
    user: "403",
    "test-admin": "403 (no OAuth grant: a grant is a token)",
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
 *   `auth.domains` (403), unless `auth.domains` is empty (owner and invites
 *   only).
 * - `required_staging_test_domain`: required, and the email must be
 *   `@<STAGING_TEST_DOMAIN>` (403).
 * - `required_test_prefix`: required, and must start `rl-` (403).
 * - `any`: no field rule (the body schema and slug rules still apply).
 * - `{ staging, prod }`: the rule differs by environment.
 */
export type FieldRule =
  | "required"
  | "required_true"
  | "required_in_auth_domains"
  | "required_staging_test_domain"
  | "required_test_prefix"
  | "any"
  | "optional"
  | "forbidden"
  | "ignored"
  | "server_set";
export type EnvFieldRule =
  | FieldRule
  | Readonly<Record<ProvisioningEnv, FieldRule>>;
export const CREATE_FIELDS = [
  "slug",
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
/**
 * Whose field rules a principal kind follows: the test admin (#1053) takes
 * O's (rl- slug, testHooks, a test-domain owner); system none.
 */
export const fieldRulesOf = (kind: PrincipalKind): CreatePrincipal | null =>
  kind === "system" ? null : kind === "test-admin" ? "oidc" : kind;

export const CREATE_FIELD_RULES: Readonly<
  Record<CreateField, Record<CreatePrincipal, EnvFieldRule>>
> = {
  // O squats nothing: `rl-` only, and nothing at all outside staging (4.4).
  slug: {
    admin: "any",
    token: "any",
    oidc: { staging: "required_test_prefix", prod: "forbidden" },
    user: "any",
  },
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
    oidc: { staging: "required_true", prod: "forbidden" },
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
 * (400), then value rules (403). U's turnstile is left to its own step. O
 * is held to `rl-` slugs on staging and refused on prod here too, so this one
 * call enforces every 3.3 rule. auth.domainCodes adds one value rule for every
 * principal: code sign-in only admits auth.domains, so the owner's domain must
 * be one (#1088). Null when the body passes.
 */
export function checkCreateFields(
  body: Readonly<Partial<Record<CreateField, unknown>>> & {
    auth?: {
      domains: readonly string[];
      providers?: readonly string[];
      domainCodes?: boolean;
    };
  },
  principal: CreatePrincipal,
  env: ProvisioningEnv,
  stagingTestDomain: string,
  workflow?: OidcWorkflow,
): CreateFieldRefusal | null {
  const fixture = principal === "oidc" && workflow === "test-install";
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
  if (
    fixture &&
    (body.auth?.domainCodes !== true ||
      body.auth.providers?.length !== 1 ||
      body.auth.providers[0] !== "email" ||
      body.auth.domains.length !== 1 ||
      body.auth.domains[0]?.toLowerCase() !== stagingTestDomain.toLowerCase())
  )
    return { field: "auth", code: "forbidden" };
  for (const [f, r] of rules) {
    const v = body[f];
    if (r === "required_true" && v !== true)
      return { field: f, code: "forbidden" };
    if (
      r === "required_test_prefix" &&
      !(
        typeof v === "string" &&
        v.startsWith(fixture ? TEST_INSTALL.slugPrefix : OIDC_LIMITS.slugPrefix)
      )
    )
      return { field: f, code: "forbidden" };
    if (
      r === "required_in_auth_domains" &&
      // No domains (Google, owner and invites only): the owner is the one
      // admitted address, so there is no domain to hold them to.
      (body.auth?.domains?.length ?? 0) > 0 &&
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
  if (
    body.auth?.domainCodes === true &&
    !body.auth.domains
      .map((d) => d.toLowerCase())
      .includes(emailDomain(body.ownerEmail as string) ?? "")
  )
    return { field: "ownerEmail", code: "forbidden" };
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
    // S: the scheduler's fleet rollout (#955); never from suspended.
    upgrade: t(["A", "T", "S"], "active"),
    rollback: t(["A", "T"], "active"),
    suspend: t(["A", "T"], "suspended"),
    delete: t(["A", "T", "U"], "deleting"),
    redline_creds: t(["A"], "active"),
    // R29, R30 (#1008): no state change. T: an OAuth grant, by their authz
    // rows; the provisioner's recheck reads the grant again.
    update: t(["T"], "active"),
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
