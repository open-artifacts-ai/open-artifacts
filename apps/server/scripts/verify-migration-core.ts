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
//     artifact_id:version, shares artifact_id:h(lower(email)) (h: a sha256
//     prefix; no plaintext emails);
//   * what explains a key that goes missing while the app stays live (see
//     EXPLAINED): the trashed artifacts (id, deleted_at, purge_after), every user as
//     id:h(lower(email)), and the audit high-water mark (the latest
//     audit_events.at and the ids at it);
//   * PRAGMA foreign_key_list of the rebuilt tables (compared even after
//     later migrations);
//   * the artifact_search rows with no artifact of their rowid.
// verify() re-reads the database and fails on: a captured key missing from a
// rebuilt table that nothing explains (new rows are fine), 0017 not recorded
// in d1_migrations, a schema object of 0017's tables missing or not as 0017
// leaves it (any object at all when no later migration ran), an
// artifact_search row that lost its artifact or points at another artifact's
// rowid, any foreign_key_check row, or integrity_check (quick_check where D1
// refuses it) not "ok". Migrations after 0017 may add, change or drop other
// objects and rows (reported, never fatal); so may other tables' counts.
// Reasons name tables, counts and objects only: never row data.
//
// EXPLAINED: every way the app deletes a row of a rebuilt table, and the
// evidence verify accepts for it. Audit rows count only after the captured
// high-water mark.
//   * artifacts, and with it its versions and shares (ON DELETE CASCADE):
//     purgeArtifact (cron trash purge, services/artifacts.ts). NOT AUDITED;
//     explained by state instead: the artifact was in the trash at capture,
//     its purge was due by verify time (deleted_at + SOFT_DELETE_DAYS and
//     purge_after both passed) and no row with its id is left.
//   * versions: no delete path but that cascade.
//   * shares, deleteShare (unshare): audit artifact.unshare on the artifact.
//     Its detail names no email, so each such row explains one missing
//     share of that artifact (unshare and transfer rows share the count).
//   * shares, transferArtifact and the departed-owner transfer
//     (services/spaces.ts, the successor's own share): audit
//     artifact.transfer on the artifact.
//   * shares, the directory's deleteUser (directory/apply.ts DROP_SHARES):
//     audit user.status on the user whose captured address the share was
//     keyed by (every share at that address).
//   * shares, moveUserEmail (services/email-move.ts, from sign-in drift and
//     directory renames): NOT AUDITED; explained by state instead: the
//     user's address changed and the same artifact has a share at the new
//     one.
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
/** LIMITS.softDeleteDays (a test keeps them equal): no @oa/shared import here. */
export const SOFT_DELETE_DAYS = 30;
const DAY = 86_400_000;
const FORMAT = "oa-verify-migration/3";

export type SchemaEntry = {
  type: string;
  name: string;
  tbl_name: string;
  sqlHash: string;
  /** The sqlHash this object must have after the migration. */
  expectHash: string;
};
export type Capture = {
  format: typeof FORMAT;
  migration: string;
  tables: { name: string; rows: number }[];
  schema: SchemaEntry[];
  keys: { artifacts: string[]; versions: string[]; shares: string[] };
  /** Artifacts with deleted_at set (purge candidates), by id. */
  trashed: { id: string; deletedAt: number; purgeAfter: number | null }[];
  /** PRAGMA foreign_key_list of each rebuilt table, one line per key column. */
  fks: Record<(typeof REBUILT)[number], string[]>;
  /** Every user as id:h(lower(email)). */
  users: string[];
  /** The latest audit_events.at (0: none) and the ids at it. */
  audit: { at: number; ids: string[] };
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

/** A short, stable hash of an email (no plaintext in a capture). */
const emailKey = async (email: unknown) =>
  (await sha256(str(email).toLowerCase())).slice(0, 32);

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
    (await keyRows(q, "shares", ["artifact_id", "email"])).map(
      async (r) => `${str(r.artifact_id)}:${await emailKey(r.email)}`,
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

async function userKeys(q: Query): Promise<string[]> {
  return (
    await Promise.all(
      (
        await keyRows(q, "users", ["id", "email"])
      ).map(async (r) => `${str(r.id)}:${await emailKey(r.email)}`),
    )
  ).sort(cmp);
}

async function foreignKeys(q: Query): Promise<Capture["fks"]> {
  const out = {} as Capture["fks"];
  for (const t of REBUILT)
    out[t] = (await q(`select * from pragma_foreign_key_list(${lit(t)})`))
      .map((r) =>
        [r.id, r.seq, r.table, r.from, r.to, r.on_update, r.on_delete, r.match]
          .map(str)
          .join(" "),
      )
      .sort(cmp);
  return out;
}

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
  const at = num(
    (await q("select coalesce(max(at), 0) as at from audit_events"))[0]?.at,
  );
  const ids = (
    await q(`select id from audit_events where at = ${at} order by id`)
  ).map((r) => str(r.id));
  return {
    format: FORMAT,
    migration: MIGRATION,
    tables: await tableCounts(q, tableNames),
    schema,
    keys: await keySets(q),
    trashed: (
      await q(
        "select id, deleted_at, purge_after from artifacts where deleted_at is not null order by id",
      )
    ).map((r) => ({
      id: str(r.id),
      deletedAt: num(r.deleted_at),
      purgeAfter: r.purge_after == null ? null : num(r.purge_after),
    })),
    fks: await foreignKeys(q),
    users: await userKeys(q),
    audit: { at, ids },
    ftsOrphans: num((await q(FTS_ORPHANS))[0]?.n),
  };
}

/**
 * Audit rows written after the capture's high-water mark (rows at the mark
 * that the capture already saw don't count): action → target id → count.
 */
async function auditSince(
  q: Query,
  mark: Capture["audit"],
): Promise<Map<string, Map<string, number>>> {
  const known = new Set(mark.ids);
  const rows = await q(
    `select id, action, target_id from audit_events where at >= ${num(mark.at)}
     and action in ('artifact.unshare', 'artifact.transfer', 'user.status')`,
  );
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (known.has(str(r.id))) continue;
    const a = str(r.action);
    const t = str(r.target_id);
    const m = out.get(a) ?? new Map<string, number>();
    m.set(t, (m.get(t) ?? 0) + 1);
    out.set(a, m);
  }
  return out;
}

/** Captured keys now missing, minus the ones EXPLAINED accounts for. */
async function unexplained(
  q: Query,
  before: Capture,
  keys: Capture["keys"],
  now: number,
): Promise<{ table: string; missing: number; explained: number }[]> {
  const live = new Set(keys.artifacts.map((k) => k.split(":")[0] as string));
  // When the purge could first take each trashed artifact (purgeExpired:
  // deleted_at older than SOFT_DELETE_DAYS and purge_after passed).
  const due = new Map(
    before.trashed.map((t) => [
      t.id,
      Math.max(t.deletedAt + SOFT_DELETE_DAYS * DAY, t.purgeAfter ?? 0),
    ]),
  );
  /** Purged during the window: trashed at capture, due by now, no row left. */
  const purged = (aid: string) =>
    !live.has(aid) && (due.get(aid) ?? Number.POSITIVE_INFINITY) <= now;
  const events = await auditSince(q, before.audit);
  const hit = (action: string, id: string) =>
    (events.get(action)?.get(id) ?? 0) > 0;
  /** Shares each artifact's unshare and transfer rows may still explain. */
  const budget = new Map<string, number>();
  for (const a of ["artifact.unshare", "artifact.transfer"])
    for (const [id, n] of events.get(a) ?? [])
      budget.set(id, (budget.get(id) ?? 0) + n);
  // Users by captured address, and where each one's address is now.
  const usersBefore = new Map<string, string[]>();
  for (const u of before.users) {
    const [id, h] = u.split(":") as [string, string];
    usersBefore.set(h, [...(usersBefore.get(h) ?? []), id]);
  }
  const usersNow = new Map(
    (await userKeys(q)).map((u) => u.split(":") as [string, string]),
  );
  const sharesNow = new Set(keys.shares);
  // Unbounded evidence first (purge, the user's removal, an address move),
  // then one unshare or transfer row per remaining share of its artifact.
  const byState = (k: string) => {
    const [aid, h] = k.split(":") as [string, string];
    if (purged(aid)) return true;
    for (const uid of usersBefore.get(h) ?? []) {
      if (hit("user.status", uid)) return true;
      const moved = usersNow.get(uid);
      if (moved && moved !== h && sharesNow.has(`${aid}:${moved}`)) return true;
    }
    return false;
  };
  const byAudit = (k: string) => {
    const aid = k.split(":")[0] as string;
    const n = budget.get(aid) ?? 0;
    if (n <= 0) return false;
    budget.set(aid, n - 1);
    return true;
  };
  const goneShares = before.keys.shares.filter((k) => !sharesNow.has(k));
  const shareOk = new Set(goneShares.filter(byState));
  for (const k of goneShares) if (!shareOk.has(k) && byAudit(k)) shareOk.add(k);
  const shareExplained = (k: string) => shareOk.has(k);
  const why: Record<(typeof REBUILT)[number], (k: string) => boolean> = {
    artifacts: (k) => purged(k.split(":")[0] as string),
    versions: (k) => purged(k.split(":")[0] as string),
    shares: shareExplained,
  };
  const out: { table: string; missing: number; explained: number }[] = [];
  for (const t of REBUILT) {
    const now = new Set(keys[t]);
    const gone = before.keys[t].filter((k) => !now.has(k));
    const ok = gone.filter(why[t]).length;
    out.push({ table: t, missing: gone.length - ok, explained: ok });
  }
  return out;
}

/** Deterministic file contents for a capture. */
export const serialize = (c: Capture) => `${JSON.stringify(c, null, 2)}\n`;

export function parseCapture(text: string): Capture {
  let c: Capture;
  try {
    c = JSON.parse(text) as Capture;
  } catch {
    // Never echo the input: a parse error message quotes it.
    throw new CheckError("not a capture file (invalid JSON)");
  }
  if (c?.format !== FORMAT || c.migration !== MIGRATION)
    throw new CheckError("not a capture file for this migration");
  return c;
}

export type Report = { ok: boolean; failures: string[]; notes: string[] };

/** The state after the migration, against `before`. */
export async function verify(
  q: Query,
  before: Capture,
  now = Date.now(),
): Promise<Report> {
  const failures: string[] = [];
  const notes: string[] = [];
  const master = await schemaRows(q);
  const tableNames = master
    .filter((m) => m.type === "table")
    .map((m) => m.name);

  // Row counts: 0017 recorded (later migrations may follow it); rebuilt
  // tables by key set below; the rest reported only.
  const counts = new Map(
    (await tableCounts(q, tableNames)).map((t) => [t.name, t.rows]),
  );
  for (const t of before.tables) {
    const now = counts.get(t.name);
    if (now === undefined) continue; // reported by the schema check
    if (now !== t.rows && t.name !== "d1_migrations")
      notes.push(`${t.name}: ${t.rows} rows before, ${now} after`);
  }
  if (!(await applied(q)))
    failures.push(`d1_migrations: ${MIGRATION_FILE} is not recorded`);
  const later = num(
    (
      await q(
        `select count(*) as n from d1_migrations where name > ${lit(MIGRATION_FILE)}`,
      )
    )[0]?.n,
  );
  if (later) notes.push(`d1_migrations: ${later} migrations after 0017`);

  // Key sets of the rebuilt tables: every captured key still there, or
  // explained (EXPLAINED).
  const keys = await keySets(q);
  for (const r of await unexplained(q, before, keys, now)) {
    const total = before.keys[r.table as (typeof REBUILT)[number]].length;
    if (r.missing)
      failures.push(
        `${r.table}: ${r.missing} of ${total} captured rows missing, unexplained`,
      );
    if (r.explained)
      notes.push(
        `${r.table}: ${r.explained} captured rows deleted by the app since capture`,
      );
  }
  for (const t of REBUILT) {
    const kept = new Set(before.keys[t]);
    const added = keys[t].filter((k) => !kept.has(k)).length;
    if (added > 0) notes.push(`${t}: ${added} rows added since capture`);
  }

  // Schema: 0017's tables exactly as it leaves them; with no later
  // migration, every other object unchanged and nothing new. A later
  // migration may change the rest (reported).
  const ours = (tbl: string) => (REBUILT as readonly string[]).includes(tbl);
  const after = new Map<string, { hash: string; tbl: string }>();
  for (const m of master)
    after.set(`${m.type} ${m.name}`, {
      hash: await sha256(m.sql),
      tbl: m.tbl_name,
    });
  const flag = (strict: boolean, msg: string) =>
    (strict ? failures : notes).push(msg);
  for (const s of before.schema) {
    const k = `${s.type} ${s.name}`;
    const a = after.get(k);
    const strict = later === 0 || ours(s.tbl_name);
    if (!a) flag(strict, `${k}: missing`);
    else if (a.tbl !== s.tbl_name)
      flag(strict, `${k}: on ${a.tbl}, expected ${s.tbl_name}`);
    else if (a.hash !== s.expectHash && (later === 0 || s.type !== "table"))
      flag(
        strict,
        `${k}: sql differs from the expected one${
          a.hash === s.sqlHash ? " (unchanged: the CHECK was not widened)" : ""
        }`,
      );
    else if (a.hash !== s.expectHash)
      notes.push(`${k}: changed after 0017 (a later migration)`);
    after.delete(k);
  }
  for (const k of after.keys()) flag(later === 0, `${k}: not there before`);
  // The rebuilt tables' foreign keys, always (a later migration may change
  // their sql, never what 0017 must keep: shares and versions cascade from
  // artifacts).
  const fks = await foreignKeys(q);
  for (const t of REBUILT)
    if (fks[t].join("\n") !== before.fks[t].join("\n"))
      failures.push(`table ${t}: foreign keys differ from before`);
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
