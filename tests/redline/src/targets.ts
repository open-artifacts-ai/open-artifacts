import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeRes, readBody, retryIdempotent } from "./http.ts";

// REDLINE_TARGETS: the two installs (and the prod probe) the suite runs
// against. Secrets are never in the JSON: only paths of 0600 files, read here
// and kept off the Target object (a WeakMap), so printing a Target, a test
// name or a failure never shows one.

export type Mode = "local" | "staging";

export interface Target {
  name: string;
  installId: string;
  /** App origin, e.g. https://rl-a.open-artifacts-staging.app */
  app: string;
  /** Content origin, e.g. https://rl-a.open-artifacts-staging.page */
  content: string;
  /** The only email domain the install's hooks act on (TEST_DOMAIN). */
  testDomain: string;
  /** Session cookie name: __Host-oa_session, or oa_session under ENVIRONMENT=dev. */
  cookieName: string;
  /** Optional: an admin PAT (CI secret REDLINE_<NAME>_PAT). Minted via the hook when absent. */
  patFile?: string;
  hookKeyFile: string;
  /** Optional: a Turnstile token the install accepts (hosted code sign-in needs one). */
  turnstileFile?: string;
  /** Local mode only: how to read this install's local D1. */
  local?: { wrangler: string; config: string; persistTo: string; db: string };
}

export interface ProdProbe {
  /** REDLINE_PROD_ACCOUNT_ID (a var, not a secret): 32 hex. */
  accountId: string;
  /** REDLINE_PROD_R2_TOKEN: R2 read-only, scoped to the prod releases bucket. */
  r2TokenFile: string;
  /** REDLINE_PROD_SCRIPTS_TOKEN: Workers Scripts Read for the prod namespace. */
  scriptsTokenFile: string;
  /**
   * The prod inventory origin (GET /installs). Read with a GitHub OIDC
   * bearer only (prodClean's inventoryBearer); there is no stored key.
   */
  inventoryUrl?: string;
}

export interface Targets {
  mode: Mode;
  a: Target;
  b: Target;
  /** Staging mode only: present when the prod credentials are configured. */
  prod?: ProdProbe;
  /**
   * Staging mode only: Platform's inventory Worker for this env (Bearer key):
   * GET /hosts, GET /hosts?host=, GET /installs. From REDLINE_TARGETS.inventory,
   * else env REDLINE_STG_INVENTORY_URL with <secretsDir>/REDLINE_STG_INVENTORY_KEY.
   */
  inventory?: Inventory;
  /** Staging mode only: hosts of a deleted install (REDLINE_DELETED_HOSTS, a JSON list). */
  deletedHosts?: string[];
  /**
   * Staging mode only: a hostname HOSTS maps to an install that serves neither
   * its APP_HOST nor its CONTENT_HOST (Platform's test mapping), so the
   * request reaches the install and must get the server's own 404.
   */
  strayHost?: string;
}

export interface Inventory {
  url: string;
  keyFile: string;
}

const INVENTORY_SECRETS = new WeakMap<object, string>();

/** @internal The inventory key of a loaded target set. */
export function inventoryKeyOf(i: Inventory): string {
  const k = INVENTORY_SECRETS.get(i);
  if (!k) throw new Error("inventory was not loaded with loadTargets");
  return k;
}

function parseInventory(
  v: unknown,
  secretsDir: string | undefined,
  env: Record<string, string | undefined>,
): Inventory | undefined {
  let url: unknown;
  let keyFile: unknown;
  if (v !== undefined && v !== null) {
    if (typeof v !== "object")
      throw new Error("REDLINE_TARGETS: inventory must be an object");
    ({ url, keyFile } = v as Record<string, unknown>);
  } else {
    url = env.REDLINE_STG_INVENTORY_URL;
    if (!url) return undefined;
    keyFile = secretsDir
      ? join(secretsDir, "REDLINE_STG_INVENTORY_KEY")
      : undefined;
  }
  const i: Inventory = {
    url: origin(url, "inventory.url", "staging"),
    keyFile: str(keyFile, "inventory.keyFile"),
  };
  INVENTORY_SECRETS.set(i, readSecretFile(i.keyFile, "inventory key"));
  return i;
}

/** A bare lowercase hostname (no scheme, port or path), or undefined when unset. */
function parseStrayHost(v: unknown, taken: Set<string>): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (
    typeof v !== "string" ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)
  )
    throw new Error("REDLINE_TARGETS: strayHost must be a bare hostname");
  if (taken.has(v))
    throw new Error("REDLINE_TARGETS: strayHost is a target's own host");
  return v;
}

function parseDeletedHosts(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let list = v;
  if (typeof v === "string") {
    try {
      list = JSON.parse(v);
    } catch {
      throw new Error("REDLINE_DELETED_HOSTS is not JSON");
    }
  }
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((h) => typeof h === "string" && h.trim())
  )
    throw new Error("deletedHosts must be a non-empty list of hosts");
  return list.map((h: string) => h.trim());
}

interface Secrets {
  hookKey: string;
  pat?: string;
  turnstile?: string;
}

const SECRETS = new WeakMap<object, Secrets>();
const PROD_SECRETS = new WeakMap<
  object,
  { r2Token: string; scriptsToken: string; inventoryBearer?: string }
>();

/** @internal Secrets of a loaded target (http.ts only). */
export function secretsOf(t: Target): Secrets {
  const s = SECRETS.get(t);
  if (!s) throw new Error(`target ${t.name} was not loaded with loadTargets`);
  return s;
}

/** @internal */
export function setPat(t: Target, pat: string): void {
  secretsOf(t).pat = pat;
}

/** @internal */
export function prodSecretsOf(p: ProdProbe) {
  const s = PROD_SECRETS.get(p);
  if (!s) throw new Error("prod probe was not loaded with loadTargets");
  return s;
}

/** The CI layout: secret REDLINE_<NAME>_<KIND> written to <secretsDir>/REDLINE_<NAME>_<KIND>. */
export const secretFileName = (name: string, kind: "PAT" | "HOOK_KEY") =>
  `REDLINE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${kind}`;

/** Reads a secret file: a regular file, mode 0600 (no group/other bits), non-empty. */
export function readSecretFile(path: string, what: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`${what}: file missing`);
  }
  if (!st.isFile()) throw new Error(`${what}: not a regular file`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    throw new Error(`${what}: file mode must be 0600`);
  const v = readFileSync(path, "utf8").trim();
  if (!v) throw new Error(`${what}: file is empty`);
  return v;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "")
    throw new Error(`REDLINE_TARGETS: ${what} must be a non-empty string`);
  return v.trim();
};

const LOOPBACK = (h: string) =>
  h === "127.0.0.1" || h === "localhost" || h.endsWith(".localhost");

function origin(v: unknown, what: string, mode: Mode): string {
  let u: URL;
  try {
    u = new URL(str(v, what));
  } catch {
    throw new Error(`REDLINE_TARGETS: ${what} is not a URL`);
  }
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    throw new Error(`REDLINE_TARGETS: ${what} must be a bare origin`);
  if (mode === "staging" && u.protocol !== "https:")
    throw new Error(`REDLINE_TARGETS: ${what} must be https in staging mode`);
  if (mode === "local" && !LOOPBACK(u.hostname))
    throw new Error(
      `REDLINE_TARGETS: ${what} must be a loopback host in local mode`,
    );
  return u.origin;
}

function parseTarget(
  raw: Record<string, unknown>,
  key: "a" | "b",
  mode: Mode,
  secretsDir: string | undefined,
): Target {
  const name = str(raw.name, `${key}.name`);
  const fileOr = (v: unknown, kind: "PAT" | "HOOK_KEY") =>
    typeof v === "string" && v !== ""
      ? v
      : secretsDir
        ? join(secretsDir, secretFileName(name, kind))
        : undefined;
  const hookKeyFile = fileOr(raw.hookKeyFile, "HOOK_KEY");
  if (!hookKeyFile)
    throw new Error(
      `REDLINE_TARGETS: ${key}.hookKeyFile (or secretsDir) is required`,
    );
  const patFile = fileOr(raw.patFile, "PAT");
  const t: Target = {
    name,
    installId: str(raw.installId, `${key}.installId`),
    app: origin(raw.app, `${key}.app`, mode),
    content: origin(raw.content, `${key}.content`, mode),
    testDomain: str(raw.testDomain, `${key}.testDomain`).toLowerCase(),
    cookieName:
      raw.cookieName === undefined
        ? mode === "local"
          ? "oa_session"
          : "__Host-oa_session"
        : str(raw.cookieName, `${key}.cookieName`),
    hookKeyFile,
    ...(patFile ? { patFile } : {}),
    ...(typeof raw.turnstileFile === "string" && raw.turnstileFile !== ""
      ? { turnstileFile: raw.turnstileFile }
      : {}),
  };
  if (mode === "local" && raw.local && typeof raw.local === "object") {
    const l = raw.local as Record<string, unknown>;
    t.local = {
      wrangler: str(l.wrangler, `${key}.local.wrangler`),
      config: str(l.config, `${key}.local.config`),
      persistTo: str(l.persistTo, `${key}.local.persistTo`),
      db: str(l.db, `${key}.local.db`),
    };
  }
  const hookKey = readSecretFile(hookKeyFile, `${name} hook key`);
  if (hookKey.length < 32)
    throw new Error(`${name} hook key: shorter than 32 chars`);
  const secrets: Secrets = { hookKey };
  // A PAT file named explicitly must exist; a derived one may be absent (minted).
  if (patFile && (typeof raw.patFile === "string" || exists(patFile)))
    secrets.pat = readSecretFile(patFile, `${name} PAT`);
  if (t.turnstileFile)
    secrets.turnstile = readSecretFile(
      t.turnstileFile,
      `${name} Turnstile token`,
    );
  SECRETS.set(t, secrets);
  return t;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const PROD_FILES = {
  r2TokenFile: "REDLINE_PROD_R2_TOKEN",
  scriptsTokenFile: "REDLINE_PROD_SCRIPTS_TOKEN",
} as const;

/**
 * The GitHub OIDC JWT the red-line job mints for the prod inventory's
 * audience and writes into the scanned secrets dir (design 4.4). Optional:
 * absent, prodClean fails inventory_unconfigured.
 */
export const PROD_INVENTORY_OIDC_FILE = "REDLINE_PROD_INVENTORY_OIDC";

/**
 * The prod probe: from REDLINE_TARGETS.prod, else the CI layout
 * (<secretsDir>/REDLINE_PROD_R2_TOKEN, _SCRIPTS_TOKEN, optional
 * _INVENTORY_OIDC, and env REDLINE_PROD_ACCOUNT_ID). Undefined when neither
 * is configured.
 */
export function parseProd(
  raw: Record<string, unknown> | undefined,
  secretsDir: string | undefined,
  env: Record<string, string | undefined>,
): ProdProbe | undefined {
  const r = raw ?? {};
  const file = (k: keyof typeof PROD_FILES): string | undefined =>
    typeof r[k] === "string" && r[k] !== ""
      ? (r[k] as string)
      : secretsDir
        ? join(secretsDir, PROD_FILES[k])
        : undefined;
  const accountId =
    typeof r.accountId === "string" && r.accountId !== ""
      ? r.accountId
      : env.REDLINE_PROD_ACCOUNT_ID;
  const r2TokenFile = file("r2TokenFile");
  const scriptsTokenFile = file("scriptsTokenFile");
  if (!raw && (!accountId || !r2TokenFile || !exists(r2TokenFile)))
    return undefined;
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId))
    throw new Error("prod: REDLINE_PROD_ACCOUNT_ID must be 32 hex characters");
  if (!r2TokenFile || !scriptsTokenFile)
    throw new Error("prod: the R2 and scripts token files are required");
  const p: ProdProbe = { accountId, r2TokenFile, scriptsTokenFile };
  const secrets: {
    r2Token: string;
    scriptsToken: string;
    inventoryBearer?: string;
  } = {
    r2Token: readSecretFile(r2TokenFile, "REDLINE_PROD_R2_TOKEN"),
    scriptsToken: readSecretFile(
      scriptsTokenFile,
      "REDLINE_PROD_SCRIPTS_TOKEN",
    ),
  };
  if (r.inventoryUrl !== undefined)
    p.inventoryUrl = origin(r.inventoryUrl, "prod.inventoryUrl", "staging");
  const jwtFile = secretsDir
    ? join(secretsDir, PROD_INVENTORY_OIDC_FILE)
    : undefined;
  if (jwtFile && exists(jwtFile))
    secrets.inventoryBearer = readSecretFile(jwtFile, PROD_INVENTORY_OIDC_FILE);
  PROD_SECRETS.set(p, secrets);
  return p;
}

/** Parses REDLINE_TARGETS and reads every secret file. No network. */
export function parseTargets(
  env: Record<string, string | undefined> = process.env,
): Targets {
  const json = env.REDLINE_TARGETS;
  if (!json) throw new Error("REDLINE_TARGETS is not set");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("REDLINE_TARGETS is not JSON");
  }
  const mode = raw.mode === undefined ? "staging" : raw.mode;
  if (mode !== "local" && mode !== "staging")
    throw new Error("REDLINE_TARGETS: mode must be local or staging");
  const secretsDir =
    typeof raw.secretsDir === "string" && raw.secretsDir !== ""
      ? raw.secretsDir
      : undefined;
  const obj = (v: unknown, k: string) => {
    if (!v || typeof v !== "object")
      throw new Error(`REDLINE_TARGETS: ${k} is required`);
    return v as Record<string, unknown>;
  };
  const a = parseTarget(obj(raw.a, "a"), "a", mode, secretsDir);
  const b = parseTarget(obj(raw.b, "b"), "b", mode, secretsDir);
  const distinct = (k: keyof Target) => {
    if (a[k] === b[k]) throw new Error(`REDLINE_TARGETS: a and b share ${k}`);
  };
  for (const k of [
    "name",
    "installId",
    "app",
    "content",
    "testDomain",
  ] as const)
    distinct(k);
  const hosts = new Set([a.app, a.content, b.app, b.content]);
  if (hosts.size !== 4)
    throw new Error(
      "REDLINE_TARGETS: every app and content origin must differ",
    );
  const out: Targets = { mode, a, b };
  const rawProd =
    raw.prod === undefined || raw.prod === null
      ? undefined
      : obj(raw.prod, "prod");
  if (rawProd && mode !== "staging")
    throw new Error("REDLINE_TARGETS: prod is staging mode only");
  if (mode === "staging") {
    const prod = parseProd(rawProd, secretsDir, env);
    if (prod) out.prod = prod;
    const inv = parseInventory(raw.inventory, secretsDir, env);
    if (inv) out.inventory = inv;
    const del = parseDeletedHosts(
      raw.deletedHosts ?? env.REDLINE_DELETED_HOSTS,
    );
    if (del) out.deletedHosts = del;
    const stray = parseStrayHost(
      raw.strayHost,
      new Set([...hosts].map((o) => new URL(o).hostname)),
    );
    if (stray) out.strayHost = stray;
  } else if (
    raw.inventory != null ||
    raw.deletedHosts != null ||
    raw.strayHost != null
  )
    throw new Error(
      "REDLINE_TARGETS: inventory, deletedHosts and strayHost are staging mode only",
    );
  return out;
}

export interface Healthz {
  ok?: unknown;
  testHooks?: unknown;
  installId?: unknown;
}

/** The guard: /healthz on the app host is 200 with ok, testHooks: true and this target's installId. */
export async function verifyTarget(t: Target): Promise<void> {
  const res = await retryIdempotent(new Request(`${t.app}/healthz`));
  const text = await readBody(res);
  if (res.status !== 200)
    throw new Error(`${t.name} /healthz: ${describeRes(res, text)}`);
  let h: Healthz;
  try {
    h = JSON.parse(text);
  } catch {
    throw new Error(`${t.name} /healthz: not JSON (${describeRes(res, text)})`);
  }
  if (h.ok !== true) throw new Error(`${t.name} /healthz: ok is not true`);
  if (h.testHooks !== true)
    throw new Error(
      `${t.name} /healthz: testHooks is not true (refusing a target without test hooks)`,
    );
  if (h.installId !== t.installId)
    throw new Error(`${t.name} /healthz: installId is not ${t.installId}`);
}

/** parseTargets, then the /healthz guard on both installs. */
export async function loadTargets(
  env: Record<string, string | undefined> = process.env,
): Promise<Targets> {
  const t = parseTargets(env);
  await verifyTarget(t.a);
  await verifyTarget(t.b);
  return t;
}
