import type {
  AccessLevel,
  CapReason,
  Member,
  Role,
  SpaceRole,
  Visibility,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  can,
  type DecisionInput,
  decide,
  type OrgAction,
  orgCan,
} from "../src/auth/policy.js";

// The full cross product of decide() inputs against the invariants the plan
// promises (adapted from the #365 security review harness). Any violation
// names the input that broke it.

const callers: DecisionInput["caller"][] = [
  null,
  ...(["owner", "admin", "member", "guest"] as Role[]).map((orgRole) => ({
    id: "me",
    orgRole,
  })),
];
const caps: (CapReason | null)[] = [null, "guest", "restricted"];
const vis: Visibility[] = ["private", "team", "public"];
const roles: (SpaceRole | null)[] = [null, "viewer", "editor", "manager"];
const shares: ("viewer" | "editor" | null)[] = [null, "viewer", "editor"];

function* inputs(): Generator<DecisionInput> {
  for (const caller of callers)
    for (const cap of caps)
      for (const spaceKind of ["personal", "shared"] as const)
        for (const spaceId of ["me", "other"])
          for (const visibility of vis)
            for (const deleted of [false, true])
              for (const allowDeleted of [false, true])
                for (const publicLinks of [false, true])
                  for (const allMembersRole of roles)
                    for (const spaceRole of roles)
                      for (const shareRole of shares) {
                        if (!caller && cap) continue;
                        yield {
                          caller,
                          cap,
                          artifact: { spaceId, spaceKind, visibility, deleted },
                          space: { publicLinks, allMembersRole },
                          spaceRole,
                          shareRole,
                          allowDeleted,
                        };
                      }
}

function violations(i: DecisionInput, l: AccessLevel | null): string[] {
  const out: string[] = [];
  const { caller, cap } = i;
  const { spaceKind, spaceId, visibility, deleted } = i.artifact;
  const personal = spaceKind === "personal";
  const own = personal && caller !== null && spaceId === "me";
  const member = caller !== null && caller.orgRole !== "guest";
  const ctx = { cap, personal };
  if (cap && l && l !== "viewer") out.push("cap above viewer");
  if (!caller && l && !(visibility === "public" && !deleted))
    out.push("anonymous beyond a public link");
  if (personal && !own && !i.shareRole && visibility === "private" && l)
    out.push("personal leak");
  if (
    cap &&
    l &&
    !i.spaceRole &&
    !i.shareRole &&
    !own &&
    visibility !== "public"
  )
    out.push("capped through team or all-members");
  // Public links off only refuses new public links (decided): it never
  // changes anyone's level on an existing artifact.
  if (
    decide({
      ...i,
      space: { ...i.space, publicLinks: !i.space.publicLinks },
    }) !== l
  )
    out.push("publicLinks changed a level");
  if (deleted && l && (!i.allowDeleted || cap))
    out.push("deleted without trash rights");
  if (
    deleted &&
    l &&
    !own &&
    !(
      !personal &&
      (i.spaceRole === "manager" ||
        (i.space.allMembersRole === "manager" && member && !cap) ||
        // Org owners and admins restore a shared space's trash (item 9).
        (caller !== null &&
          (caller.orgRole === "owner" || caller.orgRole === "admin") &&
          !cap))
    )
  )
    out.push("deleted to a non-manager");
  if (l && cap && can(l, "data.write", ctx)) out.push("capped data write");
  if (l === "editor" && can(l, "visibility", ctx)) out.push("editor widens");
  if (l && !personal && can(l, "transfer", ctx)) out.push("shared transfer");
  if (l === "manager" && can(l, "transfer", { ...ctx, personal: true }))
    out.push("manager transfer");
  if (
    caller?.orgRole === "guest" &&
    !i.spaceRole &&
    !i.shareRole &&
    !own &&
    l &&
    visibility !== "public"
  )
    out.push("guest through team or all-members");
  return out;
}

describe("decide invariants (full cross product)", () => {
  it("no over-grant anywhere", () => {
    let n = 0;
    const bad: string[] = [];
    for (const i of inputs()) {
      n++;
      const l = decide(i);
      for (const v of violations(i, l))
        if (bad.length < 20) bad.push(`${v}: ${JSON.stringify(i)} => ${l}`);
    }
    expect(n).toBeGreaterThan(50_000);
    expect(bad).toEqual([]);
  });

  it("named cases", () => {
    const base: DecisionInput = {
      caller: { id: "me", orgRole: "member" },
      cap: null,
      artifact: {
        spaceId: "s",
        spaceKind: "shared",
        visibility: "private",
        deleted: false,
      },
      space: { publicLinks: true, allMembersRole: null },
      spaceRole: null,
      shareRole: null,
      allowDeleted: false,
    };
    const team = { ...base.artifact, visibility: "team" as const };
    // anonymous on team
    expect(decide({ ...base, caller: null, artifact: team })).toBeNull();
    // capped on public: viewer only
    expect(
      decide({
        ...base,
        cap: "restricted",
        artifact: { ...base.artifact, visibility: "public" },
      }),
    ).toBe("viewer");
    // uncapped guest (guestsReadOnly off) never gets allMembersRole
    expect(
      decide({
        ...base,
        caller: { id: "me", orgRole: "guest" },
        space: { publicLinks: true, allMembersRole: "editor" },
      }),
    ).toBeNull();
    // deleted with a share: nothing, even with allowDeleted
    expect(
      decide({
        ...base,
        artifact: { ...base.artifact, deleted: true },
        shareRole: "editor",
        allowDeleted: true,
      }),
    ).toBeNull();
    // capped manager with allowDeleted: nothing (no trash for capped callers)
    expect(
      decide({
        ...base,
        cap: "restricted",
        spaceRole: "manager",
        artifact: { ...base.artifact, deleted: true },
        allowDeleted: true,
      }),
    ).toBeNull();
  });

  it("malformed inputs fail closed", () => {
    const base: DecisionInput = {
      caller: { id: "me", orgRole: "member" },
      cap: null,
      artifact: {
        spaceId: "me",
        spaceKind: "shared",
        visibility: "team",
        deleted: false,
      },
      space: { publicLinks: true, allMembersRole: null },
      spaceRole: null,
      shareRole: null,
      allowDeleted: false,
    };
    const bad = <T>(v: unknown) => v as T;
    expect(
      decide({
        ...base,
        caller: { id: "me", orgRole: bad<Role>("superuser") },
      }),
    ).toBeNull();
    expect(
      decide({
        ...base,
        artifact: { ...base.artifact, spaceId: "s", spaceKind: bad("weird") },
        spaceRole: "manager",
      }),
    ).toBe("viewer"); // treated as personal: no space role, team viewer only
    expect(
      decide({
        ...base,
        artifact: {
          ...base.artifact,
          visibility: "private",
          deleted: bad(undefined),
        },
        spaceRole: "manager",
      }),
    ).toBeNull(); // unknown deleted = deleted: only trash rights reach it
    expect(
      decide({
        ...base,
        cap: bad(""),
        artifact: { ...base.artifact, visibility: "private" },
        spaceRole: "editor",
      }),
    ).toBe("viewer");
    expect(
      decide({
        ...base,
        artifact: { ...base.artifact, visibility: "private" },
        spaceRole: bad("admin"),
      }),
    ).toBeNull();
    expect(
      decide({
        ...base,
        artifact: { ...base.artifact, visibility: "private" },
        shareRole: bad("owner"),
      }),
    ).toBeNull();
  });
});

describe("orgCan with a cap", () => {
  const m = (role: Role): Member => ({
    id: "u",
    email: "u@x.com",
    name: null,
    role,
    lastSeenAt: null,
  });
  const SPACE: OrgAction[] = [
    "space.members",
    "space.rename",
    "space.publicLinks",
    "space.publish",
  ];
  it.each(SPACE)("a capped space manager can't %s", (action) => {
    for (const cap of ["guest", "restricted"] as const) {
      expect(orgCan(m("member"), action, { spaceRole: "manager", cap })).toBe(
        false,
      );
      expect(orgCan(m("guest"), action, { spaceRole: "manager", cap })).toBe(
        false,
      );
    }
  });
  const ALL: OrgAction[] = [
    "space.create",
    "space.delete",
    "space.mappings",
    "space.allMembers",
    "space.members",
    "space.rename",
    "space.publicLinks",
    "space.adminSelfAdd",
    "space.publish",
    "restricted.groups",
    "restricted.member",
    "artifact.create",
    "transfer.departed",
    "directory.manage",
    "directory.disconnect",
    "broker.check",
    "signin.problems",
    "audit.read",
    "members.manage",
    "members.manageAdmins",
    "settings.manage",
    "usage.read",
    "tokens.create",
    "mcp.connect",
  ];
  it.each(ALL)(
    "a restricted owner or admin loses %s (belt and braces)",
    (action) => {
      for (const role of ["owner", "admin"] as Role[])
        expect(
          orgCan(m(role), action, { spaceRole: "manager", cap: "restricted" }),
        ).toBe(false);
    },
  );
});
