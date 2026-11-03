// Migration 0021's backfill reads the audit log once per removed row
// (#1161). audit_events is indexed only on `at`, so without the temporary
// index the lookup is a scan per row: 278 s for 2k removed rows over 1M audit
// rows. This runs the migration's own statements under SQLite and checks the
// plan, which doesn't depend on machine speed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const statements = readFileSync(
  join(__dirname, "../../migrations/0021_removed_by_sync.sql"),
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

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`create table users (id text primary key, status text not null);
create table audit_events (id text primary key, at integer not null,
  action text not null, target_type text, target_id text, detail text);
create index audit_events_at_idx on audit_events (at);`);
  return d;
}

describe("migration 0021", () => {
  it("creates its index before the backfill and drops it after", () => {
    const i = statements.findIndex((s) => s.startsWith("CREATE INDEX"));
    const u = statements.findIndex((s) => s.startsWith("UPDATE `users`"));
    const d = statements.findIndex((s) => s.startsWith("DROP INDEX"));
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(u);
    expect(u).toBeLessThan(d);
  });

  it("the backfill searches the audit log by target, never scans it", () => {
    const d = db();
    for (const s of statements) {
      if (s.startsWith("UPDATE `users`")) {
        const plan = d
          .prepare(`explain query plan ${s}`)
          .all()
          .map((r) => String((r as { detail: unknown }).detail))
          .join(" | ");
        expect(plan).toMatch(
          /SEARCH audit_events USING INDEX tmp_0021_audit_target/,
        );
        expect(plan).not.toMatch(/SCAN audit_events/);
      }
      d.exec(s);
    }
  });

  it("leaves the schema as it found it, apart from the column", () => {
    const d = db();
    for (const s of statements) d.exec(s);
    const names = d
      .prepare("select name from sqlite_master where type = 'index'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).not.toContain("tmp_0021_audit_target");
  });
});
