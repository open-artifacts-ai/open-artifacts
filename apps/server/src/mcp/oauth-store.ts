import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logError, logWarn } from "../log.js";

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
// Forward: kv -> dual -> the copy (copyKvToD1) -> d1. With OAUTH_KV bound,
// d1 is refused (503 oauth_store_misconfigured) until a copy completed since
// the last kv run or the install already served in d1. With no binding
// (a fresh install provisioned straight into d1) there is nothing to copy,
// so d1 serves.
//
// Rollback: dual -> kv loses nothing (KV took every write). KV stays
// authoritative in kv mode, and D1 never contradicts it: every kv put drops
// D1's row and every kv delete tombstones the row D1 holds, so a later dual
// run (or a dual isolate overlapping a kv one, in either direction) can't
// serve a stale row or revive a revoked grant; a put never overwrites a
// tombstone (PUT). Leaving d1 is refused
// (checkMarkers): once oauth_kv_writes_off_since is set, kv or dual answer
// 503 oauth_store_misconfigured unless OAUTH_STORE_ROLLBACK=1. Runbook for
// the override: empty the OAuth keys from KV first, so every agent
// reconnects; KV's copy is never revived. Keep the override set until
// /healthz shows kvWritesOffSince null.

export type OAuthStoreMode = "kv" | "dual" | "d1";
const MODES: readonly OAuthStoreMode[] = ["kv", "dual", "d1"];

/**
 * A dual list past DUAL_LIST_KV_PAGES KV pages. Not the KV 429 the library
 * retries: a retry walks the same pages and fails the same, so it surfaces
 * as a server error (mapStoreError passes it through).
 */
export class DualListTooLongError extends Error {
  override name = "DualListTooLongError";
}

/**
 * A broken OAUTH_STORE setting, a missing binding, or leaving d1 without
 * the override: fails clearly (storeMisconfigured).
 */
export class OAuthStoreConfigError extends Error {
  override name = "OAuthStoreConfigError";
}

/**
 * The markers' refusal (checkMarkers): leaving d1 without the override, or
 * d1 before a recorded copy. An OAuthStoreConfigError (the same 503), told
 * apart by class where a caller reports why (the copy route).
 */
export class OAuthStoreMarkersError extends OAuthStoreConfigError {
  override name = "OAuthStoreMarkersError";
}

/** The 503 for an OAuthStoreConfigError, wherever it surfaces. */
export function storeMisconfigured(e: OAuthStoreConfigError): Response {
  logError("oauth_store_misconfigured", e);
  return Response.json(
    { error: "oauth_store_misconfigured", message: e.message },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
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
 * OAUTH_STORE's mode, checked against the bindings (no D1): throws
 * OAuthStoreConfigError when the mode is invalid, or is kv or dual with no
 * OAUTH_KV binding.
 */
export function checkedStoreMode(
  env: Pick<Env, "OAUTH_STORE" | "OAUTH_KV">,
): OAuthStoreMode {
  const mode = oauthStoreMode(env);
  if (mode !== "d1" && !env.OAUTH_KV)
    throw new OAuthStoreConfigError(
      `OAUTH_STORE=${mode} needs the OAUTH_KV binding`,
    );
  return mode;
}

/**
 * `env` with OAUTH_KV set to this install's store (a new one, with its own
 * per-request cache, unless `env` already carries one). kv mode wraps the
 * binding so its writes keep D1 from contradicting KV (KvModeStore). kv and
 * dual check the markers once per isolate before their first write
 * (checkMarkers). Throws OAuthStoreConfigError when the mode is invalid, or
 * is kv or dual with no OAUTH_KV binding.
 */
export function oauthEnv(env: Env): OAuthEnv {
  const kv = env.OAUTH_KV;
  if (kv instanceof StoreBase) return env as OAuthEnv;
  const mode = checkedStoreMode(env);
  const store =
    mode === "kv"
      ? new KvModeStore(kv as KVNamespace, env)
      : mode === "d1"
        ? new D1KvStore(env.DB)
        : new DualKvStore(new D1KvStore(env.DB), kv as KVNamespace, env);
  // d1 never reads KV, but the marker check past the provider asks whether
  // it is bound (rawKv): record the binding when there is one.
  if (mode === "d1" && kv) bindings.set(store, kv as KVNamespace);
  return { ...env, OAUTH_KV: store as unknown as KVNamespace };
}

// ---------------------------------------------------------------- shared

/** Unix seconds. */
const nowS = () => Math.floor(Date.now() / 1000);

/** KV's list page maximum (the provider's MAX_KV_LIST_LIMIT). */
export const MAX_LIST_LIMIT = 1000;
/** Workers KV's operations per invocation (every plan). */
export const KV_OPS_PER_INVOCATION = 1000;
/**
 * The most KV list pages one dual list walks (DualKvStore.kvAfter). A walk
 * starts at the prefix (KV lists can't start after a key), so listing P
 * pages in full costs 1 + 2 + ... + P = P(P+1)/2 KV lists: P is the largest
 * whose full listing takes at most half of KV_OPS_PER_INVOCATION (the other
 * half: the provider's gets). 31.
 */
export const DUAL_LIST_KV_PAGES = Math.floor(
  (Math.sqrt(1 + 4 * KV_OPS_PER_INVOCATION) - 1) / 2,
);
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
 * temporarily_unavailable, not a 500). Only overload and busy: "Too many API
 * requests by single Worker invocation" (the per-invocation query limit) is
 * this request's own doing, and a retry of the same request hits it again.
 */
const BUSY = /overloaded|SQLITE_BUSY|database is locked|\bbusy\b/i;
const PER_INVOCATION = /too many api requests by single worker invocation/i;
export function mapStoreError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (
    !BUSY.test(msg) ||
    PER_INVOCATION.test(msg) ||
    /429 Too Many Requests/i.test(msg)
  )
    return e;
  return new Error(`oauth_kv D1 failed: 429 Too Many Requests (${msg})`, {
    cause: e,
  });
}

abstract class StoreBase {}

/** The KV binding under a store: dual, kv, and d1 when OAUTH_KV is bound. */
const bindings = new WeakMap<StoreBase, KVNamespace>();

/**
 * The raw OAUTH_KV binding: env.OAUTH_KV itself, or the binding under this
 * install's store (oauthEnv: what the app sees past the provider). The copy
 * reads KV directly, never through the dual merge.
 */
const rawKv = (kv: unknown): KVNamespace | undefined =>
  kv instanceof StoreBase ? bindings.get(kv) : (kv as KVNamespace | undefined);

// ---------------------------------------------------------------- d1

/**
 * A deleted key: a row whose expires_at is minus the deletion time (unix s).
 * Every read treats it as missing, like an expired row, and it keeps D1
 * deciding: a dual get never falls back to KV for it, a dual list drops KV's
 * copy, and neither a put (PUT) nor the backfill's insert-or-ignore can
 * bring it back. Every mode writes one for every delete: in kv mode too, so
 * a dual isolate's put racing a kv isolate's delete (its D1 half landing
 * after the tombstone) can't revive the key in D1. The nightly sweep
 * removes it after TOMBSTONE_DAYS in d1 mode, TOMBSTONE_KV_DAYS in kv mode,
 * never in dual (sweepOAuthStore).
 */
const tombstoneOf = (key: string, now: number): Row => ({
  key,
  value: "",
  expires_at: -now,
  metadata: null,
});

const GET =
  "select key, value, expires_at, metadata from oauth_kv where key = ?";
/**
 * Never over a tombstone (expires_at < 0): a deleted key stays deleted, so a
 * put racing a delete in another isolate (a dual put's D1 half landing
 * after a kv isolate's tombstone) can't revive it. The provider never puts
 * a key it deleted (grant and token keys are new ids).
 */
const PUT =
  "insert into oauth_kv (key, value, expires_at, metadata) values (?, ?, ?, ?) on conflict(key) do update set value = excluded.value, expires_at = excluded.expires_at, metadata = excluded.metadata where oauth_kv.expires_at is null or oauth_kv.expires_at >= 0";
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
/** kv mode's put: D1 holds no row for a key KV just wrote (nor a tombstone). */
const DELETE_KEYS =
  "delete from oauth_kv where key in (select value from json_each(?))";
/** Every mode: a tombstone for every deleted key. */
const TOMBSTONE_KEYS =
  "insert into oauth_kv (key, value, expires_at, metadata) select value, '', ?, null from json_each(?) where true on conflict(key) do update set value = '', expires_at = excluded.expires_at, metadata = null";

type Pending = {
  key: string;
  /** tomb: a delete (tombstone); drop: kv mode's put (no row). */
  kind: "tomb" | "drop";
  done: () => void;
  fail: (e: unknown) => void;
};

type Snap = { prefix: string; rows: Map<string, Row>; at: number };

/** KV-shaped store over the install's D1 table oauth_kv; one per request. */
export class D1KvStore extends StoreBase {
  /** key -> row (null: no row), with when it was read. Rows may be dead. */
  private readonly rows = new Map<string, { r: Row | null; at: number }>();
  /** Complete snapshots of every row (dead ones too) under a prefix. */
  private snaps: Snap[] = [];
  /** Snapshot queries in flight, by prefix (the snapshot, if it fit). */
  private readonly loading = new Map<
    string,
    Promise<{ got: Row[]; snap: Snap | null }>
  >();
  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly db: D1Database) {
    super();
  }

  private fresh(at: number) {
    return Date.now() - at <= CACHE_MS;
  }

  /** The newest fresh snapshot that `test` accepts. */
  private newestSnap(test: (s: Snap) => boolean): Snap | undefined {
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      const s = this.snaps[i] as Snap;
      if (this.fresh(s.at) && test(s)) return s;
    }
    return undefined;
  }

  /** The cached row (null: no row) or undefined (unknown). */
  private cached(key: string): Row | null | undefined {
    const c = this.rows.get(key);
    if (c && this.fresh(c.at)) return c.r;
    const s = this.newestSnap((x) => key.startsWith(x.prefix));
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
    const r = await this.q(() =>
      stmt(this.db, PUT).bind(key, value, expires_at, metadata).run(),
    );
    // No change: a tombstone held the key (PUT), and it stays dead here too.
    this.remember(
      key,
      (r.meta.changes ?? 1) === 0
        ? tombstoneOf(key, nowS())
        : { key, value, expires_at, metadata },
    );
  }

  /**
   * A tombstone (tombstoneOf). Batched: the deletes of one tick share one
   * statement per KEYS_CHUNK keys, written before this store's next query.
   */
  delete(key: string): Promise<void> {
    this.remember(key, tombstoneOf(key, nowS()));
    return this.enqueue(key, "tomb");
  }

  /** kv mode's put: D1's row goes (KV holds the value). Batched like delete. */
  drop(key: string): Promise<void> {
    this.remember(key, null);
    return this.enqueue(key, "drop");
  }

  private enqueue(key: string, kind: Pending["kind"]): Promise<void> {
    return new Promise((done, fail) => {
      this.pending.push({ key, kind, done, fail });
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
    // A key's last write in the batch wins.
    const last = new Map<string, Pending["kind"]>();
    for (const p of batch) {
      last.delete(p.key);
      last.set(p.key, p.kind);
    }
    const tombs = [...last].filter(([, k]) => k === "tomb").map(([k]) => k);
    const drops = [...last].filter(([, k]) => k === "drop").map(([k]) => k);
    const now = nowS();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < tombs.length; i += KEYS_CHUNK)
      stmts.push(
        stmt(this.db, TOMBSTONE_KEYS).bind(
          -now,
          JSON.stringify(tombs.slice(i, i + KEYS_CHUNK)),
        ),
      );
    for (let i = 0; i < drops.length; i += KEYS_CHUNK)
      stmts.push(
        stmt(this.db, DELETE_KEYS).bind(
          JSON.stringify(drops.slice(i, i + KEYS_CHUNK)),
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
    const covering = this.newestSnap((s) => prefix.startsWith(s.prefix));
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
        if (got.length > SNAPSHOT_MAX) return { got, snap: null };
        const rows = new Map(got.map((r) => [r.key, r]));
        // This request's own writes since the query began win.
        for (const [k, c] of this.rows)
          if (c.at >= started && k.startsWith(wide)) {
            if (c.r) rows.set(k, c.r);
            else rows.delete(k);
          }
        const snap: Snap = { prefix: wide, rows, at: Date.now() };
        // Only fresh snapshots stay, and none this one supersedes.
        this.snaps = this.snaps.filter(
          (s) => this.fresh(s.at) && !s.prefix.startsWith(wide),
        );
        this.snaps.push(snap);
        for (const r of got)
          if (!((this.rows.get(r.key)?.at ?? -1) >= started))
            this.rows.set(r.key, { r, at: Date.now() });
        return { got, snap };
      });
      this.loading.set(wide, load);
      void load.then(
        () => this.loading.delete(wide),
        () => this.loading.delete(wide),
      );
    }
    // The snapshot this query loaded, never an older one.
    const { snap } = await load;
    if (snap) return pick(snap.rows.values());
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

/**
 * Writes and deletes to D1 and KV; get from D1, else KV; list merges both by
 * key, D1 winning. D1 decides whenever it holds a row: a dead one (expired
 * or deleted) hides KV's copy. KV lists can't start after a key, so a dual
 * list walks KV's pages from the start of the prefix to its cursor (a
 * user's grants and tokens: one page), DUAL_LIST_KV_PAGES at most (past it,
 * DualListTooLongError, never an unbounded walk or a retryable 429). Writes check
 * the markers first (checkMarkers: leaving d1 is refused).
 */
export class DualKvStore extends StoreBase {
  constructor(
    private readonly d1: D1KvStore,
    private readonly kv: KVNamespace,
    private readonly env?: Env,
  ) {
    super();
    bindings.set(this, kv);
  }

  async get(key: string, opt?: GetOpt): Promise<unknown> {
    const t = typeOf(opt);
    const r = await this.d1.row(key);
    if (r) return decode(live(r, nowS()) ? r.value : null, t);
    return decode(await this.kv.get(key, "text"), t);
  }

  async put(key: string, value: unknown, opt?: PutOpt): Promise<void> {
    if (this.env) await checkMarkers(this.env, "dual");
    await Promise.all([
      this.d1.put(key, value, opt),
      this.kv.put(key, value as string, opt as KVNamespacePutOptions),
    ]);
  }

  async delete(key: string): Promise<void> {
    if (this.env) await checkMarkers(this.env, "dual");
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

  /**
   * Up to `n` KV keys under `prefix` after `after`, in key order, within
   * DUAL_LIST_KV_PAGES KV lists; past them, DualListTooLongError (a retry
   * fails the same, so never the KV 429 the library retries).
   */
  private async kvAfter(
    prefix: string,
    after: string,
    n: number,
  ): Promise<{ keys: ListKey[]; more: boolean }> {
    const out: ListKey[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= DUAL_LIST_KV_PAGES)
        throw new DualListTooLongError(
          `oauth_kv dual list: the KV walk passed ${DUAL_LIST_KV_PAGES} pages`,
        );
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
  }
}

// ---------------------------------------------------------------- kv

/**
 * kv mode: KV decides every read. Each write also keeps D1 from contradicting
 * KV, so a later dual run, or a dual isolate overlapping this one, never
 * serves a stale row or revives a revoked grant: a put drops D1's row (the
 * value lives in KV only), and a delete tombstones the key in D1 (held or
 * not: a dual isolate's put may land its D1 half later), before KV's
 * delete. Both batch like D1KvStore's deletes and map D1 overload like
 * every store query. Every operation, reads included (KV after d1 still
 * holds grants revoked since), checks the markers first, once per isolate
 * (checkMarkers: leaving d1 is refused); a request that never touches the
 * store never touches D1.
 */
class KvModeStore extends StoreBase {
  private readonly d1: D1KvStore;
  constructor(
    private readonly kv: KVNamespace,
    private readonly env: Env,
  ) {
    super();
    bindings.set(this, kv);
    this.d1 = new D1KvStore(env.DB);
  }
  async get(key: string, opt?: GetOpt) {
    await checkMarkers(this.env, "kv");
    // return await: a KV rejection is handled at once (workerd reports one
    // adopted a job later as unhandled).
    return await this.kv.get(key, opt as "text");
  }
  async put(key: string, value: string, opt?: KVNamespacePutOptions) {
    await checkMarkers(this.env, "kv");
    await this.d1.drop(key);
    return await this.kv.put(key, value, opt);
  }
  async delete(key: string) {
    await checkMarkers(this.env, "kv");
    await this.d1.delete(key);
    return await this.kv.delete(key);
  }
  async list(opt?: KVNamespaceListOptions) {
    await checkMarkers(this.env, "kv");
    return await this.kv.list(opt);
  }
}

// ---------------------------------------------------------------- markers

/** settings: when a full KV -> D1 copy last completed (epoch ms). */
export const BACKFILLED_KEY = "oauth_store_backfilled";
/** settings: when this install first served in d1 mode (epoch ms). */
export const KV_WRITES_OFF_KEY = "oauth_kv_writes_off_since";
/**
 * settings: the KV -> D1 copy's generation (a random id), carried in its
 * cursor. Each fresh pass mints one; kv retires it, so a cursor from before
 * a kv run restarts the pass instead of completing it.
 */
export const COPY_GEN_KEY = "oauth_store_copy_gen";

/** Moves only earlier: a later stamp never replaces an earlier one. */
const STAMP =
  "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value where cast(excluded.value as integer) < cast(settings.value as integer)";
const CLEAR = "delete from settings where key = ?";
const MARKERS = "select key, value from settings where key in (?, ?, ?)";

/**
 * The markers' state; `off` is KV_WRITES_OFF's stamp (epoch ms), `gen` the
 * copy's generation (COPY_GEN_KEY).
 */
type Markers = { backfilled: boolean; off: number | null; gen: string | null };

async function readMarkers(db: D1Database): Promise<Markers> {
  const got = await stmt(db, MARKERS)
    .bind(BACKFILLED_KEY, KV_WRITES_OFF_KEY, COPY_GEN_KEY)
    .all<{ key: string; value: string }>();
  const m = new Map(got.results.map((r) => [r.key, r.value]));
  const off = Number(m.get(KV_WRITES_OFF_KEY));
  return {
    backfilled: m.has(BACKFILLED_KEY),
    off: m.has(KV_WRITES_OFF_KEY) && Number.isFinite(off) ? off : null,
    gen: m.get(COPY_GEN_KEY) ?? null,
  };
}

const rollbackOn = (env: Pick<Env, "OAUTH_STORE_ROLLBACK">) =>
  env.OAUTH_STORE_ROLLBACK?.trim() === "1";

/**
 * Reads the markers, refuses leaving d1, then writes what `mode` changes:
 * - kv or dual while KV_WRITES_OFF is set: OAuthStoreConfigError (503
 *   oauth_store_misconfigured) unless OAUTH_STORE_ROLLBACK=1, which clears
 *   the stamp. The stamp is read before any write, so no write of this
 *   mode clears it first.
 * - d1 with OAUTH_KV bound, without BACKFILLED and before any d1 serve
 *   (KV_WRITES_OFF unset): OAuthStoreConfigError (503), so kv -> d1 can't
 *   skip dual and the copy. With no binding there is nothing to copy (a
 *   fresh install provisioned straight into d1): d1 serves, and BACKFILLED
 *   stays unset. Once KV_WRITES_OFF is set, binding KV later still serves;
 * - d1 stamps KV_WRITES_OFF unless set (STAMP: only ever earlier);
 * - kv clears BACKFILLED and retires the copy's generation (COPY_GEN_KEY):
 *   D1 misses KV's new keys from here, so going forward again needs a
 *   fresh copy, and a pass begun before this run restarts.
 * One read, and a write only when something changes.
 */
async function syncMarkers(
  env: Env,
  mode: OAuthStoreMode,
  rollback: boolean,
): Promise<void> {
  const db = env.DB;
  const m = await readMarkers(db);
  if (mode !== "d1" && m.off !== null && !rollback)
    throw new OAuthStoreMarkersError(
      `OAUTH_STORE=${mode} is refused: this install has served in d1 mode since ${new Date(m.off).toISOString()}, so KV is stale. Set OAUTH_STORE back to d1, or roll back with OAUTH_STORE_ROLLBACK=1 after emptying the OAuth keys from KV (every agent reconnects).`,
    );
  // The raw binding: past the provider (oauthEnv) OAUTH_KV is d1's store,
  // always set, so only the binding under it says KV is bound.
  if (mode === "d1" && rawKv(env.OAUTH_KV) && !m.backfilled && m.off === null)
    throw new OAuthStoreMarkersError(
      "OAUTH_STORE=d1 is refused: no complete KV -> D1 copy is recorded. Serve with OAUTH_STORE=dual, run the copy to completion, then switch to d1.",
    );
  const writes: D1PreparedStatement[] = [];
  if (mode === "d1") {
    if (m.off === null)
      writes.push(stmt(db, STAMP).bind(KV_WRITES_OFF_KEY, String(Date.now())));
  } else {
    if (m.off !== null) writes.push(stmt(db, CLEAR).bind(KV_WRITES_OFF_KEY));
    if (mode === "kv" && m.backfilled)
      writes.push(stmt(db, CLEAR).bind(BACKFILLED_KEY));
    if (mode === "kv" && m.gen !== null)
      writes.push(stmt(db, CLEAR).bind(COPY_GEN_KEY));
  }
  if (writes.length === 1) await (writes[0] as D1PreparedStatement).run();
  else if (writes.length > 1) await db.batch(writes);
}

/** This isolate's marker check per database (a refusal is not kept). */
let synced = new WeakMap<
  D1Database,
  { mode: OAuthStoreMode; rollback: boolean; done: Promise<void> }
>();

/**
 * syncMarkers once per isolate, mode and override (concurrent callers share
 * it); a refusal or an error is retried by the next call.
 */
function checkMarkers(env: Env, mode: OAuthStoreMode): Promise<void> {
  const rollback = rollbackOn(env);
  const c = synced.get(env.DB);
  if (c && c.mode === mode && c.rollback === rollback) return c.done;
  const done = syncMarkers(env, mode, rollback);
  synced.set(env.DB, { mode, rollback, done });
  done.catch(() => {
    if (synced.get(env.DB)?.done === done) synced.delete(env.DB);
  });
  return done;
}

/** Tests: forget which markers this isolate checked. */
export function resetOAuthStoreMarkers(): void {
  synced = new WeakMap();
}

/**
 * Every app-host request except /healthz: dual and d1 check the markers,
 * once per isolate and mode (checkMarkers; d1: "the first time the install
 * serves in d1 mode"). kv checks them lazily, before its first store
 * operation (KvModeStore), so a kv request that never touches the store
 * (/skill.md, a D1 quota error page) never touches D1. Throws
 * OAuthStoreConfigError on a bad mode, a missing binding, or dual after d1
 * without the override.
 */
export async function syncStoreMarkers(env: Env): Promise<void> {
  const mode = checkedStoreMode(env);
  if (mode === "kv") return;
  await checkMarkers(env, mode);
}

export type OAuthStoreHealth = {
  mode: OAuthStoreMode;
  backfilled: boolean;
  kvWritesOffSince: number | null;
};

/**
 * /healthz's oauthStore: reads the markers (one query), writes nothing.
 * kvWritesOffSince is the stamp in any mode (set in kv or dual: refused, or
 * an override not yet applied). Null when D1 can't be read, never a 500.
 * Throws OAuthStoreConfigError on a bad mode or a missing binding.
 */
export async function oauthStoreHealth(
  env: Env,
): Promise<OAuthStoreHealth | null> {
  const mode = checkedStoreMode(env);
  try {
    const m = await readMarkers(env.DB);
    return { mode, backfilled: m.backfilled, kvWritesOffSince: m.off };
  } catch (e) {
    logWarn("oauth_store_health_unread", e);
    return null;
  }
}

// ---------------------------------------------------------------- sweep

/** Rows deleted per statement. */
const SWEEP_BATCH = 1000;
/**
 * The sweep's own slot in the nightly cron's D1 budget (50 queries per
 * invocation on Workers Free, shared by every nightly task): at most this
 * many statements, SWEEP_BATCH rows each.
 */
export const OAUTH_SWEEP_QUERIES = 5;
/** How long a deleted key's tombstone outlives it in d1 (the backfill window). */
export const TOMBSTONE_DAYS = 30;
/**
 * kv: how long a tombstone outlives its key. Longer than any deploy overlap
 * (a dual isolate still running beside kv ones) and KV's edge caches, after
 * which KV's own delete decides.
 */
export const TOMBSTONE_KV_DAYS = 1;
/** d1 and kv: expired rows and tombstones older than the mode's cutoff. */
const SWEEP =
  "delete from oauth_kv where key in (select key from oauth_kv where expires_at is not null and ((expires_at >= 0 and expires_at <= ?) or (expires_at < 0 and expires_at >= ?)) limit ?)";
/** dual: expired rows only; tombstones stay. */
const SWEEP_EXPIRED =
  "delete from oauth_kv where key in (select key from oauth_kv where expires_at >= 0 and expires_at <= ? limit ?)";

/**
 * Nightly: deletes rows past expires_at (reads already treat them as
 * missing), SWEEP_BATCH per statement, at most OAUTH_SWEEP_QUERIES
 * statements. Every mode: a table left by dual or d1 still drains.
 * Tombstones go after TOMBSTONE_DAYS in d1 (leaving d1 is refused) and
 * TOMBSTONE_KV_DAYS in kv (by then KV's own delete decides); never in dual,
 * where a tombstone is what keeps KV's copy of a revoked key dead (a later
 * read, the copy). Returns the rows deleted.
 */
export async function sweepOAuthStore(env: Env, now: number): Promise<number> {
  const at = Math.floor(now / 1000);
  const mode = parseOAuthStoreMode(env.OAUTH_STORE);
  const days =
    mode === "d1" ? TOMBSTONE_DAYS : mode === "kv" ? TOMBSTONE_KV_DAYS : null;
  const tombCutoff = days === null ? null : at - days * 86_400;
  let total = 0;
  for (let i = 0; i < OAUTH_SWEEP_QUERIES; i++) {
    const r = await (tombCutoff !== null
      ? stmt(env.DB, SWEEP).bind(at, -tombCutoff, SWEEP_BATCH)
      : stmt(env.DB, SWEEP_EXPIRED).bind(at, SWEEP_BATCH)
    ).run();
    const n = r.meta.changes ?? 0;
    total += n;
    if (n < SWEEP_BATCH) break;
  }
  return total;
}

// ---------------------------------------------------------------- copy

export type CopyCounts = {
  /** Keys KV listed in this invocation. */
  kvKeys: number;
  /** Rows inserted into D1 (keys D1 already held are left as they are). */
  copied: number;
  /** Keys expiring within MIN_COPY_TTL_S, or gone before their read. */
  skippedExpiring: number;
  /** Live oauth_kv rows after the final page; null before it. */
  d1Rows: number | null;
  /** Pass to the next call; null: the pass is complete (backfilled set). */
  nextCursor: string | null;
  /**
   * The cursor passed in was from a retired generation (a kv run since, or
   * none was recorded): this call started the pass over.
   */
  restarted: boolean;
};

/** KV's minimum TTL: a key closer to expiry than this is not copied. */
const MIN_COPY_TTL_S = 60;
/**
 * Keys per invocation: one KV list and up to this many KV gets (KV allows
 * 1,000 operations per invocation).
 */
export const COPY_PAGE = 800;
/** KV reads in flight, and rows per D1 insert (by count, then size). */
const COPY_CHUNK = 50;
const COPY_CHUNK_CHARS = 512_000;
/**
 * Rows for a JSON array of [key, value, expires_at, metadata]: one
 * statement per chunk, so a page costs COPY_PAGE / COPY_CHUNK D1 queries at
 * most (D1 allows 50 per invocation on Workers Free).
 */
const COPY =
  "insert into oauth_kv (key, value, expires_at, metadata) select json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') from json_each(?) where true on conflict(key) do nothing";
const COUNT_LIVE =
  "select count(*) as n from oauth_kv where expires_at is null or expires_at > ?";
/** Only while the pass's generation is current (no kv run retired it). */
const MARK_BACKFILLED =
  "insert into settings (key, value) select ?, ? where exists (select 1 from settings where key = ? and value = ?) on conflict(key) do update set value = excluded.value";
const GEN = "select value from settings where key = ?";
const SET_GEN =
  "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value";

/** The copy's cursor: `<generation>.<KV cursor>` (empty: the pass's start). */
const copyCursor = (gen: string, kvCursor: string) => `${gen}.${kvCursor}`;
function parseCopyCursor(c: string): { gen: string; kv: string } | null {
  const i = c.indexOf(".");
  return i > 0 ? { gen: c.slice(0, i), kv: c.slice(i + 1) } : null;
}

/**
 * The backfill's core (Platform's job calls it), in dual mode only: one KV
 * page per call (COPY_PAGE keys, within KV's and D1's per-invocation
 * limits), resumed from `cursor` (the previous call's nextCursor). Inserts
 * every key into D1 with its original expiry and metadata, never
 * overwriting a row D1 already holds (a newer dual write, or a deleted
 * key's tombstone). Idempotent: a rerun copies only what is missing. The
 * call that completes the pass (nextCursor null) records BACKFILLED_KEY,
 * only while the pass's generation (COPY_GEN_KEY, in the cursor) is
 * current: a kv run retires it, and the pass then restarts from the top
 * (`restarted`) rather than completing over keys D1 missed.
 * Refused in kv mode (D1 misses KV's writes there), in d1 mode (KV is
 * stale: a copy could revive what d1 deleted), both OAuthStoreConfigError,
 * and in dual after d1 without the override (checkMarkers:
 * OAuthStoreMarkersError). `env` may carry this install's store (oauthEnv):
 * the copy reads the KV binding under it. Never logs or returns keys or values.
 * Runbook: start at least 60 s after dual is fully rolled out (KV's edge
 * caches and every kv isolate gone), so no kv write lands behind the copy.
 */
export async function copyKvToD1(
  env: Env,
  opt: { cursor?: string | null; now?: number } = {},
): Promise<CopyCounts> {
  const now = opt.now ?? Date.now();
  const mode = oauthStoreMode(env);
  const kv = rawKv(env.OAUTH_KV);
  if (mode !== "dual" || !kv)
    throw new OAuthStoreConfigError(
      "the KV -> D1 copy runs only with OAUTH_STORE=dual and OAUTH_KV bound",
    );
  await checkMarkers(env, "dual");
  const db = env.DB;
  const at = Math.floor(now / 1000);
  let copied = 0;
  let skippedExpiring = 0;
  // A cursor resumes only its own generation; a new pass (no cursor, or a
  // cursor kv retired) mints a new one.
  const given = opt.cursor ? parseCopyCursor(opt.cursor) : null;
  const current = given
    ? ((await stmt(db, GEN).bind(COPY_GEN_KEY).first<{ value: string }>())
        ?.value ?? null)
    : null;
  const resume = given !== null && given.gen === current;
  let gen = current as string;
  if (!resume) {
    gen = crypto.randomUUID();
    await stmt(db, SET_GEN).bind(COPY_GEN_KEY, gen).run();
  }
  const kvCursor = resume ? given.kv : "";
  const page = await kv.list({
    limit: COPY_PAGE,
    ...(kvCursor ? { cursor: kvCursor } : {}),
  });
  const todo = page.keys.filter(
    (k) => k.expiration === undefined || k.expiration - at >= MIN_COPY_TTL_S,
  );
  skippedExpiring += page.keys.length - todo.length;
  const inserts: D1PreparedStatement[] = [];
  let rows: unknown[] = [];
  let chars = 0;
  const flushRows = () => {
    if (rows.length === 0) return;
    inserts.push(stmt(db, COPY).bind(JSON.stringify(rows)));
    rows = [];
    chars = 0;
  };
  for (let i = 0; i < todo.length; i += COPY_CHUNK) {
    const chunk = todo.slice(i, i + COPY_CHUNK);
    const values = await Promise.all(chunk.map((k) => kv.get(k.name, "text")));
    chunk.forEach((k, j) => {
      const v = values[j];
      if (v === null || v === undefined) {
        skippedExpiring++;
        return;
      }
      const row = [
        k.name,
        v,
        k.expiration ?? null,
        k.metadata === undefined || k.metadata === null
          ? null
          : JSON.stringify(k.metadata),
      ];
      const size = k.name.length + v.length + 64;
      if (rows.length >= COPY_CHUNK || chars + size > COPY_CHUNK_CHARS)
        flushRows();
      rows.push(row);
      chars += size;
    });
  }
  flushRows();
  for (const s of inserts) {
    const r = await s.run().catch((e: unknown) => {
      throw mapStoreError(e);
    });
    copied += r.meta.changes ?? 0;
  }
  let nextCursor = page.list_complete ? null : copyCursor(gen, page.cursor);
  let d1Rows: number | null = null;
  if (nextCursor === null) {
    const [count, mark] = await db.batch<{ n: number }>([
      stmt(db, COUNT_LIVE).bind(at),
      stmt(db, MARK_BACKFILLED).bind(
        BACKFILLED_KEY,
        String(now),
        COPY_GEN_KEY,
        gen,
      ),
    ]);
    // A kv run retired this pass while it ran: not complete; the cursor's
    // generation is gone, so the next call starts over.
    if ((mark?.meta.changes ?? 0) === 0) nextCursor = copyCursor(gen, "");
    else d1Rows = count?.results[0]?.n ?? 0;
  }
  return {
    kvKeys: page.keys.length,
    copied,
    skippedExpiring,
    d1Rows,
    nextCursor,
    restarted: !!opt.cursor && !resume,
  };
}
