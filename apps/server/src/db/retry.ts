import { AsyncLocalStorage } from "node:async_hooks";
import { logInfo, logWarn } from "../log.js";
import { isStorageFailure } from "./storage-failure.js";

/**
 * Read retries for transient D1 and KV failures (#1126, the user's decision
 * of 2026-11-03): reads retry with exponential backoff and full jitter,
 * bounded in attempts and waiting; writes get one try. After the retries,
 * the error reaches toErrorResponse and answers 503 storage_unavailable.
 *
 * - Only isStorageFailure retries: a bug never does.
 * - D1: only `first`, `all` and `raw` of a statement whose SQL is read-only
 *   (isReadOnlySql). Never `run`, never `batch`, never `exec`.
 * - KV: only `get`. Never put, delete or list.
 * - Bounds: RETRY.attempts tries in all; before try n+1 a random wait in
 *   [0, baseMs * 2^(n-1)); at most RETRY.maxWaitMs of waiting per call, and
 *   per request or cron run inside withReadBudget (fetch and scheduled).
 *   Durable Object calls have no request scope (RPC doesn't carry it), so
 *   there the cap is per call.
 * - Breaker, per isolate: RETRY.breakerFailures storage failures within
 *   breakerWindowMs open it for breakerOpenMs; while open nothing retries,
 *   so an outage fails at once into the 503 instead of piling up.
 *
 * The wrappers are memoized per binding and per env, never per request:
 * many caches key on Env or D1Database (stmt.ts, auth config, ...), and a
 * fresh wrapper per request would empty them all.
 *
 * Logs carry fixed event names, the store and the attempt count only: never
 * SQL, params, keys or values.
 */
export const RETRY = {
  attempts: 3,
  baseMs: 50,
  maxWaitMs: 300,
  breakerFailures: 5,
  breakerWindowMs: 10_000,
  breakerOpenMs: 30_000,
} as const;

export type StoreKind = "d1" | "kv";

export interface RetryDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** In [0, 1). */
  random(): number;
}

const realDeps: RetryDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};
let deps: RetryDeps = realDeps;

/** Tests: swap the clock, sleep or random; null restores the real ones. */
export function setRetryDeps(d: Partial<RetryDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

// ---------------------------------------------------------------- breaker

let failures: number[] = [];
let openUntil = 0;

/** Tests: close the breaker and forget past failures. */
export function resetBreaker(): void {
  failures = [];
  openUntil = 0;
}

export function breakerOpen(now = deps.now()): boolean {
  return now < openUntil;
}

function recordFailure(now: number): void {
  if (breakerOpen(now)) return;
  failures = failures.filter((t) => now - t < RETRY.breakerWindowMs);
  failures.push(now);
  if (failures.length >= RETRY.breakerFailures) {
    openUntil = now + RETRY.breakerOpenMs;
    failures = [];
    logWarn("storage_breaker_open", undefined, {
      openMs: RETRY.breakerOpenMs,
    });
  }
}

// ---------------------------------------------------------------- budget

const budget = new AsyncLocalStorage<{ waitedMs: number }>();

/** Runs `f` with one waiting budget (RETRY.maxWaitMs) for all its reads. */
export function withReadBudget<T>(f: () => T): T {
  return budget.run({ waitedMs: 0 }, f);
}

// ---------------------------------------------------------------- retry

/**
 * Runs `read`, retrying it on a storage failure within the bounds above.
 * The first try runs synchronously, so a read that throws rather than
 * rejects still throws to its caller, exactly as without the wrapper.
 */
export function retryRead<T>(
  store: StoreKind,
  read: () => Promise<T>,
): Promise<T> {
  return settle(store, read, read());
}

async function settle<T>(
  store: StoreKind,
  read: () => Promise<T>,
  first: Promise<T>,
): Promise<T> {
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await (attempt === 1 ? first : read());
      if (attempt > 1)
        logInfo("storage_read_retry_ok", { store, attempts: attempt });
      return r;
    } catch (e) {
      if (!isStorageFailure(e)) throw e;
      const now = deps.now();
      recordFailure(now);
      const req = budget.getStore();
      const left = Math.min(
        RETRY.maxWaitMs - waited,
        req ? RETRY.maxWaitMs - req.waitedMs : Number.POSITIVE_INFINITY,
      );
      const reason =
        attempt >= RETRY.attempts
          ? "attempts"
          : breakerOpen(now)
            ? "breaker"
            : left <= 0
              ? "budget"
              : null;
      if (reason) {
        logWarn("storage_read_gave_up", undefined, {
          store,
          attempts: attempt,
          reason,
        });
        throw e;
      }
      const delay = Math.min(
        left,
        Math.floor(deps.random() * RETRY.baseMs * 2 ** (attempt - 1)),
      );
      waited += delay;
      if (req) req.waitedMs += delay;
      await deps.sleep(delay);
    }
  }
}

// ---------------------------------------------------------------- d1

const WRITE_WORD =
  /\b(?:insert|update|delete|replace|upsert|returning|create|drop|alter|pragma)\b/i;
const READ_START = /^(?:select|explain|with)\b/i;
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/;

/**
 * True only for SQL that can't write: its first keyword (past leading
 * comments) is SELECT, EXPLAIN or WITH, and no write keyword appears
 * anywhere in the text, comments and string literals included. Erring
 * towards false is safe: an unclassified statement gets one try.
 */
export function isReadOnlySql(sql: string): boolean {
  let s = sql;
  for (let m = LEADING_NOISE.exec(s); m; m = LEADING_NOISE.exec(s))
    s = s.slice(m[0].length);
  return READ_START.test(s) && !WRITE_WORD.test(sql);
}

type ReadMethod = "first" | "all" | "raw";
const READS: readonly ReadMethod[] = ["first", "all", "raw"];

/** A retrying statement -> the real statement it reads through. */
const realStatement = new WeakMap<object, D1PreparedStatement>();

/**
 * A read-only statement whose `first`, `all` and `raw` retry, and whose
 * `bind` returns the same kind: a plain object inheriting from the real
 * statement (Object.create, no Proxy), with those four as own properties.
 * The real statement itself is never changed (patching it in place recurses
 * when a binding hands back proxied statements, as test doubles do), and
 * the wrapped binding's batch() unwraps it (realStatement), so D1 always
 * receives real D1PreparedStatement objects. `run` is inherited untouched.
 */
function patchStatement(s: D1PreparedStatement): D1PreparedStatement {
  const rec = s as unknown as Record<string, (...a: unknown[]) => unknown>;
  const p = Object.create(s) as Record<string, unknown>;
  for (const m of READS)
    p[m] = (...a: unknown[]) =>
      retryRead("d1", () => rec[m]?.(...a) as Promise<unknown>);
  p.bind = (...a: unknown[]) =>
    patchStatement(rec.bind?.(...a) as D1PreparedStatement);
  realStatement.set(p, s);
  return p as unknown as D1PreparedStatement;
}

/** The statements D1 itself should see: retrying ones unwrapped. */
const unwrapAll = (stmts: D1PreparedStatement[]): D1PreparedStatement[] =>
  stmts.map((x) => realStatement.get(x) ?? x);

/** Every wrapper made here, so wrapping one again is a no-op. */
const wrappers = new WeakSet<object>();
const d1Memo = new WeakMap<D1Database, D1Database>();
const kvMemo = new WeakMap<KVNamespace, KVNamespace>();
const envMemo = new WeakMap<object, object>();

/** `db` whose read-only statements retry: one wrapper per binding. */
export function retryingD1<T extends D1Database | undefined>(db: T): T {
  if (!db || wrappers.has(db)) return db;
  const hit = d1Memo.get(db);
  if (hit) return hit as T;
  const target = db as D1Database;
  const prepare = (sql: string) => {
    const s = target.prepare(sql);
    return isReadOnlySql(sql) ? patchStatement(s) : s;
  };
  // Never retried: a batch may hold writes.
  const batch = (stmts: D1PreparedStatement[]) =>
    target.batch(unwrapAll(stmts));
  const w = new Proxy(target, {
    get(t, p) {
      if (p === "prepare") return prepare;
      if (p === "batch") return batch;
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  wrappers.add(w);
  d1Memo.set(target, w);
  return w as T;
}

// ---------------------------------------------------------------- kv

/** `kv` whose `get` retries: one wrapper per binding. */
export function retryingKv<T extends KVNamespace | undefined>(kv: T): T {
  if (!kv || wrappers.has(kv)) return kv;
  const hit = kvMemo.get(kv);
  if (hit) return hit as T;
  const target = kv as KVNamespace;
  const get = (...a: unknown[]) =>
    retryRead("kv", () =>
      (target.get as (...x: unknown[]) => Promise<unknown>).apply(target, a),
    );
  const w = new Proxy(target, {
    get(t, p) {
      if (p === "get") return get;
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  wrappers.add(w);
  kvMemo.set(target, w);
  return w as T;
}

// ---------------------------------------------------------------- env

/**
 * `env` with DB and OAUTH_KV read through retryingD1 and retryingKv. One
 * wrapper per Env (WeakMap), so caches keyed on Env or D1Database keep
 * hitting. A Proxy, so every other binding and var reads through live.
 */
export function withRetries<E extends object>(env: E): E {
  if (wrappers.has(env)) return env;
  const hit = envMemo.get(env);
  if (hit) return hit as E;
  const w = new Proxy(env, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === "DB") return retryingD1(v as D1Database | undefined);
      if (p === "OAUTH_KV") return retryingKv(v as KVNamespace | undefined);
      return v;
    },
  });
  wrappers.add(w);
  envMemo.set(env, w);
  return w;
}
