// The platform D1 schema in node:sqlite for migration and alert-condition
// tests: every migration in apps/platform-db/migrations, plus a row helper.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { splitSql } from "./fake-cf.js";

export const MIGRATIONS_DIR = new URL(
  "../../../apps/platform-db/migrations/",
  import.meta.url,
);
export const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
export const migrationSql = (f: string) =>
  readFileSync(new URL(f, MIGRATIONS_DIR), "utf8");

export function apply(db: DatabaseSync, files: readonly string[]): void {
  for (const f of files) for (const s of splitSql(migrationSql(f))) db.exec(s);
}

/** A fresh database with `files` applied (default: every migration). */
export function platformDb(files: readonly string[] = migrationFiles) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  apply(db, files);
  return db;
}

export function insert(
  db: DatabaseSync,
  table: string,
  row: Record<string, SQLInputValue>,
): void {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...cols.map((c) => row[c] as SQLInputValue));
}

let seq = 0;
const next = () => String(++seq).padStart(4, "0");

/** An installs row (0001 columns), `active` by default. */
export function install(
  db: DatabaseSync,
  id: string,
  over: Record<string, SQLInputValue> = {},
): void {
  const n = next();
  insert(db, "installs", {
    id,
    slug: `s${n}`,
    app_host: `s${n}.example.test`,
    content_host: `s${n}-c.example.test`,
    owner_email: `owner${n}@example.test`,
    rl_ns: 8 * Number(n),
    inputs_hash: "h",
    state: "active",
    created_at: 1,
    updated_at: 1,
    ...over,
  });
}

export function lifecycle(
  db: DatabaseSync,
  installId: string,
  over: Record<string, SQLInputValue> = {},
): void {
  insert(db, "install_lifecycle", {
    install_id: installId,
    source: "admin",
    created_at: 1,
    updated_at: 1,
    ...over,
  });
}

export function signup(
  db: DatabaseSync,
  over: Record<string, SQLInputValue> = {},
): string {
  const id = `sg${next()}`;
  insert(db, "signups", {
    signup_id: id,
    source: "admin",
    slug: id,
    job_id: id,
    vars: "{}",
    status: "pending",
    created_at: 1,
    updated_at: 1,
    ...over,
  });
  return id;
}

export function job(
  db: DatabaseSync,
  installId: string,
  over: Record<string, SQLInputValue> = {},
): string {
  const id = `jb${next()}`;
  insert(db, "jobs", {
    id,
    kind: "create",
    workflow: "provision_install",
    install_id: installId,
    actor_kind: "admin",
    actor_key: "admin:a",
    actor_label: "a",
    request_id: id,
    body_hash: "h",
    args: "{}",
    status: "queued",
    created_at: 1,
    updated_at: 1,
    ...over,
  });
  return id;
}
