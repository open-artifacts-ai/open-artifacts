import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Provision's built output must be plain JS at runtime: no type stripping.
// Builds provision (which builds @oa/auth-core first), then imports
// @oa/provision/names in a node that refuses to strip types.
const pkgDir = fileURLToPath(new URL("..", import.meta.url));

describe("dist runs under plain node", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["--filter", "@oa/provision", "build"], {
      cwd: pkgDir,
      stdio: "pipe",
    });
  }, 180_000);

  it("imports @oa/provision/names and builds an entry with domains, without --experimental-strip-types", () => {
    const script = `
      const m = await import("@oa/provision/names");
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
