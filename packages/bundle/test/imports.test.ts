import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// #1056: @oa/bundle stays public when the hosted code goes private, so it
// must import nothing from it. A static scan of every import, export-from,
// dynamic import and require in src/: node built-ins and files inside src/
// only, and none of the private modules by name or by relative path.
const pkg = resolve(import.meta.dirname, "..");
const src = join(pkg, "src");
const repo = resolve(pkg, "../..");

/** Private modules, as package names and as repo paths. */
const FORBIDDEN = [
  "@oa/provision",
  "@oa/shared/provisioning",
  "@oa/gh-oidc",
  "@oa/hosted",
  "@oa/redline",
  "packages/provision",
  "packages/gh-oidc",
  "packages/shared/src/provisioning",
  "packages/shared/dist/provisioning",
  "apps/provisioner",
  "apps/provisioning",
  "apps/scheduler",
  "apps/dispatch",
  "apps/inventory",
  "apps/admin",
  "scripts/hosted",
  "tests/redline",
];

const SPEC =
  /\b(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]|\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g;

function specifiers(code: string): string[] {
  return [...code.matchAll(SPEC)].map((m) => (m[1] ?? m[2]) as string);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|mts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

/** Why `spec` (imported from `file`) is refused, or null. */
function refusal(file: string, spec: string): string | null {
  const target = spec.startsWith(".")
    ? relative(repo, resolve(dirname(file), spec))
        .split(sep)
        .join("/")
    : spec;
  const hit = FORBIDDEN.find((f) => target === f || target.startsWith(`${f}/`));
  if (hit) return `imports private ${hit}`;
  if (spec.startsWith("node:")) return null;
  if (spec.startsWith(".")) {
    const r = relative(src, resolve(dirname(file), spec));
    return r.startsWith("..") ? "imports a file outside src/" : null;
  }
  return "imports a package (only node: built-ins and src/ files)";
}

describe("@oa/bundle imports nothing private (#1056)", () => {
  it("every import in src/ is a node built-in or a src/ file", () => {
    const files = sources(src);
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        seen++;
        const why = refusal(f, s);
        if (why) bad.push(`${relative(pkg, f)}: "${s}" ${why}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("package.json depends on no workspace package", () => {
    const p = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const deps = Object.keys({
      ...p.dependencies,
      ...p.peerDependencies,
      ...p.optionalDependencies,
    });
    expect(deps.filter((d) => d.startsWith("@oa/"))).toEqual([]);
  });

  it("the scan catches each private module, static or dynamic", () => {
    const f = join(src, "bundle.ts");
    for (const code of [
      'import { x } from "@oa/provision";',
      'export * from "@oa/provision/jobs";',
      'import type { T } from "@oa/shared/provisioning";',
      'const m = await import("../../../apps/provisioner/src/index.js");',
      'const m = require("../../../tests/redline/src/a.js");',
      'import "../../../scripts/hosted/src/cli.ts";',
      'import { y } from "../../provision/src/release.js";',
    ]) {
      const [s] = specifiers(code);
      expect(s, code).toBeDefined();
      expect(refusal(f, s as string), code).toMatch(/private/);
    }
    expect(refusal(f, "node:fs")).toBeNull();
    expect(refusal(f, "./tree.js")).toBeNull();
    expect(refusal(f, "@oa/shared")).toMatch(/package/);
  });
});
