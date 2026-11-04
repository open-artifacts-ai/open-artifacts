// C19: `npx @open-artifacts/bus global add|rm|list`, and doctor's note for a repo asking for global.
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { globalFile, readGlobalDirs } from "@oa/bus-daemon";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { main } from "../src/main.ts";
import { fakeCtx, transcript } from "./fake.ts";

const blocks = transcript("## 11. global");

/** A ctx whose home has ~/code/ops and ~/code/notes, run from ~/code. */
function setup() {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  for (const d of ["code/ops", "code/notes"])
    mkdirSync(join(ctx.userHome, d), { recursive: true });
  ctx.cwd = join(ctx.userHome, "code");
  const run = (...argv: string[]) => main(["global", ...argv], () => ctx);
  const dirs = () => readGlobalDirs(globalFile(ctx.home)).dirs;
  return { ctx, run, dirs, ops: join(ctx.userHome, "code/ops") };
}

describe("C19: global add, rm and list", () => {
  it("add stores the realpath, 0600, and prints Design's lines", async () => {
    const { ctx, run, dirs, ops } = setup();
    expect(await run("add", "ops")).toBe(0);
    expect(ctx.all()).toEqual(blocks[0]);
    expect(dirs()).toEqual([ops]);
    expect(statSync(globalFile(ctx.home)).mode & 0o777).toBe(0o600);
  });

  it("add of a listed dir changes nothing", async () => {
    const { ctx, run, dirs, ops } = setup();
    await run("add", ops);
    const before = readFileSync(globalFile(ctx.home), "utf8");
    const again = fakeCtx();
    Object.assign(again, {
      userHome: ctx.userHome,
      home: ctx.home,
      cwd: ctx.cwd,
    });
    expect(await main(["global", "add", "./ops/"], () => again)).toBe(0);
    expect(again.all()).toEqual(blocks[1]);
    expect(dirs()).toEqual([ops]);
    expect(readFileSync(globalFile(ctx.home), "utf8")).toBe(before);
  });

  it("add refuses what is not a directory", async () => {
    const { ctx, run, dirs } = setup();
    expect(await run("add", "opz")).toBe(1);
    expect(ctx.all()).toEqual(blocks[2]);
    writeFileSync(join(ctx.cwd, "file"), "");
    expect(await run("add", "file")).toBe(1);
    expect(dirs()).toEqual([]);
  });

  it("rm removes it; rm of an unlisted dir warns and changes nothing", async () => {
    const a = setup();
    await a.run("add", "ops");
    const rm = fakeCtx();
    Object.assign(rm, {
      userHome: a.ctx.userHome,
      home: a.ctx.home,
      cwd: a.ctx.cwd,
    });
    expect(await main(["global", "rm", "ops"], () => rm)).toBe(0);
    expect(rm.all()).toEqual(blocks[3]);
    expect(a.dirs()).toEqual([]);
    const b = setup();
    expect(await b.run("rm", "ops")).toBe(0);
    expect(b.ctx.all()).toEqual(blocks[4]);
  });

  it("list: empty, then two entries, then one", async () => {
    const a = setup();
    expect(await a.run("list")).toBe(0);
    expect(a.ctx.all()).toEqual(blocks[5]);
    const b = setup();
    await b.run("add", "ops");
    await b.run("add", "notes");
    const list = fakeCtx();
    Object.assign(list, {
      userHome: b.ctx.userHome,
      home: b.ctx.home,
      cwd: b.ctx.cwd,
    });
    expect(await main(["global", "list"], () => list)).toBe(0);
    expect(list.all()).toEqual(blocks[6]);
    await b.run("rm", "notes");
    const one = fakeCtx();
    Object.assign(one, {
      userHome: b.ctx.userHome,
      home: b.ctx.home,
      cwd: b.ctx.cwd,
    });
    await main(["global", "list"], () => one);
    expect(one.out()[2]).toBe("1 global directory");
  });

  it("a malformed allowlist is reported, never a crash (R3)", async () => {
    const { ctx, run } = setup();
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(globalFile(ctx.home), "{nope", { mode: 0o600 });
    expect(await run("list")).toBe(1);
    const unusable = blocks[8] as string[];
    expect(ctx.all()).toEqual([
      "oa-bus 0.1.0",
      "",
      unusable[0],
      "   [[muted]]It is not valid JSON.[[/muted]]",
      unusable[2],
    ]);
  });

  it("needs a subcommand, and a dir for add and rm", async () => {
    for (const argv of [[], ["add"], ["rm"], ["nope"], ["list", "x"]]) {
      const { run } = setup();
      expect(await run(...argv)).toBe(2);
    }
  });
});

describe("C19: doctor on a repo asking for global", () => {
  const note = blocks[7] as string[];

  it("warns when the nearest .oa-bus.json says global and the dir is not listed", async () => {
    const { ctx, run } = setup();
    ctx.cwd = join(ctx.userHome, "code/ops");
    writeFileSync(
      join(ctx.cwd, ".oa-bus.json"),
      JSON.stringify({ namespace: "ops", global: true }),
      // Explicit: a group-writable file (umask 002) is ignored, as it must be.
      { mode: 0o644 },
    );
    const code = await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(note.join("\n"));
    expect(ctx.all().at(-1)).toMatch(/warning/);
    // Exit code unaffected: the same run without the file.
    const plain = setup();
    plain.ctx.cwd = join(plain.ctx.userHome, "code/ops");
    expect(await doctor(plain.ctx)).toBe(code);
    // Allowlisted: no note.
    await run("add", ".");
    const after = fakeCtx();
    Object.assign(after, {
      userHome: ctx.userHome,
      home: ctx.home,
      cwd: ctx.cwd,
    });
    await doctor(after);
    expect(after.all().join("\n")).not.toContain(note[0]);
  });
});
