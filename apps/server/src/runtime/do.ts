import { DurableObject } from "cloudflare:workers";
import {
  AGENT_PRESENT_MS,
  type AgentTouch,
  accessChangedCloseReason,
  DATA_LIMIT_DEFAULTS,
  type DataChange,
  DataChangeSchema,
  type DataCount,
  type DataDoc,
  DataNameSchema,
  DataPatchBodySchema,
  type DataQueryInput,
  DataQuerySchema,
  type DataResetResult,
  dailyWritesMessage,
  dataDocTooLargeMessage,
  dataLimits,
  dataResetBodySchema,
  dataResetDocLimit,
  ERROR_CODES,
  type ErrorCode,
  LIMITS,
  type Page,
  PRESENCE_ACTIVITY_MAX,
  PRESENCE_COALESCE_MS,
  PRESENCE_GRACE_MS,
  PRESENCE_NAME_MAX,
  PRESENCE_PING,
  PRESENCE_PONG,
  PRESENCE_STALE_MS,
  PRESENCE_SWEEP_MS,
  type PresenceFrame,
  PresenceKeySchema,
  planOf,
  QUERY_TOO_LARGE_MESSAGE,
  type StorageEntry,
  type StorageKey,
  StorageKeyNameSchema,
  StorageSetBodySchema,
} from "@oa/shared";
import { z } from "zod";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError } from "../log.js";
import { indexVersionOrThrow } from "../services/search.js";
import {
  captureThumbnail,
  serverThumbnails,
  THUMB,
  type ThumbResult,
} from "../services/thumbs.js";
import { presenceStub, SKEW_MS } from "./presence.js";
import {
  type AgentRow,
  buildRoster,
  type Roster,
  type SeatRow,
} from "./roster.js";

// Errors cross the RPC boundary as plain Error (subclass + fields are lost), so the
// code rides in the message: "oa:<code>:<message>". B13 maps it back with toRuntimeApiError.
const ERR_RE = new RegExp(`^oa:(${ERROR_CODES.join("|")}):(.*)$`, "s");

function fail(code: ErrorCode, message: string): never {
  throw new Error(`oa:${code}:${message}`);
}

/** Maps an error thrown by an ArtifactRuntime RPC call to ApiError, or null if it isn't one. */
export function toRuntimeApiError(e: unknown): ApiError | null {
  if (e instanceof ApiError) return e;
  if (!(e instanceof Error)) return null;
  const m = ERR_RE.exec(e.message);
  return m ? new ApiError(m[1] as ErrorCode, m[2] ?? "") : null;
}

/** Awaits a runtime RPC call, rethrowing runtime errors as ApiError. */
export async function runtimeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toRuntimeApiError(e) ?? e;
  }
}

const enc = new TextEncoder();
/**
 * "u:{userId}" | "ip:{ip}" | "ip:{ip}|{anonShort}" | "agent:{userId}", printable
 * ASCII only (no NUL/surrogate collisions).
 */
const ACTOR_RE = /^(u|ip|agent):[\x21-\x7e]{1,250}$/;
/** The "|{anonShort}" suffix of an anonymous writer with a verified anonId. */
const ANON_SUFFIX_RE = /\|([A-Za-z0-9_-]{8})$/;
/**
 * The updatedBy stored and returned for a write: anonymous writers are
 * "anon:{anonShort}" with a verified anonId, else "anon" (the "ip:" part is
 * only the internal rate-limit key, never shown to viewers).
 */
export const publicActor = (actor: string): string => {
  if (!actor.startsWith("ip:")) return actor;
  const m = ANON_SUFFIX_RE.exec(actor);
  return m ? `anon:${m[1]}` : "anon";
};
/** The per-minute rate key: an anonymous writer's IP, whatever its anonId. */
const rateKey = (actor: string): string =>
  actor.startsWith("ip:") ? actor.replace(ANON_SUFFIX_RE, "") : actor;
/**
 * Anonymous writes per IP per artifact per minute: env ANON_WRITES_PER_MIN,
 * an integer clamped to 1..600; unset or not a number -> LIMITS.anonWritesPerMinPerIp.
 */
export function anonWritesPerMin(v: string | undefined): number {
  const t = v?.trim() ?? "";
  if (!/^\d{1,9}$/.test(t)) return LIMITS.anonWritesPerMinPerIp;
  const n = Number(t);
  return Math.min(600, Math.max(1, n));
}
/** Fixed per-row overhead counted toward LIMITS.artifactDataBytes. */
const ROW_OVERHEAD = 64;
/** Broadcasts inline the doc only up to this many bytes; larger docs go out as data:null. */
const BROADCAST_INLINE_BYTES = 16 * 1024;
/** Data-subscribe sockets per DO from signed-in viewers; fetch returns 429 past it. */
const MAX_SOCKETS = 200;
/** Data-subscribe sockets per DO from anonymous (ip:) viewers (their own pool). */
const MAX_ANON_SOCKETS = 100;
/**
 * Data-subscribe sockets per anonymous actor (an IPv4 address or IPv6 /56).
 * A tab holds one socket per subscribed collection: 8 covers a couple of
 * tabs with a few collections each, and it takes 13 networks (not 5) to
 * fill the anonymous pool. Floods never crowd members' pool.
 */
const MAX_ANON_SOCKETS_PER_ACTOR = 8;
/** R.events sockets per DO from signed-in viewers (their own pool). */
const MAX_EVENTS_SOCKETS = 200;
/** R.events sockets per DO from anonymous (ip:) viewers (their own pool). */
const MAX_ANON_EVENTS_SOCKETS = 100;
/** R.events sockets per anonymous actor (an IPv4 address or IPv6 /56). */
const MAX_ANON_EVENTS_PER_ACTOR = 3;
/** Sockets per actor (X-OA-Actor on the upgrade request); fetch returns 429 past it. */
const MAX_SOCKETS_PER_ACTOR = 20;
/** Max socket lifetime: a revocation the server missed can't outlive a signed URL. */
const SOCKET_TTL_MS = LIMITS.signedUrlTtlSec * 1000;
/** The alarm also closes sockets this close to their TTL, batching alarms (≤1/min). */
const SOCKET_TTL_SLACK_MS = 60_000;
/**
 * Search indexing (C3) runs this long after scheduleIndex, from the alarm:
 * a burst of publishes indexes only the newest version, and the alarm runs
 * after the publishing isolate's burst is over.
 */
export const INDEX_DELAY_MS = LIMITS.indexDebounceMs;
/** Index attempts per version before {evt:"index_failed"}. */
export const INDEX_MAX_ATTEMPTS = 5;
/** Retry delay after the n-th failure (1-based): 10 s, 20 s, 40 s, 80 s. */
export const indexBackoffMs = (n: number) => 10_000 * 2 ** (n - 1);
/**
 * Thumbnail runs per version, counted before the browser launches: a run
 * killed for CPU (uncatchable) is retried once, then the version gets none.
 */
export const THUMB_MAX_ATTEMPTS = 2;
/** When a started capture is looked at again if its run never finished. */
export const THUMB_RETRY_MS = 60_000;
/** After a launch error that is not the daily quota: the one retry, an hour on. */
export const THUMB_LAUNCH_BACKOFF_MS = 3_600_000;
/** Header carrying the subscriber's actor from the route to fetch. */
export const ACTOR_HEADER = "X-OA-Actor";
/**
 * Header carrying when the route's authorization ran (ms), required for
 * signed-in ("u:") actors: the accept path awaits UserPresence.touch with it,
 * and closes the socket 4403 when a revocation started at or after it.
 */
export const AUTHZ_AT_HEADER = "X-OA-Authz-At";
/**
 * where/orderBy queries scan and json-decode every doc in the collection, so they are
 * refused (query_too_large) once its tracked byte total (totals.cols[collection]) exceeds
 * this. A ~50 MB scan costs hundreds of ms of CPU; 2 MiB stays near the 10 ms budget.
 * Plain list is unaffected.
 */
const MAX_QUERY_COLLECTION_BYTES = LIMITS.queryCollectionBytes;
/** JSON path of a collection's byte total in totals.cols. */
const colPath = (collection: string) => `$."${collection}"`;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/**
 * The default data/storage writes per artifact per UTC day (DO Free: 100k rows
 * written/day, ≤3 rows per write), tracked in the single totals row. An
 * instance's is dataLimits(env).dailyWrites (DATA_DAILY_WRITES).
 */
export const DAILY_WRITES = DATA_LIMIT_DEFAULTS.free.dailyWrites;
const MAX_CURSOR = 4096;

function dataName(v: unknown, what: string): string {
  const r = DataNameSchema.safeParse(v);
  if (!r.success) fail("bad_request", `invalid ${what}`);
  return r.data;
}

function storageKey(v: unknown): string {
  const r = StorageKeyNameSchema.safeParse(v);
  if (!r.success) fail("bad_request", "invalid key");
  return r.data;
}

function actorOf(v: unknown, what = "actor"): string {
  if (typeof v !== "string" || !ACTOR_RE.test(v))
    fail("bad_request", `invalid ${what}`);
  return v;
}

function limitOf(v: unknown): number {
  if (v === undefined) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT)
    fail("bad_request", "invalid limit");
  return v;
}

/** JSON text of a value and its UTF-8 size, enforcing the plan's data-doc `limit`. */
function serialize(
  v: unknown,
  limit: DocLimit,
): { json: string; bytes: number } {
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    fail("bad_request", "value is not JSON-serializable");
  }
  if (json === undefined) fail("bad_request", "value is not JSON-serializable");
  // UTF-16 length is a lower bound on UTF-8 bytes: skip encoding obviously oversize docs.
  if (json.length > limit.bytes) fail("too_large", limit.message);
  const bytes = enc.encode(json).length;
  if (bytes > limit.bytes) fail("too_large", limit.message);
  return { json, bytes };
}

/** A data doc's (or storage value's) byte limit and its 413 message. */
type DocLimit = { bytes: number; message: string };

/** A raw request body: UTF-8 bytes (preferred: no decode in the Worker) or text. */
export type RawBody = ArrayBuffer | Uint8Array | string;

function decodeBody(body: RawBody): string {
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    fail("bad_request", "body is not UTF-8");
  }
}

/** DataDoc JSON with `data` spliced in from already-serialized text. */
const docJson = (head: DataDoc, json: string): string =>
  JSON.stringify({ ...head, data: null }).replace(
    '"data":null',
    () => `"data":${json}`,
  );

function encodeCursor(c: Record<string, string>): string {
  let bin = "";
  for (const b of enc.encode(JSON.stringify(c))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Strict base64url JSON object whose keys are exactly `keys`, all strings;
 * anything else is bad_request.
 */
function decodeCursor<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Record<K, string> | null {
  // One exact key set: every key is present.
  return decodeCursorOf(raw, [keys]) as Record<K, string> | null;
}

/** decodeCursor accepting any one of several exact key sets. */
function decodeCursorOf<K extends string>(
  raw: unknown,
  shapes: readonly (readonly K[])[],
): Partial<Record<K, string>> | null {
  if (raw === undefined) return null;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_CURSOR ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  )
    fail("bad_request", "invalid cursor");
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const p: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      typeof p === "object" &&
      p !== null &&
      !Array.isArray(p) &&
      shapes.some(
        (keys) =>
          Object.keys(p).length === keys.length &&
          keys.every(
            (k) =>
              Object.hasOwn(p, k) &&
              typeof (p as Record<string, unknown>)[k] === "string",
          ),
      )
    )
      return p as Record<K, string>;
  } catch {
    // fall through
  }
  fail("bad_request", "invalid cursor");
}

/**
 * A query cursor's sort value carried inline up to this many UTF-8 bytes; a
 * longer one is looked up from the anchor doc instead (the cursor's "h" form).
 */
const MAX_CURSOR_SORT_BYTES = 1024;

/** A query sort value: what json_extract (or updated_at) yields. */
type SortValue = string | number | null;

/**
 * The tag/text pair a sort value rides in: t "z" null, "n" a finite number
 * (String(n)), "s" a string. Typed so a cursor can only ever bind a null, a
 * number or a string, never change the query's shape.
 */
function sortTag(v: SortValue): { t: string; v: string } {
  if (v === null) return { t: "z", v: "" };
  if (typeof v === "number") return { t: "n", v: String(v) };
  return { t: "s", v };
}

function sortUntag(t: string, v: string): SortValue {
  if (t === "z" && v === "") return null;
  if (t === "s") return v;
  if (t === "n" && /^-?[0-9][0-9.eE+-]*$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  fail("bad_request", "invalid cursor");
}

/** FNV-1a 32 over UTF-16 units, plus the length: a long sort value's fingerprint. */
function sortHash(v: SortValue): string {
  const { t, v: text } = sortTag(v);
  const s = `${t}:${text}`;
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}.${s.length}`;
}

type DocRow = {
  id: string;
  data: string;
  updated_at: string;
  updated_by: string | null;
};

const toDoc = (r: DocRow): DataDoc => ({
  id: r.id,
  data: JSON.parse(r.data),
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const SCHEMA = `
create table if not exists docs (
  collection text not null, id text not null, data text not null, size integer not null,
  updated_at text not null, updated_by text, primary key (collection, id)
) without rowid;
create index if not exists docs_updated on docs (collection, updated_at, id);
create table if not exists storage (
  viewer text not null, key text not null, data text not null, size integer not null,
  updated_at text not null, primary key (viewer, key)
) without rowid;
create table if not exists totals (
  id integer primary key check (id = 1), bytes integer not null,
  day integer not null, writes integer not null, cols text not null
);
create table if not exists index_job (
  id integer primary key check (id = 1), artifact_id text not null,
  version integer not null, attempts integer not null, due integer not null,
  seq integer not null
);
create table if not exists thumb_job (
  id integer primary key check (id = 1), artifact_id text not null,
  version integer not null, attempts integer not null, due integer not null,
  state text not null
);
create table if not exists access_change (
  id integer primary key check (id = 1), at integer not null
);
create table if not exists viewer_presence_left (
  key text primary key, kind text not null, name text, guest integer not null,
  since integer not null, until integer not null, actor text not null
) without rowid;
create table if not exists viewer_presence_state (
  id integer primary key check (id = 1), hash text not null, sent_at integer not null
);
create table if not exists viewer_presence_agent (
  key text primary key, product text, owner text not null,
  owner_actor text not null, label text, since integer not null,
  seen integer not null, last_write integer, activity text
) without rowid;
`;

/** presence_unbound is logged once per isolate on the accept path. */
let unboundLogged = false;

type SqlParam = string | number | null;
/**
 * Per-socket attachment: connect time (ms); on R.events sockets also whether
 * the viewer may see publisher names (`named`, also carried as a tag), and,
 * once the socket joined viewer presence, its seat `p` (`ping`: the client
 * pings, so it can be swept as stale; `actor`: X-OA-Actor, server-only, for
 * closeActor; never sent to a client).
 */
type SocketMeta = {
  t: number;
  named?: boolean;
  p?: ViewerPresenceSeat;
};
type ViewerPresenceSeat = SeatRow & { ping: boolean; actor: string };
type ViewerPresenceLeftRow = {
  key: string;
  kind: "person" | "anon";
  name: string | null;
  guest: number;
  since: number;
  until: number;
};

/**
 * R.events socket tags. Not DataNames (NAME_RE has no "~"), so they never
 * collide with a data-subscribe collection tag. Every events socket has
 * EVENTS_TAG, one budget-pool tag (signed-in or ip) and one viewer-class tag
 * (named or anon); its per-actor cap tag is "ea:{actor}". Data and events
 * sockets alike also carry "a:{actor}" (closeActor); a data socket's
 * per-actor cap counts its "a:" sockets that are not events sockets.
 */
const EVENTS_TAG = "~ev";
const EVENTS_NAMED_TAG = "~ev:named";
const EVENTS_ANON_TAG = "~ev:anon";
const EVENTS_USER_TAG = "~ev:u";
const EVENTS_IP_TAG = "~ev:ip";
/** Data-subscribe budget-pool tags (signed-in or ip); same "~" rule as above. */
const DATA_USER_TAG = "~d:u";
const DATA_IP_TAG = "~d:ip";
/** Route → DO headers on the events upgrade: the current version and viewer class. */
export const EVENTS_VERSION_HEADER = "X-OA-Version";
export const EVENTS_NAMED_HEADER = "X-OA-Named";
/**
 * Route → DO on the events upgrade: the viewer's presence identity (JSON
 * PresenceIdentity). Absent: the socket is not counted and gets no presence
 * frames (embeds).
 */
export const VIEWER_PRESENCE_HEADER = "X-OA-Viewer-Presence";
/** "1": the client pings, so the alarm may sweep it as stale. */
export const EVENTS_PING_HEADER = "X-OA-Ping";
/**
 * Counted (presence) events sockets carry this tag from accept; a socket is
 * counted only once its attachment also has `p` (it passed both gates).
 */
const VIEWER_PRESENCE_TAG = "~vp";
const ViewerPresenceIdentitySchema = z.strictObject({
  key: PresenceKeySchema,
  kind: z.enum(["person", "anon"]),
  // Cleaned (cut to PRESENCE_NAME_MAX) by buildRoster; bounded here so the
  // attachment stays under its 2 KiB cap.
  name: z
    .string()
    .max(PRESENCE_NAME_MAX * 4)
    .nullable(),
  guest: z.boolean(),
});
/** touchViewerAgent's arg, bounded (cleaned again by buildRoster). */
const AgentTouchSchema = z.strictObject({
  key: PresenceKeySchema,
  product: z
    .string()
    .max(PRESENCE_NAME_MAX * 4)
    .nullable(),
  owner: z.string().max(PRESENCE_NAME_MAX * 4),
  ownerActor: z.string().regex(/^u:[\x21-\x7e]{1,250}$/),
  label: z
    .string()
    .max(PRESENCE_NAME_MAX * 4)
    .nullable(),
  write: z.boolean(),
  activity: z
    .string()
    .max(PRESENCE_ACTIVITY_MAX * 4)
    .nullable(),
});
/** Agent rows one person can hold on an artifact (oldest seen dropped first). */
const MAX_VIEWER_AGENTS_PER_OWNER = 20;
type ViewerAgentDbRow = {
  key: string;
  product: string | null;
  owner: string;
  owner_actor: string;
  label: string | null;
  since: number;
  seen: number;
  last_write: number | null;
  activity: string | null;
};

/** Why R.events sockets get `gone`: a soft delete, or any other access change. */
export type GoneReason = "deleted" | "changed";
const GONE_DELETED = '{"type":"gone","reason":"deleted"}';
const GONE_CHANGED = '{"type":"gone","reason":"changed"}';
/**
 * Margin on a stale socket's retryAfterMs: the reconnect must be authorized
 * after accessChangedAt + SKEW_MS, or it is refused again.
 */
const STALE_RETRY_MARGIN_MS = 250;

/** A new version, broadcast to R.events sockets by scheduleIndex. */
export type VersionEvent = {
  at: string;
  by: { kind: "user" | "agent"; name: string | null };
  restoredFrom?: number;
};

/**
 * Per-artifact live-page data (spec §6.7): shared docs, per-viewer storage, and a
 * hibernating WebSocket feed per collection. No auth here: callers (B13) authorize
 * and pass the actor ("u:{id}" | "ip:{ip}" | "ip:{ip}|{anonShort}" | "agent:{id}").
 */
export class ArtifactRuntime extends DurableObject<Env> {
  private ready = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Presence pings are answered without waking the DO (data sockets too:
    // harmless). The answer's time is the stale sweep's liveness signal.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PRESENCE_PING, PRESENCE_PONG),
    );
  }

  /** The instance's data-doc limit (env PLAN, DATA_DOC_BYTES). */
  private get docLimit(): DocLimit {
    const { plan, docBytes } = dataLimits(this.env);
    return { bytes: docBytes, message: dataDocTooLargeMessage(plan, docBytes) };
  }

  /** Clock; overridable in tests. */
  now: () => number = () => Date.now();

  /** The search indexer the alarm runs; overridable in tests. */
  indexer: (
    env: Pick<Env, "DB" | "FILES">,
    artifactId: string,
    version: number,
  ) => Promise<void> = indexVersionOrThrow;

  /** The thumbnail capture the alarm runs; overridable in tests. */
  thumbnailer: (
    env: Env,
    artifactId: string,
    version: number,
  ) => Promise<ThumbResult> = captureThumbnail;

  /**
   * Creates the schema (and migrates pre-M2 tables) outside any transaction:
   * called before every transactionSync, since a rollback there would undo the
   * DDL while `ready` stays true.
   */
  private ensureSchema(): void {
    void this.sql;
  }

  private get sql(): SqlStorage {
    if (!this.ready) {
      const sql = this.ctx.storage.sql;
      // Pre-M2 DOs: a meta (k, v) table ('bytes', 'c:<name>') and a writes table.
      const legacy =
        sql
          .exec(
            "select 1 from sqlite_master where type = 'table' and name = 'meta'",
          )
          .toArray().length > 0;
      sql.exec(SCHEMA);
      if (legacy)
        sql.exec(`insert or ignore into totals (id, bytes, day, writes, cols)
          select 1, coalesce((select v from meta where k = 'bytes'), 0), 0, 0,
            coalesce((select json_group_object(substr(k, 3), v) from meta where k like 'c:%'), '{}');
          drop table meta; drop table if exists writes;`);
      sql.exec(
        "insert or ignore into totals (id, bytes, day, writes, cols) values (1, 0, 0, 0, '{}')",
      );
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }

  /** Total stored bytes (docs + storage), as tracked in the totals row. */
  totalBytes(): number {
    return this.sql
      .exec<{ bytes: number }>("select bytes from totals where id = 1")
      .one().bytes;
  }

  /** Writes per actor in the current minute; in memory (reset on eviction), never in SQLite. */
  private rate = new Map<string, number>();
  private rateMinute = -1;

  /** Counts one write for `actor` this minute; throws rate_limited past the cap. */
  private countWrite(actor: string): void {
    const minute = Math.floor(this.now() / MINUTE_MS);
    if (minute !== this.rateMinute) {
      this.rate.clear();
      this.rateMinute = minute;
    }
    const key = rateKey(actor);
    const n = (this.rate.get(key) ?? 0) + 1;
    this.rate.set(key, n);
    const cap = key.startsWith("ip:")
      ? anonWritesPerMin(this.env.ANON_WRITES_PER_MIN)
      : LIMITS.viewerWritesPerMin;
    if (n > cap) fail("rate_limited", "too many writes; try again in a minute");
  }

  /**
   * One write's bookkeeping, inside the write's transaction, as ONE row: the
   * totals row holds the artifact's bytes, today's write count (429 past
   * dataLimits(env).dailyWrites) and per-collection bytes (`cols`, JSON). With the doc row and
   * its index entry that is ≤3 rows written per data write.
   */
  private bump(delta: number, collection?: string): void {
    const day = Math.floor(this.now() / DAY_MS);
    const col = collection !== undefined && delta !== 0;
    // Collection names are [A-Za-z0-9_-]: safe inside a quoted JSON path.
    const { bytes, writes } = this.sql
      .exec<{ bytes: number; writes: number }>(
        `update totals set bytes = bytes + ?,
           writes = case when day = ? then writes + 1 else 1 end, day = ?
           ${col ? ", cols = json_set(cols, ?, coalesce(json_extract(cols, ?), 0) + ?)" : ""}
         where id = 1 returning bytes, writes`,
        delta,
        day,
        day,
        ...(col ? [colPath(collection), colPath(collection), delta] : []),
      )
      .one();
    const { dailyWrites } = dataLimits(this.env);
    if (writes > dailyWrites)
      fail("rate_limited", dailyWritesMessage(dailyWrites));
    if (delta > 0 && bytes > LIMITS.artifactDataBytes)
      fail("too_large", "artifact data exceeds 50 MB");
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Sends one pre-serialized message to every socket tagged `collection`. */
  private broadcast(collection: string, msg: string): void {
    for (const ws of this.ctx.getWebSockets(collection)) {
      try {
        ws.send(msg);
      } catch {
        // closing socket
      }
    }
  }

  /**
   * Upsert broadcast, serialized once per write. Docs over 16 KB go out with
   * `data: null`; subscribers (B13 runtime) must refetch the doc when data is null.
   */
  private broadcastDoc(doc: DataDoc, json: string, collection: string): void {
    const envelope: DataChange = DataChangeSchema.parse({
      type: "db.change",
      collection,
      docs: [{ ...doc, data: null }],
      deleted: [],
    });
    let msg = JSON.stringify(envelope);
    // Splice the already-serialized data in place of the null placeholder.
    if (
      json.length <= BROADCAST_INLINE_BYTES &&
      enc.encode(json).length <= BROADCAST_INLINE_BYTES
    )
      msg = msg.replace('"data":null', () => `"data":${json}`);
    this.broadcast(collection, msg);
  }

  private readDoc(collection: string, id: string): DocRow | null {
    return (
      this.sql
        .exec<DocRow>(
          "select id, data, updated_at, updated_by from docs where collection = ? and id = ?",
          collection,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  /** Upserts pre-serialized doc JSON; returns updatedAt. Broadcasts. */
  private writeJson(
    collection: string,
    id: string,
    json: string,
    bytes: number,
    actor: string,
  ): string {
    const by = publicActor(actor);
    const size =
      bytes + collection.length + id.length + by.length + ROW_OVERHEAD;
    const updatedAt = this.iso();
    this.countWrite(actor);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "select size from docs where collection = ? and id = ?",
          collection,
          id,
        )
        .toArray()[0];
      this.bump(size - (old?.size ?? 0), collection);
      this.sql.exec(
        "insert into docs (collection, id, data, size, updated_at, updated_by) values (?, ?, ?, ?, ?, ?) on conflict (collection, id) do update set data = excluded.data, size = excluded.size, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
        collection,
        id,
        json,
        size,
        updatedAt,
        by,
      );
    });
    this.broadcastDoc(
      { id, data: null, updatedAt, updatedBy: by },
      json,
      collection,
    );
    return updatedAt;
  }

  private writeDoc(
    collection: string,
    id: string,
    data: unknown,
    actor: string,
  ): { doc: DataDoc; json: string } {
    const { json, bytes } = serialize(data, this.docLimit);
    const updatedAt = this.writeJson(collection, id, json, bytes, actor);
    // The caller's value (already a structured-clone copy) is returned as-is: no re-parse.
    return {
      doc: { id, data, updatedAt, updatedBy: publicActor(actor) },
      json,
    };
  }

  /**
   * Validates raw JSON text with SQLite's json_valid (one C pass; RFC 8259;
   * nesting capped at 1000) and returns it unchanged with its UTF-8 size.
   * Too deep or malformed → bad_request; over the plan's doc limit → too_large.
   */
  private rawJson(body: RawBody): { json: string; bytes: number } {
    const bytes =
      typeof body === "string" ? enc.encode(body).length : body.byteLength;
    if (bytes > this.docLimit.bytes) fail("too_large", this.docLimit.message);
    const json = decodeBody(body);
    let ok = 0;
    try {
      ok = this.sql
        .exec<{ ok: number }>("select json_valid(?) as ok", json)
        .one().ok;
    } catch {
      ok = 0;
    }
    if (ok !== 1) fail("bad_request", "invalid JSON");
    return { json, bytes };
  }

  get(collection: string, id: string, touch?: AgentTouch): DataDoc | null {
    const row = this.readDoc(
      dataName(collection, "collection"),
      dataName(id, "id"),
    );
    this.viewerAgentTouched(touch, false);
    return row ? toDoc(row) : null;
  }

  /**
   * Docs in the collection. A covering scan of the primary key range
   * (collection, id) (EXPLAIN QUERY PLAN: "SEARCH docs USING ... INDEX ...
   * (collection=?)"); no doc bodies are read.
   */
  count(collection: string, touch?: AgentTouch): DataCount {
    const c = dataName(collection, "collection");
    const out = {
      count: this.sql
        .exec<{ n: number }>(
          "select count(*) as n from docs where collection = ?",
          c,
        )
        .one().n,
    };
    this.viewerAgentTouched(touch, false);
    return out;
  }

  /** Docs in (updated_at, id) order, keyset-paginated. */
  list(
    collection: string,
    cursor?: string,
    limit?: number,
    touch?: AgentTouch,
  ): Page<DataDoc> {
    const c = dataName(collection, "collection");
    const n = limitOf(limit);
    const cur = decodeCursor(cursor, ["u", "i"] as const);
    const params: SqlParam[] = cur
      ? [c, cur.u, cur.u, cur.i, n + 1]
      : [c, n + 1];
    const rows = this.sql
      .exec<DocRow>(
        `select id, data, updated_at, updated_by from docs where collection = ?
         ${cur ? "and (updated_at > ? or (updated_at = ? and id > ?))" : ""}
         order by updated_at, id limit ?`,
        ...params,
      )
      .toArray();
    const items = rows.slice(0, n);
    const last = items[items.length - 1];
    this.viewerAgentTouched(touch, false);
    return {
      items: items.map(toDoc),
      nextCursor:
        rows.length > n && last
          ? encodeCursor({ u: last.updated_at, i: last.id })
          : null,
    };
  }

  /** Typed equality filter, ordered by (orderBy value | updated_at, id), keyset-paginated. */
  query(
    collection: string,
    q: DataQueryInput,
    touch?: AgentTouch,
  ): Page<DataDoc> {
    const c = dataName(collection, "collection");
    const parsed = DataQuerySchema.safeParse(q ?? {});
    if (!parsed.success) fail("bad_request", "invalid query");
    const { where, orderBy, order, limit, cursor } = parsed.data;
    // The cursor carries the last doc's id and sort value (t/v) plus the ordering it
    // belongs to, so a later write to that doc can't move the page boundary. A sort value
    // over MAX_CURSOR_SORT_BYTES rides as a fingerprint (h) plus the doc's updated_at (u)
    // instead: it is looked up again, and any change to that doc is 409 cursor_stale.
    // The where filter is applied on every page, so a forged cursor only moves the
    // start position inside the filtered set.
    const cur = decodeCursorOf(cursor, [
      ["i", "o", "d", "t", "v"],
      ["i", "o", "d", "u", "h"],
    ] as const);
    if (cur && (cur.o !== (orderBy ?? "") || cur.d !== order))
      fail("bad_request", "cursor does not match query");
    if (where || orderBy) {
      const bytes = this.sql
        .exec<{ v: number }>(
          "select coalesce(json_extract(cols, ?), 0) as v from totals where id = 1",
          colPath(c),
        )
        .one().v;
      if (bytes > MAX_QUERY_COLLECTION_BYTES)
        fail("query_too_large", QUERY_TOO_LARGE_MESSAGE);
    }

    // Keys are schema-validated identifiers, and are still only ever bound as '$.' || ? params.
    const conds: string[] = ["collection = ?"];
    const params: SqlParam[] = [c];
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v === null) {
        conds.push("json_type(data, '$.' || ?) = 'null'");
        params.push(k);
      } else if (typeof v === "boolean") {
        conds.push(`json_type(data, '$.' || ?) = '${v ? "true" : "false"}'`);
        params.push(k);
      } else if (typeof v === "number") {
        conds.push(
          "json_type(data, '$.' || ?) in ('integer', 'real') and json_extract(data, '$.' || ?) = ?",
        );
        params.push(k, k, v);
      } else {
        conds.push(
          "json_type(data, '$.' || ?) = 'text' and json_extract(data, '$.' || ?) = ?",
        );
        params.push(k, k, v);
      }
    }

    // SQLite orders NULL < numbers < text, consistently for ORDER BY and comparisons.
    const sv = orderBy ? "json_extract(data, '$.' || ?)" : "updated_at";
    const svp: SqlParam[] = orderBy ? [orderBy] : [];
    const desc = order === "desc";
    if (cur) {
      let v: SortValue;
      if (cur.t !== undefined && cur.v !== undefined) {
        v = sortUntag(cur.t, cur.v);
      } else {
        const anchor = this.sql
          .exec<{ v: SqlStorageValue; u: string }>(
            `select ${sv} as v, updated_at as u from docs where collection = ? and id = ?`,
            ...svp,
            c,
            cur.i ?? "",
          )
          .toArray()[0];
        const av = anchor?.v;
        if (
          !anchor ||
          (av !== null && typeof av !== "number" && typeof av !== "string") ||
          anchor.u !== cur.u ||
          sortHash(av) !== cur.h
        )
          fail(
            "cursor_stale",
            "The data changed while paging. Restart the query without a cursor.",
          );
        v = av;
      }
      const id = cur.i ?? "";
      const op = desc ? "<" : ">";
      if (v === null) {
        // NULLs come first ascending, last descending.
        if (desc) {
          conds.push(`(${sv} is null and id < ?)`);
          params.push(...svp, id);
        } else {
          conds.push(`((${sv} is null and id > ?) or ${sv} is not null)`);
          params.push(...svp, id, ...svp);
        }
      } else {
        conds.push(
          `(${sv} ${op} ? or (${sv} = ? and id ${op} ?)${desc ? ` or ${sv} is null` : ""})`,
        );
        params.push(...svp, v, ...svp, v, id, ...(desc ? svp : []));
      }
    }
    const dir = desc ? "desc" : "asc";
    const rows = this.sql
      .exec<DocRow & { sv: SqlStorageValue }>(
        `select id, data, updated_at, updated_by, ${sv} as sv from docs
         where ${conds.join(" and ")} order by sv ${dir}, id ${dir} limit ?`,
        ...svp,
        ...params,
        limit + 1,
      )
      .toArray();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    let nextCursor: string | null = null;
    if (rows.length > limit && last) {
      const lv = last.sv;
      if (lv !== null && typeof lv !== "number" && typeof lv !== "string")
        fail("internal", "unexpected sort value");
      const base = { i: last.id, o: orderBy ?? "", d: order };
      // Judged on the encoded cursor, not the value's bytes: JSON escapes a
      // control character to 6 bytes, so a short value can still overflow
      // MAX_CURSOR and be refused when it comes back.
      const inline =
        typeof lv === "string" && enc.encode(lv).length > MAX_CURSOR_SORT_BYTES
          ? null
          : encodeCursor({ ...base, ...sortTag(lv) });
      nextCursor =
        inline !== null && inline.length <= MAX_CURSOR
          ? inline
          : encodeCursor({ ...base, u: last.updated_at, h: sortHash(lv) });
    }
    this.viewerAgentTouched(touch, false);
    return { items: items.map(toDoc), nextCursor };
  }

  set(
    collection: string,
    id: string,
    data: unknown,
    actor: string,
    touch?: AgentTouch,
  ): DataDoc {
    const { doc } = this.writeDoc(
      dataName(collection, "collection"),
      dataName(id, "id"),
      data,
      actorOf(actor),
    );
    this.viewerAgentTouched(touch, true);
    return doc;
  }

  /**
   * set() from the raw request body (UTF-8 bytes or text): validated here,
   * never parsed in the Worker, and stored as sent. Returns updatedAt; the
   * caller already holds the rest of the DataDoc (id, body, actor).
   */
  setRaw(
    collection: string,
    id: string,
    body: RawBody,
    actor: string,
    touch?: AgentTouch,
  ): { updatedAt: string } {
    const c = dataName(collection, "collection");
    const i = dataName(id, "id");
    const a = actorOf(actor);
    const { json, bytes } = this.rawJson(body);
    const updatedAt = this.writeJson(c, i, json, bytes, a);
    this.viewerAgentTouched(touch, true);
    return { updatedAt };
  }

  /** Shallow merge into the doc (non-object docs are replaced); a missing doc is created. */
  update(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    actor: string,
    touch?: AgentTouch,
  ): DataDoc {
    const { doc } = this.merge(collection, id, patch, actor);
    this.viewerAgentTouched(touch, true);
    return doc;
  }

  /** update() from the raw request body; returns the DataDoc as JSON text. */
  updateRaw(
    collection: string,
    id: string,
    body: RawBody,
    actor: string,
    touch?: AgentTouch,
  ): string {
    const { json } = this.rawJson(body);
    const { doc, json: data } = this.merge(
      collection,
      id,
      JSON.parse(json) as Record<string, unknown>,
      actor,
    );
    this.viewerAgentTouched(touch, true);
    return docJson({ ...doc, data: null }, data);
  }

  private merge(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    actor: string,
  ): { doc: DataDoc; json: string } {
    const c = dataName(collection, "collection");
    const i = dataName(id, "id");
    const a = actorOf(actor);
    const p = DataPatchBodySchema.safeParse(patch);
    if (!p.success) fail("bad_request", "invalid patch");
    const row = this.readDoc(c, i);
    const old: unknown = row ? JSON.parse(row.data) : null;
    const base =
      old !== null && typeof old === "object" && !Array.isArray(old)
        ? (old as Record<string, unknown>)
        : {};
    return this.writeDoc(c, i, { ...base, ...p.data }, a);
  }

  delete(
    collection: string,
    id: string,
    actor: string,
    touch?: AgentTouch,
  ): void {
    const c = dataName(collection, "collection");
    const i = dataName(id, "id");
    const a = actorOf(actor);
    let existed = false;
    this.countWrite(a);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "delete from docs where collection = ? and id = ? returning size",
          c,
          i,
        )
        .toArray()[0];
      existed = old !== undefined;
      this.bump(-(old?.size ?? 0), c);
    });
    this.viewerAgentTouched(touch, true);
    if (existed)
      this.broadcast(
        c,
        JSON.stringify(
          DataChangeSchema.parse({
            type: "db.change",
            collection: c,
            docs: [],
            deleted: [i],
          }),
        ),
      );
  }

  /**
   * Replaces ALL data docs with the snapshot in `body` (raw DataResetBody JSON,
   * capped by the route), in one transaction: any error leaves the old data.
   * Per-viewer storage is untouched. Counts as one write for `actor`'s per-minute
   * rate, not toward DAILY_WRITES (an owner reset must not be locked out by
   * viewers' writes). Afterwards every subscriber socket is closed (1012), so
   * each live viewer reconnects and its shell emits db.resync.
   */
  replaceRaw(body: RawBody, actor: string): DataResetResult {
    const a = actorOf(actor);
    let raw: unknown;
    try {
      raw = JSON.parse(decodeBody(body));
    } catch (e) {
      if (e instanceof Error && ERR_RE.test(e.message)) throw e;
      fail("bad_request", "invalid JSON");
    }
    const p = dataResetBodySchema(
      dataResetDocLimit(planOf(this.env.PLAN)),
    ).safeParse(raw);
    if (!p.success)
      fail(
        "bad_request",
        `invalid data reset: ${p.error.issues[0]?.message ?? "bad body"}`,
      );
    const by = publicActor(a);
    const updatedAt = this.iso();
    const rows: [string, string, string, number][] = [];
    const cols = new Map<string, number>();
    // Each doc has the instance's effective per-doc limit (DATA_DOC_BYTES).
    const docLimit = this.docLimit;
    for (const [col, docs] of Object.entries(p.data.collections)) {
      let total = 0;
      for (const [id, data] of Object.entries(docs)) {
        const { json, bytes } = serialize(data, docLimit);
        const size = bytes + col.length + id.length + by.length + ROW_OVERHEAD;
        rows.push([col, id, json, size]);
        total += size;
      }
      cols.set(col, total);
    }
    const added = [...cols.values()].reduce((n, b) => n + b, 0);
    this.countWrite(a);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const removed = this.sql
        .exec<{ n: number }>("select coalesce(sum(size), 0) as n from docs")
        .one().n;
      this.sql.exec("delete from docs");
      // One statement for all rows (an exec per row costs ~10 µs of CPU each).
      if (rows.length > 0)
        this.sql.exec(
          `insert into docs (collection, id, data, size, updated_at, updated_by)
           select value ->> 0, value ->> 1, value ->> 2, value ->> 3, ?, ?
           from json_each(?)`,
          updatedAt,
          by,
          JSON.stringify(rows),
        );
      const { bytes } = this.sql
        .exec<{ bytes: number }>(
          "update totals set bytes = bytes - ? + ?, cols = ? where id = 1 returning bytes",
          removed,
          added,
          JSON.stringify(Object.fromEntries(cols)),
        )
        .one();
      if (bytes > LIMITS.artifactDataBytes)
        fail("too_large", "artifact data exceeds 50 MB");
    });
    for (const ws of this.ctx.getWebSockets()) {
      // R.events sockets carry versions, not data: a reset leaves them open.
      if (this.ctx.getTags(ws).includes(EVENTS_TAG)) continue;
      try {
        ws.close(1012, "data reset");
      } catch {
        // already closed
      }
    }
    return { collections: cols.size, docs: rows.length, updatedAt };
  }

  storageGet(viewer: string, key: string): unknown | null {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    const row = this.sql
      .exec<{ data: string }>(
        "select data from storage where viewer = ? and key = ?",
        v,
        k,
      )
      .toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }

  /** The viewer's entry with its timestamp, or null (a stored null is an entry). */
  storageEntry(viewer: string, key: string): StorageEntry | null {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    const row = this.sql
      .exec<{ data: string; updated_at: string }>(
        "select data, updated_at from storage where viewer = ? and key = ?",
        v,
        k,
      )
      .toArray()[0];
    return row
      ? { key: k, value: JSON.parse(row.data), updatedAt: row.updated_at }
      : null;
  }

  /** Per-viewer value; counts against the viewer's write rate and the artifact's byte total. */
  storageSet(viewer: string, key: string, value: unknown): StorageEntry {
    return this.storageWrite(viewer, key, value).entry;
  }

  /** storageSet() from the raw StorageSetBody; returns the StorageEntry as JSON text. */
  storageSetRaw(viewer: string, key: string, body: RawBody): string {
    const { json } = this.rawJson(body);
    const r = StorageSetBodySchema.safeParse(JSON.parse(json));
    if (!r.success) fail("bad_request", "invalid body");
    const { entry, json: value } = this.storageWrite(viewer, key, r.data.value);
    return JSON.stringify({ ...entry, value: null }).replace(
      '"value":null',
      () => `"value":${value}`,
    );
  }

  private storageWrite(
    viewer: string,
    key: string,
    value: unknown,
  ): { entry: StorageEntry; json: string } {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    const { json, bytes } = serialize(value, this.docLimit);
    const size = bytes + v.length + k.length + ROW_OVERHEAD;
    const updatedAt = this.iso();
    this.countWrite(v);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "select size from storage where viewer = ? and key = ?",
          v,
          k,
        )
        .toArray()[0];
      this.bump(size - (old?.size ?? 0));
      this.sql.exec(
        "insert into storage (viewer, key, data, size, updated_at) values (?, ?, ?, ?, ?) on conflict (viewer, key) do update set data = excluded.data, size = excluded.size, updated_at = excluded.updated_at",
        v,
        k,
        json,
        size,
        updatedAt,
      );
    });
    return { entry: { key: k, value, updatedAt }, json };
  }

  storageDelete(viewer: string, key: string): void {
    const v = actorOf(viewer, "viewer");
    const k = storageKey(key);
    this.countWrite(v);
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const old = this.sql
        .exec<{ size: number }>(
          "delete from storage where viewer = ? and key = ? returning size",
          v,
          k,
        )
        .toArray()[0];
      this.bump(-(old?.size ?? 0));
    });
  }

  /** The viewer's keys in key order, keyset-paginated. */
  storageList(
    viewer: string,
    cursor?: string,
    limit?: number,
  ): Page<StorageKey> {
    const v = actorOf(viewer, "viewer");
    const n = limitOf(limit);
    const cur = decodeCursor(cursor, ["k"] as const);
    const params: SqlParam[] = cur ? [v, cur.k, n + 1] : [v, n + 1];
    const rows = this.sql
      .exec<{ key: string; updated_at: string }>(
        `select key, updated_at from storage where viewer = ? ${cur ? "and key > ?" : ""} order by key limit ?`,
        ...params,
      )
      .toArray();
    const items = rows.slice(0, n);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({ key: r.key, updatedAt: r.updated_at })),
      nextCursor:
        rows.length > n && last ? encodeCursor({ k: last.key }) : null,
    };
  }

  /**
   * WebSocket upgrades, tagged for hibernation:
   * - `/events`: R.events (EVENTS_TAG); hello with EVENTS_VERSION_HEADER.
   * - otherwise data subscribe: `?collection=<DataName>`.
   */
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    const url = new URL(req.url);
    const actor = req.headers.get(ACTOR_HEADER);
    if (actor !== null && !ACTOR_RE.test(actor))
      return new Response("Invalid actor", { status: 400 });
    // Signed-in sockets are recorded in the user's presence (revocation).
    const userId = actor?.startsWith("u:") ? actor.slice(2) : null;
    const rawAt = req.headers.get(AUTHZ_AT_HEADER);
    const authzAt = Number(rawAt ?? Number.NaN);
    const validAt = Number.isSafeInteger(authzAt) && authzAt >= 1;
    // Required for signed-in actors; the route sends it for every actor.
    if ((userId !== null || rawAt !== null) && !validAt)
      return new Response("Missing authorization time", { status: 400 });
    let tags: string[];
    let version = 0;
    let named: boolean | undefined;
    let who: z.infer<typeof ViewerPresenceIdentitySchema> | null = null;
    if (url.pathname === "/events") {
      const v = Number(req.headers.get(EVENTS_VERSION_HEADER));
      if (!Number.isSafeInteger(v) || v < 1)
        return new Response("Invalid version", { status: 400 });
      const rawWho = req.headers.get(VIEWER_PRESENCE_HEADER);
      if (rawWho !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawWho);
        } catch {
          parsed = null;
        }
        const r = ViewerPresenceIdentitySchema.safeParse(parsed);
        if (!r.success)
          return new Response("Invalid viewer presence", { status: 400 });
        who = r.data;
      }
      // Own budgets, apart from data sockets: anonymous (ip:) actors share a
      // smaller pool and get 3 sockets each, so they starve neither live
      // data nor signed-in viewers' events.
      // The route always passes an actor ("u:{id}" or "ip:{v4 or /56}"):
      // without one the per-actor cap couldn't apply, so refuse.
      if (actor === null) return new Response("Missing actor", { status: 400 });
      const anon = actor.startsWith("ip:");
      const pool = anon ? EVENTS_IP_TAG : EVENTS_USER_TAG;
      if (
        this.ctx.getWebSockets(pool).length >=
        (anon ? MAX_ANON_EVENTS_SOCKETS : MAX_EVENTS_SOCKETS)
      )
        return new Response("Too many subscribers", { status: 429 });
      named = req.headers.get(EVENTS_NAMED_HEADER) === "1";
      tags = [EVENTS_TAG, pool, named ? EVENTS_NAMED_TAG : EVENTS_ANON_TAG];
      const tag = `ea:${actor}`;
      if (
        this.ctx.getWebSockets(tag).length >=
        (anon ? MAX_ANON_EVENTS_PER_ACTOR : MAX_SOCKETS_PER_ACTOR)
      )
        return new Response("Too many subscriptions", { status: 429 });
      tags.push(tag, `a:${actor}`);
      // Tags are fixed at accept; membership waits for `p` (both gates).
      if (who) tags.push(VIEWER_PRESENCE_TAG);
      version = v;
    } else {
      const r = DataNameSchema.safeParse(url.searchParams.get("collection"));
      if (!r.success)
        return new Response("Invalid collection", { status: 400 });
      // The route always passes the authorized actor; without one there is
      // no per-actor cap to apply, so refuse rather than skip it.
      if (actor === null) return new Response("Missing actor", { status: 400 });
      // Anonymous (ip:) actors get their own smaller pool, so a flood from
      // many addresses can't lock members out of live data.
      const anon = actor.startsWith("ip:");
      const pool = anon ? DATA_IP_TAG : DATA_USER_TAG;
      if (
        this.ctx.getWebSockets(pool).length >=
        (anon ? MAX_ANON_SOCKETS : MAX_SOCKETS)
      )
        return new Response("Too many subscribers", { status: 429 });
      const tag = `a:${actor}`;
      // Events sockets also carry "a:" (closeActor): count data sockets only.
      const held = this.ctx
        .getWebSockets(tag)
        .filter((ws) => !this.ctx.getTags(ws).includes(EVENTS_TAG)).length;
      if (held >= (anon ? MAX_ANON_SOCKETS_PER_ACTOR : MAX_SOCKETS_PER_ACTOR))
        return new Response("Too many subscriptions", { status: 429 });
      tags = [r.data, pool, tag];
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tags);
    const t = this.now();
    pair[1].serializeAttachment(
      (named === undefined ? { t } : { t, named }) satisfies SocketMeta,
    );
    await this.armAt(t + SOCKET_TTL_MS);
    // Authorized before this artifact's last access change (closeSockets):
    // the check may have seen the old access, so refuse (any actor).
    const changed = this.accessChangedAt();
    const stale = validAt && changed !== null && authzAt <= changed + SKEW_MS;
    // Accepted (and tagged) before touch, so a closeActor that runs while
    // touch is in flight finds it; a touch after the revocation started is
    // refused, and the socket closes here.
    if (
      stale ||
      (userId !== null && !(await this.touchPresence(userId, authzAt)))
    ) {
      // A stale socket (authorized inside the skew window of an access change)
      // is told when a reconnect will pass, so the client backs off once
      // instead of looping refused reconnects until the window ends.
      const retry =
        stale && changed !== null
          ? Math.min(
              SKEW_MS + STALE_RETRY_MARGIN_MS,
              Math.max(
                STALE_RETRY_MARGIN_MS,
                changed + SKEW_MS + STALE_RETRY_MARGIN_MS - this.now(),
              ),
            )
          : null;
      try {
        if (url.pathname === "/events")
          pair[1].send(
            retry === null
              ? GONE_CHANGED
              : `{"type":"gone","reason":"changed","retryAfterMs":${retry}}`,
          );
        pair[1].close(
          4403,
          retry === null ? "access revoked" : accessChangedCloseReason(retry),
        );
      } catch {
        // already closed
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/events") {
      // A closeActor or closeSockets that ran while touch was in flight
      // already closed it: it never joins.
      if (pair[1].readyState !== WebSocket.OPEN)
        return new Response(null, { status: 101, webSocket: pair[0] });
      if (who && actor !== null) {
        await this.viewerPresenceJoin(pair[1], who, {
          t,
          named,
          actor,
          ping: req.headers.get(EVENTS_PING_HEADER) === "1",
          version,
        });
      } else pair[1].send(`{"type":"hello","version":${version}}`);
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Seats an accepted events socket that passed both gates: a reconnect
   * inside the grace keeps its `since`; hello carries `you`, then the joiner
   * gets the roster, and the others one coalesced frame.
   */
  private async viewerPresenceJoin(
    ws: WebSocket,
    who: z.infer<typeof ViewerPresenceIdentitySchema>,
    o: {
      t: number;
      named: boolean | undefined;
      actor: string;
      ping: boolean;
      version: number;
    },
  ): Promise<void> {
    const now = this.now();
    const prev = this.sql
      .exec<{ since: number }>(
        "select since from viewer_presence_left where key = ? and until > ?",
        who.key,
        now,
      )
      .toArray()[0];
    this.sql.exec("delete from viewer_presence_left where key = ?", who.key);
    const p: ViewerPresenceSeat = {
      ...who,
      since: prev?.since ?? now,
      ping: o.ping,
      actor: o.actor,
    };
    ws.serializeAttachment(
      (o.named === undefined
        ? { t: o.t, p }
        : { t: o.t, named: o.named, p }) satisfies SocketMeta,
    );
    ws.send(
      JSON.stringify({ type: "hello", version: o.version, you: who.key }),
    );
    try {
      ws.send(this.viewerPresenceText(this.viewerPresenceRoster(now), o.actor));
    } catch (e) {
      logError("viewer_presence_flush_failed", e);
    }
    await this.viewerPresenceChanged(ws);
    if (o.ping)
      await this.armAt(Math.min(o.t + SOCKET_TTL_MS, now + PRESENCE_SWEEP_MS));
  }

  /** Open sockets that joined presence (tag and `p`), with their seat. */
  private viewerPresenceSockets(): {
    ws: WebSocket;
    t: number;
    p: ViewerPresenceSeat;
  }[] {
    const out: { ws: WebSocket; t: number; p: ViewerPresenceSeat }[] = [];
    for (const ws of this.ctx.getWebSockets(VIEWER_PRESENCE_TAG)) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const m = ws.deserializeAttachment() as SocketMeta | null;
      if (m?.p) out.push({ ws, t: m.t, p: m.p });
    }
    return out;
  }

  /**
   * The roster now: joined sockets, unexpired grace rows and present agents.
   * `labels` (owner actor to agent key to label) only ever reaches that
   * owner's own sockets (viewerPresenceText).
   */
  private viewerPresenceRoster(now: number): {
    frame: PresenceFrame;
    labels: Roster["labels"];
  } {
    const seats: SeatRow[] = this.viewerPresenceSockets().map(({ p }) => ({
      key: p.key,
      kind: p.kind,
      name: p.name,
      guest: p.guest,
      since: p.since,
    }));
    for (const r of this.sql
      .exec<ViewerPresenceLeftRow>(
        "select key, kind, name, guest, since, until from viewer_presence_left where until > ?",
        now,
      )
      .toArray())
      seats.push({
        key: r.key,
        kind: r.kind,
        name: r.name,
        guest: r.guest === 1,
        since: r.since,
      });
    const { viewers, total, labels } = buildRoster(
      seats,
      this.viewerAgentRows(now),
      now,
    );
    return { frame: { type: "presence", viewers, total }, labels };
  }

  /**
   * The frame one socket gets: the shared roster, or for the owner of
   * labelled agents (by its server-only actor) the variant whose own agents
   * carry `agent.label`. No other socket ever gets a label.
   */
  private viewerPresenceText(
    r: ReturnType<ArtifactRuntime["viewerPresenceRoster"]>,
    actor: string,
  ): string {
    const mine = r.labels.get(actor);
    if (!mine) return JSON.stringify(r.frame);
    return JSON.stringify({
      ...r.frame,
      viewers: r.frame.viewers.map((v) => {
        const label = v.agent ? mine.get(v.key) : undefined;
        return label && v.agent ? { ...v, agent: { ...v.agent, label } } : v;
      }),
    } satisfies PresenceFrame);
  }

  /** What the last flush is compared against: the shared frame plus every owner's labels. */
  private viewerPresenceHash(
    r: ReturnType<ArtifactRuntime["viewerPresenceRoster"]>,
  ): string {
    const frame = JSON.stringify(r.frame);
    if (r.labels.size === 0) return frame;
    const labels = [...r.labels].map(([a, m]) => [a, [...m]]);
    return `${frame}\n${JSON.stringify(labels)}`;
  }

  /** Agent rows still present at `now` (seen within AGENT_PRESENT_MS). */
  private viewerAgentRows(now: number): AgentRow[] {
    return this.sql
      .exec<ViewerAgentDbRow>(
        `select key, product, owner, owner_actor, label, since, seen, last_write, activity
         from viewer_presence_agent where seen + ? > ?`,
        AGENT_PRESENT_MS,
        now,
      )
      .toArray()
      .map((r) => ({
        key: r.key,
        product: r.product,
        owner: r.owner,
        ownerActor: r.owner_actor,
        label: r.label,
        since: r.since,
        seen: r.seen,
        lastWrite: r.last_write,
        activity: r.activity,
      }));
  }

  /**
   * An agent read (MCP get_artifact, REST GET with a PAT): the one DO call
   * presence adds. Publishes and data calls pass the same touch to the RPC
   * they already make instead.
   */
  async touchViewerAgent(t: AgentTouch): Promise<void> {
    const p = AgentTouchSchema.safeParse(t);
    if (!p.success) fail("bad_request", "invalid agent touch");
    const seen = this.upsertViewerAgent(p.data, p.data.write);
    await this.afterViewerAgentTouch(seen);
  }

  /**
   * A data RPC's trailing touch: the row is written now (SQLite is sync, so
   * the RPC stays sync); the broadcast and alarm run in waitUntil. `write`
   * comes from the RPC, not the caller. Never fails the data call.
   */
  private viewerAgentTouched(t: AgentTouch | undefined, write: boolean): void {
    if (t === undefined) return;
    try {
      const p = AgentTouchSchema.safeParse(t);
      if (!p.success) throw new Error("invalid agent touch");
      const seen = this.upsertViewerAgent(p.data, write);
      this.ctx.waitUntil(
        this.afterViewerAgentTouch(seen).catch((e) =>
          logError("viewer_presence_touch_failed", e),
        ),
      );
    } catch (e) {
      logError("viewer_presence_touch_failed", e);
    }
  }

  /**
   * Upserts the agent's row: `since` kept (unless the row had expired),
   * `seen` now, `last_write` now on a write, activity replaced when given.
   * Keeps at most MAX_VIEWER_AGENTS_PER_OWNER rows per owner. Returns `seen`.
   */
  private upsertViewerAgent(t: AgentTouch, write: boolean): number {
    const now = this.now();
    this.sql.exec(
      "delete from viewer_presence_agent where key = ? and seen + ? <= ?",
      t.key,
      AGENT_PRESENT_MS,
      now,
    );
    this.sql.exec(
      `insert into viewer_presence_agent
         (key, product, owner, owner_actor, label, since, seen, last_write, activity)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (key) do update set product = excluded.product,
         owner = excluded.owner, owner_actor = excluded.owner_actor,
         label = excluded.label, seen = excluded.seen,
         last_write = coalesce(excluded.last_write, viewer_presence_agent.last_write),
         activity = coalesce(excluded.activity, viewer_presence_agent.activity)`,
      t.key,
      t.product,
      t.owner,
      t.ownerActor,
      t.label,
      now,
      now,
      write ? now : null,
      t.activity,
    );
    this.sql.exec(
      `delete from viewer_presence_agent where owner_actor = ?1 and key not in
         (select key from viewer_presence_agent where owner_actor = ?1
          order by seen desc, key limit ?2)`,
      t.ownerActor,
      MAX_VIEWER_AGENTS_PER_OWNER,
    );
    return now;
  }

  /** After an agent touch: broadcast (coalesced) and arm its expiry. */
  private async afterViewerAgentTouch(seen: number): Promise<void> {
    await this.viewerPresenceChanged();
    await this.armAt(seen + AGENT_PRESENT_MS);
  }

  private viewerPresenceSent(): { hash: string; sentAt: number } | null {
    const r = this.sql
      .exec<{ hash: string; sent_at: number }>(
        "select hash, sent_at from viewer_presence_state where id = 1",
      )
      .toArray()[0];
    return r ? { hash: r.hash, sentAt: r.sent_at } : null;
  }

  /**
   * The roster may have changed: flush now, or once PRESENCE_COALESCE_MS
   * has passed since the last frame (the alarm flushes). `skip` already has
   * the current roster (a joiner).
   */
  private async viewerPresenceChanged(skip?: WebSocket): Promise<void> {
    try {
      const sent = this.viewerPresenceSent();
      if (sent === null || this.now() - sent.sentAt >= PRESENCE_COALESCE_MS)
        this.flushViewerPresenceOrThrow(skip);
      else await this.armAt(sent.sentAt + PRESENCE_COALESCE_MS);
    } catch (e) {
      // A failed broadcast never fails a join or closeActor.
      logError("viewer_presence_flush_failed", e);
    }
  }

  /**
   * Sends the roster to every joined socket (but `skip`) when it differs
   * from the last frame sent. `hash` holds that frame's JSON itself: an
   * exact compare, so no collision can swallow a change.
   */
  private flushViewerPresence(skip?: WebSocket): void {
    try {
      this.flushViewerPresenceOrThrow(skip);
    } catch (e) {
      // A failed broadcast never fails a join, close or alarm.
      logError("viewer_presence_flush_failed", e);
    }
  }

  private flushViewerPresenceOrThrow(skip?: WebSocket): void {
    const now = this.now();
    const r = this.viewerPresenceRoster(now);
    const hash = this.viewerPresenceHash(r);
    if (this.viewerPresenceSent()?.hash === hash) return;
    const shared = JSON.stringify(r.frame);
    for (const { ws, p } of this.viewerPresenceSockets()) {
      if (ws === skip) continue;
      try {
        ws.send(
          r.labels.has(p.actor) ? this.viewerPresenceText(r, p.actor) : shared,
        );
      } catch {
        // closing socket
      }
    }
    this.sql.exec(
      `insert into viewer_presence_state (id, hash, sent_at) values (1, ?, ?)
       on conflict (id) do update set hash = excluded.hash, sent_at = excluded.sent_at`,
      hash,
      now,
    );
  }

  /**
   * Takes `ws` out of presence (drops `p` from its attachment, so no later
   * close counts it again). With `grace` and no other joined socket of its
   * key, the face stays PRESENCE_GRACE_MS in viewer_presence_left: returns
   * that row's `until`, else null.
   */
  private viewerPresenceLeave(ws: WebSocket, grace: boolean): number | null {
    let m: SocketMeta | null;
    try {
      m = ws.deserializeAttachment() as SocketMeta | null;
    } catch {
      return null;
    }
    if (!m?.p) return null;
    const { p, ...rest } = m;
    try {
      ws.serializeAttachment(rest satisfies SocketMeta);
    } catch {
      // closed socket: the identity check below still excludes it
    }
    if (!grace) return null;
    if (
      this.viewerPresenceSockets().some((s) => s.ws !== ws && s.p.key === p.key)
    )
      return null;
    const until = this.now() + PRESENCE_GRACE_MS;
    this.sql.exec(
      `insert into viewer_presence_left (key, kind, name, guest, since, until, actor)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (key) do update set kind = excluded.kind, name = excluded.name,
         guest = excluded.guest, since = min(since, excluded.since),
         until = excluded.until, actor = excluded.actor`,
      p.key,
      p.kind,
      p.name,
      p.guest ? 1 : 0,
      p.since,
      until,
      p.actor,
    );
    return until;
  }

  /** Presence bookkeeping, for tests: grace rows and when the last frame went out. */
  pendingViewerPresence(): { left: number; sentAt: number | null } {
    const left = this.sql
      .exec<{ n: number }>("select count(*) as n from viewer_presence_left")
      .one().n;
    return { left, sentAt: this.viewerPresenceSent()?.sentAt ?? null };
  }

  /**
   * Records the socket in the user's presence. False when a revocation
   * started at or after `authzAt`, or presence failed (fail closed). An
   * install without the USER_PRESENCE binding keeps the 10 minute socket
   * TTL as its only ceiling (logged).
   */
  private async touchPresence(
    userId: string,
    authzAt: number,
  ): Promise<boolean> {
    const p = presenceStub(this.env, userId);
    if (!p) {
      if (!unboundLogged) {
        unboundLogged = true;
        logError("presence_unbound", new Error("USER_PRESENCE is not bound"));
      }
      return true;
    }
    try {
      return (await p.touch(this.artifactId(), authzAt)).ok;
    } catch (e) {
      logError("presence_touch_failed", e);
      return false;
    }
  }

  /** When closeSockets last ran (ms; an access change), or null. */
  accessChangedAt(): number | null {
    return (
      this.sql
        .exec<{ at: number }>("select at from access_change where id = 1")
        .toArray()[0]?.at ?? null
    );
  }

  /** The artifact id this DO serves: the name it was addressed by. */
  private artifactId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("ArtifactRuntime needs a named id");
    return name;
  }

  /** Moves the one alarm earlier to `t` (never later): it serves every kind of work. */
  private async armAt(t: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > t) await this.ctx.storage.setAlarm(t);
  }

  /**
   * Queues search indexing of `version` (C3): one pending job per artifact.
   * A newer version replaces the job (attempts reset, due INDEX_DELAY_MS from
   * now); the same version only bumps `seq` (keeping any retry backoff), so a
   * re-enqueue while the alarm runs it is never dropped; an older one is
   * ignored. With `thumb` (publish, restore) and serverThumbnails(env), the same
   * debounce queues a server-side thumbnail of the newest version.
   * With `event` (publish, restore), `version` frames go to the R.events
   * sockets first: this is the RPC publish already makes, so live updates
   * cost no extra request or D1 query.
   */
  async scheduleIndex(
    artifactId: string,
    version: number,
    thumb = false,
    event?: VersionEvent,
    touch?: AgentTouch,
  ): Promise<{ ms: number }> {
    if (typeof artifactId !== "string" || artifactId.length > 64)
      fail("bad_request", "invalid artifact id");
    if (!Number.isSafeInteger(version) || version < 1)
      fail("bad_request", "invalid version");
    // The object's own share of index_enqueue's wall time (returned).
    const t0 = Date.now();
    if (event) this.broadcastVersion(version, event);
    const due = this.now() + INDEX_DELAY_MS;
    this.sql.exec(
      `insert into index_job (id, artifact_id, version, attempts, due, seq) values (1, ?, ?, 0, ?, 1)
       on conflict (id) do update set
         seq = index_job.seq + 1,
         attempts = case when excluded.version > index_job.version then 0 else index_job.attempts end,
         due = case when excluded.version > index_job.version then excluded.due else index_job.due end,
         artifact_id = excluded.artifact_id, version = excluded.version
       where excluded.version >= index_job.version`,
      artifactId,
      version,
      due,
    );
    if (thumb && serverThumbnails(this.env))
      this.sql.exec(
        `insert into thumb_job (id, artifact_id, version, attempts, due, state)
         values (1, ?, ?, 0, ?, 'pending')
         on conflict (id) do update set artifact_id = excluded.artifact_id,
           version = excluded.version, attempts = 0, due = excluded.due,
           state = 'pending'
         where excluded.version > thumb_job.version`,
        artifactId,
        version,
        due,
      );
    await this.armAt(due);
    // The publishing agent (publish, restore) rides this RPC: no extra call.
    if (touch !== undefined) {
      try {
        const p = AgentTouchSchema.safeParse(touch);
        if (!p.success) throw new Error("invalid agent touch");
        await this.afterViewerAgentTouch(this.upsertViewerAgent(p.data, true));
      } catch (e) {
        logError("viewer_presence_touch_failed", e);
      }
    }
    // Returned, not logged: a DO's console doesn't reach the dispatch tail.
    return { ms: Date.now() - t0 };
  }

  /**
   * One `version` frame per viewer class, serialized once each: named sockets
   * get `by.name`, anonymous/embed/guest sockets `{ kind }` only.
   */
  private broadcastVersion(version: number, e: VersionEvent): void {
    const kind = e.by.kind === "agent" ? "agent" : "user";
    const at = typeof e.at === "string" ? e.at.slice(0, 40) : this.iso();
    const from =
      Number.isSafeInteger(e.restoredFrom) && (e.restoredFrom ?? 0) >= 1
        ? e.restoredFrom
        : undefined;
    const frame = (by: { kind: string; name?: string }) =>
      JSON.stringify({
        type: "version",
        version,
        at,
        by,
        ...(from === undefined ? {} : { restoredFrom: from }),
      });
    const send = (tag: string, msg: () => string) => {
      const socks = this.ctx.getWebSockets(tag);
      if (!socks.length) return;
      const m = msg();
      for (const ws of socks) {
        try {
          ws.send(m);
        } catch {
          // closing socket
        }
      }
    };
    const name =
      typeof e.by.name === "string" && e.by.name
        ? e.by.name.slice(0, 200)
        : undefined;
    send(EVENTS_NAMED_TAG, () =>
      frame(name === undefined ? { kind } : { kind, name }),
    );
    send(EVENTS_ANON_TAG, () => frame({ kind }));
  }

  /** The pending index job, if any (tests and the alarm). */
  pendingIndex(): {
    artifactId: string;
    version: number;
    attempts: number;
    due: number;
    seq: number;
  } | null {
    const r = this.sql
      .exec<{
        artifact_id: string;
        version: number;
        attempts: number;
        due: number;
        seq: number;
      }>(
        "select artifact_id, version, attempts, due, seq from index_job where id = 1",
      )
      .toArray()[0];
    return r
      ? {
          artifactId: r.artifact_id,
          version: r.version,
          attempts: r.attempts,
          due: r.due,
          seq: r.seq,
        }
      : null;
  }

  /** The latest version's thumbnail job and its state (tests). */
  thumbnailJob(): {
    artifactId: string;
    version: number;
    attempts: number;
    due: number;
    state: "pending" | "done" | "no_thumb";
  } | null {
    const r = this.sql
      .exec<{
        artifact_id: string;
        version: number;
        attempts: number;
        due: number;
        state: "pending" | "done" | "no_thumb";
      }>(
        "select artifact_id, version, attempts, due, state from thumb_job where id = 1",
      )
      .toArray()[0];
    return r
      ? {
          artifactId: r.artifact_id,
          version: r.version,
          attempts: r.attempts,
          due: r.due,
          state: r.state,
        }
      : null;
  }

  /** The pending thumbnail job, if any (tests and the alarm). */
  pendingThumbnail(): {
    artifactId: string;
    version: number;
    attempts: number;
    due: number;
  } | null {
    const j = this.thumbnailJob();
    return j?.state === "pending"
      ? {
          artifactId: j.artifactId,
          version: j.version,
          attempts: j.attempts,
          due: j.due,
        }
      : null;
  }

  /**
   * One alarm, multiplexed by the next due time of both kinds of work:
   * - Socket lifetime: closes sockets older than LIMITS.signedUrlTtlSec (minus
   *   a 60 s batching slack) with 4408 "reconnect"; the client reconnects
   *   through the shell, which re-checks access.
   * - Search indexing: runs the pending job (one version per alarm): a first
   *   attempt whenever the alarm fires (INDEX_DELAY_MS is a best-effort
   *   debounce), a retry only once its backoff is due.
   *   A failure retries with indexBackoffMs, up to INDEX_MAX_ATTEMPTS, then
   *   logs {evt:"index_failed"} and drops the job. A job re-enqueued while
   *   it ran (seq changed) stays pending.
   * - Thumbnails: never in the same run as indexing (its browser wait would
   *   skew the index alarm): a run that indexed re-arms at once when a
   *   capture is pending (runThumbnail).
   * Re-arms for the oldest remaining socket or the pending job.
   */
  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const job = this.pendingIndex();
    // Gate off: no thumbnail bookkeeping at all (a job queued while it was
    // on stays dormant, unread and unattempted).
    const thumbs = serverThumbnails(this.env);
    const thumb = thumbs ? this.pendingThumbnail() : null;
    if (
      !job &&
      !thumb &&
      sockets.length === 0 &&
      this.sql.exec("select 1 from viewer_presence_left limit 1").toArray()
        .length === 0 &&
      this.sql.exec("select 1 from viewer_presence_agent limit 1").toArray()
        .length === 0
    )
      return;
    const now = this.now();
    let next = this.viewerPresenceSweep(now);
    for (const ws of sockets) {
      const t = (ws.deserializeAttachment() as SocketMeta | null)?.t ?? 0;
      if (now - t >= SOCKET_TTL_MS - SOCKET_TTL_SLACK_MS) {
        // The client reconnects at once: its face waits out the grace.
        const until = this.viewerPresenceLeave(ws, true);
        if (until !== null) next = Math.min(next, until);
        try {
          ws.close(4408, "reconnect");
        } catch {
          // already closed
        }
      } else next = Math.min(next, t + SOCKET_TTL_MS);
    }
    this.viewerPresenceDue(now);
    const indexDue = !!job && (job.attempts === 0 || job.due <= now);
    if (job && indexDue) {
      const same = "where id = 1 and seq = ?";
      const key = [job.seq] as const;
      try {
        await this.indexer(this.env, job.artifactId, job.version);
        this.sql.exec(`delete from index_job ${same}`, ...key);
      } catch (e) {
        const attempts = job.attempts + 1;
        if (attempts >= INDEX_MAX_ATTEMPTS) {
          logError("index_failed", e, {
            artifactId: job.artifactId,
            version: job.version,
            attempts,
          });
          this.sql.exec(`delete from index_job ${same}`, ...key);
          await this.markFailed("index_failed", job.artifactId, job.version);
        } else
          this.sql.exec(
            `update index_job set attempts = ?, due = ? ${same}`,
            attempts,
            this.now() + indexBackoffMs(attempts),
            ...key,
          );
      }
    }
    if (!indexDue && thumb && (thumb.attempts === 0 || thumb.due <= now))
      await this.runThumbnail(thumb);
    const pending = this.pendingIndex();
    if (pending) next = Math.min(next, pending.due);
    const pendingThumb = thumbs ? this.pendingThumbnail() : null;
    if (pendingThumb)
      next = Math.min(
        next,
        indexDue && pendingThumb.attempts === 0 ? this.now() : pendingThumb.due,
      );
    // Joins, closes and upgrades ran during the awaits above and may have
    // armed an earlier alarm: recompute their due times from storage and
    // the open sockets, so the setAlarm below never moves one later.
    next = Math.min(next, this.liveDue(now));
    if (next !== Number.POSITIVE_INFINITY)
      await this.ctx.storage.setAlarm(next);
  }

  /**
   * At most one capture (one browser session) per alarm run, strictly
   * best-effort (the client upload is the fallback). The attempt is counted
   * and an alarm armed BEFORE the browser launches, so a run killed for CPU
   * (which nothing can catch) is looked at again THUMB_RETRY_MS later and
   * retried once; at THUMB_MAX_ATTEMPTS the version gets no server thumbnail.
   * A deferral (launch slot taken) or a launch error that is not the daily
   * quota (after THUMB_LAUNCH_BACKOFF_MS) is retried within the same budget;
   * any other outcome, failures included, ends the job. A newer version queued
   * meanwhile replaces the job (writes below match on version).
   */
  private async runThumbnail(job: {
    artifactId: string;
    version: number;
    attempts: number;
  }): Promise<void> {
    const same = "where id = 1 and version = ?";
    const end = (state: "done" | "no_thumb") =>
      this.sql.exec(
        `update thumb_job set state = ? ${same}`,
        state,
        job.version,
      );
    // Every no-thumbnail outcome: one log line, and the D1 marker the pdf
    // sweep skips (sweepLostIndexJobs).
    const noThumb = async (result: string, attempts: number) => {
      end("no_thumb");
      console.error(
        JSON.stringify({
          evt: "thumbnail_no_thumb",
          artifactId: job.artifactId,
          version: job.version,
          result,
          attempts,
        }),
      );
      await this.markFailed("thumb_failed", job.artifactId, job.version);
    };
    if (job.attempts >= THUMB_MAX_ATTEMPTS) {
      console.error(
        JSON.stringify({
          evt: "thumbnail_abandoned",
          artifactId: job.artifactId,
          version: job.version,
          attempts: job.attempts,
        }),
      );
      await noThumb("abandoned", job.attempts);
      return;
    }
    const retryAt = this.now() + THUMB_RETRY_MS;
    this.sql.exec(
      `update thumb_job set attempts = attempts + 1, due = ? ${same}`,
      retryAt,
      job.version,
    );
    // Never moves a future alarm later (a presence grace end or coalesce
    // armed during this run); a past one is this run's own.
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > retryAt || cur <= this.now())
      await this.ctx.storage.setAlarm(retryAt);
    await this.ctx.storage.sync();
    let result: ThumbResult;
    try {
      result = await this.thumbnailer(this.env, job.artifactId, job.version);
    } catch (e) {
      logError("thumbnail_failed", e, {
        artifactId: job.artifactId,
        version: job.version,
      });
      result = "failed";
    }
    const retryIn =
      result === "deferred"
        ? THUMB.launchGapMs
        : result === "launch_failed"
          ? THUMB_LAUNCH_BACKOFF_MS
          : null;
    if (retryIn !== null && job.attempts + 1 < THUMB_MAX_ATTEMPTS)
      this.sql.exec(
        `update thumb_job set due = ? ${same}`,
        this.now() + retryIn,
        job.version,
      );
    else if (result === "stored" || result === "skipped") end("done");
    else await noThumb(result, job.attempts + 1);
  }

  /**
   * Marks `version` permanently failed (versions.index_failed or
   * thumb_failed) so the lost-job sweep skips it. Best effort: a lost write
   * only means the sweep retries it.
   */
  private async markFailed(
    col: "index_failed" | "thumb_failed",
    artifactId: string,
    version: number,
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `update versions set ${col} = 1 where artifact_id = ? and version = ?`,
      )
        .bind(artifactId, version)
        .run();
    } catch (e) {
      logError("sweep_mark_failed", e, { artifactId, version });
    }
  }

  /**
   * Side-effect-free due time of socket and presence work: open sockets'
   * TTL, the next sweep (a joined pinging socket is open), the earliest
   * grace end and a pending coalesced flush. Infinity when none.
   */
  private liveDue(now: number): number {
    let next = Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const t = (ws.deserializeAttachment() as SocketMeta | null)?.t ?? 0;
      next = Math.min(next, t + SOCKET_TTL_MS);
    }
    if (this.viewerPresenceSockets().some(({ p }) => p.ping))
      next = Math.min(next, now + PRESENCE_SWEEP_MS);
    try {
      const until = this.sql
        .exec<{ u: number | null }>(
          "select min(until) as u from viewer_presence_left",
        )
        .one().u;
      if (until !== null) next = Math.min(next, until);
      // An agent's expiry, and the end of its Editing (buildRoster: editing
      // while now - last_write <= AGENT_PRESENT_MS) when that comes first.
      const agent = this.sql
        .exec<{ e: number | null; w: number | null }>(
          `select min(seen + ?1) as e,
             min(case when last_write is not null and last_write < seen
               and last_write + ?1 + 1 > ?2 then last_write + ?1 + 1 end) as w
           from viewer_presence_agent`,
          AGENT_PRESENT_MS,
          now,
        )
        .one();
      if (agent.e !== null) next = Math.min(next, agent.e);
      if (agent.w !== null) next = Math.min(next, agent.w);
      const sent = this.viewerPresenceSent();
      if (
        sent !== null &&
        sent.hash !==
          this.viewerPresenceHash(this.viewerPresenceRoster(this.now()))
      )
        next = Math.min(next, sent.sentAt + PRESENCE_COALESCE_MS);
    } catch (e) {
      logError("viewer_presence_flush_failed", e);
    }
    return next;
  }

  /**
   * The alarm's presence sweep: closes joined pinging sockets with no
   * auto-response (ping) for PRESENCE_STALE_MS (1001 "stale", then the
   * grace). A socket opened without X-OA-Ping is never swept. Returns the
   * next sweep (only while a pinging socket stays open) or the earliest
   * grace end it wrote, else Infinity.
   */
  private viewerPresenceSweep(now: number): number {
    let next = Number.POSITIVE_INFINITY;
    for (const { ws, t, p } of this.viewerPresenceSockets()) {
      if (!p.ping) continue;
      const seen =
        this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? t;
      if (now - seen < PRESENCE_STALE_MS) {
        next = Math.min(next, now + PRESENCE_SWEEP_MS);
        continue;
      }
      const until = this.viewerPresenceLeave(ws, true);
      if (until !== null) next = Math.min(next, until);
      try {
        ws.close(1001, "stale");
      } catch {
        // already closed
      }
    }
    return next;
  }

  /**
   * The alarm's presence upkeep: drops expired grace rows, flushes a
   * changed roster once its coalesce window has passed (liveDue arms what
   * stays pending). Never throws: a failed broadcast never fails the alarm.
   */
  private viewerPresenceDue(now: number): void {
    try {
      this.sql.exec("delete from viewer_presence_left where until <= ?", now);
      this.sql.exec(
        "delete from viewer_presence_agent where seen + ? <= ?",
        AGENT_PRESENT_MS,
        now,
      );
      // No frame ever sent: nobody joined since the last wipe.
      const sent = this.viewerPresenceSent();
      if (sent !== null && now - sent.sentAt >= PRESENCE_COALESCE_MS)
        this.flushViewerPresenceOrThrow();
    } catch (e) {
      logError("viewer_presence_flush_failed", e);
    }
  }

  /**
   * Subscribe-only feed: "ping" gets "pong" (normally the auto-response
   * answers it without waking the DO); any other client message closes the
   * socket (1008 policy violation).
   */
  override webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    try {
      if (message === PRESENCE_PING) ws.send(PRESENCE_PONG);
      else ws.close(1008, "subscribe-only");
    } catch {
      // already closed
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const until = this.viewerPresenceLeave(ws, true);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
    if (until !== null) await this.armAt(until);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const until = this.viewerPresenceLeave(ws, true);
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
    if (until !== null) await this.armAt(until);
  }

  /**
   * Closes every subscriber socket with 4403 (access may have changed: share
   * revoked, visibility changed, artifact deleted), and records the change
   * time, so a socket authorized before it is refused on accept (fetch).
   * Clients reconnect through
   * the shell, which re-checks access. R.events sockets get a `gone` frame
   * first: access isn't re-evaluated per socket here, so every one closes
   * and the client's reconnect re-checks it (404 = really gone). `gone` is
   * the frame's reason: "deleted" for a soft delete, else "changed".
   */
  closeSockets(reason: string, gone: GoneReason = "changed"): number {
    // Recorded first: a socket whose access check ran before this change
    // (authzAt <= at + SKEW_MS) and reaches fetch after it is refused there.
    this.sql.exec(
      `insert into access_change (id, at) values (1, ?)
       on conflict (id) do update set at = max(at, excluded.at)`,
      this.now(),
    );
    const frame = gone === "deleted" ? GONE_DELETED : GONE_CHANGED;
    for (const ws of this.ctx.getWebSockets(EVENTS_TAG)) {
      try {
        ws.send(frame);
      } catch {
        // closing socket
      }
    }
    const all = this.ctx.getWebSockets();
    for (const ws of all) {
      // Everyone reconnects through the shell: no grace rows.
      this.viewerPresenceLeave(ws, false);
      try {
        ws.close(4403, reason.slice(0, 120));
      } catch {
        // already closed
      }
    }
    // Agents re-prove access on their next call.
    this.sql.exec(
      `delete from viewer_presence_left; delete from viewer_presence_state;
       delete from viewer_presence_agent;`,
    );
    return all.length;
  }

  /**
   * Closes `actor`'s data and events sockets (tag "a:{actor}") with 4403
   * after their access was revoked (UserPresence.closeAll); events sockets
   * get a `gone` frame first. Returns the number closed. Other actors'
   * sockets stay open.
   */
  closeActor(actor: string, reason: string): number {
    const a = actorOf(actor);
    const why = String(reason).slice(0, 120);
    // "ea:" too: events sockets accepted before "a:" was added to them.
    const socks = new Set([
      ...this.ctx.getWebSockets(`a:${a}`),
      ...this.ctx.getWebSockets(`ea:${a}`),
    ]);
    for (const ws of socks) {
      // A revoked person leaves at once, with no grace.
      this.viewerPresenceLeave(ws, false);
      try {
        if (this.ctx.getTags(ws).includes(EVENTS_TAG)) ws.send(GONE_CHANGED);
        ws.close(4403, why);
      } catch {
        // already closed
      }
    }
    this.sql.exec("delete from viewer_presence_left where actor = ?", a);
    // Their agents leave at once too, not after AGENT_PRESENT_MS.
    this.sql.exec("delete from viewer_presence_agent where owner_actor = ?", a);
    this.ctx.waitUntil(this.viewerPresenceChanged());
    return socks.size;
  }

  /** Wipes all data (called by purge). The schema is recreated lazily on next use. */
  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      // No grace row: a later close must not recreate the wiped tables.
      this.viewerPresenceLeave(ws, false);
      try {
        ws.close(1001, "artifact deleted");
      } catch {
        // already closed
      }
    }
    this.ready = false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }
}

type RpcMethods =
  | "get"
  | "list"
  | "count"
  | "query"
  | "set"
  | "update"
  | "delete"
  | "storageGet"
  | "storageEntry"
  | "storageSet"
  | "setRaw"
  | "updateRaw"
  | "storageSetRaw"
  | "replaceRaw"
  | "closeSockets"
  | "closeActor"
  | "scheduleIndex"
  | "touchViewerAgent"
  | "pendingIndex"
  | "pendingViewerPresence"
  | "storageDelete"
  | "storageList"
  | "destroy";

/**
 * Typed RPC view of the DO. workers-types maps `unknown` (DataDoc.data) to `never`
 * through Rpc.Result, so callers use this instead of the raw stub type.
 */
export type RuntimeStub = {
  [K in RpcMethods]: (
    ...args: Parameters<ArtifactRuntime[K]>
  ) => Promise<Awaited<ReturnType<ArtifactRuntime[K]>>>;
} & { fetch(req: Request | string, init?: RequestInit): Promise<Response> };

/** The artifact's runtime DO (one per artifact id). Wrap calls in runtimeCall for ApiError. */
export function runtimeStub(
  env: Pick<Env, "ARTIFACT_RUNTIME">,
  artifactId: string,
): RuntimeStub {
  const ns = env.ARTIFACT_RUNTIME;
  return ns.get(ns.idFromName(artifactId)) as unknown as RuntimeStub;
}
