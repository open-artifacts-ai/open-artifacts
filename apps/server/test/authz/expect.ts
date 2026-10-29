// P3 T16: the expected access, written out by hand. Independent of
// src/auth/policy.ts on purpose: the matrix compares the live surfaces with
// this table, so a policy bug can't hide by agreeing with itself.
// Pure TypeScript (no workerd imports): scripts/authz-probe.ts loads it in Node.
import type { AccessLevel } from "@oa/shared";
import type { PolicyAction } from "../../src/auth/policy.ts";

export const CALLERS = [
  "orgOwner",
  "orgAdmin",
  "spaceManager",
  "spaceEditor",
  "spaceViewer",
  "allMembersOnly",
  "personalOwner",
  "otherMember",
  "guestShared",
  "guestMappedEditor",
  "restrictedContractor",
  "suspendedUser",
  "removedUser",
  "recycledEmailUser",
  "staleSynced",
  "everySpaceMember",
  "everySpaceGuest",
  "anonymous",
] as const;
export type CallerName = (typeof CALLERS)[number];

export const ARTIFACTS = [
  "personalPrivate",
  "personalTeam",
  "personalPublic",
  "spacePrivate",
  "spaceTeam",
  "spacePublic",
  "spaceLinksOff",
  "deletedPersonal",
  "deletedSpace",
] as const;
export type ArtifactName = (typeof ARTIFACTS)[number];

/**
 * The world the fixture builds (test/authz/fixture.ts):
 * - personalOwner's personal space: personalPrivate, personalTeam,
 *   personalPublic, deletedPersonal (team, in the trash).
 * - Shared space S (public links on, no all-members role): spaceManager
 *   manager, spaceEditor editor, spaceViewer viewer (manual); staleSynced
 *   and guestMappedEditor editor (sync); restrictedContractor editor
 *   (manual, restricted). spacePrivate, spaceTeam, spacePublic, deletedSpace
 *   (team, in the trash).
 * - Shared space L (public links OFF, all members editor; spaceManager
 *   manager): spaceLinksOff, public (made public before the toggle).
 * - Shares: guestShared viewer on personalPrivate and editor on
 *   spacePrivate; restrictedContractor editor on personalPrivate.
 *   suspendedUser and removedUser held a manager role in S and an editor
 *   share on personalPrivate. recycledEmailUser's address belonged to a user
 *   removed by the directory (deletion treatment) who held the same.
 * - Every-space mapping (org_group_mappings, editor) for a directory group
 *   holding everySpaceMember and everySpaceGuest: every shared space (S and
 *   L), never a personal one; the guest is capped to viewer.
 * - Directory connected, sync unhealthy for 8 days (staleAt reported):
 *   staleSynced keeps last-sync access (no stale cutoff).
 */
export const WORLD = "see fixture.ts";

/** Who the caller is once the request resolves. */
export type Traits = {
  /** The session (cookie, PAT or grant) resolves to a user. */
  session: boolean;
  /** Owner, admin or member (not a guest). */
  team: boolean;
  /** A guest under the guest cap, or a restricted member: read-only. */
  capped: boolean;
  /** Holds an agent token (PAT, MCP grant) that /mcp accepts. */
  mcp: boolean;
  role: "owner" | "admin" | "member" | "guest" | null;
  /** Capped callers list only what they reach through a share or a space role. */
  grants?: readonly ArtifactName[];
  /** Role in shared space S (manual or sync). */
  sRole?: "viewer" | "editor" | "manager";
};

const T = (role: Traits["role"], o: Partial<Traits> = {}): Traits => ({
  session: role !== null,
  team: role === "owner" || role === "admin" || role === "member",
  capped: false,
  mcp: role === "owner" || role === "admin" || role === "member",
  role,
  ...o,
});
const NONE = T(null);

export const TRAITS: Record<CallerName, Traits> = {
  orgOwner: T("owner"),
  orgAdmin: T("admin"),
  spaceManager: T("member", { sRole: "manager" }),
  spaceEditor: T("member", { sRole: "editor" }),
  spaceViewer: T("member", { sRole: "viewer" }),
  allMembersOnly: T("member"),
  personalOwner: T("member"),
  otherMember: T("member"),
  guestShared: T("guest", {
    capped: true,
    mcp: false,
    grants: ["personalPrivate", "spacePrivate"],
  }),
  guestMappedEditor: T("guest", {
    capped: true,
    mcp: false,
    grants: ["spacePrivate", "spaceTeam", "spacePublic"],
    sRole: "editor",
  }),
  restrictedContractor: T("member", {
    capped: true,
    mcp: false,
    grants: ["personalPrivate", "spacePrivate", "spaceTeam", "spacePublic"],
    sRole: "editor",
  }),
  // Inactive users resolve to no one: anonymous everywhere.
  suspendedUser: NONE,
  removedUser: NONE,
  recycledEmailUser: T("member"),
  staleSynced: T("member", { sRole: "editor" }),
  everySpaceMember: T("member", { sRole: "editor" }),
  everySpaceGuest: T("guest", {
    capped: true,
    mcp: false,
    grants: ["spacePrivate", "spaceTeam", "spacePublic", "spaceLinksOff"],
    sRole: "editor",
  }),
  anonymous: NONE,
};

const O = "owner",
  M = "manager",
  E = "editor",
  V = "viewer",
  _ = null;
type Row = readonly (AccessLevel | null)[];

/**
 * The level each caller reaches, per artifact (ARTIFACTS order). For the two
 * deleted artifacts it is the trash level (who may undelete); every other
 * action on them is refused.
 */
// biome-ignore format: an aligned table
const LEVELS: Record<CallerName, Row> = {
  //                    pPriv pTeam pPub sPriv sTeam sPub lOff delP delS
  orgOwner:             [_,   V,    V,   _,    V,    V,   E,   _,   _],
  orgAdmin:             [_,   V,    V,   _,    V,    V,   E,   _,   _],
  spaceManager:         [_,   V,    V,   M,    M,    M,   M,   _,   M],
  spaceEditor:          [_,   V,    V,   E,    E,    E,   E,   _,   _],
  spaceViewer:          [_,   V,    V,   V,    V,    V,   E,   _,   _],
  allMembersOnly:       [_,   V,    V,   _,    V,    V,   E,   _,   _],
  personalOwner:        [O,   O,    O,   _,    V,    V,   E,   O,   _],
  otherMember:          [_,   V,    V,   _,    V,    V,   E,   _,   _],
  guestShared:          [V,   _,    V,   V,    _,    V,   V,   _,   _],
  guestMappedEditor:    [_,   _,    V,   V,    V,    V,   V,   _,   _],
  restrictedContractor: [V,   _,    V,   V,    V,    V,   V,   _,   _],
  suspendedUser:        [_,   _,    V,   _,    _,    V,   V,   _,   _],
  removedUser:          [_,   _,    V,   _,    _,    V,   V,   _,   _],
  recycledEmailUser:    [_,   V,    V,   _,    V,    V,   E,   _,   _],
  staleSynced:          [_,   V,    V,   E,    E,    E,   E,   _,   _],
  everySpaceMember:     [_,   V,    V,   E,    E,    E,   E,   _,   _],
  everySpaceGuest:      [_,   _,    V,   V,    V,    V,   V,   _,   _],
  anonymous:            [_,   _,    V,   _,    _,    V,   V,   _,   _],
};

export const EXPECTED: Record<
  CallerName,
  Record<ArtifactName, AccessLevel | null>
> = Object.fromEntries(
  CALLERS.map((c) => [
    c,
    Object.fromEntries(ARTIFACTS.map((a, i) => [a, LEVELS[c][i] ?? null])),
  ]),
) as never;

/** Static facts about each artifact. */
export const ART: Record<
  ArtifactName,
  { personal: boolean; deleted: boolean; visibility: string }
> = {
  personalPrivate: { personal: true, deleted: false, visibility: "private" },
  personalTeam: { personal: true, deleted: false, visibility: "team" },
  personalPublic: { personal: true, deleted: false, visibility: "public" },
  spacePrivate: { personal: false, deleted: false, visibility: "private" },
  spaceTeam: { personal: false, deleted: false, visibility: "team" },
  spacePublic: { personal: false, deleted: false, visibility: "public" },
  spaceLinksOff: { personal: false, deleted: false, visibility: "public" },
  deletedPersonal: { personal: true, deleted: true, visibility: "team" },
  deletedSpace: { personal: false, deleted: true, visibility: "team" },
};

/** What a surface checks: a policy action, or one of the listing rules. */
export type SurfaceAction =
  | PolicyAction
  /** Appears in list or search results. */
  | "list"
  /** Appears in the trash listing (R.trash): deleted and the caller may undelete it. */
  | "trash"
  /** /p/: served to anyone while public and live, whoever asks. */
  | "public.link"
  /** Not artifact-scoped: any caller who reaches the surface at all. */
  | "reach";

const READS: readonly SurfaceAction[] = [
  "view",
  "versions",
  "version.file",
  "thumbnail.read",
  "content.mint",
  "data.read",
  "events",
  "subscribe",
];
const EDITS: readonly SurfaceAction[] = [
  "version.text",
  "publish",
  "restore",
  "upload",
];
const FULL: readonly SurfaceAction[] = [
  "share",
  "unshare",
  "visibility",
  "delete",
  "undelete",
  "data.reset",
  "move",
];
const isEditor = (l: AccessLevel | null) =>
  l === "editor" || l === "manager" || l === "owner";
const isFull = (l: AccessLevel | null) => l === "manager" || l === "owner";

export type Via = "rest" | "mcp" | "content";

/**
 * #681: who may change the artifact's live data. The fixture's artifacts
 * keep the default "viewers"; the matrix probes data writes and anon ids
 * again on "editors" clones.
 */
export type DataWritersCase = "viewers" | "editors";

/** Whether `who` may take `action` on `art` through a `via` surface. */
export function expected(
  who: CallerName,
  art: ArtifactName,
  action: SurfaceAction,
  via: Via = "rest",
  traits: Traits = TRAITS[who],
  dataWriters: DataWritersCase = "viewers",
): "allow" | "deny" {
  const t = traits;
  const a = ART[art];
  const level = EXPECTED[who][art];
  const yes = (b: boolean) => (b ? "allow" : "deny");
  if (action === "public.link")
    return yes(a.visibility === "public" && !a.deleted);
  if (via === "mcp" && !t.mcp) return "deny";
  if (action === "reach") return "allow";
  const writer = t.session && !t.capped;
  if (action === "trash") return yes(a.deleted && writer && isFull(level));
  if (a.deleted) return yes(action === "undelete" && writer && isFull(level));
  if (level === null) return "deny";
  if (action === "list")
    return yes(t.session && (!t.capped || (t.grants ?? []).includes(art)));
  if (READS.includes(action)) return "allow";
  // Data writes: "viewers" lets anyone who can view write (anonymous
  // callers reach a level only on public artifacts); "editors" only uncapped
  // editors and up. Storage is signed-in and uncapped only.
  if (action === "data.write")
    return yes(
      dataWriters === "editors"
        ? writer && isEditor(level)
        : writer || !t.session,
    );
  if (action === "storage") return yes(writer);
  if (action === "thumbnail.write")
    // A viewer is eligible for the first thumbnail only, through a share or
    // a team role on a team artifact (never public visibility alone); the
    // probe stops at eligibility (handler: a stored one is never replaced).
    return yes(
      writer && (isEditor(level) || (a.visibility === "team" && t.team)),
    );
  if (EDITS.includes(action)) return yes(writer && isEditor(level));
  if (FULL.includes(action)) return yes(writer && isFull(level));
  if (action === "transfer")
    return yes(writer && level === "owner" && a.personal);
  // anonId: anonymous callers who may write ("viewers"), over REST.
  if (action === "anonId")
    return yes(!t.session && via === "rest" && dataWriters === "viewers");
  return "deny";
}

/** Instance actions that need an uncapped org owner or admin. */
const ADMIN_ACTIONS = new Set([
  "members.manage",
  "transfer.departed",
  "space.create",
  "space.adminSelfAdd",
  "org.mappings",
  "restricted.groups",
  "restricted.member",
  "settings.manage",
  "usage.read",
  "audit.read",
  "billing.manage",
]);

/** Whether `who` passes an instance route's guard (`{ org }` or `{ user }`). */
export function orgExpected(
  who: CallerName,
  rule: { org: string } | { user: true; space?: "member" | "manager" },
): "allow" | "deny" {
  const t = TRAITS[who];
  const yes = (b: boolean) => (b ? "allow" : "deny");
  if (!t.session) return "deny";
  const admin = (t.role === "owner" || t.role === "admin") && !t.capped;
  if ("user" in rule) {
    if (rule.space === "member") return yes(admin || t.sRole !== undefined);
    if (rule.space === "manager") return yes(admin || t.sRole === "manager");
    return "allow";
  }
  if (ADMIN_ACTIONS.has(rule.org)) return yes(admin);
  switch (rule.org) {
    // The cap doesn't hide settings from members (read only).
    case "settings.read":
      return yes(t.team);
    case "directory.manage":
    // Cookie sessions only: the handler refuses a PAT or grant (tested in
    // directory.disconnect.test.ts; the matrix probes writes by cookie).
    case "directory.disconnect":
      return yes(t.role === "owner" && !t.capped);
    // Any /api/v1 credential (session or PAT), the uncapped owner's only.
    case "broker.check":
      return yes(t.role === "owner" && !t.capped);
    case "tokens.create":
      return yes(t.team && !t.capped);
    case "artifact.create":
      return yes(!t.capped);
  }
  throw new Error(`no expectation for ${rule.org}`);
}

/** The space service's write rules (S and its clones; never a personal space). */
export function spaceExpected(
  who: CallerName,
  rule: "admin" | "manager" | "none",
): "allow" | "deny" {
  const t = TRAITS[who];
  if (!t.session || t.capped || rule === "none") return "deny";
  const admin = t.role === "owner" || t.role === "admin";
  if (rule === "admin") return admin ? "allow" : "deny";
  return admin || t.sRole === "manager" ? "allow" : "deny";
}
