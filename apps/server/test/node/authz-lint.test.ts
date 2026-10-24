import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// P3 T5: access is decided in src/auth/ only. Outside it: no comparison,
// switch or includes on a `.role`, `.ownerId` or `.level`; no TEAM_ROLES or
// isTeamRole; no requireAccess (use authorize(action) and can(); single
// transfer, when it lands, joins ALLOWED); no literal { kind: "user", user }
// Caller (use callerOf, which carries the cap).

const SRC = join(import.meta.dirname, "../../src");

/**
 * Target-row rules, not caller checks: "the owner cannot be demoted/removed",
 * and "a share written at viewer" (a downgrade closes the artifact's sockets).
 */
const ALLOWED: readonly string[] = [
  'services/members.ts: row.role === "owner"',
  'services/shares.ts: s.role === "viewer"',
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".generated.ts")
      ? [p]
      : [];
  });
}

function findAdHocChecks(root: string): string[] {
  const out: string[] = [];
  for (const file of files(root)) {
    const rel = relative(root, file);
    if (rel.startsWith("auth/")) continue;
    const src = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const report = (n: ts.Node) => {
      const hit = `${rel}: ${n.getText(src)}`;
      if (!ALLOWED.includes(hit)) out.push(hit);
    };
    const prop = (n: ts.Node, name: string) =>
      ts.isPropertyAccessExpression(n) && n.name.text === name;
    const guarded = (n: ts.Node) =>
      prop(n, "role") || prop(n, "ownerId") || prop(n, "level");
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        const cmp =
          k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          k === ts.SyntaxKind.EqualsEqualsToken ||
          k === ts.SyntaxKind.ExclamationEqualsToken;
        if (cmp && [n.left, n.right].some(guarded)) report(n);
      }
      // switch (x.role), ROLES.includes(x.role)
      if (ts.isSwitchStatement(n) && guarded(n.expression))
        report(n.expression);
      if (
        ts.isCallExpression(n) &&
        prop(n.expression, "includes") &&
        n.arguments.some(guarded)
      )
        report(n);
      if (
        ts.isIdentifier(n) &&
        (n.text === "TEAM_ROLES" || n.text === "isTeamRole")
      )
        report(n);
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "requireAccess"
      )
        report(n);
      // Callers are built by callerOf(), never a literal { kind: "user", user }.
      if (ts.isObjectLiteralExpression(n)) {
        const names = n.properties.map((p) =>
          p.name && ts.isIdentifier(p.name) ? p.name.text : "",
        );
        const kindUser = n.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "kind" &&
            ts.isStringLiteral(p.initializer) &&
            p.initializer.text === "user",
        );
        if (kindUser && names.includes("user")) report(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

describe("authz lint", () => {
  it("no ad-hoc role, ownerId or owner-level checks outside src/auth", () => {
    expect(findAdHocChecks(SRC)).toEqual([]);
  });
  it("the scan catches each pattern", () => {
    const dir = join(import.meta.dirname, "fixtures");
    const hits = findAdHocChecks(dir);
    for (const h of [
      'bad.ts: user.role === "admin"',
      "bad.ts: a.ownerId !== me",
      "bad.ts: TEAM_ROLES",
      'bad.ts: requireAccess(env, c, id, "owner")',
      'bad.ts: r.level !== "viewer"',
      "bad.ts: user.role",
      "bad.ts: ROLES.includes(user.role)",
      "bad.ts: isTeamRole",
      'bad.ts: { kind: "user", user }',
    ])
      expect(hits).toContain(h);
  });
});
