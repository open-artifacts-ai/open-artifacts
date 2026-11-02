// The fleet rollout (#955): every install follows the platform's release.
// The target is this Worker's own release, its version tag (the
// "workers/tag" annotation deploy-hosted-platform sets on every platform
// Worker), so the fleet moves when the platform does: staging on the staging
// deploy, prod on the prod deploy, which a green staging red-line gates. The
// canary (FLEET_CANARY) goes first; the rest follow, FLEET_CONCURRENCY at a
// time, once the canary's upgrade is done and it answers /healthz on the
// target. Only serving, active, idle installs with test hooks off move:
// red-line installs are left to red-line, suspended ones to their operator,
// paused ones (prod_dirty) to purge or discard, and an install above the
// target is never downgraded. A fleet upgrade that fails, or that turns
// unhealthy within FLEET_ROLLBACK_WINDOW_MS and is rolled back, halts the
// rollout to that target (fleet_halted); the next release starts a new one.
// version_skew opens when an install is still off the target FLEET_SKEW_MS
// after the platform deployed it. With no canary set, the duty and both
// alerts do nothing.
import { isInstallId } from "@oa/provision/names";
import { compareVersions } from "@oa/provision/versions";
import type { AlertRow } from "@oa/shared/provisioning/alerts";
import { SYSTEM_ACTOR } from "@oa/shared/provisioning/system";
import type { Condition } from "./conditions.js";
import { bound, d1, lanes, type ProvapiEnv, within } from "./env.js";
import { type HealthProbe, publicRouteProbe } from "./health.js";
import { insertSystemJob, startJob } from "./jobs.js";
import { dutyCategory } from "./run.js";

/** Open fleet upgrades at once, the canary's included. */
export const FLEET_CONCURRENCY = 3;
/** A fleet upgrade unhealthy on two ticks within this long is rolled back. */
export const FLEET_ROLLBACK_WINDOW_MS = 30 * 60_000;
/** version_skew: an install off the target this long after the deploy. */
export const FLEET_SKEW_MS = 6 * 60 * 60_000;
/** One /healthz probe; the duty's budget allows two rounds of them. */
export const FLEET_PROBE_TIMEOUT_MS = 8_000;
/** The duty's default budget (index.ts passes its own). */
export const FLEET_BUDGET_MS = 20_000;
/** Kept back from the budget for the D1 writes after the probes. */
export const FLEET_BUDGET_SLACK_MS = 2_000;
/** `fleet_failing:<installId>`: the first failed probe since its upgrade. */
export const FLEET_FAILING_PREFIX = "fleet_failing:";
/**
 * `fleet_halt:<version>:<installId>`: an unhealthy fleet upgrade the duty
 * could not roll back; it halts the rollout to that version.
 */
export const FLEET_HALT_PREFIX = "fleet_halt:";

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** The platform's release: the version tag "vX.Y.Z" as "X.Y.Z", else null. */
export function fleetTarget(
  meta: Pick<WorkerVersionMetadata, "tag"> | undefined,
): string | null {
  return STABLE_TAG.exec(meta?.tag ?? "")?.[1] ?? null;
}

/** When this version was uploaded (epoch ms), else null. */
export function fleetSince(
  meta: Pick<WorkerVersionMetadata, "timestamp"> | undefined,
): number | null {
  const t = Date.parse(meta?.timestamp ?? "");
  return Number.isFinite(t) ? t : null;
}

/** FLEET_CANARY when it is an install id, else null (no rollout). */
export const fleetCanary = (v: string | undefined): string | null => {
  const id = v?.trim() ?? "";
  return isInstallId(id) ? id : null;
};

// An install id and an X.Y.Z with "_" for ".": always REQUEST_ID_RE.
function requestId(prefix: string, installId: string, version: string) {
  if (!isInstallId(installId) || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`${prefix} request id: bad install id or version`);
  return `${prefix}-${installId}-${version.replaceAll(".", "_")}`;
}
/** A fleet upgrade's request id: one per install and target. */
export const fleetRequestId = (installId: string, to: string) =>
  requestId("fleet", installId, to);
/** A fleet rollback's: one per install and the version it leaves. */
export const fleetRollbackRequestId = (installId: string, from: string) =>
  requestId("fleetrb", installId, from);

// Every system fleet job: request ids `fleet-…` and `fleetrb-…` (no LIKE
// wildcard in either prefix). `j` is the jobs alias.
const FLEET_UP = `j.actor_key = '${SYSTEM_ACTOR.key}' AND j.kind = 'upgrade' AND j.request_id LIKE 'fleet-%'`;
const FLEET_RB = `j.actor_key = '${SYSTEM_ACTOR.key}' AND j.kind = 'rollback' AND j.request_id LIKE 'fleetrb-%'`;
// What the duty may upgrade: active (not suspended, not upgrading), serving
// (not paused, closed or unrouted), idle, test hooks off.
const ELIGIBLE = `state = 'active' AND install_state = 'active' AND serving_mode = 'serving' AND active_job_id IS NULL AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL`;
const CANARY = `SELECT install_id, version, app_host, state, install_state, serving_mode, active_job_id, test_hooks FROM install_status WHERE install_id = ?1`;
// The canary's latest upgrade to ?2, any actor.
const CANARY_JOB = `SELECT status FROM jobs WHERE install_id = ?1 AND kind = 'upgrade' AND json_extract(args, '$.to') = ?2 ORDER BY created_at DESC, id DESC LIMIT 1`;
const BEHIND = `SELECT install_id, version FROM install_status WHERE ${ELIGIBLE} AND version <> ?1 AND install_id <> ?2 ORDER BY created_at, install_id`;
// The rollout to ?1 is halted: a failed fleet upgrade to it, a fleet
// rollback off it, or a fleet_halt mark for it.
const HALTED = `SELECT * FROM (
SELECT j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since FROM jobs j
WHERE (${FLEET_UP} AND j.status = 'failed' AND json_extract(j.args, '$.to') = ?1)
   OR (${FLEET_RB} AND json_extract(j.args, '$.from') = ?1)
UNION ALL
SELECT substr(key, length('${FLEET_HALT_PREFIX}' || ?1 || ':') + 1) AS install_id, NULL AS job_id, NULL AS job_kind, 'fleet_halt' AS code, NULL AS message, value AS since FROM platform_state
WHERE key GLOB '${FLEET_HALT_PREFIX}' || ?1 || ':*'
) ORDER BY since, install_id`;
// Fleet upgrades done since ?1 to the version the install is still on, any
// target, with no fleet rollback off that version.
const RECENT = `SELECT j.install_id AS install_id, json_extract(j.args, '$.from') AS prev, json_extract(j.args, '$.to') AS version, j.finished_at AS done_at, i.app_host AS app_host FROM jobs j JOIN installs i ON i.id = j.install_id
WHERE ${FLEET_UP} AND j.status = 'done' AND j.finished_at >= ?1 AND i.version = json_extract(j.args, '$.to')
  AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.install_id = j.install_id AND r.actor_key = '${SYSTEM_ACTOR.key}' AND r.kind = 'rollback' AND r.request_id LIKE 'fleetrb-%' AND json_extract(r.args, '$.from') = json_extract(j.args, '$.to'))
ORDER BY j.finished_at, j.install_id`;
const SKEW = `SELECT install_id, NULL AS job_id, NULL AS job_kind, version AS code, NULL AS message, ?2 AS since FROM install_status
WHERE state = 'active' AND serving_mode = 'serving' AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND version <> ?1
ORDER BY created_at, install_id`;
// The insert's own checks, in the same statement: still eligible and still
// on `from` (?9); for an upgrade also under the cap, so overlapping ticks
// never open more than FLEET_CONCURRENCY between them.
const STILL_ON = `EXISTS (SELECT 1 FROM install_status WHERE install_id = ?3 AND ${ELIGIBLE} AND version = ?9)`;
const UNDER_CAP = `(SELECT COUNT(*) FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')) < ${FLEET_CONCURRENCY}`;
const GET = "SELECT value FROM platform_state WHERE key = ?1";
const SET =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
const MARK =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
const CLEAR = "DELETE FROM platform_state WHERE key = ?1";

interface CanaryRow {
  install_id: string;
  version: string | null;
  app_host: string | null;
  state: string;
  install_state: string | null;
  serving_mode: string | null;
  active_job_id: string | null;
  test_hooks: number | null;
}

interface RecentRow {
  install_id: string;
  prev: unknown;
  version: unknown;
  done_at: number;
  app_host: string | null;
}

/**
 * ok iff /healthz answers 200 with ok, this install's id, the version and
 * no test hooks. Never throws.
 */
export async function onTarget(
  probe: HealthProbe,
  id: string,
  appHost: string,
  version: string,
  timeoutMs = FLEET_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    return await within(
      (async () => {
        const res = await probe(id, appHost);
        if (res.status !== 200) {
          await res.body?.cancel();
          return false;
        }
        const j = (await res.json()) as Record<string, unknown> | null;
        return (
          j?.ok === true &&
          j.installId === id &&
          j.version === version &&
          j.testHooks === undefined
        );
      })(),
      timeoutMs,
    );
  } catch {
    return false;
  }
}

export interface FleetOptions {
  probe?: HealthProbe;
  timeoutMs?: number;
  /** The duty's budget: no probe starts that could end past it. */
  budgetMs?: number;
  /** Tests only: elapsed time (default Date.now). */
  clock?: () => number;
}

/** Probes within the duty's budget; `null` when it had no time to. */
type Prober = (
  id: string,
  appHost: string,
  version: string,
) => Promise<boolean | null>;

function prober(o: FleetOptions): Prober {
  const probe = o.probe ?? publicRouteProbe;
  const ms = o.timeoutMs ?? FLEET_PROBE_TIMEOUT_MS;
  const budget = o.budgetMs ?? FLEET_BUDGET_MS;
  const clock = o.clock ?? Date.now;
  const started = clock();
  return async (id, appHost, version) =>
    clock() - started + ms > budget - FLEET_BUDGET_SLACK_MS
      ? null
      : onTarget(probe, id, appHost, version, ms);
}

/** One fleet tick. */
export async function fleetDue(
  env: ProvapiEnv,
  now: number,
  o: FleetOptions = {},
): Promise<void> {
  const canaryId = fleetCanary(env.FLEET_CANARY);
  if (canaryId === null) {
    console.log("provapi fleet no_canary");
    return;
  }
  const target = fleetTarget(env.CF_VERSION_METADATA);
  if (target === null) {
    // fleet_halted opens for it (fleetConditions).
    console.log("provapi fleet no_target");
    return;
  }
  const db = env.PLATFORM_DB;
  const manage = bound(env.MANAGE_INSTALL);
  const probe = prober(o);

  // A recent fleet upgrade failing (or not yet probed) holds the rollout
  // until it passes or is rolled back, which halts it.
  const recent = await watchRecent(env, now, probe);
  if (recent.hold) {
    console.log("provapi fleet holding");
    return;
  }

  if ((await d1(db.prepare(HALTED).bind(target).first())) !== null) {
    console.log("provapi fleet halted", target);
    return;
  }

  const canary = await d1(db.prepare(CANARY).bind(canaryId).first<CanaryRow>());
  if (
    canary?.state !== "active" ||
    canary.serving_mode !== "serving" ||
    (canary.test_hooks ?? 0) !== 0 ||
    canary.version === null ||
    canary.app_host === null
  ) {
    console.log("provapi fleet canary_unavailable");
    return;
  }
  if (canary.install_state !== "active" || canary.active_job_id !== null) {
    console.log("provapi fleet canary_busy");
    return;
  }
  const c = compareVersions(canary.version, target);
  if (c > 0) {
    console.log("provapi fleet canary_off_target");
    return;
  }
  if (!(await published(env, target))) return;
  if (c < 0) {
    await upgrade(env, manage, now, canaryId, canary.version, target);
    return;
  }
  // On the target: its upgrade (if it had one) is done, not just written.
  const last = await d1(
    db.prepare(CANARY_JOB).bind(canaryId, target).first<{ status: string }>(),
  );
  if (last !== null && last.status !== "done") {
    console.log("provapi fleet canary_not_done");
    return;
  }
  const healthy =
    recent.healthy.has(canaryId) ||
    (await probe(canaryId, canary.app_host, target));
  if (healthy !== true) {
    console.log(
      "provapi fleet",
      healthy === null ? "canary_unprobed" : "canary_unhealthy",
    );
    return;
  }

  const { results } = await d1(
    db
      .prepare(BEHIND)
      .bind(target, canaryId)
      .all<{ install_id: string; version: string }>(),
  );
  let slots = FLEET_CONCURRENCY;
  for (const r of results) {
    if (slots <= 0) break;
    let below: boolean;
    try {
      below = compareVersions(r.version, target) < 0;
    } catch {
      continue;
    }
    if (!below) continue;
    // A refused insert (cap reached, or no longer eligible) ends the round
    // only at the cap; the guard is the real cap.
    if (await upgrade(env, manage, now, r.install_id, r.version, target))
      slots--;
  }
}

/**
 * The target is in the release catalog, installable as a release: else no
 * fleet job is queued this tick (a job would fail release_not_published and
 * halt the rollout for good). Logged, never thrown.
 */
async function published(env: ProvapiEnv, target: string): Promise<boolean> {
  try {
    const [r] = await within(
      Promise.resolve().then(() =>
        bound(env.PROVISIONER).releases({ version: target }),
      ),
      5_000,
    );
    if (
      r?.version === target &&
      r.installable &&
      r.variants.includes("release")
    )
      return true;
    console.log("provapi fleet release_unpublished", target);
  } catch (e) {
    console.error("provapi fleet release_unknown", dutyCategory(e));
  }
  return false;
}

/**
 * Queues and starts one fleet upgrade; true once inserted (a failed start
 * leaves it queued, the sweep starts it, and it still counts).
 */
async function upgrade(
  env: ProvapiEnv,
  manage: NonNullable<ProvapiEnv["MANAGE_INSTALL"]>,
  now: number,
  installId: string,
  from: string,
  to: string,
): Promise<boolean> {
  let id: string | null;
  try {
    id = await insertSystemJob(
      env.PLATFORM_DB,
      {
        kind: "upgrade",
        installId,
        signupId: null,
        parentJobId: null,
        requestId: fleetRequestId(installId, to),
        args: { from, to },
      },
      now,
      { sql: `${STILL_ON} AND ${UNDER_CAP}`, params: [from] },
    );
  } catch (e) {
    console.error("provapi fleet install_failed", dutyCategory(e), installId);
    return false;
  }
  // null: already queued for this target, at the cap, or no longer eligible.
  if (id === null) return false;
  console.log("provapi fleet upgrade queued", installId, id, `to=${to}`);
  try {
    await startJob(manage, id);
  } catch (e) {
    console.error("provapi fleet start_failed", dutyCategory(e), installId);
  }
  return true;
}

/**
 * Probes each fleet upgrade done within the window, on the version it went
 * to. A failed probe is a strike; a second, on a later tick, after the
 * upgrade finished, queues the rollback to the version it left. More than
 * one failing in a tick is a shared cause (dispatch, Cloudflare): strikes
 * are kept, nothing is rolled back. A rollback the duty cannot queue marks
 * the version halted (fleet_halt). `hold` when any probe failed or did not
 * run; `healthy` lists the installs that passed this tick.
 */
async function watchRecent(
  env: ProvapiEnv,
  now: number,
  probe: Prober,
): Promise<{ hold: boolean; healthy: Set<string> }> {
  const db = env.PLATFORM_DB;
  const healthy = new Set<string>();
  const { results } = await d1(
    db
      .prepare(RECENT)
      .bind(now - FLEET_ROLLBACK_WINDOW_MS)
      .all<RecentRow>(),
  );
  const failing: RecentRow[] = [];
  let hold = false;
  await lanes(results, FLEET_CONCURRENCY, async (r) => {
    const ok =
      r.app_host === null || typeof r.version !== "string"
        ? false
        : await probe(r.install_id, r.app_host, r.version);
    if (ok === true) {
      healthy.add(r.install_id);
      await d1(db.prepare(CLEAR).bind(strikeKey(r.install_id)).run());
      return;
    }
    hold = true;
    if (ok === false) failing.push(r);
  });
  if (failing.length > 1)
    console.log("provapi fleet shared_failure", `n=${failing.length}`);
  for (const r of failing) {
    try {
      await strike(env, now, r, failing.length === 1);
    } catch (e) {
      console.error(
        "provapi fleet rollback_failed",
        dutyCategory(e),
        r.install_id,
      );
    }
  }
  return { hold, healthy };
}

const strikeKey = (id: string) => `${FLEET_FAILING_PREFIX}${id}`;

async function strike(
  env: ProvapiEnv,
  now: number,
  r: RecentRow,
  mayRollBack: boolean,
): Promise<void> {
  const db = env.PLATFORM_DB;
  const key = strikeKey(r.install_id);
  const first = await d1(db.prepare(GET).bind(key).first<{ value: number }>());
  // None yet, or one from before this upgrade finished: this is the first.
  if (first === null || first.value < r.done_at || first.value >= now) {
    await d1(db.prepare(SET).bind(key, now).run());
    console.log("provapi fleet unhealthy", r.install_id, "first");
    return;
  }
  if (!mayRollBack) return;
  const version = r.version as string;
  const halt = async (why: string) => {
    await d1(
      db
        .prepare(MARK)
        .bind(`${FLEET_HALT_PREFIX}${version}:${r.install_id}`, now)
        .run(),
    );
    console.log("provapi fleet", why, r.install_id);
  };
  if (typeof r.prev !== "string") return halt("rollback_no_prev");
  const id = await insertSystemJob(
    db,
    {
      kind: "rollback",
      installId: r.install_id,
      signupId: null,
      parentJobId: null,
      requestId: fleetRollbackRequestId(r.install_id, version),
      args: { from: version, to: r.prev },
    },
    now,
    { sql: STILL_ON, params: [version] },
  );
  if (id === null) return halt("rollback_not_queued");
  await d1(db.prepare(CLEAR).bind(key).run());
  console.log("provapi fleet rollback queued", r.install_id, id);
  try {
    await startJob(bound(env.MANAGE_INSTALL), id);
  } catch (e) {
    console.error("provapi fleet start_failed", dutyCategory(e), r.install_id);
  }
}

/**
 * fleet_halted and version_skew for this tick. No canary: both clear (no
 * rollout). No target with a canary set: fleet_halted opens (no_target), the
 * rollout can't move. version_skew is unknown until FLEET_SKEW_MS after the
 * deploy, and without the deploy time.
 */
export async function fleetConditions(
  env: Pick<ProvapiEnv, "PLATFORM_DB" | "CF_VERSION_METADATA" | "FLEET_CANARY">,
  now: number,
): Promise<{ fleet_halted: Condition; version_skew: Condition }> {
  const unknown: Condition = { open: null, rows: [] };
  const clear: Condition = { open: false, rows: [] };
  if (fleetCanary(env.FLEET_CANARY) === null)
    return { fleet_halted: clear, version_skew: clear };
  const target = fleetTarget(env.CF_VERSION_METADATA);
  if (target === null)
    return {
      fleet_halted: {
        open: true,
        rows: [
          {
            install_id: null,
            job_id: null,
            job_kind: null,
            code: "no_target",
            message: null,
            since: now,
          },
        ],
      },
      version_skew: unknown,
    };
  const db = env.PLATFORM_DB;
  const read = async (sql: string, ...bind: unknown[]): Promise<Condition> => {
    try {
      const { results } = await db
        .prepare(sql)
        .bind(...bind)
        .all<AlertRow>();
      return { open: results.length > 0, rows: results };
    } catch {
      console.error("provapi alert fleet query_error");
      return unknown;
    }
  };
  const since = fleetSince(env.CF_VERSION_METADATA);
  return {
    fleet_halted: await read(HALTED, target),
    version_skew:
      since === null || now - since < FLEET_SKEW_MS
        ? unknown
        : await read(SKEW, target, since),
  };
}
