import {
  ForeignResource,
  isInstallId,
  names,
  type Env as OaEnv,
} from "@oa/provision/names";
import {
  compareVersions,
  isReleaseVersion,
  REVOKE_MIN_VERSION,
} from "@oa/provision/versions";
import { emailQuota, type QuotaEnv } from "./quota.js";

export interface Env extends QuotaEnv {
  DISPATCHER: DispatchNamespace;
  /** Platform D1 (installs metadata only; no customer data). */
  PLATFORM_DB: D1Database;
  OA_ENV: OaEnv;
}

/** The cron of this Worker and of a self-hosted install (wrangler.template.jsonc). */
export const CRON = "17 3 * * *";

/**
 * 6 at a time × 25 s each fits about 190 slow installs in the 13-minute
 * deadline. Dispatch calls hit no 32-invocation cap (measured on staging,
 * 2026-10-24: 100 sequential calls from one request; docs/ops/hosted.md).
 * M2 replaces the loop with a Queue fan-out (one message per install); until
 * then, warn above this many.
 */
const SCALE_WARN = 300;

export type Reason = "timeout" | "not_found" | "canceled" | "exception";

/** Why an install wasn't called; logged as `nightly skipped <reason> <id>`. */
export type SkipReason =
  | "state"
  | "deadline"
  | "capped"
  | "recheck"
  | "db_error";

export interface NightlyResult {
  ok: string[];
  failed: { id: string; reason: Reason }[];
  /** Not called: left active or took a lease, a stalled re-check, or the run stopped. */
  skipped: string[];
  /** The platform D1 re-check failed: not the install's fault, not called. */
  dbErrors: string[];
  /** Timed out and still unsettled leakMs later, or when the run ended. */
  leaked: string[];
  /** Of skipped: held back by the unsettled cap until the deadline. */
  capped: string[];
}

export interface NightlyOptions {
  /**
   * Calls in flight, counting timed-out calls until they settle. Calling a
   * service binding doesn't count toward the 6 simultaneous open connections,
   * but the callee's own fetch, KV, R2, Cache and Queues calls share the
   * top-level request's limit while they wait for headers
   * (https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections,
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits).
   */
  concurrency?: number;
  timeoutMs?: number;
  /** No new call starts after this; under the 15-minute cron wall time. */
  deadlineMs?: number;
  /** How long a timed-out call may still hold its lane before it is leaked. */
  leakMs?: number;
  /** Bound on the per-call platform D1 re-check (also bounded by the deadline). */
  recheckMs?: number;
  /** With less than this left before the deadline, no re-check starts. */
  recheckFloorMs?: number;
  pageSize?: number;
}

/** Consecutive re-check D1 errors or stalls that stop the run (a platform D1 outage). */
const DB_ERROR_STOP = 3;
const DAY_MS = 86_400_000;
/** 2 − φ: the golden-ratio step of nightOrder's start, as a fraction of N. */
const GOLDEN = 0.3819660112501051;

// Keyset pages, so a large table is never one result set.
const PAGE_SQL =
  "SELECT id FROM installs WHERE state = 'active' AND id > ?1 ORDER BY id LIMIT ?2";

// Right before each call: still active, and no live lifecycle lease
// (provision holds one through upgrade, rollback and delete).
const RECHECK_SQL =
  "SELECT 1 AS ok FROM installs WHERE id = ?1 AND state = 'active' AND (lease_until IS NULL OR lease_until <= ?2)";

/**
 * Measured on staging through a dispatch namespace (2026-10-24): scheduled()
 * resolves to undefined when the install's handler succeeds and rejects with
 * the handler's own error when it throws. The { outcome, noRetry } result of
 * the experimental workers-types is handled defensively. scheduledTime is a
 * Date, as in the Workers docs for service bindings
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
 */
interface ScheduledFetcher {
  scheduled(o: { cron?: string; scheduledTime?: Date }): Promise<unknown>;
}

class Canceled extends Error {}
class NotFound extends Error {}

/**
 * A fixed category; never the error text: a rejection carries the install's
 * own error message (emails, URLs), so it is neither logged nor returned.
 */
const category = (e: unknown): Exclude<Reason, "timeout"> =>
  e instanceof Canceled
    ? "canceled"
    : e instanceof NotFound ||
        (e instanceof Error && /^(?:Error: )?Worker not found/.test(e.message))
      ? "not_found"
      : "exception";

/** Resolving to undefined is ok; any other result but outcome "ok" fails closed. */
function checkOutcome(r: unknown): void {
  if (r === undefined) return;
  const outcome =
    typeof r === "object" && r !== null
      ? (r as { outcome?: unknown }).outcome
      : undefined;
  if (outcome === "ok") return;
  if (outcome === "canceled") throw new Canceled();
  if (outcome === "scriptNotFound") throw new NotFound();
  throw new Error("outcome");
}

async function activeIds(
  db: D1Database,
  pageSize: number,
): Promise<{ ids: string[]; invalid: number }> {
  const ids: string[] = [];
  let invalid = 0;
  let after = "";
  for (;;) {
    const { results } = await db
      .prepare(PAGE_SQL)
      .bind(after, pageSize)
      .all<{ id: unknown }>();
    for (const r of results)
      if (typeof r.id === "string") ids.push(r.id);
      else invalid++;
    if (results.length < pageSize) return { ids, invalid };
    const last = results.at(-1)?.id;
    // TEXT affinity makes this near-impossible; never drop the later pages.
    if (typeof last !== "string")
      throw new Error("installs page ends on a non-text id");
    after = last;
  }
}

function positive(name: string, v: number, integer: boolean): number {
  if (!Number.isFinite(v) || v < 1 || (integer && !Number.isInteger(v)))
    throw new RangeError(
      `${name} must be a finite ${integer ? "integer " : ""}>= 1`,
    );
  return v;
}

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Tonight's call order, stateless: a fixed cycle (ids sorted by sha256(id),
 * tie-break on id) entered at floor(frac(UTC day number × 0.381966…) × N).
 * The golden-ratio step moves the uncovered tail of a short run on by more
 * than its width, so a run that covers 190 of 300 never skips an id two
 * nights running, and one that covers 100 of 300 skips an id at most 4
 * nights running (measured; docs/ops/hosted.md). The step is a fraction of
 * the cycle, scaled by tonight's N, so installs created or deleted between
 * nights move the window only slightly (an integer start, day × stride mod N,
 * jumps to an unrelated place whenever N changes). Independent daily
 * shuffles can't bound the streak either.
 */
export async function nightOrder(
  ids: string[],
  now: number,
): Promise<string[]> {
  const keyed = await Promise.all(
    ids.map(async (id) => ({
      id,
      h: hex(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
      ),
    })),
  );
  keyed.sort((a, b) =>
    a.h < b.h ? -1 : a.h > b.h ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const cycle = keyed.map((k) => k.id);
  const n = cycle.length;
  if (n === 0) return cycle;
  const g = Math.floor(now / DAY_MS) * GOLDEN;
  const off = Math.min(n - 1, Math.floor((g - Math.floor(g)) * n));
  return [...cycle.slice(off), ...cycle.slice(0, off)];
}

const logFailed = (reason: Reason, id: string) =>
  console.error("nightly failed", reason, id);

class Stall extends Error {}

/** Resolves with p, or rejects with Stall after ms; the timer is always cleared. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Stall()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Calls scheduled() on every `active` install's script, re-checking right
 * before each call (within recheckMs and the deadline) that it is still
 * active with no live lease. The order is nightOrder's, so a short run
 * doesn't starve the same tail night after night. At most
 * `concurrency` lanes are held; a call is reported `timeout` after
 * `timeoutMs` but keeps its lane until it settles, or for `leakMs` more, when
 * the lane is given back and the call counted as leaked. No call starts after
 * `deadlineMs`, or after 3 consecutive re-check D1 errors or stalls. At most
 * 2 × `concurrency` calls are unsettled (in a lane or leaked). One install
 * throwing or timing out never stops the others. Every failure, skip, D1
 * error and leak is logged when it happens, ids and fixed categories only.
 */
export async function runNightly(
  env: Env,
  now: number,
  {
    concurrency = 6,
    timeoutMs = 25_000,
    deadlineMs = 13 * 60_000,
    leakMs = 60_000,
    recheckMs = 5_000,
    recheckFloorMs = 1_000,
    pageSize = 500,
  }: NightlyOptions = {},
): Promise<NightlyResult> {
  positive("concurrency", concurrency, true);
  positive("timeoutMs", timeoutMs, false);
  positive("deadlineMs", deadlineMs, false);
  positive("leakMs", leakMs, false);
  positive("recheckMs", recheckMs, false);
  positive("recheckFloorMs", recheckFloorMs, false);
  positive("pageSize", pageSize, true);
  const start = Date.now();

  const rows = await activeIds(env.PLATFORM_DB, pageSize);
  const valid = rows.ids.filter((id) => isInstallId(id));
  // Resolve every script name first: an unknown OA_ENV throws before any call.
  for (const id of valid) names(id, env.OA_ENV);
  const invalid = rows.invalid + rows.ids.length - valid.length;
  if (invalid > 0) console.warn("nightly invalid", `ids=${invalid}`);
  if (valid.length > SCALE_WARN)
    console.warn("nightly scale", `active=${valid.length} over ${SCALE_WARN}`);
  // Tonight's tail is near the head on a later night (nightOrder).
  const ids = await nightOrder(valid, now);

  const ok: string[] = [];
  const failed: NightlyResult["failed"] = [];
  const skipped: string[] = [];
  const dbErrors: string[] = [];
  const leaked: string[] = [];
  const capped: string[] = [];
  const fail = (id: string, reason: Reason) => {
    failed.push({ id, reason });
    logFailed(reason, id);
  };
  const skip = (id: string, reason: SkipReason) => {
    skipped.push(id);
    if (reason === "capped") capped.push(id);
    console.warn("nightly skipped", reason, id);
  };

  let next = 0;
  let held = 0; // lanes held: from the re-check until the call settles or leaks
  let undecided = 0; // started installs with no result yet
  // Calls not yet settled, in a lane or leaked: at most 2 × concurrency, so
  // leaked calls can't pile up on the shared connection limit.
  let unsettled = 0;
  const leakTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopped: SkipReason | null = null;
  let dbStreak = 0;
  const stuck = new Set<string>(); // timed out, not settled, lane still held
  const leak = (id: string) => {
    if (!stuck.delete(id)) return;
    leaked.push(id);
    console.warn("nightly leaked", id);
  };

  await new Promise<void>((resolve) => {
    let finished = false;
    const deadline = setTimeout(
      () => {
        // Held back by the unsettled cap (not by busy lanes): its own reason.
        stopped ??= unsettled >= 2 * concurrency ? "capped" : "deadline";
        pump();
      },
      Math.max(0, start + deadlineMs - Date.now()),
    );
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      for (const t of leakTimers) clearTimeout(t);
      resolve();
    };
    function pump() {
      if (finished) return;
      while (
        !stopped &&
        held < concurrency &&
        unsettled < 2 * concurrency &&
        next < ids.length
      )
        run(next++);
      // Done once nothing more will start and every started install has a
      // result; timed-out calls may still hold lanes, but never block this.
      if ((stopped || next >= ids.length) && undecided === 0) finish();
    }
    async function run(i: number) {
      const id = ids[i] as string;
      held++;
      unsettled++;
      undecided++;
      let decided = false;
      let released = false;
      const decide = (f: () => void) => {
        if (decided) return;
        decided = true;
        undecided--;
        f();
      };
      const release = () => {
        if (released) return;
        released = true;
        held--;
        pump();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let leakTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const left = start + deadlineMs - Date.now();
        if (left < recheckFloorMs) {
          // Stop here: the rest is skipped after the run, not one by one
          // through pump (which would recurse once per install).
          stopped ??= "deadline";
          decide(() => skip(id, "deadline"));
          return;
        }
        // Bounded by recheckMs, or by the deadline when that comes first; a
        // re-check the deadline cuts short is `deadline`, never a D1 stall.
        const byDeadline = left < recheckMs;
        let still: unknown;
        try {
          still = await within(
            env.PLATFORM_DB.prepare(RECHECK_SQL).bind(id, Date.now()).first(),
            byDeadline ? left : recheckMs,
          );
        } catch (e) {
          if (e instanceof Stall && byDeadline) {
            decide(() => skip(id, "deadline"));
            return;
          }
          if (e instanceof Stall) {
            decide(() => skip(id, "recheck"));
          } else {
            // The platform D1, not the install: never a failure of the install.
            decide(() => {
              dbErrors.push(id);
              console.error("nightly db_error", id);
            });
          }
          // A stall counts like an error: a hanging D1 stops the run too.
          if (++dbStreak >= DB_ERROR_STOP) stopped ??= "db_error";
          return;
        }
        dbStreak = 0;
        if (!still) {
          decide(() => skip(id, "state"));
          return;
        }
        // A timeout is reported now; the lane stays held until the call
        // settles, or until leakMs more, when it is given back as leaked.
        timer = setTimeout(() => {
          decide(() => fail(id, "timeout"));
          stuck.add(id);
          leakTimer = setTimeout(() => {
            leakTimers.delete(leakTimer as ReturnType<typeof setTimeout>);
            leak(id);
            release();
          }, leakMs);
          leakTimers.add(leakTimer);
          pump();
        }, timeoutMs);
        const r = await (
          env.DISPATCHER.get(
            names(id, env.OA_ENV).script,
          ) as unknown as ScheduledFetcher
        ).scheduled({ cron: CRON, scheduledTime: new Date(now) });
        checkOutcome(r);
        decide(() => ok.push(id));
      } catch (e) {
        decide(() => fail(id, category(e)));
      } finally {
        stuck.delete(id);
        clearTimeout(timer);
        if (leakTimer) {
          clearTimeout(leakTimer);
          leakTimers.delete(leakTimer);
        }
        unsettled--;
        release();
        // A leaked call settling frees room under the unsettled cap.
        pump();
      }
    }
    pump();
  });

  // Calls still stuck when the run ends are leaked too.
  for (const id of [...stuck]) leak(id);
  // The run stopped (deadline or D1 errors): everything not started is skipped.
  for (let i = next; i < ids.length; i++)
    skip(ids[i] as string, stopped ?? "deadline");
  return { ok, failed, skipped, dbErrors, leaked, capped };
}

/** runNightly plus the summary line; an aborted run logs a fixed line and rethrows. */
export async function nightly(
  env: Env,
  now: number,
  o?: NightlyOptions,
): Promise<NightlyResult> {
  let r: NightlyResult;
  try {
    r = await runNightly(env, now, o);
  } catch (e) {
    console.error(
      "nightly aborted",
      e instanceof ForeignResource ? "env" : "exception",
    );
    throw e;
  }
  const { ok, failed, skipped, dbErrors, leaked, capped } = r;
  const active = ok.length + failed.length + skipped.length + dbErrors.length;
  console.log(
    "nightly summary",
    `active=${active} ok=${ok.length} failed=${failed.length} skipped=${skipped.length} capped=${capped.length} db_errors=${dbErrors.length} leaked=${leaked.length}`,
  );
  return r;
}

// ---------- H-DV: the directory revoke a delete waits for ----------

/** Every 2 minutes: move deleting installs' directory_revoke on from pending. */
export const REVOKE_CRON = "*/2 * * * *";
/** The install's job (Backend #616): revokes its Google directory grant. */
export const REVOKE_JOB = "oa:directory-disconnect";
export const REVOKE_MAX_ATTEMPTS = 5;
/** One query, on the partial index installs_revoke_pending (0005). */
export const REVOKE_SQL =
  "SELECT id, version FROM installs WHERE state='deleting' AND directory_revoke='pending' LIMIT 10";
// The only writes: the three revoke columns, on rows still deleting whose
// revoke is still pending (L2: a late result never overwrites an operator's
// skip, and never bumps row_version under a teardown).
const REVOKE_DONE_SQL =
  "UPDATE installs SET directory_revoke = 'done', directory_revoked_at = CASE WHEN directory_revoke_requested_at > ?2 THEN directory_revoke_requested_at ELSE ?2 END WHERE id = ?1 AND state = 'deleting' AND directory_revoke = 'pending'";
const REVOKE_UNSUPPORTED_SQL =
  "UPDATE installs SET directory_revoke = 'unsupported' WHERE id = ?1 AND state = 'deleting' AND directory_revoke = 'pending'";
const REVOKE_RETRY_SQL =
  "UPDATE installs SET directory_revoke_attempts = directory_revoke_attempts + 1, directory_revoke = CASE WHEN directory_revoke_attempts + 1 >= ?2 THEN 'failed' ELSE directory_revoke END WHERE id = ?1 AND state = 'deleting' AND directory_revoke = 'pending' RETURNING directory_revoke";

export interface RevokeOptions {
  /** Per call; the nightly call's default. */
  timeoutMs?: number;
}

/**
 * One tick: up to 10 pending revokes, 3 at a time (each bounded by
 * timeoutMs, so a tick ends inside the 2 minutes). Below REVOKE_MIN_VERSION, or no
 * release version, is unsupported with no call. A resolve to undefined or
 * outcome "ok" is done; outcome scriptNotFound is unsupported; a rejection,
 * timeout or any other result counts an attempt, and the fifth is failed.
 * Logs carry the install id and a fixed category (revokeCategory) only.
 */
export async function revokeTick(
  env: Env,
  now: number,
  { timeoutMs = 25_000 }: RevokeOptions = {},
): Promise<void> {
  positive("timeoutMs", timeoutMs, false);
  try {
    await runRevokeTick(env, now, timeoutMs);
  } catch {
    // M2: never the error text (it can carry a D1 message or the install's).
    console.error("directory-revoke aborted", "exception");
  }
}

/** What one revoke call came to; the retry and failed lines log it. */
export type RevokeCategory =
  | "ok"
  | "scriptNotFound"
  | "exception"
  | "exceededCpu"
  | "exceededMemory"
  | "canceled"
  | "unknown"
  | "throw"
  | "timeout";

const OUTCOMES = new Set<RevokeCategory>([
  "ok",
  "scriptNotFound",
  "exception",
  "exceededCpu",
  "exceededMemory",
  "canceled",
]);

/**
 * A resolved revoke call, from the result alone. Through a dispatch
 * namespace scheduled() resolves to undefined when the install's handler
 * succeeds (measured on staging, see ScheduledFetcher), so undefined is ok, as
 * on the nightly path; a { outcome } result is read defensively. Only a
 * known outcome string is kept; anything else is "unknown".
 */
export function revokeCategory(r: unknown): RevokeCategory {
  if (r === undefined) return "ok";
  const outcome =
    typeof r === "object" && r !== null
      ? (r as { outcome?: unknown }).outcome
      : undefined;
  return typeof outcome === "string" && OUTCOMES.has(outcome as RevokeCategory)
    ? (outcome as RevokeCategory)
    : "unknown";
}

/** L4: calls in flight per tick, so a tick never crowds a nightly run. */
export const REVOKE_CONCURRENCY = 3;

async function runRevokeTick(
  env: Env,
  now: number,
  timeoutMs: number,
): Promise<void> {
  const db = env.PLATFORM_DB;
  const { results } = await db
    .prepare(REVOKE_SQL)
    .all<{ id: unknown; version: unknown }>();
  if (results.length === 0) return;
  const rows = results.filter(
    (r): r is { id: string; version: unknown } =>
      typeof r.id === "string" && isInstallId(r.id),
  );
  if (rows.length < results.length)
    console.warn(
      "directory-revoke invalid",
      `ids=${results.length - rows.length}`,
    );
  // An unknown OA_ENV throws before any call.
  for (const r of rows) names(r.id, env.OA_ENV);
  const one = async ({ id, version }: { id: string; version: unknown }) => {
    const unsupported = async () => {
      await db.prepare(REVOKE_UNSUPPORTED_SQL).bind(id).run();
      console.log("directory-revoke unsupported", id);
    };
    if (
      !isReleaseVersion(version) ||
      compareVersions(version, REVOKE_MIN_VERSION) < 0
    )
      return unsupported();
    let cat: RevokeCategory;
    try {
      cat = revokeCategory(
        await within(
          (
            env.DISPATCHER.get(
              names(id, env.OA_ENV).script,
            ) as unknown as ScheduledFetcher
          ).scheduled({ cron: REVOKE_JOB, scheduledTime: new Date(now) }),
          timeoutMs,
        ),
      );
    } catch (e) {
      // Never the error text: it can carry the install's own message.
      cat = e instanceof Stall ? "timeout" : "throw";
    }
    if (cat !== "ok" && cat !== "scriptNotFound") {
      const after = await db
        .prepare(REVOKE_RETRY_SQL)
        .bind(id, REVOKE_MAX_ATTEMPTS)
        .first<{ directory_revoke: unknown }>();
      if (after === null) return;
      const failed = after.directory_revoke === "failed";
      console.warn(`directory-revoke ${failed ? "failed" : "retry"}`, id, cat);
      return;
    }
    const missing = cat === "scriptNotFound";
    if (missing) return unsupported();
    await db.prepare(REVOKE_DONE_SQL).bind(id, now).run();
    console.log("directory-revoke done", id);
  };
  // M2: each row on its own: one row's D1 error never stops the others.
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const row = rows[next++] as { id: string; version: unknown };
      try {
        await one(row);
      } catch {
        console.error("directory-revoke db_error", row.id);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REVOKE_CONCURRENCY, rows.length) }, lane),
  );
}

/** Deleted installs keep their owner email this long, then it is purged. */
export const OWNER_EMAIL_RETENTION_MS = 30 * DAY_MS;
/**
 * owner_email stays NOT NULL: a purged email is '' (PURGED_EMAIL, names.ts).
 * inputs_hash is an unsalted sha256 over the email (inputsHash), so it is
 * blanked in the same write; it is only compared on a creating row's resume.
 * install_versions holds no email (storedMetadata drops OWNER_EMAIL).
 */
export const PURGE_SQL =
  "UPDATE installs SET owner_email = '', inputs_hash = '' WHERE state='deleted' AND updated_at < ?1 AND owner_email <> '' RETURNING id";

/** Idempotent; the install id, its row and its audit rows stay. */
export async function purgeOwnerEmails(
  db: D1Database,
  now: number,
): Promise<number> {
  // Counted from RETURNING: meta.changes also counts the row_version
  // trigger's own updates.
  const { results } = await db
    .prepare(PURGE_SQL)
    .bind(now - OWNER_EMAIL_RETENTION_MS)
    .all();
  const n = results.length;
  console.log("owner-email purged", `count=${n}`);
  return n;
}

export default {
  async scheduled(event, env, _ctx) {
    if (event.cron === REVOKE_CRON) {
      await revokeTick(env, event.scheduledTime);
      return;
    }
    if (event.cron !== CRON) return;
    await nightly(env, event.scheduledTime);
    // Own try, after the nightly result is settled: it never changes it
    // (emailQuota logs one fixed line and doesn't throw; this catch is
    // defense only, unreachable today).
    try {
      await emailQuota(env, event.scheduledTime);
    } catch {
      console.error("email-quota failed http");
    }
    // H-DV: own try too; a D1 error here never changes the nightly result.
    try {
      await purgeOwnerEmails(env.PLATFORM_DB, event.scheduledTime);
    } catch {
      console.error("owner-email failed db");
    }
  },
} satisfies ExportedHandler<Env>;
