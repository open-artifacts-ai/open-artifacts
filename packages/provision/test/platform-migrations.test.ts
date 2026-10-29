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
      "0006_platform_state.sql",
      "0007_signups.sql",
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

describe("0006_platform_state", () => {
  it("only creates platform_state, re-runnably, and touches no other table", () => {
    const sql = readFileSync(
      new URL("0006_platform_state.sql", DIR),
      "utf8",
    ).replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/\b(?:DROP|RENAME|ALTER|INSERT|UPDATE|DELETE)\b/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS platform_state \(/);
    const db = all();
    // Re-running it is a no-op.
    for (const s of splitSql(sql)) db.exec(s);
    const cols = db.prepare("PRAGMA table_info(platform_state)").all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => [c.name, c.notnull, c.pk])).toEqual([
      ["key", 0, 1],
      ["value", 1, 0],
      ["updated_at", 1, 0],
    ]);
  });
});

describe("0007_signups", () => {
  it("0007 is additive and applies after 0006", () => {
    const sql = readFileSync(new URL("0007_signups.sql", DIR), "utf8").replace(
      /--[^\n]*/g,
      "",
    );
    expect(sql).not.toMatch(/\b(?:DROP|ALTER|UPDATE|DELETE)\b/i);
    const db = all();
    // Re-running it is a no-op.
    for (const s of splitSql(sql)) db.exec(s);
    const cols = (t: string) =>
      (
        db.prepare(`PRAGMA table_info(${t})`).all() as {
          name: string;
          notnull: number;
          pk: number;
        }[]
      ).map((c) => [c.name, c.notnull, c.pk]);
    expect(cols("signups")).toEqual([
      ["signup_id", 1, 1],
      ["owner_sub", 1, 0],
      ["slug", 1, 0],
      ["install_id", 0, 0],
      ["status", 1, 0],
      ["welcome_claimed_at", 0, 0],
      ["welcome_sent_at", 0, 0],
      ["error", 0, 0],
      ["created_at", 1, 0],
      ["updated_at", 1, 0],
    ]);
    expect(cols("signup_secret")).toEqual([
      ["signup_id", 1, 1],
      ["owner_email", 1, 0],
    ]);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'signups' AND sql IS NOT NULL",
      )
      .all();
    expect(JSON.stringify(idx)).toMatch(/signups_created_at/);
    // A TEXT primary key accepts NULL in SQLite unless NOT NULL; a NULL
    // status would slip past the CHECK. Both are refused.
    const raw = (id: string | null, st: string | null) =>
      db
        .prepare(
          "INSERT INTO signups (signup_id, owner_sub, slug, status, created_at, updated_at) VALUES (?, 's', 'n', ?, 1, 1)",
        )
        .run(id, st);
    expect(() => raw(null, "queued")).toThrow(/NOT NULL/);
    expect(() => raw("01NULLSTATUS", null)).toThrow(/NOT NULL/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO signup_secret (signup_id, owner_email) VALUES (NULL, 'a@b.c')",
        )
        .run(),
    ).toThrow(/NOT NULL/);
    const ins = (id: string, inst: string | null, st: string) =>
      db
        .prepare(
          "INSERT INTO signups (signup_id, owner_sub, slug, install_id, status, created_at, updated_at) VALUES (?, 's', 'x', ?, ?, 1, 1)",
        )
        .run(id, inst, st);
    expect(() => ins("a", "i1", "bogus")).toThrow();
    ins("a", "i1", "queued");
    expect(() => ins("b", "i1", "ready")).toThrow();
  });
});
