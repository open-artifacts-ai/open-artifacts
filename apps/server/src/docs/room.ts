/**
 * DocRoom (#1100): one Durable Object per collaborative doc.
 *
 * Relay first. Typing, cursors, wake and join never load a Y.Doc: an update is
 * buffered, broadcast and folded into a running state vector; joiners get the
 * stored snapshot and update rows as they are. The doc loads only to compact
 * (Y.applyUpdate, never mergeUpdates) and, in later PRs, for edit_doc and
 * versions. Writes are batched: at most one merged row per FLUSH_MS, via an
 * alarm armed only when the buffer goes from empty to non-empty.
 *
 * Wire format: y-websocket framing (0 = sync, 1 = awareness) over binary
 * frames; errors are text frames `{"type":"error","code":...}`.
 */
import { DurableObject } from "cloudflare:workers";
import { accessChangedCloseReason } from "@oa/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import {
  ACTOR_HEADER,
  AUTHZ_AT_HEADER,
  SOCKET_TTL_MS,
  SOCKET_TTL_SLACK_MS,
} from "../runtime/do.js";
import {
  DOC_PRESENCE_PREFIX,
  presenceStub,
  SKEW_MS,
} from "../runtime/presence.js";

/** Trusted headers from the route: the socket's role ("edit" | "read"). */
export const DOC_ROLE_HEADER = "X-OA-Doc-Role";
/** Trusted header from the route: the artifact's current version (hello frame). */
export const DOC_VERSION_HEADER = "X-OA-Doc-Version";

/** Doc size cap, one for every plan (docs need Workers Paid): snapshot + pending. */
export const DOC_MAX_BYTES = 2 * 1024 * 1024;
/** The buffer is written as one merged row at most this often. */
export const FLUSH_MS = 1000;
/** Compact when pending rows exceed this many rows... */
export const COMPACT_ROWS = 500;
/** ...or this many bytes. Compaction runs in the flush alarm only. */
export const COMPACT_ROW_BYTES = 256 * 1024;

/** Edit sockets per room. */
export const MAX_EDIT_SOCKETS = 25;
/** Read sockets per room (signed-in and anonymous). */
export const MAX_READ_SOCKETS = 200;
/** Anonymous (ip:) sockets per room, of either role: their own smaller pool. */
export const MAX_ANON_SOCKETS = 50;
/** Sockets per signed-in or agent actor. */
export const MAX_SOCKETS_PER_ACTOR = 10;
/** Sockets per anonymous actor. */
export const MAX_ANON_SOCKETS_PER_ACTOR = 4;
/** Awareness client ids tracked per socket (the attachment is 2 KB). */
const MAX_AWARENESS_IDS = 8;
/** Any frame larger than this closes the socket (a doc plus framing). */
const MAX_FRAME_BYTES = DOC_MAX_BYTES + 64;
/** A sync step 1 carries a state vector; larger ones are refused. */
const MAX_SV_BYTES = 64 * 1024;
/**
 * Full-state budget per ACTOR per room, across reconnects: a token bucket.
 * A socket upgrade costs one token and each full-state reply one more.
 * Anonymous (ip:) actors share one stricter bucket.
 */
const BUDGET_CAP = 6;
const BUDGET_REFILL_MS = 60_000;
const ANON_BUDGET_CAP = 10;
const ANON_BUDGET_KEY = "ip:*";
/** Awareness frames larger than this are dropped. */
const MAX_AWARENESS_BYTES = 8 * 1024;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const ACTOR_RE = /^(u|ip|agent):[\x21-\x7e]{1,250}$/;

export const DOC_TOO_LARGE_FRAME =
  '{"type":"error","code":"doc_too_large","message":"This doc is at its 2 MB size limit. Start a new doc to keep writing."}';
/** Awareness frames per socket per second; the excess is dropped. */
const MAX_AWARENESS_PER_SEC = 10;

/** A frame the room refuses and closes the socket for. */
class BadFrame extends Error {}

const RATE_LIMITED_FRAME =
  '{"type":"error","code":"rate_limited","message":"Too many reconnects. Try again shortly."}';
const BAD_UPDATE_FRAME =
  '{"type":"error","code":"bad_update","message":"That update could not be read."}';

export type DocRole = "edit" | "read";

interface Attachment {
  /** May write (set once at accept from the trusted route header). */
  write: boolean;
  actor: string;
  /** Accept time (ms): the socket TTL counts from here. */
  t?: number;
  /** Awareness [clientId, clock] pairs this socket announced (for removal). */
  aw: [number, number][];
}

const EMPTY_UPDATE_LEN = 2;
const isEmptyUpdate = (u: Uint8Array) =>
  u.byteLength === EMPTY_UPDATE_LEN && u[0] === 0 && u[1] === 0;

function awarenessFrame(
  entries: { id: number; clock: number; state: string }[],
): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(inner, e.id);
    encoding.writeVarUint(inner, e.clock);
    encoding.writeVarString(inner, e.state);
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
  return encoding.toUint8Array(enc);
}

export class DocRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private buffer: Uint8Array[] = [];
  private bufferBytes = 0;
  /** Running state vector of everything stored plus buffered. */
  private sv = new Map<number, number>();
  private snapBytes = 0;
  private rowCount = 0;
  private rowBytes = 0;
  /** Times a Y.Doc was loaded in this instance (tests: relay never loads). */
  docLoads = 0;
  private squeeze = false;
  /** A compaction is owed (set on a threshold or squeeze; cleared on success). */
  private compactPending = false;
  /** Sockets that received their full state (in memory). */
  private synced = new WeakSet<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS snapshot (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         state BLOB NOT NULL, sv BLOB NOT NULL, bytes INTEGER NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS updates (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         data BLOB NOT NULL, at INTEGER NOT NULL)`,
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL)",
    );
    const sv = this.sql
      .exec<{ v: ArrayBuffer }>("SELECT v FROM meta WHERE k = 'sv'")
      .toArray()[0];
    if (sv) this.sv = Y.decodeStateVector(new Uint8Array(sv.v));
    this.snapBytes =
      this.sql
        .exec<{ bytes: number }>("SELECT bytes FROM snapshot WHERE id = 1")
        .toArray()[0]?.bytes ?? 0;
    const rows = this.sql
      .exec<{ n: number; b: number }>(
        "SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS b FROM updates",
      )
      .one();
    this.rowCount = rows.n;
    this.rowBytes = rows.b;
  }

  protected now(): number {
    return Date.now();
  }

  // ------------------------------------------------------------ upgrade

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    const actor = req.headers.get(ACTOR_HEADER);
    if (actor === null || !ACTOR_RE.test(actor))
      return new Response("Missing actor", { status: 400 });
    const role = req.headers.get(DOC_ROLE_HEADER);
    if (role !== "edit" && role !== "read")
      return new Response("Invalid role", { status: 400 });
    const rawAt = req.headers.get(AUTHZ_AT_HEADER);
    const authzAt = Number(rawAt ?? Number.NaN);
    const validAt = Number.isSafeInteger(authzAt) && authzAt >= 1;
    if (!validAt)
      return new Response("Missing authorization time", { status: 400 });

    const anon = actor.startsWith("ip:");
    const version = Number(req.headers.get(DOC_VERSION_HEADER));
    // A full room (MAX_EDIT_SOCKETS) joins read-only; a viewer reads by access.
    const full =
      role === "edit" &&
      this.ctx.getWebSockets("role:edit").length >= MAX_EDIT_SOCKETS;
    const granted: DocRole = role === "edit" && !full ? "edit" : "read";
    const reason = full ? "room_full" : role === "read" ? "access" : undefined;
    if (
      granted === "read" &&
      this.ctx.getWebSockets("role:read").length >= MAX_READ_SOCKETS
    )
      return new Response("Too many readers", { status: 429 });
    if (anon && this.ctx.getWebSockets("pool:anon").length >= MAX_ANON_SOCKETS)
      return new Response("Too many subscribers", { status: 429 });
    if (
      this.ctx.getWebSockets(`a:${actor}`).length >=
      (anon ? MAX_ANON_SOCKETS_PER_ACTOR : MAX_SOCKETS_PER_ACTOR)
    )
      return new Response("Too many subscriptions", { status: 429 });

    if (!this.takeToken(actor))
      return new Response("Try again shortly", {
        status: 429,
        headers: { "Retry-After": "10" },
      });
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [
      `role:${granted}`,
      anon ? "pool:anon" : "pool:user",
      `a:${actor}`,
    ]);
    const t = this.now();
    server.serializeAttachment({
      write: granted === "edit",
      actor,
      t,
      aw: [],
    } satisfies Attachment);
    await this.armAlarm(t + SOCKET_TTL_MS);
    // Authorized before this doc's last access change: the check may have
    // seen the old access, so refuse (any actor), as ArtifactRuntime does.
    const changed = this.accessChangedAt();
    if (validAt && changed !== null && authzAt <= changed + SKEW_MS) {
      const retry = Math.min(
        SKEW_MS + 250,
        Math.max(250, changed + SKEW_MS + 250 - this.now()),
      );
      try {
        server.close(4403, accessChangedCloseReason(retry));
      } catch {
        // already closed
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // Accepted (and tagged) before touch, so a closeActor that runs while
    // touch is in flight finds it; a touch after a revocation started is
    // refused and the socket closes here (as ArtifactRuntime.fetch does).
    if (actor.startsWith("u:") && !(await this.touchPresence(actor, authzAt))) {
      try {
        server.close(4403, "access_removed");
      } catch {
        // already closed
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // The hello frame comes first: role is the server's, never the client's.
    server.send(
      JSON.stringify({
        type: "hello",
        role: granted,
        ...(reason ? { reason } : {}),
        bytes: this.storedBytes(),
        cap: DOC_MAX_BYTES,
        version: Number.isSafeInteger(version) && version >= 0 ? version : 0,
      }),
    );
    // Our state vector: the client answers with what we lack (sync step 2).
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    encoding.writeVarUint(enc, SYNC_STEP1);
    encoding.writeVarUint8Array(enc, Y.encodeStateVector(this.sv));
    server.send(encoding.toUint8Array(enc));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  accessChangedAt(): number | null {
    const r = this.sql
      .exec<{ v: number }>("SELECT v FROM meta WHERE k = 'access_changed'")
      .toArray()[0];
    return r ? Number(r.v) : null;
  }

  /**
   * Closes every socket and records the change time (see fetch): 4403
   * access_removed, or 4404 not_found when the doc was deleted.
   */
  closeSockets(
    reason: string,
    gone: "changed" | "deleted" = "changed",
  ): number {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('access_changed', ?)
       ON CONFLICT (k) DO UPDATE SET v = max(v, excluded.v)`,
      this.now(),
    );
    const all = this.ctx.getWebSockets();
    for (const ws of all) {
      try {
        if (gone === "deleted") ws.close(4404, "not_found");
        else ws.close(4403, reason.slice(0, 120));
      } catch {
        // already closed
      }
    }
    return all.length;
  }

  /** UserPresence.closeAll with a null actor (the install index): every socket. */
  closeAllSockets(reason: string): number {
    return this.closeSockets(reason);
  }

  /** Closes one actor's sockets (4403); other actors stay. */
  closeActor(actor: string, reason: string): number {
    const socks = this.ctx.getWebSockets(`a:${actor}`);
    for (const ws of socks) {
      try {
        ws.close(4403, String(reason).slice(0, 120));
      } catch {
        // already closed
      }
    }
    return socks.length;
  }

  /** Records this signed-in socket with the user's presence (revocation closes it). */
  private async touchPresence(
    actor: string,
    authzAt: number,
  ): Promise<boolean> {
    const id = this.ctx.id.name;
    const p = presenceStub(this.env, actor.slice(2));
    if (!p || !id) return true;
    try {
      return (await p.touch(`${DOC_PRESENCE_PREFIX}${id}`, authzAt)).ok;
    } catch (e) {
      logError("presence_touch_failed", e);
      return false;
    }
  }

  // ------------------------------------------------------------ messages

  override webSocketMessage(ws: WebSocket, data: ArrayBuffer | string) {
    if (typeof data === "string") return;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    try {
      // Bound the WHOLE frame first: lib0 returns views of the input, so a
      // padded frame would keep its trailer alive past the counted slice.
      if (data.byteLength > MAX_FRAME_BYTES) throw new BadFrame("frame size");
      const msg = new Uint8Array(data);
      const dec = decoding.createDecoder(msg);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        this.onSync(ws, att, dec);
      } else if (type === MSG_AWARENESS) this.onAwareness(ws, att, msg);
      else throw new BadFrame("unknown message type");
    } catch {
      // Malformed frame (truncated, bad lengths, unknown type): nothing from
      // it was stored or relayed; tell the sender and close its socket.
      try {
        ws.send(BAD_UPDATE_FRAME);
        ws.close(1007, "bad frame");
      } catch {
        // closing
      }
    }
  }

  private onSync(ws: WebSocket, att: Attachment, dec: decoding.Decoder) {
    const sub = decoding.readVarUint(dec);
    if (sub === SYNC_STEP1) {
      const sv = decoding.readVarUint8Array(dec);
      if (decoding.hasContent(dec)) throw new BadFrame("trailing bytes");
      if (sv.byteLength > MAX_SV_BYTES) throw new BadFrame("state vector size");
      try {
        Y.decodeStateVector(sv);
      } catch {
        throw new BadFrame("bad state vector");
      }
      if (this.takeToken(att.actor)) {
        this.synced.add(ws);
        this.sendState(ws);
      } else if (!this.synced.has(ws)) {
        // Never answer a refused first step 1 as if synced: close instead.
        ws.send(RATE_LIMITED_FRAME);
        ws.close(1013, "try_again");
      } // surplus step 1s on an already-synced socket are ignored
      return;
    }
    if (sub !== SYNC_STEP2 && sub !== SYNC_UPDATE)
      throw new BadFrame("unknown sync message");
    // The room, not the browser, enforces read-only.
    const update = decoding.readVarUint8Array(dec);
    if (decoding.hasContent(dec)) throw new BadFrame("trailing bytes");
    if (!att.write) return;
    if (isEmptyUpdate(update)) return;
    this.acceptUpdate(ws, att, update);
  }

  private acceptUpdate(ws: WebSocket, att: Attachment, update: Uint8Array) {
    // Decode the whole update (structs and delete set) before accepting it:
    // parseUpdateMeta skips the delete set, so a truncated update would pass
    // and then wedge every flush, compaction and joiner.
    let structs: { id: { client: number; clock: number }; length: number }[];
    try {
      structs = Y.decodeUpdate(update).structs;
    } catch {
      throw new BadFrame("undecodable update");
    }
    if (this.storedBytes() + update.byteLength > DOC_MAX_BYTES) {
      // Rows and the buffer overcount what a compacted doc holds. Never
      // compact on a socket message (a cold load costs CPU): refuse, and
      // let the alarm squeeze now so a retry sees the real size.
      if (this.rowCount > 0 || this.buffer.length > 0) {
        this.squeeze = true;
        // Keep the batching cadence: never pull an armed alarm earlier.
        this.armAlarmLogged(this.now() + FLUSH_MS);
      }
      ws.send(DOC_TOO_LARGE_FRAME);
      return;
    }
    // Advance a client's clock only across structs that continue what we
    // hold: a gap or a Skip struct (a merged update with a hole) must not
    // claim the clocks in between, or the real author's missing edits would
    // never be requested. Compaction recomputes the vector from the doc.
    // Unknown struct kinds do not advance (the safe direction).
    const cursor = new Map<number, number>();
    const stopped = new Set<number>();
    for (const st of structs) {
      const c = st.id.client;
      if (stopped.has(c)) continue;
      const at = cursor.get(c) ?? this.sv.get(c) ?? 0;
      const end = st.id.clock + st.length;
      if (end <= at) continue; // already held
      const known = st instanceof Y.Item || st instanceof Y.GC;
      if (!known || st.id.clock > at) {
        stopped.add(c);
        continue;
      }
      cursor.set(c, end);
    }
    for (const [c, to] of cursor) this.sv.set(c, to);
    this.buffer.push(update);
    this.bufferBytes += update.byteLength;
    this.armAlarmLogged(this.now() + FLUSH_MS);
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, MSG_SYNC);
    encoding.writeVarUint(out, SYNC_UPDATE);
    encoding.writeVarUint8Array(out, update);
    this.broadcast(encoding.toUint8Array(out), ws);
  }

  /** Tokens per actor key (in memory; idle full buckets are evicted). */
  private budgets = new Map<string, { tokens: number; at: number }>();
  /** Bucket size for non-anonymous actors (tests may widen it). */
  budgetCap = BUDGET_CAP;

  private takeToken(actor: string): boolean {
    const anon = actor.startsWith("ip:");
    const key = anon ? ANON_BUDGET_KEY : actor;
    const cap = anon
      ? Math.min(ANON_BUDGET_CAP, this.budgetCap)
      : this.budgetCap;
    const t = this.now();
    for (const [k, b] of this.budgets)
      if (k !== key && t - b.at >= BUDGET_REFILL_MS) this.budgets.delete(k);
    const cur = this.budgets.get(key);
    let tokens = cap;
    if (cur) {
      const refill = (Math.max(0, t - cur.at) / BUDGET_REFILL_MS) * cap;
      tokens = Math.min(cap, cur.tokens + refill);
    }
    if (tokens < 1) {
      this.budgets.set(key, { tokens, at: t });
      return false;
    }
    this.budgets.set(key, { tokens: tokens - 1, at: t });
    return true;
  }

  private armAlarmLogged(at: number) {
    this.armAlarm(at).catch((e) => logError("doc_room_arm_alarm_failed", e));
  }

  /** Arms the alarm at `at` unless one is already armed at or before it. */
  private async armAlarm(at: number) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  private storedBytes(): number {
    return this.snapBytes + this.rowBytes + this.bufferBytes;
  }

  /**
   * Answers sync step 1 from storage: update rows and the buffer as updates,
   * then the snapshot as sync step 2 (so `synced` fires after all of it).
   * Never loads the doc.
   */
  private sendState(ws: WebSocket) {
    const frame = (sub: number, data: Uint8Array) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      encoding.writeVarUint(e, sub);
      encoding.writeVarUint8Array(e, data);
      return encoding.toUint8Array(e);
    };
    for (const r of this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM updates ORDER BY seq")
      .toArray())
      ws.send(frame(SYNC_UPDATE, new Uint8Array(r.data)));
    for (const u of this.buffer) ws.send(frame(SYNC_UPDATE, u));
    const snap = this.sql
      .exec<{ state: ArrayBuffer }>("SELECT state FROM snapshot WHERE id = 1")
      .toArray()[0];
    ws.send(
      frame(
        SYNC_STEP2,
        snap ? new Uint8Array(snap.state) : new Uint8Array([0, 0]),
      ),
    );
  }

  private awRate = new WeakMap<WebSocket, { sec: number; n: number }>();

  /** True when another socket announced awareness client `id`. */
  private ownedElsewhere(ws: WebSocket, id: number): boolean {
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const o = other.deserializeAttachment() as Attachment | null;
      if (o?.aw.some(([c]) => c === id)) return true;
    }
    return false;
  }

  /**
   * Awareness never closes the socket: y-websocket clients re-send remote and
   * timed-out states, so a legitimate frame can carry many entries and other
   * peers' client ids. Offending entries are dropped, the rest relayed.
   */
  private onAwareness(ws: WebSocket, att: Attachment, msg: Uint8Array) {
    if (msg.byteLength > MAX_AWARENESS_BYTES) return;
    // Charge every inbound frame before any parsing or ownership scan.
    const sec = Math.floor(this.now() / 1000);
    const rate = this.awRate.get(ws);
    if (rate && rate.sec === sec) {
      if (++rate.n > MAX_AWARENESS_PER_SEC) return;
    } else this.awRate.set(ws, { sec, n: 1 });
    const entries: { id: number; clock: number; state: string }[] = [];
    try {
      const outer = decoding.createDecoder(msg);
      decoding.readVarUint(outer);
      const dec = decoding.createDecoder(decoding.readVarUint8Array(outer));
      if (decoding.hasContent(outer)) return; // trailing bytes
      const n = decoding.readVarUint(dec);
      if (n > MAX_AWARENESS_BYTES) return;
      const seen = new Set<number>();
      for (let i = 0; i < n; i++) {
        const id = decoding.readVarUint(dec);
        const clock = decoding.readVarUint(dec);
        const state = decoding.readVarString(dec);
        if (seen.has(id)) continue; // one entry per id per frame (the first)
        seen.add(id);
        entries.push({ id, clock, state });
      }
      if (decoding.hasContent(dec)) return;
    } catch {
      return; // undecodable awareness: drop it, keep the socket
    }
    // A socket may only set or remove client ids it introduced itself; its
    // state must be a JSON object or null.
    let tracked = att.aw.length;
    const keep = entries.filter((e) => {
      if (e.state !== "null") {
        try {
          const v: unknown = JSON.parse(e.state);
          if (typeof v !== "object" || v === null || Array.isArray(v))
            return false;
        } catch {
          return false;
        }
      }
      const own = att.aw.some(([c]) => c === e.id);
      if (own) return true;
      if (e.state === "null") return false; // nothing of ours to remove
      // A new id counts against the cap now, so the 9th in one frame is
      // neither tracked nor relayed.
      if (tracked >= MAX_AWARENESS_IDS || this.ownedElsewhere(ws, e.id))
        return false;
      tracked++;
      return true;
    });
    if (keep.length === 0) return;
    let changed = false;
    for (const e of keep) {
      const at = att.aw.findIndex(([c]) => c === e.id);
      if (e.state === "null") {
        if (at >= 0) {
          att.aw.splice(at, 1);
          changed = true;
        }
      } else if (at >= 0) {
        if ((att.aw[at] as [number, number])[1] !== e.clock) {
          att.aw[at] = [e.id, e.clock];
          changed = true;
        }
      } else {
        att.aw.push([e.id, e.clock]);
        changed = true;
      }
    }
    if (changed) ws.serializeAttachment(att);
    this.broadcast(awarenessFrame(keep), ws);
  }

  private broadcast(msg: Uint8Array, except: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        // closed socket; webSocketClose cleans up
      }
    }
  }

  override webSocketClose(ws: WebSocket) {
    this.dropAwareness(ws);
  }

  override webSocketError(ws: WebSocket) {
    this.dropAwareness(ws);
  }

  /** Tells everyone the closed socket's cursors are gone (state "null"). */
  private dropAwareness(ws: WebSocket) {
    let att: Attachment | null = null;
    try {
      att = ws.deserializeAttachment() as Attachment | null;
    } catch {
      return;
    }
    if (!att || att.aw.length === 0) return;
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, att.aw.length);
    for (const [id, clock] of att.aw) {
      encoding.writeVarUint(inner, id);
      encoding.writeVarUint(inner, clock + 1);
      encoding.writeVarString(inner, "null");
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
    att.aw = [];
    try {
      ws.serializeAttachment(att);
    } catch {
      // closed
    }
    this.broadcast(encoding.toUint8Array(enc), ws);
  }

  // ------------------------------------------------------------ storage

  override async alarm() {
    // Sockets at their TTL close 4401 (the client reconnects, and the cookie
    // re-authorizes); the alarm re-arms for the oldest remaining one.
    const nextTtl = this.expireSockets();
    try {
      this.flush();
      // A refusal at the cap asked for a squeeze (in memory: if lost, the
      // row and byte thresholds still bound the tail).
      if (this.squeeze) {
        this.squeeze = false;
        if (this.rowCount > 0) this.compactPending = true;
      }
      if (this.compactPending) {
        if (this.rowCount > 0) this.compact();
        else this.compactPending = false;
      }
    } catch (e) {
      // A write or compaction failed: the batch and the owed compaction are
      // kept; retry on the next alarm.
      logError("doc_room_alarm_failed", e);
      await this.armAlarm(this.now() + FLUSH_MS);
      return;
    } finally {
      if (nextTtl !== null) await this.armAlarm(nextTtl);
    }
  }

  /**
   * Closes sockets within SOCKET_TTL_SLACK_MS of their TTL (4401 auth_expired);
   * returns when the oldest remaining one expires, or null with none left.
   */
  private expireSockets(): number | null {
    const now = this.now();
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      let t = 0;
      try {
        t = (ws.deserializeAttachment() as Attachment | null)?.t ?? 0;
      } catch {
        // closed
      }
      if (now - t >= SOCKET_TTL_MS - SOCKET_TTL_SLACK_MS) {
        try {
          ws.close(4401, "auth_expired");
        } catch {
          // already closed
        }
      } else
        next =
          next === null ? t + SOCKET_TTL_MS : Math.min(next, t + SOCKET_TTL_MS);
    }
    return next;
  }

  /** Writes the buffer as ONE merged row; compacts past the thresholds. */
  flush() {
    if (!this.writeBuffer()) return;
    if (this.rowCount > COMPACT_ROWS || this.rowBytes > COMPACT_ROW_BYTES)
      this.compactPending = true;
    if (this.compactPending) this.compact();
  }

  private writeBuffer(): boolean {
    if (this.buffer.length === 0) return false;
    // The batch stays in memory until the transaction commits: a failed
    // write keeps it (and the alarm retries), never loses it.
    const pending = this.buffer;
    let merged: Uint8Array;
    try {
      merged =
        pending.length === 1
          ? (pending[0] as Uint8Array)
          : Y.mergeUpdates(pending);
    } catch (e) {
      // Never wedge the room: keep the updates that decode, drop the rest.
      logError("doc_room_flush_bad_update", e);
      const ok = pending.filter((u) => {
        try {
          Y.decodeUpdate(u);
          return true;
        } catch {
          return false;
        }
      });
      if (ok.length === 0) {
        this.buffer = [];
        this.bufferBytes = 0;
        return false;
      }
      merged = Y.mergeUpdates(ok);
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO updates (data, at) VALUES (?, ?)",
        merged,
        this.now(),
      );
      this.putSv();
    });
    // Committed: drop exactly what was written (updates may not arrive
    // mid-call, but be exact anyway).
    this.buffer = this.buffer.slice(pending.length);
    this.bufferBytes = this.buffer.reduce((n, u) => n + u.byteLength, 0);
    this.rowCount++;
    this.rowBytes += merged.byteLength;
    return true;
  }

  private putSv() {
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (k, v) VALUES ('sv', ?)",
      Y.encodeStateVector(this.sv),
    );
  }

  /**
   * Loads the doc (applyUpdate, never mergeUpdates), writes one snapshot and
   * drops the update rows. Returns the snapshot size. Also the hook for
   * version saves.
   */
  compact(): number {
    this.writeBuffer();
    if (this.rowCount === 0 && this.snapBytes > 0) return this.snapBytes;
    const doc = new Y.Doc({ gc: true });
    this.docLoads++;
    try {
      const snap = this.sql
        .exec<{ state: ArrayBuffer }>("SELECT state FROM snapshot WHERE id = 1")
        .toArray()[0];
      const rows = this.sql
        .exec<{ data: ArrayBuffer }>("SELECT data FROM updates ORDER BY seq")
        .toArray();
      doc.transact(() => {
        if (snap) Y.applyUpdate(doc, new Uint8Array(snap.state));
        for (const r of rows) {
          try {
            Y.applyUpdate(doc, new Uint8Array(r.data));
          } catch (e) {
            // A row that fails to decode must not wedge compaction.
            logError("doc_room_compact_bad_row", e);
          }
        }
      });
      const state = Y.encodeStateAsUpdate(doc);
      const sv = Y.encodeStateVector(doc);
      this.sv = Y.decodeStateVector(sv);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT OR REPLACE INTO snapshot (id, state, sv, bytes) VALUES (1, ?, ?, ?)",
          state,
          sv,
          state.byteLength,
        );
        this.sql.exec("DELETE FROM updates");
        this.putSv();
      });
      this.snapBytes = state.byteLength;
      this.compactPending = false;
      this.rowCount = 0;
      this.rowBytes = 0;
      return state.byteLength;
    } catch (e) {
      logError("doc_room_compact_failed", e);
      throw e;
    } finally {
      doc.destroy();
    }
  }

  /** Stored size in bytes: snapshot + rows + buffer (tests, route reads). */
  size(): number {
    return this.storedBytes();
  }
}
