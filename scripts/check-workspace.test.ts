import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const rootPkg = JSON.parse(read("package.json"));

const packages: Record<string, string> = {
  "apps/server": "@oa/server",
  "apps/dashboard": "@oa/dashboard",
  "apps/landing": "@oa/landing",
  "apps/demo-ops": "@oa/demo-ops",
  "packages/shared": "@oa/shared",
  "packages/ui": "@oa/ui",
  "packages/runtime": "@oa/runtime",
  "packages/render": "@oa/render",
  "scripts/setup": "@oa/setup",
  "tests/redline": "@oa/redline",
};

describe("workspace", () => {
  it("declares exactly the globs", () => {
    const ws = parse(read("pnpm-workspace.yaml"));
    expect(ws.packages).toEqual([
      "apps/*",
      "packages/*",
      "scripts/*",
      "tests/*",
    ]);
  });

  it.each(Object.entries(packages))("%s is %s", (dir, name) => {
    expect(existsSync(join(root, dir, "package.json"))).toBe(true);
    const pkg = JSON.parse(read(`${dir}/package.json`));
    expect(pkg.name).toBe(name);
    expect(pkg.type).toBe("module");
  });

  it("has root scripts", () => {
    for (const s of ["build", "test", "lint", "typecheck", "dev"]) {
      expect(typeof rootPkg.scripts[s]).toBe("string");
    }
    expect(rootPkg.scripts["oa:setup"]).toBe("pnpm --filter @oa/setup start");
  });

  it("pins tool versions", () => {
    expect(rootPkg.devDependencies.vitest).toMatch(/^[\^~]?4\.1/);
    expect(rootPkg.devDependencies.typescript).toMatch(/^[\^~]?5\./);
  });

  it("gitignores required paths (whole lines)", () => {
    const lines = read(".gitignore")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const p of [
      ".superpowers/",
      ".openartifacts/",
      "node_modules/",
      "dist/",
      ".wrangler/",
      "apps/server/wrangler.jsonc",
    ]) {
      expect(lines).toContain(p);
    }
  });

  it("ignores env, secrets and local dirs", () => {
    for (const p of [
      ".env.local",
      ".env.production",
      ".dev.vars.staging",
      "coverage/x",
      ".claude/x",
    ]) {
      const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: root });
      expect(r.status, p).toBe(0);
    }
    const r = spawnSync("git", ["check-ignore", "-q", ".env.example"], {
      cwd: root,
    });
    expect(r.status).toBe(1);
  });

  it("biome recommended lint rules are on", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-biome-"));
    try {
      const file = join(dir, "bad.ts");
      writeFileSync(file, "debugger;\n");
      const r = spawnSync(
        join(root, "node_modules/.bin/biome"),
        ["lint", `--config-path=${join(root, "biome.json")}`, file],
        { cwd: root },
      );
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("root vitest config only includes scripts tests", () => {
    expect(read("vitest.config.ts")).toContain("scripts/**/*.test.ts");
  });
});
