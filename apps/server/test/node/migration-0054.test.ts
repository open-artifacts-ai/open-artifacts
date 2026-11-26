import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SHARE_ROLE_CASE } from "../../src/db/share-role.js";

it("preserves existing members' commenting rights and other stored grants", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users(email TEXT COLLATE NOCASE, role TEXT); CREATE TABLE shares(email TEXT COLLATE NOCASE, role TEXT, can_comment INTEGER)",
  );
  const roles = ["owner", "admin", "member", "guest", "unknown"];
  for (const role of roles) {
    if (role !== "unknown")
      db.prepare("INSERT INTO users VALUES (?,?)").run(
        role.toUpperCase(),
        role,
      );
    for (const [grant, comments] of [
      ["viewer", 0],
      ["viewer", 1],
      ["editor", 0],
    ] as const)
      db.prepare("INSERT INTO shares VALUES (?,?,?)").run(
        role,
        grant,
        comments,
      );
  }
  db.exec(
    readFileSync(
      join(__dirname, "../../migrations/0054_member_viewer_comments.sql"),
      "utf8",
    ),
  );
  for (const role of roles) {
    const rows = db
      .prepare(
        `SELECT ${SHARE_ROLE_CASE} AS role FROM shares WHERE email = ? ORDER BY rowid`,
      )
      .all(role);
    expect(rows.map((row) => (row as { role: string }).role)).toEqual([
      ["guest", "unknown"].includes(role) ? "viewer" : "commenter",
      "commenter",
      "editor",
    ]);
  }
});
