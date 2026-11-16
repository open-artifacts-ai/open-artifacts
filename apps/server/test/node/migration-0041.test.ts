// Migration 0041 reworks passkey_settings for #2661: two additive columns and a
// reset of "every answer". The six old switches stay in place, unread.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const statements = readFileSync(
  join(__dirname, "../../migrations/0041_passkey_high_stakes.sql"),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((s) =>
    s
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter(Boolean);

const OLD = `create table passkey_settings (
  user_id text primary key not null,
  ask_merge integer default 1 not null, ask_deploy integer default 1 not null,
  ask_delete integer default 1 not null, ask_share integer default 1 not null,
  ask_public integer default 1 not null, ask_command integer default 1 not null,
  every_pick integer default 0 not null, updated_at integer not null
);`;

const seed = () => {
  const d = new DatabaseSync(":memory:");
  d.exec(OLD);
  const ins = d.prepare(
    "insert into passkey_settings (user_id, ask_merge, ask_deploy, ask_delete, ask_share, ask_public, ask_command, every_pick, updated_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  );
  ins.run("all-off", 0, 0, 0, 0, 0, 0, 1);
  ins.run("every", 1, 1, 1, 1, 1, 1, 2);
  ins.run("default", 1, 1, 1, 1, 1, 0, 3);
  return d;
};

describe("migration 0041", () => {
  it("only adds columns and resets one: no table is rebuilt", () => {
    expect(
      statements.filter((s) => /^(ALTER TABLE|UPDATE)/.test(s)),
    ).toHaveLength(statements.length);
    expect(statements.some((s) => /CREATE|DROP/i.test(s))).toBe(false);
  });

  it("everyone starts with high stakes on and every answer off, with no rule", () => {
    const d = seed();
    for (const s of statements) d.exec(s);
    const rows = d
      .prepare(
        "select user_id, high_stakes, every_pick, own_rule from passkey_settings order by updated_at",
      )
      .all();
    expect(rows).toEqual([
      { user_id: "all-off", high_stakes: 1, every_pick: 0, own_rule: "" },
      { user_id: "every", high_stakes: 1, every_pick: 0, own_rule: "" },
      { user_id: "default", high_stakes: 1, every_pick: 0, own_rule: "" },
    ]);
  });

  it("leaves the old switches and the timestamps as they were", () => {
    const d = seed();
    for (const s of statements) d.exec(s);
    expect(
      d
        .prepare(
          "select ask_merge, ask_command, updated_at from passkey_settings where user_id = 'all-off'",
        )
        .get(),
    ).toEqual({ ask_merge: 0, ask_command: 1, updated_at: 1 });
  });
});
