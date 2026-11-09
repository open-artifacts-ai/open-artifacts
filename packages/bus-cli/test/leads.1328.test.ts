// `oa-bus leads check` (#1328, PR 1): a read-only look at <home>/leads.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

const HUB = "https://artifacts.example.com";

function setup(opts: { machine?: boolean } = {}) {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
  if (opts.machine !== false)
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({ hub: "https://artifacts.example.com/" }),
      { mode: 0o600 },
    );
  const repo = join(ctx.userHome, "repo");
  const wt = join(ctx.userHome, "wt");
  mkdirSync(repo);
  mkdirSync(wt);
  const bin = join(ctx.userHome, "claude");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(bin, 0o755);
  const dir = join(ctx.home, "leads");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const tpl = {
    harness: "claude-code",
    binary: bin,
    repo,
    worktree: "new",
    worktree_root: wt,
    role_name: "OA Docs",
    brief: `${HUB}/a/cZ3zRk6KxsHAc5tz`,
    permission_cap: "read_only",
  };
  const write = (name: string, v: unknown, mode = 0o600) => {
    const f = join(dir, `${name}.json`);
    writeFileSync(f, JSON.stringify(v));
    chmodSync(f, mode);
  };
  const run = (...argv: string[]) => main(["leads", ...argv], () => ctx);
  return { ctx, tpl, write, run, dir };
}

/** Every path under `root` with its size and mtime: what "read-only" must leave alone. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = statSync(p);
      out.push(`${p} ${st.size} ${st.mtimeMs} ${st.mode}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

describe("oa-bus leads check", () => {
  it("parses", () => {
    expect(parse(["leads", "check"])).toMatchObject({
      cmd: "leads",
      sub: "check",
    });
    expect(parse(["leads", "check", "docs"])).toMatchObject({ name: "docs" });
    expect(() => parse(["leads"])).toThrow(/usage/);
    expect(() => parse(["leads", "start", "docs"])).toThrow(/usage/);
    expect(() => parse(["leads", "register", "docs"])).toThrow(/usage/);
    expect(() => parse(["leads", "check", "a", "b"])).toThrow(/unexpected/);
    expect(() => parse(["leads", "check", "--yes"])).toThrow(/does not apply/);
  });

  it("says a good template is usable, with its hash, and exits 0", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    expect(await s.run("check")).toBe(0);
    const out = s.ctx.out().join("\n");
    expect(out).toMatch(/docs/);
    expect(out).toMatch(/claude-code, role OA Docs, cap read_only/);
    expect(out).toMatch(/1 usable, 0 refused. Nothing was started or changed./);
  });

  it("refuses a template with a command key and exits 1", async () => {
    const s = setup();
    s.write("good", s.tpl);
    s.write("evil", { ...s.tpl, command: "rm -rf ~" });
    expect(await s.run("check")).toBe(1);
    expect(s.ctx.err().join("\n")).toMatch(/evil/);
    expect(s.ctx.out().join("\n")).toMatch(/1 usable, 1 refused/);
  });

  it("checks one named template, and a missing one exits 1", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    expect(await s.run("check", "docs")).toBe(0);
    expect(await s.run("check", "nope")).toBe(1);
    expect(await s.run("check", "../docs")).toBe(1);
  });

  it("says so when there are none, and exits 0", async () => {
    const s = setup();
    expect(await s.run("check")).toBe(0);
    expect(s.ctx.out().join("\n")).toMatch(/No lead templates/);
  });

  it("needs a hub: without one every brief is unverifiable", async () => {
    const s = setup({ machine: false });
    s.write("docs", s.tpl);
    expect(await s.run("check")).toBe(1);
    expect(s.ctx.err().join("\n")).toMatch(/no instance/);
  });

  it("refuses a brief on another host", async () => {
    const s = setup();
    s.write("docs", {
      ...s.tpl,
      brief: "https://other.example.org/a/cZ3zRk6KxsHAc5tz",
    });
    expect(await s.run("check")).toBe(1);
    expect(s.ctx.err().join("\n")).toMatch(/hub/);
  });

  it("is read-only: the home is byte-for-byte the same after", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    s.write("evil", { ...s.tpl, shell: true });
    const before = snapshot(s.ctx.userHome);
    const machine = readFileSync(join(s.ctx.home, "machine.json"), "utf8");
    await s.run("check");
    await s.run("check", "docs");
    expect(snapshot(s.ctx.userHome)).toEqual(before);
    expect(readFileSync(join(s.ctx.home, "machine.json"), "utf8")).toBe(
      machine,
    );
    expect(s.ctx.exec).not.toHaveBeenCalled();
    expect(s.ctx.fetch).not.toHaveBeenCalled();
  });

  it("does not create the leads folder", async () => {
    const s = setup();
    const other = fakeCtx();
    other.home = join(other.userHome, ".oa-bus");
    mkdirSync(other.home, { recursive: true });
    writeFileSync(
      join(other.home, "machine.json"),
      JSON.stringify({ hub: HUB }),
      {
        mode: 0o600,
      },
    );
    expect(await main(["leads", "check"], () => other)).toBe(0);
    expect(readdirSync(other.home)).toEqual(["machine.json"]);
    void s;
  });
});
