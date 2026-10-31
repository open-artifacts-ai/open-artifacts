import { ownerEmailOf } from "@oa/provision/names";
import {
  type Auth,
  AuthProviderSchema,
  canonicalJson,
  type Health,
  type InstallDetail,
  type InstallState,
  type InstallSummary,
  JOB_STEPS,
  type Job,
  JobErrorCodeSchema,
  type JobKind,
  type ServingMode,
  type Tier,
  VersionSchema,
} from "@oa/shared/provisioning";
import { z } from "zod";
import type { Env } from "./env.js";
import { ApiError } from "./errors.js";
import type { Principal } from "./principal.js";

// Platform D1 reads and their API shapes (3.3). Install state is always
// the install_status view (5.1); this module only reads.

/** One install_status row, plus the vars of its installs row and signup. */
export type StatusRow = {
  install_id: string;
  state: InstallState;
  source: "admin" | "self-serve";
  slug: string;
  app_host: string | null;
  content_host: string | null;
  owner_sub: string | null;
  tier: Tier | null;
  version: string | null;
  previous_version: string | null;
  test_hooks: number | null;
  lease_until: number | null;
  install_state: string | null;
  signup_id: string | null;
  signup_status: string | null;
  serving_mode: ServingMode | null;
  health: Health;
  health_at: number | null;
  suspended_at: number | null;
  suspend_reason: string | null;
  deleted_at: number | null;
  purge_at: number | null;
  discarded_at: number | null;
  active_job_id: string | null;
  active_job_kind: JobKind | null;
  created_at: number;
  updated_at: number;
  install_vars: string | null;
  signup_vars: string | null;
};

export const STATUS_SELECT = `SELECT st.*, i.vars AS install_vars, s.vars AS signup_vars
FROM install_status st
LEFT JOIN installs i ON i.id = st.install_id
LEFT JOIN signups s ON s.signup_id = st.signup_id`;

/** Reach "own" (authz.ts): O its `rl-` test installs, U the installs it owns. */
export function reachSql(
  p: Principal,
  reach: "all" | "own",
): { sql: string; binds: unknown[] } {
  if (reach === "all") return { sql: "1 = 1", binds: [] };
  if (p.kind === "oidc")
    return { sql: "st.slug LIKE 'rl-%' AND st.test_hooks = 1", binds: [] };
  // U, and any other "own" reach: the owner's sub, never null-equal.
  return {
    sql: "st.owner_sub IS NOT NULL AND st.owner_sub = ?",
    binds: [p.sub ?? ""],
  };
}

export function inReach(
  row: StatusRow,
  p: Principal,
  reach: "all" | "own",
): boolean {
  if (reach === "all") return true;
  if (p.kind === "oidc")
    return row.slug.startsWith("rl-") && row.test_hooks === 1;
  return row.owner_sub !== null && row.owner_sub === p.sub;
}

export async function loadStatus(
  env: Env,
  installId: string,
): Promise<StatusRow | null> {
  return env.PLATFORM_DB.prepare(`${STATUS_SELECT} WHERE st.install_id = ?`)
    .bind(installId)
    .first<StatusRow>();
}

/** The install a principal may see, else 404 (outside O's or U's scope too). */
export async function loadInReach(
  env: Env,
  installId: string,
  p: Principal,
  reach: "all" | "own",
): Promise<StatusRow> {
  const row = await loadStatus(env, installId);
  if (!row || !inReach(row, p, reach)) throw new ApiError("not_found");
  return row;
}

const list = (v: unknown) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** AUTH_PROVIDERS and AUTH_DOMAINS from the installs row's vars, else the signup's. */
export function authOf(row: StatusRow): Auth {
  let vars: Record<string, unknown> = {};
  try {
    vars = JSON.parse(row.install_vars ?? row.signup_vars ?? "{}");
  } catch {}
  return {
    providers: list(vars.AUTH_PROVIDERS).filter(
      (p): p is Auth["providers"][number] =>
        AuthProviderSchema.safeParse(p).success,
    ),
    domains: list(vars.AUTH_DOMAINS),
  };
}

const version = (v: string | null) =>
  v !== null && VersionSchema.safeParse(v).success ? v : null;

/** The serving mode each state should show (5.1); null: no expectation. */
const EXPECTED_MODE: Partial<Record<InstallState, ServingMode>> = {
  active: "serving",
  suspended: "paused",
  deleting: "closed",
  deleted: "unmapped",
};

/** Set when D1 state and the HOSTS mode the provisioner last wrote disagree. */
export function mismatchOf(row: StatusRow): string | null {
  const want = EXPECTED_MODE[row.state];
  if (!want || row.serving_mode === null || row.serving_mode === want)
    return null;
  return `state ${row.state}, serving mode ${row.serving_mode}`;
}

export function summaryOf(env: Env, row: StatusRow): InstallSummary {
  const auth = authOf(row);
  return {
    id: row.install_id,
    slug: row.slug,
    // Before reserve writes the installs row the hosts are derived; the
    // content domain is not the API's to know (W4 concern).
    appHost: row.app_host ?? `${row.slug}.${env.APP_DOMAIN}`,
    contentHost: row.content_host ?? "",
    state: row.state,
    servingMode: row.serving_mode ?? "unmapped",
    version: version(row.version),
    tier: row.tier,
    auth: { providers: auth.providers, domainCount: auth.domains.length },
    health: row.health,
    source: row.source,
    activeJobId: row.active_job_id,
    createdAt: row.created_at,
  };
}

/** True while restore is allowed: in grace and no purge started (5.6). */
export async function restorable(env: Env, row: StatusRow): Promise<boolean> {
  if (row.state !== "deleting" || row.purge_at === null) return false;
  if (Date.now() >= row.purge_at) return false;
  const purge = await env.PLATFORM_DB.prepare(
    "SELECT 1 AS x FROM jobs WHERE install_id = ? AND kind = 'purge' AND created_at >= ? LIMIT 1",
  )
    .bind(row.install_id, row.deleted_at ?? 0)
    .first();
  return purge === null;
}

/**
 * The owner email: the installs row's (through ownerEmailOf, so a purged ''
 * is null), else the pending signup's secret (deleted once the create is
 * done, never purged to '').
 */
export async function ownerEmailFor(
  env: Env,
  row: StatusRow,
): Promise<string | null> {
  const [inst, secret] = await env.PLATFORM_DB.batch<Record<string, unknown>>([
    env.PLATFORM_DB.prepare("SELECT * FROM installs WHERE id = ?1").bind(
      row.install_id,
    ),
    env.PLATFORM_DB.prepare(
      "SELECT owner_email FROM signup_secret WHERE signup_id = ?1",
    ).bind(row.signup_id),
  ]);
  const i = inst?.results[0];
  const s = secret?.results[0]?.owner_email;
  return (
    (i ? ownerEmailOf(i) : null) ||
    (typeof s === "string" && s !== "" ? s : null)
  );
}

export async function detailOf(
  env: Env,
  row: StatusRow,
  showEmail: boolean,
): Promise<InstallDetail> {
  const now = Date.now();
  return {
    ...summaryOf(env, row),
    ownerEmail: showEmail ? await ownerEmailFor(env, row) : null,
    auth: authOf(row),
    previousVersion: version(row.previous_version),
    suspendedAt: row.suspended_at,
    suspendReason: row.suspend_reason,
    deletedAt: row.deleted_at,
    purgeAt: row.purge_at,
    restorable: await restorable(env, row),
    testHooks: row.test_hooks === 1,
    lease: {
      held: row.lease_until !== null && row.lease_until > now,
      until: row.lease_until,
    },
    mismatch: mismatchOf(row),
  };
}

/** One jobs row (0008). */
export type JobRow = {
  id: string;
  kind: JobKind;
  workflow: "provision_install" | "manage_install" | "none";
  install_id: string;
  signup_id: string | null;
  parent_job_id: string | null;
  actor_kind: Job["actor"]["kind"];
  actor_key: string;
  actor_label: string;
  token_id: string | null;
  request_id: string;
  body_hash: string;
  args: string;
  status: Job["status"];
  step: string | null;
  attempt: number;
  last_error_code: string | null;
  retry_at: number | null;
  error_code: string | null;
  error_message: string | null;
  sealed: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

const jobCode = (c: string | null) => {
  const r = JobErrorCodeSchema.safeParse(c);
  return r.success ? r.data : null;
};

/** A Job without `sealed` (R14, R27); jobOf adds it for R15. */
export function jobItemOf(r: JobRow): Omit<Job, "sealed"> {
  const steps: string[] = [
    ...((JOB_STEPS as Record<string, readonly string[]>)[r.kind] ?? []),
  ];
  const at = r.step === null ? -1 : steps.indexOf(r.step);
  let args: Record<string, unknown> = {};
  try {
    const a = JSON.parse(r.args);
    if (a && typeof a === "object" && !Array.isArray(a)) args = a;
  } catch {}
  return {
    id: r.id,
    kind: r.kind,
    installId: r.install_id,
    status: r.status,
    step: r.step,
    steps,
    stepIndex:
      at >= 0 ? at : r.status === "done" ? Math.max(steps.length - 1, 0) : 0,
    attempt: r.attempt,
    lastErrorCode: jobCode(r.last_error_code),
    retryAt: r.retry_at,
    actor: { kind: r.actor_kind, label: r.actor_label, tokenId: r.token_id },
    args,
    error:
      r.status === "failed" && r.error_code !== null
        ? {
            code: jobCode(r.error_code) ?? "internal",
            message: r.error_message ?? "",
          }
        : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export const jobOf = (r: JobRow, sealed: string | null = null): Job => ({
  ...jobItemOf(r),
  sealed,
});

export async function loadJob(env: Env, id: string): Promise<JobRow | null> {
  return env.PLATFORM_DB.prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(id)
    .first<JobRow>();
}

// Cursors (3.1): base64url of the sort key and the query's tag; a cursor
// from another query (route, path id or filters) is invalid_input.

/**
 * A short tag of the query a cursor belongs to: FNV-1a of the canonical
 * route, path id and filters (not limit), so a cursor never carries them.
 */
export function queryTag(
  route: string,
  filters: Record<string, unknown>,
): string {
  const defined = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""),
  );
  let h = 0x811c9dc5;
  for (const ch of canonicalJson({ route, ...defined })) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function encodeCursor(key: unknown, tag: string): string {
  const s = btoa(JSON.stringify({ q: tag, k: key }));
  return s.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor<T>(
  c: string,
  schema: z.ZodType<T>,
  tag: string,
): T {
  try {
    const b = c.replaceAll("-", "+").replaceAll("_", "/");
    const o = JSON.parse(atob(b)) as { q?: unknown; k?: unknown };
    if (o && o.q === tag) {
      const v = schema.safeParse(o.k);
      if (v.success) return v.data;
    }
  } catch {}
  throw new ApiError("invalid_input", "bad cursor");
}

/** Sort key of installs and jobs pages: (created_at desc, id desc). */
export const CreatedCursor = z.tuple([z.number(), z.string()]);
