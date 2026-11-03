// Times every migration newer than the last release against a large
// synthetic database (#1213), and fails at BUDGET_MS or more for any one.
//
// Why: migration 0021 took 278 s per 1M audit rows before its index fix
// (#1175), and staging's small databases can't show that. D1 stops a query
// at 30 s, so a 3 s budget on the runner leaves about 10x for D1 being slower
// than the runner (unmeasured). Runner SQLite isn't D1: the times are
// relative, and D1-only limits (statement size, its own planner settings)
// aren't covered.
//
// Steps:
//   1. The last release: the newest v* tag reachable from HEAD
//      (MIGRATION_BASE overrides it, to time older migrations). The new
//      migrations: the .sql files in apps/server/migrations that the release
//      doesn't have. None: say so and pass.
//   2. The seed: the release's own migration files (read from the tag),
//      applied in order and recorded in d1_migrations as wrangler does, then
//      filled by migration-seed.ts. Reused when --seed-file holds one for the
//      same key (the release's migration blobs and the seeder's hash).
//   3. Each new migration, whole file in one transaction, on a copy of the
//      seed, in a child process: its wall time is printed. A child still
//      running at STOP_MS (D1's own limit) is stopped and counts as failed.
//   4. Every table of the migrated schema needs a seed rule: one without
//      fails, naming it, so the seeder grows with the schema.
//
// Usage (from anywhere in the repo):
//   node --experimental-strip-types apps/server/scripts/migration-timing.ts \
//     [--seed-file PATH] [--key]
//   --key prints the seed's cache key and exits.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { missingRules, SHAPE, seed } from "./migration-seed.ts";

export const BUDGET_MS = 3_000;
export const STOP_MS = 30_000;
const MIGRATIONS = "apps/server/migrations";
const SEEDER = path.join(import.meta.dirname, "migration-seed.ts");

const git = (args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();

const sqlFiles = (names: string[]) =>
  names.filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();

export const D1_MIGRATIONS = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Applies one migration file the way the runner does: whole, then recorded. */
export function applyMigration(db: DatabaseSync, name: string, sql: string) {
  db.exec("begin");
  try {
    db.exec(sql);
    db.prepare("insert into d1_migrations (name) values (?)").run(
      name.replace(/\.sql$/, ""),
    );
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

function plan() {
  const root = git(["rev-parse", "--show-toplevel"]);
  const base =
    process.env.MIGRATION_BASE ||
    git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"]);
  const listing = git(["ls-tree", base, "--", `${MIGRATIONS}/`]);
  const released = sqlFiles(
    listing
      .split("\n")
      .filter(Boolean)
      .map((l) => path.basename(l.split("\t")[1] ?? "")),
  );
  const current = sqlFiles(readdirSync(path.join(root, MIGRATIONS)));
  const fresh = current.filter((n) => !released.includes(n));
  const key = createHash("sha256")
    .update(listing)
    .update("\0")
    .update(readFileSync(SEEDER))
    .digest("hex")
    .slice(0, 32);
  return { root, base, released, current, fresh, key: `migration-seed-${key}` };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

function buildSeed(base: string, released: string[], file: string) {
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec("pragma journal_mode = off; pragma synchronous = off;");
  db.exec("pragma cache_size = -1000000;");
  db.exec(D1_MIGRATIONS);
  for (const name of released) {
    applyMigration(db, name, git(["show", `${base}:${MIGRATIONS}/${name}`]));
  }
  const r = seed(db);
  db.close();
  renameSync(tmp, file);
  return r;
}

/** Child mode: apply one migration file to a database, print its ms. */
function child(dbFile: string, migration: string) {
  const db = new DatabaseSync(dbFile);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  const sql = readFileSync(migration, "utf8");
  const t0 = performance.now();
  applyMigration(db, path.basename(migration), sql);
  const ms = performance.now() - t0;
  db.close();
  process.stdout.write(`${JSON.stringify({ ms })}\n`);
}

function main(argv: string[]): number {
  if (argv[0] === "--apply") {
    child(argv[1] ?? "", argv[2] ?? "");
    return 0;
  }
  const t0 = performance.now();
  const p = plan();
  if (argv.includes("--key")) {
    console.log(p.key);
    return 0;
  }
  console.log(
    `last release: ${p.base} (${p.released.length} migrations); new: ${p.fresh.length ? p.fresh.join(", ") : "none"}`,
  );

  // Every table of the current schema needs a seed rule (cheap: no rows).
  const schema = new DatabaseSync(":memory:");
  for (const name of p.current) {
    schema.exec(readFileSync(path.join(p.root, MIGRATIONS, name), "utf8"));
  }
  const missing = missingRules(schema);
  schema.close();
  if (missing.length > 0) {
    console.log(
      `FAIL: no seed rule for table(s): ${missing.join(", ")}. Add a rule to RULES in apps/server/scripts/migration-seed.ts`,
    );
    return 1;
  }

  if (p.fresh.length === 0) {
    console.log(`no migration newer than ${p.base}: nothing to time`);
    return 0;
  }

  const i = argv.indexOf("--seed-file");
  const seedFile = path.resolve(
    i >= 0 && argv[i + 1]
      ? (argv[i + 1] as string)
      : path.join(tmpdir(), "oa-migration-seed.sqlite"),
  );
  mkdirSync(path.dirname(seedFile), { recursive: true });
  const keyFile = `${seedFile}.key`;
  const cached =
    existsSync(seedFile) &&
    existsSync(keyFile) &&
    readFileSync(keyFile, "utf8").trim() === p.key;
  if (cached) {
    console.log(`seed: reused ${seedFile} (${p.key})`);
  } else {
    rmSync(keyFile, { force: true });
    const r = buildSeed(p.base, p.released, seedFile);
    writeFileSync(keyFile, `${p.key}\n`);
    const shape = Object.entries(r.rows)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    console.log(`seed: built in ${secs(r.ms)} (${p.key})`);
    console.log(`seed rows: ${shape}`);
  }
  console.log(
    `seed file: ${mb(statSync(seedFile).size)} (users ${SHAPE.users}, audit_events ${SHAPE.audit_events})`,
  );

  const work = mkdtempSync(path.join(tmpdir(), "oa-migration-timing-"));
  const db = path.join(work, "work.sqlite");
  copyFileSync(seedFile, db);
  const results: { name: string; ms: number; stopped: boolean }[] = [];
  let failed = false;
  try {
    for (const name of p.fresh) {
      const r = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          import.meta.filename,
          "--apply",
          db,
          path.join(p.root, MIGRATIONS, name),
        ],
        { encoding: "utf8", timeout: STOP_MS, killSignal: "SIGKILL" },
      );
      if (r.error || r.signal) {
        results.push({ name, ms: STOP_MS, stopped: true });
        console.log(`${name}: stopped at ${secs(STOP_MS)} (D1's limit)`);
        failed = true;
        break; // the database is mid-migration; later ones can't be timed
      }
      if (r.status !== 0) {
        console.log(`${name}: failed to apply\n${r.stderr}`);
        failed = true;
        break;
      }
      const ms = (JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
        ms: number;
      }).ms;
      results.push({ name, ms, stopped: false });
      console.log(`${name}: ${secs(ms)}`);
    }
    if (!failed) {
      const after = new DatabaseSync(db);
      const left = missingRules(after);
      after.close();
      if (left.length > 0) {
        console.log(`FAIL: no seed rule for table(s): ${left.join(", ")}`);
        failed = true;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const slow = results.filter((r) => r.stopped || r.ms >= BUDGET_MS);
  for (const r of slow) {
    console.log(
      `FAIL: ${r.name} took ${r.stopped ? `${secs(r.ms)} or more (stopped)` : secs(r.ms)}; the budget is under ${secs(BUDGET_MS)}`,
    );
  }
  console.log(`total wall time: ${secs(performance.now() - t0)}`);
  if (failed || slow.length > 0) return 1;
  console.log(
    `ok: ${results.length} new migration(s), each under ${secs(BUDGET_MS)}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
