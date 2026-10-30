import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockProblems } from "./check-migration-lock.mjs";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function dirWith(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "mlock-"));
  for (const [f, s] of Object.entries(files)) writeFileSync(join(d, f), s);
  return d;
}

describe("lockProblems", () => {
  const files = { "0001_a.sql": "create table a (x);\n" };
  const pins = { "0001_a.sql": sha(files["0001_a.sql"]) };

  it("all good: frozen, pinned, matching", () => {
    expect(lockProblems(dirWith(files), { frozen: true, pins })).toEqual([]);
  });
  it("not frozen", () => {
    const p = lockProblems(dirWith(files), { frozen: false, pins });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("not frozen");
    expect(lockProblems(dirWith(files), null)[0]).toContain("not frozen");
  });
  it("an unpinned file", () => {
    const d = dirWith({ ...files, "0002_b.sql": "select 1;\n" });
    expect(lockProblems(d, { frozen: true, pins })).toEqual([
      "0002_b.sql is not pinned",
    ]);
  });
  it("a changed file", () => {
    const d = dirWith({ "0001_a.sql": "create table a (y);\n" });
    expect(lockProblems(d, { frozen: true, pins })[0]).toContain(
      "0001_a.sql changed after it was deployed",
    );
  });
  it("a missing pinned file", () => {
    expect(lockProblems(dirWith({}), { frozen: true, pins })).toEqual([
      "0001_a.sql is pinned but missing",
    ]);
  });
});

describe("the platform D1 migration lock", () => {
  it("is frozen and holds for apps/platform-db/migrations", () => {
    const root = join(import.meta.dirname, "../..");
    const lock = JSON.parse(
      readFileSync(join(root, "apps/platform-db/migration-lock.json"), "utf8"),
    );
    expect(lock.frozen).toBe(true);
    expect(
      lockProblems(join(root, "apps/platform-db/migrations"), lock),
    ).toEqual([]);
  });
});
