// The 2.5 rechecks (design v7 2.5, 5.1): the API's D1 binding is its real
// authority, so every row is a request, never a fact. A job's first step
// re-reads installs, install_lifecycle, signups and jobs, derives the state
// from the shared install_status view, checks the kind against TRANSITIONS,
// and for a create parses signups.vars with a strict schema. Any mismatch is
// `invalid_state`, terminal.
import { NonRetryableError } from "cloudflare:workflows";
import { type Env as DeployEnv, STAGING_TEST_DOMAIN } from "@oa/provision";
import {
  canTransition,
  type InstallState,
  type JobKind,
  slugError,
  TierSchema,
  type TransitionActor,
  type TransitionFrom,
} from "@oa/shared/provisioning";
import { StepRefusal } from "./errors.js";
import { transient } from "./provisioner.js";
import type { JobRow, StepCtx } from "./steps.js";

/**
 * A failed recheck: terminal, its message exactly invalid_state's fixed
 * text; `why` reaches only the redacted log line.
 */
export const refused = (why: string): NonRetryableError =>
  new StepRefusal("invalid_state", why);

/** The install_status view row a recheck reads (0008). */
export type StatusRow = {
  install_id: string;
  state: InstallState;
  source: "admin" | "self-serve";
  slug: string | null;
  app_host: string | null;
  content_host: string | null;
  version: string | null;
  previous_version: string | null;
  test_hooks: number | null;
  lease_until: number | null;
  install_state: string | null;
  signup_id: string | null;
  signup_status: string | null;
  serving_mode: string | null;
  suspended_at: number | null;
  deleted_at: number | null;
  purge_at: number | null;
  discarded_at: number | null;
  active_job_id: string | null;
};

export async function readStatus(
  ctx: StepCtx,
  installId: string,
): Promise<StatusRow | null> {
  return transient(
    ctx.env.PLATFORM_DB.prepare(
      "SELECT * FROM install_status WHERE install_id = ?",
    )
      .bind(installId)
      .first<StatusRow>(),
  );
}

/** TRANSITIONS' actor for a job's principal (5.1): OIDC acts as A. */
export function actorOf(kind: JobRow["actor_kind"]): TransitionActor {
  switch (kind) {
    case "admin":
    case "oidc":
      return "A";
    case "token":
      return "T";
    case "user":
      return "U";
    case "system":
      return "S";
    default:
      throw refused("unknown actor kind");
  }
}

/**
 * OIDC's scope (4.4, 5.1): staging only, and only an `rl-` install with test
 * hooks. TRANSITIONS reads OIDC as A, so this is the rest of its check.
 */
export function checkOidcScope(
  job: JobRow,
  env: DeployEnv,
  install: { slug: string | null; testHooks: boolean },
): void {
  if (job.actor_kind !== "oidc") return;
  if (env !== "staging") throw refused("OIDC is staging only");
  if (!install.slug?.startsWith("rl-") || !install.testHooks)
    throw refused("OIDC acts only on rl- test installs");
}

/** The kind is allowed from `from` for the job's actor (TRANSITIONS). */
export function checkTransition(
  from: TransitionFrom,
  kind: JobKind,
  job: JobRow,
): void {
  if (!canTransition(from, kind, actorOf(job.actor_kind)))
    throw refused(`${kind} is not allowed from ${from}`);
}

/** The job is open, of the Workflow that runs it, and of an allowed kind. */
export function checkJob(
  job: JobRow | null,
  workflow: JobRow["workflow"],
  kinds: readonly JobKind[],
): JobRow {
  if (!job) throw refused("no such job");
  if (job.workflow !== workflow || !kinds.includes(job.kind))
    throw refused(`a ${job.kind} job does not run here`);
  if (job.status !== "queued" && job.status !== "running")
    throw refused(`the job is ${job.status}`);
  return job;
}

const PROVIDERS = new Set(["google", "email"]);
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * signups.vars under the strict schema (2.5 item 3): exactly AUTH_PROVIDERS,
 * AUTH_DOMAINS, TIER, and TEST_DOMAIN (equal to STAGING_TEST_DOMAIN) only on
 * a staging test-hook row. Self-serve also needs TIER = SELF_SERVE_TIER,
 * providers exactly google and at most one domain (with google, exactly
 * one). Returns the vars create renders: AUTH_DOMAIN_JOIN=invite forced,
 * an empty AUTH_DOMAINS dropped.
 */
export function strictVars(
  raw: string,
  o: {
    source: "admin" | "self-serve";
    selfServeTier: string;
    testHooks: boolean;
    env: DeployEnv;
  },
): Record<string, string> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw refused("vars are not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw refused("vars are not an object");
  const vars = v as Record<string, unknown>;
  const allowed = ["AUTH_PROVIDERS", "AUTH_DOMAINS", "TIER"];
  if (o.testHooks) allowed.push("TEST_DOMAIN");
  for (const k of Object.keys(vars))
    if (!allowed.includes(k))
      throw refused(`var ${k.slice(0, 40)} is not allowed`);
  for (const k of allowed)
    if (typeof vars[k] !== "string") throw refused(`var ${k} is missing`);
  const providers = (vars.AUTH_PROVIDERS as string).split(",");
  if (
    providers.length === 0 ||
    providers.length > 2 ||
    new Set(providers).size !== providers.length ||
    !providers.every((p) => PROVIDERS.has(p))
  )
    throw refused("AUTH_PROVIDERS is not a provider list");
  const domains =
    vars.AUTH_DOMAINS === "" ? [] : (vars.AUTH_DOMAINS as string).split(",");
  if (domains.length > 50 || !domains.every((d) => DOMAIN.test(d)))
    throw refused("AUTH_DOMAINS is not a domain list");
  if (providers.includes("google") && domains.length === 0)
    throw refused("google needs at least one domain");
  const tier = TierSchema.safeParse(vars.TIER);
  if (!tier.success) throw refused("TIER is not a tier");
  if (o.testHooks) {
    if (o.env !== "staging") throw refused("test hooks are staging only");
    if (vars.TEST_DOMAIN !== STAGING_TEST_DOMAIN)
      throw refused("TEST_DOMAIN is not the staging test domain");
  }
  if (o.source === "self-serve") {
    if (tier.data !== o.selfServeTier)
      throw refused("a self-serve TIER must be SELF_SERVE_TIER");
    if (providers.length !== 1 || providers[0] !== "google")
      throw refused("self-serve providers must be google");
    if (domains.length > 1) throw refused("self-serve has at most one domain");
  }
  return {
    AUTH_PROVIDERS: providers.join(","),
    ...(domains.length > 0 ? { AUTH_DOMAINS: domains.join(",") } : {}),
    AUTH_DOMAIN_JOIN: "invite",
    TIER: tier.data,
    ...(o.testHooks ? { TEST_DOMAIN: STAGING_TEST_DOMAIN } : {}),
  };
}

/** A stored slug is still a valid, unreserved one. */
export function checkSlug(slug: unknown): string {
  if (typeof slug !== "string" || slugError(slug) !== null)
    throw refused("the slug is not valid");
  return slug;
}
