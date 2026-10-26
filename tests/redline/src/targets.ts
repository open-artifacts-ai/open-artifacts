import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeRes, readBody } from "./http.ts";

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
  /** Local mode only: how to read this install's local D1. */
  local?: { wrangler: string; config: string; persistTo: string; db: string };
}

export interface ProdProbe {
  /** The P1 inventory Worker origin (GET /installs). */
  inventoryUrl: string;
  inventoryKeyFile: string;
  /** A token with Workers Scripts Read only. */
  scriptsTokenFile: string;
  accountId: string;
  /** Dispatch namespace of prod user Workers (default oa-prod). */
  namespace?: string;
  /** Script name prefix (default oa-p-). */
  scriptPrefix?: string;
  /** Cloudflare API base (default https://api.cloudflare.com/client/v4). */
  apiBase?: string;
}

export interface Targets {
  mode: Mode;
  a: Target;
  b: Target;
  /** Staging mode only, once the inventory is deployed. */
  prod?: ProdProbe;
}

interface Secrets {
  hookKey: string;
  pat?: string;
}

const SECRETS = new WeakMap<object, Secrets>();
const PROD_SECRETS = new WeakMap<
  object,
  { inventoryKey: string; scriptsToken: string }
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

function parseProd(raw: Record<string, unknown>): ProdProbe {
  const p: ProdProbe = {
    inventoryUrl: origin(raw.inventoryUrl, "prod.inventoryUrl", "staging"),
    inventoryKeyFile: str(raw.inventoryKeyFile, "prod.inventoryKeyFile"),
    scriptsTokenFile: str(raw.scriptsTokenFile, "prod.scriptsTokenFile"),
    accountId: str(raw.accountId, "prod.accountId"),
  };
  if (raw.namespace !== undefined)
    p.namespace = str(raw.namespace, "prod.namespace");
  if (raw.scriptPrefix !== undefined)
    p.scriptPrefix = str(raw.scriptPrefix, "prod.scriptPrefix");
  if (raw.apiBase !== undefined) p.apiBase = str(raw.apiBase, "prod.apiBase");
  PROD_SECRETS.set(p, {
    inventoryKey: readSecretFile(p.inventoryKeyFile, "inventory key"),
    scriptsToken: readSecretFile(p.scriptsTokenFile, "scripts token"),
  });
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
  if (raw.prod !== undefined && raw.prod !== null) {
    if (mode !== "staging")
      throw new Error("REDLINE_TARGETS: prod is staging mode only");
    out.prod = parseProd(obj(raw.prod, "prod"));
  }
  return out;
}

export interface Healthz {
  ok?: unknown;
  testHooks?: unknown;
  installId?: unknown;
}

/** The guard: /healthz on the app host is 200 with ok, testHooks: true and this target's installId. */
export async function verifyTarget(t: Target): Promise<void> {
  const res = await fetch(`${t.app}/healthz`, { redirect: "manual" });
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

const HOOK_NAMES = ["TEST_HOOK_KEY", "TEST_HOOKS"];

export interface ProdCleanOpts {
  /** App origin for an inventory host (tests point it at a fake server). */
  appOrigin?: (host: string) => string;
}

/**
 * The positive prod check. For every install the prod inventory lists: the
 * row's testHooks is false; /healthz has no testHooks: true and reports the
 * row's id; the script's secrets and settings bindings name neither
 * TEST_HOOK_KEY nor TEST_HOOKS. Throws on the first problem.
 */
export async function prodClean(
  p: ProdProbe,
  o: ProdCleanOpts = {},
): Promise<{ installs: number }> {
  const s = prodSecretsOf(p);
  const appOrigin = o.appOrigin ?? ((h: string) => `https://${h}`);
  const api = p.apiBase ?? "https://api.cloudflare.com/client/v4";
  const ns = p.namespace ?? "oa-prod";
  const prefix = p.scriptPrefix ?? "oa-p-";
  const getJson = async (url: string, token: string | null, what: string) => {
    const res = await fetch(url, {
      redirect: "manual",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    const text = await readBody(res);
    if (res.status !== 200)
      throw new Error(`prodClean ${what}: ${describeRes(res, text)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`prodClean ${what}: not JSON`);
    }
  };
  const inv = await getJson(
    `${p.inventoryUrl}/installs`,
    s.inventoryKey,
    "inventory",
  );
  const rows = inv.installs;
  if (!Array.isArray(rows))
    throw new Error("prodClean inventory: no installs array");
  for (const r of rows as Record<string, unknown>[]) {
    const id = String(r.id ?? "");
    if (!/^[a-z0-9-]{1,64}$/.test(id))
      throw new Error("prodClean: an inventory row has a bad id");
    if (r.testHooks !== false)
      throw new Error(`prodClean ${id}: inventory testHooks is not false`);
    const h = await getJson(
      `${appOrigin(String(r.appHost))}/healthz`,
      null,
      `${id} /healthz`,
    );
    if (h.testHooks === true)
      throw new Error(`prodClean ${id}: /healthz testHooks is true`);
    if (h.installId !== id)
      throw new Error(`prodClean ${id}: /healthz installId differs`);
    const base = `${api}/accounts/${encodeURIComponent(p.accountId)}/workers/dispatch/namespaces/${encodeURIComponent(ns)}/scripts/${encodeURIComponent(prefix + id)}`;
    const sec = await getJson(
      `${base}/secrets`,
      s.scriptsToken,
      `${id} secrets`,
    );
    const names = Array.isArray(sec.result)
      ? (sec.result as { name?: unknown }[]).map((x) => x.name)
      : null;
    if (!names) throw new Error(`prodClean ${id}: secrets list unreadable`);
    const set = await getJson(
      `${base}/settings`,
      s.scriptsToken,
      `${id} settings`,
    );
    const bindings = (
      set.result as { bindings?: { name?: unknown }[] } | undefined
    )?.bindings;
    if (!Array.isArray(bindings))
      throw new Error(`prodClean ${id}: settings unreadable`);
    for (const n of [...names, ...bindings.map((b) => b.name)])
      if (HOOK_NAMES.includes(String(n)))
        throw new Error(`prodClean ${id}: script lists ${String(n)}`);
  }
  return { installs: rows.length };
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
