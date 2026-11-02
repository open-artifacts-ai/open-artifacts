// The fleet rollout (#955): every install follows the platform's release.
// The target is this Worker's own release, its version tag (the
// "workers/tag" annotation deploy-hosted-platform sets on every platform
// Worker), so the fleet moves when the platform does: staging on the staging
// deploy, prod on the prod deploy, which a green staging red-line gates. The
// canary (FLEET_CANARY) goes first; the rest follow, FLEET_CONCURRENCY at a
// time, once the canary answers /healthz on the target. Red-line installs
// (test hooks on) are left to red-line, suspended ones to their operator, and
// an install above the target is never downgraded. A fleet upgrade that
// fails, or that turns unhealthy within FLEET_ROLLBACK_WINDOW_MS and is
// rolled back, halts the rollout to that target (fleet_halted); the next
// release starts a new one. version_skew opens when an install is still off
// the target FLEET_SKEW_MS after the platform deployed it.
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
export const FLEET_PROBE_TIMEOUT_MS = 4_000;
/** `fleet_failing:<installId>`: the first failed probe since its upgrade. */
export const FLEET_FAILING_PREFIX = "fleet_failing:";

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

// An install id and an X.Y.Z with "_" for ".": always REQUEST_ID_RE.
function requestId(prefix: string, installId: string, version: string) {
  if (!isInstallId(installId) || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`${prefix} request id: bad install id or version`);
  return `${prefix}-${installId}-${version.replaceAll(".", "_")}`;
}
/** A fleet upgrade's request id: one per install and target. */
export const fleetRequestId = (installId: string, to: string) =>
  requestId("fleet", installId, to);
/** A fleet rollback's: one per install and the target it leaves. */
export const fleetRollbackRequestId = (installId: string, from: string) =>
  requestId("fleetrb", installId, from);

// Every system fleet job: request ids `fleet-…` and `fleetrb-…` (no LIKE
// wildcard in either prefix).
const FLEET_UP = `actor_key = '${SYSTEM_ACTOR.key}' AND kind = 'upgrade' AND request_id LIKE 'fleet-%'`;
const FLEET_RB = `actor_key = '${SYSTEM_ACTOR.key}' AND kind = 'rollback' AND request_id LIKE 'fleetrb-%'`;
// What the duty may upgrade: active (not suspended, not upgrading), idle,
// test hooks off. ?1 the target.
const ELIGIBLE = `state = 'active' AND install_state = 'active' AND active_job_id IS NULL AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL`;
const CANARY = `SELECT install_id, version, app_host, state, install_state, active_job_id, test_hooks FROM install_status WHERE install_id = ?1`;
const BEHIND = `SELECT install_id, version FROM install_status WHERE ${ELIGIBLE} AND version <> ?1 AND install_id <> ?2 ORDER BY created_at, install_id`;
const OPEN = `SELECT COUNT(*) AS n FROM jobs WHERE ${FLEET_UP} AND status IN ('queued', 'running')`;
// The rollout to ?1 is halted: a failed fleet upgrade to it, or a fleet
// rollback off it.
const HALTED = `SELECT j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since FROM jobs j
WHERE (${FLEET_UP} AND status = 'failed' AND json_extract(args, '$.to') = ?1)
   OR (${FLEET_RB} AND json_extract(args, '$.from') = ?1)
ORDER BY since, j.id`;
// Fleet upgrades to ?1 done since ?2, still on it, with no fleet rollback.
const RECENT = `SELECT j.install_id AS install_id, json_extract(j.args, '$.from') AS prev, i.app_host AS app_host FROM jobs j JOIN installs i ON i.id = j.install_id
WHERE j.actor_key = '${SYSTEM_ACTOR.key}' AND j.kind = 'upgrade' AND j.request_id LIKE 'fleet-%' AND j.status = 'done'
  AND json_extract(j.args, '$.to') = ?1 AND j.finished_at >= ?2 AND i.version = ?1
  AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.install_id = j.install_id AND r.actor_key = '${SYSTEM_ACTOR.key}' AND r.kind = 'rollback' AND r.request_id LIKE 'fleetrb-%' AND json_extract(r.args, '$.from') = ?1)
ORDER BY j.finished_at, j.install_id`;
const SKEW = `SELECT install_id, NULL AS job_id, NULL AS job_kind, version AS code, NULL AS message, ?2 AS since FROM install_status
WHERE state = 'active' AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND version <> ?1
ORDER BY created_at, install_id`;
// The insert's own check: still eligible and still on `from` (?9).
const STILL_ON = `EXISTS (SELECT 1 FROM install_status WHERE install_id = ?3 AND ${ELIGIBLE} AND version = ?9)`;
const GET_FAILING = "SELECT value FROM platform_state WHERE key = ?1";
const SET_FAILING =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
const CLEAR_FAILING = "DELETE FROM platform_state WHERE key = ?1";

interface CanaryRow {
  install_id: string;
  version: string | null;
  app_host: string | null;
  state: string;
  install_state: string | null;
  active_job_id: string | null;
  test_hooks: number | null;
}

/**
 * ok iff /healthz answers 200 with ok, this install's id, the target
 * version and no test hooks. Never throws.
 */
export async function onTarget(
  probe: HealthProbe,
  id: string,
  appHost: string,
  target: string,
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
          j.version === target &&
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
}

/** One fleet tick. */
export async function fleetDue(
  env: ProvapiEnv,
  now: number,
  o: FleetOptions = {},
): Promise<void> {
  const target = fleetTarget(env.CF_VERSION_METADATA);
  if (target === null) {
    console.log("provapi fleet no_target");
    return;
  }
  const canaryId = env.FLEET_CANARY?.trim() ?? "";
  if (!isInstallId(canaryId)) {
    console.log("provapi fleet no_canary");
    return;
  }
  const db = env.PLATFORM_DB;
  const manage = bound(env.MANAGE_INSTALL);
  const probe = o.probe ?? publicRouteProbe;
  const ms = o.timeoutMs ?? FLEET_PROBE_TIMEOUT_MS;

  // A fleet upgrade failing its probe holds the rollout until it passes or
  // is rolled back (which halts it).
  if (await rollbackUnhealthy(env, now, target, probe, ms)) {
    console.log("provapi fleet holding");
    return;
  }

  const halted = await d1(db.prepare(HALTED).bind(target).first());
  if (halted !== null) {
    console.log("provapi fleet halted", target);
    return;
  }

  const canary = await d1(db.prepare(CANARY).bind(canaryId).first<CanaryRow>());
  if (
    canary?.state !== "active" ||
    (canary.test_hooks ?? 0) !== 0 ||
    canary.version === null
  ) {
    console.log("provapi fleet canary_unavailable");
    return;
  }
  const c = compareVersions(canary.version, target);
  if (c < 0) {
    if (canary.install_state === "active" && canary.active_job_id === null)
      await upgrade(env, manage, now, canaryId, canary.version, target);
    return;
  }
  if (c > 0 || canary.app_host === null) {
    console.log("provapi fleet canary_off_target");
    return;
  }
  if (!(await onTarget(probe, canaryId, canary.app_host, target, ms))) {
    console.log("provapi fleet canary_unhealthy");
    return;
  }

  const open = await d1(db.prepare(OPEN).first<{ n: number }>());
  let slots = FLEET_CONCURRENCY - (open?.n ?? 0);
  if (slots <= 0) return;
  const { results } = await d1(
    db
      .prepare(BEHIND)
      .bind(target, canaryId)
      .all<{ install_id: string; version: string }>(),
  );
  for (const r of results) {
    if (slots <= 0) break;
    let below: boolean;
    try {
      below = compareVersions(r.version, target) < 0;
    } catch {
      continue;
    }
    if (!below) continue;
    if (await upgrade(env, manage, now, r.install_id, r.version, target))
      slots--;
  }
}

/** Queues and starts one fleet upgrade; true when this tick inserted it. */
async function upgrade(
  env: ProvapiEnv,
  manage: NonNullable<ProvapiEnv["MANAGE_INSTALL"]>,
  now: number,
  installId: string,
  from: string,
  to: string,
): Promise<boolean> {
  try {
    const id = await insertSystemJob(
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
      { sql: STILL_ON, params: [from] },
    );
    // null: already queued for this target, or no longer eligible.
    if (id === null) return false;
    console.log("provapi fleet upgrade queued", installId, id, `to=${to}`);
    // A failed start leaves it queued; the sweep starts it.
    await startJob(manage, id);
    return true;
  } catch (e) {
    console.error("provapi fleet install_failed", dutyCategory(e), installId);
    return false;
  }
}

/**
 * Probes each fleet upgrade to the target done within the window. A failed
 * probe is remembered; a second, on a later tick, queues the rollback to the
 * version it left. A passing probe forgets the first. True when any probe
 * failed or could not be decided.
 */
async function rollbackUnhealthy(
  env: ProvapiEnv,
  now: number,
  target: string,
  probe: HealthProbe,
  ms: number,
): Promise<boolean> {
  const db = env.PLATFORM_DB;
  const manage = bound(env.MANAGE_INSTALL);
  let suspect = false;
  const { results } = await d1(
    db
      .prepare(RECENT)
      .bind(target, now - FLEET_ROLLBACK_WINDOW_MS)
      .all<{ install_id: string; prev: unknown; app_host: string | null }>(),
  );
  await lanes(results, FLEET_CONCURRENCY, async (r) => {
    const key = `${FLEET_FAILING_PREFIX}${r.install_id}`;
    try {
      if (
        r.app_host !== null &&
        (await onTarget(probe, r.install_id, r.app_host, target, ms))
      ) {
        await d1(db.prepare(CLEAR_FAILING).bind(key).run());
        return;
      }
      suspect = true;
      const first = await d1(
        db.prepare(GET_FAILING).bind(key).first<{ value: number }>(),
      );
      // None yet, or one from before this window (an earlier upgrade's):
      // this failure is the first.
      if (
        first === null ||
        first.value >= now ||
        first.value < now - FLEET_ROLLBACK_WINDOW_MS
      ) {
        await d1(db.prepare(SET_FAILING).bind(key, now).run());
        console.log("provapi fleet unhealthy", r.install_id, "first");
        return;
      }
      if (typeof r.prev !== "string") return;
      const id = await insertSystemJob(
        db,
        {
          kind: "rollback",
          installId: r.install_id,
          signupId: null,
          parentJobId: null,
          requestId: fleetRollbackRequestId(r.install_id, target),
          args: { from: target, to: r.prev },
        },
        now,
        { sql: STILL_ON, params: [target] },
      );
      await d1(db.prepare(CLEAR_FAILING).bind(key).run());
      if (id === null) return;
      console.log("provapi fleet rollback queued", r.install_id, id);
      await startJob(manage, id);
    } catch (e) {
      suspect = true;
      console.error(
        "provapi fleet rollback_failed",
        dutyCategory(e),
        r.install_id,
      );
    }
  });
  return suspect;
}

/**
 * fleet_halted and version_skew for this tick; unknown (null) without a
 * target, and version_skew also without the deploy time.
 */
export async function fleetConditions(
  env: Pick<ProvapiEnv, "PLATFORM_DB" | "CF_VERSION_METADATA">,
  now: number,
): Promise<{ fleet_halted: Condition; version_skew: Condition }> {
  const unknown: Condition = { open: null, rows: [] };
  const target = fleetTarget(env.CF_VERSION_METADATA);
  if (target === null) return { fleet_halted: unknown, version_skew: unknown };
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
      since === null
        ? unknown
        : now - since < FLEET_SKEW_MS
          ? { open: false, rows: [] }
          : await read(SKEW, target, since),
  };
}
