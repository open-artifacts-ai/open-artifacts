import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import {
  main,
  parseArgs,
  parseWranglerJson,
} from "../../scripts/verify-migration.ts";
import {
  capture,
  MIGRATION_FILE,
  NARROW,
  parseCapture,
  type Query,
  serialize,
  verify,
  WIDE,
} from "../../scripts/verify-migration-core.ts";

// Rehearsal of migration 0017_image_format (the format CHECK rebuild) on a
// local D1 (workerd through wrangler's getPlatformProxy: the same SQLite, the
// same enforced foreign keys and the same SQLITE_AUTH limits as D1). The DB
// is migrated to 0016, every table is populated prod-shaped (FTS rows,
// shares, versions, rowid gaps, triggers exercised), then 0017 runs. Every
// table's row count, foreign_key_check, quick_check (integrity_check is
// refused on D1), sqlite_master and an FTS query must match, and
// verify-migration's capture/verify (the script Platform runs on prod) must
// pass on the same DB.
const DIR = join(import.meta.dirname, "../../migrations");
const files = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();
const target = files.indexOf(MIGRATION_FILE);
const statements = (f: string) =>
  readFileSync(join(DIR, f), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gm, "").trim() !== "");

let dispose: () => Promise<void>;
let db: D1Database;
const q: Query = async (sql) =>
  (await db.prepare(sql).all<Record<string, unknown>>()).results;
const run = (sql: string, ...b: unknown[]) =>
  db
    .prepare(sql)
    .bind(...b)
    .run();

/** As `wrangler d1 migrations apply`: each file one batch, then its d1_migrations row. */
async function apply(f: string) {
  await db.batch([
    ...statements(f).map((s) => db.prepare(s)),
    db.prepare("insert into d1_migrations (name) values (?)").bind(f),
  ]);
}

type Snap = {
  counts: Record<string, number>;
  master: { type: string; name: string; tbl_name: string; sql: string }[];
  fts: unknown[];
  fk: unknown[];
  quick: unknown[];
  rowids: unknown[];
  content: Record<string, unknown[]>;
};
async function snap(): Promise<Snap> {
  const master = (
    await q(
      "select type, name, tbl_name, coalesce(sql, '') as sql from sqlite_master where name not like '_cf_%' order by type, name",
    )
  ).map((r) => ({
    type: String(r.type),
    name: String(r.name),
    tbl_name: String(r.tbl_name),
    sql: String(r.sql),
  }));
  const counts: Record<string, number> = {};
  for (const m of master)
    if (m.type === "table")
      counts[m.name] = Number(
        (await q(`select count(*) as n from "${m.name}"`))[0]?.n,
      );
  // Every column of every row of the rebuilt tables, exactly (quote() keeps
  // the storage class: 1 vs '1' vs 1.0, NULL vs '').
  const content: Record<string, unknown[]> = {};
  for (const t of ["artifacts", "versions", "shares"]) {
    const cols = (await q(`select name from pragma_table_info('${t}')`)).map(
      (r) => `quote("${String(r.name)}")`,
    );
    content[t] = await q(
      `select rowid as _r, ${cols.join(", ")} from "${t}" order by rowid`,
    );
  }
  return {
    content,
    counts,
    master,
    // Search as the app does: match, then join on rowid.
    fts: await q(
      `select a.id, a.title, s.body from artifact_search s join artifacts a on a.rowid = s.rowid
       where artifact_search match 'quarterly OR roadmap' order by a.id`,
    ),
    fk: await q("PRAGMA foreign_key_check"),
    quick: await q("PRAGMA quick_check"),
    rowids: await q(
      "select 'a' t, rowid r, id k from artifacts union all select 'v', rowid, artifact_id || ':' || version from versions union all select 's', rowid, artifact_id || ':' || email from shares order by 1, 2",
    ),
  };
}

const USERS = ["u-owner", "u-ann", "u-bob", "u-guest"];
const A = (i: number) => `art${String(i).padStart(4, "0")}`;
const N = 60;

async function seed() {
  // users (the users_personal_space trigger creates each personal space).
  for (const [i, u] of USERS.entries())
    await run(
      `insert into users (id, email, name, role, created_at, display_name, status, guest_lapsed)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      u,
      `${u}@Example.com`,
      u,
      i === 0 ? "owner" : i === 3 ? "guest" : "member",
      1000 + i,
      i === 1 ? "Ann" : null,
      i === 3 ? "removed" : "active",
      i === 3 ? 1 : 0,
    );
  await run(
    "insert into spaces (id, kind, name, owner_user_id, all_members_role, public_links, created_at) values ('sp-team', 'shared', 'Team', null, 'viewer', 0, 5)",
  );
  await run(
    "insert into space_members (space_id, user_id, role, source, created_at) values ('sp-team', 'u-ann', 'manager', 'manual', 6), ('sp-team', 'u-bob', 'editor', 'sync', 6)",
  );
  await run(
    "insert into group_mappings values ('sp-team', 'g1', 'eng@example.com', 'editor')",
  );
  await run(
    "insert into org_group_mappings values ('g2', 'all@example.com', 'viewer')",
  );
  await run(
    "insert into restricted_groups values ('g3', 'contractors@example.com', 7)",
  );
  await run(
    `insert into directory_groups values ('g1', 'eng@example.com', '["g2"]', 3), ('g2', 'all@example.com', '[]', 3)`,
  );
  await run(
    "insert into directory_members values ('g1', 'u-bob', 3), ('g2', 'u-ann', 3)",
  );
  await run(
    "insert into directory_state values ('sync.state', 'ok'), ('sync.cursor', 'c1')",
  );
  await run(
    "insert into frozen_edits values ('sp-team', 'u-bob', 8, 'viewer', 'override')",
  );
  await run(
    "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', 's-ann', 't', 'u-ann', 9, 1)",
  );
  await run(
    "insert into login_codes values ('ann@example.com', 'r1', 'h', 99999, 1, 10)",
  );
  await run(
    "insert into tokens (id, user_id, label, token_hash, created_at, versions_published) values ('t1', 'u-owner', 'cli', 'th1', 11, 4)",
  );
  await run(
    "insert into agent_grants values ('gr1', 'u-ann', 'Claude', 12, '1.2', 3)",
  );
  await run("insert into counters values ('browser_slot', 1, '2026-10-28')");
  await run(
    `insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, space_id, detail)
     values ('ev1', 13, 'user', 'u-owner', 'artifact.share', 'artifact', 'art0001', 'sp-team', '{"email":"x"}')`,
  );
  await run(
    "insert into reserved_artifacts values ('res1', 'u-ann', 14), ('res2', 'u-bob', 15)",
  );
  const formats = ["html", "markdown", "code", "pdf"];
  for (let i = 0; i < N; i++) {
    const owner = USERS[i % 3] as string;
    // Every 7th artifact relies on artifacts_space_default (old code path).
    const space = i % 7 === 0 ? null : i % 5 === 0 ? "sp-team" : owner;
    await run(
      `insert into artifacts (id, owner_id, space_id, title, description, format, visibility, current_version,
         capabilities, allow_anonymous_writes, data_writers, has_thumbnail, thumbnail_version, created_at, updated_at, deleted_at)
       values (?, ?, ?, ?, ?, ?, ?, 2, '{"db":true,"viewer":false,"storage":false}', ?, ?, ?, ?, ?, ?, ?)`,
      A(i),
      owner,
      space,
      i % 4 === 0 ? `Quarterly report ${i}` : `Roadmap ${i}`,
      i % 3 === 0 ? null : `desc ${i}`,
      formats[i % 4],
      ["private", "team", "public"][i % 3],
      i % 2,
      i % 2 ? "viewers" : "editors",
      i % 3 === 0 ? 1 : 0,
      i % 3 === 0 ? 2 : null,
      100 + i,
      200 + i,
      i % 11 === 0 ? 300 + i : null,
    );
    for (const v of [1, 2])
      await run(
        `insert into versions (artifact_id, version, entry, manifest, language, message, created_by, created_at,
           text_indexed, format, agent_via, index_failed, thumb_failed)
         values (?, ?, 'index.html', '[{"path":"index.html","key":"k","size":3,"contentType":"text/html"}]', ?, 'm', ?, ?, ?, ?, ?, 0, ?)`,
        A(i),
        v,
        i % 4 === 2 ? "py" : null,
        owner,
        100 + v,
        v === 2 ? 1 : 0,
        i % 9 === 0 ? null : formats[i % 4],
        i % 2 ? "g:gr1" : null,
        i % 13 === 0 ? 1 : 0,
      );
    for (const e of i % 2 ? ["Viewer@Example.com", "ed@example.com"] : [])
      await run(
        "insert into shares values (?, ?, ?, 'u-owner', ?)",
        A(i),
        e,
        e.startsWith("ed") ? "editor" : "viewer",
        400 + i,
      );
    await run(
      `insert into artifact_search (rowid, artifact_id, title, description, body)
       select rowid, id, title, description, ? from artifacts where id = ?`,
      i % 4 === 0 ? "quarterly revenue" : "roadmap notes",
      A(i),
    );
    await run(
      "insert into uploads (id, artifact_id, user_id, r2_key, size, content_type, path, created_at, consumed, received_at) values (?, ?, ?, 'r2', 10, 'image/png', 'a.png', 1, ?, 2)",
      `up${i}`,
      A(i),
      owner,
      i % 2,
    );
  }
  // Edge rows: every nullable column NULL, unicode (astral, RTL, combining,
  // ZWJ, quotes, LIKE wildcards), max-size title/description, a ~1 MB
  // manifest, int64 extremes and a REAL in an integer column.
  const big = JSON.stringify(
    Array.from({ length: 9000 }, (_, k) => ({
      path: `d/été-${k}-\u{1F600}.txt`,
      key: "k".repeat(64),
      size: k,
      contentType: "text/plain",
    })),
  );
  expect(big.length).toBeGreaterThan(900_000);
  const edgeCols = `id, owner_id, space_id, title, description, format, visibility, current_version,
    capabilities, allow_anonymous_writes, data_writers, has_thumbnail, thumbnail_version, created_at, updated_at,
    deleted_at, purge_attempts, purge_after, last_agent_name, last_agent_version`;
  await run(
    `insert into artifacts (${edgeCols})
     values ('edge-null', 'u-ann', 'u-ann', ?, null, 'markdown', 'private', 0, '{}', 0, 'viewers', 0, null,
       -9223372036854775808, 9223372036854775807, null, 0, null, null, null)`,
    "T".repeat(200),
  );
  await run(
    `insert into artifacts (${edgeCols})
     values ('edge-uni', 'u-bob', 'sp-team', ?, ?, 'code', 'public', 7, ?, 1, 'editors', 1, 3, 1.5, 2, 3, 2, 4, ?, ?)`,
    `\u{1F680} שלום é 'q' "d" \\ %_`,
    "\u{1F469}‍\u{1F4BB}".repeat(400),
    '{"db":true,"viewer":true,"storage":true,"n":"ü"}',
    "\u{1F916} agent",
    "v²",
  );
  await run(
    `insert into versions (artifact_id, version, entry, manifest, language, message, agent_name, agent_version,
       created_by, created_at, text_indexed, format, agent_via, index_failed, thumb_failed)
     values ('edge-null', 1, 'README.md', '[]', null, null, null, null, 'u-ann', 0, 0, null, null, 0, 0),
            ('edge-uni', 9223372036854775807, ?, ?, 'rust', ?, ?, ?, 'u-bob', 1, 1, 'code', 'g:gr1', 1, 1)`,
    "src/\u{1F600}/main.rs",
    big,
    "m".repeat(10_000),
    "é",
    "",
  );
  await run(
    "insert into shares values ('edge-uni', ?, 'editor', 'u-owner', -1), ('edge-null', ?, 'viewer', 'u-owner', 0)",
    "JÜRGEN@Über.example",
    `${"a".repeat(64)}@${"b".repeat(180)}.example`,
  );
  // Shares at users' own addresses: the directory delete and the address
  // move (verify's EXPLAINED) need them.
  for (const [i, u] of [
    [13, "u-bob"],
    [15, "u-guest"],
    [19, "u-ann"],
  ] as const)
    await run(
      "insert into shares values (?, ?, 'viewer', 'u-owner', 1)",
      A(i),
      `${u}@Example.com`,
    );
  // rowid gaps: a purge deletes (cascading its rows and its FTS row by hand),
  // so later rowids are not 1..n and a renumbering copy would show.
  for (const i of [3, 17, 18, 40]) {
    await run(
      "delete from artifact_search where rowid = (select rowid from artifacts where id = ?)",
      A(i),
    );
    await run("delete from artifacts where id = ?", A(i));
  }
  await run(
    "delete from shares where artifact_id = ? and email = ?",
    A(5),
    "ed@example.com",
  );
}

let before: Snap;
let captured: string;
let recaptured: string;

beforeAll(async () => {
  expect(target).toBeGreaterThan(0);
  const dir = mkdtempSync(join(tmpdir(), "oa-mig0017-"));
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: "oa-mig0017",
      compatibility_date: "2026-01-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "oa-mig0017",
          database_id: "00000000-0000-0000-0000-000000000017",
        },
      ],
    }),
  );
  const p = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(dir, "wrangler.json"),
    persist: { path: join(dir, "state") },
  });
  db = p.env.DB;
  dispose = p.dispose;
  // wrangler's own table.
  await run(
    "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  for (const f of files.slice(0, target)) await apply(f);
  await seed();
  before = await snap();
  captured = serialize(await capture(q));
  recaptured = serialize(await capture(q));
  await apply(MIGRATION_FILE);
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

describe("migration 0017_image_format rehearsal", () => {
  it("starts with the oa:non-additive marker", () => {
    expect(readFileSync(join(DIR, MIGRATION_FILE), "utf8").split("\n")[0]).toBe(
      "-- oa:non-additive",
    );
  });

  it("was rehearsed on populated tables", async () => {
    for (const [t, n] of Object.entries(before.counts))
      if (
        !t.startsWith("sqlite_") &&
        t !== "settings" &&
        t !== "artifact_search_config"
      )
        expect.soft(n, t).toBeGreaterThan(0);
    expect(before.fts.length).toBeGreaterThan(10);
    expect(before.fk).toEqual([]);
    // The space trigger filled in every null space_id.
    expect(
      await q("select count(*) n from artifacts where space_id is null"),
    ).toEqual([{ n: 0 }]);
  });

  it("keeps every table's row count, every row's rowid and the FTS query", async () => {
    const after = await snap();
    const counts = {
      ...before.counts,
      d1_migrations: before.counts.d1_migrations + 1,
    };
    expect(after.counts).toEqual(counts);
    expect(after.rowids).toEqual(before.rowids);
    for (const t of ["artifacts", "versions", "shares"])
      expect(after.content[t], t).toEqual(before.content[t]);
    const edge = (before.content.artifacts ?? []).filter((r) =>
      String(Object.values(r as object)[1]).startsWith("'edge-"),
    );
    expect(edge.length).toBe(2);
    expect(after.fts).toEqual(before.fts);
    expect(after.fk).toEqual([]);
    expect(after.quick).toEqual([{ quick_check: "ok" }]);
    console.log(
      "0017 rehearsal row counts (before -> after):",
      JSON.stringify(
        Object.fromEntries(
          Object.keys(before.counts).map((t) => [
            t,
            `${before.counts[t]} -> ${after.counts[t]}`,
          ]),
        ),
      ),
    );
  });

  it("keeps sqlite_master: every trigger, index and FTS object, only the CHECK widened", async () => {
    const after = await snap();
    const widen = (m: Snap["master"][number]) =>
      m.type === "table" && (m.name === "artifacts" || m.name === "versions")
        ? { ...m, sql: m.sql.replace(NARROW, WIDE) }
        : m;
    expect(after.master).toEqual(before.master.map(widen));
    const names = (t: string) =>
      after.master.filter((m) => m.type === t).map((m) => m.name);
    expect(names("trigger")).toEqual(
      expect.arrayContaining([
        "artifacts_space_default",
        "artifacts_space_not_null",
        "users_personal_space",
        "space_members_personal_insert",
        "group_mappings_personal_insert",
      ]),
    );
    expect(names("index")).toEqual(
      expect.arrayContaining([
        "artifacts_deleted_idx",
        "artifacts_owner_deleted_idx",
        "artifacts_owner_updated_live_idx",
        "artifacts_space_live_idx",
        "artifacts_visibility_updated_live_idx",
        "shares_email_idx",
      ]),
    );
    expect(names("table")).toEqual(
      expect.arrayContaining(["artifact_search", "artifact_search_data"]),
    );
    expect(names("table").filter((n) => n.startsWith("_oa0017"))).toEqual([]);
  });

  it("verify-migration's capture/verify pass, and capture is deterministic", async () => {
    expect(recaptured).toBe(captured);
    expect(captured).not.toMatch(/@/);
    const r = await verify(q, parseCapture(captured));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.notes).toContain("quick_check: ok");
  });

  it("verify accepts a later migration that adds objects", async () => {
    await db.batch([
      db.prepare("create table later_t (x text)"),
      db.prepare("create index later_t_x on later_t (x)"),
      db.prepare("create index artifacts_later_idx on artifacts (title)"),
      db.prepare("insert into later_t values ('a')"),
      db
        .prepare("insert into d1_migrations (name) values (?)")
        .bind("0018_later.sql"),
    ]);
    const r = await verify(q, parseCapture(captured));
    expect(r.failures).toEqual([]);
    expect(r.notes).toEqual(
      expect.arrayContaining([
        "d1_migrations: 1 migrations after 0017",
        "index later_t_x: not there before",
        "index artifacts_later_idx: not there before",
      ]),
    );
  });

  it("a delete by the app during the window is explained by its audit row or state; others fail", async () => {
    const audit = (
      id: string,
      action: string,
      type: string,
      target: string,
      at: number,
    ) =>
      run(
        "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id) values (?, ?, 'user', 'u-owner', ?, ?, ?)",
        id,
        at,
        action,
        type,
        target,
      );
    const LATER = 10_000_000_000;
    // Unshare (artifact.unshare), transfer (artifact.transfer).
    await run(
      "delete from shares where artifact_id = ? and email = 'Viewer@Example.com'",
      A(7),
    );
    await audit("ev-unshare", "artifact.unshare", "artifact", A(7), LATER);
    await run(
      "delete from shares where artifact_id = ? and email = 'ed@example.com'",
      A(9),
    );
    await audit("ev-transfer", "artifact.transfer", "artifact", A(9), LATER);
    // The directory's deleteUser: user.status on the user, their shares gone.
    await run(
      "delete from shares where artifact_id = ? and email = 'u-bob@Example.com'",
      A(13),
    );
    await audit("ev-status", "user.status", "user", "u-bob", LATER);
    // An address move (not audited): the share moves to the new address.
    await run(
      "update users set email = 'ann.new@example.com' where id = 'u-ann'",
    );
    await run(
      "insert into shares values (?, 'ann.new@example.com', 'viewer', 'u-owner', 1)",
      A(19),
    );
    await run(
      "delete from shares where artifact_id = ? and email = 'u-ann@Example.com'",
      A(19),
    );
    // The trash purge (not audited): an artifact trashed at capture.
    expect(JSON.parse(captured).trashed).toContain(A(11));
    await run(
      "delete from artifact_search where rowid = (select rowid from artifacts where id = ?)",
      A(11),
    );
    await run("delete from artifacts where id = ?", A(11));
    const ok = await verify(q, parseCapture(captured));
    expect(ok.failures).toEqual([]);
    expect(ok.notes).toEqual(
      expect.arrayContaining([
        "artifacts: 1 captured rows deleted by the app since capture",
        "versions: 2 captured rows deleted by the app since capture",
        // 4 above, plus A(11)'s two (the purge cascade).
        "shares: 6 captured rows deleted by the app since capture",
      ]),
    );
    // Unexplained: an audit row from before the capture doesn't count, nor
    // does an audit for another artifact; a live artifact can't be purged.
    await audit("ev-old", "artifact.unshare", "artifact", A(15), 1);
    await audit("ev-other", "artifact.unshare", "artifact", A(21), LATER);
    await run(
      "delete from shares where artifact_id = ? and email = 'u-guest@Example.com'",
      A(15),
    );
    const bad = await verify(q, parseCapture(captured));
    expect(bad.ok).toBe(false);
    expect(bad.failures).toEqual([
      `shares: 1 of ${before.counts.shares} captured rows missing, unexplained`,
    ]);
    await run(
      "insert into shares values (?, 'u-guest@Example.com', 'viewer', 'u-owner', 1)",
      A(15),
    );
    expect((await verify(q, parseCapture(captured))).failures).toEqual([]);
  });

  it("refuses a --db that looks like a flag, and never echoes bad JSON", () => {
    expect(parseArgs(["verify", "--db", "--remote", "--in", "f"])).toBeNull();
    expect(parseArgs(["capture", "--db", "-x", "--out", "f"])).toBeNull();
    const secret = '[{"results": [secret@example.com';
    expect(() => parseWranglerJson(secret)).toThrow(
      "wrangler printed invalid JSON",
    );
    try {
      parseWranglerJson(secret);
    } catch (e) {
      expect(String(e)).not.toMatch(/secret/);
    }
    expect(() => parseCapture("{ secret@example.com")).toThrow(
      "not a capture file (invalid JSON)",
    );
    try {
      parseCapture("{ secret@example.com");
    } catch (e) {
      expect(String(e)).not.toMatch(/secret/);
    }
  });

  it("the CLI exits 0 on a match and 1 on a mismatch, with no row data in its reasons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-verify-"));
    const file = join(dir, "before.json");
    writeFileSync(file, captured);
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    };
    expect(
      await main(["verify", "--db", "oa-mig0017", "--in", file], () => q, io),
    ).toBe(0);
    expect(err).toEqual([]);
    // capture refuses an already migrated DB.
    expect(
      await main(
        ["capture", "--db", "x", "--out", join(dir, "again.json")],
        () => q,
        io,
      ),
    ).toBe(1);
    expect(err.at(-1)).toMatch(/already applied/);
    expect(await main(["capture", "--db", "x"], () => q, io)).toBe(2);
    expect(parseArgs(["verify", "--db", "d", "--out", "f"])).toBeNull();
    expect(parseArgs(["capture", "--db", "d", "--out", "f"])).toEqual({
      cmd: "capture",
      db: "d",
      file: "f",
    });
    // A lost share and a lost version: verify fails and names counts only.
    err.length = 0;
    await run("delete from shares where artifact_id = ?", A(1));
    await run(
      "delete from versions where artifact_id = ? and version = 1",
      A(2),
    );
    expect(await main(["verify", "--db", "d", "--in", file], () => q, io)).toBe(
      1,
    );
    expect(err).toEqual(
      expect.arrayContaining([
        `MISMATCH shares: 2 of ${before.counts.shares} captured rows missing, unexplained`,
        `MISMATCH versions: 1 of ${before.counts.versions} captured rows missing, unexplained`,
      ]),
    );
    for (const e of err) {
      expect(e).not.toMatch(/@|art00/i);
    }
  });

  it("runs under node --experimental-strip-types as Platform invokes it", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(import.meta.dirname, "../../scripts/verify-migration.ts"),
        "verify",
        "--db",
        "x",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });

  it("keeps the triggers, the cascades and the widened CHECK working", async () => {
    await run(
      "insert into artifacts (id, owner_id, title, format, created_at, updated_at) values ('img1', 'u-ann', 'A photo', 'image', 1, 1)",
    );
    expect(
      (await q("select space_id from artifacts where id = 'img1'"))[0],
    ).toEqual({ space_id: "u-ann" });
    await expect(
      run("update artifacts set space_id = null where id = 'img1'"),
    ).rejects.toThrow(/space_id cannot be null/);
    await run(
      "insert into versions (artifact_id, version, entry, created_by, created_at, format) values ('img1', 1, 'a.png', 'u-ann', 1, 'image')",
    );
    await expect(
      run(
        "insert into artifacts (id, owner_id, title, format, created_at, updated_at) values ('bad1', 'u-ann', 't', 'zip', 1, 1)",
      ),
    ).rejects.toThrow(/CHECK/);
    await run(
      "insert into shares values ('img1', 'z@example.com', 'viewer', 'u-ann', 1)",
    );
    await run("delete from artifacts where id = 'img1'");
    expect(
      (
        await q(
          "select (select count(*) from versions where artifact_id = 'img1') + (select count(*) from shares where artifact_id = 'img1') n",
        )
      )[0],
    ).toEqual({ n: 0 });
    await expect(
      run(
        "insert into versions (artifact_id, version, entry, created_by, created_at) values ('nope', 1, 'x', 'u-ann', 1)",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
