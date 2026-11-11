/**
 * Throwaway Yjs room for the #1100 spike. One Durable Object per doc:
 * hibernating WebSockets, y-protocols sync + awareness (y-websocket framing:
 * 0 = sync, 1 = awareness), every update appended to DO SQLite (or batched,
 * FLUSH_MS > 0), compaction to one snapshot row after COMPACT_ROWS updates.
 *
 * Not production code: no auth, no versions, no limits. See RESULTS.md.
 */
import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { EditError, editDoc, type Op, textIndex } from "./doc-model.ts";

export interface Env {
  ROOM: DurableObjectNamespace<YRoom>;
  /** 0: one row per update. N: merge updates, one row per N ms. */
  FLUSH_MS: string;
  /** Compact after this many update rows. */
  COMPACT_ROWS: string;
}

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

interface Attachment {
  ro: boolean;
  /** Awareness client ids this socket announced, for removal on close. */
  aw: number[];
}

const now = () => performance.now();

export class YRoom extends DurableObject<Env> {
  private doc = new Y.Doc({ gc: true });
  private readonly sql: SqlStorage;
  private pending: Uint8Array[] = [];
  private lastFlush = 0;
  private alarmSet = false;
  private rowsSinceCompact = 0;
  private readonly flushMs: number;
  private readonly compactRows: number;
  readonly stats = {
    loadMs: 0,
    /** Of loadMs, the SQLite reads alone (a relay-only room pays just this). */
    loadSqlMs: 0,
    loadedSnapshotBytes: 0,
    loadedRows: 0,
    rowsWritten: 0,
    compactions: 0,
    lastCompactMs: 0,
    msgs: 0,
    msgMsTotal: 0,
    msgMsMax: 0,
    wakes: 0,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.flushMs = Number(env.FLUSH_MS ?? "0");
    this.compactRows = Number(env.COMPACT_ROWS ?? "500");
    ctx.blockConcurrencyWhile(async () => this.load());
  }

  private load() {
    const t0 = now();
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)",
    );
    const doc = new Y.Doc({ gc: true });
    const snap = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM snapshot WHERE id = 1")
      .toArray()[0];
    const rows = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM updates ORDER BY seq")
      .toArray();
    this.stats.loadSqlMs = now() - t0;
    doc.transact(() => {
      if (snap) Y.applyUpdate(doc, new Uint8Array(snap.data));
      for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.data));
    });
    this.doc = doc;
    this.rowsSinceCompact = rows.length;
    doc.on("update", (u: Uint8Array, origin: unknown) =>
      this.onUpdate(u, origin),
    );
    this.stats.loadMs = now() - t0;
    this.stats.loadedSnapshotBytes = snap?.data.byteLength ?? 0;
    this.stats.loadedRows = rows.length;
    this.stats.wakes++;
  }

  private onUpdate(update: Uint8Array, origin: unknown) {
    this.persist(update);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.broadcast(encoding.toUint8Array(enc), origin);
  }

  private broadcast(msg: Uint8Array, except: unknown) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        // closed socket; webSocketClose cleans up
      }
    }
  }

  private persist(update: Uint8Array) {
    if (this.flushMs <= 0) {
      this.insertRow(update);
      return;
    }
    this.pending.push(update);
    if (Date.now() - this.lastFlush >= this.flushMs) this.flush();
    else if (!this.alarmSet) {
      this.alarmSet = true;
      void this.ctx.storage.setAlarm(Date.now() + this.flushMs);
    }
  }

  private flush() {
    if (this.pending.length === 0) return;
    const merged =
      this.pending.length === 1
        ? (this.pending[0] as Uint8Array)
        : Y.mergeUpdates(this.pending);
    this.pending = [];
    this.lastFlush = Date.now();
    this.insertRow(merged);
  }

  private insertRow(update: Uint8Array) {
    this.sql.exec("INSERT INTO updates (data) VALUES (?)", update);
    this.stats.rowsWritten++;
    if (++this.rowsSinceCompact >= this.compactRows) this.compact();
  }

  /** One snapshot row replaces the snapshot and every update row. */
  compact() {
    const t0 = now();
    this.pending = [];
    const snap = Y.encodeStateAsUpdate(this.doc);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT OR REPLACE INTO snapshot (id, data) VALUES (1, ?)",
        snap,
      );
      this.sql.exec("DELETE FROM updates");
    });
    this.rowsSinceCompact = 0;
    this.stats.rowsWritten++;
    this.stats.compactions++;
    this.stats.lastCompactMs = now() - t0;
    return snap.byteLength;
  }

  override async alarm() {
    this.alarmSet = false;
    this.flush();
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const op = url.pathname.split("/")[3] ?? "";
    switch (op) {
      case "ws":
        return this.accept(url.searchParams.get("ro") === "1");
      case "seed":
        return this.seed(new Uint8Array(await req.arrayBuffer()));
      case "compact": {
        const bytes = this.compact();
        return Response.json({ ms: this.stats.lastCompactMs, bytes });
      }
      case "edit":
        return this.edit((await req.json()) as Op[]);
      case "stats":
        return Response.json(this.snapshotStats());
      case "evict":
        // Drops the in-memory object so the next request runs the
        // constructor (and load) again: a cold wake without an isolate start.
        this.ctx.abort("evict");
        return new Response("unreachable");
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private snapshotStats() {
    const rows = this.sql
      .exec<{ n: number; b: number }>(
        "SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS b FROM updates",
      )
      .one();
    return {
      ...this.stats,
      updateRows: rows.n,
      updateRowBytes: rows.b,
      stateBytes: Y.encodeStateAsUpdate(this.doc).byteLength,
      textChars: textIndex(this.doc).text.length,
      sockets: this.ctx.getWebSockets().length,
      sqlBytes: this.ctx.storage.sql.databaseSize,
    };
  }

  /** Bench only: body = u32 snapLen, snap, then (u32 len, update)*. */
  private seed(body: Uint8Array) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let off = 0;
    const take = () => {
      const len = dv.getUint32(off, true);
      off += 4;
      const part = body.subarray(off, off + len);
      off += len;
      return part;
    };
    const snap = take();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM updates");
      this.sql.exec("DELETE FROM snapshot");
      if (snap.byteLength > 0)
        this.sql.exec("INSERT INTO snapshot (id, data) VALUES (1, ?)", snap);
      while (off < body.byteLength)
        this.sql.exec("INSERT INTO updates (data) VALUES (?)", take());
    });
    return Response.json({ ok: true });
  }

  private edit(ops: Op[]) {
    const t0 = now();
    try {
      const applied = editDoc(this.doc, ops, "agent");
      return Response.json({ applied, ms: now() - t0 });
    } catch (e) {
      if (e instanceof EditError)
        return Response.json({ error: e.code, op: e.op }, { status: 409 });
      throw e;
    }
  }

  private accept(ro: boolean) {
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ro, aw: [] } satisfies Attachment);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    server.send(encoding.toUint8Array(enc));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketMessage(ws: WebSocket, data: ArrayBuffer | string) {
    if (typeof data === "string") return;
    const t0 = now();
    const msg = new Uint8Array(data);
    const dec = decoding.createDecoder(msg);
    const type = decoding.readVarUint(dec);
    const att = ws.deserializeAttachment() as Attachment;
    if (type === MSG_SYNC) {
      const sub = decoding.peekVarUint(dec);
      // Read-only sockets may ask for state (step 1) but never write.
      if (att.ro && sub !== syncProtocol.messageYjsSyncStep1) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      const ids = awarenessClientIds(msg);
      const fresh = ids.filter((id) => !att.aw.includes(id));
      if (fresh.length > 0) {
        att.aw.push(...fresh);
        ws.serializeAttachment(att);
      }
      this.broadcast(msg, ws);
    }
    const ms = now() - t0;
    this.stats.msgs++;
    this.stats.msgMsTotal += ms;
    if (ms > this.stats.msgMsMax) this.stats.msgMsMax = ms;
  }

  override webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.aw.length === 0) return;
    // Tell everyone the closed socket's cursors are gone (state "null").
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, att.aw.length);
    for (const id of att.aw) {
      encoding.writeVarUint(inner, id);
      encoding.writeVarUint(inner, 0xffffffff);
      encoding.writeVarString(inner, "null");
    }
    encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
    this.broadcast(encoding.toUint8Array(enc), ws);
  }
}

/** Client ids in an awareness message, without keeping awareness state. */
function awarenessClientIds(msg: Uint8Array): number[] {
  const outer = decoding.createDecoder(msg);
  decoding.readVarUint(outer);
  const dec = decoding.createDecoder(decoding.readVarUint8Array(outer));
  const n = decoding.readVarUint(dec);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(decoding.readVarUint(dec));
    decoding.readVarUint(dec);
    decoding.readVarString(dec);
  }
  return ids;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const name = new URL(req.url).pathname.split("/")[2];
    if (!name) return new Response("room name required", { status: 400 });
    return env.ROOM.get(env.ROOM.idFromName(name)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
