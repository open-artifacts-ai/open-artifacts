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

/** What the instance says about updates, as read from settings. */
export type UpdateState = {
  /** The owner's named version; null: none. */
  named: string | null;
  /** Fails closed: any value in the row pauses. */
  paused: boolean;
};

/**
 * The server's own genuine release: its built-in VERSION when that is a strict
 * x.y.z (a -dev or pre-release build, or one with build metadata, has none).
 */
export function releaseOf(serverVersion: string): string | null {
  const ok = RunVersionSchema.safeParse(serverVersion);
  return ok.success ? ok.data : null;
}

/** One read of the two update settings: the named version and the pause flag. */
export async function readUpdateState(
  env: Pick<Env, "DB">,
): Promise<UpdateState> {
  const rows = await stmt(
    env.DB,
    "select key, value from settings where key in (?, ?)",
  )
    .bind(RUN_VERSION_KEY, UPDATES_PAUSED_KEY)
    .all<{ key: string; value: string }>();
  const by = new Map(rows.results.map((r) => [r.key, r.value]));
  const named = RunVersionSchema.safeParse(by.get(RUN_VERSION_KEY));
  return {
    named: named.success ? named.data : null,
    paused: by.has(UPDATES_PAUSED_KEY),
  };
}

/** The owner's pause switch alone (#2552): any value in the row pauses, as readUpdateState reads it. */
export async function busUpdatesPaused(env: Pick<Env, "DB">): Promise<boolean> {
  const row = await stmt(env.DB, "select 1 as x from settings where key = ?")
    .bind(UPDATES_PAUSED_KEY)
    .first();
  return row !== null;
}

/**
 * The version a machine running `running` is told: null clears (nothing it
 * holds may swap in). Paused: null. A named version: that, whatever the
 * machine runs (a deliberate step back stays one). Else the server's own
 * release, offered as soon as the instance runs it (the hosted fleet's canary
 * and smoke gate which instances get a release; nothing on the instance
 * records a health probe), only when strictly newer than the machine's
 * version; otherwise null.
 */
export function targetFor(
  s: UpdateState,
  serverVersion: string,
  running: string | undefined,
): string | null {
  if (s.paused) return null;
  if (s.named !== null) return s.named;
  const release = releaseOf(serverVersion);
  if (release === null || running === undefined) return null;
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
  const report = stmt(
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
  ).bind(
    machineId,
    f.event,
    f.from,
    f.to,
    f.reason,
    f.detail ?? null,
    f.rescue_version,
    now,
    f.event === "switching" ? now : null,
  );
  const statements = [report];
  if (
    f.event === "needs_you" &&
    ["unhealthy", "hub_unreachable"].includes(f.reason)
  ) {
    statements.push(
      stmt(
        env.DB,
        `update bus_machines set failure_at = case when failure_version = ?1 then failure_at else ?2 end, failure_version = ?1 where id = ?3`,
      ).bind(f.to, now, machineId),
    );
  } else if (f.event === "updated") {
    statements.push(
      stmt(
        env.DB,
        "update bus_machines set failure_at = null, failure_version = null where id = ?",
      ).bind(machineId),
    );
  }
  await env.DB.batch(statements);
}

export const LAG_NOTICE_MS = 60 * 60_000;

export const RELEASE_LAG_HUB = "bus:~release-lag";
export type ReleaseDeadline = {
  version: string;
  previous: string;
  since: number;
};

/** Keep the first observation, including timestamps written by pre-#3265 instances. */
export async function firstReleaseObservation(
  env: Pick<Env, "DB">,
  version: string,
  now: number,
) {
  const row = await stmt(
    env.DB,
    `insert into settings(key,value) values ('bus_version_since',?1)
    on conflict(key) do update set value=case
    when json_valid(settings.value) and json_extract(settings.value,'$.version')=?2
      and json_type(settings.value,'$.since')='integer' then settings.value else excluded.value end
    returning value`,
  )
    .bind(JSON.stringify({ version, since: now }), version)
    .first<{ value: string }>();
  if (!row) throw new Error("Release timestamp missing");
  return (JSON.parse(row.value) as { since: number }).since;
}

/** One release deadline covers all members, including those with no connected machines. */
export async function reconcileReleaseLag(
  env: Pick<Env, "DB">,
  deadline: ReleaseDeadline,
  mode: "mark-overdue" | "clear-resolved",
) {
  let after = "";
  for (;;) {
    const { results } = await stmt(
      env.DB,
      `select distinct bus_version as version from bus_machines
      where revoked_at is null and bus_version > ? order by bus_version limit 64`,
    )
      .bind(after)
      .all<{ version: string }>();
    const changes = results.flatMap(({ version }) => {
      const behind =
        semverGte(deadline.previous, version) &&
        !semverGte(version, deadline.previous);
      if (mode === "clear-resolved") {
        if (behind) return [];
        return [
          stmt(
            env.DB,
            `update bus_machines set lag_since=null where revoked_at is null and bus_version=? and lag_since is not null`,
          ).bind(version),
        ];
      }
      if (!behind) return [];
      return [
        stmt(
          env.DB,
          `update bus_machines set lag_since=?1 where revoked_at is null and bus_version=?2 and (lag_since is null or lag_since > ?1)`,
        ).bind(deadline.since, version),
      ];
    });
    if (changes.length) await env.DB.batch(changes);
    if (results.length < 64) return;
    after = results[results.length - 1].version;
  }
}

/** Compare against the actual preceding release, preserving an ongoing lag episode. */
export async function refreshMachineLag(
  env: Pick<Env, "DB">,
  userId: string,
  previousRelease: string | null,
  now: number,
): Promise<void> {
  if (!previousRelease) return;
  const rows = await stmt(
    env.DB,
    "select id, bus_version as version, lag_since as since from bus_machines where user_id = ? and revoked_at is null and bus_version is not null",
  )
    .bind(userId)
    .all<{ id: string; version: string; since: number | null }>();
  const changes = rows.results.flatMap((row) => {
    const behind =
      semverGte(previousRelease, row.version) &&
      !semverGte(row.version, previousRelease);
    if (behind === (row.since !== null)) return [];
    return [
      stmt(
        env.DB,
        "update bus_machines set lag_since = ? where id = ? and bus_version = ? and lag_since is ?",
      ).bind(behind ? now : null, row.id, row.version, row.since),
    ];
  });
  if (changes.length) await env.DB.batch(changes);
}

export async function machineUpdateNotices(
  env: Pick<Env, "DB">,
  userId: string,
  now: number,
) {
  const { results } = await stmt(
    env.DB,
    `select id,label,bus_version as version,lag_since as since,failure_at as failureAt,
      coalesce(failure_version, case when u.event = 'stepped_back' and u.reason in ('unhealthy','hub_unreachable') then u.to_version end) as failed
    from bus_machines left join bus_machine_updates u on u.machine_id=bus_machines.id where user_id = ? and revoked_at is null and (lag_since <= ? or failure_at is not null) order by id`,
  )
    .bind(userId, now - LAG_NOTICE_MS)
    .all<{
      id: string;
      label: string;
      version: string | null;
      since: number | null;
      failureAt: number | null;
      failed: string | null;
    }>();
  return results;
}

export async function noteMachineVersion(
  env: Pick<Env, "DB">,
  machineId: string,
  version?: string,
): Promise<void> {
  if (!version) return;
  await stmt(
    env.DB,
    "update bus_machines set bus_version = ?1 where id = ?2 and bus_version is not ?1",
  )
    .bind(version, machineId)
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
