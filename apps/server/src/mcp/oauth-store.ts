import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

// The OAuth provider's store, per install (post-M1 OAuth store move). The
// library (@cloudflare/workers-oauth-provider, pinned) only ever reads
// `env.OAUTH_KV` from the env it is handed and has no storage option, so the
// seams pass `oauthEnv(env)`: `{ ...env, OAUTH_KV: store }`, where `store` is
// KV-shaped (get text/json, put with expirationTtl/expiration/metadata,
// delete, list with prefix/limit/cursor/metadata).
//
// OAUTH_STORE, one setting per install:
// - kv (default, unset): today's behaviour, the OAUTH_KV binding.
// - dual: writes and deletes go to D1 and KV; get reads D1, then KV on a
//   miss; list merges both by key (D1 wins), so a grant held only in KV is
//   still listed and revoked.
// - d1: the install's own D1 table oauth_kv only; OAUTH_KV may be unbound.
//
// D1 has no read replicas here (no Sessions API), so a write is visible to
// the next read from anywhere: #769 (a refresh right after the exchange read
// the pre-redeem grant from KV's edge cache) and the post-revocation window
// both close.
//
// Expiry: every read (get and list) treats a row at or past expires_at as
// missing; the nightly cron deletes such rows in bounded batches. A delete
// leaves a tombstone (tombstoneOf) so D1 keeps deciding over KV's copy.
//
// Queries: one store per request (per seam call). It remembers what a list
// or get read, for the rest of that request (CACHE_MS at most), widens a
// grant's token listing to the user's, and batches same-tick deletes into
// one statement, so the provider's list-then-get-each and delete-each stay
// under D1's 50 queries per invocation on Workers Free.
//
// Rollback: dual -> kv loses nothing (KV took every write). kv mode empties
// oauth_kv before its first KV write (markerStmts), so going forward again
// starts dual from an empty table and a fresh copy.

export type OAuthStoreMode = "kv" | "dual" | "d1";
const MODES: readonly OAuthStoreMode[] = ["kv", "dual", "d1"];

/** A broken OAUTH_STORE setting or a missing binding: fails clearly. */
export class OAuthStoreConfigError extends Error {
  override name = "OAuthStoreConfigError";
}

/** OAUTH_STORE's mode (unset or empty: kv); null for any other value. */
export function parseOAuthStoreMode(
  raw: string | undefined,
): OAuthStoreMode | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "kv";
  return MODES.find((m) => m === v) ?? null;
}

/** OAUTH_STORE's mode; throws OAuthStoreConfigError on any other value. */
export function oauthStoreMode(env: Pick<Env, "OAUTH_STORE">): OAuthStoreMode {
  const m = parseOAuthStoreMode(env.OAUTH_STORE);
  if (!m)
    throw new OAuthStoreConfigError(
      `OAUTH_STORE must be one of ${MODES.join(", ")}`,
    );
  return m;
}

/** The env the OAuth library sees: OAUTH_KV is always a store. */
export type OAuthEnv = Env & { OAUTH_KV: KVNamespace };

/**
 * `env` with OAUTH_KV set to this install's store (a new one, with its own
 * per-request cache, unless `env` already carries one). kv mode returns the
 * binding wrapped only to clear the D1 markers once per isolate before its
 * first KV write (markers below). Throws OAuthStoreConfigError when the mode
 * is invalid, or is kv or dual with no OAUTH_KV binding.
 */
export function oauthEnv(env: Env): OAuthEnv {
  const kv = env.OAUTH_KV;
  if (kv instanceof StoreBase) return env as OAuthEnv;
  const mode = oauthStoreMode(env);
  if (mode !== "d1" && !kv)
    throw new OAuthStoreConfigError(
      `OAUTH_STORE=${mode} needs the OAUTH_KV binding`,
    );
  const store =
    mode === "kv"
      ? new KvModeStore(kv as KVNamespace, env.DB)
      : mode === "d1"
        ? new D1KvStore(env.DB)
        : new DualKvStore(new D1KvStore(env.DB), kv as KVNamespace);
  return { ...env, OAUTH_KV: store as unknown as KVNamespace };
}

// ---------------------------------------------------------------- shared

/** Unix seconds. */
const nowS = () => Math.floor(Date.now() / 1000);

/** KV's list page maximum (the provider's MAX_KV_LIST_LIMIT). */
export const MAX_LIST_LIMIT = 1000;
/** How long a request trusts what it already read (ms). */
const CACHE_MS = 5_000;
/** Rows one snapshot query may hold (a user's grants or tokens). */
const SNAPSHOT_MAX = 1000;
/** Keys per statement that takes a JSON array of keys (json_each). */
const KEYS_CHUNK = 500;

type Row = {
  key: string;
  value: string;
  expires_at: number | null;
  metadata: string | null;
};

type GetType = "text" | "json";
type GetOpt = GetType | { type?: GetType; cacheTtl?: number } | undefined;
type PutOpt = {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
};
type ListOpt = {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
};
type ListKey = { name: string; expiration?: number; metadata?: unknown };
type ListResult =
  | { keys: ListKey[]; list_complete: false; cursor: string; cacheStatus: null }
  | { keys: ListKey[]; list_complete: true; cacheStatus: null };

const live = (r: { expires_at: number | null }, now: number) =>
  r.expires_at === null || r.expires_at > now;

const typeOf = (opt: GetOpt): GetType => {
  const t = typeof opt === "string" ? opt : (opt?.type ?? "text");
  if (t !== "text" && t !== "json")
    throw new TypeError(`oauth store: unsupported get type ${String(t)}`);
  return t;
};

const decode = (v: string | null, t: GetType): unknown =>
  v === null ? null : t === "json" ? JSON.parse(v) : v;

/**
 * KV's list order: UTF-8 byte order, which is code point order (and SQLite's
 * BINARY collation on UTF-8 text). JS `<` compares UTF-16 code units, which
 * differs only where a surrogate meets a code unit above it.
 */
export function keyCompare(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** The least string above every string that starts with `prefix` (non-empty). */
function prefixEnd(prefix: string): string {
  const cps = Array.from(prefix);
  const last = cps.pop() as string;
  const cp = (last.codePointAt(0) as number) + 1;
  // Skip the surrogate block: those code points have no UTF-8 form.
  return cps.join("") + String.fromCodePoint(cp === 0xd800 ? 0xe000 : cp);
}

/** Opaque, like KV's: the last key returned. */
const encodeCursor = (key: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(key)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function decodeCursor(cursor: string): string {
  try {
    const b = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(b, (c) => c.charCodeAt(0)),
    );
  } catch {
    throw new TypeError("oauth store: invalid list cursor");
  }
}

/**
 * A provider list prefix widened to the user: `token:<u>:<g>:` (revokeGrant,
 * once per grant) reads `token:<u>:` once, so revoking many grants costs one
 * list query, not one per grant.
 */
const widen = (prefix: string) =>
  /^[^:]*:[^:]*:[^:]*:$/.test(prefix)
    ? prefix.slice(0, prefix.indexOf(":", prefix.indexOf(":") + 1) + 1)
    : prefix;

const clampLimit = (limit: number | undefined) => {
  const n = Math.floor(limit ?? MAX_LIST_LIMIT);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_LIST_LIMIT) : 1000;
};

const toListKey = (r: Row): ListKey => ({
  name: r.key,
  ...(r.expires_at !== null ? { expiration: r.expires_at } : {}),
  ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) } : {}),
});

/** One list page, in key order; `more`: a next page may hold keys. */
function listResult(keys: ListKey[], more: boolean): ListResult {
  const last = keys[keys.length - 1];
  if (!more || !last) return { keys, list_complete: true, cacheStatus: null };
  return {
    keys,
    list_complete: false,
    cursor: encodeCursor(last.name),
    cacheStatus: null,
  };
}

/**
 * D1 overload or busy as the KV 429 the library already treats as retryable
 * (isKvRateLimitError matches "429 Too Many Requests": OAuth
 * temporarily_unavailable, not a 500).
 */
const BUSY =
  /overloaded|too many requests|SQLITE_BUSY|database is locked|\bbusy\b/i;
export function mapStoreError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (!BUSY.test(msg) || /429 Too Many Requests/i.test(msg)) return e;
  return new Error(`oauth_kv D1 failed: 429 Too Many Requests (${msg})`, {
    cause: e,
  });
}

abstract class StoreBase {}

// ---------------------------------------------------------------- d1

/**
 * A deleted key, in dual and d1 modes: a row whose expires_at is minus the
 * deletion time (unix s). Every read treats it as missing, like an expired
 * row, and it keeps D1 deciding: a dual get never falls back to KV for it,
 * a dual list drops KV's copy, and the backfill's insert-or-ignore can't
 * bring it back. The nightly sweep removes it after TOMBSTONE_DAYS.
 */
const tombstoneOf = (key: string, now: number): Row => ({
  key,
  value: "",
  expires_at: -now,
  metadata: null,
});

const GET =
  "select key, value, expires_at, metadata from oauth_kv where key = ?";
const PUT =
  "insert into oauth_kv (key, value, expires_at, metadata) values (?, ?, ?, ?) on conflict(key) do update set value = excluded.value, expires_at = excluded.expires_at, metadata = excluded.metadata";
/** Every row under a prefix (live or not), for a snapshot. */
const SNAP =
  "select key, value, expires_at, metadata from oauth_kv where key >= ? and key < ? order by key limit ?";
const SNAP_ALL =
  "select key, value, expires_at, metadata from oauth_kv order by key limit ?";
/** Live rows under a prefix after a key (a page past a snapshot's reach). */
const RANGE =
  "select key, value, expires_at, metadata from oauth_kv where key >= ? and key < ? and key > ? and (expires_at is null or expires_at > ?) order by key limit ?";
const RANGE_ALL =
  "select key, value, expires_at, metadata from oauth_kv where key > ? and (expires_at is null or expires_at > ?) order by key limit ?";
/** Rows for a JSON array of keys. */
const BY_KEYS =
  "select key, value, expires_at, metadata from oauth_kv where key in (select value from json_each(?))";
const DELETE_KEYS =
  "delete from oauth_kv where key in (select value from json_each(?))";
const TOMBSTONE_KEYS =
  "insert into oauth_kv (key, value, expires_at, metadata) select value, '', ?, null from json_each(?) where true on conflict(key) do update set value = '', expires_at = excluded.expires_at, metadata = null";

type Pending = { key: string; done: () => void; fail: (e: unknown) => void };

/** KV-shaped store over the install's D1 table oauth_kv; one per request. */
export class D1KvStore extends StoreBase {
  /** key -> row (null: no row), with when it was read. Rows may be dead. */
  private readonly rows = new Map<string, { r: Row | null; at: number }>();
  /** Complete snapshots of every row (dead ones too) under a prefix. */
  private readonly snaps: {
    prefix: string;
    rows: Map<string, Row>;
    at: number;
  }[] = [];
  /** Snapshot queries in flight, by prefix. */
  private readonly loading = new Map<string, Promise<Row[]>>();
  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly db: D1Database) {
    super();
  }

  private fresh(at: number) {
    return Date.now() - at <= CACHE_MS;
  }

  /** The cached row (null: no row) or undefined (unknown). */
  private cached(key: string): Row | null | undefined {
    const c = this.rows.get(key);
    if (c && this.fresh(c.at)) return c.r;
    const s = this.snaps.find(
      (x) => key.startsWith(x.prefix) && this.fresh(x.at),
    );
    return s ? (s.rows.get(key) ?? null) : undefined;
  }

  private remember(key: string, r: Row | null) {
    this.rows.set(key, { r, at: Date.now() });
    for (const s of this.snaps)
      if (key.startsWith(s.prefix)) {
        if (r) s.rows.set(key, r);
        else s.rows.delete(key);
      }
  }

  /** Runs a query after any pending deletes, mapping overload errors. */
  private async q<T>(run: () => Promise<T>): Promise<T> {
    await this.flush();
    try {
      return await run();
    } catch (e) {
      throw mapStoreError(e);
    }
  }

  /** D1's row for `key`, live or not (null: none). */
  async row(key: string): Promise<Row | null> {
    const c = this.cached(key);
    if (c !== undefined) return c;
    const r =
      (await this.q(() => stmt(this.db, GET).bind(key).first<Row>())) ?? null;
    this.remember(key, r);
    return r;
  }

  /** D1's rows for `keys`, live or not (absent: none); cached where known. */
  async rowsFor(keys: readonly string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const unknown: string[] = [];
    for (const k of keys) {
      const c = this.cached(k);
      if (c === undefined) unknown.push(k);
      else if (c) out.set(k, c);
    }
    for (let i = 0; i < unknown.length; i += KEYS_CHUNK) {
      const chunk = unknown.slice(i, i + KEYS_CHUNK);
      const got = await this.q(async () =>
        stmt(this.db, BY_KEYS).bind(JSON.stringify(chunk)).all<Row>(),
      );
      const found = new Map(got.results.map((r) => [r.key, r]));
      for (const k of chunk) {
        const r = found.get(k) ?? null;
        this.remember(k, r);
        if (r) out.set(k, r);
      }
    }
    return out;
  }

  async get(key: string, opt?: GetOpt): Promise<unknown> {
    const t = typeOf(opt);
    const r = await this.row(key);
    return decode(r && live(r, nowS()) ? r.value : null, t);
  }

  async put(key: string, value: unknown, opt?: PutOpt): Promise<void> {
    if (typeof value !== "string")
      throw new TypeError("oauth store: values are strings");
    const expires_at =
      opt?.expiration != null
        ? Math.floor(opt.expiration)
        : opt?.expirationTtl != null
          ? nowS() + Math.floor(opt.expirationTtl)
          : null;
    const metadata =
      opt?.metadata == null ? null : JSON.stringify(opt.metadata);
    await this.q(() =>
      stmt(this.db, PUT).bind(key, value, expires_at, metadata).run(),
    );
    this.remember(key, { key, value, expires_at, metadata });
  }

  /**
   * A tombstone (tombstoneOf). Batched: the deletes of one tick share one
   * statement per KEYS_CHUNK keys, written before this store's next query.
   */
  delete(key: string): Promise<void> {
    this.remember(key, tombstoneOf(key, nowS()));
    return new Promise((done, fail) => {
      this.pending.push({ key, done, fail });
      this.timer ??= setTimeout(() => void this.flush().catch(() => {}), 0);
    });
  }

  /** Writes the pending deletes; resolves once every earlier one landed. */
  flush(): Promise<void> {
    const batch = this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (batch.length === 0) return this.flushing.catch(() => {});
    this.pending = [];
    const keys = [...new Set(batch.map((p) => p.key))];
    const now = nowS();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < keys.length; i += KEYS_CHUNK)
      stmts.push(
        stmt(this.db, TOMBSTONE_KEYS).bind(
          -now,
          JSON.stringify(keys.slice(i, i + KEYS_CHUNK)),
        ),
      );
    const run = this.flushing
      .catch(() => {})
      .then(async () => {
        try {
          if (stmts.length === 1) await (stmts[0] as D1PreparedStatement).run();
          else await this.db.batch(stmts);
        } catch (e) {
          throw mapStoreError(e);
        }
      });
    this.flushing = run.then(
      () => {
        for (const p of batch) p.done();
      },
      (e) => {
        for (const p of batch) p.fail(e);
        throw e;
      },
    );
    return this.flushing;
  }

  /**
   * Up to `n` live rows under `prefix` after `after`, in key order, and
   * whether more may follow. From a snapshot when one covers the prefix,
   * else one query: widened to the user's prefix and kept as a snapshot
   * when it fits, else a page.
   */
  async listRows(
    prefix: string,
    after: string,
    n: number,
  ): Promise<{ rows: Row[]; more: boolean }> {
    const now = nowS();
    const pick = (rows: Iterable<Row>) => {
      const all = [...rows]
        .filter(
          (r) =>
            r.key.startsWith(prefix) &&
            keyCompare(r.key, after) > 0 &&
            live(r, now),
        )
        .sort((a, b) => keyCompare(a.key, b.key));
      return { rows: all.slice(0, n), more: all.length > n };
    };
    const covering = this.snaps.find(
      (s) => prefix.startsWith(s.prefix) && this.fresh(s.at),
    );
    if (covering) return pick(covering.rows.values());
    const wide = widen(prefix);
    // Concurrent lists under one prefix (revokeGrant per grant, in
    // parallel) share one query.
    let load = this.loading.get(wide);
    if (!load) {
      const started = Date.now();
      load = this.q(async () => {
        const s =
          wide === ""
            ? stmt(this.db, SNAP_ALL).bind(SNAPSHOT_MAX + 1)
            : stmt(this.db, SNAP).bind(wide, prefixEnd(wide), SNAPSHOT_MAX + 1);
        return (await s.all<Row>()).results;
      }).then((got) => {
        if (got.length <= SNAPSHOT_MAX) {
          const rows = new Map(got.map((r) => [r.key, r]));
          // This request's own writes since the query began win.
          for (const [k, c] of this.rows)
            if (c.at >= started && k.startsWith(wide)) {
              if (c.r) rows.set(k, c.r);
              else rows.delete(k);
            }
          this.snaps.push({ prefix: wide, rows, at: Date.now() });
          for (const r of got)
            if (!((this.rows.get(r.key)?.at ?? -1) >= started))
              this.rows.set(r.key, { r, at: Date.now() });
        }
        return got;
      });
      this.loading.set(wide, load);
      void load.then(
        () => this.loading.delete(wide),
        () => this.loading.delete(wide),
      );
    }
    const got = await load;
    if (got.length <= SNAPSHOT_MAX) {
      const snap = this.snaps.find((s) => s.prefix === wide);
      return pick((snap?.rows ?? new Map<string, Row>()).values());
    }
    const page = await this.q(async () => {
      const s =
        prefix === ""
          ? stmt(this.db, RANGE_ALL).bind(after, now, n + 1)
          : stmt(this.db, RANGE).bind(
              prefix,
              prefixEnd(prefix),
              after,
              now,
              n + 1,
            );
      return (await s.all<Row>()).results;
    });
    for (const r of page) this.rows.set(r.key, { r, at: Date.now() });
    return { rows: page.slice(0, n), more: page.length > n };
  }

  async list(opt?: ListOpt): Promise<ListResult> {
    const limit = clampLimit(opt?.limit);
    const after = opt?.cursor ? decodeCursor(opt.cursor) : "";
    const { rows, more } = await this.listRows(opt?.prefix ?? "", after, limit);
    return listResult(rows.map(toListKey), more);
  }
}

// ---------------------------------------------------------------- dual

/** Upper bound on KV pages one dual list walks to reach its cursor. */
const MAX_KV_PAGES = 20;

/**
 * Writes and deletes to D1 and KV; get from D1, else KV; list merges both by
 * key, D1 winning. D1 decides whenever it holds a row: a dead one (expired
 * or deleted) hides KV's copy. KV lists can't start after a key, so a dual
 * list walks KV's pages from the start of the prefix to its cursor (a
 * user's grants and tokens: one page).
 */
export class DualKvStore extends StoreBase {
  constructor(
    private readonly d1: D1KvStore,
    private readonly kv: KVNamespace,
  ) {
    super();
  }

  async get(key: string, opt?: GetOpt): Promise<unknown> {
    const t = typeOf(opt);
    const r = await this.d1.row(key);
    if (r) return decode(live(r, nowS()) ? r.value : null, t);
    return decode(await this.kv.get(key, "text"), t);
  }

  async put(key: string, value: unknown, opt?: PutOpt): Promise<void> {
    await Promise.all([
      this.d1.put(key, value, opt),
      this.kv.put(key, value as string, opt as KVNamespacePutOptions),
    ]);
  }

  async delete(key: string): Promise<void> {
    await Promise.all([this.d1.delete(key), this.kv.delete(key)]);
  }

  async list(opt?: ListOpt): Promise<ListResult> {
    const limit = clampLimit(opt?.limit);
    const prefix = opt?.prefix ?? "";
    const after = opt?.cursor ? decodeCursor(opt.cursor) : "";
    const [d1, kv] = await Promise.all([
      this.d1.listRows(prefix, after, limit),
      this.kvAfter(prefix, after, limit),
    ]);
    const merged = new Map<string, ListKey>();
    const d1Keys = new Set(d1.rows.map((r) => r.key));
    const kvOnly = kv.keys.filter((k) => !d1Keys.has(k.name));
    // D1 decides a KV-only key it holds a row for (dead: dropped).
    const known = await this.d1.rowsFor(kvOnly.map((k) => k.name));
    const now = nowS();
    for (const k of kvOnly) {
      const r = known.get(k.name);
      if (!r) merged.set(k.name, k);
      else if (live(r, now)) merged.set(k.name, toListKey(r));
    }
    for (const r of d1.rows) merged.set(r.key, toListKey(r));
    const all = [...merged.values()].sort((a, b) => keyCompare(a.name, b.name));
    return listResult(
      all.slice(0, limit),
      all.length > limit || d1.more || kv.more,
    );
  }

  /** Up to `n` KV keys under `prefix` after `after`, in key order. */
  private async kvAfter(
    prefix: string,
    after: string,
    n: number,
  ): Promise<{ keys: ListKey[]; more: boolean }> {
    const out: ListKey[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_KV_PAGES; page++) {
      const r = await this.kv.list({
        prefix,
        limit: MAX_LIST_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      for (const k of r.keys)
        if (keyCompare(k.name, after) > 0)
          out.push({
            name: k.name,
            ...(k.expiration !== undefined ? { expiration: k.expiration } : {}),
            ...(k.metadata !== undefined ? { metadata: k.metadata } : {}),
          });
      if (out.length > n) return { keys: out.slice(0, n), more: true };
      if (r.list_complete) return { keys: out, more: false };
      cursor = r.cursor;
    }
    throw new Error("oauth store: KV listing too long for a dual list");
  }
}

// ---------------------------------------------------------------- kv

/**
 * kv mode: the binding as is, except that before its first write or delete
 * in this isolate the D1 side is reset (markerStmts "kv": KV writes resumed,
 * so oauth_kv and its markers are stale).
 */
class KvModeStore extends StoreBase {
  constructor(
    private readonly kv: KVNamespace,
    private readonly db: D1Database,
  ) {
    super();
  }
  get(key: string, opt?: GetOpt) {
    return this.kv.get(key, opt as "text");
  }
  async put(key: string, value: string, opt?: KVNamespacePutOptions) {
    await syncMarkersOnce(this.db, "kv");
    return this.kv.put(key, value, opt);
  }
  async delete(key: string) {
    await syncMarkersOnce(this.db, "kv");
    return this.kv.delete(key);
  }
  list(opt?: KVNamespaceListOptions) {
    return this.kv.list(opt);
  }
}

// ---------------------------------------------------------------- markers

/** settings: when a full KV -> D1 copy last completed (epoch ms). */
export const BACKFILLED_KEY = "oauth_store_backfilled";
/** settings: when this install first served in d1 mode (epoch ms). */
export const KV_WRITES_OFF_KEY = "oauth_kv_writes_off_since";

const STAMP =
  "insert into settings (key, value) values (?, ?) on conflict(key) do nothing";
const CLEAR = "delete from settings where key = ?";
const CLEAR_BOTH = "delete from settings where key in (?, ?)";
const DROP_ROWS = "delete from oauth_kv";
const MARKERS = "select key, value from settings where key in (?, ?)";

/**
 * The marker writes for `mode`:
 * - d1 stamps KV_WRITES_OFF once (never moved forward while d1 lasts);
 * - dual clears it (KV writes resumed; the backfill stays valid: dual
 *   writes both stores);
 * - kv clears both and empties oauth_kv: from here D1 misses KV's writes and
 *   deletes, so a later dual start begins empty and needs a fresh copy (a
 *   stale row would win over KV, and could revive a revoked grant).
 */
function markerStmts(
  db: D1Database,
  mode: OAuthStoreMode,
  now: number,
): D1PreparedStatement[] {
  if (mode === "d1")
    return [stmt(db, STAMP).bind(KV_WRITES_OFF_KEY, String(now))];
  if (mode === "dual") return [stmt(db, CLEAR).bind(KV_WRITES_OFF_KEY)];
  return [
    stmt(db, CLEAR_BOTH).bind(BACKFILLED_KEY, KV_WRITES_OFF_KEY),
    stmt(db, DROP_ROWS),
  ];
}

/** The mode whose markers this isolate already wrote, per database. */
let synced = new WeakMap<D1Database, OAuthStoreMode>();

async function syncMarkersOnce(db: D1Database, mode: OAuthStoreMode) {
  if (synced.get(db) === mode) return;
  await db.batch(markerStmts(db, mode, Date.now()));
  synced.set(db, mode);
}

/** Tests: forget which markers this isolate wrote. */
export function resetOAuthStoreMarkers(): void {
  synced = new WeakMap();
}

/**
 * Every app-host request, once per isolate and mode: dual and d1 write their
 * markers (d1: "the first time the install serves in d1 mode"). kv writes
 * its markers lazily, before the first KV write (KvModeStore), so a
 * read-only kv request never touches D1. Throws OAuthStoreConfigError on a
 * bad mode or a missing binding.
 */
export async function syncStoreMarkers(env: Env): Promise<void> {
  const mode = oauthStoreMode(env);
  if (mode !== "d1" && !env.OAUTH_KV)
    throw new OAuthStoreConfigError(
      `OAUTH_STORE=${mode} needs the OAUTH_KV binding`,
    );
  if (mode === "kv") return;
  await syncMarkersOnce(env.DB, mode);
}

export type OAuthStoreHealth = {
  mode: OAuthStoreMode;
  backfilled: boolean;
  kvWritesOffSince: number | null;
};

/**
 * /healthz's oauthStore: writes this mode's markers unless this isolate
 * already did (so a rollback clears them here too, kv included), then reads
 * them, in one batch. kvWritesOffSince is null unless the mode is d1.
 */
export async function oauthStoreHealth(env: Env): Promise<OAuthStoreHealth> {
  const mode = oauthStoreMode(env);
  const writes =
    synced.get(env.DB) === mode ? [] : markerStmts(env.DB, mode, Date.now());
  const res = await env.DB.batch<{ key: string; value: string }>([
    ...writes,
    stmt(env.DB, MARKERS).bind(BACKFILLED_KEY, KV_WRITES_OFF_KEY),
  ]);
  synced.set(env.DB, mode);
  const read = res[writes.length]?.results ?? [];
  const m = new Map(read.map((r) => [r.key, r.value]));
  const off = Number(m.get(KV_WRITES_OFF_KEY));
  return {
    mode,
    backfilled: m.has(BACKFILLED_KEY),
    kvWritesOffSince: mode === "d1" && Number.isFinite(off) ? off : null,
  };
}

// ---------------------------------------------------------------- sweep

/** Expired rows deleted per statement, and statements per nightly run. */
const SWEEP_BATCH = 500;
const SWEEP_ROUNDS = 20;
/** How long a deleted key's tombstone outlives it (the backfill window). */
export const TOMBSTONE_DAYS = 30;
const SWEEP =
  "delete from oauth_kv where key in (select key from oauth_kv where expires_at is not null and ((expires_at >= 0 and expires_at <= ?) or (expires_at < 0 and expires_at >= ?)) limit ?)";

/**
 * Nightly: deletes rows past expires_at, and tombstones older than
 * TOMBSTONE_DAYS, SWEEP_BATCH per statement, at most SWEEP_ROUNDS
 * statements (reads already treat both as missing). Every mode: a table
 * left by dual or d1 still drains. Returns the rows deleted.
 */
export async function sweepOAuthStore(env: Env, now: number): Promise<number> {
  const at = Math.floor(now / 1000);
  const tombCutoff = at - TOMBSTONE_DAYS * 86_400;
  let total = 0;
  for (let i = 0; i < SWEEP_ROUNDS; i++) {
    const r = await stmt(env.DB, SWEEP)
      .bind(at, -tombCutoff, SWEEP_BATCH)
      .run();
    const n = r.meta.changes ?? 0;
    total += n;
    if (n < SWEEP_BATCH) break;
  }
  return total;
}

// ---------------------------------------------------------------- copy

export type CopyCounts = {
  /** Keys KV listed. */
  kvKeys: number;
  /** Rows inserted into D1 (keys D1 already held are left as they are). */
  copied: number;
  /** Keys expiring within MIN_COPY_TTL_S, or gone before their read. */
  skippedExpiring: number;
  /** Live oauth_kv rows after the pass. */
  d1Rows: number;
};

/** KV's minimum TTL: a key closer to expiry than this is not copied. */
const MIN_COPY_TTL_S = 60;
/** KV reads in flight, and inserts per D1 batch. */
const COPY_CHUNK = 50;
const COPY =
  "insert into oauth_kv (key, value, expires_at, metadata) values (?, ?, ?, ?) on conflict(key) do nothing";
const COUNT_LIVE =
  "select count(*) as n from oauth_kv where expires_at is null or expires_at > ?";
const MARK_BACKFILLED =
  "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value";

/**
 * The backfill's core (Platform's job calls it), in dual mode only: walks
 * KV (list, then get each) and inserts every key into D1 with its original
 * expiry and metadata, never overwriting a row D1 already holds (a newer
 * dual write, or a deleted key's tombstone). Idempotent: a rerun copies only
 * what is missing. When the pass completes it records BACKFILLED_KEY.
 * Refused in kv mode (D1 is reset there) and d1 mode (KV is stale: a copy
 * could revive what d1 deleted). Never logs or returns keys or values.
 */
export async function copyKvToD1(
  env: Env,
  now: number = Date.now(),
): Promise<CopyCounts> {
  const mode = oauthStoreMode(env);
  const kv = env.OAUTH_KV;
  if (mode !== "dual" || !kv)
    throw new OAuthStoreConfigError(
      "the KV -> D1 copy runs only with OAUTH_STORE=dual and OAUTH_KV bound",
    );
  const db = env.DB;
  const at = Math.floor(now / 1000);
  let kvKeys = 0;
  let copied = 0;
  let skippedExpiring = 0;
  let cursor: string | undefined;
  do {
    const page = await kv.list({
      limit: MAX_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    kvKeys += page.keys.length;
    const todo = page.keys.filter(
      (k) => k.expiration === undefined || k.expiration - at >= MIN_COPY_TTL_S,
    );
    skippedExpiring += page.keys.length - todo.length;
    for (let i = 0; i < todo.length; i += COPY_CHUNK) {
      const chunk = todo.slice(i, i + COPY_CHUNK);
      const values = await Promise.all(
        chunk.map((k) => kv.get(k.name, "text")),
      );
      const inserts: D1PreparedStatement[] = [];
      chunk.forEach((k, j) => {
        const v = values[j];
        if (v === null || v === undefined) {
          skippedExpiring++;
          return;
        }
        inserts.push(
          stmt(db, COPY).bind(
            k.name,
            v,
            k.expiration ?? null,
            k.metadata === undefined || k.metadata === null
              ? null
              : JSON.stringify(k.metadata),
          ),
        );
      });
      if (inserts.length === 0) continue;
      for (const r of await db.batch(inserts)) copied += r.meta.changes ?? 0;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const [count] = await db.batch<{ n: number }>([
    stmt(db, COUNT_LIVE).bind(at),
    stmt(db, MARK_BACKFILLED).bind(BACKFILLED_KEY, String(now)),
  ]);
  return {
    kvKeys,
    copied,
    skippedExpiring,
    d1Rows: count?.results[0]?.n ?? 0,
  };
}
