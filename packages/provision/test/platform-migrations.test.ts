// H-DV: 0005 rebuilds installs (owner_email nullable, the directory revoke
// columns, the partial index) with foreign keys ON, as D1 enforces them, on
// a platform D1 that already holds rows from 0001-0004.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { splitSql } from "./fake-cf.js";

const DIR = new URL("../../../apps/platform-db/migrations/", import.meta.url);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = (f: string) => readFileSync(new URL(f, DIR), "utf8");
const run = (db: DatabaseSync, text: string) => {
  for (const s of splitSql(text)) db.exec(s);
};

function before0005() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files.filter((x) => x < "0005")) run(db, sql(f));
  const ins = db.prepare(
    `INSERT INTO installs (id, slug, app_host, content_host, owner_email, rl_ns, inputs_hash, state, created_at, updated_at, version, vars, lease, lease_until, session_cut_armed)
     VALUES (?, ?, ?, ?, ?, ?, 'h', ?, 1, 2, '0.54.0', '{}', NULL, NULL, 0)`,
  );
  ins.run(
    "iaaaaaaaaaaa",
    "a",
    "a.app.test",
    "a.page.test",
    "o@a.test",
    8,
    "active",
  );
  ins.run(
    "ibbbbbbbbbbb",
    "b",
    "b.app.test",
    "b.page.test",
    "o@b.test",
    16,
    "deleted",
  );
  db.prepare("INSERT INTO hosts (host, install_id) VALUES (?, ?)").run(
    "a.app.test",
    "iaaaaaaaaaaa",
  );
  db.prepare(
    "INSERT INTO install_versions (install_id, version, vars, metadata, updated_at) VALUES (?, '0.54.0', '{}', '{}', 3)",
  ).run("iaaaaaaaaaaa");
  db.prepare(
    "INSERT INTO hosted_audit (at, install_id, action, detail, actor) VALUES (1, 'iaaaaaaaaaaa', 'x', '{}', 'ops@example.com')",
  ).run();
  return db;
}

describe("0005_directory_revoke", () => {
  it("is the fifth migration, after 0004's audit actor", () => {
    expect(files).toEqual([
      "0001_installs.sql",
      "0002_release_floor.sql",
      "0003_lifecycle.sql",
      "0004_audit_actor.sql",
      "0005_directory_revoke.sql",
    ]);
  });

  it("keeps every row and foreign key, with foreign keys on, and relaxes owner_email", () => {
    const db = before0005();
    run(db, sql("0005_directory_revoke.sql"));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT id, slug, owner_email, state, version FROM installs ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "iaaaaaaaaaaa",
        slug: "a",
        owner_email: "o@a.test",
        state: "active",
        version: "0.54.0",
      },
      {
        id: "ibbbbbbbbbbb",
        slug: "b",
        owner_email: "o@b.test",
        state: "deleted",
        version: "0.54.0",
      },
    ]);
    expect(db.prepare("SELECT * FROM hosts").all()).toEqual([
      { host: "a.app.test", install_id: "iaaaaaaaaaaa" },
    ]);
    expect(db.prepare("SELECT install_id FROM install_versions").all()).toEqual(
      [{ install_id: "iaaaaaaaaaaa" }],
    );
    expect(db.prepare("SELECT actor FROM hosted_audit").all()).toEqual([
      { actor: "ops@example.com" },
    ]);
    // The children still reference installs, and it is enforced.
    expect(() =>
      db
        .prepare(
          "INSERT INTO hosts (host, install_id) VALUES ('x', 'inope0000000')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    for (const t of ["hosts", "install_versions"])
      expect(
        (
          db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as {
            sql: string;
          }
        ).sql,
      ).toMatch(/REFERENCES "?installs"? ?\(id\)/);
    // owner_email may now be NULL (the purge); the new columns have defaults.
    db.prepare(
      "UPDATE installs SET owner_email = NULL WHERE id = 'ibbbbbbbbbbb'",
    ).run();
    expect(
      db
        .prepare(
          "SELECT owner_email, directory_revoke, directory_revoked_at, directory_revoke_attempts FROM installs WHERE id = 'ibbbbbbbbbbb'",
        )
        .get(),
    ).toEqual({
      owner_email: null,
      directory_revoke: null,
      directory_revoked_at: null,
      directory_revoke_attempts: 0,
    });
    expect(() =>
      db
        .prepare(
          "UPDATE installs SET directory_revoke = 'maybe' WHERE id = 'iaaaaaaaaaaa'",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("recreates the row_version trigger and adds the partial index", () => {
    const db = before0005();
    run(db, sql("0005_directory_revoke.sql"));
    const v = () =>
      (
        db
          .prepare("SELECT row_version FROM installs WHERE id = 'iaaaaaaaaaaa'")
          .get() as { row_version: number }
      ).row_version;
    const r0 = v();
    db.prepare(
      "UPDATE installs SET vars = '{\"A\":\"1\"}' WHERE id = 'iaaaaaaaaaaa'",
    ).run();
    expect(v()).toBe(r0 + 1);
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'installs_revoke_pending'",
        )
        .get(),
    ).toEqual({
      sql: expect.stringMatching(
        /ON installs \(id\)\s+WHERE state = 'deleting' AND directory_revoke = 'pending'/,
      ),
    });
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, version FROM installs WHERE state='deleting' AND directory_revoke='pending' LIMIT 10",
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toMatch(
      /USING (?:COVERING )?INDEX installs_revoke_pending/,
    );
  });
});
