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

  it("every shipped migration: only 0017 is held", () => {
    const dir = join(import.meta.dirname, "../../../apps/server/migrations");
    const held = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => nonAdditiveReason(readFileSync(join(dir, f), "utf8")));
    expect(held).toEqual(["0017_image_format.sql"]);
  });
});
