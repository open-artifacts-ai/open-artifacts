import {
  type AccessLevel,
  ARTIFACT_ACTIONS,
  type ArtifactAction,
  artifactCan,
  type CapReason,
  type Member,
  type Role,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  type CanCtx,
  can,
  capOf,
  type DecisionInput,
  decide,
  namedEvents,
  type OrgAction,
  orgCan,
  type PolicyAction,
} from "../src/auth/policy.js";

// P3 plan, "Decision table": literal copies of its three tables.

const ME = "u_me";
const base: DecisionInput = {
  caller: { id: ME, orgRole: "member" },
  cap: null,
  artifact: {
    spaceId: "s_eng",
    spaceKind: "shared",
    visibility: "private",
    deleted: false,
  },
  space: { publicLinks: true, allMembersRole: null },
  spaceRole: null,
  shareRole: null,
  allowDeleted: false,
};
const personal = (
  spaceId: string,
  extra: Partial<DecisionInput["artifact"]> = {},
) => ({
  ...base.artifact,
  spaceId,
  spaceKind: "personal" as const,
  ...extra,
});
const with_ = (p: Partial<DecisionInput>): DecisionInput => ({ ...base, ...p });

describe("decide: decision table rows", () => {
  const rows: [string, DecisionInput, AccessLevel | null][] = [
    [
      "2 deleted own personal, allowDeleted",
      with_({ artifact: personal(ME, { deleted: true }), allowDeleted: true }),
      "owner",
    ],
    [
      "3 deleted shared, manager, allowDeleted",
      with_({
        artifact: { ...base.artifact, deleted: true },
        spaceRole: "manager",
        allowDeleted: true,
      }),
      "manager",
    ],
    [
      "4 deleted own personal without allowDeleted",
      with_({ artifact: personal(ME, { deleted: true }) }),
      null,
    ],
    [
      "4 deleted shared, editor, allowDeleted",
      with_({
        artifact: { ...base.artifact, deleted: true },
        spaceRole: "editor",
        allowDeleted: true,
      }),
      null,
    ],
    ["5 own personal", with_({ artifact: personal(ME) }), "owner"],
    ["6 shared manager", with_({ spaceRole: "manager" }), "manager"],
    ["7 shared editor role", with_({ spaceRole: "editor" }), "editor"],
    [
      "7 editor share beats viewer role",
      with_({ spaceRole: "viewer", shareRole: "editor" }),
      "editor",
    ],
    ["8 shared viewer role", with_({ spaceRole: "viewer" }), "viewer"],
    [
      "8 viewer share on someone's personal",
      with_({ artifact: personal("u_other"), shareRole: "viewer" }),
      "viewer",
    ],
    [
      "9 team visibility, member",
      with_({ artifact: { ...base.artifact, visibility: "team" } }),
      "viewer",
    ],
    [
      "9 team visibility, guest → none",
      with_({
        caller: { id: ME, orgRole: "guest" },
        artifact: { ...base.artifact, visibility: "team" },
      }),
      null,
    ],
    [
      "10 public personal, anonymous",
      with_({
        caller: null,
        artifact: personal("u_other", { visibility: "public" }),
      }),
      "viewer",
    ],
    [
      "10 public shared with public links",
      with_({
        caller: null,
        artifact: { ...base.artifact, visibility: "public" },
      }),
      "viewer",
    ],
    [
      // Public links off only refuses new public links (decided): an
      // artifact that is already public keeps its link.
      "10 public shared, public links off, anonymous → viewer",
      with_({
        caller: null,
        artifact: { ...base.artifact, visibility: "public" },
        space: { publicLinks: false, allMembersRole: null },
      }),
      "viewer",
    ],
    [
      "10 public shared, public links off, capped member → viewer",
      with_({
        cap: "restricted",
        artifact: { ...base.artifact, visibility: "public" },
        space: { publicLinks: false, allMembersRole: null },
      }),
      "viewer",
    ],
    [
      "11 org admin, no space role, shared private",
      with_({ caller: { id: ME, orgRole: "admin" } }),
      null,
    ],
    [
      "11 org owner on someone's personal private",
      with_({
        caller: { id: ME, orgRole: "owner" },
        artifact: personal("u_other"),
      }),
      null,
    ],
    [
      "allMembersRole applies to members",
      with_({ space: { publicLinks: true, allMembersRole: "editor" } }),
      "editor",
    ],
    [
      "allMembersRole never applies to guests",
      with_({
        caller: { id: ME, orgRole: "guest" },
        space: { publicLinks: true, allMembersRole: "editor" },
      }),
      null,
    ],
    [
      "allMembersRole never applies to restricted",
      with_({
        cap: "restricted",
        space: { publicLinks: true, allMembersRole: "editor" },
      }),
      null,
    ],
    [
      "space roles never apply to personal artifacts",
      with_({ artifact: personal("u_other"), spaceRole: "manager" }),
      null,
    ],
    [
      "anonymous ignores shares",
      with_({ caller: null, shareRole: "editor" }),
      null,
    ],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    expect(decide(input)).toBe(expected);
  });

  it("restricted member with allMembersRole editor and an editor share is viewer", () => {
    expect(
      decide(
        with_({
          cap: "restricted",
          shareRole: "editor",
          space: { publicLinks: true, allMembersRole: "editor" },
        }),
      ),
    ).toBe("viewer");
  });
  it("guest mapped manager is capped at viewer", () => {
    expect(
      decide(
        with_({
          caller: { id: ME, orgRole: "guest" },
          cap: "guest",
          spaceRole: "manager",
        }),
      ),
    ).toBe("viewer");
  });
  it("restricted owner of a personal artifact is capped at viewer", () => {
    expect(decide(with_({ cap: "restricted", artifact: personal(ME) }))).toBe(
      "viewer",
    );
  });
  it("restricted member: no team artifact outside their spaces", () => {
    const team = { ...base.artifact, visibility: "team" as const };
    expect(decide(with_({ cap: "restricted", artifact: team }))).toBeNull();
    expect(
      decide(
        with_({
          cap: "restricted",
          artifact: personal("u_other", { visibility: "team" }),
        }),
      ),
    ).toBeNull();
  });
  it("restricted member: viewer through their own space role or a share", () => {
    const team = { ...base.artifact, visibility: "team" as const };
    expect(
      decide(with_({ cap: "restricted", artifact: team, spaceRole: "editor" })),
    ).toBe("viewer");
    expect(
      decide(with_({ cap: "restricted", artifact: team, shareRole: "editor" })),
    ).toBe("viewer");
  });
  it("team keeps today's meaning in shared spaces: every uncapped member", () => {
    expect(
      decide(
        with_({
          caller: { id: ME, orgRole: "member" },
          artifact: { ...base.artifact, visibility: "team" },
        }),
      ),
    ).toBe("viewer");
  });
  it("cap never grants access", () => {
    expect(decide(with_({ cap: "guest" }))).toBeNull();
  });
});

describe("can", () => {
  const ctx: CanCtx = { cap: null, personal: false };
  const LEVELS: AccessLevel[] = ["viewer", "editor", "manager", "owner"];
  // [action, viewer, editor, manager, owner]
  const table: [PolicyAction, boolean, boolean, boolean, boolean][] = [
    ["view", true, true, true, true],
    ["versions", true, true, true, true],
    ["version.file", true, true, true, true],
    ["thumbnail.read", true, true, true, true],
    ["content.mint", true, true, true, true],
    ["data.read", true, true, true, true],
    ["events", true, true, true, true],
    ["subscribe", true, true, true, true],
    ["data.write", true, true, true, true],
    ["storage", true, true, true, true],
    ["thumbnail.write", false, true, true, true],
    ["version.text", false, true, true, true],
    ["publish", false, true, true, true],
    ["restore", false, true, true, true],
    ["upload", false, true, true, true],
    ["share", false, false, true, true],
    ["unshare", false, false, true, true],
    ["visibility", false, false, true, true],
    ["delete", false, false, true, true],
    ["undelete", false, false, true, true],
    ["data.reset", false, false, true, true],
    ["move", false, false, true, true],
    ["transfer", false, false, false, false], // shared artifact: nobody
  ];
  it.each(table)("%s", (action, ...expected) => {
    expect(LEVELS.map((l) => can(l, action, ctx))).toEqual(expected);
  });
  it("visibility (widening): editor no, manager yes, owner yes", () => {
    expect(can("editor", "visibility", ctx)).toBe(false);
    expect(can("manager", "visibility", ctx)).toBe(true);
    expect(can("owner", "visibility", { ...ctx, personal: true })).toBe(true);
  });
  it("transfer: personal owner only, never a manager", () => {
    expect(can("owner", "transfer", { ...ctx, personal: true })).toBe(true);
    expect(can("manager", "transfer", { ...ctx, personal: true })).toBe(false);
  });
  it("data.seed: the uncapped, signed-in owner only", () => {
    expect(can("owner", "data.seed", ctx)).toBe(true);
    expect(can("manager", "data.seed", ctx)).toBe(false);
    expect(can("editor", "data.seed", ctx)).toBe(false);
    expect(can("owner", "data.seed", { ...ctx, cap: "restricted" })).toBe(
      false,
    );
    expect(can("owner", "data.seed", { ...ctx, anonymous: true })).toBe(false);
  });
  it("orgCan allowlists TEAM_ROLES for tokens, MCP and publishing", () => {
    const odd: Member = {
      id: "u",
      email: "u@x.com",
      name: null,
      role: "superuser" as Role,
      lastSeenAt: null,
    };
    expect(orgCan(odd, "tokens.create")).toBe(false);
    expect(orgCan(odd, "mcp.connect")).toBe(false);
    expect(orgCan(odd, "space.publish", { spaceRole: "editor" })).toBe(false);
  });
  it("no level, no action", () => {
    expect(can(null, "view", ctx)).toBe(false);
  });
  it("cap removes data.write and storage; ordinary viewers keep them", () => {
    expect(can("viewer", "data.write", { ...ctx, cap: "restricted" })).toBe(
      false,
    );
    expect(can("viewer", "storage", { ...ctx, cap: "guest" })).toBe(false);
    expect(can("viewer", "data.write", ctx)).toBe(true);
  });
  it("viewer first thumbnail only via share or team, never when capped", () => {
    expect(
      can("viewer", "thumbnail.write", { ...ctx, firstThumbnail: true }),
    ).toBe(true);
    expect(
      can("viewer", "thumbnail.write", {
        ...ctx,
        firstThumbnail: true,
        cap: "guest",
      }),
    ).toBe(false);
  });
  it("anonymous: data writes only with allowAnonymousWrites; never storage", () => {
    const anon = { ...ctx, anonymous: true };
    expect(can("viewer", "data.write", anon)).toBe(false);
    expect(
      can("viewer", "data.write", { ...anon, allowAnonymousWrites: true }),
    ).toBe(true);
    expect(
      can("viewer", "storage", { ...anon, allowAnonymousWrites: true }),
    ).toBe(false);
    expect(
      can("viewer", "anonId", { ...anon, allowAnonymousWrites: true }),
    ).toBe(true);
    expect(
      can("viewer", "anonId", { ...ctx, allowAnonymousWrites: true }),
    ).toBe(false);
  });

  const SEVEN: Record<ArtifactAction, PolicyAction> = {
    edit: "publish",
    share: "share",
    setVisibility: "visibility",
    delete: "delete",
    transfer: "transfer",
    move: "move",
    dataWrite: "data.write",
  };
  it("agrees with the contract's artifactCan on its seven actions", () => {
    const caps: (CapReason | null)[] = [null, "guest", "restricted"];
    for (const level of LEVELS)
      for (const personal of [true, false])
        for (const cap of caps) {
          const mine = Object.fromEntries(
            ARTIFACT_ACTIONS.map((a) => [
              a,
              can(level, SEVEN[a], { cap, personal }),
            ]),
          );
          expect(mine, `${level} personal=${personal} cap=${cap}`).toEqual(
            artifactCan(level, { personal, cap }),
          );
        }
  });
});

describe("capOf", () => {
  const m = (role: Role, restrictedManual = false, restrictedSync = false) => ({
    role,
    restrictedManual,
    restrictedSync,
  });
  it.each([
    [m("guest"), true, "guest"],
    [m("guest"), false, null],
    [m("member", true), false, "restricted"],
    [m("member", false, true), true, "restricted"],
    [m("admin"), true, null],
  ] as const)("%o guestsReadOnly=%s → %s", (who, guestsReadOnly, expected) => {
    expect(capOf(who, { guestsReadOnly })).toBe(expected);
  });
});

describe("orgCan", () => {
  const member = (role: Role): Member => ({
    id: "u",
    email: "u@x.com",
    name: null,
    role,
    lastSeenAt: null,
  });
  // [action, owner, admin, member, guest]
  const adminOnly: OrgAction[] = [
    "space.create",
    "space.delete",
    "space.mappings",
    "org.mappings",
    "space.allMembers",
    "space.adminSelfAdd",
    "restricted.groups",
    "restricted.member",
    "transfer.departed",
    "audit.read",
    "members.manage",
    "settings.manage",
    "usage.read",
  ];
  it.each(adminOnly)("%s: org owner and admin only", (action) => {
    expect(
      (["owner", "admin", "member", "guest"] as Role[]).map((r) =>
        orgCan(member(r), action),
      ),
    ).toEqual([true, true, false, false]);
  });
  it.each([
    "space.members",
    "space.rename",
    "space.publicLinks",
    "space.mappings.manage",
  ] as OrgAction[])("%s: admins or the space manager", (action) => {
    expect(orgCan(member("member"), action, { spaceRole: "manager" })).toBe(
      true,
    );
    // A cap drops it, manager or not.
    expect(
      orgCan(member("member"), action, {
        spaceRole: "manager",
        cap: "restricted",
      }),
    ).toBe(false);
    expect(orgCan(member("member"), action, { spaceRole: "editor" })).toBe(
      false,
    );
    expect(orgCan(member("admin"), action)).toBe(true);
  });
  it("space.publish: editor or manager, never guests or capped", () => {
    expect(
      orgCan(member("member"), "space.publish", { spaceRole: "editor" }),
    ).toBe(true);
    expect(
      orgCan(member("member"), "space.publish", { spaceRole: "viewer" }),
    ).toBe(false);
    expect(
      orgCan(member("guest"), "space.publish", { spaceRole: "editor" }),
    ).toBe(false);
    expect(
      orgCan(member("member"), "space.publish", {
        spaceRole: "manager",
        cap: "restricted",
      }),
    ).toBe(false);
  });
  it("artifact.create refuses capped members", () => {
    expect(
      orgCan(member("member"), "artifact.create", { cap: "restricted" }),
    ).toBe(false);
    expect(orgCan(member("member"), "artifact.create")).toBe(true);
  });
  it.each(["directory.manage", "members.manageAdmins"] as OrgAction[])(
    "%s: the org owner only",
    (action) => {
      expect(
        (["owner", "admin", "member", "guest"] as Role[]).map((r) =>
          orgCan(member(r), action),
        ),
      ).toEqual([true, false, false, false]);
    },
  );
  it("tokens and MCP: non-guest, uncapped", () => {
    expect(orgCan(member("member"), "tokens.create")).toBe(true);
    expect(orgCan(member("guest"), "mcp.connect")).toBe(false);
    expect(orgCan(member("member"), "mcp.connect", { cap: "restricted" })).toBe(
      false,
    );
  });
});

describe("namedEvents", () => {
  it("team members, more-than-public access; never anonymous", () => {
    expect(namedEvents({ role: "member" }, "viewer", "public")).toBe(true);
    expect(namedEvents({ role: "guest" }, "viewer", "public")).toBe(false);
    expect(namedEvents({ role: "guest" }, "editor", "public")).toBe(true);
    expect(namedEvents({ role: "guest" }, "viewer", "private")).toBe(true);
    expect(namedEvents(null, "viewer", "public")).toBe(false);
  });
});
