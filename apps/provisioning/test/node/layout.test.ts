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

/**
 * Every import in `text`: `{ spec, typeOnly }`. Static `import`/`export ...
 * from` (type-only only when the whole clause is), side-effect imports,
 * `import("x")` and `require("x")`. A dynamic import of anything but a string
 * literal is `spec: null`, always refused.
 */
function importsOf(text: string) {
  const out: { spec: string | null; typeOnly: boolean }[] = [];
  const staticRe =
    /\b(?:import|export)\s+([^'";]*?)\s*\bfrom\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(staticRe))
    out.push({
      spec: m[2] as string,
      typeOnly: typeOnlyClause(m[1] as string),
    });
  for (const m of text.matchAll(/\bimport\s*["']([^"']+)["']/g))
    out.push({ spec: m[1] as string, typeOnly: false });
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*([^)]*)\)/g)) {
    const lit = /^["']([^"']+)["']$/.exec((m[1] as string).trim());
    out.push({ spec: lit ? (lit[1] as string) : null, typeOnly: false });
  }
  return out;
}
/** `type X`, `type { X }`, or `{ type X, type Y }`; `x, { type Y }` is not. */
function typeOnlyClause(clause: string) {
  const c = clause.trim();
  if (/^type\b/.test(c)) return true;
  const braces = /^\{([^}]*)\}$/.exec(c);
  if (!braces) return false;
  const names = (braces[1] as string)
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}
const imports = (file: string) => importsOf(readFileSync(file, "utf8"));

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
        if (spec === null) bad.push(`${rel(f)} -> dynamic import`);
        else if (spec.startsWith(".")) {
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

  it("the scanner sees every import form", () => {
    const got = importsOf(`
      import { invokeRoute } from "../routes/invoke.js";
      import type { Env } from "../env.js";
      import { type A, type B } from "../a.js";
      import x, { type Y } from "../services/x.js";
      import { type C, D } from "../services/d.js";
      export { e } from "../services/e.js";
      import "../services/side.js";
      const t = await import('../services/tokens.js');
      const r = require("../services/r.js");
      const v = await import(name);
    `);
    expect(got).toEqual([
      { spec: "../routes/invoke.js", typeOnly: false },
      { spec: "../env.js", typeOnly: true },
      { spec: "../a.js", typeOnly: true },
      { spec: "../services/x.js", typeOnly: false },
      { spec: "../services/d.js", typeOnly: false },
      { spec: "../services/e.js", typeOnly: false },
      { spec: "../services/side.js", typeOnly: false },
      { spec: "../services/tokens.js", typeOnly: false },
      { spec: "../services/r.js", typeOnly: false },
      { spec: null, typeOnly: false },
    ]);
  });
});

describe("only mintAgentToken inserts into agent_tokens (9A.4)", () => {
  const re = /\binsert\s+(?:or\s+\w+\s+)?into\s+["`]?agent_tokens\b/i;

  it("no other src module has an INSERT INTO agent_tokens", () => {
    expect(
      src
        .filter((f) => re.test(readFileSync(f, "utf8")))
        .map(rel)
        .filter((r) => r !== "src/services/tokens.ts"),
    ).toEqual([]);
  });

  it("the rule catches the forms SQL allows", () => {
    for (const sql of [
      "INSERT INTO agent_tokens (id) VALUES (?)",
      "insert or replace into agent_tokens",
      'INSERT INTO "agent_tokens"',
    ])
      expect(re.test(sql), sql).toBe(true);
    expect(re.test("SELECT * FROM agent_tokens")).toBe(false);
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

describe("the API never writes provision's tables (W4 static SQL test)", () => {
  // installs and hosts belong to provision, hosted_audit to its auditAs,
  // release_floor to the release gate and platform_state to the scheduler.
  const re =
    /\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update|delete\s+from)\s+["`]?(installs|hosts|hosted_audit|release_floor|platform_state)\b/i;

  it("no src module writes installs, hosts, hosted_audit, release_floor or platform_state", () => {
    expect(src.length).toBeGreaterThan(10);
    const hits = src.flatMap((f) => {
      const m = re.exec(readFileSync(f, "utf8"));
      return m ? [`${rel(f)}: ${m[0]}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it("the rule catches every write form and lets reads through", () => {
    for (const sql of [
      "INSERT INTO installs (id) VALUES (?)",
      "insert or ignore into hosts",
      "REPLACE INTO platform_state",
      'UPDATE "installs" SET state = ?',
      "DELETE FROM hosted_audit",
      "update release_floor set floor_seq = 1",
    ])
      expect(re.test(sql), sql).toBe(true);
    for (const sql of [
      "SELECT * FROM installs",
      "LEFT JOIN hosts h",
      "SELECT value FROM platform_state",
      "UPDATE install_lifecycle SET x = 1",
      "INSERT INTO jobs",
    ])
      expect(re.test(sql), sql).toBe(false);
  });
});
