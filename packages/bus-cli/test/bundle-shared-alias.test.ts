// The release job packs oa-bus after only `pnpm install`, so packages/shared
// has no dist: every @oa/shared import in src must be bundled from source
// through bundle.mjs's alias, or `npm pack` fails (v0.239.1's pack-npm).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.(ts|mts|js|mjs)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe("bundle.mjs", () => {
  it("aliases every @oa/shared subpath that src imports", () => {
    const used = new Set<string>();
    for (const f of files(join(root, "src")))
      for (const m of readFileSync(f, "utf8").matchAll(
        /from\s+["'](@oa\/shared(?:\/[^"']+)?)["']/g,
      ))
        used.add(m[1] as string);
    expect(used.size).toBeGreaterThan(0);
    const bundle = readFileSync(join(root, "scripts/bundle.mjs"), "utf8");
    const missing = [...used].filter((u) => !bundle.includes(`"${u}":`));
    expect(missing).toEqual([]);
  });
});
