import {
  type AccessLevel,
  type Capabilities,
  CapabilitiesSchema,
  type CapReason,
  type DataWriters,
  type Member,
  type Role,
  type SpaceKind,
  type SpaceRole,
  type Visibility,
} from "@oa/shared";

const NO_CAPS: Capabilities = { db: false, viewer: false, storage: false };
/** Declared capabilities; malformed JSON means none (capability_denied, never 500). */
export function capsOf(json: string): Capabilities {
  try {
    const r = CapabilitiesSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : NO_CAPS;
  } catch {
    return NO_CAPS;
  }
}

/**
 * The hosted access policy (P3): pure functions, no I/O. authz.ts gathers a
 * DecisionInput in one D1 statement; every route and MCP tool asks `can` or
 * `orgCan`. Plan: docs/superpowers/plans/2026-10-21-hosted-m1-p3-rbac.md.
 */

/** Every per-artifact action the server checks (a superset of the contract's ArtifactAction). */
export type PolicyAction =
  | "view"
  | "versions"
  | "version.file"
  | "thumbnail.read"
  | "content.mint"
  | "data.read"
  | "events"
  | "subscribe"
  | "data.write"
  | "storage"
  | "thumbnail.write"
  | "version.text"
  | "publish"
  | "restore"
  | "upload"
  | "share"
  | "unshare"
  | "visibility"
  | "delete"
  | "undelete"
  | "data.reset"
  | "move"
  | "transfer"
  | "anonId"
  /** MCP data tools on an artifact without the db capability (B14, narrowed). */
  | "data.seed";

export type OrgAction =
  | "space.create"
  | "space.delete"
  | "space.mappings"
  /** Per-space mappings on a shared space: org admins any role, its managers viewer or editor (the handler applies the ceiling). */
  | "space.mappings.manage"
  /** "Every space" org mappings (R.orgMappings). */
  | "org.mappings"
  | "space.allMembers"
  | "space.members"
  | "space.rename"
  | "space.publicLinks"
  | "space.adminSelfAdd"
  | "space.publish"
  | "restricted.groups"
  | "restricted.member"
  | "artifact.create"
  | "transfer.departed"
  | "directory.manage"
  /** Disconnect the directory (R.directoryDisconnect): the org owner, in a cookie session (the handler refuses bearer auth). */
  | "directory.disconnect"
  /** Probe the auth and directory brokers (R.adminBrokerCheck): the org owner. */
  | "broker.check"
  /** See why configured sign-in is off (Me.instance.signIn.problems): the org owner. */
  | "signin.problems"
  /** See and dismiss owner notices (Me.notices, R.noticeDismiss): the org owner. */
  | "notices.manage"
  | "audit.read"
  | "members.manage"
  | "members.manageAdmins"
  | "settings.read"
  | "settings.manage"
  | "usage.read"
  | "tokens.create"
  | "mcp.connect";

export type DecisionInput = {
  /** Null for anonymous callers. Inactive and stale users never get here. */
  caller: { id: string; orgRole: Role } | null;
  cap: CapReason | null;
  artifact: {
    spaceId: string;
    spaceKind: SpaceKind;
    visibility: Visibility;
    deleted: boolean;
  };
  /**
   * publicLinks never changes a level: it only refuses new public links, a
   * write-path guard (public_links_off). Kept for callers that report it.
   */
  space: { publicLinks: boolean; allMembersRole: SpaceRole | null };
  /** Max of the caller's manual and sync rows in the artifact's space. */
  spaceRole: SpaceRole | null;
  shareRole: "viewer" | "editor" | null;
  allowDeleted: boolean;
};

export type CanCtx = {
  cap: CapReason | null;
  /** The artifact is in a personal space. */
  personal: boolean;
  anonymous?: boolean;
  /**
   * #681: who may change live data. Only an explicit "viewers" lets viewers
   * (and anonymous visitors) write; "editors" or undefined limits data.write
   * to editor level and up (fail closed).
   */
  dataWriters?: DataWriters;
  /** Viewer-only first thumbnail: via a share or team access, and none stored yet. */
  firstThumbnail?: boolean;
};

/** Roles that see `team` artifacts. Guests never do. */
export const TEAM_ROLES: readonly Role[] = ["owner", "admin", "member"];

/** A member, admin or owner (not a guest). */
export const isTeamRole = (role: Role): boolean => TEAM_ROLES.includes(role);

/**
 * A verified sign-in promotes a guest to member (direct sign-in: the domain or
 * code proved the address); every other role is left alone. Lives here because
 * role decisions never leave src/auth.
 */
export const promotedRole = (role: Role): Role =>
  role === "guest" ? "member" : role;

/** The guest role, for the few data decisions that key on it. */
export const isGuestRole = (role: Role): boolean => role === "guest";

const SPACE_RANK: Record<SpaceRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

const maxRole = (
  a: SpaceRole | null,
  b: SpaceRole | null,
): SpaceRole | null => {
  if (!a) return b;
  if (!b) return a;
  return SPACE_RANK[b] > SPACE_RANK[a] ? b : a;
};

/**
 * The caller's cap: restricted (manual flag or a restricted group) or a guest
 * (authConfig.guestsReadOnly, on for every install since parity 2). Null when
 * uncapped.
 */
export function capOf(
  m: Pick<Member, "role"> & {
    restrictedManual: boolean;
    restrictedSync: boolean;
  },
  authConfig: { guestsReadOnly: boolean },
): CapReason | null {
  if (m.restrictedManual || m.restrictedSync) return "restricted";
  if (m.role === "guest" && authConfig.guestsReadOnly) return "guest";
  return null;
}

/** The decision table, first match wins, then the cap lowers the level to viewer. */
export function decide(i: DecisionInput): AccessLevel | null {
  const level = uncapped(i);
  return level && i.cap != null ? "viewer" : level;
}

const SPACE_ROLES: ReadonlySet<unknown> = new Set([
  "viewer",
  "editor",
  "manager",
]);
/** A known space role, else null (fail closed on malformed input). */
const known = <T extends string>(r: unknown, ok: ReadonlySet<unknown>) =>
  ok.has(r) ? (r as T) : null;
const SHARE_ROLES: ReadonlySet<unknown> = new Set(["viewer", "editor"]);

function uncapped(i: DecisionInput): AccessLevel | null {
  const { artifact: a } = i;
  const capped = i.cap != null;
  // Allowlists throughout: anything malformed falls to the narrower branch.
  const caller =
    i.caller && typeof i.caller.id === "string" && i.caller.id
      ? i.caller
      : null;
  const member = caller !== null && TEAM_ROLES.includes(caller.orgRole);
  const personal = a.spaceKind !== "shared";
  const deleted = a.deleted !== false;
  const ownPersonal = personal && caller !== null && a.spaceId === caller.id;
  const allMembers =
    member && !capped
      ? known<SpaceRole>(i.space.allMembersRole, SPACE_ROLES)
      : null;
  const spaceRole =
    personal || !caller
      ? null
      : maxRole(known<SpaceRole>(i.spaceRole, SPACE_ROLES), allMembers);
  const shareRole = caller
    ? known<"viewer" | "editor">(i.shareRole, SHARE_ROLES)
    : null;
  if (deleted) {
    // Trash is for those who can undelete: never capped callers.
    if (i.allowDeleted !== true || capped) return null;
    if (ownPersonal) return "owner";
    if (spaceRole === "manager") return "manager";
    return null;
  }
  if (ownPersonal) return "owner";
  if (spaceRole === "manager") return "manager";
  const best = maxRole(spaceRole, shareRole);
  if (best === "editor") return "editor";
  if (best === "viewer") return "viewer";
  // `team` means every member (shared spaces too), but never capped callers:
  // restricted members and capped guests see team artifacts only through a
  // space role or a share.
  if (a.visibility === "team" && member && !capped) return "viewer";
  // Public links off only refuses new public links: an artifact that is
  // already public keeps its link (decided), whatever its space.
  if (a.visibility === "public") return "viewer";
  return null;
}

const READ: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  "view",
  "versions",
  "version.file",
  "thumbnail.read",
  "content.mint",
  "data.read",
  "events",
  "subscribe",
]);
const EDIT: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  "version.text",
  "publish",
  "restore",
  "upload",
]);
const FULL: ReadonlySet<PolicyAction> = new Set<PolicyAction>([
  "share",
  "unshare",
  "visibility",
  "delete",
  "undelete",
  "data.reset",
  "move",
]);

/**
 * Whether `level` may take `action`. Manager and owner allow the same actions
 * except `transfer` (personal owner only). A capped caller keeps reads only.
 * Never compare levels by rank for owner actions; ask `can`.
 */
export function can(
  level: AccessLevel | null,
  action: PolicyAction,
  ctx: CanCtx,
): boolean {
  if (!level) return false;
  const capped = ctx.cap != null;
  const full = !capped && (level === "manager" || level === "owner");
  if (READ.has(action)) return true;
  switch (action) {
    case "anonId":
      return ctx.anonymous === true && ctx.dataWriters === "viewers";
    case "data.write":
      if (capped) return false;
      if (ctx.dataWriters !== "viewers")
        return !ctx.anonymous && level !== "viewer";
      // Anonymous callers only reach a level on a public artifact.
      return true;
    case "storage":
      return !capped && !ctx.anonymous;
    case "thumbnail.write":
      if (capped || ctx.anonymous) return false;
      return level === "viewer" ? ctx.firstThumbnail === true : true;
    case "transfer":
      return full && level === "owner" && ctx.personal;
    case "data.seed":
      // Agents may seed data before declaring db: the uncapped personal
      // owner only; managers, editors and capped callers need the capability.
      return !capped && !ctx.anonymous && level === "owner";
  }
  if (EDIT.has(action)) return !capped && level !== "viewer";
  if (FULL.has(action)) return full;
  return false;
}

/**
 * #681: a data.write refusal caused by dataWriters "editors" alone (the
 * caller could write if viewers could): 403 data_editors_only, for anonymous
 * and signed-in viewers alike. Any other refusal keeps its code.
 */
export const editorsOnlyRefusal = (
  level: AccessLevel | null,
  ctx: CanCtx,
): boolean =>
  ctx.dataWriters !== "viewers" &&
  !can(level, "data.write", ctx) &&
  can(level, "data.write", { ...ctx, dataWriters: "viewers" });

/**
 * #681: a row's effective dataWriters. "viewers" only when data_writers is
 * "viewers" and allow_anonymous_writes is 1 (new code keeps them in step);
 * anything else is "editors" (fail closed). A row written by the previous
 * release during a rollback (the toggle switched off, or created with it off)
 * so reads as "editors" after the roll forward, with no release step.
 */
export const dataWritersOf = (a: {
  dataWriters: string;
  allowAnonymousWrites: number;
}): DataWriters =>
  a.dataWriters === "viewers" && a.allowAnonymousWrites === 1
    ? "viewers"
    : "editors";

const ORG_ADMINS: readonly Role[] = ["owner", "admin"];

/** Org owners and admins can't be restricted (400 restrict_admin; sync skips them). */
export const canBeRestricted = (role: Role): boolean =>
  !ORG_ADMINS.includes(role);

/**
 * An org owner or admin target: changing their role, removing or suspending
 * them, or resetting their Google link needs members.manageAdmins (#475).
 */
export const isOrgAdmin = (role: string): boolean =>
  (ORG_ADMINS as readonly string[]).includes(role);

/** Instance and space administration (no artifact involved). */
export function orgCan(
  m: Member,
  action: OrgAction,
  opts: { spaceRole?: SpaceRole | null; cap?: CapReason | null } = {},
): boolean {
  const capped = opts.cap != null;
  // Owners and admins can't be restricted (restrict_admin); a cap still
  // removes every admin power as belt and braces.
  const admin = ORG_ADMINS.includes(m.role) && !capped;
  switch (action) {
    case "space.members":
    case "space.rename":
    case "space.publicLinks":
    case "space.mappings.manage":
      return !capped && (admin || opts.spaceRole === "manager");
    case "space.publish":
      return (
        !capped &&
        TEAM_ROLES.includes(m.role) &&
        (opts.spaceRole === "editor" || opts.spaceRole === "manager")
      );
    case "artifact.create":
      return !capped;
    case "settings.read":
      return TEAM_ROLES.includes(m.role);
    case "directory.manage":
    // Disconnect: owner only too (the route also needs a cookie session).
    case "directory.disconnect":
    // The broker check: owner only (it spends broker rate limit).
    case "broker.check":
    // Sign-in config problems: the owner, who can fix them (review item 35).
    case "signin.problems":
    // Owner notices (Me.notices) and their dismissal (parity 2).
    case "notices.manage":
    // Acting on an org owner or admin (role, removal, suspension, Google
    // link reset): owner only (#475).
    case "members.manageAdmins":
      return m.role === "owner" && !capped;
    case "tokens.create":
    case "mcp.connect":
      return TEAM_ROLES.includes(m.role) && !capped;
    default:
      return admin;
  }
}

/**
 * Whether an artifact may be served without a signed token (/p/ and public
 * downloads): public and live. A space's public-links toggle is not part of
 * it: turning it off only refuses new public links (403 public_links_off),
 * so an artifact that is already public keeps its link (decided).
 */
export function isPubliclyServable(a: {
  visibility: string;
  deleted: boolean;
}): boolean {
  return a.visibility === "public" && a.deleted === false;
}

/**
 * Whether an events-socket subscriber sees publisher names: team members,
 * and anyone whose access is more than a public link.
 */
export function namedEvents(
  caller: Pick<Member, "role"> | null,
  level: AccessLevel,
  visibility: Visibility,
): boolean {
  if (!caller) return false;
  return (
    TEAM_ROLES.includes(caller.role) ||
    level !== "viewer" ||
    visibility !== "public"
  );
}
