import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Provision's built output must be plain JS at runtime: no type stripping.
// Compiles provision into its own temp dir (inside the package, so
// @oa/auth-core resolves through node_modules), never into dist, and never
// rebuilds a dist other test files import: auth-core's dist comes from the
// `test` script's build step, which this only checks.
const pkgDir = fileURLToPath(new URL("..", import.meta.url));
let out = "";

describe("dist runs under plain node", () => {
  beforeAll(() => {
    expect(
      existsSync(join(pkgDir, "../auth-core/dist/domains.js")),
      "run `pnpm --filter @oa/auth-core build` first (provision's test script does)",
    ).toBe(true);
    out = mkdtempSync(join(pkgDir, ".dist-node-"));
    const tsc = createRequire(join(pkgDir, "package.json")).resolve(
      "typescript/bin/tsc",
    );
    execFileSync(
      process.execPath,
      [
        tsc,
        "-p",
        "tsconfig.json",
        "--outDir",
        out,
        "--tsBuildInfoFile",
        join(out, ".tsbuildinfo"),
      ],
      { cwd: pkgDir, stdio: "pipe" },
    );
  }, 180_000);
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it("imports the built names and builds an entry with domains, without --experimental-strip-types", () => {
    const names = pathToFileURL(join(out, "names.js")).href;
    const script = `
      const m = await import(${JSON.stringify(names)});
      const e = m.registryEntry({
        installId: "iabc123def45",
        origin: "https://a.example",
        keys: [],
        domains: m.registryDomains("B.example,a.example"),
      });
      console.log(JSON.stringify(e.domains));
    `;
    const r = spawnSync(
      process.execPath,
      ["--no-experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: pkgDir, encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('["a.example","b.example"]');
  });
});
