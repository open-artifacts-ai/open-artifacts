#!/usr/bin/env node
// The platform-db target of deploy-hosted-platform.sh (design v7 8.4): brings
// oa-<p>-platform up to every pinned migration in apps/platform-db, and reads
// it back. First in the deploy order.
//   1. The lock holds (check-migration-lock.mjs): every file pinned, unchanged.
//   2. Tracker platform_migrations (name, sha256, applied_at). When it is
//      empty or absent, 0001-0005 are detected by schema (each file's own
//      tables, indexes, triggers and added columns, derived by applying the
//      files here) and recorded with their pins; a file only partly there, or
//      a gap, stops the run. A tracker row that isn't a pinned prefix stops it.
//   3. Shape check, before any file is recorded: every table, view and index
//      that 0006-0008 create and that exists must match PRAGMA table_info,
//      index_list and index_info exactly. IF NOT EXISTS would keep an old
//      shape (#859's hand-applied signups); the fix is a new migration.
//   4. Each pinned file not in the tracker, in order: apply, insert its row,
//      read the row back. Every statement is IF NOT EXISTS, so a rerun is safe.
//   5. Read back: the tracker lists every pinned file with its pin, and every
//      0006-0008 object exists with exactly its shape.
// VERIFY_ONLY=1 reads and compares only, and fails while a file is pending.
// The tracker is created first with 0008's own statement, so 0001-0005 can be
// recorded before 0008 runs.
// The token goes in a request header, never argv, and is never printed.
// Usage: CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID PLATFORM_DB_ID [VERIFY_ONLY]
//   node scripts/ops/platform-db.mjs staging|prod
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { lockProblems } from "./check-migration-lock.mjs";

export class Refused extends Error {}

/** Files 0006 onward are shape-checked; earlier ones are detected by schema. */
const FIRST_CHECKED = "0006";
const TRACKER =
  /CREATE TABLE IF NOT EXISTS platform_migrations \([^;]*\);/;

/**
 * The pinned migrations in `dir`, in order: { name, sql, sha256 }.
 * @param {string} dir
 * @param {string} lockFile
 */
export function loadMigrations(dir, lockFile) {
  let lock;
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
const objects = async (all) =>
  (
    await all(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY type, name",
    )
  ).map((r) => ({
    type: String(r.type),
    name: String(r.name),
    table: String(r.tbl_name),
  }));
const columns = async (all, t) =>
  (await all(`PRAGMA table_info(${q(t)})`)).map((c) =>
    [c.name, c.type, c.notnull, c.dflt_value, c.pk].map(String).join("|"),
  );
const indexes = async (all, t) => {
  const out = {};
  for (const i of await all(`PRAGMA index_list(${q(t)})`)) {
    const cols = (await all(`PRAGMA index_info(${q(String(i.name))})`)).map(
      (c) => `${c.seqno}:${c.name}`,
    );
    out[String(i.name)] =
      `unique=${i.unique} origin=${i.origin} partial=${i.partial} cols=${cols.join(",")}`;
  }
  return out;
};
// Names come from sqlite_master of the files we ship; quoted all the same.
const q = (n) => `"${n.replaceAll('"', '""')}"`;

/** markers: what one file adds: "table:x", "index:x", "column:t.c", ... */
async function markersOf(db, before) {
  const all = async (sql) => db.prepare(sql).all();
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

async function snapshot(db) {
  const all = async (sql) => db.prepare(sql).all();
  const objs = await objects(all);
  const cols = {};
  for (const o of objs.filter((o) => o.type === "table"))
    cols[o.name] = await columns(all, o.name);
  return { objects: objs, cols };
}

/**
 * What the pinned files build, from a local SQLite: per file its markers
 * (0001-0005 detection), and the shapes of every table, view and index of
 * the checked files (0006 onward).
 */
export async function expected(migrations) {
  const db = new DatabaseSync(":memory:");
  const all = async (sql) => db.prepare(sql).all();
  const markers = {};
  const checked = [];
  for (const m of migrations) {
    const before = await snapshot(db);
    db.exec(m.sql);
    markers[m.name] = await markersOf(db, before);
    if (m.name >= FIRST_CHECKED)
      for (const k of markers[m.name]) {
        const [type, name] = k.split(":");
        if (type === "table" || type === "view") checked.push(name);
      }
  }
  const shapes = {};
  for (const t of checked)
    shapes[t] = { columns: await columns(all, t), indexes: await indexes(all, t) };
  db.close();
  return { markers, shapes };
}

/** The live database's shape problems against `want` (missing objects only when strict). */
async function shapeProblems(all, want, strict) {
  const live = new Map((await objects(all)).map((o) => [o.name, o]));
  const out = [];
  for (const [t, w] of Object.entries(want.shapes)) {
    if (!live.has(t)) {
      if (strict) out.push(`${t} is missing`);
      continue;
    }
    const cols = await columns(all, t);
    if (JSON.stringify(cols) !== JSON.stringify(w.columns))
      out.push(`${t} has columns ${cols.join(", ")}; want ${w.columns.join(", ")}`);
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
  return out;
}

/** 0001-0005 present on the live database, by schema: a prefix, never partial. */
async function detect(all, migrations, want) {
  const live = new Set((await objects(all)).map((o) => `${o.type}:${o.name}`));
  const colsOf = {};
  const has = async (k) => {
    if (!k.startsWith("column:")) return live.has(k);
    const [t, c] = k.slice("column:".length).split(".");
    if (!live.has(`table:${t}`)) return false;
    colsOf[t] ??= (await columns(all, t)).map((x) => x.split("|")[0]);
    return colsOf[t].includes(c);
  };
  const found = [];
  let gap = null;
  for (const m of migrations.filter((m) => m.name < FIRST_CHECKED)) {
    const ks = want.markers[m.name];
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
export async function run({ db, migrations, verifyOnly, now, log }) {
  const all = (sql, params) => db.all(sql, params);
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
  let recorded;
  let bootstrap = [];
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
    bootstrap = await detect(all, migrations, want);
    recorded = new Set();
  }

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
    const record = async (m) => {
      await all(
        "INSERT INTO platform_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
        [m.name, m.sha256, now()],
      );
      const back = await all(
        "SELECT sha256 FROM platform_migrations WHERE name = ?",
        [m.name],
      );
      if (back.length !== 1 || String(back[0].sha256) !== m.sha256)
        throw new Refused(`${m.name}: the tracker row did not read back`);
    };
    if (!rows) {
      const ddl = migrations
        .map((m) => TRACKER.exec(m.sql)?.[0])
        .find(Boolean);
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
      const [t, c] = k.slice("column:".length).split(".");
      const cs = live.has(`table:${t}`)
        ? (await columns(all, t)).map((x) => x.split("|")[0])
        : [];
      if (!cs.includes(c)) shapes.push(`${k} is missing`);
    }
  if (shapes.length)
    throw new Refused(`read back: ${shapes.join("; ")}`);
  log(`${migrations.length} migrations tracked, shapes match`);
}

/** D1 over the REST API: /query, the token in a header. */
export function d1({ token, accountId, databaseId, fetch: f = fetch }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const call = async (sql, params) => {
    let body;
    try {
      const res = await f(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(params ? { sql, params } : { sql }),
      });
      body = await res.json();
    } catch {
      throw new Refused("D1 query failed: network error or unparsable response");
    }
    if (body?.success !== true || !Array.isArray(body.result))
      throw new Refused(
        `D1 query failed: ${JSON.stringify(body?.errors ?? null)}`,
      );
    for (const r of body.result)
      if (r?.success === false) throw new Refused("D1 query failed: a statement failed");
    return body.result;
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
  const fail = (msg, code = 1) => {
    console.error(msg);
    process.exit(code);
  };
  if (env !== "staging" && env !== "prod")
    fail("usage: platform-db.mjs staging|prod", 2);
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
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const verifyOnly = Boolean(process.env.VERIFY_ONLY);
  try {
    await run({
      db: d1({
        token: CLOUDFLARE_API_TOKEN,
        accountId: CLOUDFLARE_ACCOUNT_ID,
        databaseId: PLATFORM_DB_ID,
      }),
      migrations: loadMigrations(
        join(root, "apps/platform-db/migrations"),
        join(root, "apps/platform-db/migration-lock.json"),
      ),
      verifyOnly,
      now: () => Date.now(),
      log: (s) => console.log(`oa-${env[0]}-platform: ${s}`),
    });
  } catch (e) {
    fail(
      `oa-${env[0]}-platform: ${e instanceof Refused ? e.message : "failed"}; refusing`,
    );
  }
}
