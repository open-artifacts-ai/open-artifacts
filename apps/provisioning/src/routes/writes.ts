import {
  type ApiRouteId,
  type CancelJobSchema,
  canTransition,
  checkPurgeFields,
  type DeleteSchema,
  type JobKind,
  type PurgeSchema,
  type RedlineCredsSchema,
  type ReleaseLeaseSchema,
  redlineCredsJobArgs,
  type SuspendSchema,
  TOKEN_DELETING_PURGE,
  type TransitionFrom,
  type UpgradeSchema,
} from "@oa/shared/provisioning";
import type { z } from "zod";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { loadInReach, loadJob, type StatusRow } from "../model.js";
import type { Principal } from "../principal.js";
import { releases } from "../services/cache.js";
import {
  accept,
  activeJobId,
  binding,
  guard,
  type NewJob,
  replay,
  transitionActor,
  type Write,
  writeOf,
} from "../services/jobs.js";
import type { HandlerArgs } from "./handlers.js";
import type { RouteResult } from "./invoke.js";
import { slugHeld } from "./reads.js";

// The lifecycle writes R5-R13 and R26 (3.4, 5.4-5.6), R25 cancel (3.6).
// After invokeRoute's authz and schema: reach (404) -> policy (field rules)
// -> business: replay (3.1), confirmSlug, job_in_progress before
// invalid_state (4.2), the kind's own rule -> one batch -> Workflow start.

/** An admin purge of a deleting install needs a sign-in this recent (4.2). */
export const PURGE_REAUTH_MS = 10 * 60_000;

const adminOrigin = (env: Env) => `https://admin.${env.APP_DOMAIN}`;

const refuseUnless = (ok: boolean) => {
  if (!ok) throw new ApiError("invalid_state");
};
const can = (row: StatusRow, kind: JobKind, p: Principal) =>
  canTransition(row.state as TransitionFrom, kind, transitionActor(p));

/** Stable "a.b.c" order; -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The release a job installs: the given version, else the newest
 * installable one of the variant. A given version is checked for presence
 * in GET /releases only (3.5); floor and variant are release_gate's
 * (release_unverified, P32).
 */
export async function resolveRelease(
  env: Env,
  version: string | undefined,
  variant: "release" | "redline",
): Promise<string> {
  const all = await releases(env);
  if (version !== undefined) {
    if (!all.some((r) => r.version === version))
      throw new ApiError("release_not_published");
    return version;
  }
  const newest = all
    .filter((r) => r.installable && r.variants.includes(variant))
    .map((r) => r.version)
    .sort(compareVersions)
    .at(-1);
  if (!newest) throw new ApiError("release_not_published");
  return newest;
}

type Plan = {
  kind: JobKind;
  args: Record<string, unknown>;
  signupId?: string | null;
  /** Rows written in the job's batch after the job row (R12). */
  after?: (jobId: string) => D1PreparedStatement[];
  /** How a constraint error maps besides job_in_progress (R12). */
  conflict?: () => Promise<ApiError>;
};
type Planner = (a: HandlerArgs, row: StatusRow) => Promise<Plan>;

const bodyOf = <S extends z.ZodType>(a: HandlerArgs) =>
  a.input.body as z.infer<S>;

const PLANS: Partial<Record<ApiRouteId, Planner>> = {
  R5: async (a, row) => {
    refuseUnless(can(row, "upgrade", a.principal));
    const body = bodyOf<typeof UpgradeSchema>(a);
    if (row.version === null) throw new ApiError("invalid_state");
    const to = await resolveRelease(
      a.env,
      body.version,
      row.test_hooks === 1 ? "redline" : "release",
    );
    if (compareVersions(to, row.version) <= 0)
      throw new ApiError("downgrade_refused");
    return { kind: "upgrade", args: { from: row.version, to } };
  },
  R6: async (a, row) => {
    refuseUnless(can(row, "rollback", a.principal));
    if (row.version === null || row.previous_version === null)
      throw new ApiError("invalid_state", "no previous version");
    return {
      kind: "rollback",
      args: { from: row.version, to: row.previous_version },
    };
  },
  R7: async (a, row) => {
    refuseUnless(can(row, "suspend", a.principal));
    return {
      kind: "suspend",
      args: { reason: bodyOf<typeof SuspendSchema>(a).reason },
    };
  },
  R8: async (a, row) => {
    refuseUnless(can(row, "resume", a.principal));
    return { kind: "resume", args: {} };
  },
  R9: async (a, row) => {
    // U on a suspended install: TRANSITIONS has no U row there (5.1).
    refuseUnless(can(row, "delete", a.principal));
    return { kind: "delete", args: {} };
  },
  R10: async (a, row) => {
    refuseUnless(can(row, "restore", a.principal));
    const purgeStarted = await a.env.PLATFORM_DB.prepare(
      "SELECT 1 AS x FROM jobs WHERE install_id = ? AND kind = 'purge' AND created_at >= ? LIMIT 1",
    )
      .bind(row.install_id, row.deleted_at ?? 0)
      .first();
    if (row.purge_at === null || Date.now() >= row.purge_at || purgeStarted)
      throw new ApiError("grace_expired");
    return { kind: "restore", args: {} };
  },
  R11: async (a, row) => {
    const p = a.principal;
    const skip = bodyOf<typeof PurgeSchema>(a).skipDirectoryRevoke;
    const args = skip ? { skipDirectoryRevoke: skip.reason } : {};
    if (row.state === "failed") {
      // A create that failed before reserve wrote an installs row (3.2).
      const kind = row.install_state === null ? "discard" : "purge";
      refuseUnless(can(row, kind, p));
      return { kind, args };
    }
    if (row.state === "deleting") {
      // purgePolicy ran the token and reauth rules before business.
      refuseUnless(can(row, "purge", p));
      return { kind: "purge", args };
    }
    throw new ApiError("invalid_state");
  },
  R12: async (a, row) => {
    refuseUnless(can(row, "retry", a.principal));
    const sid = row.signup_id;
    if (sid === null) throw new ApiError("invalid_state");
    const { env } = a;
    const db = env.PLATFORM_DB;
    const sub = row.source === "self-serve" ? row.owner_sub : null;
    const except = { installId: row.install_id, signupId: sid };
    // A failed signup freed its slug and account (3.6 settleFailed); the
    // retry holds them again or is refused like a create.
    const conflict = async () =>
      sub && (await claimedByOther(env, sub, sid))
        ? new ApiError("signup_limit")
        : new ApiError("slug_taken");
    if (await slugHeld(env, row.slug, except)) throw new ApiError("slug_taken");
    if (sub && (await claimedByOther(env, sub, sid)))
      throw new ApiError("signup_limit");
    return {
      kind: "retry",
      args: {},
      signupId: sid,
      conflict,
      // signups.job_id is the current create or retry job (8.2); a live
      // status puts the slug back under signups_live_slug.
      after: (jobId) => [
        db
          .prepare(
            "UPDATE signups SET job_id = ?2, status = 'queued', error = NULL, updated_at = ?3 WHERE signup_id = ?1 AND status = 'failed'",
          )
          .bind(sid, jobId, Date.now()),
        guard(
          env,
          "SELECT 1 FROM signups WHERE signup_id = ? AND job_id = ?",
          sid,
          jobId,
        ),
        guard(
          env,
          "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM installs WHERE slug = ? AND id <> ?)",
          row.slug,
          row.install_id,
        ),
        ...(sub ? claimAccount(env, sub, sid, Date.now()) : []),
      ],
    };
  },
  R13: async (a, row) => {
    refuseUnless(can(row, "release_lease", a.principal));
    const force = bodyOf<typeof ReleaseLeaseSchema>(a).force === true;
    if (force && !(row.lease_until !== null && row.lease_until > Date.now()))
      throw new ApiError("invalid_state", "force needs a live lease");
    return { kind: "release_lease", args: force ? { force: true } : {} };
  },
  R26: async (a, row) => {
    refuseUnless(can(row, "redline_creds", a.principal));
    // Mint or revoke (C6): the shared helper narrows on `revoke` and owns
    // the args shape, so a mint's key travels however C7 defines it.
    return {
      kind: "redline_creds",
      args: redlineCredsJobArgs(bodyOf<typeof RedlineCredsSchema>(a)),
    };
  },
};

/** Another live signup holds the account's one-install claim (7). */
export async function claimedByOther(
  env: Env,
  sub: string,
  signupId: string,
): Promise<boolean> {
  return (
    (await env.PLATFORM_DB.prepare(
      "SELECT 1 AS x FROM signup_accounts WHERE owner_sub = ? AND freed_at IS NULL AND signup_id <> ?",
    )
      .bind(sub, signupId)
      .first()) !== null
  );
}

/**
 * Claims the account for `signupId` (7): a new row, a freed one, or the
 * signup's own; the guard aborts the batch when another signup holds it.
 */
export function claimAccount(
  env: Env,
  sub: string,
  signupId: string,
  now: number,
): D1PreparedStatement[] {
  return [
    env.PLATFORM_DB.prepare(
      `INSERT INTO signup_accounts (owner_sub, signup_id, created_at) VALUES (?1, ?2, ?3)
ON CONFLICT (owner_sub) DO UPDATE SET signup_id = excluded.signup_id, created_at = excluded.created_at, freed_at = NULL
WHERE signup_accounts.freed_at IS NOT NULL`,
    ).bind(sub, signupId, now),
    guard(
      env,
      "SELECT 1 FROM signup_accounts WHERE owner_sub = ? AND signup_id = ? AND freed_at IS NULL",
      sub,
      signupId,
    ),
  ];
}

/**
 * R11's policy on a `deleting` install (4.2, 3.5), before business: a token
 * is 403 with details.needs, an admin needs a sign-in within 10 min.
 */
function purgePolicy(a: HandlerArgs, row: StatusRow) {
  if (row.state !== "deleting") return;
  const p = a.principal;
  if (p.kind === "token")
    throw new ApiError(
      TOKEN_DELETING_PURGE.code,
      "purging a soft-deleted install needs an admin session",
      TOKEN_DELETING_PURGE.details(adminOrigin(a.env), row.install_id),
    );
  if (
    p.kind === "admin" &&
    (p.authAt == null || Date.now() - p.authAt > PURGE_REAUTH_MS)
  )
    throw new ApiError("reauth_required", "sign in again to purge", {
      reauthUrl: `${adminOrigin(a.env)}/auth/start?reauth=1&return=${encodeURIComponent(`/installs/${row.install_id}`)}`,
    });
}

const createPrincipal = (p: Principal) =>
  p.kind === "system" ? "admin" : p.kind;

/** R5-R13 and R26: one handler, the route's planner. */
export async function lifecycleWrite(a: HandlerArgs): Promise<RouteResult> {
  const route = a.route;
  const plan = PLANS[route];
  if (!plan) throw new ApiError("internal");
  const id = (a.input.params as { id: string }).id;
  const body = a.input.body as z.infer<typeof DeleteSchema> & {
    skipDirectoryRevoke?: unknown;
  };
  const row = await loadInReach(a.env, id, a.principal, a.reach);
  if (route === "R11") {
    const f = checkPurgeFields(body, createPrincipal(a.principal));
    if (f) throw new ApiError(f.code, `${f.field} is not allowed`);
    purgePolicy(a, row);
  }
  const w = await writeOf(a.env, a.principal, a.surface, route, id, body);
  const prior = await replay(w);
  if (prior) return prior;
  if (body.confirmSlug !== undefined && body.confirmSlug !== row.slug)
    throw new ApiError("confirm_mismatch");
  if (row.active_job_id)
    throw new ApiError("job_in_progress", "a job is running", {
      jobId: row.active_job_id,
    });
  const p = await plan(a, row);
  const job: NewJob = {
    kind: p.kind,
    installId: id,
    signupId: p.signupId ?? null,
    args: p.args,
  };
  return accept(w, {
    job,
    after: p.after,
    onConflict: async () => {
      const open = await activeJobId(a.env, id);
      if (open)
        throw new ApiError("job_in_progress", "a job is running", {
          jobId: open,
        });
      throw p.conflict ? await p.conflict() : new ApiError("invalid_state");
    },
  });
}

/**
 * R25 cancel (3.6): admin only, typed slug, audited job.canceled. One batch
 * marks the job failed `canceled` and inserts its `cleanup` job, which
 * exists only if the cancel took; then the job's Workflow is terminated and
 * the cleanup started.
 */
export async function cancelJob(a: HandlerArgs): Promise<RouteResult> {
  const jobId = (a.input.params as { jobId: string }).jobId;
  const body = a.input.body as z.infer<typeof CancelJobSchema>;
  const target = await loadJob(a.env, jobId);
  if (!target) throw new ApiError("not_found");
  const row = await loadInReach(a.env, target.install_id, a.principal, a.reach);
  // The path id is the job: two cancels of two jobs never share a hash.
  const w: Write = await writeOf(
    a.env,
    a.principal,
    a.surface,
    "R25",
    jobId,
    body,
  );
  const prior = await replay(w);
  if (prior) return prior;
  if (body.confirmSlug !== row.slug) throw new ApiError("confirm_mismatch");
  if (target.status !== "queued" && target.status !== "running")
    throw new ApiError("invalid_state", "the job is not running");
  const now = Date.now();
  const db = a.env.PLATFORM_DB;
  return accept(w, {
    action: "job.canceled",
    job: {
      kind: "cleanup",
      installId: target.install_id,
      signupId: target.signup_id,
      parentJobId: target.id,
      args: { canceled: target.id, kind: target.kind },
    },
    before: [
      db
        .prepare(
          `UPDATE jobs SET status = 'failed', error_code = 'canceled', error_message = 'canceled by an admin', finished_at = ?2, updated_at = ?2
WHERE id = ?1 AND status IN ('queued', 'running')`,
        )
        .bind(target.id, now),
    ],
    after: () => [
      guard(
        a.env,
        "SELECT 1 FROM jobs WHERE id = ? AND error_code = 'canceled' AND finished_at = ?",
        target.id,
        now,
      ),
    ],
    onConflict: async () => {
      throw new ApiError("invalid_state", "the job is not running");
    },
    start: async (cleanupId) => {
      try {
        await (
          await binding(a.env, target.workflow).get(target.id)
        ).terminate();
      } catch {
        // Not started yet, or already gone: the failed row is the cancel.
      }
      await binding(a.env, "manage_install").create({
        id: cleanupId,
        params: { jobId: cleanupId },
      });
    },
  });
}
