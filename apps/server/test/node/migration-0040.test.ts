// Migration 0040 adds shares.can_comment (#2590): additive, no rebuild and no
// CHECK change. A commenter share is stored as role 'viewer' with
// can_comment = 1 and read back as "commenter" (db/share-role.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  apiShareRole,
  SHARE_ROLE_CASE,
  storedShare,
} from "../../src/db/share-role.js";

const statements = readFileSync(
  join(__dirname, "../../migrations/0040_share_can_comment.sql"),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

/** The table as 0000 and 0017 left it (the CHECK lists viewer and editor). */
const OLD = `create table shares (
  artifact_id text not null,
  email text not null collate nocase,
  role text not null,
  created_by text not null,
  created_at integer not null,
  primary key (artifact_id, email),
  constraint shares_role_check check (role in ('viewer', 'editor'))
);
create index shares_email_idx on shares (email);`;

const ROWS: [string, string, string, string, number][] = [
  ["a1", "Bob@Example.com", "viewer", "u1", 1],
  ["a1", "carol@X.com", "editor", "u1", 2],
  ["a2", "Dan-Smith@Mixed.CASE", "viewer", "u2", 3],
  ["a2", "eve@x.com", "editor", "u2", 4],
];

const seed = () => {
  const d = new DatabaseSync(":memory:");
  d.exec(OLD);
  const ins = d.prepare("insert into shares values (?, ?, ?, ?, ?)");
  for (const [a, e, r, u, t] of ROWS) ins.run(a, e, r, u, t);
  return d;
};
const read = (d: DatabaseSync) =>
  d
    .prepare(
      "select artifact_id, email, role, created_by, created_at from shares order by created_at",
    )
    .all()
    .map((r) => Object.values(r as object));

describe("migration 0040", () => {
  it("is one additive ALTER: no rebuild", () => {
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TABLE `shares` ADD `can_comment`/);
  });

  it("existing rows (mixed-case emails, viewer and editor) read back identical", () => {
    const d = seed();
    const before = read(d);
    for (const s of statements) d.exec(s);
    expect(read(d)).toEqual(before);
    expect(d.prepare("select distinct can_comment from shares").all()).toEqual([
      { can_comment: 0 },
    ]);
    // The email column still matches without regard to case.
    expect(
      d
        .prepare("select count(*) as n from shares where email = ?")
        .get("bob@example.com"),
    ).toEqual({ n: 1 });
    // And through the API read, nothing changes.
    expect(
      d
        .prepare(
          `select ${SHARE_ROLE_CASE} as role from shares order by created_at`,
        )
        .all()
        .map((r) => (r as { role: string }).role),
    ).toEqual(["viewer", "editor", "viewer", "editor"]);
  });

  it("a commenter row round-trips as 'commenter', stored as viewer", () => {
    const d = seed();
    for (const s of statements) d.exec(s);
    const s = storedShare("commenter");
    expect(s).toEqual({ role: "viewer", canComment: 1 });
    d.prepare(
      "insert into shares (artifact_id, email, role, can_comment, created_by, created_at) values (?, ?, ?, ?, ?, ?)",
    ).run("a3", "Frank@X.com", s.role, s.canComment, "u3", 9);
    const row = d
      .prepare(
        `select role, can_comment, ${SHARE_ROLE_CASE} as api from shares where email = ?`,
      )
      .get("frank@x.com") as { role: string; can_comment: number; api: string };
    expect(row).toEqual({ role: "viewer", can_comment: 1, api: "commenter" });
    expect(apiShareRole(row.role, row.can_comment)).toBe("commenter");
    // The CHECK is unchanged: the stored role is never "commenter".
    expect(() =>
      d
        .prepare(
          "insert into shares (artifact_id, email, role, created_by, created_at) values ('a3', 'g@x.com', 'commenter', 'u', 1)",
        )
        .run(),
    ).toThrow();
    // Viewer and editor map to themselves.
    expect(storedShare("viewer")).toEqual({ role: "viewer", canComment: 0 });
    expect(storedShare("editor")).toEqual({ role: "editor", canComment: 0 });
    expect(apiShareRole("editor", 0)).toBe("editor");
  });
});
