// The checks behind verify-migration.ts, with no Node or Workers imports:
// the CLI runs them through `wrangler d1 execute --remote --json`, and
// test/node/migration-0017.test.ts runs the same code against a local D1.
//
// Migration 0017_image_format rebuilds artifacts, versions and shares to widen
// the format CHECK (see its header). capture() records, before it runs:
//   * every table's row count (sorted by name);
//   * every sqlite_master object (type, name, tbl_name, sha256 of its sql) and
//     the hash its sql must have afterwards (the format CHECK widened on
//     artifacts and versions, everything else unchanged);
//   * the key sets of the rebuilt tables: artifacts id:rowid, versions
//     artifact_id:version, shares sha256(artifact_id, lower(email)) (no
//     plaintext emails);
//   * the artifact_search rows with no artifact of their rowid.
// verify() re-reads the database and fails on: a captured key missing from a
// rebuilt table (new rows are fine, the app stays live), d1_migrations not
// exactly one row more with 0017 recorded, any schema object missing, extra
// or with other sql than expected, an artifact_search row that lost its
// artifact or points at another artifact's rowid, any foreign_key_check row,
// or integrity_check (quick_check where D1 refuses it) not "ok". Other
// tables' counts are reported, never fatal. Reasons name tables, counts and
// objects only: never row data.
//
// Deterministic: the same database captures to the same bytes (sorted, no
// timestamps or run ids), so a recapture compares with cmp.

/** Runs one SQL statement and returns its rows. */
export type Query = (sql: string) => Promise<Record<string, unknown>[]>;

export const MIGRATION = "0017_image_format";
export const MIGRATION_FILE = `${MIGRATION}.sql`;
export const REBUILT = ["artifacts", "versions", "shares"] as const;
export const WIDENED = ["artifacts", "versions"] as const;
export const NARROW = "in ('html', 'markdown', 'code', 'pdf')";
export const WIDE = "in ('html', 'markdown', 'code', 'pdf', 'image')";
const PAGE = 5000;

export type SchemaEntry = {
  type: string;
  name: string;
  tbl_name: string;
  sqlHash: string;
  /** The sqlHash this object must have after the migration. */
  expectHash: string;
};
export type Capture = {
  format: "oa-verify-migration/1";
  migration: string;
  tables: { name: string; rows: number }[];
  schema: SchemaEntry[];
  keys: { artifacts: string[]; versions: string[]; shares: string[] };
  ftsOrphans: number;
};

export class CheckError extends Error {}

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256(s: string): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? "" : String(v));

/** sqlite_master: everything but SQLite's and D1's internal objects. */
async function schemaRows(q: Query) {
  const rows = await q(
    `select type, name, tbl_name, sql from sqlite_master
     where name not like 'sqlite\\_%' escape '\\' or type = 'index'`,
  );
  return rows
    .map((r) => ({
      type: str(r.type),
      name: str(r.name),
      tbl_name: str(r.tbl_name),
      sql: str(r.sql),
    }))
    .filter((r) => !r.name.startsWith("_cf_") && r.name !== "sqlite_sequence")
    .sort((a, b) => cmp(a.type, b.type) || cmp(a.name, b.name));
}

/** User tables (not virtual-table internals of D1), sorted. */
async function tableCounts(q: Query, names: string[]) {
  // One row of scalar subqueries per chunk: D1 caps compound SELECTs (union
  // all) at a few terms and a result at 100 columns.
  const out: { name: string; rows: number }[] = [];
  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50);
    const row =
      (
        await q(
          `select ${chunk
            .map((n, j) => `(select count(*) from ${ident(n)}) as c${j}`)
            .join(", ")}`,
        )
      )[0] ?? {};
    for (const [j, name] of chunk.entries())
      out.push({ name, rows: num(row[`c${j}`]) });
  }
  return out;
}

/** Pages through a table by rowid; `cols` are the key columns. */
async function keyRows(q: Query, table: string, cols: string[]) {
  const out: Record<string, unknown>[] = [];
  let after = -Infinity;
  for (;;) {
    const page = await q(
      `select rowid as _r, ${cols.map(ident).join(", ")} from ${ident(table)}
       ${after === -Infinity ? "" : `where rowid > ${after}`} order by rowid limit ${PAGE}`,
    );
    out.push(...page);
    if (page.length < PAGE) return out;
    after = num(page[page.length - 1]?._r);
  }
}

async function keySets(q: Query) {
  const artifacts = (await keyRows(q, "artifacts", ["id"])).map(
    (r) => `${str(r.id)}:${num(r._r)}`,
  );
  const versions = (
    await keyRows(q, "versions", ["artifact_id", "version"])
  ).map((r) => `${str(r.artifact_id)}:${num(r.version)}`);
  const shares = await Promise.all(
    (await keyRows(q, "shares", ["artifact_id", "email"])).map((r) =>
      sha256(`${str(r.artifact_id)}\u0000${str(r.email).toLowerCase()}`),
    ),
  );
  return {
    artifacts: artifacts.sort(cmp),
    versions: versions.sort(cmp),
    shares: shares.sort(cmp),
  };
}

const FTS_ORPHANS = `select count(*) as n from artifact_search s
  where not exists (select 1 from artifacts a where a.rowid = s.rowid)`;
const FTS_MISMATCH = `select count(*) as n from artifact_search s
  join artifacts a on a.rowid = s.rowid where s.artifact_id is not a.id`;

async function applied(q: Query): Promise<boolean> {
  const r = await q(
    `select count(*) as n from d1_migrations where name = ${lit(MIGRATION_FILE)}`,
  );
  return num(r[0]?.n) > 0;
}

/** The state before the migration. Throws CheckError when it can't run. */
export async function capture(q: Query): Promise<Capture> {
  const master = await schemaRows(q);
  const tableNames = master
    .filter((m) => m.type === "table")
    .map((m) => m.name);
  for (const t of [...REBUILT, "artifact_search", "d1_migrations"])
    if (!tableNames.includes(t)) throw new CheckError(`table ${t} is missing`);
  if (await applied(q))
    throw new CheckError(`${MIGRATION} is already applied: capture before it`);
  // The rebuild copies rows back under enforced FKs: a violation now would
  // abort it. Report it here, before anything runs.
  const fk = await q("PRAGMA foreign_key_check");
  if (fk.length)
    throw new CheckError(
      `foreign_key_check: ${fk.length} rows already violate a foreign key; fix them before migrating`,
    );
  const schema: SchemaEntry[] = [];
  for (const m of master) {
    let after = m.sql;
    if (m.type === "table" && (WIDENED as readonly string[]).includes(m.name)) {
      if (after.split(NARROW).length !== 2)
        throw new CheckError(
          `table ${m.name}: the format CHECK is not the expected one`,
        );
      after = after.replace(NARROW, WIDE);
    }
    schema.push({
      type: m.type,
      name: m.name,
      tbl_name: m.tbl_name,
      sqlHash: await sha256(m.sql),
      expectHash: await sha256(after),
    });
  }
  return {
    format: "oa-verify-migration/1",
    migration: MIGRATION,
    tables: await tableCounts(q, tableNames),
    schema,
    keys: await keySets(q),
    ftsOrphans: num((await q(FTS_ORPHANS))[0]?.n),
  };
}

/** Deterministic file contents for a capture. */
export const serialize = (c: Capture) => `${JSON.stringify(c, null, 2)}\n`;

export function parseCapture(text: string): Capture {
  const c = JSON.parse(text) as Capture;
  if (c?.format !== "oa-verify-migration/1" || c.migration !== MIGRATION)
    throw new CheckError("not a capture file for this migration");
  return c;
}

export type Report = { ok: boolean; failures: string[]; notes: string[] };

/** The state after the migration, against `before`. */
export async function verify(q: Query, before: Capture): Promise<Report> {
  const failures: string[] = [];
  const notes: string[] = [];
  const master = await schemaRows(q);
  const tableNames = master
    .filter((m) => m.type === "table")
    .map((m) => m.name);

  // Row counts: d1_migrations exactly +1; rebuilt tables by key set below.
  const counts = new Map(
    (await tableCounts(q, tableNames)).map((t) => [t.name, t.rows]),
  );
  for (const t of before.tables) {
    const now = counts.get(t.name);
    if (now === undefined) continue; // reported by the schema check
    if (t.name === "d1_migrations") {
      if (now !== t.rows + 1)
        failures.push(
          `d1_migrations: ${now} rows, expected ${t.rows + 1} (one more)`,
        );
    } else if (now !== t.rows)
      notes.push(`${t.name}: ${t.rows} rows before, ${now} after`);
  }
  if (!(await applied(q)))
    failures.push(`d1_migrations: ${MIGRATION_FILE} is not recorded`);

  // Key sets of the rebuilt tables: every captured key still there.
  const keys = await keySets(q);
  for (const t of REBUILT) {
    const now = new Set(keys[t]);
    const missing = before.keys[t].filter((k) => !now.has(k)).length;
    if (missing)
      failures.push(
        `${t}: ${missing} of ${before.keys[t].length} captured rows missing`,
      );
    const added = keys[t].length - (before.keys[t].length - missing);
    if (added > 0) notes.push(`${t}: ${added} rows added since capture`);
  }

  // Schema: the same objects, each with the sql it should have now.
  const after = new Map<string, { hash: string; tbl: string }>();
  for (const m of master)
    after.set(`${m.type} ${m.name}`, {
      hash: await sha256(m.sql),
      tbl: m.tbl_name,
    });
  for (const s of before.schema) {
    const k = `${s.type} ${s.name}`;
    const a = after.get(k);
    if (!a) failures.push(`${k}: missing`);
    else if (a.tbl !== s.tbl_name)
      failures.push(`${k}: on ${a.tbl}, expected ${s.tbl_name}`);
    else if (a.hash !== s.expectHash)
      failures.push(
        `${k}: sql differs from the expected one${
          a.hash === s.sqlHash ? " (unchanged: the CHECK was not widened)" : ""
        }`,
      );
    after.delete(k);
  }
  for (const k of after.keys()) failures.push(`${k}: not there before`);
  for (const t of WIDENED) {
    const m = master.find((x) => x.type === "table" && x.name === t);
    if (m && !m.sql.includes(WIDE))
      failures.push(`table ${t}: format CHECK does not allow 'image'`);
  }

  // FTS wiring: artifact_search rowid = artifacts.rowid, same artifact.
  if (tableNames.includes("artifact_search")) {
    const orphans = num((await q(FTS_ORPHANS))[0]?.n);
    if (orphans > before.ftsOrphans)
      failures.push(
        `artifact_search: ${orphans} rows without an artifact (${before.ftsOrphans} before)`,
      );
    else if (orphans > 0)
      notes.push(
        `artifact_search: ${orphans} rows without an artifact, as before`,
      );
    const wrong = num((await q(FTS_MISMATCH))[0]?.n);
    if (wrong)
      failures.push(
        `artifact_search: ${wrong} rows point at another artifact's rowid`,
      );
  }

  // Integrity.
  const fk = await q("PRAGMA foreign_key_check");
  if (fk.length) {
    const by = new Map<string, number>();
    for (const r of fk) by.set(str(r.table), (by.get(str(r.table)) ?? 0) + 1);
    for (const [t, n] of [...by].sort((a, b) => cmp(a[0], b[0])))
      failures.push(`foreign_key_check: ${n} rows in ${t}`);
  }
  let integrity: Record<string, unknown>[];
  let which = "integrity_check";
  try {
    integrity = await q("PRAGMA integrity_check");
  } catch {
    which = "quick_check";
    integrity = await q("PRAGMA quick_check");
  }
  const vals = integrity.map((r) => str(Object.values(r)[0]));
  if (vals.length !== 1 || vals[0] !== "ok")
    failures.push(`${which}: ${vals.length} problems reported`);
  else notes.push(`${which}: ok`);

  return { ok: failures.length === 0, failures, notes };
}
