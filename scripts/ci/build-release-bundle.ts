// Writes the release Worker bundle to <outdir> via @oa/bundle buildBundle
// (a `wrangler deploy --dry-run` of the rendered setup template with dummy
// values: no account, no secrets). Input for check-no-test-hooks.ts.
// Needs `pnpm --filter @oa/bundle build` (or `pnpm --filter @oa/provision
// build`, which builds it), `pnpm --filter @oa/server run gen`
// and an apps/server/dist-assets directory first.
// Usage: node --experimental-strip-types scripts/ci/build-release-bundle.ts <outdir> [--variant release|redline]
// (default release; redline defines the test-hooks guard true, T3b).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Bundle = {
  modules: { name: string; bytes: Uint8Array }[];
  mainModule: string;
};
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const [out, flag, value, ...extra] = process.argv.slice(2);
const variant = flag === undefined ? "release" : value;
if (
  !out ||
  extra.length > 0 ||
  (flag !== undefined && flag !== "--variant") ||
  (variant !== "release" && variant !== "redline")
) {
  console.log(
    "usage: build-release-bundle.ts <outdir> [--variant release|redline]",
  );
  process.exit(1);
}
// The built package (dist), so its .js imports resolve under plain node.
const dist = pathToFileURL(join(root, "packages/bundle/dist/index.js")).href;
const { buildBundle } = (await import(dist)) as {
  buildBundle(
    root: string,
    o: { variant: "release" | "redline" },
  ): Promise<Bundle>;
};
const b = await buildBundle(root, { variant });
const dir = resolve(out);
for (const m of b.modules) {
  const p = join(dir, m.name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, m.bytes);
}
console.log(
  `build-release-bundle: ${variant}, ${b.modules.length} modules, main ${b.mainModule}, in ${dir}`,
);
