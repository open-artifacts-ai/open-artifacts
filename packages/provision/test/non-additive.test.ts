import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nonAdditiveReason } from "../src/non-additive.ts";

describe("nonAdditiveReason", () => {
  it("additive SQL passes", () => {
    for (const sql of [
      "CREATE TABLE a (id TEXT);",
      "ALTER TABLE a ADD COLUMN b TEXT;",
      "CREATE INDEX i ON a (b);\nDROP INDEX j;",
      "INSERT INTO a VALUES ('x');",
      "UPDATE a SET b = 1 WHERE c = 2;",
      "DELETE FROM a WHERE b = 1;",
    ])
      expect(nonAdditiveReason(sql)).toBeNull();
  });

  it("the marker holds, on the first line only", () => {
    expect(nonAdditiveReason("-- oa:non-additive\nSELECT 1;")).toBe("marker");
    expect(nonAdditiveReason("-- oa:non-additive  \nSELECT 1;")).toBe("marker");
    expect(nonAdditiveReason("SELECT 1;\n-- oa:non-additive\n")).toBeNull();
  });

  it("a forgotten marker still holds", () => {
    expect(nonAdditiveReason("DROP TABLE a;")).toBe("drop_table");
    expect(nonAdditiveReason("drop\n table `a`;")).toBe("drop_table");
    expect(nonAdditiveReason("DROP TABLE IF EXISTS a;")).toBe("drop_table");
    expect(nonAdditiveReason("ALTER TABLE a DROP COLUMN b;")).toBe(
      "drop_column",
    );
    expect(nonAdditiveReason("ALTER TABLE a DROP b;")).toBe("drop_column");
    expect(nonAdditiveReason("ALTER TABLE a RENAME TO b;")).toBe("rename");
    expect(nonAdditiveReason("ALTER TABLE a RENAME COLUMN b TO c;")).toBe(
      "rename",
    );
  });

  it("a DELETE or UPDATE with no WHERE holds", () => {
    expect(nonAdditiveReason("DELETE FROM a;")).toBe("delete_all");
    expect(nonAdditiveReason("SELECT 1;\n  delete from a")).toBe("delete_all");
    expect(nonAdditiveReason("UPDATE a SET b = 1;")).toBe("update_all");
    expect(
      nonAdditiveReason("UPDATE a SET b = 1 WHERE c;\nUPDATE d SET e = 2;"),
    ).toBe("update_all");
  });

  it("comments and strings aren't read as SQL", () => {
    for (const sql of [
      "-- DROP TABLE a\nCREATE TABLE b (c TEXT);",
      "/* DROP TABLE a; */ CREATE TABLE b (c TEXT);",
      "INSERT INTO a VALUES ('DROP TABLE b;');",
      "INSERT INTO a VALUES ('it''s; DELETE FROM b');",
    ])
      expect(nonAdditiveReason(sql)).toBeNull();
  });

  it("a comment or string can't hide the real thing", () => {
    expect(nonAdditiveReason("/* x */ DROP TABLE a;")).toBe("drop_table");
    expect(nonAdditiveReason("INSERT INTO a VALUES ('x'); DROP TABLE b;")).toBe(
      "drop_table",
    );
    expect(nonAdditiveReason("UPDATE a SET b = 'WHERE c';")).toBe("update_all");
    expect(nonAdditiveReason("DELETE FROM a -- WHERE b\n;")).toBe("delete_all");
  });

  it("a comment can't split a keyword", () => {
    expect(nonAdditiveReason("DROP/**/TABLE a;")).toBe("drop_table");
    expect(nonAdditiveReason("DELETE/**/FROM a;")).toBe("delete_all");
    expect(nonAdditiveReason("UPDATE/* x */a SET b = 1;")).toBe("update_all");
  });

  it("a quoted name can't hide what follows", () => {
    for (const q of [
      '"a--b"',
      "[a--b]",
      "`a--b`",
      `"it's"`,
      "`it's`",
      "[it's]",
    ])
      expect(
        nonAdditiveReason(`CREATE TABLE ${q} (c TEXT); DROP TABLE d;`),
      ).toBe("drop_table");
    expect(nonAdditiveReason('UPDATE "a""b" SET c = 1;')).toBe("update_all");
  });

  it("DML nested past the start of a statement holds", () => {
    expect(
      nonAdditiveReason(
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM b; END;",
      ),
    ).toBe("trigger_delete_all");
    expect(
      nonAdditiveReason(
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET c = CASE WHEN 1 THEN 2 END; END;",
      ),
    ).toBe("trigger_update_all");
    expect(nonAdditiveReason("WITH x AS (SELECT 1) DELETE FROM a;")).toBe(
      "unknown",
    );
    expect(nonAdditiveReason("WITH x AS (SELECT 1) UPDATE a SET b = 1;")).toBe(
      "unknown",
    );
  });

  it("a name that reads like a trigger can't hide the next statement", () => {
    for (const sql of [
      "CREATE TABLE trigger (begin TEXT); DROP TABLE x;",
      "CREATE VIEW trigger AS SELECT 1 AS begin; DROP TABLE x;",
      "CREATE TABLE IF NOT trigger (begin TEXT); DROP TABLE x;",
    ])
      expect(nonAdditiveReason(sql), sql).toBe("drop_table");
    expect(
      nonAdditiveReason(
        "CREATE TEMP TRIGGER t BEGIN SELECT 1; END; DROP TABLE x;",
      ),
    ).toBe("unknown");
  });

  it("a safe trigger passes, and the statement after it is still read", () => {
    const t =
      "CREATE TRIGGER t BEFORE DELETE ON a BEGIN SELECT CASE WHEN old.x THEN RAISE(ABORT, 'no') END; END;";
    expect(nonAdditiveReason(t)).toBeNull();
    expect(nonAdditiveReason(`${t} DROP TABLE b;`)).toBe("drop_table");
  });

  it("a WHERE must narrow the statement itself", () => {
    expect(
      nonAdditiveReason("UPDATE a SET b = (SELECT c FROM d WHERE e = 1);"),
    ).toBe("update_all");
    expect(
      nonAdditiveReason("DELETE FROM a WHERE b IN (SELECT c FROM d);"),
    ).toBeNull();
    for (const w of [
      "1",
      "1 = 1",
      "TRUE",
      "NOT NULL",
      "(1)",
      "1 OR 1",
      "'a' = 'a'",
      "1 IS 1",
      "1e0",
      "NULL IS NULL",
      "1 RETURNING b",
      "a = a",
      "a = a + 0",
      '"a" = [A]',
      "t.a IS t.a",
      "a = t.a",
      "b = 1 OR 1",
      "lower(a) = 'x'",
      "(a = 1)",
      "a",
    ])
      expect(nonAdditiveReason(`DELETE FROM a WHERE ${w};`), w).toBe(
        "delete_all",
      );
    for (const w of [
      "a = 1",
      "a = 'x'",
      "a = b",
      "t.a = t.b",
      '"a" = 1',
      "a IS NULL",
      "a IS NOT NULL",
      "a IN (1, 2)",
      "a NOT IN (SELECT b FROM c)",
      "a LIKE 'x%'",
      "a BETWEEN 1 AND 2",
      "a = new.a",
      "a <> 1",
      "a >= 1",
      "a = 1 AND 1",
      "1 AND a = 1",
      "a = 1 RETURNING b",
      "a = 1 ORDER BY b LIMIT 1",
    ])
      expect(nonAdditiveReason(`DELETE FROM a WHERE ${w};`), w).toBeNull();
  });

  it("anything that overwrites holds", () => {
    expect(nonAdditiveReason("REPLACE INTO a VALUES (1);")).toBe("replace");
    expect(nonAdditiveReason("INSERT OR REPLACE INTO a VALUES (1);")).toBe(
      "replace",
    );
    expect(nonAdditiveReason("UPDATE OR REPLACE a SET b = 1 WHERE c;")).toBe(
      "replace",
    );
    expect(
      nonAdditiveReason(
        "INSERT INTO a VALUES (1) ON CONFLICT (b) DO UPDATE SET c = 2;",
      ),
    ).toBe("upsert");
    expect(nonAdditiveReason("INSERT OR IGNORE INTO a VALUES (1);")).toBeNull();
  });

  it("anything it can't read holds", () => {
    for (const sql of [
      "PRAGMA writable_schema = 1;",
      "ATTACH DATABASE 'x' AS y;",
      "VACUUM;",
      "DROP TRIGGER t;",
      "DROP VIEW v;",
      "ALTER TABLE a;",
    ])
      expect(nonAdditiveReason(sql)).toBe("unknown");
    for (const sql of [
      "/* DROP TABLE a;",
      "SELECT 'x",
      'SELECT "x',
      "SELECT [x",
    ])
      expect(nonAdditiveReason(sql)).toBe("unreadable");
  });

  it("every shipped migration: only 0017 is held", () => {
    const dir = join(import.meta.dirname, "../../../apps/server/migrations");
    const held = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => nonAdditiveReason(readFileSync(join(dir, f), "utf8")));
    expect(held).toEqual(["0017_image_format.sql"]);
  });
});
