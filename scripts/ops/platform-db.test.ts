import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { d1, loadMigrations, pinDrift, run } from "./platform-db.ts";

// platform-db.ts (design v7 8.4) against a local SQLite standing in for D1:
// bootstrap by schema, the shape check before any record, apply in order,
// read back; verify only reads.
const root = join(import.meta.dirname, "../..");
const DIR = join(root, "apps/platform-db/migrations");
const LOCK = join(root, "apps/platform-db/migration-lock.json");
type M = { name: string; sql: string; sha256: string };
const migrations: M[] = loadMigrations(DIR, LOCK);
const names = migrations.map((m) => m.name);

// A fake D1: every call logged, so the tests can see what ran and in what order.
const fakeDb = (sqlite = new DatabaseSync(":memory:")) => {
  const calls: string[] = [];
  return {
    sqlite,
    calls,
    db: {
      all: async (sql: string, params?: SQLInputValue[]) => {
        calls.push(`all ${sql}`);
        return sqlite.prepare(sql).all(...(params ?? []));
      },
      exec: async (sql: string) => {
        calls.push(`exec ${sql.slice(0, 60)}`);
        sqlite.exec(sql);
      },
    },
  };
};
const applied = (n: number) => {
  const f = fakeDb();
  for (const m of migrations.slice(0, n)) f.sqlite.exec(m.sql);
  return f;
};
const go = async (
  f: ReturnType<typeof fakeDb>,
  opts: { verifyOnly?: boolean; upTo?: number } = {},
) => {
  const log: string[] = [];
  try {
    await run({
      db: f.db,
      migrations: migrations.slice(0, opts.upTo ?? migrations.length),
      verifyOnly: Boolean(opts.verifyOnly),
      now: () => 1_700_000_000_000,
      log: (s: string) => log.push(s),
    });
    return { ok: true, log, err: "" };
  } catch (e) {
    return { ok: false, log, err: (e as Error).message };
  }
};
const tracker = (f: ReturnType<typeof fakeDb>) =>
  f.sqlite
    .prepare(
      "SELECT name, sha256, applied_at FROM platform_migrations ORDER BY name",
    )
    .all();
const writes = (f: ReturnType<typeof fakeDb>) =>
  f.calls.filter((c) => c.startsWith("exec") || c.includes("INSERT"));

// #859's 0007 signups shape (as packages/provision's schema test pins it).
const SIGNUPS_859 = `CREATE TABLE signups (
  signup_id TEXT NOT NULL PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  slug TEXT NOT NULL,
  install_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','queued','waiting_cap','creating','ready','failed')),
  admitted_at INTEGER,
  welcome_claimed_at INTEGER,
  welcome_sent_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE signup_secret (signup_id TEXT NOT NULL PRIMARY KEY, owner_email TEXT NOT NULL);
CREATE INDEX signups_admitted_at ON signups (admitted_at);`;

describe("platform-db.ts", () => {
  it("a fresh database: every file applied in order, each recorded with its pin, then read back", async () => {
    const f = fakeDb();
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.ok).toBe(true);
    expect(r.log).toEqual([
      ...names.map((n) => `${n}: applied`),
      `${names.length} migrations tracked, shapes match`,
    ]);
    expect(tracker(f)).toEqual(
      migrations.map((m) => ({
        name: m.name,
        sha256: m.sha256,
        applied_at: 1_700_000_000_000,
      })),
    );
  });

  it("today's envs (0001-0005, no tracker): records 0001-0005 by schema, applies 0006-0008", async () => {
    const f = applied(5);
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.log).toEqual([
      ...names.slice(0, 5).map((n) => `${n}: present, recorded`),
      ...names.slice(5).map((n) => `${n}: applied`),
      `${names.length} migrations tracked, shapes match`,
    ]);
    // 0001-0005 never run again (0004 and 0005 are not re-runnable).
    const execs = f.calls.filter((c) => c.startsWith("exec"));
    // The tracker, then 0006 onward.
    expect(execs).toHaveLength(1 + names.slice(5).length);
    expect(execs[0]).toContain("CREATE TABLE IF NOT EXISTS platform_migrat");
  });

  it("refuses #859's hand-applied signups shape before recording anything", async () => {
    const f = applied(6);
    f.sqlite.exec(SIGNUPS_859);
    const r = await go(f);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("the live schema differs from the migrations");
    expect(r.err).toContain("signups has columns");
    expect(r.err).toContain("add a new numbered migration");
    expect(writes(f)).toEqual([]);
    expect(
      f.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'platform_migrations'",
        )
        .all(),
    ).toEqual([]);
  });

  it("refuses an index of the same name with other columns", async () => {
    const f = applied(6);
    f.sqlite.exec(
      migrations[6]?.sql.replace(
        "ON signups (source, admitted_at)",
        "ON signups (admitted_at)",
      ) as string,
    );
    const r = await go(f);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("index signups_admitted_at on signups is");
    expect(writes(f)).toEqual([]);
  });

  it("refuses a partial index with another WHERE, and a view with another body", async () => {
    const idx = applied(6);
    idx.sqlite.exec(
      migrations[6]?.sql.replace(
        "WHERE status <> 'failed'",
        "WHERE status = 'ready'",
      ) as string,
    );
    const r = await go(idx);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("signups_live_slug is");
    expect(writes(idx)).toEqual([]);
    // The same columns, another body: only the sql tells them apart.
    const view = applied(7);
    const body = "ORDER BY created_at DESC, id DESC LIMIT 1)";
    expect(migrations[7]?.sql).toContain(body);
    view.sqlite.exec(
      migrations[7]?.sql.replace(
        body,
        "ORDER BY created_at ASC, id DESC LIMIT 1)",
      ) as string,
    );
    const v = await go(view);
    expect(v.ok).toBe(false);
    expect(v.err).toContain("install_status is");
    expect(writes(view)).toEqual([]);
  });

  it("a run stopped between applying 0001-0005 and recording them converges: the tracker lists 0001-0002, the schema has 0001-0005", async () => {
    const f = fakeDb();
    // A fresh env: 0008's tracker, 0001-0005 applied, only 0001-0002 recorded.
    const ddl =
      /CREATE TABLE IF NOT EXISTS platform_migrations \([^;]*\);/.exec(
        migrations[7]?.sql as string,
      )?.[0] as string;
    f.sqlite.exec(ddl);
    for (const m of migrations.slice(0, 5)) f.sqlite.exec(m.sql);
    for (const m of migrations.slice(0, 2))
      f.sqlite
        .prepare(
          "INSERT INTO platform_migrations (name, sha256, applied_at) VALUES (?, ?, 1)",
        )
        .run(m.name, m.sha256);
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.log).toEqual([
      ...names.slice(2, 5).map((n) => `${n}: present, recorded`),
      ...names.slice(5).map((n) => `${n}: applied`),
      `${names.length} migrations tracked, shapes match`,
    ]);
    // 0003-0005 (ADD COLUMN) never run again.
    expect(f.calls.filter((c) => c.startsWith("exec"))).toHaveLength(
      names.slice(5).length,
    );
    expect(tracker(f)).toHaveLength(names.length);
    // The tracker lists 0001-0003 and 0004 is absent: 0004 onward applied.
    const g = fakeDb();
    g.sqlite.exec(ddl);
    for (const m of migrations.slice(0, 3)) {
      g.sqlite.exec(m.sql);
      g.sqlite
        .prepare(
          "INSERT INTO platform_migrations (name, sha256, applied_at) VALUES (?, ?, 1)",
        )
        .run(m.name, m.sha256);
    }
    const r2 = await go(g);
    expect(r2.err).toBe("");
    expect(r2.log.slice(0, 2)).toEqual([
      `${names[3]}: applied`,
      `${names[4]}: applied`,
    ]);
  });

  it("a hand-applied 0006 and 0007 with the right shape are recorded, not refused", async () => {
    const f = applied(7);
    const r = await go(f);
    expect(r.err).toBe("");
    expect(tracker(f)).toHaveLength(names.length);
  });

  it("refuses a 0001-0005 file that is only partly there, or a gap", async () => {
    const partial = applied(4);
    partial.sqlite.exec(
      "ALTER TABLE installs ADD COLUMN directory_revoke TEXT",
    );
    const r = await go(partial);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("0005_directory_revoke.sql is only partly applied");
    expect(writes(partial)).toEqual([]);

    const gap = fakeDb();
    for (const m of [0, 2].map((i) => migrations[i] as M))
      gap.sqlite.exec(m.sql);
    const g = await go(gap);
    expect(g.ok).toBe(false);
    expect(g.err).toMatch(/0003_lifecycle\.sql is applied but 0002_/);
    expect(writes(gap)).toEqual([]);
  });

  it("a tracker row that isn't its pin, isn't pinned or isn't a prefix stops the run", async () => {
    for (const [name, sha] of [
      [names[0], "0".repeat(64)],
      ["0099_rogue.sql", "0".repeat(64)],
      [names[1], migrations[1]?.sha256],
    ]) {
      const f = applied(8);
      f.sqlite
        .prepare("INSERT INTO platform_migrations VALUES (?, ?, 1)")
        .run(name as string, sha as string);
      const r = await go(f);
      expect(r.ok, name).toBe(false);
      expect(r.err, name).toMatch(/tracker/);
      expect(writes(f).filter((c) => c.includes("INSERT"))).toEqual([]);
    }
  });

  it("a rerun on a migrated database changes nothing", async () => {
    const f = fakeDb();
    await go(f);
    f.calls.length = 0;
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.log).toEqual([`${names.length} migrations tracked, shapes match`]);
    expect(writes(f)).toEqual([]);
  });

  // v0.89.0: 0009 (ALTER TABLE jobs) was refused before it ran, as the check
  // compared the live jobs table with its shape after 0009.
  const tracked = migrations.findIndex((m) =>
    m.sql.includes("platform_migrations"),
  );
  it.each(names.slice(tracked, -1).map((n, i) => [n, tracked + i + 1]))(
    "a database tracked up to %s applies every later file, ALTER TABLE ones too",
    async (_n, k) => {
      const f = fakeDb();
      expect((await go(f, { upTo: k })).err).toBe("");
      const r = await go(f);
      expect(r.err).toBe("");
      expect(r.log).toEqual([
        ...names.slice(k).map((n) => `${n}: applied`),
        `${names.length} migrations tracked, shapes match`,
      ]);
    },
  );

  it("refuses a pending ALTER TABLE file already applied by hand, before any write", async () => {
    const f = fakeDb();
    expect((await go(f, { upTo: 8 })).err).toBe("");
    f.sqlite.exec(migrations[8]?.sql ?? "");
    f.calls.length = 0;
    const r = await go(f);
    expect(r.err).toContain("the live schema differs from the migrations");
    expect(r.err).toContain("jobs has columns");
    expect(writes(f)).toEqual([]);
  });

  it("refuses an extra live column on a tracked table while a file is pending", async () => {
    const f = fakeDb();
    expect((await go(f, { upTo: 8 })).err).toBe("");
    f.sqlite.exec("ALTER TABLE jobs ADD COLUMN extra TEXT");
    f.calls.length = 0;
    const r = await go(f);
    expect(r.err).toContain("jobs has columns");
    expect(writes(f)).toEqual([]);
  });

  it("verify only: reads only; passes on a migrated database, fails while a file is pending", async () => {
    const done = fakeDb();
    await go(done);
    done.calls.length = 0;
    const ok = await go(done, { verifyOnly: true });
    expect(ok.err).toBe("");
    expect(writes(done)).toEqual([]);

    const old = applied(5);
    const r = await go(old, { verifyOnly: true });
    expect(r.ok).toBe(false);
    expect(r.err).toContain("not migrated");
    expect(writes(old)).toEqual([]);
  });

  it("fails the read-back when an object is gone after the run", async () => {
    const f = fakeDb();
    const real = f.db.exec;
    f.db.exec = async (sql: string) => {
      await real(sql);
      if (sql.includes("CREATE VIEW IF NOT EXISTS install_status"))
        f.sqlite.exec("DROP VIEW install_status");
    };
    const r = await go(f);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("read back: install_status is missing");
  });

  it("refuses a lock that doesn't hold", () => {
    expect(() => loadMigrations(DIR, "/nonexistent/lock.json")).toThrow(
      /missing or not JSON/,
    );
  });

  it("d1: the token only in the header; a failed statement or call throws", async () => {
    const TOKEN = "tok-SHOULD-NEVER-APPEAR";
    const seen: { url: string; init: RequestInit }[] = [];
    const answer =
      (body: unknown) => async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(body));
      };
    const ok = d1({
      token: TOKEN,
      accountId: "a".repeat(32),
      databaseId: "db",
      fetch: answer({
        success: true,
        result: [{ success: true, results: [{ x: 1 }] }],
      }),
    });
    expect(await ok.all("SELECT 1 AS x", [1])).toEqual([{ x: 1 }]);
    expect(seen[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/d1/database/db/query`,
    );
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
      sql: "SELECT 1 AS x",
      params: [1],
    });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const body of [
      { success: false, errors: [{ code: 7500 }] },
      { success: true, result: [{ success: false }] },
    ]) {
      const bad = d1({
        token: TOKEN,
        accountId: "a".repeat(32),
        databaseId: "db",
        fetch: answer(body),
      });
      await expect(bad.exec("x")).rejects.toThrow(/D1 query failed/);
      await expect(bad.exec("x")).rejects.not.toThrow(TOKEN);
    }
  });

  describe("main's lock against the tag's (pinDrift)", () => {
    /** A tag's tree: the repo's migrations and lock, then `edit` applied. */
    const tagTree = (
      edit: (dir: string, lock: Record<string, string>) => void,
    ) => {
      const t = mkdtempSync(join(tmpdir(), "oa-tag-db-"));
      cpSync(DIR, join(t, "migrations"), { recursive: true });
      const lock = JSON.parse(readFileSync(LOCK, "utf8"));
      edit(join(t, "migrations"), lock.pins);
      writeFileSync(join(t, "lock.json"), JSON.stringify(lock));
      return { dir: join(t, "migrations"), lock: join(t, "lock.json") };
    };
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    it("refuses an edited pinned migration whose pin the tag updated (its own lock holds)", () => {
      const t = tagTree((dir, pins) => {
        const f = join(dir, "0007_signups.sql");
        const sql = `${readFileSync(f, "utf8")}\n-- edited\n`;
        writeFileSync(f, sql);
        pins["0007_signups.sql"] = sha(sql);
      });
      // The tag's own lock vouches for the edit...
      expect(() => loadMigrations(t.dir, t.lock)).not.toThrow();
      // ...main's doesn't.
      expect(pinDrift(LOCK, t.lock)).toEqual([
        "0007_signups.sql's pin differs from main's (an edited migration)",
      ]);
    });
    it("refuses a pin main has that the tag dropped", () => {
      const t = tagTree((_, pins) => {
        delete pins["0008_provisioning.sql"];
      });
      expect(pinDrift(LOCK, t.lock)).toEqual([
        "0008_provisioning.sql is pinned on main, not in the tag",
      ]);
    });
    it("accepts a new migration the tag pins", () => {
      const t = tagTree((dir, pins) => {
        const sql = "CREATE TABLE IF NOT EXISTS x (id TEXT PRIMARY KEY);\n";
        writeFileSync(join(dir, "0009_x.sql"), sql);
        pins["0009_x.sql"] = sha(sql);
      });
      expect(() => loadMigrations(t.dir, t.lock)).not.toThrow();
      expect(pinDrift(LOCK, t.lock)).toEqual([]);
      expect(pinDrift(LOCK, LOCK)).toEqual([]);
    });
    it("refuses a lock it can't read", () => {
      expect(() => pinDrift("/nonexistent/lock.json", LOCK)).toThrow(
        "main's migration lock is missing or not JSON",
      );
      const t = tagTree(() => {});
      writeFileSync(t.lock, "{}");
      expect(() => pinDrift(LOCK, t.lock)).toThrow(
        "the tag's migration lock has no pins",
      );
    });
  });

  it("the CLI refuses a bad env or missing inputs before any call", () => {
    const cli = (args: string[], env: Record<string, string>) =>
      spawnSync(
        "node",
        [
          "--experimental-strip-types",
          "--no-warnings",
          join(import.meta.dirname, "platform-db.ts"),
          ...args,
        ],
        {
          env: { PATH: process.env.PATH as string, ...env },
          encoding: "utf8",
        },
      );
    const ok = {
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      PLATFORM_DB_ID: "6ca9103e-507e-4541-b3bb-2485e699512b",
      MAIN_MIGRATION_LOCK: LOCK,
    };
    expect(cli(["dev"], ok).status).toBe(2);
    expect(cli(["prod"], { ...ok, MAIN_MIGRATION_LOCK: "" }).status).toBe(2);
    // main pins a file the tag re-pinned: refused before any call to D1.
    const main = join(
      mkdtempSync(join(tmpdir(), "oa-main-lock-")),
      "lock.json",
    );
    const lock = JSON.parse(readFileSync(LOCK, "utf8"));
    lock.pins["0007_signups.sql"] = "0".repeat(64);
    writeFileSync(main, JSON.stringify(lock));
    const drift = cli(["prod"], { ...ok, MAIN_MIGRATION_LOCK: main });
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain(
      "0007_signups.sql's pin differs from main's (an edited migration); refusing",
    );
    expect(cli(["prod"], { ...ok, PLATFORM_DB_ID: "x" }).status).toBe(2);
    expect(cli(["prod"], { ...ok, CLOUDFLARE_API_TOKEN: "" }).status).toBe(2);
  });

  it("the CLI never prints the token", () => {
    const src = readFileSync(
      join(import.meta.dirname, "platform-db.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/console\.\w+\([^)]*TOKEN/);
  });
});
