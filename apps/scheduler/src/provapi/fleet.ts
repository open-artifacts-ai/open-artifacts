// The fleet rollout (#955): every install follows the platform's release.
// The target is this Worker's own release, its version tag (the
// "workers/tag" annotation deploy-hosted-platform sets on every platform
// Worker), so the fleet moves when the platform does: staging on the staging
// deploy, prod on the prod deploy, which a green staging red-line gates.
//
// The canary (FLEET_CANARY) goes first and must soak. Then batches of
// FLEET_CONCURRENCY, each soaking whole before the next starts. Only serving,
// active, idle installs with health ok and test hooks off move: a broken
// install is skipped (version_skew reports it), so it can't halt a release.
// The exception is an install that halted a version: it may take the next
// release whatever its health or serving mode, as that may be its fix. An
// install above the target is never downgraded.
//
// Soak: every tick probes the installs upgraded to the target. One soaks once
// its probes pass unbroken for FLEET_SOAK_MS. A tick with no probe doesn't
// count: a gap over FLEET_SOAK_GAP_MS restarts the clock, as a failure does.
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
import type { AlertRow } from "@oa/shared/provisioning/alerts";
import { alertStateKey } from "@oa/shared/provisioning/state";
import { SYSTEM_ACTOR } from "@oa/shared/provisioning/system";
import type { Condition } from "./conditions.js";
import { bound, d1, type ProvapiEnv, within } from "./env.js";
import { type HealthProbe, publicRouteProbe } from "./health.js";
import { insertSystemJob, startJob } from "./jobs.js";
import { dutyCategory } from "./run.js";

/** A batch: open fleet upgrades at once, the insert's own guard included. */
export const FLEET_CONCURRENCY = 3;
/** Unbroken passing probes this long and an install has soaked. */
export const FLEET_SOAK_MS = 15 * 60_000;
/** Passes further apart than this aren't unbroken: the clock restarts. */
export const FLEET_SOAK_GAP_MS = 5 * 60_000;
/** The canary isn't soaked on the target this long: fleet_halted opens. */
export const FLEET_BLOCKED_MS = 30 * 60_000;
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
/** `fleet_blocked:<version>`: when the duty first saw it as the target, the canary not soaked on it. */
export const FLEET_BLOCKED_PREFIX = "fleet_blocked:";
/** `fleet_behind:<id>`: when the duty first saw it off the target. */
export const FLEET_BEHIND_PREFIX = "fleet_behind:";

const VERSIONED_PREFIXES = [
  FLEET_HALT_PREFIX,
  FLEET_FAIL_PREFIX,
  FLEET_PASS_PREFIX,
  FLEET_SOAKED_PREFIX,
  FLEET_BLOCKED_PREFIX,
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

const SYS = `'${SYSTEM_ACTOR.key}'`;
// Every fleet upgrade: request ids `fleet-…` (no LIKE wildcard in the prefix).
// `j` is the jobs alias.
const FLEET_UP = `j.actor_key = ${SYS} AND j.kind = 'upgrade' AND j.request_id LIKE 'fleet-%'`;
// A failure of the release: an operator's cancel, or the halt's own, is not.
const FAILED = `j.status = 'failed' AND COALESCE(j.error_code, '') <> 'canceled'`;
// What the duty may upgrade: active (not suspended, not upgrading), idle, test
// hooks off, and either serving and healthy or an install that halted a
// version, which the next release may be the fix for.
const VICTIM = (id: string) =>
  `EXISTS (SELECT 1 FROM platform_state v WHERE v.key GLOB '${FLEET_HALT_PREFIX}*:' || ${id})`;
const ELIGIBLE = `state = 'active' AND install_state = 'active' AND active_job_id IS NULL AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND ((serving_mode = 'serving' AND health = 'ok') OR ${VICTIM("install_id")})`;
const CANARY = `SELECT install_id, version, app_host, state, install_state, serving_mode, active_job_id, test_hooks, health FROM install_status WHERE install_id = ?1`;
// The canary's latest upgrade to ?2, any actor.
const CANARY_JOB = `SELECT status FROM jobs WHERE install_id = ?1 AND kind = 'upgrade' AND json_extract(args, '$.to') = ?2 ORDER BY created_at DESC, id DESC LIMIT 1`;
const BEHIND = `SELECT install_id, version FROM install_status WHERE ${ELIGIBLE} AND version <> ?1 AND install_id <> ?2 ORDER BY created_at, install_id`;
const OPEN = `SELECT COUNT(*) AS n FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')`;
// The batch of version `to`, as SQL: every install a fleet upgrade to it
// reached, not yet soaked there. A canceled job counts if the install is on
// `to`: R25 can land after the version moved. Only soaking takes an install
// out, or the install going away. Suspended, paused, busy or rolled back, it
// still holds the next batch: a person acted on it, so nothing moves past it.
const BATCH = (to: string) =>
  `SELECT 1 FROM jobs j JOIN install_status s ON s.install_id = j.install_id
WHERE ${FLEET_UP} AND json_extract(j.args, '$.to') = ${to}
  AND (j.status = 'done' OR (j.status = 'failed' AND j.error_code = 'canceled' AND s.version = ${to}))
  AND s.state NOT IN ('deleting', 'deleted')
  AND NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key = '${FLEET_SOAKED_PREFIX}' || ${to} || ':' || j.install_id)`;
const PENDING = `SELECT COUNT(*) AS n FROM (${BATCH("?1")})`;
// Every failed fleet upgrade, with the version it halts.
const HALT_JOBS = `SELECT j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since, json_extract(j.args, '$.to') AS version
FROM jobs j WHERE ${FLEET_UP} AND ${FAILED}`;
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
const NOT_HALTED = `NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key GLOB '${FLEET_HALT_PREFIX}' || json_extract(?10, '$.to') || ':*')
AND NOT EXISTS (SELECT 1 FROM jobs j WHERE ${FLEET_UP} AND ${FAILED} AND json_extract(j.args, '$.to') = json_extract(?10, '$.to'))
AND NOT EXISTS (${BATCH("json_extract(?10, '$.to')")})`;
const SET_ONCE =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
const SET_PASS =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
const CLEAR = "DELETE FROM platform_state WHERE key = ?1";
const AUDIT = `INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, '${SYSTEM_ACTOR.key}', ?2, 'fleet.halted', ?3)`;
// A new halt owes an email, even while the alert is already open.
const OWE_EMAIL = "UPDATE platform_state SET value = 0 WHERE key = ?1";
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

const failedJobs = async (db: D1Database) =>
  (await d1(db.prepare(HALT_JOBS).all<HaltRow>())).results;

/** Every halt: failed jobs, and marks with no failed job behind them. */
async function halts(db: D1Database, st: FleetState): Promise<HaltRow[]> {
  const jobs = await failedJobs(db);
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
    marks.push({
      install_id: install,
      job_id: job?.id ?? null,
      job_kind: job?.kind ?? null,
      code: "fleet_halt",
      message: null,
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

/** Whether any install halted `version`, this tick's halts included. */
function isHalted(st: FleetState, version: string): boolean {
  for (const key of st.rows.keys())
    if (key.startsWith(`${FLEET_HALT_PREFIX}${version}:`)) return true;
  return false;
}

/** Whether this install halted a version, so the next release may be its fix. */
function isVictim(st: FleetState, id: string): boolean {
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
      db.prepare(SET_ONCE).bind(key, now),
      db.prepare(CANCEL_QUEUED).bind(version, now),
      db.prepare(AUDIT).bind(now, id, JSON.stringify({ version })),
      db.prepare(OWE_EMAIL).bind(alertStateKey("fleet_halted", "notified_at")),
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
): Promise<void> {
  for (const j of await failedJobs(db)) {
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
  const canaryId = fleetCanary(env.FLEET_CANARY);
  const st = await fleetState(db);

  await haltFailedJobs(db, now, st);
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
  const hold = await watch(db, now, st, target, canary, probe, ms);
  if (canaryId === null) {
    console.log("provapi fleet no_canary");
    return;
  }
  await trackBehind(db, now, st, target);
  await trackCanary(db, now, st, target, canaryId);
  if (isHalted(st, target)) {
    console.log("provapi fleet halted", target);
    return;
  }
  if (hold) {
    console.log("provapi fleet holding");
    return;
  }
  const pending = await d1(
    db.prepare(PENDING).bind(target).first<{ n: number }>(),
  );
  if ((pending?.n ?? 0) > 0) {
    console.log("provapi fleet holding");
    return;
  }
  const manage = bound(env.MANAGE_INSTALL);

  const ready = await canaryReady(env, now, st, canary, target, manage);
  if (!ready) return;

  // A batch starts whole, and only once the last one has soaked: the watch
  // holds until then, and this until its last job is done. The insert's
  // guards are what hold the cap and the halt.
  const open = await d1(db.prepare(OPEN).first<{ n: number }>());
  if ((open?.n ?? 0) > 0) return;
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
    if (await upgrade(env, manage, now, r.install_id, r.version, target))
      slots--;
  }
}

/**
 * The clock of canary_blocked: from when the duty first saw a target the canary
 * hasn't soaked on, whatever the reason. It stops only once the canary has
 * soaked, or the target halted (fleet_halted says so itself). An older stamp
 * stays, so a release shipped during a block doesn't read as an all-clear.
 */
async function trackCanary(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  canaryId: string,
): Promise<void> {
  const key = blockedKey(target);
  if (st.rows.has(soakedKey(target, canaryId)) || isHalted(st, target)) {
    for (const k of [...st.rows.keys()])
      if (k.startsWith(FLEET_BLOCKED_PREFIX)) {
        await d1(db.prepare(CLEAR).bind(k).run());
        st.rows.delete(k);
      }
    return;
  }
  if (st.rows.has(key)) return;
  await d1(db.prepare(SET_ONCE).bind(key, now).run());
  st.rows.set(key, { key, value: now, updated_at: now });
}

/** Moves the canary toward the target; true once it has soaked there. */
async function canaryReady(
  env: ProvapiEnv,
  now: number,
  st: FleetState,
  canary: CanaryRow | null,
  target: string,
  manage: NonNullable<ProvapiEnv["MANAGE_INSTALL"]>,
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
  const victim = isVictim(st, id);
  if (canary.serving_mode !== "serving" && !victim) return stuck("unavailable");
  const last = await d1(
    db.prepare(CANARY_JOB).bind(id, target).first<{ status: string }>(),
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
  if (c < 0 && canary.health !== "ok" && !victim) return stuck("unhealthy");
  if (!(await published(env, target))) return false;
  if (c < 0) {
    await upgrade(env, manage, now, id, canary.version, target);
    return false;
  }
  // On the target, its upgrade (if it had one) done and not just written.
  if (last !== null && last.status !== "done") {
    console.log("provapi fleet canary_not_done");
    return false;
  }
  return st.rows.has(soakedKey(target, id));
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
      {
        sql: `${STILL_ON} AND ${UNDER_CAP} AND ${NOT_HALTED}`,
        params: [from],
      },
    );
  } catch (e) {
    console.error("provapi fleet install_failed", dutyCategory(e), installId);
    return false;
  }
  // null: already queued for this target, at the cap, halted, or not eligible.
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
        ? await passed(db, now, st, target, r.install_id)
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
): Promise<boolean> {
  const key = passKey(target, id);
  const prev = st.rows.get(key);
  const unbroken = prev && now - prev.updated_at <= FLEET_SOAK_GAP_MS;
  const start = unbroken ? prev.value : now;
  if (now - start < FLEET_SOAK_MS) {
    await d1(db.prepare(SET_PASS).bind(key, start, now).run());
    st.rows.set(key, { key, value: start, updated_at: now });
    return false;
  }
  const done = soakedKey(target, id);
  await d1(
    db.batch([
      db.prepare(SET_ONCE).bind(done, now),
      db.prepare(CLEAR).bind(key),
    ]),
  );
  st.rows.set(done, { key: done, value: now, updated_at: now });
  st.rows.delete(key);
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

/**
 * fleet_halted and version_skew for this tick.
 * - fleet_halted: halts on the target, any halt on another version in the
 *   last FLEET_HALT_ALERT_MS, a canary not soaked on the target
 *   FLEET_BLOCKED_MS after the duty first saw it (canary_blocked), and a
 *   canary set with no target (no_target).
 * - version_skew: installs first seen off FLEET_SKEW_MS ago. Unknown with no
 *   canary or no target, so it never sends a false all-clear.
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
      .map((r) => ({ ...r, version: r.version ?? undefined }));
    const stamps = [...st.rows.values()]
      .filter((r) => r.key.startsWith(FLEET_BLOCKED_PREFIX))
      .map((r) => r.value);
    const since = stamps.length > 0 ? Math.min(...stamps) : null;
    if (canary !== null && since !== null && now - since >= FLEET_BLOCKED_MS)
      rows.push(row({ install_id: canary, code: "canary_blocked", since }));
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
