// Upload metadata for one user Worker, in Cloudflare's multipart upload format.
// Format: https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
// Bindings: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
// The same metadata works for `/workers/scripts/{name}` (account) and the
// dispatch-namespace endpoint; only the target URL differs (not decided here).
import { normalizeVar, TUNABLES } from "@oa/shared";
import { assertOwnResource, isInstallId, names } from "./names.js";
import type { InstallId } from "./types.js";

/** Remove // and /* *\/ comments and trailing commas, leaving strings intact. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// biome-ignore lint/suspicious/noExplicitAny: the template is arbitrary JSON
export type Template = Record<string, any>;

export function parseTemplate(text: string): Template {
  return JSON.parse(stripJsonc(text)) as Template;
}

/** Template entries hosted does not upload as bindings, each with a reason. */
export const TEMPLATE_BINDINGS_EXCLUDED: Record<string, string> = {
  routes: "custom domains are attached separately by the provisioner",
  triggers: "crons run from the central scheduler, not per install",
  workers_dev:
    "set by the provisioner via the script subdomain API {enabled:false, previews_enabled:false}",
  preview_urls:
    "set by the provisioner via the script subdomain API {enabled:false, previews_enabled:false}",
  define:
    "build-time constants (the test-hooks guard, false), folded into the bundle by buildBundle; not a binding",
  ANALYTICS_TOKEN: "an account analytics token would expose every install",
  ACCESS_TEAM_DOMAIN: "hosted signs in directly, without Access (P2)",
  ACCESS_CLIENT_ID: "hosted signs in directly, without Access (P2)",
  ACCESS_CLIENT_SECRET: "hosted signs in directly, without Access (P2)",
  CF_ACCOUNT_ID: "only feeds the Usage page, which is off in hosted",
  OAUTH_KV_ID: "only feeds the Usage page, which is off in hosted",
};

/**
 * Body for POST /accounts/{id}/workers/scripts/{name}/subdomain, which Task 4
 * must call on every create and upgrade (workers.dev and preview URLs default
 * to enabled otherwise). Fields:
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/
 */
export function scriptSubdomainSettings(): {
  enabled: false;
  previews_enabled: false;
} {
  return { enabled: false, previews_enabled: false };
}

/** Hosted-only names this module adds beyond the template. */
export const HOSTED_ADDED = [
  "HOSTED",
  "INSTALL_ID",
  "FEATURES",
  "EMAIL_DAILY_CAP",
  "CODE_EMAILS_PER_DAY",
  "AUTH_PROVIDERS",
  "AUTH_DOMAINS",
  "AUTH_DOMAIN_JOIN",
  "AUTH_BROKER_URL",
  "NIGHTLY_PUBKEY",
  "TEST_HOOKS",
  "TEST_HOOK_KEY",
  "TEST_DOMAIN",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
] as const;

/** Secrets every install has (TEST_HOOK_KEY is added for test installs). */
export const KNOWN_SECRETS = ["SESSION_SECRET", "CONTENT_SIGNING_KEY"] as const;

const posInt = (v: string) =>
  /^[1-9]\d{0,8}$/.test(v) ? undefined : "expected a positive integer";
const list = (re: RegExp) => (v: string) =>
  v.split(",").every((x) => re.test(x.trim()))
    ? undefined
    : "expected a comma-separated list";
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Hosted vars a caller may pass; the setup tunables are allowed too. */
export const HOSTED_VARS: Record<string, (v: string) => string | undefined> = {
  INSTALL_ID: (v) => (isInstallId(v) ? undefined : "bad install id"),
  FEATURES: list(/^[a-z][a-z0-9_]*$/),
  EMAIL_DAILY_CAP: posInt,
  CODE_EMAILS_PER_DAY: posInt,
  AUTH_PROVIDERS: list(/^[a-z][a-z0-9_-]*$/),
  AUTH_DOMAINS: list(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i),
  // Hosted AUTH_DOMAINS isn't verified as owned, so a hosted install never
  // admits by domain: always "invite" until ownership is proven (#572).
  AUTH_DOMAIN_JOIN: (v) =>
    v === "invite"
      ? undefined
      : 'hosted installs must use "invite" until domain ownership is proven (#572)',
  AUTH_BROKER_URL: (v) =>
    /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/\S*)?$/i.test(v)
      ? undefined
      : "expected an https URL",
  EMAIL_FROM: (v) => (EMAIL_RE.test(v) ? undefined : "expected an email"),
  // Test-hook installs only (checked in userWorkerMetadata): hooks act only
  // on emails @TEST_DOMAIN.
  TEST_DOMAIN: (v) =>
    HOST_RE.test(v) ? undefined : "expected a lowercase hostname",
  // "on" or "off" only; the server enables domain codes only when its other
  // conditions hold too, which create checks (see wfp.ts) before any call.
  EMAIL_CODE_DOMAIN: (v) =>
    v === "on" || v === "off" ? undefined : 'expected "on" or "off"',
  NIGHTLY_PUBKEY: (v) =>
    /^[A-Za-z0-9_-]{43}$/.test(v) &&
    Buffer.from(v, "base64url").toString("base64url") === v
      ? undefined
      : "expected base64url of exactly 32 bytes",
};

const PASSTHROUGH = [
  "EMAIL_DAILY_CAP",
  "CODE_EMAILS_PER_DAY",
  "AUTH_PROVIDERS",
  "AUTH_DOMAINS",
  "AUTH_BROKER_URL",
  "NIGHTLY_PUBKEY",
];

export type Vars = Record<string, string>;

const providersOf = (v: Vars): string[] =>
  (v.AUTH_PROVIDERS ?? "").split(",").map((p) => p.trim());

/** True when google is in next's AUTH_PROVIDERS and was not in prev's. */
export function googleNewlyEnabled(prev: Vars, next: Vars): boolean {
  return (
    providersOf(next).includes("google") &&
    !providersOf(prev).includes("google")
  );
}

/**
 * Turning google on later must end every session minted before (domain-code
 * sessions included). Task 5's var-change path runs this against the install's
 * D1 whenever googleNewlyEnabled(prev, next) holds.
 */
export function epochBumpSql(): string {
  return "UPDATE users SET session_epoch = session_epoch + 1";
}

export type Binding = { type: string; name: string; [k: string]: unknown };

export interface UploadMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Binding[];
  observability: {
    enabled: true;
    logs: { enabled: true; invocation_logs: false; head_sampling_rate: 1 };
  };
  tags: string[];
  assets: {
    jwt?: string;
    config: Record<string, unknown>;
  };
  keep_assets?: true;
  migrations?: {
    old_tag?: string;
    new_tag: string;
    steps: Record<string, unknown>[];
  };
  keep_bindings?: string[];
}

export interface InstallMetaInput {
  id: InstallId;
  appHost: string;
  contentHost: string;
  ownerEmail: string;
  vars: Record<string, string>;
  testHooks: boolean;
}

export interface ResourceMetaInput {
  d1Id: string;
  kvId: string;
  version: string;
  /** 1_000_000 x envIndex + 8 x seq; envIndex 1 (staging) or 2 (prod). */
  rlNs: number;
  /**
   * Must be the live script's migration_tag (read from script settings), not a
   * saved value; null only for a script that does not exist yet.
   */
  doMigrationTag: string | null;
  /** The environment, separate from the script target. */
  env: "staging" | "prod";
  /** Where the script lives; does not change the metadata. */
  target: "account" | "namespace";
  /** create needs every secret; update sends only the missing ones. */
  mode: "create" | "update";
  secrets?: Record<string, string>;
  mainModule: string;
  /** Exactly one of assetsJwt (assets were uploaded) and keepAssets. */
  assetsJwt?: string;
  keepAssets?: boolean;
  /** The release's server template (verified against the signed record). */
  template: Template;
}

const ASSET_CONFIG_KEYS = [
  "not_found_handling",
  "run_worker_first",
  "html_handling",
];

/** Durable Object migration steps that lose or move data: never sent. */
export const DO_MIGRATION_REFUSED = [
  "deleted_classes",
  "renamed_classes",
  "transferred_classes",
  "deleted_sqlite_classes",
] as const;
/** The only step keys a hosted upload sends (besides tag). */
export const DO_MIGRATION_ALLOWED = ["new_sqlite_classes", "new_classes"];

/** Refuses any template migration step that is not purely additive. */
export function assertSafeMigrations(template: Template): void {
  const all = template.migrations ?? [];
  if (!Array.isArray(all))
    throw new Error("template migrations must be an array");
  for (const m of all as Record<string, unknown>[]) {
    if (!m || typeof m !== "object" || typeof m.tag !== "string" || !m.tag)
      throw new Error("every Durable Object migration step needs a tag");
    for (const k of Object.keys(m)) {
      if (k === "tag") continue;
      if ((DO_MIGRATION_REFUSED as readonly string[]).includes(k))
        throw new Error(
          `Durable Object migration ${m.tag} has ${k}; hosted only applies new_sqlite_classes and new_classes`,
        );
      if (!DO_MIGRATION_ALLOWED.includes(k))
        throw new Error(
          `Durable Object migration ${m.tag} has unknown key ${JSON.stringify(k)}`,
        );
    }
  }
}

function migrationsFor(
  template: Template,
  current: string | null,
): UploadMetadata["migrations"] {
  assertSafeMigrations(template);
  const all = (template.migrations ?? []) as {
    tag: string;
    [k: string]: unknown;
  }[];
  if (all.length === 0) return undefined;
  const latest = (all[all.length - 1] as { tag: string }).tag;
  const stepOf = ({ tag: _t, ...rest }: { tag: string }) => rest;
  if (current === null) {
    return { new_tag: latest, steps: all.map(stepOf) };
  }
  const idx = all.findIndex((m) => m.tag === current);
  if (idx < 0)
    throw new Error(`unknown Durable Object migration tag: ${current}`);
  if (idx === all.length - 1) return undefined;
  return {
    old_tag: current,
    new_tag: latest,
    steps: all.slice(idx + 1).map(stepOf),
  };
}

function checkInputs(i: InstallMetaInput, r: ResourceMetaInput): void {
  if (!isInstallId(i.id)) throw new Error("invalid install id");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      r.d1Id,
    )
  )
    throw new Error("d1Id must be a UUID");
  if (!/^[0-9a-f]{32}$/.test(r.kvId))
    throw new Error("kvId must be 32 hex characters");
  for (const [k, v] of [
    ["appHost", i.appHost],
    ["contentHost", i.contentHost],
  ] as const)
    if (!HOST_RE.test(v)) throw new Error(`${k} must be a lowercase hostname`);
  if (!EMAIL_RE.test(i.ownerEmail)) throw new Error("invalid ownerEmail");
  if (
    !Number.isInteger(r.rlNs) ||
    r.rlNs < 1_000_000 ||
    r.rlNs >= 3_000_000 ||
    r.rlNs % 8 !== 0
  )
    throw new Error(
      "rlNs must be an integer multiple of 8 from 1000000 to below 3000000",
    );
  if ((r.assetsJwt !== undefined) === (r.keepAssets === true))
    throw new Error("exactly one of assetsJwt and keepAssets is required");
  if (i.testHooks && r.env === "prod")
    throw new Error("test hooks are not allowed in prod");
}

export function userWorkerMetadata(
  i: InstallMetaInput,
  r: ResourceMetaInput,
): UploadMetadata {
  checkInputs(i, r);
  // F5: no fallback to the checkout's template; the caller passes the release's.
  if (!r.template || typeof r.template !== "object")
    throw new Error("userWorkerMetadata needs the release template");
  const t = r.template;
  const n = names(i.id, r.env);
  for (const v of [n.script, n.d1, n.r2, n.kv]) assertOwnResource(v, r.env);
  for (const k of ["d1_databases", "r2_buckets", "kv_namespaces"])
    if ((t[k] ?? []).length > 1)
      throw new Error(
        `template has more than one ${k} entry; hosted provisions one`,
      );

  // EMAIL_FROM is always noreply@<slug>.mail.<app-domain>
  const dot = i.appHost.indexOf(".");
  const emailFrom = `noreply@${i.appHost.slice(0, dot)}.mail.${i.appHost.slice(dot + 1)}`;

  // vars: allowlist first
  for (const [k, v] of Object.entries(i.vars)) {
    const check = Object.hasOwn(HOSTED_VARS, k)
      ? HOSTED_VARS[k]
      : Object.hasOwn(TUNABLES, k)
        ? (x: string) => (x === "" ? undefined : TUNABLES[k]?.check(x))
        : undefined;
    if (!check) throw new Error(`unknown var ${JSON.stringify(k)}`);
    const why = check(v);
    if (why) throw new Error(`invalid var ${k}: ${why}`);
  }
  if (i.vars.TEST_DOMAIN !== undefined && (!i.testHooks || r.env === "prod"))
    throw new Error(
      "TEST_DOMAIN is only allowed on test-hook installs outside prod",
    );
  if (i.vars.INSTALL_ID !== undefined && i.vars.INSTALL_ID !== i.id)
    throw new Error("INSTALL_ID must equal the install id");
  if (i.vars.EMAIL_FROM !== undefined && i.vars.EMAIL_FROM !== emailFrom)
    throw new Error(`EMAIL_FROM must be ${emailFrom}`);

  const features = [
    ...new Set(
      (i.vars.FEATURES ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .concat("usage_off"),
    ),
  ].join(",");

  const fill: Record<string, string> = {
    WORKER_NAME: n.script,
    APP_HOST: i.appHost,
    CONTENT_HOST: i.contentHost,
    OWNER_EMAIL: i.ownerEmail,
    D1_NAME: n.d1,
    D1_ID: r.d1Id,
    R2_BUCKET: n.r2,
    KV_ID: r.kvId,
    EMAIL_FROM: emailFrom,
  };
  const render = (s: string, where: string) => {
    const out = s.replace(/\{\{(\w+)\}\}/g, (m, k: string) =>
      Object.hasOwn(fill, k) ? (fill[k] as string) : m,
    );
    if (out.includes("{{"))
      throw new Error(`unfilled template placeholder in ${where}: ${out}`);
    return out;
  };

  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(
    (t.vars ?? {}) as Record<string, string>,
  )) {
    if (Object.hasOwn(TEMPLATE_BINDINGS_EXCLUDED, k)) continue;
    plain[k] = render(v, `var ${k}`);
  }
  // Every resource name the template emits, rendered, must be this env's own.
  assertOwnResource(plain.WORKER_NAME ?? n.script, r.env);
  for (const [k, field, key] of [
    ["d1_databases", "database_name", "d1"],
    ["r2_buckets", "bucket_name", "r2"],
    ["kv_namespaces", "title", "kv"],
  ] as const)
    for (const e of (t[k] ?? []) as Record<string, string>[])
      assertOwnResource(
        e[field] === undefined ? n[key] : render(e[field], `${k}.${field}`),
        r.env,
      );
  Object.assign(plain, {
    PLAN: "paid",
    ENVIRONMENT: "production",
    HOSTED: "1",
    INSTALL_ID: i.id,
    FEATURES: features,
    AUTH_DOMAIN_JOIN: "invite",
  });
  for (const k of PASSTHROUGH) {
    const v = i.vars[k];
    if (v !== undefined) plain[k] = v;
  }
  // "off" is the same as absent: nothing is uploaded.
  if (i.vars.EMAIL_CODE_DOMAIN === "on") plain.EMAIL_CODE_DOMAIN = "on";
  for (const k of Object.keys(TUNABLES)) {
    const v = i.vars[k];
    if (v !== undefined) plain[k] = normalizeVar(k, v);
  }
  if (i.testHooks) plain.TEST_HOOKS = "1";
  if (i.testHooks && i.vars.TEST_DOMAIN !== undefined)
    plain.TEST_DOMAIN = i.vars.TEST_DOMAIN;

  const bindings: Binding[] = Object.entries(plain).map(([name, text]) => ({
    type: "plain_text",
    name,
    text,
  }));

  // TODO(Task 1 spike): confirm the API accepts type "browser" (as wrangler
  // sends) rather than the docs page's "browser_rendering" for account and
  // dispatch scripts.
  if (t.browser) bindings.push({ type: "browser", name: t.browser.binding });
  for (const e of (t.send_email ?? []) as { name: string }[])
    bindings.push({ type: "send_email", name: e.name });
  if (t.assets) bindings.push({ type: "assets", name: t.assets.binding });
  for (const e of (t.d1_databases ?? []) as { binding: string }[])
    bindings.push({ type: "d1", name: e.binding, id: r.d1Id });
  for (const e of (t.r2_buckets ?? []) as { binding: string }[])
    bindings.push({ type: "r2_bucket", name: e.binding, bucket_name: n.r2 });
  for (const e of (t.kv_namespaces ?? []) as { binding: string }[])
    bindings.push({
      type: "kv_namespace",
      name: e.binding,
      namespace_id: r.kvId,
    });
  for (const e of (t.durable_objects?.bindings ?? []) as {
    name: string;
    class_name: string;
  }[])
    bindings.push({
      type: "durable_object_namespace",
      name: e.name,
      class_name: e.class_name,
    });

  const rls = (t.ratelimits ?? []) as {
    name: string;
    namespace_id: string;
    simple: { limit: number; period: number };
  }[];
  if (rls.length > 8)
    throw new Error("template has more than 8 ratelimits; rlNs stride is 8");
  for (const e of rls)
    if (Number(e.namespace_id) >= 1_000_000)
      throw new Error(
        `template ratelimit id ${e.namespace_id} must be < 1000000`,
      );
  rls.forEach((e, k) => {
    bindings.push({
      type: "ratelimit",
      name: e.name,
      namespace_id: String(r.rlNs + k),
      simple: e.simple,
    });
  });

  const known: string[] = [
    ...KNOWN_SECRETS,
    ...(i.testHooks ? ["TEST_HOOK_KEY"] : []),
  ];
  const given = r.secrets ?? {};
  for (const k of Object.keys(given))
    if (!known.includes(k))
      throw new Error(`unknown secret ${JSON.stringify(k)}`);
  if (given.TEST_HOOK_KEY !== undefined && given.TEST_HOOK_KEY.length < 32)
    throw new Error("TEST_HOOK_KEY must be at least 32 characters");
  const missing = known.filter((k) => given[k] === undefined);
  if (r.mode === "create" && missing.length > 0)
    throw new Error(`create needs every secret; missing ${missing.join(", ")}`);
  for (const k of known)
    if (given[k] !== undefined)
      bindings.push({ type: "secret_text", name: k, text: given[k] });

  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t.assets ?? {})) {
    if (k === "directory" || k === "binding") continue;
    if (!ASSET_CONFIG_KEYS.includes(k))
      throw new Error(`unknown assets config key ${JSON.stringify(k)}`);
    config[k] = v;
  }

  const meta: UploadMetadata = {
    main_module: r.mainModule,
    compatibility_date: t.compatibility_date,
    compatibility_flags: t.compatibility_flags ?? [],
    bindings,
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 },
    },
    tags: [i.id, `v${r.version}`],
    assets: { config },
  };
  if (r.assetsJwt !== undefined) meta.assets.jwt = r.assetsJwt;
  else meta.keep_assets = true;
  const migrations = migrationsFor(t, r.doMigrationTag);
  if (migrations) meta.migrations = migrations;
  if (missing.length > 0) meta.keep_bindings = ["secret_text", "secret_key"];
  assertUniqueBindings(meta.bindings);
  return meta;
}

/** Two bindings with one name would let one silently shadow the other. */
export function assertUniqueBindings(bindings: readonly Binding[]): void {
  const seen = new Set<string>();
  for (const b of bindings) {
    if (seen.has(b.name))
      throw new Error(`duplicate binding name ${JSON.stringify(b.name)}`);
    seen.add(b.name);
  }
}
