#!/usr/bin/env node
// The platform-db target of deploy-hosted-platform.sh (design v7 8.4): brings
// oa-<p>-platform up to every pinned migration in apps/platform-db, and reads
// it back. First in the deploy order.
//   1. The lock holds (check-migration-lock.mjs): every file pinned, unchanged;
//      and every pin on main's lock (MAIN_MIGRATION_LOCK) is the tag's too: a
//      tag may add a migration, never edit one and re-pin it (pinDrift).
//   2. Tracker platform_migrations (name, sha256, applied_at). A tracker row
//      that isn't a pinned prefix stops the run. Every 0001-0005 file not in
//      the tracker (all of them when it is empty or absent) is detected by
//      schema (each file's own tables, indexes, triggers and added columns,
//      derived by applying the files here) and recorded with its pin when
//      fully there; a file only partly there, or a gap, stops the run. So a
//      run that stopped between applying or detecting a file and recording it
//      converges on the next (those files ADD COLUMN, which can't rerun).
//   3. Shape check, before any file is recorded: every table, view and index
//      that 0006-0008 create and that exists must match PRAGMA table_info,
//      index_list and index_info exactly, and each index and view its
//      sqlite_master.sql (whitespace collapsed: a partial index's WHERE, a
//      view's body). IF NOT EXISTS would keep an old shape (#859's
//      hand-applied signups); the fix is a new migration.
//   4. Each pinned file not in the tracker, in order: apply, insert its row,
//      read the row back. Every statement is IF NOT EXISTS, so a rerun is safe.
//   5. Read back: the tracker lists every pinned file with its pin, and every
//      0006-0008 object exists with exactly its shape.
// VERIFY_ONLY=1 reads and compares only, and fails while a file is pending.
// The tracker is created first with 0008's own statement, so 0001-0005 can be
// recorded before 0008 runs.
// The token goes in a request header, never argv, and is never printed.
// Usage: CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID PLATFORM_DB_ID MAIN_MIGRATION_LOCK [VERIFY_ONLY]
//   node scripts/ops/platform-db.ts staging|prod
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { lockProblems } from "./check-migration-lock.mjs";

export class Refused extends Error {}

type Row = Record<string, unknown>;
type All = (sql: string, params?: SQLInputValue[]) => Promise<Row[]>;
/** The live database: rows for a statement, or a file run whole. Both throw on failure. */
export interface Db {
  all: All;
  exec: (sql: string) => Promise<void>;
}
export interface Migration {
  name: string;
  sql: string;
  sha256: string;
}
interface Shape {
  columns: string[];
  indexes: Record<string, string>;
}
interface Expected {
  markers: Record<string, string[]>;
  shapes: Record<string, Shape>;
  /** Index and view name -> its normalized sqlite_master.sql (0006 onward). */
  sqls: Record<string, string>;
}
interface Obj {
  type: string;
  name: string;
  table: string;
}

/** Files 0006 onward are shape-checked; earlier ones are detected by schema. */
const FIRST_CHECKED = "0006";
const TRACKER = /CREATE TABLE IF NOT EXISTS platform_migrations \([^;]*\);/;

/**
 * main's lock against the tag's (design v7 8.4): the tag's own lock vouches
 * only for itself, so every file main pins must keep exactly that pin in the
 * tag's lock. A changed or dropped pin is an edited migration re-pinned,
 * which never reaches a database that recorded the old file. The tag may pin
 * new files. Problems, empty when none.
 */
export function pinDrift(mainLockFile: string, tagLockFile: string): string[] {
  const pins = (f: string, what: string): Record<string, unknown> => {
    let lock: { pins?: unknown };
    try {
      lock = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      throw new Refused(`${what} migration lock is missing or not JSON`);
    }
    if (!lock?.pins || typeof lock.pins !== "object" || Array.isArray(lock.pins))
      throw new Refused(`${what} migration lock has no pins`);
    return lock.pins as Record<string, unknown>;
  };
  const main = pins(mainLockFile, "main's");
  const tag = pins(tagLockFile, "the tag's");
  const out: string[] = [];
  for (const [name, sha] of Object.entries(main)) {
    if (!(name in tag)) out.push(`${name} is pinned on main, not in the tag`);
    else if (tag[name] !== sha)
      out.push(`${name}'s pin differs from main's (an edited migration)`);
  }
  return out;
}

/** The pinned migrations in `dir`, in order. */
export function loadMigrations(dir: string, lockFile: string): Migration[] {
  let lock: Parameters<typeof lockProblems>[1];
  try {
    lock = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    throw new Refused("the migration lock is missing or not JSON");
  }
  const problems = lockProblems(dir, lock);
  if (problems.length) throw new Refused(problems.join("; "));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      const sha256 = createHash("sha256").update(sql).digest("hex");
      return { name, sql, sha256 };
    });
}

// Schema reads, the same against node:sqlite (expected) and D1 (live).
const objects = async (all: All): Promise<Obj[]> =>
  (
    await all(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY type, name",
    )
  ).map((r) => ({
    type: String(r.type),
    name: String(r.name),
    table: String(r.tbl_name),
  }));
const columns = async (all: All, t: string): Promise<string[]> =>
  (await all(`PRAGMA table_info(${q(t)})`)).map((c) =>
    [c.name, c.type, c.notnull, c.dflt_value, c.pk].map(String).join("|"),
  );
const indexes = async (all: All, t: string) => {
  const out: Record<string, string> = {};
  for (const i of await all(`PRAGMA index_list(${q(t)})`)) {
    const cols = (await all(`PRAGMA index_info(${q(String(i.name))})`)).map(
      (c) => `${c.seqno}:${c.name}`,
    );
    out[String(i.name)] =
      `unique=${i.unique} origin=${i.origin} partial=${i.partial} cols=${cols.join(",")}`;
  }
  return out;
};
/** An object's sqlite_master.sql, whitespace collapsed; "" when it has none. */
const sqlOf = async (all: All, name: string): Promise<string> => {
  const r = await all("SELECT sql FROM sqlite_master WHERE name = ?", [name]);
  const v = r[0]?.sql;
  return typeof v === "string"
    ? v.replace(/\s+/g, " ").trim().replace(/;$/, "")
    : "";
};
// Names come from sqlite_master of the files we ship; quoted all the same.
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

/** markers: what one file adds: "table:x", "index:x", "column:t.c", ... */
const local =
  (db: DatabaseSync): All =>
  async (sql, params) =>
    db.prepare(sql).all(...(params ?? [])) as Row[];

async function markersOf(
  db: DatabaseSync,
  before: Awaited<ReturnType<typeof snapshot>>,
): Promise<string[]> {
  const all = local(db);
  const now = await objects(all);
  const had = new Set(before.objects.map((o) => `${o.type}:${o.name}`));
  const out = now
    .map((o) => `${o.type}:${o.name}`)
    .filter((k) => !had.has(k) && !k.startsWith("index:sqlite_autoindex"));
  for (const o of before.objects.filter((o) => o.type === "table")) {
    const was = new Set(before.cols[o.name]);
    for (const c of await columns(all, o.name))
      if (!was.has(c)) out.push(`column:${o.name}.${c.split("|")[0]}`);
  }
  return out;
}

async function snapshot(db: DatabaseSync) {
  const all = local(db);
  const objs = await objects(all);
  const cols: Record<string, string[]> = {};
  for (const o of objs.filter((o) => o.type === "table"))
    cols[o.name] = await columns(all, o.name);
  return { objects: objs, cols };
}

/**
 * What the pinned files build, from a local SQLite: per file its markers
 * (0001-0005 detection), and the shapes of every table, view and index of
 * the checked files (0006 onward).
 */
export async function expected(migrations: Migration[]): Promise<Expected> {
  const db = new DatabaseSync(":memory:");
  const all = local(db);
  const markers: Record<string, string[]> = {};
  const checked: string[] = [];
  const texts: string[] = [];
  for (const m of migrations) {
    const before = await snapshot(db);
    db.exec(m.sql);
    const ks = await markersOf(db, before);
    markers[m.name] = ks;
    if (m.name >= FIRST_CHECKED)
      for (const k of ks) {
        const [type, name] = k.split(":") as [string, string];
        if (type === "table" || type === "view") checked.push(name);
        if (type === "index" || type === "view") texts.push(name);
      }
  }
  const sqls: Record<string, string> = {};
  for (const n of texts) sqls[n] = await sqlOf(all, n);
  const shapes: Record<string, Shape> = {};
  for (const t of checked)
    shapes[t] = {
      columns: await columns(all, t),
      indexes: await indexes(all, t),
    };
  db.close();
  return { markers, shapes, sqls };
}

/** The live database's shape problems against `want` (missing objects only when strict). */
async function shapeProblems(
  all: All,
  want: Expected,
  strict: boolean,
): Promise<string[]> {
  const live = new Map((await objects(all)).map((o) => [o.name, o]));
  const out: string[] = [];
  for (const [t, w] of Object.entries(want.shapes)) {
    if (!live.has(t)) {
      if (strict) out.push(`${t} is missing`);
      continue;
    }
    const cols = await columns(all, t);
    if (JSON.stringify(cols) !== JSON.stringify(w.columns))
      out.push(
        `${t} has columns ${cols.join(", ")}; want ${w.columns.join(", ")}`,
      );
    const idx = await indexes(all, t);
    for (const [n, s] of Object.entries(idx))
      if (w.indexes[n] !== s)
        out.push(
          w.indexes[n] === undefined
            ? `${t} has an index ${n} the migrations don't make`
            : `index ${n} on ${t} is ${s}; want ${w.indexes[n]}`,
        );
    if (strict)
      for (const n of Object.keys(w.indexes))
        if (idx[n] === undefined) out.push(`index ${n} on ${t} is missing`);
  }
  for (const [n, w] of Object.entries(want.sqls)) {
    if (!live.has(n)) continue;
    const got = await sqlOf(all, n);
    if (got !== w) out.push(`${n} is \`${got}\`; want \`${w}\``);
  }
  return out;
}

/**
 * Which of `candidates` (untracked 0001-0005 files, in order) the live
 * database has, by schema: a prefix of them, never partial.
 */
async function detect(
  all: All,
  candidates: Migration[],
  want: Expected,
): Promise<Migration[]> {
  const live = new Set((await objects(all)).map((o) => `${o.type}:${o.name}`));
  const colsOf: Record<string, string[]> = {};
  const has = async (k: string) => {
    if (!k.startsWith("column:")) return live.has(k);
    const [t, c] = k.slice("column:".length).split(".") as [string, string];
    if (!live.has(`table:${t}`)) return false;
    colsOf[t] ??= (await columns(all, t)).map((x) => x.split("|")[0] as string);
    return colsOf[t].includes(c);
  };
  const found: Migration[] = [];
  let gap: string | null = null;
  for (const m of candidates) {
    const ks = want.markers[m.name] ?? [];
    let n = 0;
    for (const k of ks) if (await has(k)) n++;
    if (n > 0 && n < ks.length)
      throw new Refused(
        `${m.name} is only partly applied (${n} of ${ks.length} of its objects); fix it by hand, then rerun`,
      );
    if (n === 0) {
      gap ??= m.name;
      continue;
    }
    if (gap)
      throw new Refused(`${m.name} is applied but ${gap} is not; refusing`);
    found.push(m);
  }
  return found;
}

/**
 * Migrates (or, verifyOnly, checks) the live database. `db.all(sql, params)`
 * returns rows; `db.exec(sql)` runs a file. Both throw on any failure.
 */
export async function run({
  db,
  migrations,
  verifyOnly,
  now,
  log,
}: {
  db: Db;
  migrations: Migration[];
  verifyOnly: boolean;
  now: () => number;
  log: (s: string) => void;
}): Promise<void> {
  const all: All = (sql, params) => db.all(sql, params);
  const want = await expected(migrations);
  const pins = new Map(migrations.map((m) => [m.name, m.sha256]));

  const tracked = async () => {
    const t = await all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_migrations'",
    );
    if (t.length === 0) return null;
    return (
      await all("SELECT name, sha256 FROM platform_migrations ORDER BY name")
    ).map((r) => ({ name: String(r.name), sha256: String(r.sha256) }));
  };
  const rows = await tracked();
  let recorded: Set<string>;
  let bootstrap: Migration[];
  if (rows && rows.length > 0) {
    rows.forEach((r, i) => {
      if (!pins.has(r.name))
        throw new Refused(`the tracker lists ${r.name}, which is not pinned`);
      if (pins.get(r.name) !== r.sha256)
        throw new Refused(`the tracker's sha256 for ${r.name} is not its pin`);
      if (migrations[i]?.name !== r.name)
        throw new Refused(
          `the tracker is not a prefix of the pinned files (at ${r.name})`,
        );
    });
    recorded = new Set(rows.map((r) => r.name));
  } else {
    recorded = new Set();
  }
  bootstrap = await detect(
    all,
    migrations.filter((m) => m.name < FIRST_CHECKED && !recorded.has(m.name)),
    want,
  );

  const before = await shapeProblems(all, want, false);
  if (before.length)
    throw new Refused(
      `the live schema differs from the migrations (add a new numbered migration): ${before.join("; ")}`,
    );

  const pending = migrations.filter(
    (m) => !recorded.has(m.name) && !bootstrap.includes(m),
  );
  if (verifyOnly) {
    if (bootstrap.length || pending.length)
      throw new Refused(
        `not migrated: ${[...bootstrap, ...pending].map((m) => m.name).join(", ")} not in the tracker`,
      );
  } else {
    const record = async (m: Migration) => {
      await all(
        "INSERT INTO platform_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
        [m.name, m.sha256, now()],
      );
      const back = await all(
        "SELECT sha256 FROM platform_migrations WHERE name = ?",
        [m.name],
      );
      if (back.length !== 1 || String(back[0]?.sha256) !== m.sha256)
        throw new Refused(`${m.name}: the tracker row did not read back`);
    };
    if (!rows) {
      const ddl = migrations.map((m) => TRACKER.exec(m.sql)?.[0]).find(Boolean);
      if (!ddl) throw new Refused("no migration creates platform_migrations");
      await db.exec(ddl);
    }
    for (const m of bootstrap) {
      await record(m);
      log(`${m.name}: present, recorded`);
    }
    for (const m of pending) {
      await db.exec(m.sql);
      await record(m);
      log(`${m.name}: applied`);
    }
  }

  const after = await tracked();
  const names = (after ?? []).map((r) => r.name).join(",");
  if (names !== migrations.map((m) => m.name).join(","))
    throw new Refused(`the tracker lists '${names}' after the run`);
  for (const r of after ?? [])
    if (pins.get(r.name) !== r.sha256)
      throw new Refused(`the tracker's sha256 for ${r.name} is not its pin`);
  const shapes = await shapeProblems(all, want, true);
  const live = new Set((await objects(all)).map((o) => `${o.type}:${o.name}`));
  for (const ks of Object.values(want.markers))
    for (const k of ks) {
      if (!k.startsWith("column:")) {
        if (!live.has(k)) shapes.push(`${k} is missing`);
        continue;
      }
      const [t, c] = k.slice("column:".length).split(".") as [string, string];
      const cs = live.has(`table:${t}`)
        ? (await columns(all, t)).map((x) => x.split("|")[0])
        : [];
      if (!cs.includes(c)) shapes.push(`${k} is missing`);
    }
  if (shapes.length) throw new Refused(`read back: ${shapes.join("; ")}`);
  log(`${migrations.length} migrations tracked, shapes match`);
}

/** D1 over the REST API: /query, the token in a header. */
export function d1({
  token,
  accountId,
  databaseId,
  fetch: f = fetch,
}: {
  token: string;
  accountId: string;
  databaseId: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): Db {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  type Result = { success?: boolean; results?: Row[] };
  const call = async (
    sql: string,
    params?: SQLInputValue[],
  ): Promise<Result[]> => {
    let body: { success?: unknown; result?: unknown; errors?: unknown };
    try {
      const res = await f(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(params ? { sql, params } : { sql }),
      });
      body = (await res.json()) as typeof body;
    } catch {
      throw new Refused(
        "D1 query failed: network error or unparsable response",
      );
    }
    if (body?.success !== true || !Array.isArray(body.result))
      throw new Refused(
        `D1 query failed: ${JSON.stringify(body?.errors ?? null)}`,
      );
    const result = body.result as Result[];
    for (const r of result)
      if (r?.success === false)
        throw new Refused("D1 query failed: a statement failed");
    return result;
  };
  return {
    all: async (sql, params) => (await call(sql, params))[0]?.results ?? [],
    exec: async (sql) => {
      await call(sql);
    },
  };
}

// Run as a script (paths compared after symlinks, as macOS's /var is one).
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const env = process.argv[2];
  const fail = (msg: string, code = 1): never => {
    console.error(msg);
    process.exit(code);
  };
  if (env !== "staging" && env !== "prod")
    fail("usage: platform-db.ts staging|prod", 2);
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PLATFORM_DB_ID } =
    process.env;
  if (!CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN is required", 2);
  if (!/^[0-9a-f]{32}$/.test(CLOUDFLARE_ACCOUNT_ID ?? ""))
    fail("CLOUDFLARE_ACCOUNT_ID must be 32 hex", 2);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      PLATFORM_DB_ID ?? "",
    )
  )
    fail("PLATFORM_DB_ID must be a uuid", 2);
  // main's lock (deploy-hosted-platform.yml copies it from main's checkout).
  const mainLock = process.env.MAIN_MIGRATION_LOCK;
  if (!mainLock) fail("MAIN_MIGRATION_LOCK (main's migration-lock.json) is required", 2);
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const lockFile = join(root, "apps/platform-db/migration-lock.json");
  const verifyOnly = Boolean(process.env.VERIFY_ONLY);
  try {
    const drift = pinDrift(mainLock as string, lockFile);
    if (drift.length) throw new Refused(drift.join("; "));
    await run({
      db: d1({
        token: CLOUDFLARE_API_TOKEN as string,
        accountId: CLOUDFLARE_ACCOUNT_ID as string,
        databaseId: PLATFORM_DB_ID as string,
      }),
      migrations: loadMigrations(
        join(root, "apps/platform-db/migrations"),
        lockFile,
      ),
      verifyOnly,
      now: () => Date.now(),
      log: (s) => console.log(`oa-${env?.[0]}-platform: ${s}`),
    });
  } catch (e) {
    fail(
      `oa-${env?.[0]}-platform: ${e instanceof Refused ? e.message : "failed"}; refusing`,
    );
  }
}
