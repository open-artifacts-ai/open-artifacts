import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { LEGACY_COMMENT } from "../../src/db/share-role.js";

it("adds legacy grants without touching existing rows and captures in-flight legacy writes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users(email TEXT PRIMARY KEY COLLATE NOCASE, role TEXT);
    CREATE TABLE shares(artifact_id TEXT, email TEXT COLLATE NOCASE, role TEXT, can_comment INTEGER, PRIMARY KEY(artifact_id,email));`);
  const grants = ["owner", "admin", "member", "guest", "unknown"];
  const put = db.prepare("INSERT INTO shares VALUES (?,?,?,?)");
  for (const kind of grants) {
    if (kind !== "unknown")
      db.prepare("INSERT INTO users VALUES (?,?)").run(
        kind.toUpperCase(),
        kind,
      );
    put.run("view", kind, "viewer", 0);
    put.run("comment", kind, "viewer", 1);
    put.run("edit", kind, "editor", 0);
  }
  const users = db.prepare("SELECT rowid,* FROM users ORDER BY rowid");
  const shares = db.prepare("SELECT rowid,* FROM shares ORDER BY rowid");
  const original = [users.all(), shares.all()];
  // Abort even a transient write to an original table during the migration.
  for (const table of ["users", "shares"]) {
    for (const action of ["insert", "update", "delete"]) {
      db.exec(`CREATE TEMP TRIGGER guard_${table}_${action} BEFORE ${action} ON ${table}
        BEGIN SELECT RAISE(ABORT,'migration modified existing table'); END;`);
    }
  }
  const migration = readFileSync(
    join(__dirname, "../../migrations/0054_member_viewer_comments.sql"),
    "utf8",
  );
  db.exec(migration);
  expect([users.all(), shares.all()]).toEqual(original);
  const preserved = db.prepare(
    "SELECT artifact_id,email FROM legacy_viewer_comments WHERE can_comment = 1 ORDER BY email",
  );
  expect(preserved.all()).toEqual(
    ["admin", "member", "owner"].map((email) => ({
      artifact_id: "view",
      email,
    })),
  );
  for (const action of ["insert", "update", "delete"])
    db.exec(`DROP TRIGGER guard_shares_${action}`);
  const mayComment = db.prepare(
    `SELECT ${LEGACY_COMMENT} AS granted FROM shares WHERE artifact_id = 'late' AND email = ?`,
  );
  put.run("late", "member", "viewer", 0);
  expect(mayComment.get("member")).toEqual({ granted: 1 });
  put.run("late", "guest", "editor", 0);
  db.prepare(
    "UPDATE shares SET role='viewer' WHERE artifact_id='late' AND email='guest'",
  ).run();
  expect(mayComment.get("guest")).toEqual({ granted: 0 });
  db.exec("DROP TRIGGER guard_users_update");
  db.prepare("UPDATE users SET role='member' WHERE email='guest'").run();
  db.prepare(
    "UPDATE shares SET role='editor' WHERE artifact_id='late' AND email='guest'",
  ).run();
  db.prepare(
    "UPDATE shares SET role='viewer' WHERE artifact_id='late' AND email='guest'",
  ).run();
  expect(mayComment.get("guest")).toEqual({ granted: 1 });

  db.prepare("DELETE FROM shares WHERE artifact_id='late'").run();
  expect(
    db
      .prepare("SELECT * FROM legacy_viewer_comments WHERE artifact_id='late'")
      .all(),
  ).toEqual([]);
});
