import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { script } from "./stubs.ts";

const M = "apps/server/migrations";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "frozen-"));
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, M), { recursive: true });
  const write = (p: string, s: string) => writeFileSync(join(dir, p), s);
  write(`${M}/0001_init.sql`, "-- first\ncreate table a (x);\n");
  write(`${M}/0002_b.sql`, "create table b (y);\n");
  const commit = (msg: string) => {
    git("add", "-A");
    git("commit", "-qm", msg);
  };
  commit("init");
  return {
    dir,
    git,
    write,
    commit,
    tag: (t: string) => git("tag", t),
    run: () => {
      const r = spawnSync("bash", [script("released-migrations-frozen.sh")], {
        env: { ...process.env, ROOT: dir },
        encoding: "utf8",
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("released-migrations-frozen.sh", () => {
  it("passes when nothing changed", () => {
    const r = repo();
    r.tag("v1.0.0");
    expect(r.run().code).toBe(0);
    r.done();
  });
  it("passes for a new migration and an edit to a file newer than the tag", () => {
    const r = repo();
    r.tag("v1.0.0");
    r.write(`${M}/0003_c.sql`, "create table c (z);\n");
    r.commit("add");
    r.write(`${M}/0003_c.sql`, "create table c (z, w);\n");
    r.commit("edit unreleased");
    expect(r.run().code).toBe(0);
    r.done();
  });
  it("requires a marker and a verification plan for newly destructive SQL", () => {
    const r = repo();
    r.tag("v1.0.0");
    const path = `${M}/0003_cleanup.sql`;
    for (const sql of [
      "-- 0053-shaped cleanup\nDeLeTe /* dead devices */ FROM a;",
      "CREATE TRIGGER clean AFTER INSERT ON b BEGIN DELETE FROM a; END;",
      "CREATE TABLE tmp(x); INSERT INTO tmp SELECT x FROM a; DROP TABLE a;",
      "ALTER TABLE a DROP COLUMN x;",
      "REPLACE INTO a VALUES (1);",
    ]) {
      r.write(path, sql);
      r.commit("unmarked");
      expect(r.run().err).toContain("requires -- oa:non-additive");
    }
    r.write(path, "-- oa:non-additive\nDELETE FROM a;");
    r.commit("marker only");
    expect(r.run().err).toContain("-- oa:verify");
    r.write(
      path,
      "-- oa:non-additive\n-- oa:verify Compare survivor IDs before and after.\nDELETE FROM a;",
    );
    r.commit("documented");
    expect(r.run().code).toBe(0);
    r.write(
      path,
      "CREATE TABLE c(x TEXT DEFAULT 'DROP TABLE a;', y REFERENCES a ON DELETE CASCADE); -- DELETE FROM a",
    );
    r.commit("additive");
    expect(r.run().code).toBe(0);
    r.done();
  });

  it("compares with the highest stable tag, ignoring prereleases", () => {
    const r = repo();
    r.tag("v1.9.0");
    r.write(`${M}/0003_c.sql`, "x\n");
    r.commit("c");
    r.tag("v1.10.0");
    r.tag("v1.11.0-rc.1");
    r.write(`${M}/0003_c.sql`, "y\n");
    r.commit("edit");
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain(
      "0003_c.sql shipped in v1.10.0; add a new migration instead",
    );
    r.done();
  });
  it("fails on a one-byte comment edit", () => {
    const r = repo();
    r.tag("v1.0.0");
    r.write(`${M}/0001_init.sql`, "-- First\ncreate table a (x);\n");
    r.commit("edit");
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain(
      "apps/server/migrations/0001_init.sql shipped in v1.0.0; add a new migration instead",
    );
    r.done();
  });
  it("fails on a rename", () => {
    const r = repo();
    r.tag("v1.0.0");
    renameSync(join(r.dir, `${M}/0002_b.sql`), join(r.dir, `${M}/0002_bb.sql`));
    r.commit("rename");
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain("0002_b.sql shipped in v1.0.0");
    r.done();
  });
  it("fails on a delete", () => {
    const r = repo();
    r.tag("v1.0.0");
    rmSync(join(r.dir, `${M}/0002_b.sql`));
    r.commit("delete");
    expect(r.run().code).toBe(1);
    r.done();
  });
  it("fails closed with no release tag", () => {
    const r = repo();
    r.tag("v1.0.0-rc.1");
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain("no release tag");
    r.done();
  });
  it("fails closed when git errors", () => {
    const r = repo();
    r.done();
    const res = r.run();
    expect(res.code).toBe(1);
  });
});
