import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "@oa/shared";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import { closeUserBus } from "../services/bus.js";

/** A socket lives at most this long (the ArtifactRuntime TTL, 4408 after it). */
const SOCKET_TTL_MS = LIMITS.signedUrlTtlSec * 1000;
/**
 * A queued close is dropped once it is this old: every socket accepted
 * before the revocation has reached its TTL by then (10 min plus a minute of
 * alarm slack), so there is nothing left to close.
 */
export const RETRY_MAX_AGE_MS = 11 * 60_000;
/** Retry delay after the n-th failed close (1-based): 1 s, 2 s, 4 s ... 60 s. */
export const retryBackoffMs = (n: number) =>
  Math.min(60_000, 1000 * 2 ** (n - 1));
/**
 * closeActor calls per closeAll or alarm run; the rest wait in the queue for
 * the next alarm (due at once), so one run stays within the CPU budget.
 */
export const CLOSE_FANOUT = 50;
/**
 * Clock-skew margin (ms) between the Worker that stamps authzAt and this DO
 * that stamps revokedAt: touch refuses any authzAt <= revokedAt + SKEW_MS.
 */
export const SKEW_MS = 2000;
const MAX_REASON = 120;

/**
 * The install-wide socket index (#1182): the UserPresence instance with this
 * name. Never a user id (ids are base58), so a user's revocation never
 * reaches it, and it refuses touch, closeAll and markRevoked. ArtifactRuntime
 * reports here (seen) when it accepts a socket of any kind (events or data,
 * signed-in or anonymous), at most once per INDEX_REPORT_MS per DO instance,
 * so the platform's suspend can close every open socket on the install
 * (closeInstall) without walking every artifact.
 */
export const INSTALL_INDEX = "~install";
/** An artifact DO reports to the index at most this often. */
export const INDEX_REPORT_MS = 60_000;
/**
 * An index row older than this names no live socket: a socket lives at most
 * SOCKET_TTL_MS, plus the report throttle, plus a minute of alarm slack.
 */
export const INDEX_WINDOW_MS = SOCKET_TTL_MS + INDEX_REPORT_MS + 60_000;
/**
 * closeInstall's later passes, this long after the first. Dispatch refuses
 * every request, upgrades included, once it reads the paused HOSTS value
 * (apps/dispatch/src/index.ts), so only an edge still serving the old value
 * can accept a new socket. That window is dispatch's 60 s cacheTtl on top of
 * KV propagation, which has no hard bound: about two minutes usually, so a
 * pass at 2 minutes, and one at 5 for a slow edge. Past that, the 10-minute
 * socket TTL is the ceiling.
 */
export const LATER_PASSES_MS = [120_000, 300_000] as const;
// One sweep row per later pass (ids 1 and 2). The table shipped with this
// check: a deployed DO keeps the check it was created with, so adding a pass
// later means a new table, not a wider check.
export const SECOND_PASS_MS = LATER_PASSES_MS[0];
/**
 * #1291: install-index rows for a member's BusHub carry this prefix plus the
 * user id (artifact ids are base58, never with a colon). closeInstall closes
 * such a hub's sockets (BusHub.closeAll) instead of an artifact's.
 */
export const BUS_INDEX_PREFIX = "bus:";

const SCHEMA = `
create table if not exists state (
  id integer primary key check (id = 1), revoked_at integer not null
);
create table if not exists seen (
  artifact_id text primary key, seen_at integer not null
) without rowid;
create index if not exists seen_at on seen (seen_at);
create table if not exists retry (
  artifact_id text primary key, reason text not null, first_at integer not null,
  attempts integer not null, due integer not null
) without rowid;
create index if not exists retry_due on retry (due);
create table if not exists sweep (
  id integer primary key check (id in (1, 2)), reason text not null, due integer not null
);
`;

/** The artifact DO's close RPCs (runtime/do.ts), as this DO calls them. */
type ActorCloser = {
  closeActor(actor: string, reason: string): Promise<number>;
  closeAllSockets(reason: string): Promise<number>;
};

type RetryRow = {
  artifact_id: string;
  reason: string;
  first_at: number;
  attempts: number;
};

/** What one closeInstall did: counts only. */
export type InstallCloseResult = {
  /** Artifacts the index saw within INDEX_WINDOW_MS. */
  artifacts: number;
  /** Sockets closed now. */
  closed: number;
  /** Artifacts left to the alarm (past CLOSE_FANOUT, or failed now). */
  queued: number;
};

/**
 * One per user (idFromName(userId)). Records which artifacts the user holds
 * live sockets on, so a revocation closes them at once instead of waiting for
 * the 10 minute socket TTL:
 * - touch: every signed-in socket accept awaits it (ArtifactRuntime.fetch).
 * - closeAll: sets revokedAt first, then closes the user's sockets on every
 *   recorded artifact. A socket whose authorization ran at or before
 *   revokedAt and touches after it is refused by touch, so no accept can slip
 *   between the status write and the close.
 * Failed closes wait in a durable queue, retried by alarm with backoff until
 * RETRY_MAX_AGE_MS old.
 *
 * The instance named INSTALL_INDEX is the install-wide socket index instead
 * (seen, closeInstall): its queue closes every socket on an artifact
 * (closeAllSockets), and it never writes revokedAt, so nothing it does
 * refuses a later accept.
 */
export class UserPresence extends DurableObject<Env> {
  private ready = false;

  /** Clock; overridable in tests. */
  now: () => number = () => Date.now();

  /**
   * Closes `actor`'s sockets on one artifact's DO, or every socket there
   * when `actor` is null (the install index); overridable in tests.
   */
  closer: (
    env: Env,
    artifactId: string,
    actor: string | null,
    reason: string,
  ) => Promise<number> = (env, artifactId, actor, reason) => {
    if (artifactId.startsWith(BUS_INDEX_PREFIX)) {
      // Only the install index records hubs, so `actor` is null here.
      const bus = env.BUS_HUB;
      if (!bus || actor !== null) return Promise.resolve(0);
      const hub = bus.get(bus.idFromName(artifactId)) as unknown as {
        closeAll(reason: string): Promise<number>;
      };
      return hub.closeAll(reason);
    }
    const ns = env.ARTIFACT_RUNTIME;
    const s = ns.get(ns.idFromName(artifactId)) as unknown as ActorCloser;
    return actor === null
      ? s.closeAllSockets(reason)
      : s.closeActor(actor, reason);
  };

  private get sql(): SqlStorage {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA);
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }

  /** True for the install-wide socket index (INSTALL_INDEX). */
  private get isIndex(): boolean {
    return this.ctx.id.name === INSTALL_INDEX;
  }

  /**
   * Who this DO's closes are for: `u:{id}` for a user's presence (the name
   * it was addressed by), null for the install index (every socket).
   */
  private get target(): string | null {
    const id = this.ctx.id.name;
    if (!id) throw new Error("UserPresence needs a named id");
    return id === INSTALL_INDEX ? null : `u:${id}`;
  }

  /** The user this DO tracks; throws on the install index. */
  private get actor(): string {
    const a = this.target;
    if (a === null) throw new Error("not a user's presence");
    return a;
  }

  /** When the last revocation started (ms), or null. */
  revokedAt(): number | null {
    return (
      this.sql
        .exec<{ revoked_at: number }>(
          "select revoked_at from state where id = 1",
        )
        .toArray()[0]?.revoked_at ?? null
    );
  }

  /**
   * Records a socket accepted on `artifactId` whose authorization ran at
   * `authzAt` (ms). ok is false (record nothing; the caller closes 4403) when
   * a revocation started at or after that authorization, within SKEW_MS.
   */
  touch(artifactId: string, authzAt: number): { ok: boolean } {
    void this.actor;
    if (typeof artifactId !== "string" || !artifactId || artifactId.length > 64)
      throw new Error("invalid artifact id");
    if (!Number.isSafeInteger(authzAt)) throw new Error("invalid authzAt");
    const revoked = this.revokedAt();
    if (revoked !== null && authzAt <= revoked + SKEW_MS) return { ok: false };
    const now = this.now();
    this.sql.exec(
      `insert into seen (artifact_id, seen_at) values (?, ?)
       on conflict (artifact_id) do update set seen_at = excluded.seen_at`,
      artifactId,
      now,
    );
    // Rows past the socket TTL name no live socket: keep the table small.
    this.sql.exec("delete from seen where seen_at < ?", now - SOCKET_TTL_MS);
    return { ok: true };
  }

  /**
   * Writes revokedAt = now (never moves it back) and returns it, closing
   * nothing: the last resort when closeAll keeps failing, so at least new
   * accepts are refused.
   */
  markRevoked(): number {
    void this.actor;
    const now = this.now();
    this.sql.exec(
      `insert into state (id, revoked_at) values (1, ?)
       on conflict (id) do update set revoked_at = max(revoked_at, excluded.revoked_at)`,
      now,
    );
    return now;
  }

  /**
   * Starts a revocation: revokedAt = now is written before any close, then
   * the user's sockets on each recorded artifact close (4403). Failed closes,
   * and any past CLOSE_FANOUT, go to the retry queue. Returns the number of
   * sockets closed now.
   */
  async closeAll(reason: string): Promise<number> {
    const why = String(reason).slice(0, MAX_REASON);
    const actor = this.actor;
    const now = this.markRevoked();
    const ids = this.sql
      .exec<{ artifact_id: string }>(
        "delete from seen where seen_at >= ? returning artifact_id",
        now - SOCKET_TTL_MS,
      )
      .toArray()
      .map((r) => r.artifact_id);
    this.sql.exec("delete from seen");
    const nowIds = ids.slice(0, CLOSE_FANOUT);
    for (const id of ids.slice(CLOSE_FANOUT))
      this.enqueue(id, why, now, 0, now);
    let closed = 0;
    const rs = await Promise.allSettled(
      nowIds.map((id) => this.closer(this.env, id, actor, why)),
    );
    rs.forEach((r, i) => {
      if (r.status === "fulfilled") closed += r.value;
      else {
        logError("presence_close_failed", r.reason, { attempts: 1 });
        this.enqueue(nowIds[i] as string, why, now, 1, now + retryBackoffMs(1));
      }
    });
    await this.arm();
    // #1291: their bus sockets too (BusHub.closeAll; nothing for a member
    // with no machine that ever connected). Last, after revokedAt and the
    // artifact closes: a failure throws, so revokeUserLive retries the whole
    // call (idempotent).
    closed += await this.busCloser(this.env, actor.slice(2), why);
    return closed;
  }

  /** Closes the member's bus sockets (services/bus.ts); overridable in tests. */
  busCloser: (env: Env, userId: string, reason: string) => Promise<number> =
    closeUserBus;

  /**
   * Install index only: records that `artifactId`'s DO accepted a socket
   * now (ArtifactRuntime.fetch, throttled to INDEX_REPORT_MS). Rows past
   * INDEX_WINDOW_MS name no live socket and are dropped.
   */
  seen(artifactId: string): void {
    this.indexOnly();
    if (typeof artifactId !== "string" || !artifactId || artifactId.length > 64)
      throw new Error("invalid artifact id");
    const now = this.now();
    this.sql.exec(
      `insert into seen (artifact_id, seen_at) values (?, ?)
       on conflict (artifact_id) do update set seen_at = excluded.seen_at`,
      artifactId,
      now,
    );
    this.sql.exec("delete from seen where seen_at < ?", now - INDEX_WINDOW_MS);
  }

  /**
   * Install index only (the platform's suspend, cron.ts CLOSE_SOCKETS_CRON):
   * closes every socket on every artifact the index saw within
   * INDEX_WINDOW_MS (4403; events sockets get `gone` first). Up to
   * CLOSE_FANOUT closes run now; the rest, and failed ones, wait in the retry
   * queue for the alarm (due at once, CLOSE_FANOUT per run). A second pass
   * runs SECOND_PASS_MS later (the alarm), for reconnects that reached the
   * install before dispatch saw the pause. Nothing here refuses a later
   * accept (no revokedAt, no access change), so a resumed install serves
   * new sockets at once. The index rows stay (they age out) for the second
   * pass.
   */
  async closeInstall(reason: string): Promise<InstallCloseResult> {
    this.indexOnly();
    const why = String(reason).slice(0, MAX_REASON);
    const now = this.now();
    for (const [i, after] of LATER_PASSES_MS.entries())
      this.sql.exec(
        `insert into sweep (id, reason, due) values (?, ?, ?)
         on conflict (id) do update set reason = excluded.reason, due = excluded.due`,
        i + 1,
        why,
        now + after,
      );
    const ids = this.indexed(now);
    const nowIds = ids.slice(0, CLOSE_FANOUT);
    for (const id of ids.slice(CLOSE_FANOUT))
      this.enqueue(id, why, now, 0, now);
    let closed = 0;
    let failed = 0;
    const rs = await Promise.allSettled(
      nowIds.map((id) => this.closer(this.env, id, null, why)),
    );
    rs.forEach((r, i) => {
      if (r.status === "fulfilled") closed += r.value;
      else {
        failed++;
        this.enqueue(nowIds[i] as string, why, now, 1, now + retryBackoffMs(1));
      }
    });
    if (failed > 0)
      logError("install_close_failed", new Error("socket close failed"), {
        count: failed,
        attempts: 1,
      });
    await this.arm();
    return {
      artifacts: ids.length,
      closed,
      queued: ids.length - nowIds.length + failed,
    };
  }

  /** The index's artifacts that may hold a live socket at `now`, newest first. */
  private indexed(now: number): string[] {
    return this.sql
      .exec<{ artifact_id: string }>(
        "select artifact_id from seen where seen_at >= ? order by seen_at desc",
        now - INDEX_WINDOW_MS,
      )
      .toArray()
      .map((r) => r.artifact_id);
  }

  private indexOnly(): void {
    if (!this.isIndex) throw new Error("not the install index");
  }

  /** The next later pass's due time, while one is pending (tests). */
  pendingSweep(): number | null {
    return (
      this.sql
        .exec<{ due: number | null }>("select min(due) as due from sweep")
        .toArray()[0]?.due ?? null
    );
  }

  private enqueue(
    artifactId: string,
    reason: string,
    firstAt: number,
    attempts: number,
    due: number,
  ): void {
    this.sql.exec(
      `insert into retry (artifact_id, reason, first_at, attempts, due)
       values (?, ?, ?, ?, ?)
       on conflict (artifact_id) do update set reason = excluded.reason,
         first_at = excluded.first_at, attempts = excluded.attempts,
         due = excluded.due`,
      artifactId,
      reason,
      firstAt,
      attempts,
      due,
    );
  }

  /** The queued closes (tests). */
  pendingRetries(): {
    artifactId: string;
    attempts: number;
    firstAt: number;
    due: number;
  }[] {
    return this.sql
      .exec<RetryRow & { due: number }>(
        "select artifact_id, reason, first_at, attempts, due from retry order by due",
      )
      .toArray()
      .map((r) => ({
        artifactId: r.artifact_id,
        attempts: r.attempts,
        firstAt: r.first_at,
        due: r.due,
      }));
  }

  private async arm(): Promise<void> {
    const next = this.sql
      .exec<{ due: number | null }>(
        "select min(due) as due from (select due from retry union all select due from sweep)",
      )
      .one().due;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /**
   * Retries due closes (at most CLOSE_FANOUT per run) with backoff; drops
   * those past RETRY_MAX_AGE_MS (their sockets are past the TTL). On the
   * install index, a due second pass first queues every indexed artifact
   * again. Re-arms for the next due one.
   */
  override async alarm(): Promise<void> {
    const now = this.now();
    const sweep = this.sql
      .exec<{ reason: string }>(
        "delete from sweep where due <= ? returning reason",
        now,
      )
      .toArray()[0];
    if (sweep && this.isIndex)
      for (const id of this.indexed(now))
        this.enqueue(id, sweep.reason, now, 0, now);
    const expired = this.sql
      .exec(
        "delete from retry where first_at < ? returning artifact_id",
        now - RETRY_MAX_AGE_MS,
      )
      .toArray().length;
    if (expired > 0)
      logError(
        this.isIndex ? "install_close_expired" : "presence_close_expired",
        new Error("retries exhausted"),
        { count: expired },
      );
    const rows = this.sql
      .exec<RetryRow>(
        "select artifact_id, reason, first_at, attempts from retry where due <= ? order by due limit ?",
        now,
        CLOSE_FANOUT,
      )
      .toArray();
    if (rows.length > 0) {
      const target = this.target;
      const rs = await Promise.allSettled(
        rows.map((r) => this.closer(this.env, r.artifact_id, target, r.reason)),
      );
      rs.forEach((res, i) => {
        const r = rows[i] as RetryRow;
        // A newer closeAll may have re-queued the row meanwhile: match first_at.
        if (res.status === "fulfilled")
          this.sql.exec(
            "delete from retry where artifact_id = ? and first_at = ?",
            r.artifact_id,
            r.first_at,
          );
        else {
          const attempts = r.attempts + 1;
          // The index logs a fixed error: its reason can name an artifact.
          if (this.isIndex)
            logError("install_close_failed", new Error("socket close failed"), {
              attempts,
            });
          else logError("presence_close_failed", res.reason, { attempts });
          this.sql.exec(
            "update retry set attempts = ?, due = ? where artifact_id = ? and first_at = ?",
            attempts,
            this.now() + retryBackoffMs(attempts),
            r.artifact_id,
            r.first_at,
          );
        }
      });
    }
    await this.arm();
  }
}

/** Typed RPC view of a user's presence DO. */
export type PresenceStub = {
  touch(artifactId: string, authzAt: number): Promise<{ ok: boolean }>;
  closeAll(reason: string): Promise<number>;
  markRevoked(): Promise<number>;
};

/**
 * The user's presence DO, or null when the install has no USER_PRESENCE
 * binding (callers log presence_unbound).
 */
export function presenceStub(
  env: Pick<Env, "USER_PRESENCE">,
  userId: string,
): PresenceStub | null {
  const ns = env.USER_PRESENCE;
  if (!ns) return null;
  return ns.get(ns.idFromName(userId)) as unknown as PresenceStub;
}

/** Typed RPC view of the install-wide socket index (INSTALL_INDEX). */
export type SocketIndexStub = {
  seen(artifactId: string): Promise<void>;
  closeInstall(reason: string): Promise<InstallCloseResult>;
};

/** The install's socket index, or null without the USER_PRESENCE binding. */
export function socketIndexStub(
  env: Pick<Env, "USER_PRESENCE">,
): SocketIndexStub | null {
  const ns = env.USER_PRESENCE;
  if (!ns) return null;
  return ns.get(ns.idFromName(INSTALL_INDEX)) as unknown as SocketIndexStub;
}
