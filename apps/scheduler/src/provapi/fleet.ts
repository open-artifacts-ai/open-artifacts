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
// The watch (watchRecent): after a fleet upgrade the install is probed every
// tick. A failure holds the rollout. One that lasts FLEET_BLIP_MS always
// halts its version for good (a fleet_halt mark; fleet_halted opens) and
// ends that install's hold. It is also rolled back, but only inside
// FLEET_ROLLBACK_WINDOW_MS of the upgrade and only when a control proves
// the platform is fine: an install on an older version, health ok, that
// passes this tick. Otherwise a human decides. The next release clears the
// halt. version_skew opens for an install behind the target for
// FLEET_SKEW_MS, counted from when the duty first saw it behind.
import { isInstallId } from "@oa/provision/names";
import { compareVersions } from "@oa/provision/versions";
import type { AlertRow } from "@oa/shared/provisioning/alerts";
import { SYSTEM_ACTOR } from "@oa/shared/provisioning/system";
import type { Condition } from "./conditions.js";
import { bound, d1, type ProvapiEnv, within } from "./env.js";
import { type HealthProbe, publicRouteProbe } from "./health.js";
import { insertSystemJob, startJob } from "./jobs.js";
import { dutyCategory } from "./run.js";

/** Open fleet upgrades at once, the canary's included; also rollbacks per tick. */
export const FLEET_CONCURRENCY = 3;
/** Rollback only within this long of the upgrade (D1 is forward-only). */
export const FLEET_ROLLBACK_WINDOW_MS = 30 * 60_000;
/** A failure shorter than this is a blip: it holds, never halts. */
export const FLEET_BLIP_MS = 10 * 60_000;
/** A failure seen this long without a verdict opens fleet_halted (holding). */
export const FLEET_HOLD_ALERT_MS = 30 * 60_000;
/** version_skew: an install behind this long. */
export const FLEET_SKEW_MS = 6 * 60 * 60_000;
/** One /healthz probe; every probe of a tick runs at once. */
export const FLEET_PROBE_TIMEOUT_MS = 8_000;
/** Watched installs probed per tick; the rest wait (and hold). */
export const FLEET_PROBES_PER_TICK = 6;
/** Halts on other versions stay on fleet_halted this long. */
export const FLEET_HALT_ALERT_MS = 6 * 60 * 60_000;
/** Halt marks of other versions are pruned after this long. */
export const FLEET_HALT_KEEP_MS = 7 * 24 * 60 * 60_000;
/** `fleet_failing:<id>`: when its current failure was first seen. */
export const FLEET_FAILING_PREFIX = "fleet_failing:";
/** `fleet_halt:<version>:<id>`: the install's upgrade to it failed. */
export const FLEET_HALT_PREFIX = "fleet_halt:";
/** `fleet_behind:<id>`: when the duty first saw it behind the target. */
export const FLEET_BEHIND_PREFIX = "fleet_behind:";

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** The platform's release: the version tag "vX.Y.Z" as "X.Y.Z", else null. */
export function fleetTarget(
  meta: Pick<WorkerVersionMetadata, "tag"> | undefined,
): string | null {
  return STABLE_TAG.exec(meta?.tag ?? "")?.[1] ?? null;
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

const SYS = `'${SYSTEM_ACTOR.key}'`;
// Every system fleet job: request ids `fleet-…` and `fleetrb-…` (no LIKE
// wildcard in either prefix). `j` is the jobs alias.
const FLEET_UP = `j.actor_key = ${SYS} AND j.kind = 'upgrade' AND j.request_id LIKE 'fleet-%'`;
const FLEET_RB = `j.actor_key = ${SYS} AND j.kind = 'rollback' AND j.request_id LIKE 'fleetrb-%'`;
// What the duty may upgrade: active (not suspended, not upgrading), serving
// (not paused, closed or unrouted), idle, test hooks off.
const ELIGIBLE = `state = 'active' AND install_state = 'active' AND serving_mode = 'serving' AND active_job_id IS NULL AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL`;
const CANARY = `SELECT install_id, version, app_host, state, install_state, serving_mode, active_job_id, test_hooks FROM install_status WHERE install_id = ?1`;
// The canary's latest upgrade to ?2, any actor.
const CANARY_JOB = `SELECT status FROM jobs WHERE install_id = ?1 AND kind = 'upgrade' AND json_extract(args, '$.to') = ?2 ORDER BY created_at DESC, id DESC LIMIT 1`;
const BEHIND = `SELECT install_id, version FROM install_status WHERE ${ELIGIBLE} AND version <> ?1 AND install_id <> ?2 ORDER BY created_at, install_id`;
const OPEN = `SELECT COUNT(*) AS n FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')`;
// Every halting job, with the version it halts: a failed fleet upgrade
// (to), a fleet rollback (from). The marks are read with STATE.
const HALT_JOBS = `SELECT j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since,
  CASE WHEN j.kind = 'upgrade' THEN json_extract(j.args, '$.to') ELSE json_extract(j.args, '$.from') END AS version
FROM jobs j WHERE (${FLEET_UP} AND j.status = 'failed') OR (${FLEET_RB})`;
const STATE = `SELECT key, value FROM platform_state WHERE key GLOB 'fleet_*'`;
// The watch: each serving, active, idle install whose latest fleet upgrade
// is done and still live (no fleet rollback off it), finished since ?1 or
// with a failure still open. Halted ones are dropped in code.
const WATCH = `SELECT j.install_id AS install_id, json_extract(j.args, '$.from') AS prev, json_extract(j.args, '$.to') AS version, j.finished_at AS done_at, st.app_host AS app_host
FROM jobs j JOIN install_status st ON st.install_id = j.install_id
WHERE ${FLEET_UP} AND j.status = 'done' AND st.version = json_extract(j.args, '$.to')
  AND st.state = 'active' AND st.install_state = 'active' AND st.serving_mode = 'serving' AND st.active_job_id IS NULL
  AND j.id = (SELECT k.id FROM jobs k WHERE k.install_id = j.install_id AND k.actor_key = ${SYS} AND k.kind = 'upgrade' AND k.request_id LIKE 'fleet-%' ORDER BY k.created_at DESC, k.id DESC LIMIT 1)
  AND (j.finished_at >= ?1 OR EXISTS (SELECT 1 FROM platform_state p WHERE p.key = '${FLEET_FAILING_PREFIX}' || j.install_id))
  AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.install_id = j.install_id AND r.actor_key = ${SYS} AND r.kind = 'rollback' AND r.request_id LIKE 'fleetrb-%' AND json_extract(r.args, '$.from') = json_extract(j.args, '$.to'))
ORDER BY j.finished_at, j.install_id`;
// Control candidates: eligible, health ok, oldest first.
const CONTROLS = `SELECT s.install_id AS install_id, s.version AS version, s.app_host AS app_host FROM install_status s JOIN install_lifecycle l ON l.install_id = s.install_id
WHERE ${ELIGIBLE.replaceAll(/\b(state|install_state|serving_mode|active_job_id|test_hooks|version)\b/g, "s.$1")} AND s.app_host IS NOT NULL AND l.health = 'ok'
ORDER BY s.created_at, s.install_id`;
const LAGGING = `SELECT install_id FROM install_status
WHERE state = 'active' AND serving_mode = 'serving' AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND version <> ?1`;
// The insert's own checks, in the same statement: still eligible and still
// on `from` (?9); for an upgrade also under the cap, so overlapping ticks
// never open more than FLEET_CONCURRENCY between them.
const STILL_ON = `EXISTS (SELECT 1 FROM install_status WHERE install_id = ?3 AND ${ELIGIBLE} AND version = ?9)`;
const UNDER_CAP = `(SELECT COUNT(*) FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')) < ${FLEET_CONCURRENCY}`;
const SET_ONCE =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
const SET =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
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

interface Watched {
  install_id: string;
  prev: unknown;
  version: string;
  done_at: number;
  app_host: string | null;
}

type HaltRow = AlertRow & { version: string | null };

/** The fleet's platform_state rows, by prefix. */
interface FleetState {
  strikes: Map<string, number>;
  halts: HaltRow[];
  behind: Map<string, number>;
  keys: { key: string; value: number }[];
}

async function fleetState(db: D1Database): Promise<FleetState> {
  const { results } = await d1(
    db.prepare(STATE).all<{ key: string; value: number }>(),
  );
  const s: FleetState = {
    strikes: new Map(),
    halts: [],
    behind: new Map(),
    keys: results,
  };
  for (const { key, value } of results) {
    if (key.startsWith(FLEET_FAILING_PREFIX))
      s.strikes.set(key.slice(FLEET_FAILING_PREFIX.length), value);
    else if (key.startsWith(FLEET_BEHIND_PREFIX))
      s.behind.set(key.slice(FLEET_BEHIND_PREFIX.length), value);
    else if (key.startsWith(FLEET_HALT_PREFIX)) {
      const rest = key.slice(FLEET_HALT_PREFIX.length);
      const i = rest.lastIndexOf(":");
      if (i > 0)
        s.halts.push(haltMark(rest.slice(0, i), rest.slice(i + 1), value));
    }
  }
  return s;
}

const haltMark = (version: string, id: string, since: number): HaltRow => ({
  install_id: id,
  job_id: null,
  job_kind: null,
  code: "fleet_halt",
  message: null,
  since,
  version,
});

/** Every halt (jobs and marks), each with the version it halts. */
async function halts(db: D1Database, st: FleetState): Promise<HaltRow[]> {
  const { results } = await d1(db.prepare(HALT_JOBS).all<HaltRow>());
  return [...results, ...st.halts].sort(
    (a, b) =>
      a.since - b.since ||
      String(a.install_id).localeCompare(String(b.install_id)),
  );
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
}

/** One fleet tick. */
export async function fleetDue(
  env: ProvapiEnv,
  now: number,
  o: FleetOptions = {},
): Promise<void> {
  const db = env.PLATFORM_DB;
  const probe = o.probe ?? publicRouteProbe;
  const ms = o.timeoutMs ?? FLEET_PROBE_TIMEOUT_MS;
  const target = fleetTarget(env.CF_VERSION_METADATA);
  const st = await fleetState(db);

  // The watch runs with or without a canary or target: an upgrade already
  // made stays watched if the rollout is switched off.
  const watch = await watchRecent(env, now, st, probe, ms);
  await prune(env, now, st, target);

  const canaryId = fleetCanary(env.FLEET_CANARY);
  if (canaryId === null) {
    console.log("provapi fleet no_canary");
    return;
  }
  if (target === null) {
    // fleet_halted opens for it (fleetConditions).
    console.log("provapi fleet no_target");
    return;
  }
  await trackBehind(db, now, st, target);
  if (watch.hold) {
    console.log("provapi fleet holding");
    return;
  }
  if ((await halts(db, st)).some((h) => h.version === target)) {
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
  if (
    !watch.healthy.has(canaryId) &&
    !(await onTarget(probe, canaryId, canary.app_host, target, ms))
  ) {
    console.log("provapi fleet canary_unhealthy");
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
 * Probes the watch (up to FLEET_PROBES_PER_TICK) and the control all at
 * once, each bounded by its own timeout, so a hanging install can't starve
 * the control. Then, per failing install: a first failure is stamped; one
 * past FLEET_BLIP_MS is halted (always) and rolled back (at most
 * FLEET_CONCURRENCY a tick) when inside the rollback window and the control
 * passed. `hold` while any watched install fails or wasn't probed.
 */
async function watchRecent(
  env: ProvapiEnv,
  now: number,
  st: FleetState,
  probe: HealthProbe,
  ms: number,
): Promise<{ hold: boolean; healthy: Set<string> }> {
  const db = env.PLATFORM_DB;
  const { results } = await d1(
    db
      .prepare(WATCH)
      .bind(now - FLEET_ROLLBACK_WINDOW_MS)
      .all<Watched>(),
  );
  const halted = new Set(st.halts.map((h) => `${h.version}:${h.install_id}`));
  const all = results.filter(
    (r) =>
      typeof r.version === "string" &&
      !halted.has(`${r.version}:${r.install_id}`),
  );
  const healthy = new Set<string>();
  // A strike of an install that left the watch (suspended, paused, busy,
  // rolled back, halted) is over.
  const watched = new Set(all.map((r) => r.install_id));
  for (const id of st.strikes.keys())
    if (!watched.has(id)) {
      await d1(db.prepare(CLEAR).bind(strikeKey(id)).run());
      st.strikes.delete(id);
    }
  if (all.length === 0) return { hold: false, healthy };
  const probed = all.slice(0, FLEET_PROBES_PER_TICK);
  const control = await pickControl(db, probed);
  const [verdicts, controlOk] = await Promise.all([
    Promise.all(
      probed.map((r) =>
        r.app_host === null
          ? false
          : onTarget(probe, r.install_id, r.app_host, r.version, ms),
      ),
    ),
    control === null
      ? false
      : onTarget(
          probe,
          control.install_id,
          control.app_host,
          control.version,
          ms,
        ),
  ]);
  let hold = all.length > probed.length;
  let rollbacks = 0;
  for (const [i, r] of probed.entries()) {
    try {
      if (verdicts[i]) {
        healthy.add(r.install_id);
        if (st.strikes.has(r.install_id))
          await d1(db.prepare(CLEAR).bind(strikeKey(r.install_id)).run());
        continue;
      }
      const first = st.strikes.get(r.install_id);
      // None yet, or one from before this upgrade finished: this is the first.
      if (first === undefined || first < r.done_at || first > now) {
        hold = true;
        await d1(db.prepare(SET).bind(strikeKey(r.install_id), now).run());
        console.log("provapi fleet unhealthy", r.install_id);
        continue;
      }
      if (now - first < FLEET_BLIP_MS) {
        hold = true;
        continue;
      }
      // Halted: the version stops, and this install no longer holds.
      await d1(
        db.prepare(SET_ONCE).bind(haltKey(r.version, r.install_id), now).run(),
      );
      // This tick's halt check reads `st`: it must see this mark too.
      st.halts.push(haltMark(r.version, r.install_id, now));
      await d1(db.prepare(CLEAR).bind(strikeKey(r.install_id)).run());
      st.strikes.delete(r.install_id);
      console.log("provapi fleet halted_by", r.install_id, r.version);
      const why =
        now - r.done_at > FLEET_ROLLBACK_WINDOW_MS
          ? "past_window"
          : !controlOk
            ? "no_control"
            : rollbacks >= FLEET_CONCURRENCY
              ? "rollback_cap"
              : typeof r.prev !== "string"
                ? "no_prev"
                : null;
      if (why !== null) {
        console.log("provapi fleet no_rollback", r.install_id, why);
        continue;
      }
      rollbacks++;
      await rollBack(env, now, r, r.prev as string);
    } catch (e) {
      hold = true;
      console.error(
        "provapi fleet watch_failed",
        dutyCategory(e),
        r.install_id,
      );
    }
  }
  return { hold, healthy };
}

/**
 * The control: the oldest eligible install outside the watch, health ok,
 * on a version below every probed one.
 */
async function pickControl(
  db: D1Database,
  probed: readonly Watched[],
): Promise<{ install_id: string; version: string; app_host: string } | null> {
  const ids = new Set(probed.map((r) => r.install_id));
  const { results } = await d1(
    db
      .prepare(CONTROLS)
      .all<{ install_id: string; version: string; app_host: string }>(),
  );
  for (const c of results) {
    if (ids.has(c.install_id)) continue;
    try {
      if (probed.every((r) => compareVersions(c.version, r.version) < 0))
        return c;
    } catch {}
  }
  return null;
}

async function rollBack(
  env: ProvapiEnv,
  now: number,
  r: Watched,
  to: string,
): Promise<void> {
  const id = await insertSystemJob(
    env.PLATFORM_DB,
    {
      kind: "rollback",
      installId: r.install_id,
      signupId: null,
      parentJobId: null,
      requestId: fleetRollbackRequestId(r.install_id, r.version),
      args: { from: r.version, to },
    },
    now,
    { sql: STILL_ON, params: [r.version] },
  );
  if (id === null) {
    console.log("provapi fleet no_rollback", r.install_id, "not_queued");
    return;
  }
  console.log("provapi fleet rollback queued", r.install_id, id);
  try {
    await startJob(bound(env.MANAGE_INSTALL), id);
  } catch (e) {
    console.error("provapi fleet start_failed", dutyCategory(e), r.install_id);
  }
}

/** Stamps when each lagging install was first seen behind; clears the rest. */
async function trackBehind(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
): Promise<void> {
  const { results } = await d1(
    db.prepare(LAGGING).bind(target).all<{ install_id: string }>(),
  );
  const lagging = new Set(results.map((r) => r.install_id));
  for (const id of lagging)
    if (!st.behind.has(id))
      await d1(
        db.prepare(SET_ONCE).bind(`${FLEET_BEHIND_PREFIX}${id}`, now).run(),
      );
  for (const id of st.behind.keys())
    if (!lagging.has(id))
      await d1(db.prepare(CLEAR).bind(`${FLEET_BEHIND_PREFIX}${id}`).run());
}

/**
 * Drops fleet state nothing reads any more: strikes of installs that left
 * the watch a day ago, and halt marks of other versions past
 * FLEET_HALT_KEEP_MS.
 */
async function prune(
  env: ProvapiEnv,
  now: number,
  st: FleetState,
  target: string | null,
): Promise<void> {
  const db = env.PLATFORM_DB;
  for (const [id, at] of st.strikes)
    if (at < now - 24 * 60 * 60_000)
      await d1(db.prepare(CLEAR).bind(strikeKey(id)).run());
  for (const h of st.halts)
    if (h.version !== target && h.since < now - FLEET_HALT_KEEP_MS)
      await d1(
        db
          .prepare(CLEAR)
          .bind(haltKey(h.version as string, h.install_id as string))
          .run(),
      );
}

/**
 * fleet_halted and version_skew for this tick.
 * - fleet_halted: halts on the target, any halt on another version in the
 *   last FLEET_HALT_ALERT_MS, a failure held past FLEET_HOLD_ALERT_MS
 *   (holding), and a canary set with no target (no_target).
 * - version_skew: installs first seen behind FLEET_SKEW_MS ago. Unknown with
 *   no canary or no target, so it never sends a false all-clear.
 */
export async function fleetConditions(
  env: Pick<ProvapiEnv, "PLATFORM_DB" | "CF_VERSION_METADATA" | "FLEET_CANARY">,
  now: number,
): Promise<{ fleet_halted: Condition; version_skew: Condition }> {
  const unknown: Condition = { open: null, rows: [] };
  const db = env.PLATFORM_DB;
  const target = fleetTarget(env.CF_VERSION_METADATA);
  const canary = fleetCanary(env.FLEET_CANARY);
  let st: FleetState;
  try {
    st = await fleetState(db);
  } catch {
    console.error("provapi alert fleet query_error");
    return { fleet_halted: unknown, version_skew: unknown };
  }
  const row = (
    o: Partial<AlertRow> & { since: number; code: string },
  ): AlertRow => ({
    install_id: null,
    job_id: null,
    job_kind: null,
    message: null,
    ...o,
  });
  let fleet_halted: Condition;
  try {
    const rows: AlertRow[] = (await halts(db, st))
      .filter(
        (h) =>
          (target !== null && h.version === target) ||
          h.since >= now - FLEET_HALT_ALERT_MS,
      )
      .map(({ version: _v, ...r }) => r);
    for (const [id, at] of st.strikes)
      if (now - at >= FLEET_HOLD_ALERT_MS)
        rows.push(row({ install_id: id, code: "holding", since: at }));
    if (canary !== null && target === null)
      rows.push(row({ code: "no_target", since: now }));
    fleet_halted = { open: rows.length > 0, rows };
  } catch {
    console.error("provapi alert fleet query_error");
    fleet_halted = unknown;
  }
  if (canary === null || target === null)
    return { fleet_halted, version_skew: unknown };
  const rows = [...st.behind]
    .filter(([, at]) => now - at >= FLEET_SKEW_MS)
    .map(([id, at]) => row({ install_id: id, code: "behind", since: at }));
  return { fleet_halted, version_skew: { open: rows.length > 0, rows } };
}
