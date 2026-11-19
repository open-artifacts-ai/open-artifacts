import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every fs call layout.ts makes, with its path arguments, in order.
const calls: { fn: string; args: unknown[] }[] = [];
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  const wrapped: Record<string, unknown> = { ...fs };
  for (const [name, fn] of Object.entries(fs))
    if (typeof fn === "function" && name.endsWith("Sync"))
      wrapped[name] = (...args: unknown[]) => {
        calls.push({ fn: name, args });
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
  return { ...wrapped, default: wrapped };
});

const { installVersion, swap } = await import("../src/update/layout.ts");

const home = () => {
  const h = join(mkdtempSync(join(tmpdir(), "oa-swap-")), ".oa-bus");
  mkdirSync(h, { mode: 0o700 });
  return h;
};
const put = (v: string) => (dir: string) =>
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: v }));
const REMOVERS = ["rmSync", "unlinkSync", "rmdirSync"];

describe("swap replaces bin by one rename (#2552)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it.skipIf(process.platform === "win32")(
    "never removes or writes bin itself: one renameSync(tmp, bin), and bin is a new link",
    () => {
      const h = home();
      const bin = join(h, "bin");
      installVersion(h, "1.0.0", put("1.0.0"));
      installVersion(h, "2.0.0", put("2.0.0"));
      const before = lstatSync(bin).ino;
      calls.length = 0;
      swap(h, "1.0.0");
      const touchingBin = calls.filter((c) => c.args.some((a) => a === bin));
      // Reads of bin are fine; anything that removes or creates bin is not.
      expect(
        touchingBin.filter(
          (c) => REMOVERS.includes(c.fn) || c.fn === "symlinkSync",
        ),
      ).toEqual([]);
      const renames = calls.filter((c) => c.fn === "renameSync");
      expect(renames).toHaveLength(1);
      expect(renames[0]?.args[1]).toBe(bin);
      expect(String(renames[0]?.args[0])).toMatch(/\.new$/);
      // The link at bin was replaced, not edited in place.
      expect(lstatSync(bin).isSymbolicLink()).toBe(true);
      expect(lstatSync(bin).ino).not.toBe(before);
    },
  );
});
