import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { d1, loadMigrations, run } from "./platform-db.mjs";

// platform-db.mjs (design v7 8.4) against a local SQLite standing in for D1:
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
  opts: { verifyOnly?: boolean } = {},
) => {
  const log: string[] = [];
  try {
    await run({
      db: f.db,
      migrations,
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

describe("platform-db.mjs", () => {
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
    expect(execs).toHaveLength(4); // the tracker, then 0006, 0007, 0008
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
    const answer = (body: unknown) => async (url: string, init: RequestInit) => {
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
    expect(
      (seen[0]?.init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${TOKEN}`);
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

  it("the CLI refuses a bad env or missing inputs before any call", () => {
    const cli = (args: string[], env: Record<string, string>) =>
      spawnSync("node", [join(import.meta.dirname, "platform-db.mjs"), ...args], {
        env: { PATH: process.env.PATH as string, ...env },
        encoding: "utf8",
      });
    const ok = {
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      PLATFORM_DB_ID: "6ca9103e-507e-4541-b3bb-2485e699512b",
    };
    expect(cli(["dev"], ok).status).toBe(2);
    expect(cli(["prod"], { ...ok, PLATFORM_DB_ID: "x" }).status).toBe(2);
    expect(cli(["prod"], { ...ok, CLOUDFLARE_API_TOKEN: "" }).status).toBe(2);
  });

  it("the CLI never prints the token", () => {
    const src = readFileSync(join(import.meta.dirname, "platform-db.mjs"), "utf8");
    expect(src).not.toMatch(/console\.\w+\([^)]*TOKEN/);
  });
});
