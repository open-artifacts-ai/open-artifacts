import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "@oa/shared";
import type { Env } from "../env.js";
import { logError } from "../log.js";

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
`;

/** The artifact DO's closeActor RPC (runtime/do.ts), as this DO calls it. */
type ActorCloser = {
  closeActor(actor: string, reason: string): Promise<number>;
};

type RetryRow = {
  artifact_id: string;
  reason: string;
  first_at: number;
  attempts: number;
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
 */
export class UserPresence extends DurableObject<Env> {
  private ready = false;

  /** Clock; overridable in tests. */
  now: () => number = () => Date.now();

  /** Closes `actor`'s sockets on one artifact's DO; overridable in tests. */
  closer: (
    env: Env,
    artifactId: string,
    actor: string,
    reason: string,
  ) => Promise<number> = (env, artifactId, actor, reason) => {
    const ns = env.ARTIFACT_RUNTIME;
    return (
      ns.get(ns.idFromName(artifactId)) as unknown as ActorCloser
    ).closeActor(actor, reason);
  };

  private get sql(): SqlStorage {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA);
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }

  /** The user this DO tracks: the name it was addressed by. */
  private get actor(): string {
    const id = this.ctx.id.name;
    if (!id) throw new Error("UserPresence needs a named id");
    return `u:${id}`;
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
   * Starts a revocation: revokedAt = now is written before any close, then
   * the user's sockets on each recorded artifact close (4403). Failed closes,
   * and any past CLOSE_FANOUT, go to the retry queue. Returns the number of
   * sockets closed now.
   */
  async closeAll(reason: string): Promise<number> {
    const why = String(reason).slice(0, MAX_REASON);
    const actor = this.actor;
    const now = this.now();
    this.sql.exec(
      `insert into state (id, revoked_at) values (1, ?)
       on conflict (id) do update set revoked_at = max(revoked_at, excluded.revoked_at)`,
      now,
    );
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
    return closed;
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
      .exec<{ due: number | null }>("select min(due) as due from retry")
      .one().due;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /**
   * Retries due closes (at most CLOSE_FANOUT per run) with backoff; drops
   * those past RETRY_MAX_AGE_MS (their sockets are past the TTL). Re-arms for
   * the next due one.
   */
  override async alarm(): Promise<void> {
    const now = this.now();
    const expired = this.sql
      .exec(
        "delete from retry where first_at < ? returning artifact_id",
        now - RETRY_MAX_AGE_MS,
      )
      .toArray().length;
    if (expired > 0)
      logError("presence_close_expired", new Error("retries exhausted"), {
        count: expired,
      });
    const rows = this.sql
      .exec<RetryRow>(
        "select artifact_id, reason, first_at, attempts from retry where due <= ? order by due limit ?",
        now,
        CLOSE_FANOUT,
      )
      .toArray();
    if (rows.length > 0) {
      const actor = this.actor;
      const rs = await Promise.allSettled(
        rows.map((r) => this.closer(this.env, r.artifact_id, actor, r.reason)),
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
          logError("presence_close_failed", res.reason, { attempts });
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
};

let unboundLogged = false;

/**
 * The user's presence DO, or null when the install has no USER_PRESENCE
 * binding (logged once per isolate as presence_unbound).
 */
export function presenceStub(
  env: Pick<Env, "USER_PRESENCE">,
  userId: string,
): PresenceStub | null {
  const ns = env.USER_PRESENCE;
  if (!ns) {
    if (!unboundLogged) {
      unboundLogged = true;
      logError("presence_unbound", new Error("USER_PRESENCE is not bound"));
    }
    return null;
  }
  return ns.get(ns.idFromName(userId)) as unknown as PresenceStub;
}
