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
// target is never downgraded.
//
// After a fleet upgrade, the install is watched (watchRecent). A failure
// that lasts FLEET_BLIP_MS, while a control install answers, halts the
// version durably (a fleet_halt mark: fleet_halted opens) and rolls the
// install back; a failure the control shares is the platform's, not the
// release's, and restarts the clock. A halted version gets no more fleet
// upgrades; the next release starts a new rollout. version_skew opens for an
// install still behind FLEET_SKEW_MS after the first release past its
// version reached this env.
import { isInstallId } from "@oa/provision/names";
import { compareVersions } from "@oa/provision/versions";
import type { ProvisionerRpc } from "@oa/shared/provisioning";
import type { AlertRow } from "@oa/shared/provisioning/alerts";
import { SYSTEM_ACTOR } from "@oa/shared/provisioning/system";
import type { Condition } from "./conditions.js";
import { bound, d1, lanes, type ProvapiEnv, within } from "./env.js";
import { type HealthProbe, publicRouteProbe } from "./health.js";
import { insertSystemJob, startJob } from "./jobs.js";
import { dutyCategory } from "./run.js";

/** Open fleet upgrades at once, the canary's included. */
export const FLEET_CONCURRENCY = 3;
/** A fleet upgrade is watched this long after it finished. */
export const FLEET_ROLLBACK_WINDOW_MS = 30 * 60_000;
/** A failure shorter than this is a blip: it holds, never halts. */
export const FLEET_BLIP_MS = 10 * 60_000;
/** version_skew: an install behind this long. */
export const FLEET_SKEW_MS = 6 * 60 * 60_000;
/** One /healthz probe. */
export const FLEET_PROBE_TIMEOUT_MS = 8_000;
/** The duty's default budget (index.ts passes its own). */
export const FLEET_BUDGET_MS = 15_000;
/** Kept back from the budget for the D1 writes after the probes. */
export const FLEET_BUDGET_SLACK_MS = 2_000;
/** Recent halts on other versions keep fleet_halted open this long. */
export const FLEET_HALT_ALERT_MS = 6 * 60 * 60_000;
/** `fleet_failing:<installId>`: when its current failure was first seen. */
export const FLEET_FAILING_PREFIX = "fleet_failing:";
/**
 * `fleet_halt:<version>:<installId>`: an install's upgrade to the version
 * failed past a blip; the rollout to that version stops.
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

const haltKey = (version: string, id: string) =>
  `${FLEET_HALT_PREFIX}${version}:${id}`;
const strikeKey = (id: string) => `${FLEET_FAILING_PREFIX}${id}`;

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
const OPEN = `SELECT COUNT(*) AS n FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')`;
// Every halt, with the version it halts: a failed fleet upgrade (to), a
// fleet rollback (from). The fleet_halt marks are read separately.
const HALT_JOBS = `SELECT j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since,
  CASE WHEN j.kind = 'upgrade' THEN json_extract(j.args, '$.to') ELSE json_extract(j.args, '$.from') END AS version
FROM jobs j WHERE (${FLEET_UP} AND j.status = 'failed') OR (${FLEET_RB})
ORDER BY since, j.id`;
const HALT_MARKS = `SELECT key, value FROM platform_state WHERE key GLOB '${FLEET_HALT_PREFIX}*'`;
// Each install's latest fleet upgrade, done, still on the version it went
// to with no fleet rollback off it, finished since ?1 or with a failure
// still open (a strike): the watch.
const RECENT = `SELECT j.install_id AS install_id, json_extract(j.args, '$.from') AS prev, json_extract(j.args, '$.to') AS version, j.finished_at AS done_at, st.app_host AS app_host, st.state AS state, st.install_state AS install_state, st.serving_mode AS serving_mode, st.active_job_id AS active_job_id
FROM jobs j JOIN install_status st ON st.install_id = j.install_id
WHERE ${FLEET_UP} AND j.status = 'done' AND st.version = json_extract(j.args, '$.to')
  AND j.id = (SELECT k.id FROM jobs k WHERE k.install_id = j.install_id AND k.actor_key = '${SYSTEM_ACTOR.key}' AND k.kind = 'upgrade' AND k.request_id LIKE 'fleet-%' ORDER BY k.created_at DESC, k.id DESC LIMIT 1)
  AND (j.finished_at >= ?1 OR EXISTS (SELECT 1 FROM platform_state p WHERE p.key = '${FLEET_FAILING_PREFIX}' || j.install_id))
  AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.install_id = j.install_id AND r.actor_key = '${SYSTEM_ACTOR.key}' AND r.kind = 'rollback' AND r.request_id LIKE 'fleetrb-%' AND json_extract(r.args, '$.from') = json_extract(j.args, '$.to'))
ORDER BY j.finished_at, j.install_id`;
// The control: the oldest eligible install not in the watch (?1, a JSON
// array of ids), probed on its own version.
const CONTROL = `SELECT install_id, version, app_host FROM install_status WHERE ${ELIGIBLE} AND app_host IS NOT NULL AND install_id NOT IN (SELECT value FROM json_each(?1)) ORDER BY created_at, install_id LIMIT 1`;
const LAGGING = `SELECT install_id, version FROM install_status
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
  state: string;
  install_state: string | null;
  serving_mode: string | null;
  active_job_id: string | null;
}

type HaltRow = AlertRow & { version: string | null };

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

/** Every halt (jobs and marks), each with the version it halts. */
async function halts(db: D1Database): Promise<HaltRow[]> {
  const { results: jobs } = await d1(db.prepare(HALT_JOBS).all<HaltRow>());
  const { results: marks } = await d1(
    db.prepare(HALT_MARKS).all<{ key: string; value: number }>(),
  );
  const fromMarks = marks.flatMap((m): HaltRow[] => {
    const rest = m.key.slice(FLEET_HALT_PREFIX.length);
    const i = rest.lastIndexOf(":");
    if (i <= 0) return [];
    return [
      {
        install_id: rest.slice(i + 1),
        job_id: null,
        job_kind: null,
        code: "fleet_halt",
        message: null,
        since: m.value,
        version: rest.slice(0, i),
      },
    ];
  });
  return [...jobs, ...fromMarks].sort(
    (a, b) => a.since - b.since || String(a.install_id).localeCompare(String(b.install_id)),
  );
}

/** One fleet tick. */
export async function fleetDue(
  env: ProvapiEnv,
  now: number,
  o: FleetOptions = {},
): Promise<void> {
  const db = env.PLATFORM_DB;
  const probe = prober(o);

  // The watch runs with or without a canary or target: an upgrade already
  // made stays watched if the rollout is switched off.
  const recent = await watchRecent(env, now, probe);

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
  if (recent.hold) {
    console.log("provapi fleet holding");
    return;
  }
  if ((await halts(db)).some((h) => h.version === target)) {
    console.log("provapi fleet halted", target);
    return;
  }
  const manage = bound(env.MANAGE_INSTALL);

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

  // The read keeps a full cap from costing a refused insert per install;
  // the insert's guard is what holds the cap.
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
 * The watch. Each watched install that is active and serving is probed on
 * the version it went to; one busy with a job holds without a probe; one
 * that left active or serving (suspended, deleting, paused) is no longer
 * the fleet's and drops out. A failure is first stamped (its strike), then:
 *
 * - under FLEET_BLIP_MS it only holds the rollout;
 * - past it, the failure is checked against a control. Any watched install
 *   passing this tick, or else the control (the oldest eligible install
 *   outside the watch, on its own version), answering proves the platform
 *   path works: the version is halted for good (fleet_halt) and the install
 *   rolled back. A control that fails too is the platform's failure: no
 *   halt, and every strike restarts so a recovery is timed from the end of
 *   it. With no control at all, the failure is the release's.
 *
 * `hold` when any watched install failed, was busy or wasn't probed;
 * `healthy` lists those that passed this tick.
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
  const failing: { r: RecentRow; first: number }[] = [];
  let hold = false;
  await lanes(results, FLEET_CONCURRENCY, async (r) => {
    if (r.state !== "active" || r.serving_mode !== "serving") {
      await d1(db.prepare(CLEAR).bind(strikeKey(r.install_id)).run());
      return;
    }
    if (r.install_state !== "active" || r.active_job_id !== null) {
      hold = true;
      return;
    }
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
    if (ok === null) return;
    const s = await d1(
      db.prepare(GET).bind(strikeKey(r.install_id)).first<{ value: number }>(),
    );
    // None yet, or one from before this upgrade finished: this is the first.
    if (s === null || s.value < r.done_at || s.value > now) {
      await d1(db.prepare(SET).bind(strikeKey(r.install_id), now).run());
      console.log("provapi fleet unhealthy", r.install_id, "first");
      return;
    }
    failing.push({ r, first: s.value });
  });
  const lasting = failing.filter((f) => now - f.first >= FLEET_BLIP_MS);
  if (lasting.length === 0) return { hold, healthy };

  let shared = false;
  if (healthy.size === 0) {
    const control = await d1(
      db
        .prepare(CONTROL)
        .bind(JSON.stringify(results.map((r) => r.install_id)))
        .first<{ install_id: string; version: string; app_host: string }>(),
    );
    if (control !== null) {
      const ok = await probe(
        control.install_id,
        control.app_host,
        control.version,
      );
      if (ok === null) return { hold: true, healthy };
      shared = !ok;
    }
  }
  if (shared) {
    console.log("provapi fleet shared_failure", `n=${failing.length}`);
    for (const f of failing)
      await d1(db.prepare(SET).bind(strikeKey(f.r.install_id), now).run());
    return { hold: true, healthy };
  }
  for (const f of lasting) {
    try {
      await haltAndRollBack(env, now, f.r);
    } catch (e) {
      console.error(
        "provapi fleet rollback_failed",
        dutyCategory(e),
        f.r.install_id,
      );
    }
  }
  return { hold: true, healthy };
}

/** fleet_halt for the version, then the rollback to the version it left. */
async function haltAndRollBack(
  env: ProvapiEnv,
  now: number,
  r: RecentRow,
): Promise<void> {
  const db = env.PLATFORM_DB;
  const version = r.version as string;
  await d1(db.prepare(MARK).bind(haltKey(version, r.install_id), now).run());
  console.log("provapi fleet halted_by", r.install_id, version);
  if (typeof r.prev !== "string") {
    console.log("provapi fleet rollback_no_prev", r.install_id);
    return;
  }
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
  if (id === null) {
    console.log("provapi fleet rollback_not_queued", r.install_id);
    return;
  }
  await d1(db.prepare(CLEAR).bind(strikeKey(r.install_id)).run());
  console.log("provapi fleet rollback queued", r.install_id, id);
  try {
    await startJob(bound(env.MANAGE_INSTALL), id);
  } catch (e) {
    console.error("provapi fleet start_failed", dutyCategory(e), r.install_id);
  }
}

/**
 * When an install on `version` fell behind: the publish time of the first
 * release past it; for the target itself, no earlier than this env's deploy.
 * Null when the catalog doesn't say.
 */
function behindSince(
  version: string,
  target: string,
  releases: readonly { version: string; publishedAt: number | null }[],
  deployed: number,
): number | null {
  let next: { version: string; publishedAt: number | null } | undefined;
  for (const r of releases) {
    try {
      if (
        compareVersions(r.version, version) > 0 &&
        compareVersions(r.version, target) <= 0 &&
        (next === undefined || compareVersions(r.version, next.version) < 0)
      )
        next = r;
    } catch {}
  }
  if (next === undefined) return deployed;
  if (next.version === target)
    return Math.max(next.publishedAt ?? deployed, deployed);
  return next.publishedAt;
}

/**
 * fleet_halted and version_skew for this tick.
 * - fleet_halted: halts on the target, and any halt on another version in
 *   the last FLEET_HALT_ALERT_MS (the watch acts on earlier releases too).
 *   A canary set with no target opens it too (no_target).
 * - version_skew: installs behind for FLEET_SKEW_MS (behindSince). Unknown
 *   with no canary, no target, no deploy time or no catalog, so it never
 *   sends a false all-clear.
 */
export async function fleetConditions(
  env: Pick<ProvapiEnv, "PLATFORM_DB" | "CF_VERSION_METADATA" | "FLEET_CANARY"> & {
    PROVISIONER?: ProvisionerRpc;
  },
  now: number,
): Promise<{ fleet_halted: Condition; version_skew: Condition }> {
  const unknown: Condition = { open: null, rows: [] };
  const db = env.PLATFORM_DB;
  const target = fleetTarget(env.CF_VERSION_METADATA);
  const canary = fleetCanary(env.FLEET_CANARY);
  let fleet_halted: Condition;
  try {
    const all = await halts(db);
    const rows = all
      .filter(
        (h) =>
          (target !== null && h.version === target) ||
          h.since >= now - FLEET_HALT_ALERT_MS,
      )
      .map(({ version: _v, ...row }) => row);
    if (canary !== null && target === null)
      rows.push({
        install_id: null,
        job_id: null,
        job_kind: null,
        code: "no_target",
        message: null,
        since: now,
      });
    fleet_halted = { open: rows.length > 0, rows };
  } catch {
    console.error("provapi alert fleet query_error");
    fleet_halted = unknown;
  }
  const deployed = fleetSince(env.CF_VERSION_METADATA);
  if (canary === null || target === null || deployed === null || !env.PROVISIONER)
    return { fleet_halted, version_skew: unknown };
  let version_skew: Condition;
  try {
    const rpc = env.PROVISIONER;
    const releases = await within(
      Promise.resolve().then(() => rpc.releases()),
      5_000,
    );
    const { results } = await db
      .prepare(LAGGING)
      .bind(target)
      .all<{ install_id: string; version: string }>();
    const rows: AlertRow[] = results.flatMap((r) => {
      const since = behindSince(r.version, target, releases, deployed);
      return since !== null && now - since >= FLEET_SKEW_MS
        ? [
            {
              install_id: r.install_id,
              job_id: null,
              job_kind: null,
              code: r.version,
              message: null,
              since,
            },
          ]
        : [];
    });
    version_skew = { open: rows.length > 0, rows };
  } catch {
    console.error("provapi alert fleet skew_error");
    version_skew = unknown;
  }
  return { fleet_halted, version_skew };
}
