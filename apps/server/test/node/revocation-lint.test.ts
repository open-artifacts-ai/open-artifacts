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
// A function counts as access-shrinking when its body matches SHRINK below.
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
  // Visibility or capability narrowing affects every viewer of the artifact.
  "services/artifacts.ts:patch": "artifact",
  "services/artifacts.ts:publish": "artifact",
  "services/artifacts.ts:softDelete": "artifact",
};

/** Exempt from the scan: the primitives themselves. */
const SKIP_FILES = new Set(["runtime/revoke.ts", "mcp/oauth-api.ts"]);

/** Access-shrinking markers in a function body. */
const SHRINK: readonly RegExp[] = [
  /\brevokeAllGrants\(/,
  /\bcloseRuntimeSockets\(/,
  /session_epoch \+ 1|sessionEpoch\} \+ 1/,
  /\.delete\((shares|identities)\)/,
  /delete from (shares|identities)\b/i,
  /status = 'removed'|status = 'suspended'|\bDEACTIVATE_GUEST\b/,
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

/** Top-level functions (declarations and const arrows): "file:name" → body text. */
function functions(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files(root)) {
    const rel = relative(root, file);
    if (SKIP_FILES.has(rel)) continue;
    const src = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const st of src.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body)
        out.set(`${rel}:${st.name.text}`, st.body.getText(src));
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (
            ts.isIdentifier(d.name) &&
            d.initializer &&
            (ts.isArrowFunction(d.initializer) ||
              ts.isFunctionExpression(d.initializer))
          )
            out.set(`${rel}:${d.name.text}`, d.initializer.getText(src));
    }
  }
  return out;
}

describe("revocation lint (P3 T7)", () => {
  const fns = functions(SRC);

  it("every access-shrinking function is registered with a guard", () => {
    const missing = [...fns]
      .filter(([, body]) => SHRINK.some((re) => re.test(body)))
      .map(([k]) => k)
      .filter((k) => !(k in REGISTRY));
    expect(missing).toEqual([]);
  });

  it("every registered function calls its guard", () => {
    const bad = Object.entries(REGISTRY).filter(([k, g]) => {
      const body = fns.get(k);
      return body === undefined || !CALLS[g].test(body);
    });
    expect(bad).toEqual([]);
  });

  it("finds a shrinking function that skips the guard (self-test)", () => {
    const body = "{ await revokeAllGrants(env, id); }";
    expect(SHRINK.some((re) => re.test(body))).toBe(true);
    expect(CALLS.user.test(body)).toBe(false);
  });
});
