// WfpProvisioner: one isolated install = one Workers for Platforms user Worker
// (or an account script, for tests and the dispatch Worker itself) with its
// own D1, R2, KV and secrets, named by install id and env.
//
// create(), each step idempotent by checking first:
//   pre-flight (no Cloudflare call): prod lock, env, target, domains, owner
//     email, bundle variant, Turnstile inputs, the signed release record,
//     the signed release floor, every release file against the record,
//     secrets, metadata dry run
//   token check -> resolve platform D1, HOSTS, registry and its directory
//   copy by name
//   -> floor_seq (the D1 cache of the floor: refuse below it, raise to it)
//   -> Turnstile widget (GET, codes on only)
//   -> platform row (creating, rl_ns, hosts, audit; one batch) -> D1 -> R2
//   -> KV (ids resolved by name and checked against the row) -> server
//   migrations (re-read and re-checked) -> upload (modules, assets and
//   template re-read and re-checked; secret_text bindings, DO tag probe)
//   -> subdomain off (account only) -> broker keypair (flag) -> HOSTS
//   -> /healthz -> owner PAT (0600) -> MCP selftest -> active.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { newId, newPat } from "@oa/shared";
import {
  type AssetFile,
  assetHash,
  type Cf,
  CfError,
  type Module,
  type Target,
} from "./cf.js";
import {
  ALLOW_ACCOUNT_TARGET,
  FLOOR_MIN_SEQ,
  PROD_UNLOCKED,
  RELEASE_PUBKEY,
  RELEASE_PUBKEY_PLACEHOLDER,
} from "./internal/gates.js";
import {
  assertSafeMigrations,
  assertUniqueBindings,
  epochBumpSql,
  googleNewlyEnabled,
  KNOWN_SECRETS,
  parseTemplate,
  scriptSubdomainSettings,
  type Template,
  type UploadMetadata,
  userWorkerMetadata,
} from "./metadata.js";
import {
  assertOwnResource,
  type Env,
  ForeignResource,
  hosts,
  isInstallId,
  isPlatformPrincipalId,
  names,
  newInstallId,
  ownerEmailOf,
  platformNames,
  type RegistryEntry,
  registryDomains,
  registryEntry,
  registryKey,
} from "./names.js";
import {
  canonicalJson,
  type DirectoryRevoke,
  type InstallRow,
  type InstallState,
  inputsHash,
  PlatformDb,
  RL_BASE,
  type StoredVersion,
} from "./platform.js";
import {
  ASSET_LIMITS,
  assertAssetPath,
  type BundleVariant,
  bundleSha256,
  compareVersions,
  type FloorRecord,
  floorRefusal,
  isReleaseVersion,
  MIGRATION_RE,
  migrationsSha256,
  openFloor,
  openReleaseRecord,
  type ReleaseAssetEntry,
  type ReleaseFile,
  type ReleaseReader,
  type ReleaseRecord,
  sha256Hex,
  TEST_HOOKS_DEFINE,
} from "./release.js";
import type {
  CreateInput,
  Install,
  InstallId,
  UpgradeResult,
} from "./types.js";
import { REVOKE_MIN_VERSION } from "./versions.js";

/** Option names that look like a gate: refused, so no config or spread can try one. */
const GATE_LIKE =
  /^(?:__testOnly|prodRecordWriter$|PROD_UNLOCKED$|ALLOW_ACCOUNT_TARGET$|RELEASE_PUBKEY|FLOOR_MIN_SEQ$)/;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** Template vars that would change auth behind the provisioner's back. */
const TEMPLATE_VARS_REFUSED = [
  "AUTH_PROVIDERS",
  "EMAIL_CODE_DOMAIN",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET",
];

/** The dispatch namespace of each env (live M1 target). */
export const NAMESPACES: Readonly<Record<Env, string>> = Object.freeze({
  staging: "oa-staging",
  prod: "oa-prod",
});

/** The tenant domain pair of each env (user decision, 2026-10-21). */
export const HOSTED_DOMAINS: Readonly<
  Record<Env, Readonly<{ app: string; content: string }>>
> = Object.freeze({
  staging: Object.freeze({
    app: "open-artifacts-staging.app",
    content: "open-artifacts-staging.page",
  }),
  prod: Object.freeze({
    app: "open-artifacts.app",
    content: "open-artifacts.page",
  }),
});

/**
 * The env's broker Google sign-in client (public). Staging's equals
 * apps/auth-broker/wrangler.jsonc's env.staging.vars.GOOGLE_CLIENT_ID; prod's
 * is the client in project open-artifacts-prod, which the prod deploy fills
 * into the broker's {{GOOGLE_CLIENT_ID_PROD}} (tests pin both). null: that env
 * has no broker client yet.
 */
export const BROKER_GOOGLE_CLIENT_ID: Readonly<Record<Env, string | null>> =
  Object.freeze({
    staging:
      "1032390278908-nmf0n63n51u57dtvanu7bphes1lpi6pk.apps.googleusercontent.com",
    prod: "206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com",
  });

/** The platform HOSTS KV namespace title (host -> install id). */
export const hostsKvTitle = (env: Env): string => platformNames(env).hosts;

export interface WfpCreateInput extends CreateInput {
  bundle: BundleVariant;
  version: string;
}

export interface WfpOptions {
  cf: Cf;
  env: Env;
  /** Live envs use { kind: "namespace", ns: NAMESPACES[env] }. */
  target: Target;
  /** Must equal HOSTED_DOMAINS[env]. */
  domains: { app: string; content: string };
  /** The release's signed record and files (R2 in production); never the checkout. */
  release: ReleaseReader;
  /**
   * The env's one Turnstile widget (sitekey and secret from the keychain item
   * oa-hosted-<env>-turnstile). Required when codes are on.
   */
  turnstile?: { sitekey: string; secret: string };
  /**
   * Where the owner PAT and a test-hook key are saved (0600). Required unless
   * ciOwnerToken is set; with ciOwnerToken and no patDir (the provisioner
   * Worker) a test-hook key is never written (redline_creds rotates it).
   */
  patDir?: string;
  /**
   * CI (the oa:hosted CLI's --ci-owner-token, label ci-<run id>) and the
   * hosted provisioner (label ss-<signup ULID>): create, upgrade, rollback
   * and updateVars mint an owner PAT labelled `label` into the install's D1
   * under the operation's lease, hold it in memory for the selftest and
   * revoke it before the lease is released. No PAT file is read or written;
   * ciTokenSweep revokes what a crashed run left.
   */
  ciOwnerToken?: { label: string };
  /** Broker keypair (P2); off until the broker exists. */
  brokerEnabled?: boolean;
  /** For /healthz and the MCP selftest. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  healthTimeoutMs?: number;
  /** Require /healthz to report installId (Task 6b, Backend). */
  requireInstallId?: boolean;
  /**
   * The longest a Cloudflare token may run before its end date, in days
   * (1 to PROVISIONER_MAX_TOKEN_DAYS). The CLI keeps DEFAULT_MAX_TOKEN_DAYS;
   * the hosted provisioner passes PROVISIONER_MAX_TOKEN_DAYS (design v7 Q2).
   */
  maxTokenDays?: number;
  /**
   * Called as create, upgrade and rollback reach each WFP_STEPS step, so the
   * Workflow can record it (design v7 5.2). Awaited; a throw fails the
   * operation. Not built yet (W2): passing it is refused.
   */
  onStep?: (step: WfpStep) => void | Promise<void>;
  /**
   * Keep the sign-in registry copy `disabled: true` on every rewrite
   * (upgrade, rollback, updateVars of a suspended or deleting install;
   * design v7 5.4). The directory copy is never disabled. Not built yet
   * (W2): `true` is refused, so a suspended install is never re-enabled.
   */
  registryDisabled?: boolean;
}

/**
 * The job steps provision reports through onStep, in create order (design
 * v7 3.2 JOB_STEPS): upgrade and rollback report upload, verify_clean and
 * health only.
 */
export const WFP_STEPS = Object.freeze([
  "upload",
  "verify_clean",
  "health",
  "route",
  "enable_signin",
  "active",
] as const);
export type WfpStep = (typeof WFP_STEPS)[number];

/** The CLI's cap on a Cloudflare token's end date, in days. */
export const DEFAULT_MAX_TOKEN_DAYS = 30;
/** The hosted provisioner's cap: an end date at most 400 days out, required (design v7 Q2). */
export const PROVISIONER_MAX_TOKEN_DAYS = 400;

/**
 * Every job error code (design v7 3.5, `JobErrorCode`): a ProvisionRefused
 * carries one where it is thrown, and classification reads that property,
 * never the message.
 */
export const PROVISION_ERROR_CODES = Object.freeze([
  "release_not_published",
  "release_unverified",
  "downgrade_refused",
  "prod_dirty",
  "invalid_state",
  "slug_taken",
  "lease_held",
  "revoke_pending",
  "token_invalid",
  "upgrade_rolled_back",
  "upgrade_incomplete",
  "canceled",
  "cf_error",
  "internal",
] as const);
export type ProvisionErrorCode = (typeof PROVISION_ERROR_CODES)[number];

/** The codes a ProvisionRetry carries: a rerun may succeed (bounded backoff). */
export const PROVISION_RETRY_CODES = Object.freeze([
  "lease_held",
  "revoke_pending",
  "token_invalid",
] as const);
export type ProvisionRetryCode = (typeof PROVISION_RETRY_CODES)[number];

/** Every job kind (design v7 3.2 `JobKindSchema`). */
export const PROVISION_JOB_KINDS = Object.freeze([
  "create",
  "retry",
  "upgrade",
  "rollback",
  "suspend",
  "resume",
  "delete",
  "restore",
  "purge",
  "discard",
  "release_lease",
  "cleanup",
  "redline_creds",
] as const);
export type ProvisionJobKind = (typeof PROVISION_JOB_KINDS)[number];

/**
 * What each job kind does with a token within REFUSE_TOKEN_DAYS of its end
 * date (design v7 5.7): forward changes refuse, recovery goes on with a
 * WARNING note. Passed to verifyToken and the operations' nearExpiry.
 */
export const NEAR_EXPIRY_MODE: Readonly<
  Record<ProvisionJobKind, "refuse" | "warn">
> = Object.freeze({
  create: "refuse",
  retry: "refuse",
  upgrade: "refuse",
  resume: "refuse",
  restore: "refuse",
  redline_creds: "refuse",
  suspend: "warn",
  delete: "warn",
  purge: "warn",
  discard: "warn",
  release_lease: "warn",
  rollback: "warn",
  cleanup: "warn",
});

/** The platform D1 as a Worker binding sees it (the subset settleFailed uses). */
export interface SettleDb {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}

/**
 * Settles a failed job (design v7 3.6), shared by every fail step, cancel
 * and the scheduler sweep: `jobs` to failed with `code` (never over a stored
 * code), `signups.status = failed`, and `signup_accounts` freed for a
 * self-serve install that was never created. One D1 batch on `db` (the
 * platform D1 binding). W3 builds the body; until then it throws.
 */
export async function settleFailed(
  db: SettleDb,
  jobId: string,
  code: ProvisionErrorCode,
): Promise<void> {
  void db;
  if (!(PROVISION_ERROR_CODES as readonly string[]).includes(code))
    throw new Error(`unknown provision error code ${String(code)}`);
  throw new Error(`settleFailed is not built yet (W3); job ${jobId}`);
}
export type SettleFailed = typeof settleFailed;

/** The binding types verify_clean refuses on any install (design v7 5.2 e). */
export const VERIFY_CLEAN_REFUSED_BINDING_TYPES = Object.freeze([
  "secrets_store_secret",
  "service",
  "dispatch_namespace",
] as const);

/**
 * The exact secret names verify_clean expects on an install (design v7 5.2
 * e, rule 4), sorted: CREATE_SECRETS, BROKER_SIGNING_KEY with the broker,
 * TURNSTILE_SECRET with codes on, TEST_HOOK_KEY iff test hooks.
 */
export function expectedSecretNames(o: {
  broker: boolean;
  codes: boolean;
  testHooks: boolean;
}): string[] {
  return [
    ...CREATE_SECRETS,
    ...(o.broker ? ["BROKER_SIGNING_KEY"] : []),
    ...(o.codes ? ["TURNSTILE_SECRET"] : []),
    ...(o.testHooks ? ["TEST_HOOK_KEY"] : []),
  ].sort();
}

/**
 * verify_clean (design v7 5.2 e), run after the upload and before health,
 * route or any sign-in; W2 builds it. A refusal is `prod_dirty` (terminal,
 * never routed). In order:
 * 1. Live settings (GET .../dispatch/namespaces/<ns>/scripts/<script>/settings)
 *    and cf.secretList.
 * 2. Refuse any binding of a VERIFY_CLEAN_REFUSED_BINDING_TYPES type.
 * 3. Non-secret bindings minus OWNER_EMAIL equal `sent`'s by (name, type);
 *    for plain_text and json, sha256 of the value equals the render's.
 * 4. Secret names equal expectedSecretNames(...) exactly.
 * 5. TEST_HOOK_KEY, TEST_HOOKS and TEST_DOMAIN absent unless testHooks
 *    (keyed on testHooks, not OA_ENV).
 * 6. The release record's variant is `release` unless testHooks, and the
 *    live do_migration_tag equals the template's last tag.
 */
export interface VerifyCleanInput {
  id: InstallId;
  /**
   * The rendered metadata of this upload, or install_versions.metadata on a
   * resumed attempt (secrets and OWNER_EMAIL stripped).
   */
  sent: {
    bindings: { name: string; type: string; text?: string; json?: unknown }[];
  };
  rec: ReleaseRecord;
  broker: boolean;
  codes: boolean;
  testHooks: boolean;
  /** The template's last Durable Object migration tag. */
  lastTag: string;
}

export class ProvisionRefused extends Error {
  override name = "ProvisionRefused";
  /** The job error code, set where it is thrown (design v7 3.5). */
  readonly code: ProvisionErrorCode | undefined;
  constructor(message: string, code?: ProvisionErrorCode) {
    super(message);
    if (
      code !== undefined &&
      !(PROVISION_ERROR_CODES as readonly string[]).includes(code)
    )
      throw new Error(`unknown provision error code ${String(code)}`);
    this.code = code;
  }
}

/**
 * A refusal a rerun may clear (a held lease, a pending directory revoke, a
 * token that is not active): the Workflow retries it with bounded backoff.
 */
export class ProvisionRetry extends ProvisionRefused {
  override name = "ProvisionRetry";
  declare readonly code: ProvisionRetryCode;
  constructor(message: string, code: ProvisionRetryCode) {
    if (!(PROVISION_RETRY_CODES as readonly string[]).includes(code))
      throw new Error(`${String(code)} is not a retry code`);
    super(message, code);
  }
}

/**
 * The job error code for anything an operation threw (design v7 3.5): a
 * ProvisionRefused's own code, `cf_error` for a Cloudflare API error, and
 * `internal` for everything else, an uncoded refusal included. W3 and W7
 * classify through this, never a message.
 */
export function provisionErrorCode(e: unknown): ProvisionErrorCode {
  if (e instanceof ProvisionRefused) return e.code ?? "internal";
  if (e instanceof CfError) return "cf_error";
  return "internal";
}

/** An MCP call the install answered with an HTTP error. */
class McpError extends Error {
  constructor(
    method: string,
    readonly status: number,
  ) {
    super(`MCP ${method}: HTTP ${status}`);
    this.name = "McpError";
  }
}

/** Prod creates are refused until the T3b release-record writer exists. */
export class ProdLocked extends ProvisionRefused {
  override name = "ProdLocked";
}

/** As the server: codes are on with AUTH_PROVIDERS containing email, or EMAIL_CODE_DOMAIN=on. */
export function codesOn(vars: Record<string, string>): boolean {
  const providers = (vars.AUTH_PROVIDERS ?? "").split(",").map((p) => p.trim());
  return providers.includes("email") || vars.EMAIL_CODE_DOMAIN === "on";
}

/** The release, read and checked against its signed record. */
interface Checked {
  rec: ReleaseRecord;
  mainModule: string;
  modules: Module[];
  template: Template;
  migrations: ReleaseFile[];
  /** The env's signed floor, checked against FLOOR_MIN_SEQ and the version. */
  floor: FloorRecord;
}

const SECRET_BYTES = 48;
/** Secrets every install gets in its first upload (TEST_HOOK_KEY added on test installs). */
export const CREATE_SECRETS = [
  ...KNOWN_SECRETS,
  "DIRECTORY_TOKEN_KEY",
] as const;
/** Secrets metadata.ts does not know; appended to its bindings here. */
const EXTRA_SECRETS = ["DIRECTORY_TOKEN_KEY", "TURNSTILE_SECRET"];
const SITEKEY_RE = /^[0-9A-Za-z_-]{8,64}$/;

/**
 * Cloudflare's always-pass Turnstile pair. Only a test-hooks install (rl-a,
 * rl-b on staging) gets it, so the red-line suite can sign in by code; every
 * other install, and prod always, refuses any test key.
 */
export const TURNSTILE_TEST_KEYS = {
  sitekey: "1x00000000000000000000AA",
  secret: "1x0000000000000000000000000000000AA",
} as const;
/** Every Cloudflare Turnstile test sitekey or secret (1x, 2x, 3x). */
const TURNSTILE_TEST_KEY = /^[123]x0{20,}[A-Z]{2}$/;
/** An old_tag no script can have: the 412 it draws names the live tag. */
const PROBE_TAG = "__oa_probe__";
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 2_000;
const MAX_ACTIVE_TOKENS = 50;
const TOKEN_LABEL = "provision";
const REFUSE_TOKEN_DAYS = 5;
const DAY = 86_400_000;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const ASCII_EMAIL = /^[!-?A-~]+@[!-?A-~]+$/;
const WELCOME_TITLE = "Welcome to Open Artifacts";
const HEX64 = /^[0-9a-f]{64}$/;

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** As the server's normEmail: trimmed, lowercased printable ASCII, or null. */
export function normOwnerEmail(s: string): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length > 320 || !ASCII_EMAIL.test(t)) return null;
  const e = t.toLowerCase();
  return ASCII_EMAIL.test(e) ? e : null;
}

/** 48 bytes from the CSPRNG, base64url. Generated per install, never derived. */
export function newSecret(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** Decision 13: at least 32 bytes, base64url, distinct from every other secret of the run. */
export function assertSessionSecret(v: string, others: string[]): void {
  if (
    typeof v !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(v) ||
    Buffer.from(v, "base64url").toString("base64url") !== v
  )
    throw new Error("SESSION_SECRET must be base64url");
  if (Buffer.from(v, "base64url").byteLength < 32)
    throw new Error("SESSION_SECRET must be at least 32 bytes");
  if (others.includes(v))
    throw new Error("SESSION_SECRET must be distinct from every other secret");
}

/** The broker registry origin: exactly https://<appHost>. */
export function brokerOrigin(appHost: string): string {
  if (typeof appHost !== "string" || !HOST_RE.test(appHost))
    throw new Error("broker origin needs a lowercase hostname");
  return `https://${appHost}`;
}

export function assertBrokerOrigin(origin: string, appHost: string): void {
  if (origin !== brokerOrigin(appHost))
    throw new Error(
      "broker origin must be exactly https://<appHost> (https, lowercase, no port, path or trailing slash)",
    );
}

/** kid = first 16 chars of base64url(SHA-256(raw 32-byte public key x)). */
export function brokerKid(x: string): string {
  return createHash("sha256")
    .update(Buffer.from(x, "base64url"))
    .digest("base64url")
    .slice(0, 16);
}

function newBrokerKey(): { kid: string; x: string; pkcs8: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey as KeyObject).export({ format: "jwk" }).x as string;
  const pkcs8 = b64u(
    (privateKey as KeyObject).export({ format: "der", type: "pkcs8" }),
  );
  return { kid: brokerKid(x), x, pkcs8 };
}

/** Writes a 0600 file, refusing to follow a symlink at `path`. */
function writeSecretFile(path: string, text: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** One record assets entry: a safe path, a size and a full sha256. */
function assertAssetEntry(a: unknown): asserts a is ReleaseAssetEntry {
  const x = a as ReleaseAssetEntry;
  assertAssetPath(x?.path);
  if (!Number.isSafeInteger(x.size) || x.size < 0)
    throw new Error(`asset ${x.path} has no valid size`);
  if (typeof x.sha256 !== "string" || !HEX64.test(x.sha256))
    throw new Error(`asset ${x.path} has no valid sha256`);
}

const errCode = (e: unknown) =>
  (e as { code?: string })?.code ?? (e as Error)?.name ?? "error";

type Meta = {
  appHost: string;
  contentHost: string;
  ownerEmail: string;
  vars: Record<string, string>;
  testHooks: boolean;
  /** The verified Turnstile sitekey when codes are on. */
  sitekey: string | null;
};

/** How long a lifecycle operation holds the row's lock (installs.lease_until); renewed at each step. */
const LEASE_MS = 30 * 60_000;
const HEX32 = /^[0-9a-f]{32}$/;
const hex16 = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

/**
 * What install_versions keeps of an upload: no secret value (secrets stay on
 * the script through keep_bindings), no email (OWNER_EMAIL is re-rendered from
 * installs.owner_email), no assets jwt (one per upload) and no DO migration
 * step (a rollback never crosses a tag).
 */
export function storedMetadata(meta: UploadMetadata): Record<string, unknown> {
  const { migrations: _m, keep_assets: _k, ...rest } = meta;
  return {
    ...rest,
    bindings: meta.bindings.filter(
      (b) => !b.type.startsWith("secret") && b.name !== "OWNER_EMAIL",
    ),
    assets: { config: meta.assets.config },
    keep_bindings: ["secret_text", "secret_key"],
  };
}

const tagsOf = (t: Template): string[] =>
  ((t.migrations ?? []) as { tag: string }[]).map((x) => x.tag);

/**
 * Constraints: a Durable Object class ships one release before the code that
 * binds it. Read from the release template (verified against the signed
 * record's templateSha256): the classes its migrations add after `live`
 * (new_classes, new_sqlite_classes; L5 refuses every other step) must not be
 * in its durable_objects.bindings.
 */
export function assertDoClassesShipFirst(
  t: Template,
  live: string | null,
): void {
  const all = (t.migrations ?? []) as Record<string, unknown>[];
  const at = live === null ? -1 : tagsOf(t).indexOf(live);
  if (live !== null && at < 0)
    throw new Error(
      `the live Durable Object migration tag ${live} is not in this release; forward-fix only`,
    );
  const added = all
    .slice(at + 1)
    .flatMap((m) => [
      ...((m.new_classes ?? []) as string[]),
      ...((m.new_sqlite_classes ?? []) as string[]),
    ]);
  const bound = (
    (t.durable_objects?.bindings ?? []) as { class_name: string }[]
  ).map((b) => b.class_name);
  const both = added.filter((c) => bound.includes(c));
  if (both.length > 0)
    throw new Error(
      `this release adds Durable Object class ${both.join(", ")} and binds it in the same version; a class ships one release before the code that uses it`,
    );
}

/**
 * Forward only, in order: the install may not have a migration the release
 * lacks, and no unapplied file may sort before the last applied one.
 */
export function assertMigrationOrder(
  files: readonly string[],
  done: ReadonlySet<string>,
  version: string,
): void {
  const ahead = [...done].filter((x) => !files.includes(x));
  if (ahead.length > 0)
    throw new ProvisionRefused(
      `the install's D1 has migration ${ahead[0]}, which release ${version} does not; forward-fix only`,
    );
  const last = files.reduce((n, f, i) => (done.has(f) ? i : n), -1);
  const early =
    last < 0 ? undefined : files.slice(0, last).find((f) => !done.has(f));
  if (early !== undefined)
    throw new ProvisionRefused(
      `release ${version}: unapplied migration ${early} sorts before applied ${files[last]}; refusing to apply out of order`,
    );
}

/** M3: another operation holds the install now; this one stopped. */
export class LostLease extends ProvisionRefused {
  override name = "LostLease";
}

export interface VarsResult {
  id: InstallId;
  version: string;
  /** False when a check after the upload failed (the new vars are live). */
  ok: boolean;
  /** The epoch bump ran (google newly on, or a cut owed from an earlier run). */
  sessionCut: boolean;
  reason?: string;
}

export interface RotationResult {
  id: InstallId;
  ok: boolean;
  /** False for an install with codes off (nothing to rotate). */
  rotated: boolean;
  reason?: string;
}

/** H-DV: what delete prints when the directory revoke is skipped. */
export const DIRECTORY_REVOKE_SKIPPED_NOTE =
  "the Google grant stays live; revoke it in the customer's Google Admin console: Security > Access and data control > API controls > Manage Third-Party App Access (Manage App Access in newer consoles), find the Open Artifacts Directory app, then Change access to Blocked";

/**
 * A done unlocks teardown only when it is fresh: confirmed at or after the
 * start of this delete attempt (M1b). A skip unlocks it too (audited).
 */
const freshDone = (r: {
  directory_revoke: DirectoryRevoke | null;
  directory_revoked_at: number | null;
  directory_revoke_requested_at: number | null;
}): boolean =>
  r.directory_revoke === "done" &&
  r.directory_revoked_at !== null &&
  r.directory_revoke_requested_at !== null &&
  r.directory_revoked_at >= r.directory_revoke_requested_at;
const REVOKE_POLL_MS = 15_000;
const REVOKE_WAIT_MS = 10 * 60_000;

export interface DeleteOptions {
  /** Skip the Google directory revoke; the reason goes to hosted_audit. */
  skipDirectoryRevoke?: string;
  /** Called on each phase-2 poll. */
  onPoll?: (p: {
    state: DirectoryRevoke | null;
    attempts: number;
    waitedMs: number;
  }) => void | Promise<void>;
}

/** A skip reason: non-empty, one line, at most 200 characters, no email. */
function skipReason(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const r = typeof v === "string" ? v.trim() : "";
  if (r === "")
    throw new ProvisionRefused("skipDirectoryRevoke needs a non-empty reason");
  if (r.length > 200 || /[\r\n@]/.test(r))
    throw new ProvisionRefused(
      "the skip reason must be one line, at most 200 characters, with no email (it goes to hosted_audit)",
    );
  return r;
}

export interface DeleteResult {
  id: InstallId;
  ok: true;
  state: "deleted";
}

/** An operation's lock on its install (M3). */
interface Held {
  id: InstallId;
  lease: string;
  op: string;
}

/** R2-L1: what one operation owns, kept per call (AsyncLocalStorage). */
interface OpContext {
  sensitive: Set<string>;
  held: Held | null;
  /** The CI owner token this operation minted and has not revoked yet. */
  ci: CiToken | null;
}

/** An ephemeral CI owner PAT: in memory only, revoked before the lease goes. */
interface CiToken {
  pat: string;
  tokenId: string;
  d1Id: string;
  d1Name: string;
}

/** The CI owner token label: ci-<GitHub run id>. */
export const CI_TOKEN_LABEL_RE = /^ci-[1-9][0-9]{0,19}$/;
/** The hosted provisioner's owner token label: ss-<signup ULID>. */
export const PROVISIONER_TOKEN_LABEL_RE = /^ss-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const isTokenLabel = (l: unknown): l is string =>
  typeof l === "string" &&
  (CI_TOKEN_LABEL_RE.test(l) || PROVISIONER_TOKEN_LABEL_RE.test(l));

/** A pending session cut and the vars it was minted against. */
interface Cut {
  id: string;
  base: Record<string, string>;
  /** A google-on upload may have gone live (session_cut_armed). */
  armed: boolean;
}

/** What an upload attempt did: the tag it reached, and whether it may have landed. */
interface UploadOut {
  reached: string | null;
  /** True from just before a script upload is sent until Cloudflare definitely refuses it. */
  maybe: boolean;
}

/** A 4xx from Cloudflare: the request was refused and changed nothing. */
const refusedByCf = (e: unknown) =>
  e instanceof CfError && e.status >= 400 && e.status < 500;

/** A checked rollback, planned before any write. */
interface RollbackPlan {
  row: InstallRow;
  from: string;
  to: string;
  /** The render with the current vars: uploaded (with a fresh assets jwt) and stored. */
  upload: UploadMetadata;
  /** The previous release rendered with no tag: every DO step, for the probe. */
  probe: UploadMetadata;
  vars: Record<string, string>;
  m: Meta;
  rel: Checked;
  d1Id: string;
  /** Absent with ciOwnerToken: the selftest uses the in-memory CI token. */
  patFile?: string;
  /** R-L1: the PAT was refused; the rollback checks /healthz only. */
  refused?: string;
  raiseFloor: boolean;
}

/**
 * The owner PAT file, and why it was refused when a manual rollback goes on
 * without it. No file with ciOwnerToken: the CI token is minted under the lease.
 */
interface OwnerToken {
  patFile?: string;
  refused?: string;
}

export interface InstallStatus {
  id: InstallId;
  state: InstallState;
  version: string | null;
  previous_version: string | null;
  lease_until: number | null;
  leaseLive: boolean;
  /**
   * R2-N1: `pending` is the alarm (a cut is owed or must be settled by the
   * next upload). `owedRelativeToRecordedVars` compares installs.vars with the
   * cut's base; after a crash between an upload and its vars write it can
   * read false while google is live.
   */
  sessionCut: {
    pending: true;
    /** A google-on upload may have gone live (session_cut_armed). */
    armed: boolean;
    owedRelativeToRecordedVars: boolean;
  } | null;
  /**
   * H-DR: the install's broker registry entry against its directory copy.
   * Data-free (no key material); null when both agree. Both absent is
   * `missing_both` only where an entry is owed: an active or upgrading install
   * (broker on, or a broker_kid recorded) or a creating one past the registry
   * step.
   * Reported only, never repaired here: rerun create to resync.
   */
  registryDrift: {
    id: InstallId;
    kind: "missing_broker" | "missing_directory" | "mismatch" | "missing_both";
  } | null;
  /** H-DV: whether the owner email is still held; never the address. */
  owner: "(set)" | "(purged)";
  /** H-DV: the Google directory revoke a delete waits for. */
  directoryRevoke: {
    state: DirectoryRevoke | null;
    attempts: number;
    revokedAt: number | null;
  };
}

/**
 * R-L3: the tag probe went through. The probe body is a full upload of the
 * release (every DO step), so it is treated as an upload that happened.
 */
export class ProbeAccepted extends Error {
  override name = "ProbeAccepted";
}

export class WfpProvisioner {
  readonly notes: string[] = [];
  /** Each verified asset's assetHash, by its record sha256 and path. */
  private readonly assetHashes = new Map<string, string>();
  private readonly cf: Cf;
  private readonly env: Env;
  private readonly target: Target;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly http: typeof fetch;
  /**
   * R2-L1: each operation's own state (its redaction set and lock), per call
   * and never on the instance, so nothing else that runs reaches it.
   */
  private readonly ctx = new AsyncLocalStorage<OpContext>();
  /** R2-L1: one operation per instance at a time; a second one is refused. */
  private inFlight = false;
  // Resolved by name per run (never taken from the caller).
  private platform!: PlatformDb;
  private hostsKv!: { id: string; title: string };
  private registryKv?: { id: string; title: string };
  /** H-DR: the directory broker's copy of the registry (it never binds the one above). */
  private directoryKv?: { id: string; title: string };

  constructor(private readonly o: WfpOptions) {
    // F1: the gates live in src/internal/gates.ts; an option never opens one.
    for (const k of Object.keys(o ?? {}))
      if (GATE_LIKE.test(k))
        throw new ProvisionRefused(
          `${JSON.stringify(k)} is not an option; gates are code constants`,
        );
    this.cf = o.cf;
    this.env = o.env;
    this.target = o.target;
    this.now = o.now ?? Date.now;
    this.sleep =
      o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.http = o.fetch ?? fetch;
  }

  async create(i: WfpCreateInput): Promise<Install> {
    return this.guarded(() => {
      if (typeof i?.ownerEmail === "string" && i.ownerEmail) {
        this.sensitive.add(i.ownerEmail);
        this.sensitive.add(i.ownerEmail.trim());
        this.sensitive.add(i.ownerEmail.trim().toLowerCase());
      }
      return this.run(i);
    });
  }

  /** Values this operation must never print; scrubbed from every thrown error. */
  private get sensitive(): Set<string> {
    return this.ctx.getStore()?.sensitive ?? new Set();
  }

  /** The operation in progress: its install, lock and audit prefix (M3). */
  private get held(): Held | null {
    return this.ctx.getStore()?.held ?? null;
  }

  private set held(h: Held | null) {
    const c = this.ctx.getStore();
    if (!c) throw new Error("no operation context");
    c.held = h;
  }

  /** Scrubs every own string property (message, stack, Cloudflare text, route). */
  private scrub(e: unknown): unknown {
    if (!(e instanceof Error)) return new Error("create failed");
    const rec = e as unknown as Record<string, unknown>;
    for (const k of new Set([
      ...Object.getOwnPropertyNames(e),
      "message",
      "stack",
    ])) {
      let v = rec[k];
      if (typeof v !== "string") continue;
      for (const s of this.sensitive)
        if (s) v = (v as string).split(s).join("[redacted]");
      try {
        rec[k] = v;
      } catch {
        // read-only property: leave it
      }
    }
    return e;
  }

  // ---------- pre-flight: no Cloudflare call ----------

  private checkOptions(): void {
    const { env, o } = this;
    if (env !== "staging" && env !== "prod") throw new ForeignResource("", env);
    // L2: no prod create before the T3b record writer (a code change).
    if (env === "prod" && PROD_UNLOCKED !== true)
      throw new ProdLocked(
        "prod is locked until the T3b release-record writer exists",
      );
    const t = this.target;
    if (t.kind === "namespace") {
      if (t.ns !== NAMESPACES[env])
        throw new ProvisionRefused(
          `namespace ${JSON.stringify(t.ns)} is not the ${env} dispatch namespace (${NAMESPACES[env]})`,
        );
    } else if (t.kind === "account") {
      // L3: live envs always use the namespace.
      if (ALLOW_ACCOUNT_TARGET !== true)
        throw new ProvisionRefused(
          "the account target is for tests only; live envs use the dispatch namespace",
        );
    } else throw new ProvisionRefused("target must be account or namespace");
    if (this.pubkey() === RELEASE_PUBKEY_PLACEHOLDER)
      throw new ProvisionRefused(
        `RELEASE_PUBKEY.${env} is still the placeholder; T3b must set the release signing key before any create`,
      );
    // A malformed CI label is refused before any call, not at the mint.
    this.ciLabel();
    this.maxTokenDays();
    if (o.onStep !== undefined && typeof o.onStep !== "function")
      throw new ProvisionRefused("onStep must be a function");
    if (
      o.registryDisabled !== undefined &&
      typeof o.registryDisabled !== "boolean"
    )
      throw new ProvisionRefused("registryDisabled must be a boolean");
    // Fail closed until W2 wires them: a silent no-op would re-enable a
    // suspended install's sign-in or drop the Workflow's step record.
    if (o.onStep !== undefined)
      throw new ProvisionRefused("onStep is not built yet (W2)");
    if (o.registryDisabled === true)
      throw new ProvisionRefused("registryDisabled is not built yet (W2)");
    const d = HOSTED_DOMAINS[env];
    if (o.domains?.app !== d.app || o.domains?.content !== d.content)
      throw new ProvisionRefused(
        `domains must be the ${env} pair (${d.app}, ${d.content})`,
      );
  }

  /** Decision 8 and TEST_DOMAIN: which bundle and vars may go where. */
  private checkVariant(
    i: { bundle: BundleVariant; testHooks?: boolean },
    vars: Record<string, string>,
  ): void {
    const hooks = i.testHooks === true;
    const stagingNs =
      this.env === "staging" &&
      this.target.kind === "namespace" &&
      this.target.ns === NAMESPACES.staging;
    if (hooks && this.env === "prod")
      throw new ProvisionRefused("test hooks are not allowed in prod");
    if (i.bundle === "redline") {
      if (!stagingNs || !hooks)
        throw new ProvisionRefused(
          "the redline (hooks-enabled) bundle is only for test-hook installs in the oa-staging namespace",
        );
    } else if (i.bundle === "release") {
      if (hooks)
        throw new ProvisionRefused(
          "a test-hook install needs the redline bundle, not release",
        );
    } else throw new ProvisionRefused("bundle must be release or redline");
    if (vars.TEST_DOMAIN !== undefined && (!hooks || this.env === "prod"))
      throw new ProvisionRefused(
        "TEST_DOMAIN is only allowed on test-hook installs outside prod",
      );
    if (hooks && typeof vars.TEST_DOMAIN !== "string")
      throw new ProvisionRefused(
        "a test-hook install needs vars.TEST_DOMAIN (hooks act only on emails @TEST_DOMAIN)",
      );
  }

  private pubkey(): string {
    return RELEASE_PUBKEY[this.env];
  }

  /** L2 then M1: the record is trusted only after its signature checks out. */
  private async readRecord(i: {
    version: string;
    bundle: BundleVariant;
  }): Promise<ReleaseRecord> {
    const want = `${i.version} (${i.bundle})`;
    const got = await this.o.release.record(i.version, i.bundle);
    if (!got)
      throw new ProvisionRefused(
        `no release record for ${want}; the bundle step (T3b) must write one before any create`,
      );
    // F4: verify and use a private, frozen copy; the reader keeps nothing.
    // T3b: the record is the exact signed string, parsed strictly after the
    // signature (no duplicate key, no unknown key, canonical).
    let signed: unknown;
    try {
      signed = deepFreeze(structuredClone(got));
    } catch {
      signed = null;
    }
    let rec: ReleaseRecord;
    try {
      rec = deepFreeze(openReleaseRecord(signed, this.pubkey(), this.env));
    } catch (e) {
      throw new ProvisionRefused(
        `release record ${want}: ${(e as Error).message}`,
      );
    }
    if (rec.env !== this.env)
      throw new ProvisionRefused(
        `release record ${want} is for env ${String(rec.env)}, not ${this.env}`,
      );
    if (!isReleaseVersion(i.version))
      throw new ProvisionRefused(
        `version ${i.version} is not a release version`,
      );
    if (rec.version !== i.version || rec.variant !== i.bundle)
      throw new ProvisionRefused(
        `the release record read for ${want} is for ${String(rec.version)} (${String(rec.variant)})`,
      );
    const d = rec.defines?.[TEST_HOOKS_DEFINE];
    if (typeof d !== "boolean")
      throw new ProvisionRefused(
        `release record ${want}: ${TEST_HOOKS_DEFINE} must be a boolean literal`,
      );
    if (d !== (i.bundle === "redline"))
      throw new ProvisionRefused(
        `release record ${want}: ${TEST_HOOKS_DEFINE} must be ${i.bundle === "redline"}`,
      );
    for (const k of [
      "sha256",
      "templateSha256",
      "migrationsSha256",
      "welcomeSha256",
    ] as const)
      if (typeof rec[k] !== "string" || !HEX64.test(rec[k]))
        throw new ProvisionRefused(`release record ${want} has no valid ${k}`);
    if (!Array.isArray(rec.assets))
      throw new ProvisionRefused(`release record ${want} has no assets list`);
    try {
      // F8: limits before any other read, so a huge record fails early.
      if (rec.assets.length > ASSET_LIMITS.files)
        throw new Error(`more than ${ASSET_LIMITS.files} assets`);
      let prev = "";
      let total = 0;
      for (const [n, a] of rec.assets.entries()) {
        assertAssetEntry(a);
        if (a.size > ASSET_LIMITS.fileBytes)
          throw new Error(`asset ${a.path} is over 25 MiB`);
        total += a.size;
        if (n > 0 && !(a.path > prev))
          throw new Error("assets are not sorted by path, or repeat one");
        prev = a.path;
      }
      if (total > ASSET_LIMITS.totalBytes)
        throw new Error("assets are over 512 MiB in total");
    } catch (e) {
      throw new ProvisionRefused(
        `release record ${want}: ${(e as Error).message}`,
      );
    }
    return rec;
  }

  /**
   * E (T3b): the env's signed floor, verified against the release key, at or
   * above FLOOR_MIN_SEQ[env] (the code anchor), and not below minVersion or
   * revoked for this version. The D1 floor_seq cache is checked after the
   * platform DB resolves (checkFloorSeq). Every lifecycle operation runs both
   * for the version it uploads (upgrade's target, rollback's previous).
   */
  private async readFloor(rec: ReleaseRecord): Promise<FloorRecord> {
    const got = await this.o.release.floor();
    if (got === null || got === undefined)
      throw new ProvisionRefused(
        `the ${this.env} release floor (releases/floor.json) is missing; publish one before any create`,
        "release_unverified",
      );
    let f: FloorRecord;
    try {
      f = deepFreeze(openFloor(structuredClone(got), this.pubkey(), this.env));
    } catch (e) {
      throw new ProvisionRefused(
        `the ${this.env} release floor: ${(e as Error).message}`,
        "release_unverified",
      );
    }
    const why = floorRefusal(f, rec.version, FLOOR_MIN_SEQ[this.env]);
    if (why) throw new ProvisionRefused(why, "release_unverified");
    return f;
  }

  /**
   * E: floor_seq in D1 is only a cache (the token can write D1). Read-only:
   * refuses a floor below it; returns whether create must raise it (with
   * MAX, right before its first platform write).
   */
  private async checkFloorSeq(floor: FloorRecord): Promise<boolean> {
    const cached = await this.platform.floorSeq();
    if (floor.seq < cached)
      throw new ProvisionRefused(
        `the release floor seq ${floor.seq} is below ${cached}, the highest this env has accepted`,
        "release_unverified",
      );
    return floor.seq > cached;
  }

  /** M1: each read is checked against the record right before it is used. */
  private refuse(rec: ReleaseRecord, what: string, why?: string): never {
    throw new ProvisionRefused(
      `release ${rec.version} (${rec.variant}): the ${what} do not match the signed record${why ? ` (${why})` : ""}`,
      "release_unverified",
    );
  }

  private async readModules(
    rec: ReleaseRecord,
  ): Promise<{ mainModule: string; modules: Module[] }> {
    const m = await this.o.release.modules(rec.version, rec.variant);
    // A private copy: the bytes hashed are the bytes uploaded.
    const copy = {
      mainModule: String(m?.mainModule),
      modules: (m?.modules ?? []).map((x) => ({
        name: x.name,
        type: x.type,
        bytes: new Uint8Array(x.bytes),
      })),
    };
    if (bundleSha256(copy) !== rec.sha256) this.refuse(rec, "modules");
    return copy;
  }

  /**
   * The assets list, checked against the signed record, as an upload
   * manifest whose bytes are read only when used: every read is a private
   * copy checked against the record's size and sha256, so a file changed
   * since an earlier read is refused. Each file's assetHash comes from its
   * verify read: with `verify` (pre-flight, rollback apply) every file is
   * read and checked now, one at a time, and dropped; without, only a file
   * not verified yet in this run is.
   */
  private async readAssets(
    rec: ReleaseRecord,
    verify = false,
  ): Promise<AssetFile[]> {
    const list = await this.o.release.assets(rec.version, rec.variant);
    const got = (Array.isArray(list) ? list : []).map((a) => ({
      path: a?.path,
      size: a?.size,
      sha256: a?.sha256,
    }));
    try {
      for (const a of got) assertAssetEntry(a);
      got.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    } catch (e) {
      throw new ProvisionRefused(
        `release ${rec.version} (${rec.variant}): ${(e as Error).message}`,
      );
    }
    if (canonicalJson(got) !== canonicalJson(rec.assets))
      this.refuse(rec, "assets", "an extra, missing or changed file");
    const read = async (a: ReleaseAssetEntry) => {
      const bytes = new Uint8Array(
        (await this.o.release.assetBytes(rec.version, rec.variant, a.path)) ??
          [],
      );
      if (bytes.byteLength !== a.size || sha256Hex(bytes) !== a.sha256)
        this.refuse(rec, "assets", `${a.path} changed`);
      return bytes;
    };
    const files: AssetFile[] = [];
    for (const a of rec.assets) {
      // The hash is of the bytes with this sha256, so it is reused safely.
      const key = `${a.sha256}\0${a.path}`;
      let hash = this.assetHashes.get(key);
      if (verify || hash === undefined) {
        hash = assetHash(await read(a), a.path);
        this.assetHashes.set(key, hash);
      }
      files.push({ path: a.path, size: a.size, hash, bytes: () => read(a) });
    }
    return files;
  }

  private async readTemplate(rec: ReleaseRecord): Promise<Template> {
    const bytes = new Uint8Array(
      (await this.o.release.template(rec.version, rec.variant)) ?? [],
    );
    if (sha256Hex(bytes) !== rec.templateSha256) this.refuse(rec, "template");
    const t = parseTemplate(new TextDecoder().decode(bytes));
    // F6: codes on/off and Turnstile are decided by the provisioner only.
    for (const k of TEMPLATE_VARS_REFUSED)
      if (Object.hasOwn(t.vars ?? {}, k))
        throw new ProvisionRefused(
          `the release template sets ${k} in vars; only create may set it`,
        );
    // L5: only additive Durable Object migrations, before any call.
    try {
      assertSafeMigrations(t);
    } catch (e) {
      throw new ProvisionRefused((e as Error).message);
    }
    return t;
  }

  private async readMigrations(rec: ReleaseRecord): Promise<ReleaseFile[]> {
    const list = await this.o.release.migrations(rec.version, rec.variant);
    const copy = (list ?? []).map((f) => ({
      name: f?.name,
      bytes: new Uint8Array(f?.bytes ?? []),
    }));
    let h: string;
    try {
      h = migrationsSha256(copy);
    } catch (e) {
      throw new ProvisionRefused(
        `release ${rec.version} (${rec.variant}): ${(e as Error).message}`,
      );
    }
    if (h !== rec.migrationsSha256) this.refuse(rec, "migrations");
    return copy.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private async readWelcome(rec: ReleaseRecord): Promise<string> {
    const bytes = new Uint8Array(
      (await this.o.release.welcome(rec.version, rec.variant)) ?? [],
    );
    if (sha256Hex(bytes) !== rec.welcomeSha256) this.refuse(rec, "welcome");
    return new TextDecoder().decode(bytes);
  }

  /** Pre-flight: the signed record, then every release file against it. */
  private async readRelease(i: {
    version: string;
    bundle: BundleVariant;
  }): Promise<Checked> {
    if (!this.o.release) throw new ProvisionRefused("no release reader");
    const rec = await this.readRecord(i);
    const floor = await this.readFloor(rec);
    const { mainModule, modules } = await this.readModules(rec);
    await this.readAssets(rec, true);
    const template = await this.readTemplate(rec);
    const migrations = await this.readMigrations(rec);
    await this.readWelcome(rec);
    return { rec, mainModule, modules, template, migrations, floor };
  }

  /**
   * T8 review M1: the broker transport, for every caller. With the broker
   * on, AUTH_BROKER_URL is exactly https://auth.<the env's app domain>:
   * every render (create, upgrade, rollback, var change) gets it, and a
   * caller value that differs is refused at create and updateVars. The
   * stored vars stay as the caller gave them. Google with the
   * broker off is refused: the server would refuse google anyway, and a
   * create must never succeed with sign-in silently off.
   */
  private brokerVars(
    vars: Record<string, string>,
    mode: "check" | "render" = "check",
  ): Record<string, string> {
    if (!this.o.brokerEnabled) return vars;
    const client = BROKER_GOOGLE_CLIENT_ID[this.env];
    const want = `https://auth.${HOSTED_DOMAINS[this.env].app}`;
    // The directory broker rides the same switch: its signing key and
    // registry entry are the sign-in broker's, and on HOSTED=1 the server's
    // directory transport is "none" without this URL (review item 6).
    const wantDir = `https://directory.${HOSTED_DOMAINS[this.env].app}`;
    // L7: only create and updateVars refuse; a render (upgrade, rollback)
    // replaces a stale stored value with the derived one, noted.
    const refuse = (why: string) => {
      if (mode === "check") throw new ProvisionRefused(why);
      this.notes.push(`render: ${why}; rendering the derived value`);
    };
    if (!client)
      refuse(
        `the broker is on but there is no ${this.env} broker Google client`,
      );
    if (vars.AUTH_BROKER_URL !== undefined && vars.AUTH_BROKER_URL !== want)
      refuse(`AUTH_BROKER_URL must be ${want}, the ${this.env} broker`);
    if (
      vars.DIRECTORY_BROKER_URL !== undefined &&
      vars.DIRECTORY_BROKER_URL !== wantDir
    )
      refuse(
        `DIRECTORY_BROKER_URL must be ${wantDir}, the ${this.env} directory broker`,
      );
    if (
      client &&
      vars.GOOGLE_CLIENT_ID !== undefined &&
      vars.GOOGLE_CLIENT_ID !== client
    )
      refuse(
        `GOOGLE_CLIENT_ID must be ${client}, the ${this.env} broker's client`,
      );
    const { GOOGLE_CLIENT_ID: _old, ...rest } = vars;
    return {
      ...rest,
      AUTH_BROKER_URL: want,
      DIRECTORY_BROKER_URL: wantDir,
      ...(client ? { GOOGLE_CLIENT_ID: client } : {}),
    };
  }

  /** M1: google with the broker off is refused (after the other var checks). */
  /**
   * Every google precondition the server checks (apps/server/src/auth/
   * config.ts googleConfig) that provision does not render itself, in one
   * place: the broker on, and AUTH_DOMAINS non-empty after the server's own
   * parse (@oa/auth-core). The rest (client id, HOSTED, AUTH_BROKER_URL,
   * INSTALL_ID, BROKER_SIGNING_KEY) are rendered; a test pins the list.
   */
  private checkGoogleBroker(vars: Record<string, string>): void {
    const google = googleNewlyEnabled({}, vars);
    if (
      !this.o.brokerEnabled &&
      (google || vars.GOOGLE_CLIENT_ID !== undefined)
    )
      throw new ProvisionRefused(
        "google sign-in on a hosted install needs the sign-in broker (brokerEnabled)",
      );
    if (google && this.registryDomainsOf(vars).length === 0)
      throw new ProvisionRefused(
        "google needs AUTH_DOMAINS: the server refuses google when it is empty",
      );
  }

  /** Belt and braces before every upload: hooks only reach a staging test install. */
  private assertHooksAllowed(variant: BundleVariant, testHooks: boolean): void {
    if (variant === "release") return;
    const t = this.target;
    if (
      this.env !== "staging" ||
      t.kind !== "namespace" ||
      t.ns !== NAMESPACES.staging ||
      !testHooks
    )
      throw new ProvisionRefused(
        "refusing to upload a hooks-enabled bundle outside a staging test-hook install",
      );
  }

  /**
   * EMAIL_CODE_DOMAIN=on only when the server would honour it (it is silently
   * off otherwise): email in AUTH_PROVIDERS, google not, Turnstile (checked by
   * turnstileInput), and AUTH_DOMAINS non-empty. Names the condition, never a value.
   */
  private checkEmailCodeDomain(
    vars: Record<string, string>,
    stage: "providers" | "domains",
  ): void {
    if (vars.EMAIL_CODE_DOMAIN !== "on") return;
    const providers = (vars.AUTH_PROVIDERS ?? "")
      .split(",")
      .map((p) => p.trim());
    if (stage === "providers") {
      if (!providers.includes("email"))
        throw new ProvisionRefused(
          "EMAIL_CODE_DOMAIN=on needs email in AUTH_PROVIDERS",
        );
      if (providers.includes("google"))
        throw new ProvisionRefused(
          "EMAIL_CODE_DOMAIN=on needs google out of AUTH_PROVIDERS",
        );
    } else if (
      !(vars.AUTH_DOMAINS ?? "").split(",").some((d) => d.trim() !== "")
    )
      throw new ProvisionRefused("EMAIL_CODE_DOMAIN=on needs AUTH_DOMAINS");
  }

  /**
   * Codes on needs a Turnstile pair; checked before any call. A test-hooks
   * install gets Cloudflare's always-pass pair; any other install takes the
   * env's widget, and refuses it if it is a test key.
   */
  private turnstileInput(
    vars: Record<string, string>,
    testHooks: boolean,
  ): { sitekey: string; secret: string } | null {
    if (!codesOn(vars)) return null;
    if (testHooks) {
      if (this.env === "prod")
        throw new ProvisionRefused("a test Turnstile key is refused on prod");
      return { ...TURNSTILE_TEST_KEYS };
    }
    const ts = this.o.turnstile;
    if (
      !ts ||
      typeof ts.sitekey !== "string" ||
      typeof ts.secret !== "string" ||
      ts.sitekey.trim() === "" ||
      ts.secret.trim() === ""
    )
      throw new ProvisionRefused(
        `codes are on (AUTH_PROVIDERS has email, or EMAIL_CODE_DOMAIN=on) but the ${this.env} Turnstile sitekey and secret are missing; run the Turnstile init for ${this.env} first`,
      );
    if (!SITEKEY_RE.test(ts.sitekey))
      throw new ProvisionRefused("the Turnstile sitekey is malformed");
    if (
      TURNSTILE_TEST_KEY.test(ts.sitekey) ||
      TURNSTILE_TEST_KEY.test(ts.secret)
    )
      throw new ProvisionRefused(
        `a test Turnstile key is refused for the ${this.env} widget: only a test-hooks install gets one`,
      );
    this.sensitive.add(ts.secret);
    return { sitekey: ts.sitekey, secret: ts.secret };
  }

  /**
   * Read-only: the widget is the env's one, with exactly the env's app domain.
   * A test-hooks install's sitekey is the test pair's, which is no widget.
   */
  private async checkWidget(
    sitekey: string,
    testHooks: boolean,
  ): Promise<void> {
    if (testHooks) {
      if (sitekey !== TURNSTILE_TEST_KEYS.sitekey)
        throw new ProvisionRefused(
          "a test-hooks install's Turnstile sitekey must be the test key",
        );
      return;
    }
    if (TURNSTILE_TEST_KEY.test(sitekey))
      throw new ProvisionRefused(
        "a test Turnstile key is refused: only a test-hooks install gets one",
      );
    const name = platformNames(this.env).turnstile;
    const domain = HOSTED_DOMAINS[this.env].app;
    const w = await this.cf.turnstileWidget(sitekey);
    if (!w || w.sitekey !== sitekey)
      throw new ProvisionRefused(
        `Turnstile widget ${sitekey} not found on the account`,
      );
    if (w.name !== name)
      throw new ProvisionRefused(
        `Turnstile widget ${sitekey} is not ${name} (the ${this.env} widget)`,
      );
    if (
      !Array.isArray(w.domains) ||
      w.domains.length !== 1 ||
      w.domains[0] !== domain
    )
      throw new ProvisionRefused(
        `Turnstile widget ${sitekey} must list exactly [${domain}]`,
      );
  }

  // ---------- create ----------

  private async run(i: WfpCreateInput): Promise<Install> {
    this.checkOptions();
    if (i.plan !== "paid") throw new ProvisionRefused("plan must be paid");
    const ownerEmail = normOwnerEmail(i.ownerEmail);
    if (!ownerEmail)
      throw new ProvisionRefused("ownerEmail is not a valid email");
    const { appHost, contentHost } = hosts(i.slug, this.o.domains);
    if (i.resumeId !== undefined && !isInstallId(i.resumeId))
      throw new ProvisionRefused("resumeId is not an install id");
    if (i.installId !== undefined && !isInstallId(i.installId))
      throw new ProvisionRefused("installId is not an install id");
    if (i.installId !== undefined && i.resumeId !== undefined)
      throw new ProvisionRefused("pass installId or resumeId, not both");
    // 4.1: the admin and signup principals are never installs.
    for (const id of [i.installId, i.resumeId])
      if (isPlatformPrincipalId(id))
        throw new ProvisionRefused(
          `${id} is a platform principal id, never an install`,
        );
    const testHooks = i.testHooks === true;
    const vars = i.vars ?? {};
    this.brokerVars(vars);
    this.checkVariant(i, vars);
    // The owner PAT and test-hook key files without a CI token; with one,
    // both stay in memory (no patDir in the provisioner Worker).
    if (this.o.ciOwnerToken === undefined) this.patDir();
    this.checkEmailCodeDomain(vars, "providers");
    const ts = this.turnstileInput(vars, testHooks);
    this.checkEmailCodeDomain(vars, "domains");
    this.checkGoogleBroker(vars);
    if (this.o.brokerEnabled) this.registryDomainsOf(vars);
    const rel = await this.readRelease(i);

    // Secrets for a fresh upload; unused (and dropped) when the script exists.
    const secrets: Record<string, string> = {};
    for (const k of CREATE_SECRETS) secrets[k] = newSecret();
    if (testHooks) secrets.TEST_HOOK_KEY = newSecret();
    for (const v of Object.values(secrets)) this.sensitive.add(v);
    assertSessionSecret(
      secrets.SESSION_SECRET as string,
      Object.entries(secrets)
        .filter(([k]) => k !== "SESSION_SECRET")
        .map(([, v]) => v),
    );
    if (new Set(Object.values(secrets)).size !== Object.keys(secrets).length)
      throw new Error("generated secrets are not distinct");
    // Not generated: the env's widget secret, sent like the others.
    if (ts) secrets.TURNSTILE_SECRET = ts.secret;

    // Dry run: template, vars and ratelimit rules fail here, before any call.
    const meta: Meta = {
      appHost,
      contentHost,
      ownerEmail,
      vars,
      testHooks,
      sitekey: ts?.sitekey ?? null,
    };
    this.metadata("iaaaaaaaaaaa", meta, rel, {
      d1Id: "00000000-0000-4000-8000-000000000000",
      kvId: "0".repeat(32),
      rlNs: RL_BASE[this.env],
      tag: null,
      mode: "create",
      secrets,
      assetsJwt: "dry-run",
    });

    await this.checkToken();
    await this.resolvePlatform();
    const raiseFloor = await this.checkFloorSeq(rel.floor);
    if (ts) await this.checkWidget(ts.sitekey, testHooks);

    // ---------- platform row ----------
    const hash = inputsHash({ ownerEmail, vars, testHooks });
    let row = await this.findRow(i);
    let res: { d1: string | null; kv: string | null } | undefined;
    if (row) {
      if (row.state === "active")
        throw new ProvisionRefused(
          `slug ${i.slug} already exists as active install ${row.id}`,
          "slug_taken",
        );
      // Covers deleted too: its slug and hosts stay held until a purge.
      if (row.state !== "creating")
        throw new ProvisionRefused(
          `install ${row.id} is ${row.state}; only a creating install can be resumed (a deleted install keeps its slug and hosts until a purge)`,
          "invalid_state",
        );
      if (row.inputs_hash !== hash)
        throw new ProvisionRefused(
          `install ${row.id}: resume inputs differ from the first run (owner, vars or testHooks); use the original inputs`,
        );
      // F2/I1: never move an install to an older release.
      if (row.version && compareVersions(rel.rec.version, row.version) < 0)
        throw new ProvisionRefused(
          `install ${row.id} is at ${row.version}; ${rel.rec.version} would be a downgrade`,
          "downgrade_refused",
        );
      if (row.app_host !== appHost || row.content_host !== contentHost)
        throw new ProvisionRefused(
          `install ${row.id}: hosts differ from the first run`,
        );
      const held = await this.platform.hostsHeldByOthers(row.id, [
        appHost,
        contentHost,
      ]);
      if (held.length > 0)
        throw new ProvisionRefused(
          `host ${held[0]?.host} is already taken by ${held[0]?.install_id}`,
          "slug_taken",
        );
      res = await this.resources(row);
    } else {
      const holders = await this.platform.holdersOf([appHost, contentHost]);
      if (holders.length > 0)
        throw new ProvisionRefused(
          `host or broker origin already taken by install ${holders[0]?.id} (slug ${i.slug})`,
          "slug_taken",
        );
    }
    for (const h of [appHost, contentHost]) {
      const cur = await this.cf.kvGet(this.hostsKv.id, h);
      if (cur !== null && cur !== row?.id)
        throw new ProvisionRefused(
          `host ${h} is already taken by ${cur}`,
          "slug_taken",
        );
    }
    if (raiseFloor) await this.platform.raiseFloorSeq(rel.floor.seq);
    const fresh = !row;
    if (!row)
      row = await this.platform.insertCreating({
        id: i.installId ?? newInstallId(),
        slug: i.slug,
        appHost,
        contentHost,
        ownerEmail,
        testHooks,
        inputsHash: hash,
      });
    // R-M1: create holds the row's lease like every other operation (a
    // creating -> creating CAS on row_version), so a delete or a second
    // resume can never interleave with it; every row write checks it.
    await this.claim(row, ["creating"], "creating", "create");
    const id = row.id;
    try {
      if (!fresh) {
        await this.hold();
        await this.platform.resume({
          id,
          slug: i.slug,
          appHost,
          contentHost,
        });
      }
      return await this.steps(row, res, i, rel, secrets, meta);
    } catch (e) {
      if (!(e instanceof LostLease)) await this.releaseQuietly("creating", e);
      if (e instanceof Error && !e.message.startsWith(`install ${id}`))
        e.message = `install ${id}: ${e.message}`;
      throw e;
    }
  }

  /** H1: the platform D1, HOSTS, registry and directory copy come from env names, never from ids handed in. */
  private async resolvePlatform(): Promise<void> {
    const env = this.env;
    const dbName = platformNames(env).db;
    const dbId = await this.cf.d1Get(dbName);
    if (!dbId) throw new ProvisionRefused(`platform D1 ${dbName} not found`);
    this.platform = new PlatformDb(
      this.cf,
      { id: dbId, name: dbName },
      env,
      this.now,
    );
    const hostsTitle = hostsKvTitle(env);
    const hostsId = await this.cf.kvFind(hostsTitle);
    if (!hostsId)
      throw new ProvisionRefused(`HOSTS KV ${hostsTitle} not found`);
    this.hostsKv = { id: hostsId, title: hostsTitle };
    if (this.o.brokerEnabled) {
      const regTitle = platformNames(env).registry;
      const regId = await this.cf.kvFind(regTitle);
      if (!regId)
        throw new ProvisionRefused(`broker registry KV ${regTitle} not found`);
      this.registryKv = { id: regId, title: regTitle };
      const dirTitle = platformNames(env).directoryRegistry;
      const dirId = await this.cf.kvFind(dirTitle);
      if (!dirId)
        throw new ProvisionRefused(
          `directory registry KV ${dirTitle} not found`,
        );
      this.directoryKv = { id: dirId, title: dirTitle };
    }
  }

  /** H1: an install's D1 and KV are resolved by name; a row id that disagrees is refused. */
  private async resources(
    row: InstallRow,
    /** delete: a resource already gone is fine; another id is still refused. */
    allowGone = false,
  ): Promise<{ d1: string | null; kv: string | null }> {
    const n = names(row.id, this.env);
    const d1 = await this.cf.d1Get(n.d1);
    if (row.d1_id !== null && row.d1_id !== d1 && !(allowGone && d1 === null))
      throw new ProvisionRefused(
        `install ${row.id}: installs.d1_id is not the id of D1 ${n.d1}; refusing to touch another database`,
      );
    const kv = await this.cf.kvFind(n.kv);
    if (row.kv_id !== null && row.kv_id !== kv && !(allowGone && kv === null))
      throw new ProvisionRefused(
        `install ${row.id}: installs.kv_id is not the id of KV ${n.kv}; refusing to touch another namespace`,
      );
    return { d1, kv };
  }

  private async findRow(i: WfpCreateInput): Promise<InstallRow | undefined> {
    const bySlug = await this.platform.bySlug(i.slug);
    if (i.installId !== undefined) {
      const byId = await this.platform.byId(i.installId);
      if (byId && byId.slug !== i.slug)
        throw new ProvisionRefused(
          `installId ${i.installId} is not the install for slug ${i.slug}`,
        );
      // An active row keeps its own refusal (slug ... already exists).
      if (bySlug && bySlug.id !== i.installId && bySlug.state !== "active")
        throw new ProvisionRefused(
          `slug ${i.slug} is already taken by install ${bySlug.id}`,
          "slug_taken",
        );
      return bySlug;
    }
    if (i.resumeId === undefined) return bySlug;
    const byId = await this.platform.byId(i.resumeId);
    if (!byId || byId.slug !== i.slug || bySlug?.id !== byId.id)
      throw new ProvisionRefused(
        `resumeId ${i.resumeId} is not the install for slug ${i.slug}`,
      );
    return byId;
  }

  /**
   * `nearExpiry`: within REFUSE_TOKEN_DAYS of expiry, forward changes refuse;
   * a recovery (rollback, delete, releasing a lease) goes on with a loud note,
   * so an incident never waits on a token roll. An expired token always fails.
   */
  private async checkToken(
    nearExpiry: "refuse" | "warn" = "refuse",
  ): Promise<void> {
    const t = await this.cf.tokenVerify();
    const now = this.now();
    if (t?.status !== "active")
      throw new ProvisionRetry(
        "Cloudflare token is not active",
        "token_invalid",
      );
    if (t.not_before && Date.parse(t.not_before) > now)
      throw new ProvisionRefused(
        "Cloudflare token is not valid yet (not_before is in the future)",
      );
    const maxDays = this.maxTokenDays();
    if (!t.expires_on)
      throw new ProvisionRefused(
        `Cloudflare token has no expiry; set an end date at most ${maxDays} days out`,
      );
    const exp = Date.parse(t.expires_on);
    if (!Number.isFinite(exp) || exp <= now)
      throw new ProvisionRetry("Cloudflare token has expired", "token_invalid");
    if (exp > now + maxDays * DAY)
      throw new ProvisionRefused(
        `Cloudflare token expires more than ${maxDays} days out; mint one with a shorter expiry`,
      );
    if (exp <= now + REFUSE_TOKEN_DAYS * DAY) {
      const why = `the Cloudflare token expires on ${new Date(exp).toISOString().slice(0, 10)}, within ${REFUSE_TOKEN_DAYS} days; roll it (Cloudflare dashboard > My Profile > API Tokens > Roll) and ${this.tokenHome()}`;
      if (nearExpiry === "refuse")
        throw new ProvisionRefused(`${why}, then retry`);
      this.notes.push(`WARNING: ${why}`);
    }
    try {
      await this.cf.scriptsRead();
    } catch (e) {
      if (e instanceof CfError && (e.status === 401 || e.status === 403))
        throw new ProvisionRefused(
          `Cloudflare token lacks Workers Scripts Read on the account (HTTP ${e.status})`,
        );
      throw e;
    }
  }

  private metadata(
    id: InstallId,
    m: Meta,
    b: { rec: ReleaseRecord; mainModule: string; template: Template },
    r: {
      d1Id: string;
      kvId: string;
      rlNs: number;
      tag: string | null;
      mode: "create" | "update";
      secrets: Record<string, string>;
      assetsJwt: string;
    },
  ): UploadMetadata {
    const known = Object.fromEntries(
      Object.entries(r.secrets).filter(([k]) => !EXTRA_SECRETS.includes(k)),
    );
    const { sitekey, ...install } = m;
    const meta = userWorkerMetadata(
      { id, ...install, vars: this.brokerVars(install.vars, "render") },
      {
        d1Id: r.d1Id,
        kvId: r.kvId,
        version: b.rec.version,
        rlNs: r.rlNs,
        doMigrationTag: r.tag,
        env: this.env,
        target: this.target.kind,
        mode: r.mode,
        secrets: known,
        mainModule: b.mainModule,
        assetsJwt: r.assetsJwt,
        template: b.template,
      },
    );
    if (sitekey !== null)
      meta.bindings.push({
        type: "plain_text",
        name: "TURNSTILE_SITE_KEY",
        text: sitekey,
      });
    for (const k of EXTRA_SECRETS) {
      const v = r.secrets[k];
      if (v !== undefined)
        meta.bindings.push({ type: "secret_text", name: k, text: v });
    }
    // An update never drops the secrets already on the script.
    if (r.mode === "update") meta.keep_bindings = ["secret_text", "secret_key"];
    if (
      !m.testHooks &&
      meta.bindings.some((x) =>
        ["TEST_HOOKS", "TEST_HOOK_KEY", "TEST_DOMAIN"].includes(x.name),
      )
    )
      throw new Error("hooks bindings on a non-test install");
    try {
      assertUniqueBindings(meta.bindings);
    } catch (e) {
      throw new ProvisionRefused((e as Error).message);
    }
    return meta;
  }

  private async steps(
    row: InstallRow,
    resolved: { d1: string | null; kv: string | null } | undefined,
    i: WfpCreateInput,
    rel: Checked,
    fresh: Record<string, string>,
    m: Meta,
  ): Promise<Install> {
    const { cf, env, target } = this;
    const rec = rel.rec;
    const version = rec.version;
    const id = row.id;
    const n = names(id, env);
    const testHooks = m.testHooks;
    const res = resolved ?? (await this.resources(row));

    // D1, R2, KV (ids resolved by name, checked against the row)
    let d1Id = res.d1;
    if (!d1Id) {
      assertOwnResource(n.d1, env);
      await this.hold();
      d1Id = await cf.d1Create(n.d1);
    }
    if (row.d1_id !== d1Id) await this.write({ d1_id: d1Id });
    if (!(await cf.r2Exists(n.r2))) {
      assertOwnResource(n.r2, env);
      await this.hold();
      await cf.r2Create(n.r2);
    }
    let kvId = res.kv;
    if (!kvId) {
      assertOwnResource(n.kv, env);
      await this.hold();
      kvId = await cf.kvCreate(n.kv);
    }
    if (row.kv_id !== kvId) await this.write({ kv_id: kvId });

    await this.hold();
    await this.migrate(rec, d1Id, n.d1);

    // Upload, only when something is missing or behind.
    const tags = ((rel.template.migrations ?? []) as { tag: string }[]).map(
      (x) => x.tag,
    );
    const latest = tags.length ? (tags[tags.length - 1] as string) : null;
    const exists = await cf.scriptExists(target, n.script);
    const required = [
      ...CREATE_SECRETS,
      ...(testHooks ? ["TEST_HOOK_KEY"] : []),
      ...(m.sitekey !== null ? ["TURNSTILE_SECRET"] : []),
    ];
    const have = exists ? await cf.secretList(target, n.script) : [];
    const missing = required.filter((k) => !have.includes(k));
    const behind = row.version !== version || row.do_migration_tag !== latest;
    if (!exists || missing.length > 0 || behind) {
      const send = Object.fromEntries(
        missing.map((k) => [k, fresh[k] as string]),
      );
      // With ciOwnerToken and no patDir the key is not saved: redline_creds
      // rotates and delivers it (design v7 3.3).
      const hookDir =
        this.o.ciOwnerToken === undefined ? this.patDir() : this.o.patDir;
      if (send.TEST_HOOK_KEY !== undefined && hookDir !== undefined) {
        const dir = hookDir;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const f = join(dir, `${m.appHost}-hook-key`);
        try {
          writeSecretFile(f, `${send.TEST_HOOK_KEY}\n`);
        } catch (e) {
          throw new Error(
            `could not save the test-hook key to ${f} (${errCode(e)})`,
          );
        }
      }
      await this.hold();
      const out: UploadOut = { reached: null, maybe: false };
      const sent = await this.uploadRelease({
        id,
        script: n.script,
        rec,
        m,
        d1Id,
        kvId,
        rlNs: row.rl_ns,
        exists,
        journal: row.do_migration_tag,
        tags,
        send,
        out,
      });
      const reached = out.reached;
      // Stored before the row moves on: a rerun that finds the row current
      // skips the upload, so the version's render must already be kept.
      await this.hold();
      await this.platform.putVersion(id, version, {
        vars: m.vars,
        metadata: storedMetadata(sent),
        do_migration_tag: reached,
      });
      await this.write({
        version,
        do_migration_tag: reached,
        vars: canonicalJson(m.vars),
      });
      await this.logged("create.upload", {
        version,
        variant: rec.variant,
        sha256: rec.sha256,
      });
    }
    // Decision 4: workers.dev and previews off, account scripts only (405 on namespace scripts).
    if (target.kind === "account") {
      assertOwnResource(n.script, env);
      await this.hold();
      await cf.scriptSubdomain(target, n.script, scriptSubdomainSettings());
    }

    if (this.o.brokerEnabled)
      await this.broker(
        id,
        n.script,
        m.appHost,
        this.registryDomainsOf(m.vars),
      );

    // HOSTS: after the script exists and holds every secret.
    for (const h of [m.appHost, m.contentHost]) {
      const cur = await cf.kvGet(this.hostsKv.id, h);
      if (cur === id) continue;
      if (cur !== null)
        throw new ProvisionRefused(
          `host ${h} is already taken by ${cur}`,
          "slug_taken",
        );
      assertOwnResource(this.hostsKv.title, env);
      await this.hold();
      await cf.kvPut(this.hostsKv.id, h, id);
    }

    await this.health(id, m.appHost, version);
    await this.hold();
    // CI: the selftest runs on an ephemeral token and the owner gets no PAT
    // from provisioning (they sign in); otherwise the 0600 PAT file.
    let patFile: string | undefined;
    if (this.o.ciOwnerToken)
      await this.mintCiToken(d1Id, n.d1, m.ownerEmail, true);
    else patFile = await this.mintPat(d1Id, n.d1, m.ownerEmail, m.appHost);
    await this.selftest(rec, m.appHost, patFile);

    await this.logged("create.active", { version });
    await this.release("active");
    return {
      id,
      slug: i.slug,
      appHost: m.appHost,
      contentHost: m.contentHost,
      version,
      ...(patFile === undefined ? {} : { patFile }),
    };
  }

  /**
   * Uploads a checked release: modules, assets and template are re-read and
   * re-checked right before the write (M1), and the metadata sent is
   * returned. Decision 5: the settings API never reports the tag, so the
   * journal is checked by uploading: a 412 names the live tag and changes
   * nothing. An existing script with an empty journal is probed with a tag
   * it cannot have; a missing script is never probed. With `probe` (every
   * lifecycle upload, L5) the live tag is always probed first and `onLive`
   * re-checks it before the real upload.
   */
  private async uploadRelease(u: {
    id: InstallId;
    script: string;
    rec: ReleaseRecord;
    m: Meta;
    d1Id: string;
    kvId: string;
    rlNs: number;
    exists: boolean;
    journal: string | null;
    tags: string[];
    send: Record<string, string>;
    probe?: boolean;
    onLive?: (live: string | null) => void;
    /** Filled as the upload goes: the tag reached, and whether it may have landed. */
    out?: UploadOut;
  }): Promise<UploadMetadata> {
    const { cf, env, target } = this;
    let sent: UploadMetadata | undefined;
    const render = (
      mods: { mainModule: string },
      template: Template,
      tag: string | null,
      jwt: string,
    ) =>
      this.metadata(
        u.id,
        u.m,
        { rec: u.rec, mainModule: mods.mainModule, template },
        {
          d1Id: u.d1Id,
          kvId: u.kvId,
          rlNs: u.rlNs,
          tag,
          mode: u.exists ? "update" : "create",
          secrets: u.send,
          assetsJwt: jwt,
        },
      );
    /** Every script PUT: `maybe` is true from just before it until Cloudflare refuses it. */
    const send = async (meta: UploadMetadata, modules: Module[]) => {
      if (u.out) u.out.maybe = true;
      try {
        await cf.scriptUpload(target, u.script, meta, modules);
      } catch (e) {
        if (u.out && refusedByCf(e)) u.out.maybe = false;
        throw e;
      }
    };
    const upload = async (tag: string | null, probe = false) => {
      this.assertHooksAllowed(u.rec.variant, u.m.testHooks);
      const mods = await this.readModules(u.rec);
      const assets = await this.readAssets(u.rec);
      const template = await this.readTemplate(u.rec);
      const { jwt } = await cf.assetsUpload(target, u.script, assets);
      const meta = render(mods, template, tag, jwt);
      if (probe && meta.migrations) meta.migrations.old_tag = PROBE_TAG;
      assertOwnResource(u.script, env);
      await send(meta, mods.modules);
      sent = meta;
      // What the script now runs: the new tag when steps went, else the one sent against.
      if (u.out) u.out.reached = meta.migrations?.new_tag ?? tag;
    };
    let journal = u.exists ? u.journal : null;
    if (u.probe && u.exists) {
      const mods = await this.readModules(u.rec);
      const template = await this.readTemplate(u.rec);
      if (u.out) u.out.maybe = true;
      let live: string | null | undefined;
      try {
        live = await this.probeTag(
          u.script,
          render(mods, template, null, "probe"),
          mods.modules,
        );
      } catch (e) {
        if (u.out && refusedByCf(e)) u.out.maybe = false;
        throw e;
      }
      // A 412 (or no probe at all): nothing landed.
      if (u.out) u.out.maybe = false;
      if (live !== undefined) {
        if (live !== journal)
          this.notes.push(
            `probe: live migration tag is ${live ?? "none"}, the journal says ${journal ?? "none"}`,
          );
        u.onLive?.(live);
        journal = live;
      }
      await upload(journal);
      return sent as UploadMetadata;
    }
    try {
      await upload(journal, u.exists && journal === null);
    } catch (e) {
      const live =
        u.exists && e instanceof CfError && e.status === 412
          ? /expected tag is '([^']*)'/.exec(e.cfMessage)?.[1]
          : undefined;
      if (live === undefined) throw e;
      if (live !== "" && !u.tags.includes(live))
        throw new Error(
          `live Durable Object migration tag ${live} is not in this release; forward-fix only`,
        );
      this.notes.push(`probe: live migration tag is ${live || "none"}`);
      await upload(live === "" ? null : live);
    }
    return sent as UploadMetadata;
  }

  /**
   * L5: the live DO tag, read by an upload no script can accept (old_tag is
   * a tag no script has): the 412 names the tag and nothing changes.
   * undefined when the release has no DO step to send (nothing to probe).
   */
  private async probeTag(
    script: string,
    meta: UploadMetadata,
    modules: Module[],
  ): Promise<string | null | undefined> {
    if (!meta.migrations) return undefined;
    const { jwt: _j, ...assets } = meta.assets;
    const probe: UploadMetadata = {
      ...meta,
      bindings: meta.bindings.filter((b) => !b.type.startsWith("secret")),
      assets,
      keep_assets: true,
      migrations: { ...meta.migrations, old_tag: PROBE_TAG },
    };
    assertOwnResource(script, this.env);
    try {
      await this.cf.scriptUpload(this.target, script, probe, modules);
    } catch (e) {
      const live =
        e instanceof CfError && e.status === 412
          ? /expected tag is '([^']*)'/.exec(e.cfMessage)?.[1]
          : undefined;
      if (live === undefined) throw e;
      return live === "" ? null : live;
    }
    // The Task 1 spike (plan "Workers for Platforms is the M1 target",
    // docs/ops/hosted.md, PR #407) found an old_tag that is not the live tag
    // always draws 412 "Actor migration tag precondition failed ... expected
    // tag is '<tag>'" and changes nothing. If Cloudflare ever accepts it, the
    // probe body is live: callers take the post-upload (L7) path.
    throw new ProbeAccepted(
      "the Durable Object tag probe was accepted; the probe body (this release, every DO step) may be live",
    );
  }

  // ---------- lifecycle: upgrade, rollback, var changes, delete ----------

  /**
   * One operation: refused while another runs on this instance (R2-L1), with
   * its own redaction set and lock in a per-call context, every error
   * scrubbed.
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight)
      throw new ProvisionRefused(
        "this provisioner is already running an operation; use one instance per concurrent operation",
      );
    this.inFlight = true;
    try {
      return await this.ctx.run(
        { sensitive: new Set(), held: null, ci: null },
        async () => {
          try {
            return await fn();
          } catch (e) {
            throw this.scrub(e);
          } finally {
            // Any path that left the CI token live (a lost lease, a throw
            // past the release): revoke it now; ciTokenSweep is the backstop.
            await this.revokeCiToken();
          }
        },
      );
    } finally {
      this.inFlight = false;
    }
  }

  private reasonOf(e: unknown): string {
    const x = this.scrub(e);
    return x instanceof Error ? x.message : "failed";
  }

  /** Pre-flight shared by every lifecycle operation; the claim re-checks the row. */
  private async openInstall(
    id: InstallId,
    states: InstallState[],
    nearExpiry: "refuse" | "warn" = "refuse",
  ): Promise<InstallRow> {
    if (!isInstallId(id)) throw new ProvisionRefused("not an install id");
    this.checkOptions();
    await this.checkToken(nearExpiry);
    await this.resolvePlatform();
    const row = await this.platform.byId(id);
    if (!row) throw new ProvisionRefused(`install ${id} not found`);
    if (!states.includes(row.state))
      throw new ProvisionRefused(
        `install ${id} is ${row.state}; this operation needs ${states.join(" or ")}`,
      );
    // Never the purged '': splitting on it would shred every message.
    const owner = ownerEmailOf(row);
    if (owner !== null) this.sensitive.add(owner);
    return row;
  }

  /**
   * H1: one compare-and-swap moves the row and takes the lock, only if the
   * row is unchanged since pre-flight read it (row_version) and no live lock
   * is held.
   */
  private async claim(
    row: InstallRow,
    from: InstallState[],
    to: InstallState,
    op: string,
  ): Promise<void> {
    const lease = hex16();
    if (
      await this.platform.claim(
        row.id,
        from,
        to,
        lease,
        this.now() + LEASE_MS,
        row.row_version,
      )
    ) {
      this.held = { id: row.id, lease, op };
      return;
    }
    const cur = await this.platform.byId(row.id);
    if (cur && !from.includes(cur.state))
      throw new ProvisionRefused(
        `install ${row.id} is ${cur.state}; another operation got there first`,
        "invalid_state",
      );
    if (cur && cur.lease_until !== null && cur.lease_until > this.now())
      throw new ProvisionRetry(
        `install ${row.id} is busy: another operation holds it`,
        "lease_held",
      );
    throw new ProvisionRefused(
      `install ${row.id} changed since pre-flight read it; re-run`,
    );
  }

  /** M3: renews the lock before a step; a lock another operation took stops this one. */
  private async hold(): Promise<void> {
    const h = this.held;
    if (h && !(await this.platform.renew(h.id, h.lease, this.now() + LEASE_MS)))
      await this.lost();
  }

  private async lost(): Promise<never> {
    const h = this.held as { id: InstallId; op: string };
    this.held = null;
    await this.platform.audit(h.id, `${h.op}.lost_lease`, {}).catch(() => {});
    throw new LostLease(
      `install ${h.id}: lost the lease; another operation holds the install now, so this ${h.op} stopped`,
    );
  }

  /** A write of the held row, only while the lock is still this operation's. */
  private async write(fields: Partial<InstallRow>): Promise<void> {
    const h = this.held as { id: InstallId; lease: string };
    if (!(await this.platform.update(h.id, fields, h.lease))) await this.lost();
  }

  /** An audit row for the held install, after the lock is renewed. */
  private async logged(
    action: string,
    detail: Record<string, string | number> = {},
  ): Promise<void> {
    await this.hold();
    await this.platform.audit(
      (this.held as { id: InstallId }).id,
      action,
      detail,
    );
  }

  /** Ends the operation; a lock already gone is an error (lost the lease), not a success. */
  private async release(state: InstallState): Promise<void> {
    const h = this.held;
    if (!h) return;
    await this.revokeCiToken();
    if (!(await this.platform.finish(h.id, h.lease, state))) await this.lost();
    this.held = null;
  }

  /** Error paths: drops the lock if still held, never masking the error. */
  /**
   * Error paths: drops the lock if still held, never masking the error. With
   * the error, also audits `<op>.aborted` (paths that already audited a
   * post-upload outcome pass none).
   */
  private async releaseQuietly(
    state: InstallState,
    e?: unknown,
  ): Promise<void> {
    const h = this.held;
    if (h) await this.revokeCiToken();
    this.held = null;
    if (!h) return;
    if (e !== undefined)
      await this.platform
        .audit(h.id, `${h.op}.aborted`, { state, error: errCode(e) })
        .catch(() => {});
    await this.platform.finish(h.id, h.lease, state).catch(() => false);
  }

  /** Create's checks on an install's render inputs: variant, codes and Turnstile. */
  private renderInputs(row: InstallRow, vars: Record<string, string>): Meta {
    if (
      !vars ||
      typeof vars !== "object" ||
      Array.isArray(vars) ||
      Object.values(vars).some((v) => typeof v !== "string")
    )
      throw new ProvisionRefused("vars must map names to strings");
    const testHooks = row.test_hooks === 1;
    this.checkVariant(
      { bundle: testHooks ? "redline" : "release", testHooks },
      vars,
    );
    this.checkEmailCodeDomain(vars, "providers");
    const ts = this.turnstileInput(vars, testHooks);
    this.checkEmailCodeDomain(vars, "domains");
    const raw = ownerEmailOf(row);
    if (raw === null)
      throw new ProvisionRefused(
        `install ${row.id}: the owner email is purged (or missing); it is never rendered`,
      );
    const ownerEmail = normOwnerEmail(raw);
    if (!ownerEmail)
      throw new ProvisionRefused(`install ${row.id} has no valid owner email`);
    this.sensitive.add(ownerEmail);
    return {
      appHost: row.app_host,
      contentHost: row.content_host,
      ownerEmail,
      vars,
      testHooks,
      sitekey: ts?.sitekey ?? null,
    };
  }

  /** installs.vars: what the install runs with now (create and updateVars write it). */
  private currentVars(row: InstallRow): Record<string, string> {
    if (row.vars === null)
      throw new ProvisionRefused(
        `install ${row.id} has no stored vars (created before per-version metadata)`,
      );
    let v: unknown;
    try {
      v = JSON.parse(row.vars);
    } catch {
      v = null;
    }
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.values(v).some((x) => typeof x !== "string")
    )
      throw new ProvisionRefused(
        `install ${row.id}: installs.vars is not an object of strings; refusing to render it`,
      );
    return v as Record<string, string>;
  }

  private pendingCut(row: InstallRow): Cut | null {
    if (row.session_cut === null) return null;
    return {
      id: row.session_cut,
      base:
        row.session_cut_base === null ? {} : JSON.parse(row.session_cut_base),
      armed: row.session_cut_armed === 1,
    };
  }

  /**
   * M1 and L10, right after an upload is accepted (the uploaded vars are
   * live): the owed cut runs when they have google newly on relative to the
   * vars the cut was minted against, and is dropped otherwise.
   */
  private async settleCut(
    cut: Cut | null,
    live: Record<string, string>,
    d1Id: string,
    d1Name: string,
    version: string,
  ): Promise<boolean> {
    if (cut === null) return false;
    const clear = {
      session_cut: null,
      session_cut_base: null,
      session_cut_armed: 0,
    };
    // Fix round 5: an armed cut (a google-on upload may have gone live) is
    // applied even when this upload renders google off: sessions minted while
    // google was live must still end. Dropped only when none ever was.
    if (!cut.armed && !googleNewlyEnabled(cut.base, live)) {
      await this.write(clear);
      await this.logged("vars.session_cut_dropped", { version });
      return false;
    }
    await this.hold();
    await this.sessionCut(d1Id, d1Name, cut.id);
    await this.write(clear);
    await this.logged("vars.session_cut", { version });
    return true;
  }

  /**
   * R-L2: a failed bump (a transient D1 error) keeps the cut pending, audited,
   * and the operation goes on to /healthz and its rollback logic.
   */
  private async settleCutOrDefer(
    cut: Cut | null,
    live: Record<string, string>,
    d1Id: string,
    d1Name: string,
    version: string,
  ): Promise<boolean> {
    try {
      return await this.settleCut(cut, live, d1Id, d1Name, version);
    } catch (e) {
      if (e instanceof LostLease) throw e;
      this.notes.push(`session cut deferred: ${this.reasonOf(e)}`);
      await this.logged("vars.session_cut_failed", { version });
      return false;
    }
  }

  /**
   * Mints a fresh owner PAT (label `provision`) into an active install's D1
   * and writes it to the 0600 PAT file, under the lease; the earlier
   * provision tokens are retired once it is saved (mintPat). Every lifecycle
   * operation's pre-flight and selftest use that file, so an install whose
   * file is lost or whose token was revoked is recovered this way.
   */
  async reissueOwnerToken(
    id: InstallId,
    confirm: string,
  ): Promise<{ id: InstallId; patFile: string }> {
    return this.guarded(async () => {
      if (typeof confirm !== "string" || confirm !== id)
        throw new ProvisionRefused(
          "reissueOwnerToken needs confirm to be exactly the install id",
        );
      // The new PAT goes to a file: no patDir is refused before any write.
      this.patDir();
      const row = await this.openInstall(id, ["active"]);
      const raw = ownerEmailOf(row);
      const ownerEmail = raw === null ? null : normOwnerEmail(raw);
      if (!ownerEmail)
        throw new ProvisionRefused(
          `install ${id} has no valid owner email (purged or missing)`,
        );
      const { d1 } = await this.resources(row);
      if (!d1) throw new ProvisionRefused(`install ${id} has no D1`);
      await this.claim(row, ["active"], "active", "owner-token");
      try {
        await this.hold();
        const patFile = await this.mintPat(
          d1,
          names(id, this.env).d1,
          ownerEmail,
          row.app_host,
        );
        await this.logged("owner_token.reissue", {});
        await this.release("active");
        return { id, patFile };
      } catch (e) {
        if (!(e instanceof LostLease)) await this.releaseQuietly("active", e);
        throw e;
      }
    });
  }

  /**
   * Drops the operation lock a dead process left. Refused while the lease is
   * live unless `force` (the operator is sure nothing runs); both audited. An
   * upgrading row goes back to active; a deleting one stays deleting (rerun
   * delete to resume).
   */
  async releaseLease(
    id: InstallId,
    confirm: string,
    o: { force?: boolean } = {},
  ): Promise<{
    id: InstallId;
    released: true;
    forced: boolean;
    state: InstallState;
  }> {
    return this.guarded(async () => {
      if (typeof confirm !== "string" || confirm !== id)
        throw new ProvisionRefused(
          "releaseLease needs confirm to be exactly the install id",
        );
      const row = await this.openInstall(
        id,
        ["creating", "active", "upgrading", "deleting", "deleted"],
        "warn",
      );
      if (row.lease === null)
        throw new ProvisionRefused(`install ${id} holds no lease`);
      const live = row.lease_until !== null && row.lease_until > this.now();
      if (live && o?.force !== true) {
        await this.platform.audit(id, "lease.release_refused", {
          state: row.state,
        });
        throw new ProvisionRefused(
          `install ${id}: the lease has not expired (until ${new Date(row.lease_until as number).toISOString()}); pass force: true only when no operation is running`,
        );
      }
      const state: InstallState =
        row.state === "upgrading" ? "active" : row.state;
      if (!(await this.platform.finish(id, row.lease, state)))
        throw new ProvisionRefused(
          `install ${id}: the lease changed while releasing it; retry`,
        );
      await this.platform.audit(
        id,
        live ? "lease.force_release" : "lease.release",
        { from: row.state, state },
      );
      return { id, released: true, forced: live, state };
    });
  }

  private async storedOf(
    row: InstallRow,
    version: string,
  ): Promise<StoredVersion> {
    const v = await this.platform.version(row.id, version);
    if (!v)
      throw new ProvisionRefused(
        `install ${row.id}: no stored metadata for ${version} (the install was created before per-version metadata; it cannot be upgraded or rolled back)`,
      );
    return v;
  }

  /** The owner PAT create saved; the selftest uses it, and nothing re-mints it. */
  private patFileOf(appHost: string): string {
    const f = join(this.patDir(), `${appHost}-pat-token`);
    if (!existsSync(f))
      throw new ProvisionRefused(
        `the owner token file ${f} is missing; the selftest needs it`,
      );
    return f;
  }

  /**
   * M2: the PAT the read-only selftest needs, checked with a read-only MCP
   * initialize before any write. A 401 or 403 is refused, unless `allowRefused`
   * (R-L1: a manual rollback then proceeds with /healthz only, noted).
   */
  private async ownerToken(
    row: InstallRow,
    appHost: string,
    allowRefused = false,
  ): Promise<OwnerToken> {
    // CI: no file to check; the token is minted after the claim.
    if (this.o.ciOwnerToken) return {};
    const patFile = this.patFileOf(appHost);
    try {
      await this.mcp(appHost, patFile).initialize();
    } catch (e) {
      if (e instanceof McpError && (e.status === 401 || e.status === 403)) {
        const why = `the owner token in ${patFile} was refused by ${appHost} (HTTP ${e.status})`;
        if (!allowRefused)
          throw new ProvisionRefused(
            `${why}; restore it before any lifecycle operation`,
          );
        return { patFile, refused: why };
      }
      this.notes.push(
        `pre-flight: MCP on ${appHost} of ${row.id} did not answer (${errCode(e)}); continuing`,
      );
    }
    return { patFile };
  }

  /**
   * The token checks every operation runs first (active, not_before, an
   * expiry at most maxTokenDays out, Workers Scripts Read), on their own
   * and with no write, so a caller (the oa:hosted CLI) can refuse a token
   * before its own first write. `nearExpiry` as in each operation.
   */
  async verifyToken(nearExpiry: "refuse" | "warn"): Promise<void> {
    await this.checkToken(nearExpiry === "warn" ? "warn" : "refuse");
  }

  /**
   * Design v7 5.5, under a lease claim(row, ["active"], "active", kind):
   * both HOSTS keys to `<mode>:<id>` (hostsValue), then the sign-in registry
   * copy `disabled: true`; the directory copy is never disabled, so a later
   * purge's directory revoke still works. Idempotent. W2 builds the body.
   */
  async pause(
    id: InstallId,
    mode: "paused" | "closed",
    o: { kind: ProvisionJobKind },
  ): Promise<{ id: InstallId; mode: "paused" | "closed" }> {
    if (!isInstallId(id)) throw new ProvisionRefused("not an install id");
    if (mode !== "paused" && mode !== "closed")
      throw new ProvisionRefused("pause mode must be paused or closed");
    this.jobKind(o);
    throw new Error("pause is not built yet (W2)");
  }

  /**
   * Design v7 5.5: HOSTS back to `<id>`, then the sign-in registry copy
   * re-enabled. Idempotent. W2 builds the body.
   */
  async unpause(
    id: InstallId,
    o: { kind: ProvisionJobKind },
  ): Promise<{ id: InstallId; mode: "serving" }> {
    if (!isInstallId(id)) throw new ProvisionRefused("not an install id");
    this.jobKind(o);
    throw new Error("unpause is not built yet (W2)");
  }

  /**
   * R-N1: the row as an operator needs it, with no lease taken: state,
   * versions, the lock and any session cut still owed.
   */
  async status(id: InstallId): Promise<InstallStatus> {
    // R2-L1: not an operation: no re-entry check, and it never touches an
    // operation's lock or redaction set. It reads through its own PlatformDb.
    {
      if (!isInstallId(id)) throw new ProvisionRefused("not an install id");
      if (this.env !== "staging" && this.env !== "prod")
        throw new ForeignResource("", this.env);
      const dbName = platformNames(this.env).db;
      const dbId = await this.cf.d1Get(dbName);
      if (!dbId) throw new ProvisionRefused(`platform D1 ${dbName} not found`);
      const platform = new PlatformDb(
        this.cf,
        { id: dbId, name: dbName },
        this.env,
        this.now,
      );
      const row = await platform.byId(id);
      if (!row) throw new ProvisionRefused(`install ${id} not found`);
      const cut = this.pendingCut(row);
      const registryDrift = await this.registryDrift(row);
      return {
        id,
        state: row.state,
        version: row.version,
        previous_version: row.previous_version,
        lease_until: row.lease_until,
        leaseLive: row.lease_until !== null && row.lease_until > this.now(),
        sessionCut:
          cut === null
            ? null
            : {
                pending: true,
                armed: cut.armed,
                owedRelativeToRecordedVars:
                  row.vars !== null &&
                  googleNewlyEnabled(cut.base, JSON.parse(row.vars)),
              },
        registryDrift,
        owner: ownerEmailOf(row) === null ? "(purged)" : "(set)",
        directoryRevoke: {
          state: row.directory_revoke ?? null,
          attempts: row.directory_revoke_attempts ?? 0,
          revokedAt: row.directory_revoked_at ?? null,
        },
      };
    }
  }

  /** H-DR, read only: a namespace that is missing reads as empty; nothing is written. */
  private async registryDrift(
    row: InstallRow,
  ): Promise<InstallStatus["registryDrift"]> {
    const id = row.id;
    const read = async (title: string) => {
      const ns = await this.cf.kvFind(title);
      return ns ? await this.cf.kvGet(ns, registryKey(id)) : null;
    };
    const p = platformNames(this.env);
    const reg = await read(p.registry);
    const dir = await read(p.directoryRegistry);
    if (reg === null && dir === null) {
      // create puts the entry before it records broker_kid; delete removes it.
      const owed =
        row.broker_kid !== null
          ? ["active", "upgrading", "creating"].includes(row.state)
          : ["active", "upgrading"].includes(row.state) &&
            this.o.brokerEnabled === true;
      return owed ? { id, kind: "missing_both" } : null;
    }
    if (reg === dir) return null;
    if (reg === null) return { id, kind: "missing_broker" };
    if (dir === null) return { id, kind: "missing_directory" };
    return { id, kind: "mismatch" };
  }

  /** The install's D1 and script, both present, and every secret create sends. */
  private async liveInstall(
    row: InstallRow,
    m: Meta,
  ): Promise<{ d1Id: string; kvId: string }> {
    const res = await this.resources(row);
    if (!res.d1 || !res.kv)
      throw new ProvisionRefused(`install ${row.id} has no D1 or KV`);
    const script = names(row.id, this.env).script;
    if (!(await this.cf.scriptExists(this.target, script)))
      throw new ProvisionRefused(`install ${row.id} has no script`);
    const have = await this.cf.secretList(this.target, script);
    const missing = [
      ...CREATE_SECRETS,
      ...(m.testHooks ? ["TEST_HOOK_KEY"] : []),
    ].filter((k) => !have.includes(k));
    if (missing.length > 0)
      throw new ProvisionRefused(
        `install ${row.id} is missing secret ${missing.join(", ")}; repair it first`,
      );
    return { d1Id: res.d1, kvId: res.kv };
  }

  /** L4 in pre-flight: read-only, the install's applied migrations against the release's. */
  private async checkMigrationOrder(rel: Checked, d1Id: string): Promise<void> {
    const r = await this.cf.d1Query(d1Id, "SELECT name FROM d1_migrations");
    assertMigrationOrder(
      rel.migrations.map((f) => f.name),
      new Set((r[0]?.results ?? []).map((x) => String(x.name))),
      rel.rec.version,
    );
  }

  /** L5: the DO rule, re-run on the probed live tag. */
  private doRule(t: Template): (live: string | null) => void {
    return (live) => {
      try {
        assertDoClassesShipFirst(t, live);
      } catch (e) {
        throw new ProvisionRefused((e as Error).message);
      }
    };
  }

  /**
   * active -> upgrading -> new D1 migrations -> upload (keep_bindings, no
   * secret value) -> /healthz and the read-only MCP selftest -> active. A
   * failed check rolls back, unless the DO tag moved (forward-fix only).
   */
  async upgrade(id: InstallId, toVersion: string): Promise<UpgradeResult> {
    return this.guarded(() => this.runUpgrade(id, toVersion));
  }

  private async runUpgrade(id: InstallId, to: string): Promise<UpgradeResult> {
    const row = await this.openInstall(id, ["active"]);
    const from = row.version;
    if (!from) throw new ProvisionRefused(`install ${id} has no version`);
    if (!isReleaseVersion(to))
      throw new ProvisionRefused(`version ${to} is not a release version`);
    // Constraints: never --allow-downgrade.
    const c = compareVersions(to, from);
    if (c < 0)
      throw new ProvisionRefused(
        `install ${id} is at ${from}; ${to} would be a downgrade`,
        "downgrade_refused",
      );
    if (c === 0)
      throw new ProvisionRefused(
        `install ${id} is already at ${to}`,
        "downgrade_refused",
      );
    await this.storedOf(row, from);
    const vars = this.currentVars(row);
    const m = this.renderInputs(row, vars);
    const rel = await this.readRelease({
      version: to,
      bundle: m.testHooks ? "redline" : "release",
    });
    this.doRule(rel.template)(row.do_migration_tag);
    const { d1Id, kvId } = await this.liveInstall(row, m);
    await this.checkMigrationOrder(rel, d1Id);
    const own = await this.ownerToken(row, m.appHost);
    const n = names(id, this.env);
    this.metadata(id, m, rel, {
      d1Id,
      kvId,
      rlNs: row.rl_ns,
      tag: row.do_migration_tag,
      mode: "update",
      secrets: {},
      assetsJwt: "dry-run",
    });
    const raiseFloor = await this.checkFloorSeq(rel.floor);
    if (m.sitekey !== null) await this.checkWidget(m.sitekey, m.testHooks);
    const cut = this.pendingCut(row);

    await this.claim(row, ["active"], "upgrading", "upgrade");
    let uploaded = false;
    try {
      await this.ciTokenUnderLease(d1Id, n.d1, m.ownerEmail);
      if (raiseFloor) {
        await this.hold();
        await this.platform.raiseFloorSeq(rel.floor.seq);
      }
      await this.logged("upgrade.start", { from, to });
      await this.hold();
      await this.migrate(rel.rec, d1Id, n.d1);
      const out: UploadOut = { reached: null, maybe: false };
      await this.hold();
      const sent = await this.uploadRelease({
        id,
        script: n.script,
        rec: rel.rec,
        m,
        d1Id,
        kvId,
        rlNs: row.rl_ns,
        exists: true,
        journal: row.do_migration_tag,
        tags: tagsOf(rel.template),
        send: {},
        probe: true,
        onLive: this.doRule(rel.template),
        out,
      });
      uploaded = true;
      // Fix round 5: the tag the upload actually reached (probed, then sent).
      const reached = out.reached;
      await this.hold();
      await this.platform.putVersion(id, to, {
        vars,
        metadata: storedMetadata(sent),
        do_migration_tag: reached,
      });
      await this.write({
        version: to,
        previous_version: from,
        do_migration_tag: reached,
      });
      await this.settleCutOrDefer(cut, vars, d1Id, n.d1, to);
      try {
        await this.health(id, m.appHost, to, "the upgrade did not take");
        await this.checkSelf(m.appHost, own.patFile);
      } catch (e) {
        if (e instanceof LostLease) throw e;
        const reason = this.reasonOf(e);
        await this.logged("upgrade.failed", { from, to });
        const done = await this.afterFailedUpgrade(
          {
            ...row,
            version: to,
            previous_version: from,
            do_migration_tag: reached,
            session_cut: null,
            session_cut_base: null,
          },
          from,
          to,
          reason,
          own,
        );
        await this.release("active");
        return done;
      }
      await this.logged("upgrade.done", { from, to });
      await this.release("active");
      return { id, from, to, ok: true, rolledBack: false };
    } catch (e) {
      if (e instanceof LostLease) throw e;
      if (!uploaded && !(e instanceof ProbeAccepted)) {
        await this.releaseQuietly("active", e);
        throw e;
      }
      // L7: the new script may be live; say so and leave a trail.
      const reason = this.reasonOf(e);
      await this.platform
        .audit(id, "upgrade.incomplete", { from, to })
        .catch(() => {});
      await this.releaseQuietly("active");
      return {
        id,
        from,
        to,
        ok: false,
        rolledBack: false,
        forwardFix: true,
        reason: `${reason}; the script may already run ${to}: re-run or forward-fix`,
      };
    }
  }

  /** Review Focus 3: roll back, unless the DO tag moved or the previous version is refused. */
  private async afterFailedUpgrade(
    row: InstallRow,
    from: string,
    to: string,
    reason: string,
    own: OwnerToken,
  ): Promise<UpgradeResult> {
    const forwardFix = async (why: string) => {
      await this.logged("upgrade.forward_fix", { from, to });
      return {
        id: row.id,
        from,
        to,
        ok: false,
        rolledBack: false,
        forwardFix: true,
        reason: why,
      };
    };
    let back: { ok: boolean; reason?: string };
    try {
      const plan = await this.planRollback(row, own);
      back = await this.applyRollback(plan, null);
    } catch (e) {
      if (e instanceof LostLease || !(e instanceof ProvisionRefused)) throw e;
      return forwardFix(`${reason}; no rollback: ${this.reasonOf(e)}`);
    }
    return {
      id: row.id,
      from,
      to,
      ok: false,
      rolledBack: true,
      reason: back.ok ? reason : `${reason}; ${back.reason}`,
    };
  }

  /**
   * Re-uploads the previous version's verified code with its stored
   * metadata (bindings, compat, tag) and the install's current vars, and
   * swaps version and previous_version. Never rolls back D1 (forward-only),
   * never crosses a DO tag, never moves forward.
   */
  async rollback(id: InstallId): Promise<UpgradeResult> {
    return this.guarded(async () => {
      const row = await this.openInstall(id, ["active"], "warn");
      const plan = await this.planRollback(row);
      await this.claim(row, ["active"], "upgrading", "rollback");
      try {
        await this.ciTokenUnderLease(
          plan.d1Id,
          names(id, this.env).d1,
          plan.m.ownerEmail,
        );
        const r = await this.applyRollback(plan, this.pendingCut(row));
        await this.release("active");
        return {
          id,
          from: plan.from,
          to: plan.to,
          ok: r.ok,
          rolledBack: true,
          ...(r.ok ? {} : { reason: r.reason }),
          ...(r.note === undefined ? {} : { note: r.note }),
        };
      } catch (e) {
        if (!(e instanceof LostLease)) await this.releaseQuietly("active", e);
        throw e;
      }
    });
  }

  /** Every rollback refusal, before any write. `own` is passed by the auto-rollback. */
  private async planRollback(
    row: InstallRow,
    own?: OwnerToken,
  ): Promise<RollbackPlan> {
    const id = row.id;
    const from = row.version;
    const to = row.previous_version;
    if (!from || !to)
      throw new ProvisionRefused(
        `install ${id} has no previous version to roll back to`,
      );
    // L3: a rollback never moves forward; that is an upgrade, with its checks.
    if (compareVersions(to, from) > 0)
      throw new ProvisionRefused(
        `install ${id}: the previous version ${to} is newer than ${from}; use upgrade`,
      );
    const stored = await this.storedOf(row, to);
    if (stored.do_migration_tag !== row.do_migration_tag)
      throw new ProvisionRefused(
        `install ${id}: the Durable Object migration tag moved from ${String(stored.do_migration_tag)} (${to}) to ${String(row.do_migration_tag)} (${from}); rollback is refused (forward-fix only)`,
      );
    // The previous version's code, bindings, compat and tag, with the
    // install's CURRENT vars, re-validated against that release as create and
    // updateVars validate them. Vars do not change, so there is no session cut.
    const vars = this.currentVars(row);
    const unfit = (e: unknown) =>
      new ProvisionRefused(
        `install ${id}: the current vars do not fit ${to}: ${(e as Error).message}`,
      );
    const m = this.renderInputs(row, vars);
    const rel = await this.readRelease({
      version: to,
      bundle: m.testHooks ? "redline" : "release",
    });
    const meta = stored.metadata as unknown as UploadMetadata;
    if (
      meta.main_module !== rel.mainModule ||
      canonicalJson(meta.tags) !== canonicalJson([id, `v${to}`]) ||
      !Array.isArray(meta.bindings) ||
      meta.bindings.some((b) => String(b?.type).startsWith("secret")) ||
      meta.migrations !== undefined
    )
      throw new ProvisionRefused(
        `install ${id}: the stored metadata for ${to} is not a render of that release`,
      );
    const tok = own ?? (await this.ownerToken(row, m.appHost, true));
    const { d1Id, kvId } = await this.liveInstall(row, m);
    const render = (tag: string | null) =>
      this.metadata(id, m, rel, {
        d1Id,
        kvId,
        rlNs: row.rl_ns,
        tag,
        mode: "update",
        secrets: {},
        assetsJwt: "dry-run",
      });
    let fresh: UploadMetadata;
    try {
      fresh = render(row.do_migration_tag);
    } catch (e) {
      throw unfit(e);
    }
    // Everything not rendered from vars must be what was stored for `to`.
    const varNames = new Set([
      ...Object.keys(stored.vars),
      ...Object.keys(vars),
      "FEATURES",
      "TURNSTILE_SITE_KEY",
    ]);
    const notVars = (x: Record<string, unknown>) =>
      canonicalJson({
        ...x,
        bindings: (x.bindings as { type: string; name: string }[]).filter(
          (b) => !(b.type === "plain_text" && varNames.has(b.name)),
        ),
      });
    if (notVars(storedMetadata(fresh)) !== notVars(stored.metadata))
      throw new ProvisionRefused(
        `install ${id}: release ${to} no longer renders the metadata stored for it`,
      );
    const { jwt: _j, ...assets } = fresh.assets;
    const { migrations: _m, ...upload } = { ...fresh, assets };
    const raiseFloor = await this.checkFloorSeq(rel.floor);
    if (m.sitekey !== null) await this.checkWidget(m.sitekey, m.testHooks);
    return {
      row,
      from,
      to,
      upload,
      probe: render(null),
      vars,
      m,
      rel,
      d1Id,
      ...(tok.patFile === undefined ? {} : { patFile: tok.patFile }),
      ...(tok.refused === undefined ? {} : { refused: tok.refused }),
      raiseFloor,
    };
  }

  private async applyRollback(
    p: RollbackPlan,
    cut: Cut | null,
  ): Promise<{ ok: boolean; reason?: string; note?: string }> {
    const { row, from, to, rel } = p;
    const id = row.id;
    const n = names(id, this.env);
    if (p.raiseFloor) {
      await this.hold();
      await this.platform.raiseFloorSeq(rel.floor.seq);
    }
    await this.logged("rollback.start", { from, to });
    this.assertHooksAllowed(rel.rec.variant, p.m.testHooks);
    const mods = await this.readModules(rel.rec);
    // Check-first: every file again, before the probe or any write.
    const assets = await this.readAssets(rel.rec, true);
    // L5: the live tag, not only the journal; a rollback never crosses it.
    await this.hold();
    let live: string | null | undefined;
    try {
      live = await this.probeTag(n.script, p.probe, mods.modules);
    } catch (e) {
      if (!(e instanceof ProbeAccepted)) throw e;
      await this.logged("rollback.incomplete", { from, to });
      return {
        ok: false,
        reason: `${this.reasonOf(e)}; forward-fix`,
      };
    }
    if (live !== undefined && live !== row.do_migration_tag)
      throw new ProvisionRefused(
        `install ${id}: the live Durable Object migration tag is ${live ?? "none"}, the journal says ${row.do_migration_tag ?? "none"}; rollback is refused (forward-fix only)`,
      );
    const { jwt } = await this.cf.assetsUpload(this.target, n.script, assets);
    const meta: UploadMetadata = {
      ...p.upload,
      assets: { ...p.upload.assets, jwt },
    };
    try {
      assertUniqueBindings(meta.bindings);
    } catch (e) {
      throw new ProvisionRefused((e as Error).message);
    }
    assertOwnResource(n.script, this.env);
    await this.hold();
    await this.cf.scriptUpload(this.target, n.script, meta, mods.modules);
    try {
      await this.hold();
      await this.platform.putVersion(id, to, {
        vars: p.vars,
        metadata: storedMetadata(meta),
        do_migration_tag: row.do_migration_tag,
      });
      await this.write({ version: to, previous_version: from });
      await this.settleCutOrDefer(cut, p.vars, p.d1Id, n.d1, to);
      await this.health(id, p.m.appHost, to, "the rollback did not take");
      if (p.refused === undefined) await this.checkSelf(p.m.appHost, p.patFile);
    } catch (e) {
      if (e instanceof LostLease) throw e;
      // L7: the rolled-back script is live; report it and leave a trail.
      await this.logged("rollback.unhealthy", { from, to });
      return { ok: false, reason: `after the rollback: ${this.reasonOf(e)}` };
    }
    if (p.refused !== undefined) {
      await this.logged("rollback.selftest_skipped", { from, to });
      await this.logged("rollback.done", { from, to });
      return {
        ok: true,
        note: `${p.refused}: the MCP selftest was skipped, /healthz only`,
      };
    }
    await this.logged("rollback.done", { from, to });
    return { ok: true };
  }

  /**
   * A var change on the live version, with create's checks. When google is
   * newly on (#442) the install's own D1 gets epochBumpSql() as soon as the
   * upload is accepted, once per enablement: the cut id and its base vars
   * are journaled on the row before the upload and the id is recorded in
   * the install's D1 with the bump.
   */
  async updateVars(
    id: InstallId,
    nextVars: Record<string, string>,
  ): Promise<VarsResult> {
    return this.guarded(async () => {
      if (!nextVars || typeof nextVars !== "object" || Array.isArray(nextVars))
        throw new ProvisionRefused("vars must be an object of strings");
      const row = await this.openInstall(id, ["active"]);
      const version = row.version;
      if (!version) throw new ProvisionRefused(`install ${id} has no version`);
      await this.storedOf(row, version);
      // H1: computed from the snapshot the claim pins.
      const prev = this.currentVars(row);
      const vars = { ...nextVars };
      this.brokerVars(vars);
      const m = this.renderInputs(row, vars);
      this.checkGoogleBroker(vars);
      // T8 review M2: only create's broker step issues the signing key and
      // the first registry entry. Without them google can't work, and the
      // session cut would log everyone out for nothing.
      // TODO(Platform): a lease-held broker-enrol op for active installs, so
      // google can be turned on for an existing install.
      if (googleNewlyEnabled(prev, vars) && row.broker_kid === null)
        throw new ProvisionRefused(
          `install ${id} has no broker key; the broker key is only issued at create, so turning google on for an existing install is a follow-up (Platform)`,
        );
      // H-RD: only the paths that write the registry check its domains (here
      // and create); upgrade and rollback never do, so a rollback is never
      // blocked by them.
      const domains = this.o.brokerEnabled
        ? this.registryDomainsOf(vars)
        : null;
      const rel = await this.readRelease({
        version,
        bundle: m.testHooks ? "redline" : "release",
      });
      const { d1Id, kvId } = await this.liveInstall(row, m);
      const own = await this.ownerToken(row, m.appHost);
      const n = names(id, this.env);
      const have = await this.cf.secretList(this.target, n.script);
      // Codes newly on: the env's widget secret goes up with the vars. A
      // test-hooks install always gets the test secret, so one that holds the
      // env's secret is moved to the test pair.
      const send: Record<string, string> =
        m.sitekey === null
          ? {}
          : m.testHooks
            ? { TURNSTILE_SECRET: TURNSTILE_TEST_KEYS.secret }
            : !have.includes("TURNSTILE_SECRET")
              ? {
                  TURNSTILE_SECRET: (this.o.turnstile as { secret: string })
                    .secret,
                }
              : {};
      this.metadata(id, m, rel, {
        d1Id,
        kvId,
        rlNs: row.rl_ns,
        tag: row.do_migration_tag,
        mode: "update",
        secrets: send,
        assetsJwt: "dry-run",
      });
      const raiseFloor = await this.checkFloorSeq(rel.floor);
      if (m.sitekey !== null) await this.checkWidget(m.sitekey, m.testHooks);
      let cut = this.pendingCut(row);

      await this.claim(row, ["active"], "upgrading", "vars");
      let uploaded = false;
      let sessionCut = false;
      let armedHere = false;
      const out: UploadOut = { reached: null, maybe: false };
      try {
        await this.ciTokenUnderLease(d1Id, n.d1, m.ownerEmail);
        if (raiseFloor) {
          await this.hold();
          await this.platform.raiseFloorSeq(rel.floor.seq);
        }
        if (cut === null && googleNewlyEnabled(prev, vars)) {
          cut = { id: hex16(), base: prev, armed: false };
          await this.write({
            session_cut: cut.id,
            session_cut_base: canonicalJson(prev),
          });
        }
        const changed = [
          ...new Set([...Object.keys(prev), ...Object.keys(vars)]),
        ]
          .filter((k) => prev[k] !== vars[k])
          .sort();
        await this.logged("vars.start", {
          version,
          changed: changed.join(","),
        });
        // Fix round 5: armed right before an upload that turns google on goes
        // out; only a definite refusal from Cloudflare disarms it.
        if (cut !== null && !cut.armed && googleNewlyEnabled(cut.base, vars)) {
          await this.write({ session_cut_armed: 1 });
          cut.armed = true;
          armedHere = true;
        }
        await this.hold();
        const sent = await this.uploadRelease({
          id,
          script: n.script,
          rec: rel.rec,
          m,
          d1Id,
          kvId,
          rlNs: row.rl_ns,
          exists: true,
          journal: row.do_migration_tag,
          tags: tagsOf(rel.template),
          send,
          probe: true,
          onLive: this.doRule(rel.template),
          out,
        });
        uploaded = true;
        await this.write({ vars: canonicalJson(vars) });
        // H-RD: the registry copies follow the live vars, in this lease.
        if (domains !== null) await this.syncRegistry(id, m.appHost, domains);
        await this.hold();
        await this.platform.putVersion(id, version, {
          vars,
          metadata: storedMetadata(sent),
          do_migration_tag: out.reached,
        });
        await this.write({ do_migration_tag: out.reached });
        // M1: the vars are live once the upload is accepted; cut now.
        sessionCut = await this.settleCutOrDefer(
          cut,
          vars,
          d1Id,
          n.d1,
          version,
        );
        await this.health(id, m.appHost, version, "rerun the var change");
        await this.checkSelf(m.appHost, own.patFile);
        await this.logged("vars.done", { version });
        await this.release("active");
        return { id, version, ok: true, sessionCut };
      } catch (e) {
        if (e instanceof LostLease) throw e;
        if (!uploaded && !(e instanceof ProbeAccepted) && !out.maybe) {
          // Definitely not live: a cut armed by this attempt is disarmed.
          if (armedHere)
            await this.write({ session_cut_armed: 0 }).catch(() => {});
          await this.releaseQuietly("active", e);
          throw e;
        }
        // L7: the new vars are live; report it and leave a trail.
        const reason = this.reasonOf(e);
        await this.platform
          .audit(id, "vars.failed", { version })
          .catch(() => {});
        await this.releaseQuietly("active");
        return { id, version, ok: false, sessionCut, reason };
      }
    });
  }

  /**
   * epochBumpSql() once per cut id: the id lands in the install's D1 in the
   * same batch as the bump, so a rerun after a lost reply never bumps twice.
   */
  private async sessionCut(
    d1Id: string,
    d1Name: string,
    cut: string,
  ): Promise<void> {
    if (!HEX32.test(cut)) throw new Error("the session cut id is malformed");
    assertOwnResource(d1Name, this.env);
    await this.cf.d1Query(
      d1Id,
      "CREATE TABLE IF NOT EXISTS oa_session_cuts (id TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    const r = await this.cf.d1Query(
      d1Id,
      "SELECT id FROM oa_session_cuts WHERE id = ?1",
      [cut],
    );
    if (r[0]?.results?.length) return;
    assertOwnResource(d1Name, this.env);
    await this.cf.d1Batch(d1Id, [
      { sql: "INSERT INTO oa_session_cuts (id) VALUES (?1)", params: [cut] },
      { sql: epochBumpSql() },
    ]);
  }

  /**
   * Puts the env's current Turnstile secret (options.turnstile, from the
   * keychain) on every active install of `env` with codes on. One result per
   * install; an install that is not active, or owes a session cut, is
   * reported, not skipped silently.
   */
  async rotateTurnstileSecret(env: Env): Promise<RotationResult[]> {
    return this.guarded(async () => {
      this.checkOptions();
      if (env !== this.env)
        throw new ProvisionRefused(
          `this provisioner is for ${this.env}, not ${String(env)}`,
        );
      // The pair codes-on needs, checked as create checks it.
      const ts = this.turnstileInput({ AUTH_PROVIDERS: "email" }, false);
      if (!ts) throw new Error("unreachable");
      await this.checkToken();
      await this.resolvePlatform();
      await this.checkWidget(ts.sitekey, false);
      const out: RotationResult[] = [];
      for (const row of await this.platform.inStates([
        "creating",
        "active",
        "upgrading",
      ])) {
        try {
          // N2: codes off is nothing to rotate, whatever the state; a
          // test-hooks install keeps the test pair.
          if (
            row.test_hooks === 1 ||
            (row.vars !== null && !codesOn(this.currentVars(row)))
          ) {
            out.push({ id: row.id, ok: true, rotated: false });
            continue;
          }
          if (row.state !== "active")
            throw new ProvisionRefused(
              `install ${row.id} is ${row.state}; rerun the rotation once it is active`,
            );
          if (row.session_cut !== null)
            throw new ProvisionRefused(
              `install ${row.id}: pending session cut: re-run updateVars first`,
            );
          this.currentVars(row);
          const cur = await this.storedOf(row, row.version as string);
          const site = (
            (cur.metadata.bindings ?? []) as { name: string; text?: string }[]
          ).find((b) => b.name === "TURNSTILE_SITE_KEY")?.text;
          if (site !== ts.sitekey)
            throw new ProvisionRefused(
              `install ${row.id} uses another Turnstile sitekey; a var change sets the new one`,
            );
          await this.claim(row, ["active"], "active", "turnstile");
          try {
            const script = names(row.id, this.env).script;
            assertOwnResource(script, this.env);
            await this.hold();
            await this.cf.secretPut(
              this.target,
              script,
              "TURNSTILE_SECRET",
              ts.secret,
            );
            await this.logged("turnstile.rotate", { sitekey: ts.sitekey });
            await this.release("active");
          } catch (e) {
            if (!(e instanceof LostLease))
              await this.releaseQuietly("active", e);
            throw e;
          }
          out.push({ id: row.id, ok: true, rotated: true });
        } catch (e) {
          out.push({
            id: row.id,
            ok: false,
            rotated: false,
            reason: this.reasonOf(e),
          });
        }
      }
      return out;
    });
  }

  /** L1: the name Cloudflare holds for the id about to be deleted must be names(id)'s. */
  private assertDeletes(actual: string, want: string): void {
    assertOwnResource(actual, this.env);
    if (actual !== want) throw new ForeignResource(actual, this.env);
  }

  /**
   * Review Focus 4: confirm must equal the id. Unmaps first (HOSTS, then the
   * hosts rows), so the dispatch Worker 404s at once; then the registry
   * entry's directory copy and then the entry, the script, KV, R2 (emptied first), D1 and the local token files.
   * The row ends deleted and stays, holding the slug. Each step checks first
   * and renews the lock, so a rerun after a partial failure finishes the job.
   */
  async delete(
    id: InstallId,
    confirm: string,
    o: DeleteOptions = {},
  ): Promise<DeleteResult> {
    return this.guarded(async () => {
      if (typeof confirm !== "string" || confirm !== id)
        throw new ProvisionRefused(
          "delete needs confirm to be exactly the install id",
        );
      const skip = skipReason(o?.skipDirectoryRevoke);
      let row = await this.openInstall(
        id,
        ["creating", "active", "deleting", "deleted"],
        "warn",
      );
      if (row.state === "deleted") {
        // R2-N2: a HOSTS put that landed in the lease's TOCTOU window (a
        // stalled create) still maps a host to this deleted id; clear it.
        // deleted is terminal, so no operation can claim the row meanwhile.
        let stale = 0;
        for (const h of [row.app_host, row.content_host]) {
          if ((await this.cf.kvGet(this.hostsKv.id, h)) !== id) continue;
          assertOwnResource(this.hostsKv.title, this.env);
          await this.cf.kvDeleteKey(this.hostsKv.id, h);
          stale++;
        }
        if (stale > 0)
          await this.platform.audit(id, "delete.unmap_stale", { hosts: stale });
        return { id, ok: true, state: "deleted" };
      }
      // L2, R-M1: a creating row only once its create lease has expired (or
      // was released by a failed create); the claim's CAS settles a race.
      if (
        row.state === "creating" &&
        row.lease_until !== null &&
        row.lease_until > this.now()
      )
        throw new ProvisionRetry(
          `install ${id} is creating and its create still holds the lease; retry once it ends or the lease expires`,
          "lease_held",
        );

      // H-DV phase 1: deleting + pending (or skipped), hosts still mapped,
      // so the install can still run the scheduler's revoke job; the lease
      // is released while the scheduler works. A rerun skips this unless
      // the revoke was never started, or a skip replaces a pending/failed one.
      // Every read-only refusal first (a D1 or KV id that isn't names(id)'s),
      // so a refused delete writes nothing, phase 1 included.
      await this.resources(row, true);
      const revoke = row.directory_revoke;
      // M1: a skipped row counts only with its reason in hosted_audit.
      const skipAudited =
        revoke === "skipped" && (await this.platform.hasSkipAudit(id));
      // M1b/M2: only a fresh done or an audited skip is settled; anything
      // else (pending, failed, unsupported, a stale done) starts a new attempt.
      const settled = freshDone(row) || (revoke === "skipped" && skipAudited);
      const phase1 =
        row.state !== "deleting" ||
        (!settled && (revoke !== "skipped" || skip !== undefined));
      // A skip replaces a pending/failed/unsupported attempt, never a done.
      const useSkip = skip !== undefined && revoke !== "done";
      if (phase1) {
        await this.claim(
          row,
          ["creating", "active", "deleting"],
          "deleting",
          "delete",
        );
        try {
          if (useSkip) {
            // M1: the reason first; an orphan audit row is harmless, a
            // skipped row with no reason is not.
            await this.logged("delete.revoke_skipped", { reason: skip });
            await this.write({ directory_revoke: "skipped" });
          } else {
            // M1b: each attempt records its start and resets the count.
            await this.write({
              directory_revoke: "pending",
              directory_revoke_attempts: 0,
              directory_revoke_requested_at: this.now(),
              directory_revoked_at: null,
            });
            await this.logged("delete.revoke_pending", {});
            // M1a: unmap now; the revoke job needs no HOSTS entry, and the
            // dispatch Worker stops serving the install at once. Teardown's
            // unmap is then an idempotent no-op.
            await this.unmapHosts(row, id);
          }
          await this.release("deleting");
        } catch (e) {
          if (!(e instanceof LostLease))
            await this.releaseQuietly("deleting", e);
          throw e;
        }
      }
      const wroteSkip = phase1 && useSkip;
      if (wroteSkip) this.notes.push(DIRECTORY_REVOKE_SKIPPED_NOTE);

      // Phase 2: wait for the scheduler (every 15 s, up to 10 minutes).
      if (!wroteSkip)
        for (let waited = 0; ; waited += REVOKE_POLL_MS) {
          const st = await this.platform.revokeState(id);
          if (!st) throw new ProvisionRefused(`install ${id} not found`);
          await o?.onPoll?.({
            state: st.state,
            attempts: st.attempts,
            waitedMs: waited,
          });
          if (st.state === "skipped") {
            if (!(await this.platform.hasSkipAudit(id)))
              throw new ProvisionRefused(
                `install ${id}: the directory revoke was skipped with no recorded reason; rerun with --skip-directory-revoke "<reason>"`,
              );
            this.notes.push(DIRECTORY_REVOKE_SKIPPED_NOTE);
            break;
          }
          if (st.state === "unsupported") {
            // M2: it can't confirm the revoke, so it never auto-proceeds.
            await this.platform.audit(id, "delete.revoke_unsupported", {});
            throw new ProvisionRefused(
              `install ${id} is below ${REVOKE_MIN_VERSION} and can't confirm the Google revoke; upgrade it or pass --skip-directory-revoke <reason>`,
            );
          }
          if (st.state === "done") {
            if (
              freshDone({
                directory_revoke: "done",
                directory_revoked_at: st.revokedAt,
                directory_revoke_requested_at: st.requestedAt,
              })
            )
              break;
            // M1b: a done from an earlier attempt; dispatch a fresh one.
            await this.platform.redispatchRevoke(id);
          }
          if (st.state === "failed")
            throw new ProvisionRefused(
              `install ${id}: the directory revoke failed after ${st.attempts} attempts; the row stays deleting. Rerun delete with --skip-directory-revoke "<reason>" to tear down anyway (${DIRECTORY_REVOKE_SKIPPED_NOTE})`,
            );
          if (waited >= REVOKE_WAIT_MS)
            throw new ProvisionRetry(
              `install ${id}: the directory revoke is still pending after 10 minutes; rerun delete to resume (the scheduler retries every 2 minutes)`,
              "revoke_pending",
            );
          await this.sleep(REVOKE_POLL_MS);
        }

      // Teardown, unchanged and resumable, on the row as it is now.
      const now = await this.platform.byId(id);
      if (now?.state !== "deleting")
        throw new ProvisionRefused(
          `install ${id} is ${now?.state ?? "gone"}; it is no longer deleting`,
        );
      // Defense in depth: the revoke must still be settled, and fresh.
      if (now.directory_revoke === "done" && !freshDone(now)) {
        await this.platform.redispatchRevoke(id);
        throw new ProvisionRetry(
          `install ${id}: the directory revoke was not confirmed for this attempt; a fresh one is dispatched, rerun delete`,
          "revoke_pending",
        );
      }
      if (now.directory_revoke !== "done" && now.directory_revoke !== "skipped")
        throw new ProvisionRetry(
          `install ${id}: the directory revoke is no longer settled (${now.directory_revoke ?? "none"}); rerun delete`,
          "revoke_pending",
        );
      row = now;
      const { cf, env, target } = this;
      const n = names(id, env);
      const res = await this.resources(row, true);
      const regTitle = platformNames(env).registry;
      const regId = await cf.kvFind(regTitle);
      const dirTitle = platformNames(env).directoryRegistry;
      const dirId = await cf.kvFind(dirTitle);

      await this.claim(row, ["deleting"], "deleting", "delete");
      try {
        await this.logged("delete.start", {});
        await this.unmapHosts(row, id);
        // L1: the directory copy first, then the broker entry, so the
        // directory never trusts a key that sign-in has dropped. A rerun
        // redoes both.
        if (dirId) {
          assertOwnResource(dirTitle, env);
          await this.hold();
          await cf.kvDeleteKey(dirId, registryKey(id));
        }
        if (regId) {
          assertOwnResource(regTitle, env);
          await this.hold();
          await cf.kvDeleteKey(regId, registryKey(id));
        }
        if (await cf.scriptExists(target, n.script)) {
          assertOwnResource(n.script, env);
          await this.hold();
          await cf.scriptDelete(target, n.script);
        }
        if (res.kv) {
          const title = await cf.kvTitleOf(res.kv);
          if (title !== null) {
            this.assertDeletes(title, n.kv);
            await this.hold();
            await cf.kvDelete(res.kv);
          }
        }
        if (await cf.r2Exists(n.r2)) {
          assertOwnResource(n.r2, env);
          await this.emptyBucket(n.r2);
          await this.hold();
          await cf.r2Delete(n.r2);
        }
        if (res.d1) {
          const name = await cf.d1NameOf(res.d1);
          if (name !== null) {
            this.assertDeletes(name, n.d1);
            await this.hold();
            await cf.d1Delete(res.d1);
          }
        }
        // L8: the owner PAT and hook key of a deleted host are dead weight.
        // With no patDir (the provisioner Worker) there is no file.
        const dir = this.o.patDir;
        if (dir !== undefined)
          for (const f of [
            `${row.app_host}-pat-token`,
            `${row.app_host}-hook-key`,
          ])
            rmSync(join(dir, f), { force: true });
        await this.release("deleted");
        await this.platform.audit(id, "delete.done", {});
        return { id, ok: true, state: "deleted" };
      } catch (e) {
        // Stays deleting; the lock goes so a rerun can resume at once.
        if (!(e instanceof LostLease)) await this.releaseQuietly("deleting", e);
        throw e;
      }
    });
  }

  /** Unmaps the install's HOSTS keys and hosts rows; idempotent. */
  private async unmapHosts(
    row: { app_host: string; content_host: string },
    id: InstallId,
  ): Promise<void> {
    for (const h of [row.app_host, row.content_host]) {
      const cur = await this.cf.kvGet(this.hostsKv.id, h);
      if (cur === null) continue;
      if (cur !== id) {
        this.notes.push(`HOSTS ${h} maps to ${cur}, not ${id}; left alone`);
        continue;
      }
      assertOwnResource(this.hostsKv.title, this.env);
      await this.hold();
      await this.cf.kvDeleteKey(this.hostsKv.id, h);
    }
    await this.hold();
    await this.platform.unmapHosts(id);
  }

  /** Deletes every object, a listing page at a time (lock renewed each page), until a listing comes back empty. */
  private async emptyBucket(bucket: string): Promise<void> {
    for (let page = 0; page < 100_000; page++) {
      await this.hold();
      const keys = await this.cf.r2InstallKeys(bucket);
      if (keys.length === 0) return;
      for (const k of keys) await this.cf.r2InstallDeleteObject(bucket, k);
    }
    throw new Error(`R2 bucket ${bucket} did not empty`);
  }

  /** The release's D1 migrations in order, recorded in d1_migrations as wrangler does. */
  private async migrate(
    rec: ReleaseRecord,
    d1Id: string,
    d1Name: string,
  ): Promise<void> {
    // M1: re-read from the release and re-check right before applying.
    const files = await this.readMigrations(rec);
    assertOwnResource(d1Name, this.env);
    await this.cf.d1Query(
      d1Id,
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    const r = await this.cf.d1Query(d1Id, "SELECT name FROM d1_migrations");
    const done = new Set((r[0]?.results ?? []).map((x) => String(x.name)));
    assertMigrationOrder(
      files.map((f) => f.name),
      done,
      rec.version,
    );
    for (const f of files) {
      if (done.has(f.name)) continue;
      if (!MIGRATION_RE.test(f.name))
        throw new Error(`unexpected migration file name ${f.name}`);
      const sql = new TextDecoder().decode(f.bytes).trimEnd();
      assertOwnResource(d1Name, this.env);
      // One query: the file and its record land together or not at all.
      await this.cf.d1Query(
        d1Id,
        `${sql}${sql.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${f.name}');`,
      );
    }
  }

  /** H-RD: the registry's domains from AUTH_DOMAINS; refused in pre-flight, before any write. */
  private registryDomainsOf(vars: Record<string, string>): string[] {
    try {
      return registryDomains(vars.AUTH_DOMAINS);
    } catch (e) {
      throw new ProvisionRefused((e as Error).message);
    }
  }

  /** The entry, written to the broker registry and then, identical, to its directory copy. */
  private async putEntry(
    id: InstallId,
    appHost: string,
    e: Omit<RegistryEntry, "installId" | "origin">,
  ): Promise<void> {
    const reg = this.registryKv as { id: string; title: string };
    const dir = this.directoryKv as { id: string; title: string };
    const value = registryEntry({
      installId: id,
      origin: brokerOrigin(appHost),
      ...e,
    });
    assertBrokerOrigin(value.origin, appHost);
    const text = JSON.stringify(value);
    assertOwnResource(reg.title, this.env);
    await this.cf.kvPut(reg.id, registryKey(id), text);
    assertOwnResource(dir.title, this.env);
    await this.cf.kvPut(dir.id, registryKey(id), text);
  }

  /**
   * H-RD: after a var change is live, both copies carry its domains, with the
   * same keys. No entry yet: create's broker step owns writing the first one.
   * Each copy is written only if it differs, so a rerun finishes a partial one.
   */
  private async syncRegistry(
    id: InstallId,
    appHost: string,
    domains: string[],
  ): Promise<void> {
    const reg = this.registryKv as { id: string; title: string };
    const dir = this.directoryKv as { id: string; title: string };
    const raw = await this.cf.kvGet(reg.id, registryKey(id));
    if (raw === null) return;
    const entry = JSON.parse(raw) as RegistryEntry;
    if (entry.installId !== id || entry.origin !== brokerOrigin(appHost))
      throw new ProvisionRefused(
        `broker registry entry for ${id} has another origin or id`,
      );
    const text = JSON.stringify(
      registryEntry({ ...entry, domains, disabled: entry.disabled === true }),
    );
    if (raw !== text) {
      await this.hold();
      await this.putEntry(id, appHost, {
        keys: entry.keys,
        domains,
        disabled: entry.disabled === true,
      });
      return;
    }
    if ((await this.cf.kvGet(dir.id, registryKey(id))) !== raw) {
      assertOwnResource(dir.title, this.env);
      await this.hold();
      await this.cf.kvPut(dir.id, registryKey(id), raw);
    }
  }

  /** P2 v3: add the new key -> upload BROKER_SIGNING_KEY -> journal kid -> drop the old key. */
  private async broker(
    id: InstallId,
    script: string,
    appHost: string,
    domains: string[],
  ): Promise<void> {
    const reg = this.registryKv as { id: string; title: string };
    const dir = this.directoryKv as { id: string; title: string };
    const origin = brokerOrigin(appHost);
    const raw = await this.cf.kvGet(reg.id, registryKey(id));
    const entry: RegistryEntry | null = raw === null ? null : JSON.parse(raw);
    if (entry && (entry.installId !== id || entry.origin !== origin))
      throw new ProvisionRefused(
        `broker registry entry for ${id} has another origin or id`,
      );
    const row = await this.platform.byId(id);
    const kid = row?.broker_kid ?? null;
    const secrets = await this.cf.secretList(this.target, script);
    const healthy =
      kid !== null &&
      entry !== null &&
      entry.keys.length === 1 &&
      entry.keys[0]?.kid === kid &&
      secrets.includes("BROKER_SIGNING_KEY");
    // H-DR: the directory copy is the broker entry byte for byte. A run that
    // stopped between the two writes finishes the copy here.
    const copy = async (value: string) => {
      assertOwnResource(dir.title, this.env);
      await this.cf.kvPut(dir.id, registryKey(id), value);
    };
    const put = (keys: RegistryEntry["keys"]) =>
      this.putEntry(id, appHost, {
        keys,
        domains,
        disabled: entry?.disabled === true,
      });
    if (healthy) {
      // H-RD: stale domains (or none, from before they existed) rewrite both.
      if (JSON.stringify(entry.domains ?? null) !== JSON.stringify(domains)) {
        await this.hold();
        await put(entry.keys);
      } else if ((await this.cf.kvGet(dir.id, registryKey(id))) !== raw) {
        await this.hold();
        await copy(raw as string);
      }
      return;
    }
    let keys = entry?.keys ?? [];
    if (keys.length >= 2)
      keys = [
        keys.find((k) => k.kid === kid) ??
          (keys[keys.length - 1] as RegistryEntry["keys"][0]),
      ];
    const k = newBrokerKey();
    this.sensitive.add(k.pkcs8);
    await this.hold();
    await put([...keys, { kid: k.kid, x: k.x }]);
    assertOwnResource(script, this.env);
    await this.hold();
    await this.cf.secretPut(this.target, script, "BROKER_SIGNING_KEY", k.pkcs8);
    await this.write({ broker_kid: k.kid });
    await this.hold();
    await put([{ kid: k.kid, x: k.x }]);
    await this.logged("create.broker", { kid: k.kid });
  }

  private async health(
    id: InstallId,
    appHost: string,
    version: string,
    again = "rerun create to resume",
  ): Promise<void> {
    const timeout = this.o.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    const start = this.now();
    let last = "no answer";
    for (;;) {
      try {
        const res = await this.http(`https://${appHost}/healthz`);
        if (res.status !== 200) last = `HTTP ${res.status}`;
        else {
          const j = (await res.json()) as Record<string, unknown>;
          if (j.ok !== true) last = "ok is not true";
          else if (j.plan !== "paid") last = "plan is not paid";
          else if (j.version !== version) last = `version is not ${version}`;
          else if (this.o.requireInstallId && j.installId !== id)
            last = "installId does not match";
          else return;
        }
      } catch (e) {
        last = errCode(e);
      }
      if (this.now() - start >= timeout)
        throw new Error(
          `/healthz on ${appHost} was not healthy within ${Math.round(timeout / 1000)} s (last: ${last}); ${again}`,
        );
      await this.sleep(HEALTH_INTERVAL_MS);
    }
  }

  /** Same statements as scripts/setup owner-token.ts, parameterized; hash only in SQL. */
  private async mintPat(
    d1Id: string,
    d1Name: string,
    email: string,
    appHost: string,
  ): Promise<string> {
    // Before the token row: a PAT with no file to go to is never minted.
    const dir = this.patDir();
    const pat = newPat();
    this.sensitive.add(pat);
    const tokenId = newId();
    const now = this.now();
    const hash = createHash("sha256").update(pat).digest("hex");
    const q = async (sql: string, params: unknown[]) => {
      if (!/^\s*SELECT/i.test(sql)) assertOwnResource(d1Name, this.env);
      return this.cf.d1Query(d1Id, sql, params);
    };
    await q(
      "INSERT INTO users (id, email, name, role, created_at) VALUES (?1, ?2, ?3, 'owner', ?4) ON CONFLICT(email) DO UPDATE SET role = 'owner'",
      [newId(), email, email.split("@")[0] || email, now],
    );
    const ins = await q(
      `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ?1, id, ?2, ?3, ?4 FROM users WHERE email = ?5 AND (SELECT count(*) FROM tokens WHERE user_id = users.id AND revoked_at IS NULL) < ${MAX_ACTIVE_TOKENS}`,
      [tokenId, TOKEN_LABEL, hash, now, email],
    );
    if (!ins[0]?.meta?.changes)
      throw new ProvisionRefused(
        `the owner already has ${MAX_ACTIVE_TOKENS} active tokens; revoke some, then rerun`,
      );
    const ok = await q(
      "SELECT id FROM tokens WHERE id = ?1 AND revoked_at IS NULL",
      [tokenId],
    );
    if (!ok[0]?.results?.length)
      throw new Error(`token row ${tokenId} missing after the insert; rerun`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${appHost}-pat-token`);
    try {
      writeSecretFile(file, `${pat}\n`);
    } catch (e) {
      await q("UPDATE tokens SET revoked_at = ?1 WHERE id = ?2", [
        this.now(),
        tokenId,
      ]).catch(() => {});
      throw new Error(
        `could not save the owner token to ${file} (${errCode(e)}); the new token was revoked; fix that and rerun`,
      );
    }
    // Earlier provision tokens (from a failed earlier run) are retired once the new one is saved.
    await q(
      "UPDATE tokens SET revoked_at = ?1 WHERE user_id = (SELECT id FROM users WHERE email = ?2) AND label = ?3 AND revoked_at IS NULL AND id <> ?4",
      [this.now(), email, TOKEN_LABEL, tokenId],
    );
    return file;
  }

  /** The CI label, checked; undefined when the CI token is off. */
  private ciLabel(): string | undefined {
    const c = this.o.ciOwnerToken;
    if (c === undefined) return undefined;
    if (!isTokenLabel(c?.label))
      throw new ProvisionRefused(
        "ciOwnerToken.label must be ci-<run id> or ss-<ULID>",
      );
    return c.label;
  }

  /** The token end-date cap in days, checked (an integer, 1 to 400). */
  /**
   * The job kind pause and unpause run under: it names the lease and picks
   * the near-expiry mode (NEAR_EXPIRY_MODE: suspend and delete warn,
   * resume and restore refuse).
   */
  private jobKind(o: { kind: ProvisionJobKind } | undefined): {
    kind: ProvisionJobKind;
    nearExpiry: "refuse" | "warn";
  } {
    const kind = o?.kind;
    if (!(PROVISION_JOB_KINDS as readonly string[]).includes(kind as string))
      throw new ProvisionRefused(`unknown job kind ${String(kind)}`);
    return {
      kind: kind as ProvisionJobKind,
      nearExpiry: NEAR_EXPIRY_MODE[kind as ProvisionJobKind],
    };
  }

  /**
   * Where an operator puts a rolled token: the provisioner's Secrets Store
   * secret (maxTokenDays above the CLI's cap), else the CLI's
   * CLOUDFLARE_API_TOKEN (deploy Environment in CI, the keychain on a laptop).
   */
  private tokenHome(): string {
    return this.maxTokenDays() > DEFAULT_MAX_TOKEN_DAYS
      ? `paste it into Secrets Store (\`${platformNames(this.env).provisionToken}\`)`
      : "update CLOUDFLARE_API_TOKEN (the deploy Environment secret in CI, the keychain item on a laptop)";
  }

  private maxTokenDays(): number {
    const d = this.o.maxTokenDays ?? DEFAULT_MAX_TOKEN_DAYS;
    if (!Number.isSafeInteger(d) || d < 1 || d > PROVISIONER_MAX_TOKEN_DAYS)
      throw new ProvisionRefused(
        `maxTokenDays must be an integer from 1 to ${PROVISIONER_MAX_TOKEN_DAYS}`,
      );
    return d;
  }

  /** The PAT directory, for the files only a laptop or redline run writes. */
  private patDir(): string {
    const d = this.o.patDir;
    if (typeof d !== "string" || d === "")
      throw new ProvisionRefused("patDir is required without ciOwnerToken");
    return d;
  }

  /** With ciOwnerToken: the CI token, right after the claim (under the lease). */
  private async ciTokenUnderLease(
    d1Id: string,
    d1Name: string,
    email: string,
  ): Promise<void> {
    if (!this.o.ciOwnerToken) return;
    await this.hold();
    await this.mintCiToken(d1Id, d1Name, email, false);
  }

  /**
   * An owner PAT labelled ci-<run id>, held only in this operation's context
   * (never a file, a note, a result or an error: it is in the redaction set).
   * `upsertOwner` (create only) makes the owner row as mintPat does; the
   * lifecycle operations need the owner row to exist already.
   */
  private async mintCiToken(
    d1Id: string,
    d1Name: string,
    email: string,
    upsertOwner: boolean,
  ): Promise<void> {
    const label = this.ciLabel() as string;
    const c = this.ctx.getStore();
    if (!c || !this.held)
      throw new Error("the CI token is minted under a lease");
    if (c.ci) throw new Error("this operation already holds a CI token");
    const pat = newPat();
    this.sensitive.add(pat);
    const tokenId = newId();
    const now = this.now();
    const hash = createHash("sha256").update(pat).digest("hex");
    const q = async (sql: string, params: unknown[]) => {
      if (!/^\s*SELECT/i.test(sql)) assertOwnResource(d1Name, this.env);
      return this.cf.d1Query(d1Id, sql, params);
    };
    if (upsertOwner)
      await q(
        "INSERT INTO users (id, email, name, role, created_at) VALUES (?1, ?2, ?3, 'owner', ?4) ON CONFLICT(email) DO UPDATE SET role = 'owner'",
        [newId(), email, email.split("@")[0] || email, now],
      );
    else {
      const u = await q("SELECT id FROM users WHERE email = ?1", [email]);
      if (!u[0]?.results?.length)
        throw new ProvisionRefused(
          "the install has no owner user for the CI selftest token",
        );
    }
    // Recorded before the insert: a lost reply still gets revoked by id.
    c.ci = { pat, tokenId, d1Id, d1Name };
    const ins = await q(
      `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ?1, id, ?2, ?3, ?4 FROM users WHERE email = ?5 AND (SELECT count(*) FROM tokens WHERE user_id = users.id AND revoked_at IS NULL) < ${MAX_ACTIVE_TOKENS}`,
      [tokenId, label, hash, now, email],
    );
    if (!ins[0]?.meta?.changes)
      throw new ProvisionRefused(
        `the owner already has ${MAX_ACTIVE_TOKENS} active tokens; revoke some, then rerun`,
      );
    await this.logged("ci_token.mint", { label });
  }

  /**
   * Revokes this operation's CI token, if any, and reads it back. Called
   * before every lease release and once more when the operation ends. A
   * failure is a note (the run's ci-token-sweep revokes and verifies), never
   * a mask over the operation's own result.
   */
  private async revokeCiToken(): Promise<void> {
    const c = this.ctx.getStore();
    const t = c?.ci;
    if (!c || !t) return;
    c.ci = null;
    try {
      assertOwnResource(t.d1Name, this.env);
      await this.cf.d1Query(
        t.d1Id,
        "UPDATE tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
        [this.now(), t.tokenId],
      );
      const left = await this.cf.d1Query(
        t.d1Id,
        "SELECT id FROM tokens WHERE id = ?1 AND revoked_at IS NULL",
        [t.tokenId],
      );
      if (left[0]?.results?.length) throw new Error("still active");
      const h = this.held;
      if (h)
        await this.platform
          .audit(h.id, "ci_token.revoke", { label: this.ciLabel() as string })
          .catch(() => {});
    } catch (e) {
      this.notes.push(
        `the CI owner token was not revoked (${errCode(e)}); ci-token-sweep revokes it`,
      );
    }
  }

  /**
   * The CI backstop: revokes every still-active owner token labelled exactly
   * `label` (ci-<run id> or ss-<ULID>; never a prefix or pattern) in the
   * install's D1, then lists them again and refuses unless none remains. Takes no lease: it runs after the operation, which
   * may have crashed holding one. An install with no D1 has no token.
   */
  async ciTokenSweep(
    id: InstallId,
    label: string,
  ): Promise<{ id: InstallId; label: string; revoked: number; active: 0 }> {
    return this.guarded(async () => {
      if (!isInstallId(id)) throw new ProvisionRefused("not an install id");
      if (!isTokenLabel(label))
        throw new ProvisionRefused(
          "the sweep label must be ci-<run id> or ss-<ULID>",
        );
      this.checkOptions();
      await this.checkToken("warn");
      await this.resolvePlatform();
      const row = await this.platform.byId(id);
      if (!row) throw new ProvisionRefused(`install ${id} not found`);
      // A deleted install's D1 is gone, and its tokens with it.
      const { d1 } = await this.resources(row, true);
      if (!d1) return { id, label, revoked: 0, active: 0 as const };
      const d1Name = names(id, this.env).d1;
      const active = async () =>
        (
          await this.cf.d1Query(
            d1,
            "SELECT id FROM tokens WHERE label = ?1 AND revoked_at IS NULL",
            [label],
          )
        )[0]?.results?.length ?? 0;
      const before = await active();
      if (before > 0) {
        assertOwnResource(d1Name, this.env);
        await this.cf.d1Query(
          d1,
          "UPDATE tokens SET revoked_at = ?1 WHERE label = ?2 AND revoked_at IS NULL",
          [this.now(), label],
        );
        await this.platform
          .audit(id, "ci_token.sweep", { label, revoked: before })
          .catch(() => {});
      }
      // The verification: a fresh read, never the UPDATE's own count.
      const left = await active();
      if (left !== 0)
        throw new ProvisionRefused(
          `install ${id}: ${left} owner token(s) labelled ${label} are still active after the sweep; revoke them by label`,
        );
      return { id, label, revoked: before, active: 0 as const };
    });
  }

  /** An MCP session on the install as its owner (the PAT is scrubbed from every error, L6). */
  private mcp(appHost: string, patFile: string | undefined) {
    const token =
      patFile === undefined
        ? this.ctx.getStore()?.ci?.pat
        : readFileSync(patFile, "utf8").trim();
    if (!token) throw new Error("no owner token for the MCP selftest");
    this.sensitive.add(token);
    const url = `https://${appHost}/mcp`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    let seq = 0;
    // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC results are arbitrary JSON
    const post = async (method: string, params: unknown): Promise<any> => {
      const id = ++seq;
      const res = await this.http(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!res.ok) throw new McpError(method, res.status);
      const text = await res.text();
      const msgs = res.headers.get("content-type")?.includes("event-stream")
        ? text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => JSON.parse(l.slice(5)))
        : [JSON.parse(text)];
      const msg = msgs.find((x: { id?: number }) => x.id === id);
      if (!msg || msg.error)
        throw new Error(`MCP ${method}: ${msg?.error?.code ?? "no response"}`);
      return msg.result;
    };
    const initialize = async () => {
      await post("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oa-provision", version: "1" },
      });
      await this.http(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
    };
    const getWelcome = async (artId: string) => {
      const got = await post("tools/call", {
        name: "get_artifact",
        arguments: { id: artId },
      });
      const body = got?.structuredContent?.content ?? got?.content?.[0]?.text;
      if (
        got?.isError ||
        typeof body !== "string" ||
        !body.includes(WELCOME_TITLE)
      )
        throw new Error(
          `MCP get_artifact did not return the welcome artifact ${artId}`,
        );
    };
    return { post, initialize, getWelcome };
  }

  /** As setup's selftest: publish a private Welcome artifact over MCP and read it back. Create only. */
  private async selftest(
    rec: ReleaseRecord,
    appHost: string,
    patFile: string | undefined,
  ): Promise<string> {
    const c = this.mcp(appHost, patFile);
    await c.initialize();
    const { tools } = await c.post("tools/list", {});
    if (!tools?.some((t: { name: string }) => t.name === "publish_artifact"))
      throw new Error("MCP tools/list has no publish_artifact");
    // F3: the release's text, re-read and re-checked right before publishing.
    const content = await this.readWelcome(rec);
    const pub = await c.post("tools/call", {
      name: "publish_artifact",
      arguments: { title: WELCOME_TITLE, format: "markdown", content },
    });
    const artId = pub?.structuredContent?.id;
    if (pub?.isError || typeof artId !== "string")
      throw new Error("MCP publish_artifact failed");
    await c.getWelcome(artId);
    return artId;
  }

  /**
   * M2, R-M2: the lifecycle selftest, read-only and independent of what the
   * owner keeps: initialize, tools/list and an authenticated list_artifacts
   * (it succeeds on an empty account). Nothing is published.
   */
  private async checkSelf(
    appHost: string,
    patFile: string | undefined,
  ): Promise<void> {
    const c = this.mcp(appHost, patFile);
    await c.initialize();
    const { tools } = await c.post("tools/list", {});
    if (!tools?.some((t: { name: string }) => t.name === "list_artifacts"))
      throw new Error("MCP tools/list has no list_artifacts");
    const r = await c.post("tools/call", {
      name: "list_artifacts",
      arguments: {},
    });
    if (r?.isError) throw new Error("MCP list_artifacts failed");
  }
}
