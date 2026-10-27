import type { DirectoryBinding, HeldSweep, SyncStatus } from "@oa/shared";
import {
  brokerTransportKind,
  withoutBrokerProps,
} from "../auth/broker-transport.js";
import { stmt } from "../db/stmt.js";
import type { DirectoryAlert } from "../email/templates.js";
import type { Env } from "../env.js";
import { logError, logInfo, logWarn } from "../log.js";
import { revokeFanoutCap, revokeUsersLive } from "../runtime/revoke.js";
import { type AuditActor, audit } from "../services/audit.js";
import { setUserStatus } from "../services/members.js";
import { directoryMode } from "../services/spaces.js";
import { alertOwners } from "./alert.js";
import { applyGroupDiff, applyUsers } from "./apply.js";
import { bindPage } from "./binding.js";
import { directoryClient } from "./client.js";
import { directoryStatus } from "./connect.js";
import {
  activities,
  GoogleApiError,
  type GoogleUser,
  getGroup,
  getUser,
  listMembers,
  listUsers,
} from "./google.js";
import {
  ALERT_AFTER_MS,
  clearHealth,
  type Health,
  markStale,
  putHealth,
  readHealth,
} from "./health.js";
import {
  liveSub,
  putInitial,
  readBinding,
  readInitial,
  readPending,
} from "./store.js";
import { type PendingRevokes, thawFrozenEdits } from "./thaw.js";
import { type DirectoryClient, TransportError } from "./transport.js";

// The DirectorySync engine (P3 T13). One DO per install runs it on its alarm;
// everything here takes the env and the DO's SQLite explicitly, so tests can
// drive it with any env and clock.
//
// - Two lanes, each a queue of steps persisted in the DO:
//   - fast (every 2 min): Reports admin and groups events since the cursor
//     (10 min overlap). User events re-read that user by address through
//     users.get and apply by Google id (suspensions at once; DELETE_USER
//     queues the deleted listing). Group events mark the group and its
//     ancestors dirty; the dirty mapped or restricted groups are re-read.
//   - rec (hourly, and on mapping, manual and signin kicks): the active,
//     suspended and deleted listings, then every mapped or restricted group
//     with its descendants.
//   The fast lane runs whenever it is due, even while a reconcile is paging
//   or stuck, so suspensions keep applying.
// - One Google page per alarm; while a lane has steps the alarm re-arms at
//   once, and an alarm is always set again (finally). A step's progress (its
//   page cursor, the members it saw) is committed in one DO transaction only
//   after its D1 work succeeded, so a failure retries the same page and a
//   partial read never removes anyone. A group's removals are computed only
//   after its last page (the members seen, in the DO's `seen` table, against
//   directory_members), and `seen` is cleared only after the sweep's writes.
// - Holds: a sweep removing over 50% of a group of 5+ (unless groups.get
//   reads directMembersCount 0), a 404 group without DELETE_GROUP, and every
//   sweep while the active listing read 0 users. A group answering another
//   4xx removes nobody that run. Suspensions and deletions are never held.
//   The owner's confirm re-reads the group and then applies its removals
//   once, so anyone re-added since the hold stays.
// - Customer check on every run: the grant's own user (users.get) and every
//   listed user must carry the binding's customer id (a missing one counts
//   as a mismatch), else customer_mismatch (audited, owners emailed, retried
//   hourly).
// - Frozen (Team): user listings and user events continue; group sync stops.
// - Health is written to D1 only on change (lastSuccessAt at most hourly).

export const FAST_MS = 2 * 60_000;
export const RECONCILE_MS = 3600_000;
export const OVERLAP_MS = 10 * 60_000;
/** A signin kick starts a reconcile at most this often. */
export const SIGNIN_MIN_MS = 10 * 60_000;
export const BACKOFF_MIN_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** auth_failed, scope_missing and customer_mismatch retry hourly. */
export const RETRY_HOURLY_MS = 3600_000;
/** users.get calls for user events per alarm; the rest carry over. */
export const USER_EVENTS_PER_PAGE = 100;
/** Google member ids resolved per D1 statement. */
const ID_CHUNK = 200;

/** "confirm" is internal: a held sweep's re-read (DirectorySync.confirmHeld). */
export type KickReason = "cron" | "mapping" | "manual" | "signin" | "confirm";
/** A queued access job (P3 T9: space-wide socket closes, revocation retries). */
export type SyncJob = { kind: string; [k: string]: unknown };

type Lane = "fast" | "rec";
/** Kicks that may run once during a backoff (retryAt). */
const REC_REASONS: readonly KickReason[] = ["mapping", "manual", "signin"];
const LANES: readonly Lane[] = ["fast", "rec"];
/** A confirmed hold applies on a sweep within this long of the click. */
export const CONFIRM_TTL_MS = 24 * 3600_000;
/** Reconciles in a row a group must refuse its listing before it is surfaced. */
export const CONSECUTIVE_REFUSALS = 3;
/** "Sync now" may run during a backoff at most this often. */
export const MANUAL_BYPASS_MS = 10 * 60_000;
/** How long an access token is used after it reached this DO (Google's last 1 h). */
export const TOKEN_TTL_MS = 45 * 60_000;

/**
 * The directory access token, in memory only: never written to DO storage,
 * never logged, dropped at expiry, on a reset and on a 401. One per DO
 * instance (sync-do.ts), so an evicted DO starts empty.
 *
 * Where it comes from:
 * - handed in (handToken) by an invocation that holds the platform's
 *   DIRECTORY_BROKER capability: the scheduler's oa:directory-sync tick or a
 *   request's kick (services/directory.ts feedSync). The capability itself
 *   never reaches the DO, only the token (or why minting failed).
 * - minted here (self-host): when this install reaches its broker without
 *   props (a binding, or HTTPS off HOSTED) or holds its own Google app
 *   (direct), exactly as before.
 * A hosted alarm never calls the broker: without a token in hand it stops
 * cleanly (the run stays) until the next tick hands one over.
 */
export class TokenBox {
  /** `for`: the binding it was minted for (tokenFor). */
  tok: { token: string; exp: number; for: string } | null = null;
  /** A failed mint (feedSync), raised once by the next alarm as before. */
  fault: { stage: TransportError["stage"]; for: string } | null = null;
}

/** Which binding a token belongs to: a reset to another one drops it. */
export const tokenFor = (
  b: Pick<DirectoryBinding, "customerId" | "connectedAt">,
) => `${b.customerId}:${b.connectedAt}`;

/**
 * This DO may mint its own access token (self-host): a direct client, or a
 * broker reachable without props (binding, or HTTPS off HOSTED). Read under
 * withoutBrokerProps, so a hosted install answers false.
 */
const selfMints = (env: Env, client: DirectoryClient) =>
  client.kind === "direct" ||
  withoutBrokerProps(() => brokerTransportKind(env, "directory")) !== null;

const SYNC: AuditActor = { kind: "sync", id: null };

type Walk = {
  kind: "walk";
  target: string;
  stack: { g: string; page: string | null }[];
  visited: string[];
  had: number | null;
  partial: boolean;
  missing: boolean;
  /** The target itself refused its listing (a 4xx other than 401/429/404). */
  refused?: boolean;
  /** When this walk read its first page: rows added after it are kept. */
  startedAt?: number;
};
type Step =
  | { kind: "customer" }
  | { kind: "initial" }
  | {
      kind: "users";
      which: "active" | "suspended" | "deleted";
      page: string | null;
    }
  | { kind: "reports"; app: "admin" | "groups"; page: string | null }
  | { kind: "userkeys" }
  | { kind: "targets"; all: boolean }
  | { kind: "thaw" }
  | Walk
  | { kind: "finish" };

/** Steps that read groups or apply group-derived access: skipped while frozen. */
const GROUP_STEPS = new Set(["targets", "thaw", "walk", "reports:groups"]);
const stepGroup = (s: Step) =>
  s.kind === "reports" ? `reports:${s.app}` : s.kind;

type Run = {
  lane: Lane;
  startedAt: number;
  queue: Step[];
  /** Users in the active listing so far (rec). */
  active: number;
  /** DELETE_GROUP seen this run (group emails). */
  deletedGroups: string[];
  /** Kick reasons this run answers. */
  reasons: KickReason[];
  /** User-event addresses still to re-read (past USER_EVENTS_PER_PAGE). */
  userKeys: string[];
};

/** What a step did: its status, whether it called Google, its commit. */
type Done = {
  status: "done" | "more" | "abort";
  called: boolean;
  /** Replaces the finished step (targets: one walk per group). */
  replace?: Step[];
  /** DO writes committed with the run, in one transaction. */
  tx?: () => void;
};

const SCHEMA = `
create table if not exists kv (k text primary key, v text not null) without rowid;
create table if not exists seen (
  lane text not null, target text not null, uid text not null,
  primary key (lane, target, uid)
) without rowid;
create table if not exists dirty (group_id text primary key) without rowid;
create table if not exists held (
  group_id text primary key, since integer not null,
  -- 'sweep': removals waiting for the owner; 'unreadable': the group
  -- refused its listing CONSECUTIVE_REFUSALS runs in a row (not confirmable).
  kind text not null default 'sweep',
  -- the removals the owner is shown (a confirm applies at most this many)
  would integer not null default 0,
  confirmed_at integer
) without rowid;
create table if not exists refused (
  group_id text primary key, runs integer not null, since integer not null
) without rowid;
`;

export class SyncError extends Error {
  constructor(
    public state: "backoff" | "auth_failed" | "scope_missing",
    public code: string,
  ) {
    super(`directory sync: ${code}`);
    this.name = "SyncError";
  }
}

/** Maps a transport or Admin SDK failure to the health state it causes. */
export function classify(e: unknown): SyncError {
  if (e instanceof SyncError) return e;
  if (e instanceof TransportError)
    return e.stage === "invalid_grant"
      ? new SyncError("auth_failed", "invalid_grant")
      : new SyncError("backoff", `transport_${e.stage}`);
  if (e instanceof GoogleApiError) {
    if (e.status === 403 && e.reason === "insufficientPermissions")
      return new SyncError("scope_missing", "insufficient_permissions");
    return new SyncError("backoff", `google_http_${e.status}`);
  }
  return new SyncError("backoff", "internal");
}

/** A group-level Admin SDK refusal: that walk removes nobody, the run goes on. */
const groupRefusal = (e: unknown) =>
  e instanceof GoogleApiError &&
  e.status >= 400 &&
  e.status < 500 &&
  e.status !== 401 &&
  e.status !== 429 &&
  e.reason !== "insufficientPermissions";

export const backoffMs = (n: number) =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, n - 1));

/** A group's members this run (`seen`) against its stored rows (`cur`). */
export function memberDiff(
  seen: ReadonlySet<string>,
  cur: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const u of seen) if (!cur.has(u)) added.push(u);
  for (const u of cur) if (!seen.has(u)) removed.push(u);
  return { added, removed };
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// D1 statements.
const TARGETS = `select group_id from group_mappings
  union select group_id from org_group_mappings
  union select group_id from restricted_groups`;
const GROUP_IDS_BY_EMAIL = `select group_id from directory_groups
  where email in (select value from json_each(?1))`;
/**
 * The dirty groups and every ancestor (parent_ids), intersected with the
 * targets: one row per (dirty mark, target it reaches).
 */
const DIRTY_TARGETS = `with recursive up(origin, g) as (
    select value, value from json_each(?1)
    union
    select up.origin, p.value from up join directory_groups dg on dg.group_id = up.g,
      json_each(dg.parent_ids) p
  )
  select distinct origin, g as group_id from up where g in (${TARGETS})`;
const UIDS_FOR_SUBJECTS = `select subject, user_id from identities
  where provider = 'google' and directory_bound = 1
    and subject in (select value from json_each(?1))`;
/** gen holds when the row was added (ms; 0 before T13): see sweep(). */
const MEMBERS_OF =
  "select user_id, gen from directory_members where group_id = ?1";
const COUNT_OF =
  "select count(*) as n from directory_members where group_id = ?1";
const GROUP_ROW = "select email from directory_groups where group_id = ?1";
/** A nested group's row and its parent link; written only when it changes. */
const UPSERT_CHILD = `insert into directory_groups (group_id, email, parent_ids)
  values (?1, ?2, json_array(?3))
  on conflict (group_id) do update set
    email = excluded.email,
    parent_ids = case
      when exists (select 1 from json_each(directory_groups.parent_ids) where value = ?3)
      then directory_groups.parent_ids
      else json_insert(directory_groups.parent_ids, '$[#]', ?3) end
  where directory_groups.email <> excluded.email
    or not exists (select 1 from json_each(directory_groups.parent_ids) where value = ?3)`;
/** A page of active synced users after ?1, by id (T18's customer_mismatch socket close). */
const SYNCED_PAGE = `select u.id from identities i join users u on u.id = i.user_id
  where i.provider = 'google' and i.directory_bound = 1 and u.status = 'active'
    and u.id > ?1
    and (select value from directory_state where key = 'sync.state') = 'customer_mismatch'
  order by u.id limit ?2`;
/** DO kv: the last user id whose sockets the customer_mismatch close signalled. */
const CLOSE_KEY = "mismatch.close";

/** A reset() landed since this alarm started: it writes nothing more. */
class StaleSignal extends Error {
  constructor() {
    super("directory sync: stale epoch");
  }
}

class MismatchSignal extends Error {
  constructor(public actual: string) {
    super("directory sync: customer_mismatch");
  }
}

/** Informational (T18): sync has not succeeded for STALE_MS. Nothing is revoked. */
const staleAudit = (env: Env, h: Health) =>
  audit(env, "directory.stale", { type: "directory", id: "google" }, SYNC, {
    detail: {
      lastSuccessAt: h.lastSuccessAt,
      staleAt: h.staleAt,
      state: h.state,
    },
  });

export class SyncEngine {
  private sql: SqlStorage;

  constructor(
    private env: Env,
    private storage: DurableObjectStorage,
    private ctx?: Pick<ExecutionContext, "waitUntil">,
    private box: TokenBox = new TokenBox(),
  ) {
    this.sql = storage.sql;
    this.sql.exec(SCHEMA);
  }

  // ------------------------------------------------------------ kv

  private get<T>(k: string): T | null {
    const r = this.sql.exec("select v from kv where k = ?", k).toArray()[0];
    if (!r) return null;
    try {
      return JSON.parse(String(r.v)) as T;
    } catch {
      return null;
    }
  }

  private put(k: string, v: unknown) {
    this.sql.exec(
      "insert into kv (k, v) values (?, ?) on conflict (k) do update set v = excluded.v",
      k,
      JSON.stringify(v),
    );
  }

  private del(k: string) {
    this.sql.exec("delete from kv where k = ?", k);
  }

  // ------------------------------------------------------- owed revokes

  /** Closes these users' sockets (the thaw's narrowed). Replaceable in tests. */
  revokeLive = (ids: string[]): Promise<void> =>
    revokeUsersLive(this.env, ids, "frozen edit undone", this.ctx);

  /** The thaw's owed socket closes, kept in kv until revoked (P3 T15). */
  private owed(): PendingRevokes {
    const K = "revoke.pending";
    const cur = () => new Set(this.get<string[]>(K) ?? []);
    const set = (s: Set<string>) => {
      if (s.size) this.put(K, [...s]);
      else {
        this.del(K);
        this.del("revoke.tries");
      }
    };
    // Held by this thaw only: users already owed stay owed whatever it finds.
    let held = new Set<string>();
    return {
      hold: (ids) => {
        const c = cur();
        held = new Set(ids.filter((x) => !c.has(x)));
        set(new Set([...c, ...ids]));
      },
      keep: (_ids, narrowed) => {
        const keep = new Set(narrowed);
        set(new Set([...cur()].filter((x) => keep.has(x) || !held.has(x))));
      },
      release: (ids) =>
        set(new Set([...cur()].filter((x) => !ids.includes(x)))),
    };
  }

  /** Retries socket closes a failed or interrupted thaw still owes. */
  private async retryOwed(): Promise<void> {
    const ids = this.get<string[]>("revoke.pending") ?? [];
    if (!ids.length) return;
    try {
      await this.revokeLive(ids);
      this.owed().release(ids);
      this.del("revoke.tries");
    } catch (e) {
      // Retried by the re-armed alarm, each time later (backoffMs).
      this.put("revoke.tries", (this.get<number>("revoke.tries") ?? 0) + 1);
      logError("directory_thaw_revoke", e);
    }
  }

  private reasons(): KickReason[] {
    return this.get<KickReason[]>("reasons") ?? [];
  }

  /** A run is in flight on either lane. */
  busy(): boolean {
    return (
      this.get<Run>("run.fast") !== null || this.get<Run>("run.rec") !== null
    );
  }

  /** Work can run at `now` on some lane. */
  due(now: number): boolean {
    return this.get<string>(CLOSE_KEY) !== null || this.nextAt(now) <= now;
  }

  /** When `lane` may next run (its backoff respected, kicks and bypasses counted). */
  private laneAt(lane: Lane, now: number): number {
    const retryAt = this.get<number>(`retryAt.${lane}`);
    const backing = retryAt !== null && now < retryAt;
    const reasons = this.reasons();
    const kicked =
      lane === "fast"
        ? reasons.includes("confirm")
        : reasons.some((r) => REC_REASONS.includes(r));
    const want =
      this.get<Run>(`run.${lane}`) !== null || kicked
        ? now
        : (this.get<number>(lane === "fast" ? "next.fast" : "next.reconcile") ??
          now);
    if (!backing) return Math.max(now, want);
    return this.bypass(lane, now) ? now : (retryAt as number);
  }

  /**
   * During a backoff a lane may still run for a kick that arrived after its
   * last failure: a confirm (fast) once per kick; a mapping change or "Sync
   * now" (rec) at most once per MANUAL_BYPASS_MS together, so repeated
   * mapping writes can't drive Google or broker load during a backoff.
   */
  private bypass(lane: Lane, now: number): boolean {
    const reasons = this.reasons();
    const failAt = this.get<number>(`failAt.${lane}`) ?? 0;
    const after = (r: KickReason) =>
      reasons.includes(r) && (this.get<number>(`kick.${r}`) ?? -1) > failAt;
    if (lane === "fast") return after("confirm");
    return (
      (after("mapping") || after("manual")) &&
      now - (this.get<number>("bypass.rec") ?? -MANUAL_BYPASS_MS) >=
        MANUAL_BYPASS_MS
    );
  }

  private nextAt(now: number): number {
    return Math.min(...LANES.map((l) => this.laneAt(l, now)));
  }

  // ------------------------------------------------------------ RPCs

  /** Asks for a run; returns the status. */
  async kick(reason: KickReason, now = Date.now()): Promise<SyncStatus> {
    const reasons = this.reasons();
    const lastRec = this.get<number>("reconcile.startedAt") ?? 0;
    const counts =
      reason !== "cron" &&
      (reason !== "signin" || now - lastRec >= SIGNIN_MIN_MS);
    // When it arrived: a kick after a lane's last failure may bypass its
    // backoff (bypass()).
    this.put(`kick.${reason}`, now);
    if (counts && !reasons.includes(reason)) {
      reasons.push(reason);
      this.put("reasons", reasons);
    }
    const alarm = await this.storage.getAlarm();
    if (counts || alarm === null) await this.storage.setAlarm(now);
    return this.status();
  }

  status(): Promise<SyncStatus> {
    return directoryStatus(this.env, { showProblem: true });
  }

  /**
   * A lane is due (the same timing the alarm uses: laneAt) and no unexpired
   * token is in hand: the caller should mint one and handToken it. Restarts
   * a lost alarm (like a cron kick). Reads only this DO's storage.
   */
  async wantsToken(now = Date.now()): Promise<boolean> {
    if ((await this.storage.getAlarm()) === null)
      await this.storage.setAlarm(now);
    const t = this.box.tok;
    if (t && t.exp > now) return false;
    if (this.get<string>(CLOSE_KEY) !== null) return false;
    return LANES.some((l) => this.laneAt(l, now) <= now);
  }

  /**
   * Takes an access token minted by the caller for binding `forKey`
   * (tokenFor), or why minting failed, and runs the due step now: the alarm,
   * at once. The token stays in memory only (TokenBox).
   */
  async handToken(
    forKey: string,
    h: { token: string } | { error: TransportError["stage"] },
    now = Date.now(),
  ): Promise<void> {
    if ("token" in h) {
      this.box.tok = { token: h.token, exp: now + TOKEN_TTL_MS, for: forKey };
      this.box.fault = null;
    } else this.box.fault = { stage: h.error, for: forKey };
    await this.storage.setAlarm(now);
  }

  /**
   * The org owner confirmed a held sweep: the group is re-read now and its
   * removals then apply once, at most the count the owner was shown and
   * within CONFIRM_TTL_MS (the next sweep consumes the click whatever its
   * outcome), so anyone re-added since the hold stays. Null when there is
   * nothing to confirm: an unreadable group can't be confirmed.
   */
  async confirmHeld(
    groupId: string,
    by: AuditActor = SYNC,
    now = Date.now(),
  ): Promise<SyncStatus | null> {
    const ok = this.storage.transactionSync(() => {
      const r = this.sql
        .exec("select kind from held where group_id = ?", groupId)
        .toArray()[0];
      if (!r || r.kind !== "sweep") return false;
      this.sql.exec(
        "update held set confirmed_at = ? where group_id = ?",
        now,
        groupId,
      );
      this.sql.exec(
        "insert or ignore into dirty (group_id) values (?)",
        groupId,
      );
      return true;
    });
    if (!ok) return null;
    await audit(
      this.env,
      "directory.sweep.confirmed",
      { type: "group", id: groupId },
      by,
    ).run();
    return this.kick("confirm", now);
  }

  async enqueue(_job: SyncJob): Promise<void> {
    // P3 T9's access jobs (space-wide socket closes, revocation retries)
    // land here; revokeUsersLive covers them inline until then.
  }

  /**
   * Forgets everything synced state remembers (a new binding replaced the
   * old one, or the directory was disconnected): runs, cursors, the active
   * count, holds, and the D1 health rows.
   */
  async reset(now = Date.now()): Promise<void> {
    // Only the epoch moves here; the next alarm does the clearing, serialized
    // with every other write (an alarm in flight then writes nothing more).
    this.put("epoch", (this.get<number>("epoch") ?? 0) + 1);
    this.dropToken();
    await this.storage.setAlarm(now);
  }

  /** Applies a reset(): clears runs, seen, holds, cursors and health. */
  private async applyReset(ep: number): Promise<void> {
    this.storage.transactionSync(() => {
      for (const t of ["seen", "dirty", "held", "refused"])
        this.sql.exec(`delete from ${t}`);
      this.sql.exec(
        `delete from kv where k in ('run.fast', 'run.rec', 'lastActive',
          'cursor.admin', 'cursor.groups', 'retryAt.fast', 'retryAt.rec',
          'backoff.fast', 'backoff.rec', 'failAt.fast', 'failAt.rec',
          'bypass.rec', 'next.fast', 'next.reconcile', 'lastLane')`,
      );
    });
    this.dropToken();
    await clearHealth(this.env).run();
    // Recorded last: a failure above retries the clearing next alarm.
    this.put("epoch.applied", ep);
  }

  /** Throws StaleSignal when a reset() landed since this alarm started. */
  private guard() {
    if (!this.fresh()) throw new StaleSignal();
  }

  /** The epoch this alarm started under; reset() bumps it. */
  private ep = 0;
  /** No reset() ran since this alarm started. */
  private fresh(): boolean {
    return (this.get<number>("epoch") ?? 0) === this.ep;
  }
  /** This alarm's clock. */
  private now = 0;

  // ------------------------------------------------------------ alarm

  /**
   * One alarm: picks a lane (fast first when due), plans its run when none is
   * in flight, then works through steps until one Google call was made.
   * Whatever happens, the next alarm is set (finally), unless sync is off
   * and no socket close is owed: owed closes re-arm it (backing off from
   * BACKOFF_MIN_MS to BACKOFF_MAX_MS) in any mode until they are done.
   */
  alarm(now = Date.now()): Promise<void> {
    // An alarm never holds a broker capability, whatever reached this DO.
    return withoutBrokerProps(() => this.alarmIn(now));
  }

  private async alarmIn(now: number): Promise<void> {
    let next: number | null = now + FAST_MS;
    try {
      next = await this.tick(now);
    } catch (e) {
      logError("directory_sync_alarm", e);
      next = now + BACKOFF_MIN_MS;
    } finally {
      try {
        if (this.get<string[]>("revoke.pending")?.length) {
          const retry = now + backoffMs(this.get<number>("revoke.tries") ?? 1);
          next = next === null ? retry : Math.min(next, retry);
        }
      } catch (e) {
        logError("directory_thaw_revoke", e);
      }
      if (next !== null)
        await this.storage
          .setAlarm(next)
          .catch((e) => logError("directory_sync_rearm", e));
    }
  }

  /** The alarm's work; resolves to when the next alarm is due (null: none). */
  private async tick(now: number): Promise<number | null> {
    this.ep = this.get<number>("epoch") ?? 0;
    this.now = now;
    if (this.ep > (this.get<number>("epoch.applied") ?? 0)) {
      await this.applyReset(this.ep);
      if (!this.fresh()) return now;
    }
    // Socket closes a thaw still owes, first, in any mode.
    await this.retryOwed();
    // A customer_mismatch close still paging (T18): one page per alarm,
    // re-armed at once; a D1 error backs off. Once the state has left
    // customer_mismatch the page is empty, the cursor drops and sync resumes.
    if (this.get<string>(CLOSE_KEY) !== null) {
      const ids = await this.syncedPage();
      if (ids === null) return now + BACKOFF_MIN_MS;
      await revokeUsersLive(this.env, ids, "directory customer_mismatch");
      return now;
    }
    const mode = directoryMode(this.env);
    const client = directoryClient(this.env);
    const [{ binding, sealed }, pending] = await Promise.all([
      readBinding(this.env),
      readPending(this.env),
    ]);
    // Nothing to sync (off, unbound, no transport): stop until kicked. Runs
    // in flight are kept; they resume when sync is back.
    if (mode === "off" || !client || !binding || !sealed) return null;
    // A consent waiting for its owner: nothing syncs until confirm or cancel.
    if (pending) return now + FAST_MS;
    if (!this.fresh()) return now;
    const groups = mode === "google";
    // Hosted with no token in hand: stop cleanly before planning anything
    // (no lane, run or bypass is touched); the run in flight stays and the
    // next oa:directory-sync tick (or a request's kick) hands a token over.
    if (
      LANES.some((l) => this.laneAt(l, now) <= now) &&
      !this.canToken(client, binding, now)
    )
      return now + FAST_MS;
    const lane = this.pickLane(now, groups);
    if (!lane) return this.nextAt(now);
    const run = this.get<Run>(`run.${lane}`) as Run;
    try {
      const token = await this.token(client, binding, sealed, now);
      await this.work(run, token, binding, groups, now);
    } catch (e) {
      if (e instanceof StaleSignal || !this.fresh()) return now;
      try {
        if (e instanceof MismatchSignal) {
          this.del(`run.${lane}`);
          return await this.mismatch(binding.customerId, e.actual, now);
        }
        await this.fail(lane, classify(e), now);
      } catch (f) {
        if (f instanceof StaleSignal) return now;
        throw f;
      }
    }
    return this.nextAt(now);
  }

  /**
   * The lane to work now, planning its run when needed; null when neither
   * may run. When both may, they alternate, so neither starves the other.
   */
  private pickLane(now: number, groups: boolean): Lane | null {
    const ready = LANES.filter((l) => this.laneAt(l, now) <= now);
    if (!ready.length) return null;
    const last = this.get<Lane>("lastLane");
    const lane =
      ready.length === 2
        ? last === "fast"
          ? "rec"
          : "fast"
        : (ready[0] as Lane);
    const retryAt = this.get<number>(`retryAt.${lane}`);
    // A rec bypass (mapping or "Sync now"): spent for MANUAL_BYPASS_MS.
    if (lane === "rec" && retryAt !== null && now < retryAt)
      this.put("bypass.rec", now);
    this.put("lastLane", lane);
    if (!this.get<Run>(`run.${lane}`))
      this.plan(lane, now, groups, this.reasons());
    return lane;
  }

  private plan(
    lane: Lane,
    now: number,
    groups: boolean,
    reasons: KickReason[],
  ) {
    const queue: Step[] = [{ kind: "customer" }];
    if (lane === "rec") {
      this.put("reconcile.startedAt", now);
      queue.push(
        { kind: "initial" },
        { kind: "users", which: "active", page: null },
        { kind: "users", which: "suspended", page: null },
        { kind: "users", which: "deleted", page: null },
      );
      // Sync back after a freeze: the walks (targets is replaced by them, in
      // front of the thaw) refresh directory_members first, then frozen
      // edits get their outcomes on fresh membership (P3 T15).
      if (groups) queue.push({ kind: "targets", all: true }, { kind: "thaw" });
    } else {
      queue.push({ kind: "reports", app: "admin", page: null });
      if (groups) {
        queue.push({ kind: "reports", app: "groups", page: null });
        queue.push({ kind: "targets", all: false });
      }
    }
    queue.push({ kind: "finish" });
    const run: Run = {
      lane,
      startedAt: now,
      queue,
      active: 0,
      deletedGroups: [],
      reasons: reasons.filter((r) =>
        lane === "rec" ? REC_REASONS.includes(r) : r === "confirm",
      ),
      userKeys: [],
    };
    this.put(`run.${lane}`, run);
  }

  private dropToken() {
    this.box.tok = null;
    this.box.fault = null;
  }

  /** An unexpired token for `b`, a failed mint to report, or self-minting. */
  private canToken(
    client: DirectoryClient,
    b: DirectoryBinding,
    now: number,
  ): boolean {
    const key = tokenFor(b);
    const t = this.box.tok;
    if (t && (t.for !== key || t.exp <= now)) this.box.tok = null;
    if (this.box.fault && this.box.fault.for !== key) this.box.fault = null;
    return !!this.box.tok || !!this.box.fault || selfMints(this.env, client);
  }

  /**
   * The access token for `b` (TokenBox): the one in hand, else a handed-in
   * mint failure (thrown once, so it backs off or marks auth_failed as a
   * mint here did), else minted here (self-host only; canToken checked).
   */
  private async token(
    client: DirectoryClient,
    b: DirectoryBinding,
    sealed: string,
    now: number,
  ): Promise<string> {
    const key = tokenFor(b);
    const t = this.box.tok;
    if (t && t.for === key && t.exp > now) return t.token;
    this.box.tok = null;
    const f = this.box.fault;
    this.box.fault = null;
    if (f && f.for === key) throw new TransportError(f.stage);
    if (!selfMints(this.env, client))
      throw new TransportError("broker_unavailable");
    const token = await client.accessToken(sealed);
    this.box.tok = { token, exp: now + TOKEN_TTL_MS, for: key };
    return token;
  }

  /**
   * Runs steps until one has called Google (or the queue is empty). Each
   * step's progress commits with the run in one DO transaction, after its
   * own D1 work; a throw commits nothing, so the step runs again.
   */
  private async work(
    run: Run,
    token: string,
    b: DirectoryBinding,
    groups: boolean,
    now: number,
  ): Promise<void> {
    const key = `run.${run.lane}`;
    for (;;) {
      const step = run.queue[0];
      if (!step) {
        this.del(key);
        return;
      }
      const res = await this.step(run, step, token, b, groups, now);
      // reset() ran meanwhile (a new binding): this run is gone; drop it.
      if (!this.fresh()) return;
      if (res.status === "abort") {
        this.storage.transactionSync(() => {
          res.tx?.();
          this.del(key);
        });
        return;
      }
      if (res.status === "done") {
        run.queue.shift();
        if (res.replace) run.queue.unshift(...res.replace);
      }
      this.storage.transactionSync(() => {
        res.tx?.();
        if (run.queue.length) this.put(key, run);
        else this.del(key);
      });
      if (res.called || !run.queue.length) return;
    }
  }

  private async step(
    run: Run,
    step: Step,
    token: string,
    b: DirectoryBinding,
    groups: boolean,
    now: number,
  ): Promise<Done> {
    // Frozen (Team): a run planned while sync was on reads no groups and
    // changes no group-derived access; it never widens (P3 T15).
    if (!groups && GROUP_STEPS.has(stepGroup(step)))
      return { status: "done", called: false };
    switch (step.kind) {
      case "customer": {
        const sub = await liveSub(this.env);
        if (!sub) return { status: "done", called: false };
        let who: GoogleUser | null = null;
        try {
          who = await getUser(token, sub);
        } catch (e) {
          // The grant's account gone: the listings still check every user.
          if (!(e instanceof GoogleApiError && e.status === 404)) throw e;
        }
        if (who && who.customerId !== b.customerId)
          throw new MismatchSignal(who.customerId ?? "");
        return { status: "done", called: true };
      }
      case "initial": {
        const init = await readInitial(this.env);
        if (init.done) return { status: "done", called: false };
        const page = await listUsers(token, b.customerId, {
          pageToken: init.cursor ?? undefined,
        });
        this.checkCustomer(page.users, b);
        this.guard();
        await bindPage(this.env, page.users, {
          tenant: b.domain,
          allowEmail: true,
          ctx: this.ctx,
          guard: () => this.guard(),
        });
        const done = !page.nextPageToken;
        this.guard();
        await putInitial(this.env, { done, cursor: page.nextPageToken }).run();
        return { status: done ? "done" : "more", called: true };
      }
      case "users": {
        const page = await listUsers(token, b.customerId, {
          query:
            step.which === "active"
              ? "isSuspended=false"
              : step.which === "suspended"
                ? "isSuspended=true"
                : undefined,
          showDeleted: step.which === "deleted",
          pageToken: step.page ?? undefined,
        });
        this.checkCustomer(page.users, b);
        if (step.which !== "deleted") {
          this.guard();
          await bindPage(this.env, page.users, {
            tenant: b.domain,
            allowEmail: false,
            ctx: this.ctx,
            guard: () => this.guard(),
          });
        }
        // By identity: deletions, unsuspensions, new addresses, recycled ids.
        await applyUsers(this.env, page.users, this.applyOpts(token, b));
        if (step.which === "active") run.active += page.users.length;
        step.page = page.nextPageToken;
        if (step.page) return { status: "more", called: true };
        const active = run.active;
        return {
          status: "done",
          called: true,
          tx:
            step.which === "active"
              ? () => this.put("lastActive", active)
              : undefined,
        };
      }
      case "reports": {
        const cursor = this.get<number>(`cursor.${step.app}`);
        const start = (cursor ?? run.startedAt) - OVERLAP_MS;
        const out = await activities(
          token,
          b.customerId,
          step.app,
          start,
          step.page ?? undefined,
        );
        const { keys, dirty, deleted } = this.events(run, step.app, out.events);
        for (const k of keys)
          if (!run.userKeys.includes(k)) run.userKeys.push(k);
        await this.userEvents(run, token, b);
        if (deleted) this.queueDeleted(run);
        if (groups && dirty.length) await this.markDirty(dirty);
        if (
          run.userKeys.length &&
          !run.queue.some((s) => s.kind === "userkeys")
        )
          run.queue.splice(1, 0, { kind: "userkeys" });
        step.page = out.nextPageToken;
        if (step.page) return { status: "more", called: true };
        const app = step.app;
        const at = run.startedAt;
        return {
          status: "done",
          called: true,
          tx: () => this.put(`cursor.${app}`, at),
        };
      }
      case "userkeys": {
        await this.userEvents(run, token, b);
        return {
          status: run.userKeys.length ? "more" : "done",
          called: true,
        };
      }
      case "targets": {
        const found = await this.targets(step.all);
        // The fast lane leaves a group the reconcile is walking to it (and
        // keeps the dirty marks, so it is read again after).
        const walking = new Set(
          run.lane === "fast"
            ? (this.get<Run>("run.rec")?.queue ?? []).flatMap((x) =>
                // Started walks only: one still queued reads the group later.
                x.kind === "walk" && x.had !== null ? [x.target] : [],
              )
            : [],
        );
        const ids = found.ids.filter((id) => !walking.has(id));
        // Clear every mark except those reaching a group left to the
        // reconcile (read again once it is done).
        const keep = new Set(
          found.pairs.filter((x) => walking.has(x.target)).map((x) => x.origin),
        );
        const dirty = found.dirty.filter((d) => !keep.has(d));
        return {
          status: "done",
          called: false,
          replace: ids.map(
            (target): Walk => ({
              kind: "walk",
              target,
              stack: [{ g: target, page: null }],
              visited: [target],
              had: null,
              partial: false,
              missing: false,
            }),
          ),
          // Only the marks read here: a mark added meanwhile stays.
          tx: () => {
            for (const id of dirty)
              this.sql.exec("delete from dirty where group_id = ?", id);
          },
        };
      }
      case "thaw": {
        const more = await thawFrozenEdits(this.env, {
          guard: () => this.guard(),
          now,
          ctx: this.ctx,
          pending: this.owed(),
          revoke: this.revokeLive,
        });
        // One chunk per alarm: a long list never runs past the alarm's
        // subrequest budget.
        return more
          ? { status: "more", called: true }
          : { status: "done", called: false };
      }
      case "walk":
        return this.walk(run, step, token);
      case "finish": {
        await this.succeed(run, now, groups);
        return { status: "done", called: false };
      }
    }
  }

  /** Every listed user must carry the binding's customer id (missing too). */
  private checkCustomer(users: GoogleUser[], b: DirectoryBinding) {
    for (const u of users)
      if (u.customerId !== b.customerId)
        throw new MismatchSignal(u.customerId ?? "");
  }

  private queueDeleted(run: Run) {
    if (!run.queue.some((s) => s.kind === "users" && s.which === "deleted"))
      run.queue.splice(1, 0, { kind: "users", which: "deleted", page: null });
  }

  /** applyUsers' options: epoch-guarded, users.get for a recycled address. */
  private applyOpts(token: string, b: DirectoryBinding) {
    return {
      tenant: b.domain,
      ctx: this.ctx,
      guard: () => this.guard(),
      lookup: async (id: string) => {
        let u: GoogleUser | null;
        try {
          u = await getUser(token, id);
        } catch (e) {
          if (e instanceof GoogleApiError && e.status === 404) return null;
          throw e;
        }
        // Another customer's user (or none): customer_mismatch, fail closed.
        if (u) this.checkCustomer([u], b);
        return u;
      },
    };
  }

  /** One Reports page: the user addresses to re-read and the dirty groups. */
  private events(
    run: Run,
    app: "admin" | "groups",
    events: { name: string; params: Record<string, string> }[],
  ): { keys: string[]; dirty: string[]; deleted: boolean } {
    const keys = new Set<string>();
    const dirty = new Set<string>();
    let deleted = false;
    for (const e of events) {
      const p = e.params;
      if (app === "admin") {
        if (e.name === "SUSPEND_USER" || e.name === "UNSUSPEND_USER") {
          if (p.USER_EMAIL) keys.add(p.USER_EMAIL.toLowerCase());
        } else if (
          e.name === "RENAME_USER" ||
          e.name === "CHANGE_PRIMARY_EMAIL"
        ) {
          // A new primary address: re-read by the new one (the old one is
          // kept as an alias, or gone); applied by identity.
          const to = p.NEW_VALUE?.toLowerCase();
          if (to?.includes("@")) keys.add(to);
          else if (p.USER_EMAIL) keys.add(p.USER_EMAIL.toLowerCase());
        } else if (e.name === "DELETE_USER") deleted = true;
        else if (
          e.name === "ADD_GROUP_MEMBER" ||
          e.name === "REMOVE_GROUP_MEMBER" ||
          e.name === "DELETE_GROUP"
        ) {
          const g = p.GROUP_EMAIL?.toLowerCase();
          if (g) dirty.add(g);
          if (g && e.name === "DELETE_GROUP" && !run.deletedGroups.includes(g))
            run.deletedGroups.push(g);
        }
      } else if (
        e.name === "add_user" ||
        e.name === "remove_user" ||
        e.name === "change_user_role"
      ) {
        const g = p.group_email?.toLowerCase();
        if (g) dirty.add(g);
      }
    }
    return { keys: [...keys], dirty: [...dirty], deleted };
  }

  /**
   * Re-reads up to USER_EVENTS_PER_PAGE event addresses through users.get
   * (the Google id), and applies suspensions by that id only (identities),
   * never by the install's own emails. The rest stay in run.userKeys.
   */
  private async userEvents(run: Run, token: string, b: DirectoryBinding) {
    const batch = run.userKeys.slice(0, USER_EVENTS_PER_PAGE);
    if (!batch.length) return;
    const found: GoogleUser[] = [];
    let deleted = false;
    for (const key of batch) {
      try {
        const u = await getUser(token, key);
        if (u) found.push(u);
      } catch (e) {
        // Gone since the event: the deleted listing handles it.
        if (e instanceof GoogleApiError && e.status === 404) deleted = true;
        else throw e;
      }
    }
    this.checkCustomer(found, b);
    // Suspensions, unsuspensions and address changes, by identity.
    await applyUsers(this.env, found, this.applyOpts(token, b));
    if (deleted) this.queueDeleted(run);
    run.userKeys = run.userKeys.slice(batch.length);
  }

  private async markDirty(emails: string[]) {
    const { results } = await stmt(this.env.DB, GROUP_IDS_BY_EMAIL)
      .bind(JSON.stringify(emails))
      .all<{ group_id: string }>();
    for (const r of results)
      this.sql.exec(
        "insert or ignore into dirty (group_id) values (?)",
        r.group_id,
      );
  }

  /** The groups to walk, and (fast lane) the dirty marks they answer. */
  private async targets(all: boolean): Promise<{
    ids: string[];
    dirty: string[];
    pairs: { origin: string; target: string }[];
  }> {
    if (all) {
      const { results } = await stmt(this.env.DB, TARGETS).all<{
        group_id: string;
      }>();
      return { ids: results.map((r) => r.group_id), dirty: [], pairs: [] };
    }
    const dirty = this.sql
      .exec("select group_id from dirty")
      .toArray()
      .map((r) => String(r.group_id));
    if (!dirty.length) return { ids: [], dirty, pairs: [] };
    const { results } = await stmt(this.env.DB, DIRTY_TARGETS)
      .bind(JSON.stringify(dirty))
      .all<{ origin: string; group_id: string }>();
    const pairs = results.map((r) => ({
      origin: r.origin,
      target: r.group_id,
    }));
    return { ids: [...new Set(pairs.map((x) => x.target))], dirty, pairs };
  }

  /**
   * One members page of a target's tree, or the sweep once its stack is
   * empty. The page's D1 work runs first; the cursor, the stack and the
   * members seen commit together afterwards.
   */
  private async walk(run: Run, w: Walk, token: string): Promise<Done> {
    const lane = run.lane;
    const init = w.had === null;
    const had = init
      ? ((
          await stmt(this.env.DB, COUNT_OF)
            .bind(w.target)
            .first<{ n: number }>()
        )?.n ?? 0)
      : (w.had as number);
    const clearSeen = () =>
      this.sql.exec(
        "delete from seen where lane = ? and target = ?",
        lane,
        w.target,
      );
    const i = w.stack.length - 1;
    const top = w.stack[i];
    if (!top) return this.sweep(run, w, token);
    let page: Awaited<ReturnType<typeof listMembers>>;
    try {
      page = await listMembers(token, top.g, top.page ?? undefined);
    } catch (e) {
      const gone = e instanceof GoogleApiError && e.status === 404;
      if (!gone && !groupRefusal(e)) throw e;
      if (!gone)
        logWarn("directory_group_refused", e, {
          status: (e as GoogleApiError).status,
        });
      w.had = had;
      if (init) w.startedAt = this.now;
      if (top.g === w.target) {
        if (gone) w.missing = true;
        else {
          w.partial = true;
          w.refused = true;
        }
        w.stack = [];
      } else {
        // A nested group vanished or refused mid-walk: this run removes nobody.
        w.partial = true;
        w.stack.splice(i, 1);
      }
      return { status: "more", called: true, tx: init ? clearSeen : undefined };
    }
    const userIds = page.members
      .filter((m) => m.type === "USER")
      .map((m) => m.id);
    const uids: string[] = [];
    for (const ids of chunks(userIds, ID_CHUNK)) {
      const { results } = await stmt(this.env.DB, UIDS_FOR_SUBJECTS)
        .bind(JSON.stringify(ids))
        .all<{ user_id: string }>();
      for (const r of results) uids.push(r.user_id);
    }
    const children = page.members.filter((m) => m.type === "GROUP" && m.email);
    if (children.length) {
      this.guard();
      await this.env.DB.batch(
        children.map((c) =>
          stmt(this.env.DB, UPSERT_CHILD).bind(c.id, c.email, top.g),
        ),
      );
    }
    // D1 done: advance the walk.
    w.had = had;
    if (init) w.startedAt = this.now;
    if (page.nextPageToken) top.page = page.nextPageToken;
    else w.stack.splice(i, 1);
    // A whole-customer member can't be flattened here: removes nobody.
    if (page.members.some((m) => m.type === "CUSTOMER" || m.type === "OTHER"))
      w.partial = true;
    for (const c of children)
      if (!w.visited.includes(c.id)) {
        w.visited.push(c.id);
        w.stack.push({ g: c.id, page: null });
      }
    return {
      status: "more",
      called: true,
      tx: () => {
        if (init) clearSeen();
        for (const uid of uids)
          this.sql.exec(
            "insert or ignore into seen (lane, target, uid) values (?, ?, ?)",
            lane,
            w.target,
            uid,
          );
      },
    };
  }

  /**
   * After a target's last page: adds now, removals unless held. `seen`, the
   * hold rows and the refusal count change only in the commit after every
   * write succeeded. A confirm is consumed by this sweep whatever happens;
   * a click that lands while it runs is kept.
   */
  private async sweep(run: Run, w: Walk, token: string): Promise<Done> {
    const lane = run.lane;
    const now = this.now;
    // Every DO read before the first await: what this sweep decides on can't
    // change under it.
    const seen = new Set(
      this.sql
        .exec(
          "select uid from seen where lane = ? and target = ?",
          lane,
          w.target,
        )
        .toArray()
        .map((r) => String(r.uid)),
    );
    const prior = this.sql
      .exec(
        "select since, kind, would, confirmed_at from held where group_id = ?",
        w.target,
      )
      .toArray()[0];
    const refusedRow = this.sql
      .exec("select runs, since from refused where group_id = ?", w.target)
      .toArray()[0];
    const lastActive = this.get<number>("lastActive");
    const row = await stmt(this.env.DB, GROUP_ROW)
      .bind(w.target)
      .first<{ email: string }>();
    const email = row?.email ?? w.target;
    const { results } = await stmt(this.env.DB, MEMBERS_OF)
      .bind(w.target)
      .all<{ user_id: string; gen: number }>();
    const cur = new Set(results.map((r) => r.user_id));
    // A row added after this walk began (the other lane read the group
    // later) is newer than what this walk saw: never removed by it.
    const begun = w.startedAt ?? run.startedAt;
    const newer = new Set(
      results.filter((r) => Number(r.gen) >= begun).map((r) => r.user_id),
    );
    const d = memberDiff(seen, cur);
    const added = w.missing ? [] : d.added;
    let removed = (w.partial ? [] : w.missing ? [...cur] : d.removed).filter(
      (u) => !newer.has(u),
    );
    const had = w.had ?? cur.size;
    const clicked =
      prior?.confirmed_at === null || prior?.confirmed_at === undefined
        ? null
        : Number(prior.confirmed_at);
    const confirmOk =
      prior?.kind === "sweep" &&
      clicked !== null &&
      now - clicked < CONFIRM_TTL_MS &&
      removed.length <= Number(prior.would);
    let called = false;
    let hold: string | null = null;
    if (removed.length && !confirmOk) {
      if (w.missing && !run.deletedGroups.includes(email)) hold = "group_404";
      else if ((lastActive ?? 1) === 0) hold = "empty_active_listing";
      else if (!w.missing && had >= 5 && removed.length * 2 > had) {
        called = true;
        try {
          const g = await getGroup(token, w.target);
          if (g?.directMembersCount !== 0) hold = "over_half";
        } catch (e) {
          if (!groupRefusal(e)) throw e;
          hold = "over_half";
        }
      }
    }
    // Consecutive reconciles that couldn't read the group.
    const runs =
      lane === "rec"
        ? w.refused
          ? Number(refusedRow?.runs ?? 0) + 1
          : 0
        : Number(refusedRow?.runs ?? 0);
    const refusedSince = refusedRow ? Number(refusedRow.since) : now;
    const unreadable = runs >= CONSECUTIVE_REFUSALS;
    const pre: D1PreparedStatement[] = [];
    const since = prior ? Number(prior.since) : now;
    if (hold) {
      if (!prior)
        pre.push(
          audit(
            this.env,
            "directory.sweep.held",
            { type: "group", id: w.target },
            SYNC,
            {
              detail: { why: hold, wouldRemove: removed.length, members: had },
            },
          ),
        );
      await this.writeHealth((h) => ({
        ...h,
        held: [
          ...h.held.filter((x) => x.groupId !== w.target),
          {
            groupId: w.target,
            email,
            name: email,
            wouldRemove: removed.length,
            members: had,
            since: new Date(since).toISOString(),
          },
        ],
      }));
      logInfo("directory_sweep_held", { why: hold });
    } else if (unreadable) {
      // Surfaced to the owner as a held entry that removes nobody.
      if (prior?.kind !== "unreadable")
        pre.push(
          audit(
            this.env,
            "directory.sweep.held",
            { type: "group", id: w.target },
            SYNC,
            { detail: { why: "unreadable", runs, members: had } },
          ),
        );
      await this.writeHealth((h) => ({
        ...h,
        held: [
          ...h.held.filter((x) => x.groupId !== w.target),
          {
            groupId: w.target,
            email,
            name: email,
            wouldRemove: 0,
            members: had,
            since: new Date(refusedSince).toISOString(),
          },
        ],
      }));
    }
    const wouldRemove = removed.length;
    if (hold) removed = [];
    await this.apply(w.target, added, removed, pre);
    // Released: a sweep that read the whole group and held nothing (or a
    // readable group that was surfaced as unreadable).
    const release =
      !!prior &&
      !hold &&
      ((prior.kind === "sweep" && !w.partial) ||
        (prior.kind === "unreadable" && !w.refused && lane === "rec"));
    if (release)
      await this.writeHealth((h) => ({
        ...h,
        held: h.held.filter((x) => x.groupId !== w.target),
      }));
    return {
      status: "done",
      called,
      tx: () => {
        this.sql.exec(
          "delete from seen where lane = ? and target = ?",
          lane,
          w.target,
        );
        if (lane === "rec") {
          if (runs > 0)
            this.sql.exec(
              `insert into refused (group_id, runs, since) values (?, ?, ?)
                on conflict (group_id) do update set runs = excluded.runs`,
              w.target,
              runs,
              refusedSince,
            );
          else
            this.sql.exec("delete from refused where group_id = ?", w.target);
        }
        // `confirmed_at is ?` keeps a click that landed during this sweep.
        if (hold)
          this.sql.exec(
            `insert into held (group_id, since, kind, would) values (?, ?, 'sweep', ?)
              on conflict (group_id) do update set kind = 'sweep',
                would = excluded.would,
                confirmed_at = case when held.confirmed_at is ? then null
                  else held.confirmed_at end`,
            w.target,
            since,
            wouldRemove,
            clicked,
          );
        else if (unreadable && !release)
          this.sql.exec(
            `insert into held (group_id, since, kind, would) values (?, ?, 'unreadable', 0)
              on conflict (group_id) do update set kind = 'unreadable', would = 0,
                confirmed_at = null`,
            w.target,
            refusedSince,
          );
        else if (release)
          this.sql.exec(
            "delete from held where group_id = ? and confirmed_at is ?",
            w.target,
            clicked,
          );
        else if (clicked !== null)
          this.sql.exec(
            "update held set confirmed_at = null where group_id = ? and confirmed_at is ?",
            w.target,
            clicked,
          );
      },
    };
  }

  /**
   * A group's member diff (applyGroupDiff, T14): directory_members, the
   * restriction flags and the synced space roles in one batch gated on the
   * epoch, then the sockets of the narrowed and newly capped close.
   */
  private async apply(
    groupId: string,
    added: string[],
    removed: string[],
    pre: D1PreparedStatement[],
  ) {
    await applyGroupDiff(this.env, groupId, added, removed, SYNC, {
      pre,
      guard: () => this.guard(),
      now: this.now,
      ctx: this.ctx,
    });
  }

  // ------------------------------------------------------------ health

  /** Writes f(health) when it differs (re-read first: never a stale copy). */
  private async writeHealth(f: (h: Health) => Health) {
    const h = await readHealth(this.env);
    const out = putHealth(this.env, h, f(h));
    if (out.length) {
      this.guard();
      await this.env.DB.batch(out);
    }
  }

  /**
   * A run finished. Frozen (`groups` false) it polled user status but read
   * no group: lastSuccessAt (and staleAt from it) keeps the last run that
   * read groups, and an install that never had one stays "never", not ok
   * (P3 T15).
   */
  private async succeed(run: Run, now: number, groups: boolean) {
    this.guard();
    const lane = run.lane;
    const nextFast = now + FAST_MS;
    const nextRec =
      lane === "rec"
        ? now + RECONCILE_MS
        : (this.get<number>("next.reconcile") ?? now);
    await this.writeHealth((h) => {
      const lanes = { ...h.lanes, [lane]: null };
      const other = lane === "fast" ? lanes.rec : lanes.fast;
      // The other lane still failing: stay unhealthy (banner, email, state).
      if (other !== null) return { ...h, lanes };
      // lastSuccessAt at most hourly while healthy: no write per fast tick.
      const state = groups || h.lastSuccessAt !== null ? "ok" : "never";
      const stamp =
        h.state !== state ||
        (groups &&
          (h.lastSuccessAt === null || now - h.lastSuccessAt >= RECONCILE_MS));
      return {
        ...h,
        state,
        unhealthySince: null,
        lastSuccessAt: stamp && groups ? now : h.lastSuccessAt,
        lastError: null,
        // Frozen: no stamp, but each reconcile still moves the next run (hourly).
        nextRunAt:
          stamp || (!groups && lane === "rec")
            ? Math.min(nextFast, nextRec)
            : h.nextRunAt,
        alertedAt: null,
        customerMismatch: null,
        backoffN: 0,
        failState: null,
        lanes,
        staleAt: null,
      };
    });
    this.storage.transactionSync(() => {
      if (lane === "fast") this.put("next.fast", nextFast);
      else this.put("next.reconcile", nextRec);
      const left = this.reasons().filter((r) => !run.reasons.includes(r));
      this.put("reasons", left);
      for (const k of [`retryAt.${lane}`, `backoff.${lane}`, `failAt.${lane}`])
        this.del(k);
    });
  }

  /** Records a lane's failure (re-reading health); resolves to its retry time. */
  private async fail(lane: Lane, e: SyncError, now: number): Promise<number> {
    const h = await readHealth(this.env);
    this.guard();
    const n =
      e.state === "backoff"
        ? (this.get<number>(`backoff.${lane}`) ?? 0) + 1
        : 0;
    const delay = e.state === "backoff" ? backoffMs(n) : RETRY_HOURLY_MS;
    const retryAt = now + delay;
    if (e.state !== "backoff" || e.code === "google_http_401") this.dropToken();
    this.put(`retryAt.${lane}`, retryAt);
    this.put(`backoff.${lane}`, n);
    this.put(`failAt.${lane}`, now);
    const since = h.unhealthySince ?? now;
    // Audited once per lane per outage (never on every retry).
    const entering = h.lanes[lane] !== e.state;
    let alertedAt = h.alertedAt;
    const why: DirectoryAlert | null =
      e.state === "scope_missing" && entering
        ? "scope_missing"
        : alertedAt === null && now - since >= ALERT_AFTER_MS
          ? "unhealthy"
          : null;
    if (why) alertedAt = now;
    const { h: next, became } = markStale(
      {
        ...h,
        state:
          h.lastSuccessAt === null && e.state === "backoff" ? "never" : e.state,
        unhealthySince: since,
        lastError: { at: now, message: e.code },
        nextRunAt: retryAt,
        alertedAt,
        backoffN: n,
        failState: e.state,
        lanes: { ...h.lanes, [lane]: e.state },
      },
      now,
    );
    this.guard();
    await this.env.DB.batch([
      ...putHealth(this.env, h, next),
      ...(became ? [staleAudit(this.env, next)] : []),
      ...(entering
        ? [
            audit(
              this.env,
              "directory.sync.failed",
              { type: "directory", id: "google" },
              SYNC,
              { detail: { state: e.state, code: e.code, lane } },
            ),
          ]
        : []),
    ]);
    logWarn("directory_sync_failed", e, { state: e.state, lane });
    if (why) {
      this.guard();
      await this.alertOwners(why);
    }
    return retryAt;
  }

  /** A token or listing from another customer (or none): fail closed. */
  private async mismatch(
    expected: string,
    actual: string,
    now: number,
  ): Promise<number> {
    const h = await readHealth(this.env);
    this.guard();
    const entering = h.state !== "customer_mismatch";
    const retryAt = now + RETRY_HOURLY_MS;
    this.storage.transactionSync(() => {
      for (const l of LANES) this.put(`retryAt.${l}`, retryAt);
      this.del("reasons");
      this.del("run.fast");
      this.del("run.rec");
    });
    const { h: next, became } = markStale(
      {
        ...h,
        state: "customer_mismatch",
        unhealthySince: h.unhealthySince ?? now,
        lastError: { at: now, message: "customer_mismatch" },
        nextRunAt: retryAt,
        customerMismatch: { expected, actual },
        alertedAt: entering ? now : h.alertedAt,
        failState: "customer_mismatch",
        lanes: { fast: "customer_mismatch", rec: "customer_mismatch" },
      },
      now,
    );
    this.guard();
    await this.env.DB.batch([
      ...putHealth(this.env, h, next),
      ...(became ? [staleAudit(this.env, next)] : []),
      ...(entering
        ? [
            audit(
              this.env,
              "directory.sync.failed",
              { type: "directory", id: "google" },
              SYNC,
              { detail: { state: "customer_mismatch", expected, actual } },
            ),
          ]
        : []),
    ]);
    logWarn("directory_customer_mismatch");
    if (entering) {
      // Synced users now fail closed (T18: getUser and the content load), so
      // their live sockets close too: one page of revokeFanoutCap here, the
      // rest one page per alarm (tick) until every synced user is signalled.
      // Never guarded: the state committed.
      this.put(CLOSE_KEY, "");
      const ids = await this.syncedPage();
      await revokeUsersLive(this.env, ids ?? [], "directory customer_mismatch");
      this.guard();
      await this.alertOwners("customer_mismatch");
      // A D1 error: back off, then the tick retries the page.
      if (ids === null) return now + BACKOFF_MIN_MS;
    }
    return this.get<string>(CLOSE_KEY) !== null ? now : retryAt;
  }

  /**
   * The next page (revokeFanoutCap, the invocation's subrequest share) of
   * active synced users after the close cursor, advancing it. The cursor is
   * dropped after the last page, and as soon as the state is no longer
   * customer_mismatch (a reconnect, a reset or a success: the query then
   * returns nothing). Null on a D1 error (the cursor stays; the caller backs
   * off and the next alarm retries).
   */
  private async syncedPage(): Promise<string[] | null> {
    const after = this.get<string>(CLOSE_KEY);
    if (after === null) return [];
    const cap = revokeFanoutCap(this.env);
    try {
      const { results } = await stmt(this.env.DB, SYNCED_PAGE)
        .bind(after, cap)
        .all<{ id: string }>();
      const ids = results.map((r) => r.id);
      const last = ids[ids.length - 1];
      if (ids.length < cap || last === undefined) this.del(CLOSE_KEY);
      else this.put(CLOSE_KEY, last);
      return ids;
    } catch (err) {
      logError("directory_mismatch_close", err);
      return null;
    }
  }

  private async alertOwners(why: DirectoryAlert) {
    await alertOwners(this.env, why);
  }
}
