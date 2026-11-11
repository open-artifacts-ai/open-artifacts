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
import { ACTOR_HEADER, AUTHZ_AT_HEADER } from "../runtime/do.js";
import { SKEW_MS } from "../runtime/presence.js";

/** Trusted headers from the route: the socket's role ("edit" | "read"). */
export const DOC_ROLE_HEADER = "X-OA-Doc-Role";

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

const BAD_UPDATE_FRAME =
  '{"type":"error","code":"bad_update","message":"That update could not be read."}';

export type DocRole = "edit" | "read";

interface Attachment {
  /** May write (set once at accept from the trusted route header). */
  write: boolean;
  actor: string;
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
    if ((actor.startsWith("u:") || rawAt !== null) && !validAt)
      return new Response("Missing authorization time", { status: 400 });

    const anon = actor.startsWith("ip:");
    if (role === "edit") {
      if (this.ctx.getWebSockets("role:edit").length >= MAX_EDIT_SOCKETS)
        return new Response("Too many editors", { status: 429 });
    } else if (this.ctx.getWebSockets("role:read").length >= MAX_READ_SOCKETS)
      return new Response("Too many readers", { status: 429 });
    if (anon && this.ctx.getWebSockets("pool:anon").length >= MAX_ANON_SOCKETS)
      return new Response("Too many subscribers", { status: 429 });
    if (
      this.ctx.getWebSockets(`a:${actor}`).length >=
      (anon ? MAX_ANON_SOCKETS_PER_ACTOR : MAX_SOCKETS_PER_ACTOR)
    )
      return new Response("Too many subscriptions", { status: 429 });

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [
      `role:${role}`,
      anon ? "pool:anon" : "pool:user",
      `a:${actor}`,
    ]);
    server.serializeAttachment({
      write: role === "edit",
      actor,
      aw: [],
    } satisfies Attachment);
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

  /** Closes every socket (4403) and records the change time (see fetch). */
  closeSockets(reason: string): number {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('access_changed', ?)
       ON CONFLICT (k) DO UPDATE SET v = max(v, excluded.v)`,
      this.now(),
    );
    const all = this.ctx.getWebSockets();
    for (const ws of all) {
      try {
        ws.close(4403, reason.slice(0, 120));
      } catch {
        // already closed
      }
    }
    return all.length;
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

  // ------------------------------------------------------------ messages

  override webSocketMessage(ws: WebSocket, data: ArrayBuffer | string) {
    if (typeof data === "string") return;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    try {
      const msg = new Uint8Array(data);
      const dec = decoding.createDecoder(msg);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) this.onSync(ws, att, dec);
      else if (type === MSG_AWARENESS) this.onAwareness(ws, att, msg);
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
      this.sendState(ws);
      return;
    }
    if (sub !== SYNC_STEP2 && sub !== SYNC_UPDATE)
      throw new BadFrame("unknown sync message");
    // The room, not the browser, enforces read-only.
    if (!att.write) return;
    const update = decoding.readVarUint8Array(dec);
    if (isEmptyUpdate(update)) return;
    this.acceptUpdate(ws, att, update);
  }

  private acceptUpdate(ws: WebSocket, att: Attachment, update: Uint8Array) {
    // Decode the whole update (structs and delete set) before accepting it:
    // parseUpdateMeta skips the delete set, so a truncated update would pass
    // and then wedge every flush, compaction and joiner.
    let meta: { from: Map<number, number>; to: Map<number, number> };
    try {
      Y.decodeUpdate(update);
      meta = Y.parseUpdateMeta(update);
    } catch {
      throw new BadFrame("undecodable update");
    }
    if (this.storedBytes() + update.byteLength > DOC_MAX_BYTES) {
      // Rows and the buffer overcount what a compacted doc holds. Never
      // compact on a socket message (a cold load costs CPU): refuse, and
      // let the alarm squeeze now so a retry sees the real size.
      if (this.rowCount > 0 || this.buffer.length > 0) {
        this.squeeze = true;
        void this.ctx.storage.setAlarm(this.now());
      }
      ws.send(DOC_TOO_LARGE_FRAME);
      return;
    }
    // Advance a client's clock only when the update continues what we hold:
    // a gap (structs at a far clock) must not claim the clocks in between,
    // or the real author's missing edits would never be requested.
    // (parseUpdateMeta, not encodeStateVectorFromUpdate, which counts only
    // from clock 0.) Compaction recomputes the vector from the doc.
    for (const [c, to] of meta.to) {
      const have = this.sv.get(c) ?? 0;
      if (have < to && (meta.from.get(c) ?? 0) <= have) this.sv.set(c, to);
    }
    const wasEmpty = this.buffer.length === 0;
    this.buffer.push(update);
    this.bufferBytes += update.byteLength;
    if (wasEmpty) void this.ctx.storage.setAlarm(this.now() + FLUSH_MS);
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, MSG_SYNC);
    encoding.writeVarUint(out, SYNC_UPDATE);
    encoding.writeVarUint8Array(out, update);
    this.broadcast(encoding.toUint8Array(out), ws);
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
    const entries: { id: number; clock: number; state: string }[] = [];
    try {
      const outer = decoding.createDecoder(msg);
      decoding.readVarUint(outer);
      const dec = decoding.createDecoder(decoding.readVarUint8Array(outer));
      const n = decoding.readVarUint(dec);
      for (let i = 0; i < n; i++) {
        const id = decoding.readVarUint(dec);
        const clock = decoding.readVarUint(dec);
        const state = decoding.readVarString(dec);
        entries.push({ id, clock, state });
      }
    } catch {
      return; // undecodable awareness: drop it, keep the socket
    }
    // A socket may only set or remove client ids it introduced itself; its
    // state must be a JSON object or null.
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
      return (
        att.aw.length < MAX_AWARENESS_IDS && !this.ownedElsewhere(ws, e.id)
      );
    });
    // Only a frame with something of ours counts toward the rate limit.
    if (keep.length === 0) return;
    const sec = Math.floor(this.now() / 1000);
    const rate = this.awRate.get(ws);
    if (rate && rate.sec === sec) {
      if (++rate.n > MAX_AWARENESS_PER_SEC) return;
    } else this.awRate.set(ws, { sec, n: 1 });
    let changed = false;
    for (const e of keep) {
      const at = att.aw.findIndex(([c]) => c === e.id);
      if (e.state === "null") {
        att.aw.splice(at, 1);
        changed = true;
      } else if (at >= 0) {
        if ((att.aw[at] as [number, number])[1] !== e.clock) {
          att.aw[at] = [e.id, e.clock];
          changed = true;
        }
      } else if (att.aw.length < MAX_AWARENESS_IDS) {
        att.aw.push([e.id, e.clock]);
        changed = true;
      }
    }
    if (changed) ws.serializeAttachment(att);
    const out = keep.length === entries.length ? msg : awarenessFrame(keep);
    this.broadcast(out, ws);
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
    this.flush();
    // A refusal at the cap asked for a squeeze (in memory: if lost, the
    // row and byte thresholds still bound the tail).
    if (this.squeeze) {
      this.squeeze = false;
      if (this.rowCount > 0) this.compact();
    }
  }

  /** Writes the buffer as ONE merged row; compacts past the thresholds. */
  flush() {
    if (!this.writeBuffer()) return;
    if (this.rowCount > COMPACT_ROWS || this.rowBytes > COMPACT_ROW_BYTES)
      this.compact();
  }

  private writeBuffer(): boolean {
    if (this.buffer.length === 0) return false;
    const pending = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
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
      if (ok.length === 0) return false;
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
