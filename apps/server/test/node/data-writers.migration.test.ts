import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { can, dataWritersOf } from "../../src/auth/policy.ts";

// #681: migration NNNN_data_writers (found by suffix, never by number),
// before and after on a seeded table. The migrations before it build the
// table in SQLite; the seeded rows cover every visibility and
// allow_anonymous_writes value, plus random ones.
const DIR = join(import.meta.dirname, "../../migrations");
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const at = files.findIndex((f) => f.endsWith("_data_writers.sql"));
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");

type Row = {
  id: string;
  visibility: string;
  aaw: number;
  deleted: boolean;
};
type Who = "anonymous" | "viewer" | "editor";
const WHO: readonly Who[] = ["anonymous", "viewer", "editor"];

/** The writers before #681: signed-in viewers and up; anonymous only with the opt-in on a public artifact. */
const writersBefore = (r: Row, who: Who) =>
  who === "anonymous" ? r.visibility === "public" && r.aaw === 1 : true;
/** After, by the live policy and the live read of both columns. */
const writersAfter = (r: Row, after: { dw: string; aaw: number }, who: Who) =>
  can(
    who === "anonymous" ? (r.visibility === "public" ? "viewer" : null) : who,
    "data.write",
    {
      cap: null,
      personal: true,
      anonymous: who === "anonymous",
      dataWriters: dataWritersOf({
        dataWriters: after.dw,
        allowAnonymousWrites: after.aaw,
      }),
    },
  );
/** The statements after the ADD COLUMN (backfill and alignment). */
const updates = () =>
  (sql(files[at] as string).split("--> statement-breakpoint") as string[])
    .slice(1)
    .join("\n");

/** A deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function migrated(rows: Row[]) {
  const db = new DatabaseSync(":memory:");
  // Seeded rows reference no users or spaces.
  db.exec("PRAGMA foreign_keys = OFF");
  for (const f of files.slice(0, at)) db.exec(sql(f));
  const ins = db.prepare(
    `insert into artifacts (id, owner_id, space_id, title, format, visibility,
       allow_anonymous_writes, created_at, updated_at, deleted_at)
     values (?, 'u', 'u', 't', 'html', ?, ?, 1, 1, ?)`,
  );
  for (const r of rows)
    ins.run(r.id, r.visibility, r.aaw, r.deleted ? 2 : null);
  db.exec(sql(files[at] as string));
  const out = new Map<string, { dw: string; aaw: number }>();
  for (const x of db
    .prepare(
      "select id, data_writers dw, allow_anonymous_writes aaw from artifacts",
    )
    .all() as { id: string; dw: string; aaw: number }[])
    out.set(x.id, { dw: x.dw, aaw: x.aaw });
  return { db, out };
}

describe("migration data_writers", () => {
  it("exists, with its CHECK and backfill", () => {
    expect(at).toBeGreaterThan(0);
    const m = sql(files[at] as string);
    expect(m).toMatch(
      /ADD `data_writers` text DEFAULT 'viewers' NOT NULL CONSTRAINT "artifacts_data_writers_check" CHECK\("data_writers" in \('viewers', 'editors'\)\)/,
    );
    expect(m).toMatch(
      /UPDATE `artifacts` SET `data_writers` = 'editors' WHERE `visibility` = 'public' AND `allow_anonymous_writes` = 0/,
    );
    expect(m).toMatch(
      /UPDATE `artifacts` SET `allow_anonymous_writes` = CASE WHEN `data_writers` = 'viewers' THEN 1 ELSE 0 END/,
    );
    // Additive: allow_anonymous_writes stays (release-before-use).
    expect(m).not.toMatch(/DROP|RENAME/i);
  });

  it("maps each visibility and opt-in", () => {
    const cases: [string, number, string][] = [
      ["public", 1, "viewers"],
      ["public", 0, "editors"],
      ["team", 0, "viewers"],
      ["team", 1, "viewers"],
      ["private", 0, "viewers"],
      ["private", 1, "viewers"],
    ];
    const rows = cases.map(([visibility, aaw], i) => ({
      id: `c${i}`,
      visibility,
      aaw,
      deleted: false,
    }));
    const { out } = migrated(rows);
    cases.forEach(([v, aaw, want], i) => {
      expect(out.get(`c${i}`)?.dw, `${v} ${aaw}`).toBe(want);
      // Aligned on every row, private and team included.
      expect(out.get(`c${i}`)?.aaw, `${v} ${aaw}`).toBe(
        want === "viewers" ? 1 : 0,
      );
    });
  });

  it("private and team viewers rows get allow_anonymous_writes 1", () => {
    const rows: Row[] = ["private", "team"].flatMap((visibility) => [
      { id: `${visibility}0`, visibility, aaw: 0, deleted: false },
      { id: `${visibility}0d`, visibility, aaw: 0, deleted: true },
    ]);
    const { out } = migrated(rows);
    for (const r of rows)
      expect(out.get(r.id), r.id).toEqual({ dw: "viewers", aaw: 1 });
  });

  it("is idempotent: rerunning the backfill and alignment changes nothing", () => {
    const r = rng(682);
    const VIS = ["private", "team", "public"];
    const rows: Row[] = Array.from({ length: 200 }, (_, i) => ({
      id: `i${i}`,
      visibility: VIS[Math.floor(r() * 3)] as string,
      aaw: r() < 0.5 ? 1 : 0,
      deleted: r() < 0.1,
    }));
    const { db, out } = migrated(rows);
    const snap = () =>
      db
        .prepare(
          "select id, visibility, data_writers, allow_anonymous_writes, updated_at, deleted_at from artifacts order by id",
        )
        .all();
    const once = snap();
    db.exec(updates());
    expect(snap()).toEqual(once);
    db.exec(updates());
    expect(snap()).toEqual(once);
    // And the columns agree on every row.
    for (const [, x] of out) expect(x.aaw).toBe(x.dw === "viewers" ? 1 : 0);
  });

  it("never grows the set of writers on any row (seeded table)", () => {
    const r = rng(681);
    const VIS = ["private", "team", "public"];
    const rows: Row[] = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      visibility: VIS[Math.floor(r() * 3)] as string,
      aaw: r() < 0.5 ? 1 : 0,
      deleted: r() < 0.1,
    }));
    const { out } = migrated(rows);
    const grew: string[] = [];
    for (const row of rows) {
      const after = out.get(row.id) as { dw: string; aaw: number };
      for (const who of WHO)
        if (writersAfter(row, after, who) && !writersBefore(row, who))
          grew.push(`${row.id} ${row.visibility} aaw=${row.aaw} ${who}`);
    }
    expect(grew).toEqual([]);
    // Anonymous writers are exactly the opted-in public rows, before and after.
    for (const row of rows)
      expect(
        writersAfter(
          row,
          out.get(row.id) as { dw: string; aaw: number },
          "anonymous",
        ),
      ).toBe(writersBefore(row, "anonymous"));
  });

  it("the CHECK refuses other values", () => {
    const { db } = migrated([
      { id: "x", visibility: "public", aaw: 1, deleted: false },
    ]);
    expect(() =>
      db.exec("update artifacts set data_writers = 'anyone' where id = 'x'"),
    ).toThrow(/CHECK/);
  });
});
