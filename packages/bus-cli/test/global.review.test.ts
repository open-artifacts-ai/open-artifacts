// C19 review round 1: canonical paths, inherited entries, and doctor's safe reads.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { globalFile, readGlobalDirs, writeGlobalDirs } from "@oa/bus-daemon";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { main } from "../src/main.ts";
import { fakeCtx, transcript } from "./fake.ts";

/** A fresh ctx on the same homes and cwd as `base`. */
const again = (base: ReturnType<typeof fakeCtx>, cwd = base.cwd) =>
  Object.assign(fakeCtx(), {
    userHome: base.userHome,
    home: base.home,
    cwd,
  });

function setup() {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  mkdirSync(join(ctx.userHome, "code/ops/deep"), { recursive: true });
  ctx.cwd = join(ctx.userHome, "code");
  const dirs = () => readGlobalDirs(globalFile(ctx.home)).dirs;
  return { ctx, dirs, ops: join(ctx.userHome, "code/ops") };
}

describe("M3: entries cover their subdirectories", () => {
  it("add of a covered subdir says already global and adds nothing", async () => {
    const { ctx, dirs, ops } = setup();
    await main(["global", "add", "ops"], () => ctx);
    const sub = again(ctx, ops);
    expect(await main(["global", "add", "deep"], () => sub)).toBe(0);
    expect(sub.out()[2]).toBe(
      "[[success]]✓[[/success]]  ~/code/ops/deep is already global.",
    );
    expect(dirs()).toEqual([ops]);
  });

  it("rm of an inherited subdir says it was not global and keeps the parent", async () => {
    const { ctx, dirs, ops } = setup();
    await main(["global", "add", "ops"], () => ctx);
    const sub = again(ctx, ops);
    expect(await main(["global", "rm", "deep"], () => sub)).toBe(0);
    expect(sub.out()[2]).toBe(
      "[[warning]]![[/warning]]  ~/code/ops/deep was not global. Nothing changed.",
    );
    expect(dirs()).toEqual([ops]);
  });
});

describe("M1: add and rm store and match the canonical path", () => {
  it("a differently cased path is stored as the volume spells it", async () => {
    const { ctx, dirs, ops } = setup();
    if (!existsSync(join(ctx.userHome, "code/OPS"))) return; // case-sensitive volume
    expect(await main(["global", "add", "OPS"], () => ctx)).toBe(0);
    expect(dirs()).toEqual([ops]);
    const rm = again(ctx);
    await main(["global", "rm", "Ops"], () => rm);
    expect(dirs()).toEqual([]);
  });
});

describe("I2: doctor reads .oa-bus.json as the daemon does", () => {
  for (const [what, make] of [
    ["a FIFO", (f: string) => execFileSync("mkfifo", [f])],
    ["a /dev/zero symlink", (f: string) => symlinkSync("/dev/zero", f)],
  ] as const)
    it(`never hangs on ${what}`, async () => {
      const { ctx, ops } = setup();
      make(join(ops, ".oa-bus.json"));
      const d = again(ctx, ops);
      await doctor(d);
      expect(d.all().join("\n")).not.toContain("asks for global");
    }, 5000);
});

describe("M8: doctor on an unusable global.json", () => {
  const block = transcript("## 11. global")[8] as string[];
  const reason = (why: string) => [
    block[0],
    `   [[muted]]It ${why}.[[/muted]]`,
    block[2],
  ];

  it("prints Design's lines, with the reason by cause", async () => {
    for (const [make, lines] of [
      [
        (f: string) => {
          writeFileSync(f, '{"dirs":[]}');
          chmodSync(f, 0o666);
        },
        block,
      ],
      [
        (f: string) => writeFileSync(f, "{nope", { mode: 0o600 }),
        reason("is not valid JSON"),
      ],
      [
        (f: string) => {
          const t = `${f}.real`;
          writeFileSync(t, '{"dirs":[]}', { mode: 0o600 });
          symlinkSync(t, f);
        },
        reason("is a symlink"),
      ],
    ] as const) {
      const { ctx } = setup();
      mkdirSync(ctx.home, { recursive: true });
      make(globalFile(ctx.home));
      const code = await doctor(ctx);
      const all = ctx.all();
      const at = all.indexOf(lines[0] as string);
      expect(all.slice(at, at + 3)).toEqual(lines);
      // Exit code unaffected.
      const plain = setup();
      expect(await doctor(plain.ctx)).toBe(code);
    }
  });

  it("says nothing when there is no global.json", async () => {
    const { ctx } = setup();
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain("global.json");
  });
});

describe("R3: list, add and rm on an unusable global.json", () => {
  it("print Design's lines and never overwrite it", async () => {
    const block = transcript("## 11. global")[8] as string[];
    for (const argv of [["list"], ["add", "ops"], ["rm", "ops"]]) {
      const { ctx } = setup();
      mkdirSync(ctx.home, { recursive: true });
      const f = globalFile(ctx.home);
      writeFileSync(f, '{"dirs":["/hand/edited"]}');
      chmodSync(f, 0o666);
      expect(await main(["global", ...argv], () => ctx)).toBe(1);
      expect(ctx.all()).toEqual(["oa-bus 0.1.0", "", ...block]);
      expect(readFileSync(f, "utf8")).toBe('{"dirs":["/hand/edited"]}');
    }
  });
});

describe("R1/R4: rm matches entries by identity, only while their path is real", () => {
  it("rm never removes an entry whose path is now a symlink to the dir", async () => {
    const { ctx, dirs, ops } = setup();
    mkdirSync(ctx.home, { recursive: true });
    const link = join(ctx.userHome, "code/link");
    symlinkSync(ops, link);
    writeGlobalDirs([link], ctx.home);
    expect(await main(["global", "rm", "ops"], () => ctx)).toBe(0);
    expect(ctx.out()[2]).toBe(
      "[[warning]]![[/warning]]  ~/code/ops was not global. Nothing changed.",
    );
    expect(dirs()).toEqual([link]);
  });

  it("rm of the exact stored path still removes a stale entry", async () => {
    const { ctx, dirs } = setup();
    mkdirSync(ctx.home, { recursive: true });
    const link = join(ctx.userHome, "code/link");
    symlinkSync(join(ctx.userHome, "code/ops"), link);
    writeGlobalDirs([link], ctx.home);
    expect(await main(["global", "rm", link], () => ctx)).toBe(0);
    expect(dirs()).toEqual([]);
  });
});
