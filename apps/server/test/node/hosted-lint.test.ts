import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// HOSTED=1 may only add a fail-closed requirement or report itself; it never
// enables a feature or loosens a check (P2/P3 Global Constraints). Every read
// of `HOSTED` in src is listed here with why it is one of the two, so a new
// read has to be justified.

const SRC = join(import.meta.dirname, "../../src");

/** `file: enclosing function` → why this read only tightens or reports. */
const READS: Record<string, string> = {
  "auth/sign-in.ts: showsSignInFields":
    "reports: Me carries the hosted sign-in fields (shape only, no access)",
  "auth/config.ts: domainJoin":
    "fail closed: hosted installs admit by invite only, never by domain",
  "auth/config.ts: googleConfig":
    "fail closed: hosted Google sign-in requires the broker transport",
  "routes/codes.ts: (anonymous)":
    "fail closed: hosted code sign-in requires Turnstile",
  "routes/me.ts: toMe": "reports: Me.instance.hosted",
  "directory/transport.ts: resolve":
    "fail closed: hosted directory sync requires the broker; direct vars or no broker resolve to none",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".generated.ts")
      ? [p]
      : [];
  });
}

/** The nearest named function, method or variable around `n`. */
function enclosing(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name)
      return p.name.getText();
    if (
      ts.isVariableDeclaration(p) &&
      p.initializer &&
      (ts.isArrowFunction(p.initializer) ||
        ts.isFunctionExpression(p.initializer))
    )
      return p.name.getText();
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const v = p.parent;
      if (!(ts.isVariableDeclaration(v) && v.initializer === p))
        return "(anonymous)";
    }
  }
  return "(module)";
}

/** Every HOSTED identifier or string in `root`, as "file: enclosing function". */
function hostedReads(root: string): string[] {
  const out: string[] = [];
  for (const file of files(root)) {
    const rel = relative(root, file);
    if (rel === "env.ts") continue; // the declaration, not a read
    const src = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    // Any identifier or string literal spelled HOSTED counts, so a property
    // read, a destructured binding ({ HOSTED }) and a key held in a variable
    // (const k = "HOSTED"; env[k]) are all caught.
    const visit = (n: ts.Node) => {
      if (
        (ts.isIdentifier(n) && n.text === "HOSTED") ||
        ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
          n.text === "HOSTED")
      )
        out.push(`${rel}: ${enclosing(n)}`);
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return [...new Set(out)].sort();
}

describe("HOSTED lint", () => {
  it("every HOSTED read in src is listed with a reason", () => {
    expect(hostedReads(SRC)).toEqual(Object.keys(READS).sort());
  });

  it("every listed read still exists (no stale entries)", () => {
    const found = new Set(hostedReads(SRC));
    for (const k of Object.keys(READS)) expect(found.has(k), k).toBe(true);
  });

  it("the scan catches property, element, destructured and variable-key reads", () => {
    const dir = join(import.meta.dirname, "fixtures/hosted");
    expect(hostedReads(dir)).toEqual([
      "probe.ts: (anonymous)",
      "probe.ts: (module)",
      "probe.ts: destructuredLocal",
      "probe.ts: destructuredParam",
      "probe.ts: elementRead",
      "probe.ts: propertyRead",
      // variableKey reads through KEY: the "HOSTED" string is caught where it
      // is written, the module-level const (module), so the read can't hide.
    ]);
  });
});
