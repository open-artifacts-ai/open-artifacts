// The fleet rollout (#955): every install follows the platform's release.
// The target is this Worker's own release, its version tag (the
// "workers/tag" annotation deploy-hosted-platform sets on every platform
// Worker), so the fleet moves when the platform does: staging on the staging
// deploy, prod on the prod deploy, which a green staging red-line gates.
//
// The canary (FLEET_CANARY) goes first, must settle, and then must pass the
// canary smoke (smoke.ts, #1343): short active checks as a dedicated smoke
// member, which replace the old passive soak. Then FLEET_SECOND (prod's leo),
// alone, if it is behind and may move; it settles too. Then batches of
// FLEET_CONCURRENCY, oldest first, each settling whole before the next
// starts. Only serving,
// active, idle installs with health ok and test hooks off move: a broken
// install is skipped (version_skew reports it), so it can't halt a release.
// The exception is an install on a halted version, or one that halted a
// version: it gets one try at a later release whatever its health or serving
// mode, as that may be its fix. It has to soak to earn another, so one broken
// install can't halt every release. An install above the target is never
// downgraded.
//
// Settle (the "soaked" marks, so state carries over): every tick probes the
// installs upgraded to the target. One settles once its probes pass unbroken
// for FLEET_SOAK_MS, two passes on separate ticks. A tick with no probe
// doesn't count: a gap over FLEET_SOAK_GAP_MS restarts the clock, as a
// failure does.
//
// Smoke: once the canary has settled, smoke() runs once per tick until it
// passes (fleet_smoked). The canary answering wrongly halts the version at
// once; a timeout, network error or 5xx counts once, and a second on a later
// tick halts. A smoke that can't run as set up (no token, smoke-a not a plain
// member, a bad share target) never passes and never halts: fleet_halted names it
// (smoke_unconfigured). Running out of the tick's time is neither.
//
// Halt: a failed fleet upgrade, or a second failed probe of that version on a
// later tick, on any install, halts the version for good and alerts. Nothing
// resets a failed probe: not a pass, and not the install leaving the watch,
// so flapping halts, and so does a release failing once on every install. A person
// decides what happens to the install: there is no automatic rollback here
// (#1105), though ManageInstall reverts an upgrade that fails its own checks.
// A halt never blocks the next release. The insert re-reads the halt and the
// batch in the same statement, so an overlapping tick can't queue onto a
// halted version or past an unsoaked batch, and halting cancels what is still
// queued for it.
import { isInstallId } from "@oa/provision/names";
import { compareVersions } from "@oa/provision/versions";
import type { AlertRow } from "@oa/provisioning-contract/alerts";
import { alertStateKey } from "@oa/provisioning-contract/state";
import { SYSTEM_ACTOR } from "@oa/provisioning-contract/system";
import type { Condition } from "./conditions.js";
import { bound, d1, type ProvapiEnv, within } from "./env.js";
import { type HealthProbe, publicRouteProbe } from "./health.js";
import { insertSystemJob, startJob } from "./jobs.js";
import { dutyCategory } from "./run.js";
import { type SmokeInput, type SmokeResult, smoke } from "./smoke.js";

/** A batch: open fleet upgrades at once, the insert's own guard included. */
export const FLEET_CONCURRENCY = 3;
/**
 * Unbroken passing probes this long and an install has settled: two passes on
 * separate two-minute ticks (#1343: no passive soak; the canary smoke
 * replaces it).
 */
export const FLEET_SOAK_MS = 2 * 60_000;
/**
 * With the smoke off (FLEET_SMOKE "off"): the passive soak as before #1343's
 * smoke, unbroken passing probes this long, and no smoke.
 */
export const FLEET_SOAK_OFF_MS = 15 * 60_000;

/**
 * FLEET_SMOKE, per env: "off" keeps the passive soak (FLEET_SOAK_OFF_MS) and
 * runs no smoke; "required" settles (FLEET_SOAK_MS) and must pass the smoke.
 * Anything else, unset included, is "required": a typo never skips it.
 */
export type SmokeMode = "required" | "off";
export const fleetSmokeMode = (v: string | undefined): SmokeMode =>
  v?.trim() === "off" ? "off" : "required";
const soakOf = (m: SmokeMode) =>
  m === "off" ? FLEET_SOAK_OFF_MS : FLEET_SOAK_MS;
/** Passes further apart than this aren't unbroken: the clock restarts. */
export const FLEET_SOAK_GAP_MS = 5 * 60_000;
/** The canary isn't settled and smoked on the target this long: fleet_halted opens. */
export const FLEET_BLOCKED_MS = 45 * 60_000;
/** version_skew: an install off the target this long. */
export const FLEET_SKEW_MS = 6 * 60 * 60_000;
/** One /healthz probe; every probe of a tick runs at once. */
export const FLEET_PROBE_TIMEOUT_MS = 8_000;
/** Halts on other versions stay on fleet_halted this long. */
export const FLEET_HALT_ALERT_MS = 6 * 60 * 60_000;
/** Marks of versions below the target are pruned after this long. */
export const FLEET_KEEP_MS = 7 * 24 * 60 * 60_000;
/** `fleet_halt:<version>:<id>`: that install halted the version. */
export const FLEET_HALT_PREFIX = "fleet_halt:";
/** `fleet_fail:<version>`: that version's first failed probe. Nothing resets it. */
export const FLEET_FAIL_PREFIX = "fleet_fail:";
/** `fleet_pass:<version>:<id>`: value, the run's start; updated_at, its last pass. */
export const FLEET_PASS_PREFIX = "fleet_pass:";
/** `fleet_soaked:<version>:<id>`: it soaked on that version. */
export const FLEET_SOAKED_PREFIX = "fleet_soaked:";
/** `fleet_smoked:<version>:<id>`: the canary passed the smoke on that version. */
export const FLEET_SMOKED_PREFIX = "fleet_smoked:";
/** `fleet_smoke_fail:<version>:<check>`: the smoke's first transport failure. */
export const FLEET_SMOKE_FAIL_PREFIX = "fleet_smoke_fail:";
/** `fleet_smoke_halt:<version>:<check>`: the check whose failure halted it. */
export const FLEET_SMOKE_HALT_PREFIX = "fleet_smoke_halt:";
/** `fleet_smoke_config:<version>:<check>`: the smoke can't run as set up. */
export const FLEET_SMOKE_CONFIG_PREFIX = "fleet_smoke_config:";
/** `fleet_blocked:<version>`: when the duty first saw it as the target, the canary not soaked on it. */
export const FLEET_BLOCKED_PREFIX = "fleet_blocked:";
/** `fleet_retry:<id>`: it spent its one try while broken. Soaking clears it. */
export const FLEET_RETRY_PREFIX = "fleet_retry:";
/** `fleet_behind:<id>`: when the duty first saw it off the target. */
export const FLEET_BEHIND_PREFIX = "fleet_behind:";

const VERSIONED_PREFIXES = [
  FLEET_HALT_PREFIX,
  FLEET_FAIL_PREFIX,
  FLEET_PASS_PREFIX,
  FLEET_SOAKED_PREFIX,
  FLEET_BLOCKED_PREFIX,
  FLEET_SMOKED_PREFIX,
  FLEET_SMOKE_FAIL_PREFIX,
  FLEET_SMOKE_HALT_PREFIX,
  FLEET_SMOKE_CONFIG_PREFIX,
] as const;

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

/**
 * FLEET_SECOND (#1343, prod's leo) when it is an install id other than the
 * canary, else null. It goes first among the installs still behind, alone,
 * once the canary has settled and passed the smoke; the batches wait for it
 * to settle.
 */
export const fleetSecond = (
  v: string | undefined,
  canary: string | null,
): string | null => {
  const id = fleetCanary(v);
  return id !== null && id !== canary ? id : null;
};

/** A fleet upgrade's request id: one per install and target. */
export function fleetRequestId(installId: string, to: string): string {
  if (!isInstallId(installId) || !/^\d+\.\d+\.\d+$/.test(to))
    throw new Error("fleet request id: bad install id or version");
  return `fleet-${installId}-${to.replaceAll(".", "_")}`;
}

const haltKey = (v: string, id: string) => `${FLEET_HALT_PREFIX}${v}:${id}`;
const failKey = (v: string) => `${FLEET_FAIL_PREFIX}${v}`;
const passKey = (v: string, id: string) => `${FLEET_PASS_PREFIX}${v}:${id}`;
const soakedKey = (v: string, id: string) => `${FLEET_SOAKED_PREFIX}${v}:${id}`;
const blockedKey = (v: string) => `${FLEET_BLOCKED_PREFIX}${v}`;
const retryKey = (id: string) => `${FLEET_RETRY_PREFIX}${id}`;

const SYS = `'${SYSTEM_ACTOR.key}'`;
// Every fleet upgrade: request ids `fleet-…` (no LIKE wildcard in the prefix).
// `j` is the jobs alias.
const FLEET_UP = `j.actor_key = ${SYS} AND j.kind = 'upgrade' AND j.request_id LIKE 'fleet-%'`;
// A failure of the release: an operator's cancel, or the halt's own, is not.
const FAILED = `j.status = 'failed' AND COALESCE(j.error_code, '') <> 'canceled'`;
// What the duty may upgrade: active (not suspended, not upgrading), idle, test
// hooks off, and either serving and healthy or on its one try: on a halted
// version, or having halted one, with no try spent.
const ON_TRY = `(EXISTS (SELECT 1 FROM platform_state v WHERE v.key GLOB '${FLEET_HALT_PREFIX}' || version || ':*' OR v.key GLOB '${FLEET_HALT_PREFIX}*:' || install_id)
  AND NOT EXISTS (SELECT 1 FROM platform_state t WHERE t.key = '${FLEET_RETRY_PREFIX}' || install_id))`;
const ELIGIBLE = `state = 'active' AND install_state = 'active' AND active_job_id IS NULL AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND ((serving_mode = 'serving' AND health = 'ok') OR ${ON_TRY})`;
const CANARY = `SELECT install_id, version, app_host, state, install_state, serving_mode, active_job_id, test_hooks, health FROM install_status WHERE install_id = ?1`;
// The canary's latest upgrade to ?2, any actor.
const CANARY_JOB = `SELECT status, error_code FROM jobs WHERE install_id = ?1 AND kind = 'upgrade' AND json_extract(args, '$.to') = ?2 ORDER BY created_at DESC, id DESC LIMIT 1`;
const BEHIND = `SELECT install_id, version, serving_mode, health FROM install_status WHERE ${ELIGIBLE} AND version <> ?1 AND install_id <> ?2 ORDER BY created_at, install_id`;
const OPEN = `SELECT COUNT(*) AS n FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')`;
// The batch of version `to`, as SQL: every install a fleet upgrade to it
// reached, not yet soaked there. A canceled job counts if the install is on
// `to`: R25 can land after the version moved. Only soaking takes an install
// out, or the install going away. Suspended, paused, busy or rolled back, it
// still holds the next batch: a person acted on it, so nothing moves past it.
const BATCH = (to: string) =>
  `SELECT j.install_id AS install_id FROM jobs j JOIN install_status s ON s.install_id = j.install_id
WHERE ${FLEET_UP} AND json_extract(j.args, '$.to') = ${to}
  AND (j.status = 'done' OR (j.status = 'failed' AND j.error_code = 'canceled' AND s.version = ${to}))
  AND s.state NOT IN ('deleting', 'deleted')
  AND NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key = '${FLEET_SOAKED_PREFIX}' || ${to} || ':' || j.install_id)`;
const HELD = `${BATCH("?1")} LIMIT 1`;
// Every failed fleet upgrade, with the version it halts. A member held by a
// migration only a person may cross doesn't halt it: it stays behind, version_skew
// shows it, and the rollout carries on. The canary's hold (?1) still halts.
const HALT_JOBS = `SELECT j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since, json_extract(j.args, '$.to') AS version
FROM jobs j WHERE ${FLEET_UP} AND ${FAILED} AND (COALESCE(j.error_code, '') <> 'migration_held' OR j.install_id = ?1)`;
// The fleet upgrade behind a mark, for the alert.
const MARK_JOB = `SELECT j.id AS id, j.kind AS kind FROM jobs j WHERE ${FLEET_UP} AND j.install_id = ?1 AND json_extract(j.args, '$.to') = ?2 LIMIT 1`;
const STATE = `SELECT key, value, updated_at FROM platform_state WHERE key GLOB 'fleet_*'`;
// The watch: installs still on an upgrade to the target (?1) that is done,
// serving, active and idle, not yet soaked, on a version not halted. Only the
// target's, so it never outgrows a batch and old marks can go.
const WATCH = `SELECT j.install_id AS install_id, st.app_host AS app_host
FROM jobs j JOIN install_status st ON st.install_id = j.install_id
WHERE ${FLEET_UP} AND (j.status = 'done' OR (j.status = 'failed' AND j.error_code = 'canceled')) AND json_extract(j.args, '$.to') = ?1 AND st.version = ?1
  AND st.state = 'active' AND st.install_state = 'active' AND st.serving_mode = 'serving' AND st.active_job_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key = '${FLEET_SOAKED_PREFIX}' || ?1 || ':' || j.install_id)
  AND NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key GLOB '${FLEET_HALT_PREFIX}' || ?1 || ':*')
ORDER BY j.finished_at, j.install_id`;
const LAGGING = `SELECT install_id FROM install_status
WHERE state = 'active' AND serving_mode = 'serving' AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND version <> ?1`;
// The insert's own checks, in the same statement, so nothing can change
// between them and the insert. ?9 is `from`; ?10, the args, holds the version.
const STILL_ON = `EXISTS (SELECT 1 FROM install_status WHERE install_id = ?3 AND ${ELIGIBLE} AND version = ?9)`;
const UNDER_CAP = `(SELECT COUNT(*) FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')) < ${FLEET_CONCURRENCY}`;
// A held job isn't a failure of the release here: on the canary, the tick's
// haltFailedJobs has already marked the version, and the first line stops it.
const NOT_HALTED = `NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key GLOB '${FLEET_HALT_PREFIX}' || json_extract(?10, '$.to') || ':*')
AND NOT EXISTS (SELECT 1 FROM jobs j WHERE ${FLEET_UP} AND ${FAILED} AND COALESCE(j.error_code, '') <> 'migration_held' AND json_extract(j.args, '$.to') = json_extract(?10, '$.to'))
AND NOT EXISTS (${BATCH("json_extract(?10, '$.to')")})`;
const SET_ONCE =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
const SET_PASS =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
const CLEAR = "DELETE FROM platform_state WHERE key = ?1";
// Both only for a new mark, so they run before the batch writes it.
const AUDIT = `INSERT INTO hosted_audit (at, actor, install_id, action, detail) SELECT ?1, '${SYSTEM_ACTOR.key}', ?2, 'fleet.halted', ?3 WHERE NOT EXISTS (SELECT 1 FROM platform_state WHERE key = ?4)`;
// A new halt owes an email, even while the alert is already open.
const OWE_EMAIL =
  "UPDATE platform_state SET value = 0 WHERE key = ?1 AND NOT EXISTS (SELECT 1 FROM platform_state WHERE key = ?2)";
// A started instance stops at its recheck (checkJob: the job is failed), so
// no terminate. Queued only: one already running finishes.
const CANCEL_QUEUED = `UPDATE jobs AS j SET status = 'failed', error_code = 'canceled', error_message = 'the fleet rollout of this version halted', finished_at = ?2, updated_at = ?2
WHERE ${FLEET_UP} AND j.status = 'queued' AND json_extract(j.args, '$.to') = ?1`;

interface CanaryRow {
  install_id: string;
  version: string | null;
  app_host: string | null;
  state: string;
  install_state: string | null;
  serving_mode: string | null;
  active_job_id: string | null;
  test_hooks: number | null;
  health: string | null;
}

interface Watched {
  install_id: string;
  app_host: string | null;
}

type HaltRow = Omit<AlertRow, "version"> & { version: string | null };

interface StateRow {
  key: string;
  value: number;
  updated_at: number;
}

/** The fleet's platform_state rows, kept current through the tick. */
interface FleetState {
  rows: Map<string, StateRow>;
  behind: Map<string, number>;
}

async function fleetState(db: D1Database): Promise<FleetState> {
  const { results } = await d1(db.prepare(STATE).all<StateRow>());
  const s: FleetState = { rows: new Map(), behind: new Map() };
  for (const r of results) {
    s.rows.set(r.key, r);
    if (r.key.startsWith(FLEET_BEHIND_PREFIX))
      s.behind.set(r.key.slice(FLEET_BEHIND_PREFIX.length), r.value);
  }
  return s;
}

/** A versioned key's version, or null for one that isn't. */
function versionOf(key: string): string | null {
  for (const p of VERSIONED_PREFIXES) {
    if (key.startsWith(p)) return key.slice(p.length).split(":")[0] ?? null;
  }
  return null;
}

const failedJobs = async (db: D1Database, canary: string | null) =>
  (await d1(db.prepare(HALT_JOBS).bind(canary).all<HaltRow>())).results;

/** Every halt: failed jobs, and marks with no failed job behind them. */
async function halts(
  db: D1Database,
  st: FleetState,
  canary: string | null,
): Promise<HaltRow[]> {
  const jobs = await failedJobs(db, canary);
  const fromJob = new Set(jobs.map((j) => `${j.version}:${j.install_id}`));
  const marks: HaltRow[] = [];
  for (const [key, r] of st.rows) {
    if (!key.startsWith(FLEET_HALT_PREFIX)) continue;
    const rest = key.slice(FLEET_HALT_PREFIX.length);
    const i = rest.indexOf(":");
    if (i <= 0 || fromJob.has(rest)) continue;
    const install = rest.slice(i + 1);
    const version = rest.slice(0, i);
    const job = await d1(
      db
        .prepare(MARK_JOB)
        .bind(install, version)
        .first<{ id: string; kind: string }>(),
    );
    // A smoke halt names its check (a fixed word), never a body.
    const check =
      install === canary
        ? smokeCheckOf(st, FLEET_SMOKE_HALT_PREFIX, version)
        : null;
    marks.push({
      install_id: install,
      job_id: job?.id ?? null,
      job_kind: job?.kind ?? null,
      code: check === null ? "fleet_halt" : "smoke_failed",
      message: check,
      since: r.value,
      version,
    });
  }
  return [...jobs, ...marks].sort(
    (a, b) =>
      a.since - b.since ||
      String(a.install_id).localeCompare(String(b.install_id)),
  );
}

/** The check named by a `<prefix><version>:<check>` key, if any. */
function smokeCheckOf(
  st: FleetState,
  prefix: string,
  version: string,
): string | null {
  for (const key of st.rows.keys())
    if (key.startsWith(`${prefix}${version}:`))
      return key.slice(`${prefix}${version}:`.length);
  return null;
}

/** Whether any install halted `version`, this tick's halts included. */
function isHalted(st: FleetState, version: string): boolean {
  for (const key of st.rows.keys())
    if (key.startsWith(`${FLEET_HALT_PREFIX}${version}:`)) return true;
  return false;
}

/** Whether this install has its one try: as ON_TRY, for what the tick read. */
function onTry(st: FleetState, id: string, version: string | null): boolean {
  if (st.rows.has(retryKey(id))) return false;
  if (version !== null && isHalted(st, version)) return true;
  for (const key of st.rows.keys())
    if (key.startsWith(FLEET_HALT_PREFIX) && key.endsWith(`:${id}`))
      return true;
  return false;
}

/**
 * Halts `version`, durably: the mark, the audit row, an owed email and the
 * cancel of what is queued for it, in one batch.
 */
async function halt(
  db: D1Database,
  now: number,
  st: FleetState,
  version: string,
  id: string,
): Promise<void> {
  const key = haltKey(version, id);
  await d1(
    db.batch([
      db.prepare(AUDIT).bind(now, id, JSON.stringify({ version }), key),
      db
        .prepare(OWE_EMAIL)
        .bind(alertStateKey("fleet_halted", "notified_at"), key),
      db.prepare(SET_ONCE).bind(key, now),
      db.prepare(CANCEL_QUEUED).bind(version, now),
    ]),
  );
  if (!st.rows.has(key)) st.rows.set(key, { key, value: now, updated_at: now });
  console.log("provapi fleet halted_by", id, version);
}

/** A failed fleet upgrade halts its version: its mark, once. */
async function haltFailedJobs(
  db: D1Database,
  now: number,
  st: FleetState,
  canary: string | null,
): Promise<void> {
  for (const j of await failedJobs(db, canary)) {
    if (typeof j.version !== "string" || typeof j.install_id !== "string")
      continue;
    if (!st.rows.has(haltKey(j.version, j.install_id)))
      await halt(db, now, st, j.version, j.install_id);
  }
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
  /** Tests only: the canary smoke (default smoke() over fetch). */
  smoke?: (i: SmokeInput) => Promise<SmokeResult>;
}

/** The fleet duty's env: the smoke also reads the broker origin (a var). */
export type FleetEnv = ProvapiEnv & { AUTH_BROKER_ORIGIN?: string };

/** One fleet tick. */
export async function fleetDue(
  env: FleetEnv,
  now: number,
  o: FleetOptions = {},
): Promise<void> {
  const db = env.PLATFORM_DB;
  const probe = o.probe ?? publicRouteProbe;
  const ms = o.timeoutMs ?? FLEET_PROBE_TIMEOUT_MS;
  const target = fleetTarget(env.CF_VERSION_METADATA);
  const canaryId = fleetCanary(env.FLEET_CANARY);
  const secondId = fleetSecond(env.FLEET_SECOND, canaryId);
  const st = await fleetState(db);

  await haltFailedJobs(db, now, st, canaryId);
  await prune(db, now, st, target);
  if (target === null) {
    // With a canary set, fleet_halted opens for it (fleetConditions).
    console.log("provapi fleet no_target");
    return;
  }
  const canary =
    canaryId === null
      ? null
      : await d1(db.prepare(CANARY).bind(canaryId).first<CanaryRow>());
  // Runs with or without a canary: switching the rollout off never drops an
  // upgrade already made.
  const mode = fleetSmokeMode(env.FLEET_SMOKE);
  const hold = await watch(
    db,
    now,
    st,
    target,
    canary,
    probe,
    ms,
    soakOf(mode),
  );
  if (canaryId === null) {
    console.log("provapi fleet no_canary");
    return;
  }
  await trackBehind(db, now, st, target);
  await trackCanary(db, now, st, target, canaryId, mode);
  if (isHalted(st, target)) {
    console.log("provapi fleet halted", target);
    return;
  }
  if (hold) {
    console.log("provapi fleet holding");
    return;
  }
  const manage = bound(env.MANAGE_INSTALL);

  const ready = await canaryReady(env, now, st, canary, target, manage, o);
  if (!ready) {
    await stamp(db, now, st, target);
    return;
  }
  await clearBlocked(db, st);

  // A batch starts whole, and only once the last one has soaked: the watch
  // holds until then, and this until its last job is done. The insert's
  // guards are what hold the cap and the halt.
  const open = await d1(db.prepare(OPEN).first<{ n: number }>());
  if ((open?.n ?? 0) > 0) return;
  const { results } = await d1(
    db.prepare(BEHIND).bind(target, canaryId).all<{
      install_id: string;
      version: string;
      serving_mode: string | null;
      health: string | null;
    }>(),
  );
  // FLEET_SECOND first among those behind, and alone: the watch then holds
  // the batches until it soaks, as it holds them for any batch. If its insert
  // doesn't land (its request id spent by a canceled job, or the guard
  // refusing it), the batches go on without it: it can't stall the rollout.
  const below = (v: string) => {
    try {
      return compareVersions(v, target) < 0;
    } catch {
      return false;
    }
  };
  const second = results.find(
    (r) => r.install_id === secondId && below(r.version),
  );
  if (second !== undefined) {
    const broken = second.serving_mode !== "serving" || second.health !== "ok";
    if (
      await upgrade(
        env,
        manage,
        now,
        second.install_id,
        second.version,
        target,
        broken,
      )
    )
      return;
  }
  let slots = FLEET_CONCURRENCY;
  for (const r of results) {
    if (slots <= 0) break;
    if (r === second) continue;
    let below: boolean;
    try {
      below = compareVersions(r.version, target) < 0;
    } catch {
      continue;
    }
    if (!below) continue;
    const broken = r.serving_mode !== "serving" || r.health !== "ok";
    if (
      await upgrade(env, manage, now, r.install_id, r.version, target, broken)
    )
      slots--;
  }
}

/**
 * The clock of canary_blocked: from when the duty first saw a target the canary
 * hasn't soaked on, whatever the reason, and again if a soaked canary can't
 * lead. It stops only once the canary is ready, or the target halted
 * (fleet_halted says so itself). An older stamp stays, so a release shipped
 * during a block doesn't read as an all-clear.
 */
async function trackCanary(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  canaryId: string,
  mode: SmokeMode,
): Promise<void> {
  if (isHalted(st, target)) await clearBlocked(db, st);
  else if (
    !st.rows.has(soakedKey(target, canaryId)) ||
    (mode === "required" && !st.rows.has(smokedKey(target, canaryId)))
  )
    await stamp(db, now, st, target);
}

async function stamp(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
): Promise<void> {
  const key = blockedKey(target);
  if (st.rows.has(key)) return;
  await d1(db.prepare(SET_ONCE).bind(key, now).run());
  st.rows.set(key, { key, value: now, updated_at: now });
}

async function clearBlocked(db: D1Database, st: FleetState): Promise<void> {
  for (const k of [...st.rows.keys()])
    if (k.startsWith(FLEET_BLOCKED_PREFIX)) {
      await d1(db.prepare(CLEAR).bind(k).run());
      st.rows.delete(k);
    }
}

/** Moves the canary toward the target; true once it has soaked there. */
async function canaryReady(
  env: FleetEnv,
  now: number,
  st: FleetState,
  canary: CanaryRow | null,
  target: string,
  manage: NonNullable<ProvapiEnv["MANAGE_INSTALL"]>,
  o: FleetOptions,
): Promise<boolean> {
  const db = env.PLATFORM_DB;
  const stuck = (why: string) => {
    console.log("provapi fleet canary_blocked", why);
    return false;
  };
  if (
    canary?.state !== "active" ||
    (canary.test_hooks ?? 0) !== 0 ||
    canary.version === null ||
    canary.app_host === null
  )
    return stuck("unavailable");
  const id = canary.install_id;
  const exempt = onTry(st, id, canary.version);
  if (canary.serving_mode !== "serving" && !exempt) return stuck("unavailable");
  const last = await d1(
    db
      .prepare(CANARY_JOB)
      .bind(id, target)
      .first<{ status: string; error_code: string | null }>(),
  );
  const openJob = last?.status === "queued" || last?.status === "running";
  if (canary.install_state !== "active" || canary.active_job_id !== null) {
    if (!openJob) return stuck("busy");
    console.log("provapi fleet canary_busy");
    return false;
  }
  let c: number;
  try {
    c = compareVersions(canary.version, target);
  } catch {
    return stuck("bad_version");
  }
  if (c > 0) return stuck("off_target");
  if (c < 0 && canary.health !== "ok" && !exempt) return stuck("unhealthy");
  if (!(await published(env, target))) return false;
  if (c < 0) {
    const broken = canary.serving_mode !== "serving" || canary.health !== "ok";
    await upgrade(env, manage, now, id, canary.version, target, broken);
    return false;
  }
  // On the target, its upgrade (if it had one) done and not just written. A
  // cancel landed after the version moved: it soaked, so it counts.
  if (
    last !== null &&
    last.status !== "done" &&
    last.error_code !== "canceled"
  ) {
    console.log("provapi fleet canary_not_done");
    return false;
  }
  if (!st.rows.has(soakedKey(target, id))) return false;
  // FLEET_SMOKE "off": the soak alone, as before the smoke.
  if (fleetSmokeMode(env.FLEET_SMOKE) === "off") return true;
  if (st.rows.has(smokedKey(target, id))) return true;
  return await smokeCanary(env, now, st, canary, target, o);
}

const smokedKey = (v: string, id: string) => `${FLEET_SMOKED_PREFIX}${v}:${id}`;

/** Deletes every key with `prefix` + version + ":". */
async function clearFor(
  db: D1Database,
  st: FleetState,
  prefix: string,
  v: string,
): Promise<void> {
  for (const k of [...st.rows.keys()])
    if (k.startsWith(`${prefix}${v}:`)) {
      await d1(db.prepare(CLEAR).bind(k).run());
      st.rows.delete(k);
    }
}

async function setOnce(
  db: D1Database,
  st: FleetState,
  key: string,
  now: number,
): Promise<void> {
  if (st.rows.has(key)) return;
  await d1(db.prepare(SET_ONCE).bind(key, now).run());
  st.rows.set(key, { key, value: now, updated_at: now });
}

/**
 * One canary smoke (smoke.ts) on a settled canary; true once it passed. Only
 * check names and kinds are logged or stored: never the token, a body or an
 * address.
 */
async function smokeCanary(
  env: FleetEnv,
  now: number,
  st: FleetState,
  canary: CanaryRow,
  target: string,
  o: FleetOptions,
): Promise<boolean> {
  const db = env.PLATFORM_DB;
  const id = canary.install_id;
  const r = await (o.smoke ?? smoke)({
    fetch: (url, init) => fetch(url, init),
    installId: id,
    appHost: canary.app_host ?? "",
    token: env.FLEET_SMOKE_TOKEN,
    shareTo: env.FLEET_SMOKE_SHARE_TO,
    brokerOrigin: env.AUTH_BROKER_ORIGIN,
    version: target,
  });
  if (r.ok) {
    await clearFor(db, st, FLEET_SMOKE_CONFIG_PREFIX, target);
    await setOnce(db, st, smokedKey(target, id), now);
    console.log("provapi fleet smoke passed", id, target, ...r.notes);
    return true;
  }
  console.log("provapi fleet smoke", r.kind, r.check);
  if (r.kind === "budget") return false;
  if (r.kind === "config") {
    await clearFor(db, st, FLEET_SMOKE_CONFIG_PREFIX, target);
    await setOnce(
      db,
      st,
      `${FLEET_SMOKE_CONFIG_PREFIX}${target}:${r.check}`,
      now,
    );
    return false;
  }
  await clearFor(db, st, FLEET_SMOKE_CONFIG_PREFIX, target);
  if (r.kind === "transport") {
    // The first counts; a second on a later tick halts, as probes do.
    const first = [...st.rows.values()].find((x) =>
      x.key.startsWith(`${FLEET_SMOKE_FAIL_PREFIX}${target}:`),
    );
    if (first === undefined || first.value >= now) {
      await setOnce(
        db,
        st,
        `${FLEET_SMOKE_FAIL_PREFIX}${target}:${r.check}`,
        now,
      );
      return false;
    }
  }
  // Named before the halt, so the alert row can say which check.
  await setOnce(db, st, `${FLEET_SMOKE_HALT_PREFIX}${target}:${r.check}`, now);
  await halt(db, now, st, target, id);
  return false;
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
  broken = false,
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
      {
        sql: `${STILL_ON} AND ${UNDER_CAP} AND ${NOT_HALTED}`,
        params: [from],
      },
    );
  } catch (e) {
    console.error("provapi fleet install_failed", dutyCategory(e), installId);
    return false;
  }
  // null: already queued for this target, at the cap, halted, held by the
  // last batch, or not eligible.
  if (id === null) {
    const by = await env.PLATFORM_DB.prepare(HELD)
      .bind(to)
      .first<{ install_id: string }>()
      .catch(() => null);
    if (by) console.log(`provapi fleet held by ${by.install_id}`);
    return false;
  }
  if (broken)
    await d1(
      env.PLATFORM_DB.prepare(SET_ONCE).bind(retryKey(installId), now).run(),
    ).catch(() => console.error("provapi fleet retry_mark_failed", installId));
  console.log("provapi fleet upgrade queued", installId, id, `to=${to}`);
  try {
    await startJob(manage, id);
  } catch (e) {
    console.error("provapi fleet start_failed", dutyCategory(e), installId);
  }
  return true;
}

/**
 * Probes every unsoaked install on the target at once, each bounded by its
 * own timeout. A batch at most, so no probe waits on another. True while any
 * of them holds the next one back.
 */
async function watch(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  canary: CanaryRow | null,
  probe: HealthProbe,
  ms: number,
  soakMs: number,
): Promise<boolean> {
  const { results } = await d1(db.prepare(WATCH).bind(target).all<Watched>());
  const all = [...results];
  // A canary already on the target with no fleet upgrade soaks all the same.
  if (
    canary !== null &&
    canary.version === target &&
    canary.state === "active" &&
    canary.install_state === "active" &&
    canary.serving_mode === "serving" &&
    canary.active_job_id === null &&
    (canary.test_hooks ?? 0) === 0 &&
    !st.rows.has(soakedKey(target, canary.install_id)) &&
    !isHalted(st, target) &&
    !all.some((r) => r.install_id === canary.install_id)
  )
    all.push({ install_id: canary.install_id, app_host: canary.app_host });
  const verdicts = await Promise.all(
    all.map((r) =>
      r.app_host === null
        ? false
        : onTarget(probe, r.install_id, r.app_host, target, ms),
    ),
  );
  let hold = false;
  for (const [i, r] of all.entries()) {
    try {
      const soaked = verdicts[i]
        ? await passed(db, now, st, target, r.install_id, soakMs)
        : await failed(db, now, st, target, r.install_id);
      if (!soaked) hold = true;
    } catch (e) {
      hold = true;
      console.error(
        "provapi fleet watch_failed",
        dutyCategory(e),
        r.install_id,
      );
    }
  }
  return hold;
}

/** One passing probe; true once the install has soaked. */
async function passed(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  id: string,
  soakMs: number,
): Promise<boolean> {
  const key = passKey(target, id);
  const prev = st.rows.get(key);
  const unbroken = prev && now - prev.updated_at <= FLEET_SOAK_GAP_MS;
  const start = unbroken ? prev.value : now;
  if (now - start < soakMs) {
    await d1(db.prepare(SET_PASS).bind(key, start, now).run());
    st.rows.set(key, { key, value: start, updated_at: now });
    return false;
  }
  const done = soakedKey(target, id);
  await d1(
    db.batch([
      db.prepare(SET_ONCE).bind(done, now),
      db.prepare(CLEAR).bind(key),
      db.prepare(CLEAR).bind(retryKey(id)),
    ]),
  );
  st.rows.set(done, { key: done, value: now, updated_at: now });
  st.rows.delete(key);
  st.rows.delete(retryKey(id));
  console.log("provapi fleet soaked", id, target);
  return true;
}

/**
 * One failed probe of the version. The first restarts this install's soak and
 * stays; a later tick's, on any install, halts the version. True then: a
 * halted version holds nothing back.
 */
async function failed(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  id: string,
): Promise<boolean> {
  const key = failKey(target);
  const first = st.rows.get(key);
  if (first !== undefined && first.value < now) {
    await halt(db, now, st, target, id);
    return true;
  }
  await d1(
    db.batch([
      db.prepare(SET_ONCE).bind(key, now),
      db.prepare(CLEAR).bind(passKey(target, id)),
    ]),
  );
  if (first === undefined)
    st.rows.set(key, { key, value: now, updated_at: now });
  st.rows.delete(passKey(target, id));
  console.log("provapi fleet unhealthy", id);
  return false;
}

/** Stamps when each lagging install was first seen off; clears the rest. */
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
 * Drops marks of versions below the target past FLEET_KEEP_MS. The watch and
 * the insert only ever read the target's. Never with no target: what is
 * current is then unknown, and a resumed rollout would go onto a halted
 * version.
 */
async function prune(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string | null,
): Promise<void> {
  if (target === null) return;
  for (const [key, r] of st.rows) {
    const v = versionOf(key);
    if (v === null || r.value >= now - FLEET_KEEP_MS) continue;
    let older: boolean;
    try {
      older = compareVersions(v, target) < 0;
    } catch {
      continue;
    }
    if (!older) continue;
    await d1(db.prepare(CLEAR).bind(key).run());
    st.rows.delete(key);
  }
}

/** A row's version and the install's fleet upgrade to it, if it had one. */
async function named(db: D1Database, id: string, version: string | null) {
  if (version === null) return {};
  const job = await d1(
    db
      .prepare(MARK_JOB)
      .bind(id, version)
      .first<{ id: string; kind: string }>(),
  );
  return { version, job_id: job?.id ?? null, job_kind: job?.kind ?? null };
}

const isHeld = async (db: D1Database, target: string) =>
  (await d1(db.prepare(HELD).bind(target).first())) !== null;

/**
 * fleet_halted and version_skew for this tick.
 * - fleet_halted: halts on the target (smoke_failed when the canary smoke
 *   halted it), any halt on another version in the last FLEET_HALT_ALERT_MS,
 *   a canary not settled and smoked on the target FLEET_BLOCKED_MS after the
 *   duty first saw it (canary_blocked), a smoke that can't run as set up
 *   (smoke_unconfigured), and a canary set with no target (no_target).
 * - version_skew: installs first seen off FLEET_SKEW_MS ago. Unknown with no
 *   canary or no target, so it never sends a false all-clear.
 */
export async function fleetConditions(
  env: Pick<
    ProvapiEnv,
    "PLATFORM_DB" | "CF_VERSION_METADATA" | "FLEET_CANARY" | "FLEET_SMOKE"
  >,
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
    const rows: AlertRow[] = (await halts(db, st, canary))
      .filter(
        (h) =>
          (target !== null && h.version === target) ||
          h.since >= now - FLEET_HALT_ALERT_MS,
      )
      .map((r) => ({ ...r, version: r.version ?? undefined }));
    const stamps = [...st.rows.values()]
      .filter((r) => r.key.startsWith(FLEET_BLOCKED_PREFIX))
      .map((r) => r.value);
    const since = stamps.length > 0 ? Math.min(...stamps) : null;
    const unconfigured =
      canary !== null &&
      target !== null &&
      fleetSmokeMode(env.FLEET_SMOKE) === "required"
        ? smokeCheckOf(st, FLEET_SMOKE_CONFIG_PREFIX, target)
        : null;
    if (unconfigured !== null)
      rows.push(
        row({
          install_id: canary,
          code: "smoke_unconfigured",
          message: unconfigured,
          since:
            st.rows.get(`${FLEET_SMOKE_CONFIG_PREFIX}${target}:${unconfigured}`)
              ?.value ?? now,
        }),
      );
    if (canary !== null && since !== null && now - since >= FLEET_BLOCKED_MS)
      rows.push(
        row({
          install_id: canary,
          code: "canary_blocked",
          since,
          ...(await named(db, canary, target)),
        }),
      );
    if (canary !== null && target === null)
      rows.push(row({ code: "no_target", since: now }));
    // Nothing to report, but a batch still unsoaked: no all-clear yet.
    const held =
      rows.length === 0 && target !== null && (await isHeld(db, target));
    fleet_halted = held ? unknown : { open: rows.length > 0, rows };
  } catch {
    console.error("provapi alert fleet query_error");
    fleet_halted = unknown;
  }
  if (canary === null || target === null)
    return { fleet_halted, version_skew: unknown };
  const rows: AlertRow[] = [];
  for (const [id, at] of st.behind)
    if (now - at >= FLEET_SKEW_MS)
      rows.push(
        row({
          install_id: id,
          code: "behind",
          since: at,
          ...(await named(db, id, target)),
        }),
      );
  return { fleet_halted, version_skew: { open: rows.length > 0, rows } };
}
