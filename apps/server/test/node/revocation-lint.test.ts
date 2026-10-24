import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// P3 T7: every function that shrinks someone's access must also close the
// live sockets that access opened, through a revokedAt guard:
// - "user": the function calls revokeUserLive (UserPresence: every socket the
//   user holds, on every artifact; accepts authorized before revokedAt are
//   refused).
// - "artifact": the change is one artifact's, for possibly many actors; the
//   function calls closeRuntimeSockets, which records the change time in that
//   artifact's DO (accepts authorized before it are refused) and closes every
//   socket on it. Revoking each affected user would close their sockets on
//   unrelated artifacts too.
// A unit counts as access-shrinking when its code (comments stripped)
// matches SHRINK below. Units are the outermost functions wherever they sit
// (top level, inside blocks, object literals or call arguments) and each
// class method; a nested function counts toward the unit that contains it.
// A new one fails this test until it is listed here with its guard.

const SRC = join(import.meta.dirname, "../../src");

type Guard = "user" | "artifact";
const REGISTRY: Readonly<Record<string, Guard>> = {
  // Removes the user: every socket they hold closes.
  "services/members.ts:removeMember": "user",
  // A role change ends their sessions; sockets were authorized under the old role.
  "services/members.ts:patchMember": "user",
  // A guest's last share went: the guest is deactivated.
  "services/shares.ts:removeGuestIfUnshared": "user",
  // owner_only identity reset: sessions, PATs and grants revoked.
  "services/identity.ts:resetIdentity": "user",
  // One share on one artifact: the artifact guard covers the race precisely;
  // the guest case is removeGuestIfUnshared above.
  "services/shares.ts:deleteShare": "artifact",
  // A share's role write: a downgrade to viewer closes the artifact's sockets.
  "services/shares.ts:putShare": "artifact",
  // Visibility or capability narrowing affects every viewer of the artifact.
  "services/artifacts.ts:patch": "artifact",
  "services/artifacts.ts:publish": "artifact",
  "services/artifacts.ts:softDelete": "artifact",
};

/** Exempt from the scan: the primitives themselves. */
const SKIP_FILES = new Set(["runtime/revoke.ts", "mcp/oauth-api.ts"]);

/** Access-shrinking markers in a unit's code. */
const SHRINK: readonly RegExp[] = [
  /\brevokeAllGrants\(/,
  /\bcloseRuntimeSockets\(/,
  /session_epoch \+ 1|sessionEpoch\} \+ 1/,
  /\.delete\((shares|identities)\)/,
  /delete from (shares|identities)\b/i,
  /status = 'removed'|status = 'suspended'|\bDEACTIVATE_GUEST\b/,
  // Role writes (a demotion narrows every space and agent grant).
  /\.set\(\{[^}]*\brole\s*:/,
  /\bset role = /i,
  // Visibility writes (a narrowing cuts team or public viewers).
  /\.set\(\{[^}]*\bvisibility\s*:/,
  /\bset[^;`]*\bvisibility = \?|"visibility = \?"/i,
  // Space membership and group mapping removals.
  /\.delete\((spaceMembers|groupMappings|orgGroupMappings)\)/,
  /delete from (space_members|group_mappings|org_group_mappings)\b/i,
];
const CALLS: Record<Guard, RegExp> = {
  user: /\brevokeUserLive\(/,
  artifact: /\bcloseRuntimeSockets\(/,
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

const printer = ts.createPrinter({ removeComments: true });

const nameText = (n: ts.PropertyName | ts.BindingName | undefined) =>
  n &&
  (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n))
    ? n.text
    : undefined;

/** The unit's name: its declaration, variable, Class.method or obj.prop. */
function unitName(n: ts.Node, src: ts.SourceFile): string {
  const line = src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  if (
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n)
  ) {
    const method = ts.isConstructorDeclaration(n)
      ? "constructor"
      : (nameText(n.name) ?? `<method@${line}>`);
    const owner = n.parent;
    if (ts.isClassLike(owner))
      return `${owner.name?.text ?? "<class>"}.${method}`;
    const v = owner.parent;
    if (ts.isObjectLiteralExpression(owner) && v && ts.isVariableDeclaration(v))
      return `${nameText(v.name) ?? "<object>"}.${method}`;
    return method;
  }
  const p = n.parent;
  if (p && ts.isVariableDeclaration(p))
    return nameText(p.name) ?? `<fn@${line}>`;
  if (p && ts.isPropertyAssignment(p)) {
    const obj = p.parent.parent;
    const prop = nameText(p.name) ?? `<prop@${line}>`;
    return obj && ts.isVariableDeclaration(obj)
      ? `${nameText(obj.name) ?? "<object>"}.${prop}`
      : prop;
  }
  return `<fn@${line}>`;
}

const isUnit = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n) ||
  ts.isConstructorDeclaration(n);

/** "rel:name" → the unit's code with comments stripped. */
function unitsOf(rel: string, text: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node): void => {
    if (isUnit(n) && n.body) {
      let key = `${rel}:${unitName(n, src)}`;
      while (out.has(key)) key += "'";
      out.set(key, printer.printNode(ts.EmitHint.Unspecified, n, src));
      // A nested function belongs to this unit: its code is in the text.
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

function units(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files(root)) {
    const rel = relative(root, file);
    if (SKIP_FILES.has(rel)) continue;
    for (const [k, v] of unitsOf(rel, readFileSync(file, "utf8")))
      out.set(k, v);
  }
  return out;
}

/** Shrinking units with no registry entry, and registered units without their guard. */
function check(
  fns: Map<string, string>,
  registry: Readonly<Record<string, Guard>>,
) {
  const missing = [...fns]
    .filter(([, body]) => SHRINK.some((re) => re.test(body)))
    .map(([k]) => k)
    .filter((k) => !(k in registry));
  const unguarded = Object.entries(registry)
    .filter(([k, g]) => {
      const body = fns.get(k);
      return body === undefined || !CALLS[g].test(body);
    })
    .map(([k]) => k);
  return { missing, unguarded };
}

describe("revocation lint (P3 T7)", () => {
  const fns = units(SRC);

  it("every access-shrinking function is registered with a guard", () => {
    expect(check(fns, REGISTRY).missing).toEqual([]);
  });

  it("every registered function calls its guard", () => {
    expect(check(fns, REGISTRY).unguarded).toEqual([]);
  });

  it("finds a shrinking function that skips the guard (self-test)", () => {
    const body = "{ await revokeAllGrants(env, id); }";
    expect(SHRINK.some((re) => re.test(body))).toBe(true);
    expect(CALLS.user.test(body)).toBe(false);
  });

  it("a nested function that narrows visibility without the guard fails", () => {
    const src = `
      export async function outer(env: Env, id: string) {
        const narrow = async () => {
          await db.update(artifacts).set({ visibility: "private" }).where(eq(artifacts.id, id));
        };
        await narrow();
      }`;
    const fns = unitsOf("x.ts", src);
    expect(check(fns, {}).missing).toEqual(["x.ts:outer"]);
    expect(check(fns, { "x.ts:outer": "artifact" }).unguarded).toEqual([
      "x.ts:outer",
    ]);
  });

  it("scans class methods and object-literal methods", () => {
    const src = `
      class Sync { async apply() { await db.delete(spaceMembers).where(x); } }
      export const handler = { async run() { await env.DB.prepare("update users set role = ?").run(); } };`;
    expect(check(unitsOf("y.ts", src), {}).missing).toEqual([
      "y.ts:Sync.apply",
      "y.ts:handler.run",
    ]);
  });

  it("a guard named only in a comment does not count", () => {
    const src = `
      export async function sneaky(env: Env) {
        // revokeUserLive(env, id) is not called here
        await revokeAllGrants(env, id);
      }`;
    expect(
      check(unitsOf("z.ts", src), { "z.ts:sneaky": "user" }).unguarded,
    ).toEqual(["z.ts:sneaky"]);
  });
});
