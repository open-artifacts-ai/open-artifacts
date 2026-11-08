/**
 * Node stand-ins for the Worker's bindings, for the CPU bench (scripts/bench.ts).
 *
 * Local workerd reports cpuTime = 0 to tail consumers, and performance.now()
 * does not advance during synchronous work there, so the bench runs the real
 * Worker code in Node and meters it with the calling thread's CPU clock.
 * Work that happens outside the Worker isolate in production (D1's SQLite, R2)
 * is metered separately and subtracted; Durable Object work is metered into
 * its own bucket (a DO invocation has its own CPU budget).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// ------------------------------------------------------------- CPU metering

type Usage = { user: number; system: number };
const proc = process as unknown as {
  threadCpuUsage?: (prev?: Usage) => Usage;
};
/** CPU µs of the calling thread (process-wide before Node 23.9). */
export const cpuMicros: () => number = proc.threadCpuUsage
  ? () => {
      const u = (proc.threadCpuUsage as () => Usage)();
      return u.user + u.system;
    }
  : () => {
      const u = process.cpuUsage();
      return u.user + u.system;
    };
export const CLOCK = proc.threadCpuUsage
  ? "process.threadCpuUsage"
  : "process.cpuUsage";

/** Per-request counters: CPU outside the Worker isolate, and in the DO. */
export const meter = {
  external: 0,
  durableObject: 0,
  d1Queries: 0,
  d1RowsRead: 0,
  r2Ops: 0,
  doCalls: 0,
  reset() {
    this.external = 0;
    this.durableObject = 0;
    this.d1Queries = 0;
    this.d1RowsRead = 0;
    this.r2Ops = 0;
    this.doCalls = 0;
  },
};

/** Nested-safe: only the outermost bucket accrues, and inner time is not double counted. */
let depth = 0;
function metered<T>(bucket: "external" | "durableObject", fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  const t = cpuMicros();
  try {
    return fn();
  } finally {
    meter[bucket] += cpuMicros() - t;
    depth--;
  }
}

/**
 * Meters `fn` as a DO invocation of its own (e.g. an alarm): its CPU minus
 * D1/R2 shim time goes to the DO bucket.
 */
export async function meterDo<T>(fn: () => Promise<T>): Promise<T> {
  const t = cpuMicros();
  const e = meter.external;
  try {
    return await fn();
  } finally {
    meter.durableObject += cpuMicros() - t - (meter.external - e);
  }
}

// ----------------------------------------------------------------------- D1

type Param = string | number | bigint | null | Uint8Array;
function param(v: unknown): Param {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: undefined bind");
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as Param;
}

class D1Stmt {
  constructor(
    private db: D1Shim,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new D1Stmt(this.db, this.sql, args.map(param));
  }
  private stmt(): StatementSync {
    return this.db.sqlite.prepare(this.sql);
  }
  run() {
    return Promise.resolve(this.db.exec(() => this.runSync()));
  }
  runSync() {
    meter.d1Queries++;
    const s = this.stmt();
    const cols = s.columns();
    if (cols.length) {
      const rows = s.all(...this.params) as Record<string, unknown>[];
      meter.d1RowsRead += rows.length;
      return { success: true, results: rows, meta: { changes: 0 } };
    }
    const r = s.run(...this.params);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(r.changes),
        last_row_id: Number(r.lastInsertRowid),
      },
    };
  }
  all() {
    return this.run();
  }
  first(col?: string) {
    return this.run().then((r) => {
      const row = r.results[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return col ? (row[col] ?? null) : row;
    });
  }
  raw(opts?: { columnNames?: boolean }) {
    return Promise.resolve(
      this.db.exec(() => {
        meter.d1Queries++;
        const s = this.stmt();
        const names = s.columns().map((c) => c.name);
        s.setReturnArrays(true);
        let rows: unknown[][] = [];
        if (names.length)
          rows = s.all(...this.params) as unknown as unknown[][];
        else s.run(...this.params);
        meter.d1RowsRead += rows.length;
        return opts?.columnNames ? [names, ...rows] : rows;
      }),
    );
  }
}

export class D1Shim {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor(migrationsDir: string) {
    for (const f of readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      this.sqlite.exec(readFileSync(path.join(migrationsDir, f), "utf8"));
  }
  exec<T>(fn: () => T): T {
    return metered("external", fn);
  }
  prepare(sql: string) {
    return new D1Stmt(this, sql);
  }
  async batch(stmts: D1Stmt[]) {
    return this.exec(() => {
      this.sqlite.exec("begin");
      try {
        const out = stmts.map((s) => s.runSync());
        this.sqlite.exec("commit");
        return out;
      } catch (e) {
        this.sqlite.exec("rollback");
        throw e;
      }
    });
  }
}

// ----------------------------------------------------------------------- R2

/** R2 bodies arrive in chunks; 64 KiB matches what the runtime hands JS. */
const CHUNK = 64 * 1024;
const toStream = (b: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += CHUNK)
        c.enqueue(b.subarray(i, i + CHUNK));
      c.close();
    },
  });

export class R2Shim {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string }
  >();
  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | string | ReadableStream,
    opts?: { httpMetadata?: { contentType?: string } },
  ) {
    meter.r2Ops++;
    // Upload PUTs stream (bench setup only).
    if (value instanceof ReadableStream)
      value = new Uint8Array(await new Response(value).arrayBuffer());
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.objects.set(key, {
      bytes,
      contentType: opts?.httpMetadata?.contentType,
    });
    return { key, size: bytes.length };
  }
  async get(
    key: string,
    opts?: { range?: { offset: number; length: number } },
  ) {
    meter.r2Ops++;
    const o = this.objects.get(key);
    if (!o) return null;
    const b = opts?.range
      ? o.bytes.subarray(
          opts.range.offset,
          opts.range.offset + opts.range.length,
        )
      : o.bytes;
    return {
      key,
      size: o.bytes.length,
      body: toStream(b),
      httpMetadata: { contentType: o.contentType },
      text: async () => new TextDecoder().decode(b),
      arrayBuffer: async () => b.slice().buffer,
    };
  }
  async head(key: string) {
    meter.r2Ops++;
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.length } : null;
  }
  async delete(keys: string | string[]) {
    meter.r2Ops++;
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(opts: { prefix?: string; limit?: number } = {}) {
    meter.r2Ops++;
    const limit = opts.limit ?? 1000;
    const all = [...this.objects.keys()].filter((k) =>
      k.startsWith(opts.prefix ?? ""),
    );
    return {
      objects: all
        .slice(0, limit)
        .map((key) => ({ key, size: this.objects.get(key)?.bytes.length })),
      truncated: all.length > limit,
    };
  }
}

// --------------------------------------------------------------------- KV

export class KVShim {
  private m = new Map<string, string>();
  async get(k: string, type?: string) {
    const v = this.m.get(k) ?? null;
    return v !== null && type === "json" ? JSON.parse(v) : v;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list() {
    return {
      keys: [...this.m.keys()].map((name) => ({ name })),
      list_complete: true,
    };
  }
}

// ---------------------------------------------------------- Durable Objects

/** A hibernated socket: send() only counts bytes (the copy is native in workerd). */
export class FakeSocket {
  sent = 0;
  frames = 0;
  constructor(readonly tags: string[]) {}
  send(m: string) {
    this.sent += m.length;
    this.frames++;
  }
  close() {}
}

class SqlStorageShim {
  constructor(private db: DatabaseSync) {}
  exec(query: string, ...bindings: unknown[]) {
    const q = query.trim();
    if (bindings.length === 0 && /;\s*\S/.test(q)) {
      this.db.exec(q);
      return cursor([]);
    }
    const s = this.db.prepare(q);
    const ps = bindings.map(param);
    if (s.columns().length)
      return cursor(s.all(...ps) as Record<string, unknown>[]);
    s.run(...ps);
    return cursor([]);
  }
}
function cursor(rows: Record<string, unknown>[]) {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1)
        throw new Error(`expected 1 row, got ${rows.length}`);
      return rows[0];
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
    rowsRead: rows.length,
    rowsWritten: 0,
  };
}

export class DOState {
  readonly db = new DatabaseSync(":memory:");
  readonly sockets: FakeSocket[] = [];
  alarm: number | null = null;
  readonly storage = {
    sql: new SqlStorageShim(this.db),
    getAlarm: async () => this.alarm,
    setAlarm: async (t: number) => {
      this.alarm = t;
    },
    deleteAlarm: async () => {
      this.alarm = null;
    },
    transactionSync: <T>(fn: () => T): T => {
      this.db.exec("savepoint t");
      try {
        const r = fn();
        this.db.exec("release t");
        return r;
      } catch (e) {
        this.db.exec("rollback to t");
        this.db.exec("release t");
        throw e;
      }
    },
    deleteAll: async () => {
      for (const { name } of this.db
        .prepare("select name from sqlite_master where type = 'table'")
        .all() as { name: string }[])
        this.db.exec(`drop table if exists "${name}"`);
    },
  };
  getWebSockets(tag?: string) {
    return tag === undefined
      ? this.sockets
      : this.sockets.filter((s) => s.tags.includes(tag));
  }
  acceptWebSocket(ws: FakeSocket, tags: string[]) {
    this.sockets.push(Object.assign(ws, { tags }));
  }
  getTags(ws: FakeSocket) {
    return ws.tags;
  }
  /** The runtime answers the presence ping itself; the node proxy has no such layer. */
  setWebSocketAutoResponse() {}
  waitUntil() {}
}

/** workerd global the DO constructor uses for its presence auto-response; Node has none. */
const g = globalThis as { WebSocketRequestResponsePair?: unknown };
g.WebSocketRequestResponsePair ??= class {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
};

type DOClass = new (state: DOState, env: unknown) => Record<string, unknown>;

/**
 * DurableObjectNamespace over in-process instances. RPC arguments and
 * results are structured-cloned (as the runtime serializes them), and the
 * method body is metered into the DO bucket.
 */
export class DONamespaceShim {
  readonly instances = new Map<
    string,
    { state: DOState; obj: Record<string, unknown> }
  >();
  constructor(
    private cls: DOClass,
    private env: () => unknown,
  ) {}
  idFromName(name: string) {
    return { name, toString: () => name };
  }
  instance(name: string) {
    let i = this.instances.get(name);
    if (!i) {
      const state = new DOState();
      i = { state, obj: new this.cls(state, this.env()) };
      this.instances.set(name, i);
    }
    return i;
  }
  get(id: { name: string }) {
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "then") return undefined;
          return async (...args: unknown[]) => {
            meter.doCalls++;
            const a = structuredClone(args);
            const { obj } = this.instance(id.name);
            const fn = obj[prop as string] as (...x: unknown[]) => unknown;
            const r = await metered("durableObject", () => fn.apply(obj, a));
            return structuredClone(r);
          };
        },
      },
    );
  }
}

// ----------------------------------------------------------- globals, ctx

/** Workers-only globals the code paths under test touch. */
export function installGlobals() {
  const g = globalThis as Record<string, unknown>;
  g.IdentityTransformStream ??= class extends TransformStream {};
  // workerd has the native TC39 Uint8Array.fromBase64 (planFiles uses it when
  // present); Node 24 doesn't, and the atob loop fallback is ~15× slower.
  const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
  // Buffer's decoder is native too, but lenient: validation is not modelled.
  U.fromBase64 ??= (s: string) => {
    const b = Buffer.from(s, "base64");
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  };
  g.WebSocketPair ??= class {
    0 = new FakeSocket([]);
    1 = new FakeSocket([]);
  };
}

export function execCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
      props: {},
    },
    /** waitUntil work runs on the request's CPU budget: settle it all. */
    settle: async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}
