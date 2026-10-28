import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { main, parseArgs } from "../../scripts/verify-migration.ts";
import {
  capture,
  MIGRATION_FILE,
  NARROW,
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
  return {
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
    const r = await verify(q, JSON.parse(captured));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.notes).toContain("quick_check: ok");
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
        `MISMATCH shares: 2 of ${before.counts.shares} captured rows missing`,
        `MISMATCH versions: 1 of ${before.counts.versions} captured rows missing`,
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
