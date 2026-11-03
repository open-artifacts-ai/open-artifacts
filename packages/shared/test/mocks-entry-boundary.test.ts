import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The public mocks entry (@oa/shared/mocks) is loaded by the dashboard. It must
// never reach hosted provisioning code: neither the provisioning MSW mock
// (src/mocks/provisioning.ts) nor anything under src/provisioning/. That code
// moves to the private hosted repo (#1056).

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ENTRY = resolve(SRC, "mocks/index.ts");

// Static and dynamic specifiers, including `import type` / `export type`.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function resolveLocal(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    resolve(base, "index.ts"),
  ];
  const hit = candidates.find((c) => /\.tsx?$/.test(c) && existsSync(c));
  if (!hit) throw new Error(`unresolved import ${spec} in ${from}`);
  return hit;
}

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const spec = m[1] as string;
      if (spec.startsWith(".")) queue.push(resolveLocal(file, spec));
      else if (spec.startsWith("@oa/shared"))
        throw new Error(`self-import ${spec} in ${file}; use a relative path`);
    }
  }
  return [...seen].map((f) => relative(SRC, f));
}

describe("@oa/shared/mocks entry", () => {
  const files = reachable(ENTRY);

  it("walks the real graph", () => {
    expect(files).toContain("mocks/index.ts");
    expect(files).toContain("mocks/handlers.ts");
    expect(files).toContain("mocks/hosted.ts");
  });

  it("never reaches the provisioning mock or src/provisioning/", () => {
    const hosted = files.filter(
      (f) => f === "mocks/provisioning.ts" || f.startsWith("provisioning/"),
    );
    expect(hosted).toEqual([]);
  });
});
