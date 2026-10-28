// Hosted M1 spaces, members, group mappings and the restricted-group cap (P3).
// No access is 404 (never 403), except the explicit space_forbidden on
// publish/move. Personal spaces are never targets of these routes (space_personal).
import { z } from "zod";
import {
  PageSchema,
  RoleSchema,
  stripNameControls,
  UserRefSchema,
} from "../schemas.js";
import {
  CapReasonSchema,
  GroupRefSchema,
  MemberStatusSchema,
  MySpaceSchema,
  RestrictionSchema,
  SpaceKindSchema,
  SpaceRefSchema,
  SpaceRoleSchema,
} from "./core.js";

/**
 * Space.can. manageMappings: list and change this space's group mappings.
 * True for org admins, and for the space's managers while
 * Settings.spaceManagerMappings is on. Always false for personal spaces.
 */
export const SpaceCanSchema = z.object({ manageMappings: z.boolean() });
export type SpaceCan = z.infer<typeof SpaceCanSchema>;

export const SpaceSchema = SpaceRefSchema.extend({
  /** Personal spaces only. */
  owner: UserRefSchema.nullable(),
  /** Role every non-guest, non-restricted member gets; null = none. */
  allMembersRole: SpaceRoleSchema.nullable(),
  /** Effective; own personal space = "manager"; null = org admin view only. */
  myRole: SpaceRoleSchema.nullable(),
  memberCount: z.number().int(),
  /** Live artifacts. */
  artifactCount: z.number().int(),
  createdAt: z.string(),
  /** What the caller may do in this space (optional: older servers omit it). */
  can: SpaceCanSchema.optional(),
});
export type Space = z.infer<typeof SpaceSchema>;

/** MCP list_spaces input: no arguments. */
export const ListSpacesInputSchema = z.strictObject({});
export type ListSpacesInput = z.infer<typeof ListSpacesInputSchema>;

/**
 * MCP list_spaces result: the spaces the caller can publish into
 * (publish_artifact spaceId). Their personal space first (myRole
 * "manager"), then shared spaces where they are editor or manager, by name;
 * at most LIST_SPACES_MAX. Empty for a capped caller.
 */
export const ListSpacesResultSchema = z.object({
  items: z.array(MySpaceSchema),
});
export type ListSpacesResult = z.infer<typeof ListSpacesResultSchema>;
export const LIST_SPACES_MAX = 200;

/** GET R.spaces query. Response: Page<Space>, by name. */
export const SpacesQuerySchema = z.strictObject({
  kind: SpaceKindSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SpacesQuery = z.infer<typeof SpacesQuerySchema>;

/** 400 space_name_reserved message: a shared space can't be named "Personal". */
export const SPACE_NAME_RESERVED_MESSAGE =
  "That name is reserved for your personal space.";

/** "Personal", trimmed and case-insensitive: refused on create and rename. */
export const isReservedSpaceName = (name: string): boolean =>
  name.trim().toLowerCase() === "personal";

/**
 * A space name: control and bidi characters stripped, then trimmed, 1-80
 * characters (a name of only such characters is 400), and not "Personal"
 * (trimmed, any case; SPACE_NAME_RESERVED_MESSAGE).
 */
export const SpaceNameSchema = z
  .string()
  .transform(stripNameControls)
  .pipe(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((n) => !isReservedSpaceName(n), {
        message: SPACE_NAME_RESERVED_MESSAGE,
      }),
  );

/**
 * A SpaceCreate/SpacePatch parse failed on the reserved name: answer 400
 * space_name_reserved (details { field: "name" }), not bad_request.
 */
export const spaceNameReserved = (issues: readonly unknown[]): boolean =>
  issues.some((i) => {
    const x = i as { message?: unknown; path?: unknown };
    return (
      x.message === SPACE_NAME_RESERVED_MESSAGE &&
      Array.isArray(x.path) &&
      x.path[0] === "name"
    );
  });

/**
 * POST R.spaces (org owner, admin) -> 201 Space. addMe (default true): the
 * creator becomes a manual manager of the new space; false adds no row (an
 * admin is never implicitly in a space).
 */
export const SpaceCreateSchema = z.strictObject({
  name: SpaceNameSchema,
  allMembersRole: SpaceRoleSchema.nullable().default(null),
  publicLinks: z.boolean().default(true),
  addMe: z.boolean().default(true),
});
export type SpaceCreate = z.infer<typeof SpaceCreateSchema>;
export type SpaceCreateInput = z.input<typeof SpaceCreateSchema>;

/**
 * PATCH R.space(id) -> Space. name and publicLinks: space manager or org
 * admin (publicLinks changes are audited; off refuses new public links only:
 * existing public artifacts, their links and sockets keep working, nothing is
 * rewritten). allMembersRole: org owner or
 * admin. (outsideSharing is dropped until M4.) Making an artifact public in a
 * space with publicLinks off is 403 public_links_off.
 */
export const SpacePatchSchema = z
  .strictObject({
    name: SpaceNameSchema,
    allMembersRole: SpaceRoleSchema.nullable(),
    publicLinks: z.boolean(),
  })
  .partial();
export type SpacePatch = z.infer<typeof SpacePatchSchema>;
/** Fields a space manager (not admin) may change. */
export const SPACE_MANAGER_FIELDS = ["name", "publicLinks"] as const;

export const SpaceMemberSourceSchema = z.enum(["manual", "sync"]);
export type SpaceMemberSource = z.infer<typeof SpaceMemberSourceSchema>;

/** How a group reaches a space: its own mapping, or an Every-space org mapping (R.orgMappings). */
export const SpaceMemberGroupViaSchema = z.enum(["space", "every"]);
export type SpaceMemberGroupVia = z.infer<typeof SpaceMemberGroupViaSchema>;

/** One mapped group behind a member's syncRole: the role that mapping grants and where it comes from. */
export const SpaceMemberGroupSchema = GroupRefSchema.extend({
  role: SpaceRoleSchema,
  via: SpaceMemberGroupViaSchema,
});
export type SpaceMemberGroup = z.infer<typeof SpaceMemberGroupSchema>;

/**
 * GET R.spaceMembers(id) -> SpaceMembersPage (personal: 400 space_personal).
 * Keyed by user id. The UI's
 * per-row reason line comes from manualRole, groups[].role/via and
 * allMembers (e.g. "Manager by hand, Editor via eng@", "Viewer via All
 * members").
 */
export const SpaceMemberSchema = z.object({
  userId: z.string(),
  user: UserRefSchema,
  status: MemberStatusSchema,
  /** Effective role: max of manualRole and syncRole. */
  role: SpaceRoleSchema,
  /** Which row grants `role` (manual wins a tie). */
  source: SpaceMemberSourceSchema,
  manualRole: SpaceRoleSchema.nullable(),
  syncRole: SpaceRoleSchema.nullable(),
  /** Mapped groups that grant syncRole, one entry per mapping (a group mapped here and Every space appears twice). */
  groups: z.array(SpaceMemberGroupSchema),
  /** Guest or restricted: effective access is viewer whatever the role. */
  cap: CapReasonSchema.nullable(),
  /** The space's allMembersRole when it applies to this person; null for guests, capped users, or when none is set. */
  allMembers: SpaceRoleSchema.nullable(),
  /**
   * As Member.restriction (the manual flag and/or restricted groups), only
   * for a caller who can manage the space (uncapped manager, org admin);
   * null for everyone else (cap still says restricted) and when
   * unrestricted. Optional: older servers omit it.
   */
  restriction: RestrictionSchema.nullable().optional(),
});
export type SpaceMember = z.infer<typeof SpaceMemberSchema>;

/**
 * GET R.spaceMembers(id) query. q: case-insensitive prefix of the email or of
 * any word of the name; group: a groupId (members it reaches, either via).
 */
export const SpaceMembersQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200).optional(),
  group: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SpaceMembersQuery = z.infer<typeof SpaceMembersQuerySchema>;
export type SpaceMembersQueryInput = z.input<typeof SpaceMembersQuerySchema>;

/** Page<SpaceMember> plus total: the count matching q/group across every page. */
export const SpaceMembersPageSchema = PageSchema(SpaceMemberSchema).extend({
  total: z.number().int(),
});
export type SpaceMembersPage = z.infer<typeof SpaceMembersPageSchema>;

/** The largest page R.spaceCandidates returns. */
export const SPACE_CANDIDATES_MAX = 50;

/**
 * GET R.spaceCandidates(id) query: the "Add people" search. q, as
 * SpaceMembersQuery's: a case-insensitive prefix of the email or of any word
 * of the name; absent lists every candidate (paged).
 */
export const SpaceCandidatesQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(SPACE_CANDIDATES_MAX).default(20),
});
export type SpaceCandidatesQuery = z.infer<typeof SpaceCandidatesQuerySchema>;
export type SpaceCandidatesQueryInput = z.input<
  typeof SpaceCandidatesQuerySchema
>;

/**
 * GET R.spaceCandidates(id) -> Page<SpaceCandidate>, by email then id: the
 * people a caller who can manage the space may add to it. Active org
 * members (owner, admin, member; never a guest, who comes in by link) of the
 * whole org, those already in the space included (`spaceRole` says so). For
 * an uncapped org admin, or an uncapped manager of that space; anyone else
 * 404, as for a space they can't see. Personal: 400 space_personal.
 */
export const SpaceCandidateSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  /** Org role (owner, admin or member). */
  role: RoleSchema,
  /** As Member.restriction; null when unrestricted. A restricted person is viewer whatever role they get. */
  restriction: RestrictionSchema.nullable(),
  /**
   * Their role in this space now (by hand, synced, or Every space: the
   * SpaceMember.role they'd show in R.spaceMembers); null when they aren't
   * in it. allMembersRole doesn't count.
   */
  spaceRole: SpaceRoleSchema.nullable(),
});
export type SpaceCandidate = z.infer<typeof SpaceCandidateSchema>;

/** What a 403 space_forbidden on a member or mapping route refused (the UI picks its copy). */
export const SpaceForbiddenTargetSchema = z.enum(["member", "mapping"]);
export type SpaceForbiddenTarget = z.infer<typeof SpaceForbiddenTargetSchema>;
/** 403 space_forbidden details on R.spaceMember PUT and R.spaceMapping PUT/DELETE. Publish/move refusals carry none. */
export const SpaceForbiddenDetailsSchema = z.object({
  target: SpaceForbiddenTargetSchema,
});
export type SpaceForbiddenDetails = z.infer<typeof SpaceForbiddenDetailsSchema>;

/*
 * PUT R.spaceMember(id, userId) (space manager, org admin) -> SpaceMember.
 * The target must be an existing, active member, else 404.
 * Sets the manual row. A space manager (not an org admin) granting manager,
 * or changing a peer manager (a manager row by hand or synced, the frozen
 * override included): 403 space_forbidden { target: "member" }. While sync is frozen, on a row with a syncRole: any
 * role (raise or lower) is a manual grant under those rules and replaces the
 * synced row with a manual override (the next reconcile after unfreezing
 * replaces it). Audited space.member.add/role
 * (frozen override: detail { syncFrozen: true, role }).
 *
 * DELETE R.spaceMember(id, userId) -> 204: removes the manual row. Only an
 * org admin removes a peer manager (a manager row by hand or synced, frozen
 * included): else 403 space_forbidden { target: "member" }, before
 * member_synced. A synced-only row while sync is live: 409 member_synced. While frozen it
 * removes the synced row too (removing access is always allowed); audited
 * space.member.remove (frozen: detail { syncFrozen: true }).
 */
/** PUT R.spaceMember(id, userId) body (rules above). Also the body of POST R.spaceMemberSelf(id). */
export const SpaceMemberPutSchema = z.strictObject({ role: SpaceRoleSchema });
export type SpaceMemberPut = z.infer<typeof SpaceMemberPutSchema>;

/** Roles a space manager (not an org admin) may map a group to; manager is 403 space_forbidden. */
export const SPACE_MANAGER_MAPPING_ROLES = ["viewer", "editor"] as const;

/**
 * GET R.spaceMappings(id) -> GroupMapping[] (bounded). Org admin or a space
 * manager (whatever Settings.spaceManagerMappings says). Personal: 400
 * space_personal. Per-space rows only: Every-space rows are R.orgMappings.
 * Pending server implementation (P3 T9/T14).
 */
export const GroupMappingSchema = GroupRefSchema.extend({
  role: SpaceRoleSchema,
  memberCount: z.number().int().nullable(),
  lastSyncedAt: z.string().nullable(),
});
export type GroupMapping = z.infer<typeof GroupMappingSchema>;

/**
 * PUT R.spaceMapping(id, group) -> GroupMapping; DELETE -> 204. Org admin: any
 * role. Space manager: only rows that are and stay viewer|editor
 * (SPACE_MANAGER_MAPPING_ROLES). Checks in order: personal 400
 * space_personal; no role 404; PUT while Settings.spaceManagerMappings is off
 * 403 directory_mapping_off (DELETE is always allowed: removing access);
 * a manager role (PUT body, or the existing row on PUT or DELETE) 403
 * space_forbidden; sync off or frozen 409 directory_sync_off. Manager access
 * is pending server implementation (P3 T9/T14).
 */
export const GroupMappingPutSchema = z.strictObject({ role: SpaceRoleSchema });
export type GroupMappingPut = z.infer<typeof GroupMappingPutSchema>;

/*
 * "Every space" mappings reuse GroupMapping / GroupMappingPut (pending server
 * implementation, P3 T9/T14). GET R.orgMappings?cursor&limit ->
 * Page<GroupMapping> (org admin). PUT R.orgMapping(groupId) GroupMappingPut ->
 * GroupMapping (upsert); DELETE -> 204; org admin only; 409
 * directory_sync_off when sync is off or frozen; audited mapping.set /
 * mapping.remove with spaceId null. One row per group, NEVER expanded into
 * per-space rows: a member's effective role in a shared space is the
 * read-time max of the per-space rows and the org mappings of their groups
 * (SpaceMember.syncRole, groups). Applies to every shared space, including
 * ones created later, and never to a personal space.
 */

/**
 * GET R.restrictedGroups -> RestrictedGroup[] (org admin). Restricted members
 * (a restricted group, or the manual flag R.memberRestricted) are capped at
 * viewer everywhere: no allMembersRole, no create (personal space included),
 * no data writes, on REST, MCP and the data API.
 * PUT R.restrictedGroup(groupId) -> RestrictedGroup, 409 directory_sync_off
 * when sync is off or frozen; DELETE -> 204 in any mode.
 */
export const RestrictedGroupSchema = GroupRefSchema.extend({
  memberCount: z.number().int().nullable(),
  createdAt: z.string(),
});
export type RestrictedGroup = z.infer<typeof RestrictedGroupSchema>;
