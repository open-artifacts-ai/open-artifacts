// H-DV: 0005 adds the directory revoke columns and the partial index only;
// owner_email stays NOT NULL (the purge writes '', never NULL).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { splitSql } from "./fake-cf.js";

const DIR = new URL("../../../apps/platform-db/migrations/", import.meta.url);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const all = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files)
    for (const s of splitSql(readFileSync(new URL(f, DIR), "utf8"))) db.exec(s);
  return db;
};

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

  it("only adds columns and the index: no table is rebuilt, owner_email stays NOT NULL", () => {
    const sql = readFileSync(
      new URL("0005_directory_revoke.sql", DIR),
      "utf8",
    ).replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/\b(?:DROP|RENAME|CREATE TABLE)\b/i);
    const db = all();
    const cols = db.prepare("PRAGMA table_info(installs)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const by = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(by.owner_email?.notnull).toBe(1);
    expect(by.directory_revoke?.notnull).toBe(0);
    expect(by.directory_revoked_at?.notnull).toBe(0);
    // H-DV fix 2 M1b: each delete attempt's start, on D1's clock.
    expect(by.directory_revoke_requested_at?.notnull).toBe(0);
    expect(by.directory_revoke_attempts).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });
  });

  it("the partial index serves the scheduler's query", () => {
    const db = all();
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
