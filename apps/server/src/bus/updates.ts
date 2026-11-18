import {
  RunVersionSchema,
  semverGte,
  type UpdateReportFrame,
} from "@oa/bus-protocol";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

/**
 * The instance side of #2552: the version the instance names, and the latest
 * update report of each machine (D1 bus_machine_updates). The hub calls these;
 * nothing here reads or sends anything from the wire but the validated frame.
 */

/** settings row: the version machines are told to run; absent: none is named. */
export const RUN_VERSION_KEY = "bus_run_version";

/** A machine that reported `switching` and says no hello for this long has stopped. */
export const STOPPED_AFTER_MS = 5 * 60_000;

/** The named version, or null when none is (or the stored value is not x.y.z). */
export async function readRunVersion(
  env: Pick<Env, "DB">,
): Promise<string | null> {
  const row = await stmt(env.DB, "select value from settings where key = ?")
    .bind(RUN_VERSION_KEY)
    .first<{ value: string }>();
  const ok = RunVersionSchema.safeParse(row?.value);
  return ok.success ? ok.data : null;
}

/** settings row: present while the owner has paused every instance-driven update (#2552). */
export const UPDATES_PAUSED_KEY = "bus_updates_paused";
/** settings row: { version, since } - when this instance first ran its current release. */
export const VERSION_SINCE_KEY = "bus_version_since";
/** A release must have run on the instance this long before machines follow it. */
export const SOAK_MS = 24 * 60 * 60_000;

/** What the instance says about updates, as read from settings. */
export type UpdateState = {
  /** The owner's named version; null: none. */
  named: string | null;
  /** Fails closed: any value in the row pauses. */
  paused: boolean;
  /** The release this instance first ran, and when (ms); null: not recorded. */
  since: { version: string; since: number } | null;
};

/**
 * The server's own genuine release: its built-in VERSION when that is a strict
 * x.y.z (a -dev or pre-release build, or one with build metadata, has none).
 */
export function releaseOf(serverVersion: string): string | null {
  const ok = RunVersionSchema.safeParse(serverVersion);
  return ok.success ? ok.data : null;
}

function parseSince(v: string | undefined): UpdateState["since"] {
  if (v === undefined) return null;
  try {
    const j = JSON.parse(v) as { version?: unknown; since?: unknown } | null;
    return typeof j?.version === "string" &&
      typeof j.since === "number" &&
      Number.isSafeInteger(j.since)
      ? { version: j.version, since: j.since }
      : null;
  } catch {
    return null;
  }
}

/**
 * One read of the three update settings. Also the "first seen" record: the
 * first time a genuine release VERSION is met that is not the stored one, its
 * `since` is written (idempotent, and the earliest writer wins: a concurrent
 * hub finds the row already there). A -dev build records nothing.
 */
export async function readUpdateState(
  env: Pick<Env, "DB">,
  serverVersion: string,
  now: number,
): Promise<UpdateState> {
  const rows = await stmt(
    env.DB,
    "select key, value from settings where key in (?, ?, ?)",
  )
    .bind(RUN_VERSION_KEY, UPDATES_PAUSED_KEY, VERSION_SINCE_KEY)
    .all<{ key: string; value: string }>();
  const by = new Map(rows.results.map((r) => [r.key, r.value]));
  const named = RunVersionSchema.safeParse(by.get(RUN_VERSION_KEY));
  let since = parseSince(by.get(VERSION_SINCE_KEY));
  const release = releaseOf(serverVersion);
  if (release !== null && since?.version !== release) {
    const value = JSON.stringify({ version: release, since: now });
    await stmt(
      env.DB,
      `insert into settings (key, value) values (?1, ?2)
       on conflict(key) do update set value = excluded.value
        where json_extract(settings.value, '$.version') is not ?3`,
    )
      .bind(VERSION_SINCE_KEY, value, release)
      .run();
    const row = await stmt(env.DB, "select value from settings where key = ?")
      .bind(VERSION_SINCE_KEY)
      .first<{ value: string }>();
    since = parseSince(row?.value);
  }
  return {
    named: named.success ? named.data : null,
    paused: by.has(UPDATES_PAUSED_KEY),
    since,
  };
}

/** When the default release finishes its soak (ms), or null: no default is waiting on one. */
export function soakEnds(s: UpdateState, serverVersion: string): number | null {
  const release = releaseOf(serverVersion);
  if (release === null || s.since?.version !== release) return null;
  return s.since.since + SOAK_MS;
}

/**
 * The version a machine running `running` is told: null clears (nothing it
 * holds may swap in). Paused: null. A named version: that, whatever the
 * machine runs (a deliberate step back stays one). Else the default, the
 * server's own release, only once it soaked and only when newer than the
 * machine's version; otherwise null.
 */
export function targetFor(
  s: UpdateState,
  serverVersion: string,
  running: string | undefined,
  now: number,
): string | null {
  if (s.paused) return null;
  if (s.named !== null) return s.named;
  const release = releaseOf(serverVersion);
  const end = soakEnds(s, serverVersion);
  if (release === null || end === null || now < end) return null;
  if (running === undefined) return null;
  // Strictly newer: semverGte is false for a malformed `running`, and a
  // pre-release of `release` ranks below it.
  return semverGte(release, running) && !semverGte(running, release)
    ? release
    : null;
}

/** Keeps the latest report of a machine; `switching` starts its 5 minute clock. */
export async function recordReport(
  env: Pick<Env, "DB">,
  machineId: string,
  f: UpdateReportFrame,
  now: number,
): Promise<void> {
  await stmt(
    env.DB,
    `insert into bus_machine_updates
       (machine_id, event, from_version, to_version, reason, detail, rescue_version, reported_at, switching_at, last_hello_at, stopped_at)
     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?8, null)
     on conflict(machine_id) do update set
       event = excluded.event, from_version = excluded.from_version,
       to_version = excluded.to_version, reason = excluded.reason,
       detail = excluded.detail, rescue_version = excluded.rescue_version,
       reported_at = excluded.reported_at, switching_at = excluded.switching_at,
       last_hello_at = excluded.last_hello_at, stopped_at = null`,
  )
    .bind(
      machineId,
      f.event,
      f.from,
      f.to,
      f.reason,
      f.detail ?? null,
      f.rescue_version,
      now,
      f.event === "switching" ? now : null,
    )
    .run();
}

/** A hello from the machine: a pending `switching` clock stops counting against it. */
export async function noteHello(
  env: Pick<Env, "DB">,
  machineId: string,
  now: number,
): Promise<void> {
  await stmt(
    env.DB,
    "update bus_machine_updates set last_hello_at = ?, stopped_at = null where machine_id = ? and event = 'switching'",
  )
    .bind(now, machineId)
    .run();
}

/**
 * Marks this member's machines stopped: latest report `switching`, no hello
 * since it, 5 minutes gone. Returns when the next still-waiting one falls due
 * (ms), or null when none waits.
 */
export async function markStopped(
  env: Pick<Env, "DB">,
  userId: string,
  now: number,
): Promise<number | null> {
  await stmt(
    env.DB,
    `update bus_machine_updates set stopped_at = ?1
      where event = 'switching' and stopped_at is null
        and switching_at <= ?2 and (last_hello_at is null or last_hello_at <= switching_at)
        and machine_id in (select id from bus_machines where user_id = ?3)`,
  )
    .bind(now, now - STOPPED_AFTER_MS, userId)
    .run();
  const next = await stmt(
    env.DB,
    `select min(switching_at) as t from bus_machine_updates
      where event = 'switching' and stopped_at is null
        and (last_hello_at is null or last_hello_at <= switching_at)
        and machine_id in (select id from bus_machines where user_id = ?1)`,
  )
    .bind(userId)
    .first<{ t: number | null }>();
  return next?.t == null ? null : next.t + STOPPED_AFTER_MS;
}

/**
 * `detail` and the machine label come from a machine (the label from its
 * owner, `detail` from the daemon): the Machines view that shows them must
 * render both as plain text, never as markup or a link.
 */
/** The stored latest report of one machine (tests and the Machines list later). */
export type StoredUpdate = {
  event: string;
  fromVersion: string;
  toVersion: string;
  reason: string;
  detail: string | null;
  rescueVersion: number;
  reportedAt: number;
  stoppedAt: number | null;
};
export async function latestReport(
  env: Pick<Env, "DB">,
  machineId: string,
): Promise<StoredUpdate | null> {
  return stmt(
    env.DB,
    `select event, from_version as fromVersion, to_version as toVersion, reason, detail,
            rescue_version as rescueVersion, reported_at as reportedAt, stopped_at as stoppedAt
       from bus_machine_updates where machine_id = ?`,
  )
    .bind(machineId)
    .first<StoredUpdate>();
}
