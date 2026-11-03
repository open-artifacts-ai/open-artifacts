// The seeder behind the migration-timing CI job (#1213), at a small scale:
// every table of the current schema has a seed rule, the rows it writes fit
// the schema (constraints, triggers, foreign keys), and a table with no rule
// fails, naming it. The full-size run is the CI job (scripts/migration-timing.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { missingRules, RULES, seed } from "../../scripts/migration-seed.ts";
import {
  applyMigration,
  D1_MIGRATIONS,
} from "../../scripts/migration-timing.ts";

const dir = join(__dirname, "../../migrations");
const files = readdirSync(dir)
  .filter((n) => /^\d{4}_.*\.sql$/.test(n))
  .sort();

function migrated() {
  const d = new DatabaseSync(":memory:");
  d.exec(D1_MIGRATIONS);
  for (const f of files) applyMigration(d, f, readFileSync(join(dir, f), "utf8"));
  return d;
}

describe("migration seeder", () => {
  it("has a rule for every table of the current schema", () => {
    expect(missingRules(migrated())).toEqual([]);
  });

  it("seeds every table, consistent with the schema's keys", () => {
    const d = migrated();
    d.exec("pragma foreign_keys = on");
    const r = seed(d, { scale: 0.002 });
    for (const t of Object.keys(RULES)) {
      expect(r.rows[t], t).toBeGreaterThan(0);
    }
    expect(d.prepare("pragma foreign_key_check").all()).toEqual([]);
    // 0021's backfill input: removed users whose latest user.status row
    // gives a directory reason.
    const marked = d
      .prepare(
        `select count(*) as n from users where status = 'removed' and (
          select json_extract(detail, '$.reason') from audit_events
          where target_type = 'user' and target_id = users.id and action = 'user.status'
          order by at desc, id desc limit 1) like 'directory\\_%' escape '\\'`,
      )
      .get() as { n: number };
    expect(marked.n).toBeGreaterThan(0);
  });

  it("fails a table with no seed rule, naming it", () => {
    const d = migrated();
    d.exec("create table `brand_new` (`id` text primary key not null)");
    expect(() => seed(d, { scale: 0.002 })).toThrow(
      /no seed rule for table\(s\): brand_new/,
    );
  });

  it("fails a rule that leaves a required column empty, naming it", () => {
    const d = migrated();
    d.exec("create table `t2` (`id` text primary key not null, `n` integer not null)");
    expect(() =>
      seed(d, { scale: 0.002, rules: { ...RULES, t2: { rows: () => 1, row: () => ({ id: "x" }) } } }),
    ).toThrow(/seed rule for t2 leaves required column n empty/);
  });
});
