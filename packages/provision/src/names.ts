import { parseDomains } from "@oa/auth-core/domains";
import type { InstallId } from "./types.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_RE = /^i[a-z0-9]{11}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const RESERVED_SLUGS: readonly string[] = [
  "www",
  "api",
  "admin",
  "app",
  "mail",
  "status",
  "docs",
  "staging",
  "content",
  // Platform hosts on the tenant domains (P2 auth broker at auth.<app-domain>,
  // P3 directory broker at directory.<app-domain>).
  "auth",
  "broker",
  "login",
  "sso",
  "directory",
  // The billing Worker's public Stripe webhook (billing.<app-domain>).
  "billing",
];

export function isInstallId(s: string): s is InstallId {
  return ID_RE.test(s);
}

/** "i" + 11 base32 chars; a 5-bit mask over random bytes, so no modulo bias. */
export function newInstallId(): InstallId {
  const bytes = crypto.getRandomValues(new Uint8Array(11));
  let out = "i";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export type Env = "staging" | "prod";

/** The tenant domain pair of each env (user decision, 2026-10-21). Dispatch,
 * the scheduler and billing build and check an install's app host from it. */
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

/** A trial's length from its start: the billing Worker and the backfill. */
export const TRIAL_MS = 14 * 86_400_000;

/**
 * Platform-wide var defaults per env, rendered at create for a name the
 * caller does not pass (a caller value wins; updateVars changes or clears
 * them). An empty value is no default. The free-plan caps are off until
 * their numbers are picked.
 * Change a default only when no install is in `creating`: the defaults are
 * part of create's inputs hash, so a resume would refuse.
 */
export const HOSTED_DEFAULT_VARS: Readonly<
  Record<Env, Readonly<Record<string, string>>>
> = Object.freeze({
  staging: Object.freeze({
    FREE_STORAGE_BYTES: "",
    FREE_DATA_DOCS: "",
    FREE_DATA_DAILY_WRITES: "",
  }),
  prod: Object.freeze({
    FREE_STORAGE_BYTES: "",
    FREE_DATA_DOCS: "",
    FREE_DATA_DAILY_WRITES: "",
  }),
});

/** The caller's vars plus each non-empty default it does not set. */
export function withDefaultVars(
  vars: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): Record<string, string> {
  const out = { ...vars };
  for (const [k, v] of Object.entries(defaults))
    if (v !== "" && !Object.hasOwn(out, k)) out[k] = v;
  return out;
}

const APP_LABEL = /^[a-z0-9-]+$/;

/**
 * True only for `<label>.<env app domain>`, the shape of an install's app
 * host. Billing accepts the gate's app host only in this shape.
 */
export function isAppHost(host: unknown, env: Env): host is string {
  if (typeof host !== "string" || !Object.hasOwn(HOSTED_DOMAINS, env))
    return false;
  const suffix = `.${HOSTED_DOMAINS[env].app}`;
  return host.endsWith(suffix) && APP_LABEL.test(host.slice(0, -suffix.length));
}

/**
 * The app host of the install that holds `host` (its app or its content
 * host: both are <slug>.<domain>, the same slug), or null for any other
 * name. Dispatch calls it only with a host HOSTS maps to the install.
 */
export function appHostFor(host: string, env: Env): string | null {
  if (!Object.hasOwn(HOSTED_DOMAINS, env)) return null;
  const { app, content } = HOSTED_DOMAINS[env];
  for (const d of [app, content]) {
    const slug = host.endsWith(`.${d}`) ? host.slice(0, -d.length - 1) : "";
    if (APP_LABEL.test(slug)) return `${slug}.${app}`;
  }
  return null;
}

/** Every hosted resource name carries its environment; the account is shared. */
export const ENV_PREFIX: Readonly<Record<Env, string>> = Object.freeze({
  staging: "oa-s-",
  prod: "oa-p-",
});

export class ForeignResource extends Error {
  constructor(name: string, env?: unknown) {
    super(
      `refusing to touch ${JSON.stringify(name)}: not an ${String(env)} resource`,
    );
    this.name = "ForeignResource";
  }
}

/** Throws unless `name` starts with the exact prefix of `env` (case-sensitive). */
export function assertOwnResource(name: string, env: Env): void {
  const p = Object.hasOwn(ENV_PREFIX, env) ? ENV_PREFIX[env] : undefined;
  if (p === undefined || typeof name !== "string" || !name.startsWith(p))
    throw new ForeignResource(String(name), env);
}

export function names(
  id: InstallId,
  env: Env,
): { script: string; d1: string; r2: string; kv: string } {
  if (!Object.hasOwn(ENV_PREFIX, env)) throw new ForeignResource(id, env);
  const p = ENV_PREFIX[env];
  return {
    script: `${p}${id}`,
    d1: `${p}${id}`,
    r2: `${p}${id}`,
    kv: `${p}${id}-oauth`,
  };
}

export function platformNames(env: Env): {
  db: string;
  releases: string;
  registry: string;
  scheduler: string;
  inventory: string;
  broker: string;
  directoryBroker: string;
  directoryRegistry: string;
  dispatch: string;
  hosts: string;
  turnstile: string;
  billing: string;
} {
  if (!Object.hasOwn(ENV_PREFIX, env)) throw new ForeignResource("", env);
  const p = ENV_PREFIX[env];
  return {
    db: `${p}platform`,
    releases: `${p}releases`,
    registry: `${p}broker-registry`,
    scheduler: `${p}scheduler`,
    inventory: `${p}inventory`,
    broker: `${p}auth-broker`,
    // P3 directory broker. It binds only directoryRegistry, a copy of the
    // install registry that provision keeps: KV has no read-only binding, so
    // it must never bind the sign-in registry above.
    directoryBroker: `${p}directory-broker`,
    directoryRegistry: `${p}directory-registry`,
    dispatch: `${p}dispatch`,
    // HOSTS KV (host -> install id): written by create/delete, read by dispatch.
    hosts: `${p}hosts`,
    // The one Turnstile widget of the env (created once by Task 8's init).
    turnstile: `${p}turnstile`,
    // The tier store: the billing Worker and its own D1 share this name.
    billing: `${p}billing`,
  };
}

export function hosts(
  slug: string,
  domains: { app: string; content: string },
): { appHost: string; contentHost: string } {
  // "--" at positions 3-4 is IDNA-reserved ("xn--" is punycode): a slug
  // like that could render as another name (homograph).
  if (
    !SLUG_RE.test(slug) ||
    RESERVED_SLUGS.includes(slug) ||
    slug.slice(2, 4) === "--"
  ) {
    throw new Error(`invalid slug: ${slug}`);
  }
  const { app, content } = domains;
  if (
    app === content ||
    app.endsWith(`.${content}`) ||
    content.endsWith(`.${app}`)
  ) {
    throw new Error("app and content domain must be distinct and not nested");
  }
  return { appHost: `${slug}.${app}`, contentHost: `${slug}.${content}` };
}

// The install registry format, shared by provision (the writer) and the auth
// broker (the reader, apps/auth-broker/src/registry.ts, which imports these
// from @oa/provision/names in its contract test).
export interface RegistryEntry {
  installId: string;
  origin: string;
  keys: { kid: string; x: string }[];
  /** The install's AUTH_DOMAINS: lowercase A-labels, unique, sorted; [] when none. */
  domains: string[];
  disabled?: boolean;
}

/** The broker refuses an entry with more (#564). */
export const REGISTRY_MAX_DOMAINS = 50;

/**
 * An install's registry domains from its AUTH_DOMAINS, through the parser the
 * server and the broker use (@oa/auth-core), never a copy of it.
 */
export function registryDomains(authDomains: string | undefined): string[] {
  const { domains, invalid } = parseDomains(authDomains ?? "");
  if (invalid.length > 0)
    throw new Error(
      `AUTH_DOMAINS has an invalid domain (${invalid.length} invalid)`,
    );
  if (domains.length > REGISTRY_MAX_DOMAINS)
    throw new Error(
      `AUTH_DOMAINS has more than ${REGISTRY_MAX_DOMAINS} domains`,
    );
  return domains.sort();
}

/** The registry KV key of an install: exactly what the broker reads. */
export function registryKey(id: string): string {
  if (!isInstallId(id))
    throw new Error(`registry key: ${JSON.stringify(id)} is not an install id`);
  return `install:${id}`;
}

/**
 * An entry in the broker's shape; `domains` always (sorted), `disabled` only
 * when true. Each domain must already be in the shared parser's canonical
 * form; anything else, a duplicate or more than 50, is refused.
 */
export function registryEntry(e: RegistryEntry): RegistryEntry {
  if (e.keys.length > 2)
    throw new Error("broker registry entry would hold more than 2 keys");
  if (!Array.isArray(e.domains))
    throw new Error("broker registry entry needs a domains array");
  if (e.domains.length > REGISTRY_MAX_DOMAINS)
    throw new Error(
      `broker registry entry would hold more than ${REGISTRY_MAX_DOMAINS} domains`,
    );
  for (const d of e.domains) {
    const p = typeof d === "string" ? parseDomains(d) : null;
    if (
      !p ||
      p.invalid.length > 0 ||
      p.domains.length !== 1 ||
      p.domains[0] !== d
    )
      throw new Error("broker registry entry has an invalid domain");
  }
  if (new Set(e.domains).size !== e.domains.length)
    throw new Error("broker registry entry has a duplicate domain");
  const out: RegistryEntry = {
    installId: e.installId,
    origin: e.origin,
    keys: e.keys.map(({ kid, x }) => ({ kid, x })),
    domains: [...e.domains].sort(),
  };
  if (e.disabled === true) out.disabled = true;
  return out;
}

/** H-DV: a deleted install's owner email is purged to this after 30 days. */
export const PURGED_EMAIL = "";

/** True for a purged installs.owner_email; never use it as an address. */
export const isPurgedEmail = (v: unknown): boolean => v === PURGED_EMAIL;

/**
 * The only way to read installs.owner_email (a source test pins it): the
 * address, or null when it is purged or absent.
 */
export function ownerEmailOf(row: { owner_email?: unknown }): string | null {
  const v = row.owner_email;
  return typeof v === "string" && !isPurgedEmail(v) ? v : null;
}
