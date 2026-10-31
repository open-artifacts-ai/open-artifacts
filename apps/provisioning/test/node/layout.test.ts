import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static rules on the source tree (design v7 2.5, 9A.4).

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP = new Set(["node_modules", ".wrangler", "dist", "dist-assets"]);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => relative(app, p).split("\\").join("/");
const files = walk(app);
const src = files.filter((f) => rel(f).startsWith("src/") && f.endsWith(".ts"));
const mcp = src.filter((f) => rel(f).startsWith("src/mcp/"));

/** Every import of a file: `{ spec, typeOnly }`. */
function imports(file: string) {
  const text = readFileSync(file, "utf8");
  const re =
    /\b(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g;
  return [...text.matchAll(re)].map((m) => ({
    spec: m[3] as string,
    typeOnly: Boolean(m[2]),
  }));
}

describe("the provisioning token never reaches this app (2.5)", () => {
  // Built so this file does not contain the string itself.
  const needle = ["provision", "token"].join("-");

  it("no file under apps/provisioning names it", () => {
    expect(files.length).toBeGreaterThan(10);
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(needle));
    expect(hits.map(rel)).toEqual([]);
  });
});

describe("src/mcp is only a transport adapter (9A.4)", () => {
  // Runtime imports src/mcp may make inside the app: itself, invokeRoute,
  // and auth/ (authenticate). Type-only imports carry no code.
  const allowed = (target: string) =>
    target.startsWith("src/mcp/") ||
    target === "src/routes/invoke.ts" ||
    target.startsWith("src/auth/");
  // Packages: the tool table (@oa/shared/provisioning) and the MCP SDK.
  const allowedPkg = (spec: string) =>
    spec === "@oa/shared/provisioning" ||
    spec.startsWith("agents/") ||
    spec.startsWith("@modelcontextprotocol/");

  it("has files to check", () => {
    expect(mcp.length).toBeGreaterThan(0);
  });

  it("imports only invokeRoute, auth/, the tool table and the SDK", () => {
    const bad: string[] = [];
    for (const f of mcp)
      for (const { spec, typeOnly } of imports(f)) {
        if (typeOnly) continue;
        if (spec.startsWith(".")) {
          const target = rel(resolve(dirname(f), spec)).replace(/\.js$/, ".ts");
          if (!allowed(target)) bad.push(`${rel(f)} -> ${spec}`);
        } else if (!allowedPkg(spec)) bad.push(`${rel(f)} -> ${spec}`);
      }
    expect(bad).toEqual([]);
  });

  it("never touches PLATFORM_DB, a Workflow binding or PROVISIONER", () => {
    const re = /\b(PLATFORM_DB|PROVISION_INSTALL|MANAGE_INSTALL|PROVISIONER)\b/;
    expect(
      mcp.filter((f) => re.test(readFileSync(f, "utf8"))).map(rel),
    ).toEqual([]);
  });

  it("holds no POLICY table (one authz table, authz.ts)", () => {
    const re = /\b[A-Z_]*POLICY[A-Z_]*\s*[:=]/;
    expect(
      mcp.filter((f) => re.test(readFileSync(f, "utf8"))).map(rel),
    ).toEqual([]);
  });

  it("the rule catches a forbidden import", () => {
    const f = join(app, "src/mcp/x.ts");
    const target = rel(resolve(dirname(f), "../routes/world.js")).replace(
      /\.js$/,
      ".ts",
    );
    expect(allowed(target)).toBe(false);
    expect(allowed("src/routes/invoke.ts")).toBe(true);
  });
});

describe("layout (9A.4)", () => {
  it("has src/mcp, src/auth/oauth and src/routes/world.ts", () => {
    const r = src.map(rel);
    expect(r).toContain("src/mcp/index.ts");
    expect(r).toContain("src/auth/oauth/index.ts");
    expect(r).toContain("src/routes/world.ts");
    expect(r).toContain("src/routes/invoke.ts");
  });
});
