import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
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
  // Removes the user: every socket they hold closes through setUserStatus
  // (spaces on) or deleteMember (off), both "user" below; its own guard is
  // the belt-and-braces close of the artifacts shared with them.
  "services/members.ts:removeMember": "artifact",
  // The spaces-off removal: the row is deleted, and the shares addressed to
  // their email go in the same batch (a leftover share re-admitted them).
  "services/members.ts:deleteMember": "user",
  // Suspend or remove (P3 T6): PATs, grants and sessions revoked; a removal
  // also drops the shares addressed to their email in the same batch.
  "services/members.ts:setUserStatus": "user",
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
  // P3 T9 spaces API. A member's manual row lowered, a frozen override or a
  // self-add below the current role: that user.
  "services/spaces.ts:putSpaceMember": "user",
  "services/spaces.ts:deleteSpaceMember": "user",
  "services/spaces.ts:selfAddSpace": "user",
  // A per-space or Every-space mapping lowered or removed: the group's
  // members (revokeUsersLive, pages of 50).
  "services/spaces.ts:putSpaceMapping": "user",
  "services/spaces.ts:deleteSpaceMapping": "user",
  "services/spaces.ts:putOrgMapping": "user",
  "services/spaces.ts:deleteOrgMapping": "user",
  // allMembersRole lowered or removed: every member it reached.
  "services/spaces.ts:patchSpace": "user",
  // Restricted flag or group set: the user, or the group's members.
  "services/spaces.ts:setMemberRestricted": "user",
  "services/spaces.ts:putRestrictedGroup": "user",
  // P3 T10. A move: the source space's members, and public viewers when it
  // becomes team, lose this one artifact.
  "services/spaces.ts:moveArtifact": "artifact",
  // A single transfer narrows the former owner to editor on this one
  // artifact: the artifact guard, not their sockets everywhere.
  "services/spaces.ts:transferArtifact": "artifact",
  // A departed transfer narrows the (inactive) former owner on up to a page
  // of artifacts: their presence again, plus the artifacts made team.
  "services/spaces.ts:transferPersonal": "user",
  // P3 T13/T14 DirectorySync: a synced group's diff removes members (their
  // Every-space and mapped roles are read through directory_members), drops
  // or lowers synced space roles and caps the newly restricted: the
  // narrowed and capped users.
  "directory/apply.ts:applyChunk": "user",
  // P3 T14: a directory deletion (or a recycled address): removed, its
  // address's shares and every membership gone.
  "directory/apply.ts:deleteUser": "user",
  // P3 T15: sync back after a freeze undoes frozen edits (a manager
  // override lowered, a restore below the override): the users whose role
  // dropped.
  "directory/thaw.ts:thawFrozenEdits": "user",
  // P3 T18: entering customer_mismatch denies every synced user (getUser and
  // the content load): their sockets close.
  "directory/sync.ts:SyncEngine.mismatch": "user",
  // P2.5 #16: a confirm that swaps in another Workspace suspends and
  // unbinds the previous one's users (sessions, PATs and grants end).
  "directory/binding.ts:retireTenant": "user",
  // P2.5 #5: the reconcile's full restricted_sync recompute caps whoever a
  // restricted group now holds.
  "directory/sync.ts:SyncEngine.recomputeRestricted": "user",
  // P3 T17 (test builds only): the session hook may lower the user's manual
  // space row.
  "test-hooks/index.ts:grantSpaces": "user",
};

/**
 * Units that match a marker but only ever widen access, so no socket needs
 * to close. Each entry says why; a stale entry fails the test below.
 */
const WIDENS: Readonly<Record<string, string>> = {
  // Sign-in: the role is computed in SQL from the row's current role (guest
  // becomes member, every other role kept), or owner for OWNER_EMAIL while
  // no owner exists. It never writes back an earlier read, so it can't undo
  // a racing demotion.
  "services/identity.ts:touch": "sign-in promotion from the current role only",
  // Access sign-in: .set(set) holds only lastSeenAt and name.
  "services/users.ts:upsertOnLogin": "sign-in touch: last_seen_at and name",
  // Removing a restricted group only lifts caps (restricted_sync recomputed
  // from the groups that remain).
  "services/spaces.ts:deleteRestrictedGroup": "lifts a restriction only",
  // P3 T14: every address change (sign-in drift, sync) re-keys the person's shares to it (the
  // higher role on a conflict): their access stays or widens.
  "services/email-move.ts:moveUserEmail": "shares follow the person, max role",
  // P2.5 #17: the reconcile drops directory_members rows of groups that are
  // no longer targets; no mapping or restriction reads them.
  "directory/sync.ts:SyncEngine.targets": "rows nothing reads for access",
  // P2.5 #17: a deleted space's groups that nothing else targets lose their
  // directory_members rows (its own rows and mappings go by cascade).
  "services/spaces.ts:deleteSpace": "rows nothing reads for access",
  // P3 T10: the transfer successor predicate reads restricted_* (no write).
  "services/spaces.ts:SUCCESSOR": "a read: the successor predicate",
};

/** Exempt from the scan: the primitives themselves. */
const SKIP_FILES = new Set(["runtime/revoke.ts", "mcp/oauth-api.ts"]);

/**
 * #681: a dataWriters write ("editors" cuts every viewer's data writes),
 * SQL or a [column, value] pair.
 */
const DATA_WRITERS_WRITE =
  /\bdata_writers\s*=\s*\?|"data_writers",|\.set\(\{[^}]*\bdataWriters\b/;

/** Access-shrinking markers in a unit's code. */
const SHRINK: readonly RegExp[] = [
  /\brevokeAllGrants\(/,
  /\bcloseRuntimeSockets\(/,
  /session_epoch \+ 1|sessionEpoch\} \+ 1/,
  /\.delete\((shares|identities)\)/,
  /delete from (shares|identities)\b/i,
  /status = 'removed'|status = 'suspended'|\bDEACTIVATE_GUEST\b/,
  // Status and role writes, SQL or drizzle (the value may be bound). A
  // bare `\bstatus\s*[:=]` flags every HTTP status, so these are scoped to
  // an SQL SET list (any earlier assignment, never past its WHERE or
  // RETURNING) or a drizzle .set({ ... }), shorthand included.
  /\bset\s(?:(?!\bwhere\b|\breturning\b)[^;]){0,400}?\b(status|role)\s*=[^=]/i,
  /\.set\(\{[^}]*\b(status|role)\b/,
  // A users or tokens update from a variable object (.set(patch)): the
  // fields aren't visible, so it counts.
  /\.update\((users|tokens)\)\s*\.set\((?!\s*\{)/,
  // Token revocation, SQL or drizzle.
  /update tokens set revoked_at/i,
  /\.delete\(tokens\)/,
  // Visibility writes (a narrowing cuts team or public viewers).
  /\.set\(\{[^}]*\bvisibility\s*:/,
  /\bset[^;`]*\bvisibility = \?|"visibility = \?"/i,
  // Space membership and group mapping removals.
  /\.delete\((spaceMembers|groupMappings|orgGroupMappings)\)/,
  /delete from (space_members|group_mappings|org_group_mappings)\b/i,
  // P3 T13: a synced group's membership rows (roles are read through them).
  /delete from directory_members\b|\bREMOVE_MEMBERS\b/i,
  // P3 T9: allMembersRole and the restriction caps (manual flag, group).
  /\ball_members_role\s*=[^=]|\.set\(\{[^}]*\ballMembersRole\b/,
  /\brestricted_(manual|sync)\s*=[^=]|\.set\(\{[^}]*\brestricted(Manual|Sync)\b/,
  /\binto restricted_groups\b/i,
  // P3 T18: the customer_mismatch state denies every synced user.
  /\bstate: "customer_mismatch"/,
  DATA_WRITERS_WRITE,
];
const CALLS: Record<Guard, RegExp> = {
  // revokeUsersLive: revokeUserLive for many users (a group, every member).
  user: /\brevokeUsers?Live\(/,
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

const stringish = (e: ts.Expression): boolean =>
  ts.isStringLiteral(e) ||
  ts.isNoSubstitutionTemplateLiteral(e) ||
  ts.isTemplateExpression(e);

/** `x as const` / `x satisfies T` → x. */
const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
    ? unwrap(e.expression)
    : e;

/**
 * Module-level string constants and the string properties of module-level
 * object literals (SQL kept outside the function): name → text.
 */
function moduleConsts(src: ts.SourceFile): Map<string, string> {
  const consts = new Map<string, string>();
  for (const st of src.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrap(d.initializer);
      if (stringish(init)) consts.set(d.name.text, init.getText(src));
      else if (ts.isObjectLiteralExpression(init)) {
        const props = init.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => unwrap(p.initializer))
          .filter(stringish)
          .map((e) => e.getText(src));
        if (props.length) consts.set(d.name.text, props.join("\n"));
      }
    }
  }
  return consts;
}

/** Named imports from other scanned files: local name → that file's constant. */
function importedConsts(
  rel: string,
  src: ts.SourceFile,
  all: ReadonlyMap<string, Map<string, string>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of src.statements) {
    if (
      !ts.isImportDeclaration(st) ||
      !ts.isStringLiteral(st.moduleSpecifier) ||
      !st.moduleSpecifier.text.startsWith(".")
    )
      continue;
    const target = posix
      .normalize(posix.join(posix.dirname(rel), st.moduleSpecifier.text))
      .replace(/\.js$/, ".ts");
    const consts = all.get(target);
    const named = st.importClause?.namedBindings;
    if (!consts || !named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const v = consts.get((el.propertyName ?? el.name).text);
      if (v !== undefined) out.set(el.name.text, v);
    }
  }
  return out;
}

/**
 * "rel:name" → each unit's code with comments stripped, plus the text of
 * every module-level or imported constant it names. `sources` maps
 * src-relative paths ("/"-separated) to file text.
 */
function scan(sources: ReadonlyMap<string, string>): Map<string, string> {
  const parsed = new Map(
    [...sources].map(([rel, text]) => [
      rel,
      ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true),
    ]),
  );
  const consts = new Map(
    [...parsed].map(([rel, src]) => [rel, moduleConsts(src)]),
  );
  const out = new Map<string, string>();
  for (const [rel, src] of parsed) {
    if (SKIP_FILES.has(rel)) continue;
    const known = new Map([
      ...importedConsts(rel, src, consts),
      ...(consts.get(rel) ?? []),
    ]);
    const withConsts = (code: string) => {
      const used = [...known].filter(([k]) =>
        new RegExp(`\\b${k}\\b`).test(code),
      );
      return [code, ...used.map(([, v]) => v)].join("\n");
    };
    const visit = (n: ts.Node): void => {
      if (isUnit(n) && n.body) {
        let key = `${rel}:${unitName(n, src)}`;
        while (out.has(key)) key += "'";
        out.set(
          key,
          withConsts(printer.printNode(ts.EmitHint.Unspecified, n, src)),
        );
        // A nested function belongs to this unit: its code is in the text.
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

/** One file's units (the self-tests). */
const unitsOf = (rel: string, text: string) => scan(new Map([[rel, text]]));

function units(root: string): Map<string, string> {
  return scan(
    new Map(
      files(root).map((f) => [
        relative(root, f).split(sep).join("/"),
        readFileSync(f, "utf8"),
      ]),
    ),
  );
}

/** Shrinking units with no registry entry, and registered units without their guard. */
function check(
  fns: Map<string, string>,
  registry: Readonly<Record<string, Guard>>,
) {
  const missing = [...fns]
    .filter(([, body]) => SHRINK.some((re) => re.test(body)))
    .map(([k]) => k)
    .filter((k) => !(k in registry) && !(k in WIDENS));
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

  it("every widening exemption still names a unit that matches a marker", () => {
    const stale = Object.keys(WIDENS).filter((k) => {
      const body = fns.get(k);
      return body === undefined || !SHRINK.some((re) => re.test(body));
    });
    expect(stale).toEqual([]);
  });

  // #681: switching dataWriters to "editors" shrinks access; both writers
  // of the column are registered with the artifact guard.
  it("registers every dataWriters write (patch, publish)", () => {
    const writers = [...fns]
      .filter(([, body]) => DATA_WRITERS_WRITE.test(body))
      .map(([k]) => k)
      .sort();
    expect(writers).toEqual([
      "services/artifacts.ts:patch",
      "services/artifacts.ts:publish",
    ]);
    for (const k of writers) expect(REGISTRY[k]).toBe("artifact");
    const src = `export async function f(env: Env) {
      await env.DB.prepare("update artifacts set data_writers = ? where id = ?").run();
    }`;
    expect(check(unitsOf("x.ts", src), {}).missing).toEqual(["x.ts:f"]);
  });

  // A removal's share drop (a leftover share re-admitted the address) is a
  // marker in both removal units, so each stays registered with its guard.
  it("both removals drop shares and are registered with the user guard", () => {
    const drop = /\.delete\(shares\)|delete from shares\b/i;
    for (const k of [
      "services/members.ts:setUserStatus",
      "services/members.ts:deleteMember",
    ]) {
      expect(fns.get(k)).toMatch(drop);
      expect(REGISTRY[k]).toBe("user");
    }
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

  it("SQL in a module-level constant counts toward the function using it", () => {
    const src = `
      const SUSPEND = "update users set status = ?2 where id = ?1";
      export async function quiet(env: Env, id: string) {
        await env.DB.prepare(SUSPEND).bind(id, "suspended").run();
      }`;
    expect(check(unitsOf("c.ts", src), {}).missing).toEqual(["c.ts:quiet"]);
  });

  it("drizzle status writes and token deletes count", () => {
    const src = `
      export async function drop(id: string) {
        await db.update(users).set({ status: "removed" }).where(eq(users.id, id));
      }
      export async function forget(id: string) {
        await db.delete(tokens).where(eq(tokens.userId, id));
      }
      export async function revokeAll(env: Env, id: string) {
        await env.DB.prepare("update tokens set revoked_at = ? where user_id = ?").bind(1, id).run();
      }`;
    expect(check(unitsOf("d.ts", src), {}).missing).toEqual([
      "d.ts:drop",
      "d.ts:forget",
      "d.ts:revokeAll",
    ]);
  });

  it("e5: a status write after a comma in an earlier SET expression counts", () => {
    const src = `
      export async function rename(env: Env) {
        await env.DB.prepare("update users set name = coalesce(?3, name), status = ?2 where id = ?1").run();
      }
      export async function promote(env: Env) {
        await env.DB.prepare("update users set name = coalesce(?3, name), role = 'admin' where id = ?1").run();
      }
      export async function touch(env: Env) {
        await env.DB.prepare("update users set last_seen_at = ? where status = 'active'").run();
      }`;
    expect(check(unitsOf("e5.ts", src), {}).missing).toEqual([
      "e5.ts:rename",
      "e5.ts:promote",
    ]);
  });

  it("e6: drizzle shorthand .set({ status }) and .set({ role }) count", () => {
    const src = `
      export async function a(status: string) { await db.update(users).set({ status }); }
      export async function b(role: string) { await db.update(users).set({ name, role }); }`;
    expect(check(unitsOf("e6.ts", src), {}).missing).toEqual([
      "e6.ts:a",
      "e6.ts:b",
    ]);
  });

  it("e7: a users or tokens update from a variable object counts", () => {
    const src = `
      export async function a(patch: object) { await db.update(users).set(patch); }
      export async function b(patch: object) { await db.update(tokens)
        .set(patch); }
      export async function c(patch: object) { await db.update(versions).set(patch); }`;
    expect(check(unitsOf("e7.ts", src), {}).missing).toEqual([
      "e7.ts:a",
      "e7.ts:b",
    ]);
  });

  it("e8: SQL in a module-level object or an imported constant counts", () => {
    const sql = `
      export const TOKENS_SQL = {
        revoke: "update tokens set revoked_at = ? where user_id = ?",
      } as const;
      export const SUSPEND = \`update users set status = 'suspended' where id = ?\`;`;
    const local = `
      const TOKENS_SQL = { revoke: "update tokens set revoked_at = ? where user_id = ?" };
      export async function viaObject(env: Env) {
        await env.DB.prepare(TOKENS_SQL.revoke).run();
      }`;
    const user = `
      import { SUSPEND as S, TOKENS_SQL } from "../db/sql.js";
      export async function viaImport(env: Env) { await env.DB.prepare(S).run(); }
      export async function viaImportedObject(env: Env) {
        await env.DB.prepare(TOKENS_SQL.revoke).run();
      }`;
    const fns = scan(
      new Map([
        ["db/sql.ts", sql],
        ["services/local.ts", local],
        ["services/user.ts", user],
      ]),
    );
    expect(check(fns, {}).missing).toEqual([
      "services/local.ts:viaObject",
      "services/user.ts:viaImport",
      "services/user.ts:viaImportedObject",
    ]);
  });

  it("T9: allMembersRole and restriction writes count; revokeUsersLive guards", () => {
    const src = `
      export async function lower(env: Env) {
        await env.DB.prepare("update spaces set all_members_role = ?2 where id = ?1").run();
      }
      export async function cap(env: Env) {
        await env.DB.prepare("update users set restricted_manual = 1 where id = ?").run();
      }
      export async function group(env: Env) {
        await env.DB.prepare("insert or ignore into restricted_groups (group_id) values (?)").run();
        await revokeUsersLive(env, ids, "restricted");
      }`;
    const fns = unitsOf("t9.ts", src);
    expect(check(fns, {}).missing).toEqual([
      "t9.ts:lower",
      "t9.ts:cap",
      "t9.ts:group",
    ]);
    expect(check(fns, { "t9.ts:group": "user" }).unguarded).toEqual([]);
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
