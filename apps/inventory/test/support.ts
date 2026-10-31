import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Claims, Pins } from "@oa/gh-oidc";
import { afterEach, beforeEach, vi } from "vitest";
import type { Verify } from "../src/auth.ts";
import { type Env, makeWorker } from "../src/index.ts";

export const REPO = "open-artifacts-ai/open-artifacts";
export const WF = `${REPO}/.github/workflows`;
export const MONITOR = `${WF}/prodclean-monitor.yml@refs/heads/main`;
export const REDLINE = `${WF}/redline-staging.yml@refs/heads/main`;
export const NOW = Date.parse("2026-10-31T12:00:00Z");

export const VARS = {
  OIDC_AUDIENCE: "oa-p-inventory",
  OIDC_REPOSITORY: REPO,
  OIDC_REPOSITORY_ID: "123456",
  OIDC_JOB_WORKFLOW_REFS: `${REDLINE}, ${MONITOR}`,
  OIDC_ENVIRONMENT: "redline-staging",
} as const;

export const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";

export const claims = (ref = MONITOR): Claims => ({
  iss: "https://token.actions.githubusercontent.com",
  aud: VARS.OIDC_AUDIENCE,
  sub: "repo:x",
  iat: NOW / 1000,
  nbf: NOW / 1000,
  exp: NOW / 1000 + 300,
  repository: REPO,
  repository_id: VARS.OIDC_REPOSITORY_ID,
  ref: "refs/heads/main",
  job_workflow_ref: ref,
  environment: "redline-staging",
  event_name: "schedule",
  runner_environment: "github-hosted",
});

/** A verifier that accepts JWT and returns claims for `ref`; records its calls. */
export function fakeVerify(ref = MONITOR) {
  const calls: { jwt: string; pins: Pins }[] = [];
  const verify: Verify = async (jwt, pins) => {
    calls.push({ jwt, pins });
    if (jwt !== JWT) throw new Error("bad");
    return claims(ref);
  };
  return { verify, calls };
}

// No test may reach GitHub's JWKS (or anything else) over the network.
let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error("network disabled in tests");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A KV stub: list() pages over the sorted keys, `page` at a time, with opaque
// cursors; get() takes one key or an array (bulk, at most 100).
export function makeKv(entries: Record<string, string>, page = 2) {
  const names = Object.keys(entries).sort();
  const calls = { list: 0, get: 0, writes: 0, keys: [] as string[] };
  const kv = {
    async list(opts: { cursor?: string; limit?: number } = {}) {
      calls.list++;
      const start = opts.cursor ? Number(opts.cursor.replace("c", "")) : 0;
      const n = Math.min(page, opts.limit ?? 1000);
      const slice = names.slice(start, start + n);
      const done = start + n >= names.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: done,
        cursor: done ? undefined : `c${start + n}`,
      };
    },
    async get(k: string | string[]) {
      calls.get++;
      if (Array.isArray(k)) {
        if (k.length > 100) throw new Error("bulk get over 100");
        calls.keys.push(...k);
        return new Map(k.map((x) => [x, entries[x] ?? null]));
      }
      calls.keys.push(k);
      return entries[k] ?? null;
    },
    async put() {
      calls.writes++;
    },
    async delete() {
      calls.writes++;
    },
  };
  return { kv, calls };
}

/** A D1 stub: every all() answers `rows`; run() records its bindings. */
export function makeDb(rows: object[] = []) {
  const sqls: string[] = [];
  const binds: unknown[][] = [];
  const runs: { sql: string; values: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      const stmt = (values: unknown[]) => ({
        async all() {
          return { results: rows };
        },
        async run() {
          runs.push({ sql, values });
          return {};
        },
      });
      return {
        bind(...values: unknown[]) {
          binds.push(values);
          return stmt(values);
        },
        ...stmt([]),
      };
    },
  };
  return { db, sqls, binds, runs };
}

/** D1 over a node:sqlite database (the real platform schema). */
export function sqliteD1(sqlite: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = (values: unknown[]) => ({
        async all() {
          return {
            results: sqlite.prepare(sql).all(...(values as SQLInputValue[])),
          };
        },
        async run() {
          return sqlite.prepare(sql).run(...(values as SQLInputValue[]));
        },
      });
      return {
        bind: (...values: unknown[]) => stmt(values),
        ...stmt([]),
      };
    },
  };
}

export function makeEnv(over: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    ...VARS,
    PLATFORM_DB: makeDb().db,
    HOSTS: makeKv({}).kv,
    ...over,
  } as unknown as Env;
}

export function worker(ref = MONITOR, now = () => NOW) {
  const v = fakeVerify(ref);
  return { w: makeWorker({ verify: v.verify, now }), calls: v.calls };
}

export const req = (path: string, init: RequestInit = {}, auth?: string) =>
  new Request(`https://inventory.test${path}`, {
    ...init,
    headers: {
      ...((init.headers as Record<string, string>) ?? {}),
      ...(auth === undefined ? {} : { authorization: auth }),
    },
  });

export const BEARER = `Bearer ${JWT}`;

export async function getJson(env: Env, path: string, ref = MONITOR) {
  const res = await worker(ref).w.fetch(req(path, {}, BEARER), env);
  if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
  if (res.headers.get("cache-control") !== "no-store")
    throw new Error("cache-control");
  return (await res.json()) as Record<string, unknown>;
}
