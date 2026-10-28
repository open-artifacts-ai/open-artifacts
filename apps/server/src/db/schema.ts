import {
  FORMATS,
  RoleSchema,
  ShareRoleSchema,
  SpaceKindSchema,
  SpaceRoleSchema,
  VisibilitySchema,
} from "@oa/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`"${col}" in (${values.map((v) => `'${v}'`).join(", ")})`);

// EMAIL RULE: all email writes and lookups go through normalizeEmail() (@oa/auth-core),
// because SQLite COLLATE NOCASE only folds ASCII.
//
// FTS RULE (for B8): artifact_search rows use rowid = artifacts.rowid (the implicit
// integer rowid). Insert with that rowid and delete with
// `DELETE FROM artifact_search WHERE rowid = (SELECT rowid FROM artifacts WHERE id = ?)`;
// deleting by the UNINDEXED artifact_id column is a full scan.
//
// NOTE: users.email and shares.email need `COLLATE NOCASE`, which Drizzle cannot
// express; migrations/0001_init.sql is hand-edited for those two columns.
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    /** IdP name (or the sign-in default); refreshed on every sign-in. */
    name: text("name").notNull(),
    /** The name the user chose (PATCH /me); never touched by sign-in. */
    displayName: text("display_name"),
    role: text("role").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
    /** Bumped to end every session of the user (role change, link reset, P3 sync). */
    sessionEpoch: integer("session_epoch").notNull().default(0),
    /** MemberStatus (@oa/shared): active | suspended | removed. P3's sync sets it; sign-in refuses non-active. */
    status: text("status").notNull().default("active"),
    /**
     * A restriction cap (P3), from an admin's manual flag or from a restricted
     * Google group (sync keeps it, manual never lifts the group one). No CHECK:
     * 0008's precedent, an ADD COLUMN check needs a table rebuild.
     */
    restrictedManual: integer("restricted_manual").notNull().default(0),
    restrictedSync: integer("restricted_sync").notNull().default(0),
    /**
     * 1 only for a guest deactivated because their last share went (status
     * 'removed'): the one removal a new share undoes (putShare). An admin or
     * directory removal clears it, so that removal sticks (P3 T6). Its
     * CHECK (0 or 1) is inline in the ADD COLUMN (hand-edited migration): a
     * table-level check here would make drizzle-kit rebuild the table.
     */
    guestLapsed: integer("guest_lapsed").notNull().default(0),
    /**
     * When status last changed (ms; null = never). An OAuth grant issued at
     * or before it is refused, so a grant minted during a suspension, or
     * missed by the KV revocation, never survives an unsuspend (P3 T6).
     */
    statusChangedAt: integer("status_changed_at"),
    /**
     * 1 after an admin reset the user's Google link (resetIdentity): the next
     * directory users page that lists a Google user at this address relinks
     * this same row (applyUsers) instead of treating the address as recycled.
     * Cleared by whichever links the row first: that relink, or the user's
     * own Google sign-in (googleLinkStmts). Only read while the row has no
     * Google identity.
     */
    googleRelink: integer("google_relink").notNull().default(0),
  },
  () => [check("users_role_check", inList("role", RoleSchema.options))],
);

// P3: every artifact lives in a space. A personal space's id is its owner's
// user id - the id IS the ownership, the single source of truth (one row per
// user, created by the users_personal_space trigger), so today's installs map
// 1:1 with no access change. No FK on owner_user_id; removing a member deletes
// the space when it is empty, else re-points it at the instance owner. A
// personal space never has members, group mappings or all_members_role
// (migration triggers + a CHECK).
export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id"),
    /** The role every member gets in this shared space; null = none (P3 T9). */
    allMembersRole: text("all_members_role"),
    /**
     * Public links toggle (P3 T9): when 0 it refuses NEW public links only.
     * Existing public artifacts keep working (the toggle never revokes), and
     * moving a public artifact into this space rewrites it to team.
     * New rows default to 0 (fail closed); the 0009 backfill sets 1 on the
     * personal spaces that predate the toggle.
     */
    publicLinks: integer("public_links").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    // GET R.spaces: shared spaces by name, without walking personal ones.
    // Partial, so a user insert (its personal space) writes no index entry.
    index("spaces_kind_name_idx")
      .on(t.kind, t.name, t.id)
      .where(sql`${t.kind} = 'shared'`),
    check("spaces_kind_check", inList("kind", SpaceKindSchema.options)),
    check(
      "spaces_all_members_role_check",
      sql`${t.allMembersRole} is null or ${t.allMembersRole} in ('viewer', 'editor', 'manager')`,
    ),
    check("spaces_public_links_check", sql`${t.publicLinks} in (0, 1)`),
    // Personal spaces are one owner's: no all-members role.
    check(
      "spaces_personal_no_all_members_check",
      sql`${t.kind} = 'shared' or ${t.allMembersRole} is null`,
    ),
  ],
);

// Manual and sync roles are separate rows so a sync pass never overwrites an
// admin's manual grant; the effective role is the max over all sources.
export const spaceMembers = sqliteTable(
  "space_members",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId, t.source] }),
    // "Which shared spaces am I in?" (list scope=spaces): a scan otherwise.
    index("space_members_user_idx").on(t.userId),
    check("space_members_role_check", inList("role", SpaceRoleSchema.options)),
    check("space_members_source_check", inList("source", ["manual", "sync"])),
  ],
);

// A Google group mapped to a space role (P3 T9/T14). Keyed by the immutable
// group id, never the email.
export const groupMappings = sqliteTable(
  "group_mappings",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull(),
    groupEmail: text("group_email").notNull(),
    role: text("role").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.groupId] }),
    check("group_mappings_role_check", inList("role", SpaceRoleSchema.options)),
  ],
);

// "Every space" group mapping (Q5): applies to every shared space, including
// spaces created later, and never to a personal space. Keyed by group id.
export const orgGroupMappings = sqliteTable(
  "org_group_mappings",
  {
    groupId: text("group_id").primaryKey(),
    groupEmail: text("group_email").notNull(),
    role: text("role").notNull(),
  },
  (t) => [
    check(
      "org_group_mappings_role_check",
      inList("role", SpaceRoleSchema.options),
    ),
  ],
);

// A space member an admin edited by hand while sync was frozen (Team), first
// edit wins. kind: override (a synced row changed; manual_role is the manual
// row from before it, null: none, and the thaw puts it back), delete (an
// explicit removal: final, the manual row stays as it is), manual (a manual
// row on a pair with no synced row: kept). The first reconcile after sync
// returns derives the synced role again, audits the outcome and deletes the
// row (P3 T15).
export const frozenEdits = sqliteTable(
  "frozen_edits",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    /** override: the pair's manual role before the first frozen edit; null: none. */
    manualRole: text("manual_role"),
    kind: text("kind").notNull().default("override"),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    check(
      "frozen_edits_manual_role_check",
      sql`${t.manualRole} is null or ${t.manualRole} in ('viewer', 'editor', 'manager')`,
    ),
    check(
      "frozen_edits_kind_check",
      sql`${t.kind} in ('override', 'delete', 'manual')`,
    ),
  ],
);

// Groups whose members are capped at viewer on every surface (P3 T14).
export const restrictedGroups = sqliteTable("restricted_groups", {
  groupId: text("group_id").primaryKey(),
  groupEmail: text("group_email").notNull(),
  /** When the group was restricted (ms); null for rows written before P3 T9. */
  createdAt: integer("created_at"),
});

// Raw directory rows from the last successful read: a parent_ids list resolves
// nesting locally, and gen tags a sweep's generation (P3 T13/T14).
export const directoryGroups = sqliteTable(
  "directory_groups",
  {
    groupId: text("group_id").primaryKey(),
    email: text("email").notNull(),
    parentIds: text("parent_ids").notNull().default("[]"),
    gen: integer("gen").notNull().default(0),
  },
  (t) => [
    check("directory_groups_parent_ids_check", sql`json_valid(${t.parentIds})`),
  ],
);

export const directoryMembers = sqliteTable(
  "directory_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => directoryGroups.groupId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gen: integer("gen").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

// One row per directory key (cursor, customerId, health timestamps); a single
// PK read on the auth path (P3 T13).
export const directoryState = sqliteTable("directory_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    spaceId: text("space_id"),
    detail: text("detail").notNull().default("{}"),
  },
  (t) => [index("audit_events_at_idx").on(t.at)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    /**
     * The space this artifact belongs to (P3). Never null in practice: the
     * artifacts_space_default AFTER INSERT trigger fills it with owner_id for
     * old code that does not write it (rollback-safe), the BEFORE UPDATE guard
     * refuses NULL, and the backfill set it for every pre-spaces row. Nullable
     * here because ADD COLUMN cannot add NOT NULL without a default (0008).
     */
    spaceId: text("space_id").references(() => spaces.id),
    title: text("title").notNull(),
    description: text("description"),
    format: text("format").notNull(),
    visibility: text("visibility").notNull().default("private"),
    currentVersion: integer("current_version").notNull().default(0),
    capabilities: text("capabilities")
      .notNull()
      .default('{"db":false,"viewer":false,"storage":false}'),
    allowAnonymousWrites: integer("allow_anonymous_writes")
      .notNull()
      .default(0),
    /**
     * #681: who may change live data, "viewers" (anyone who can view) or
     * "editors" (editor level and up). The CHECK is inline in 0014's ADD
     * COLUMN. allow_anonymous_writes is kept in step (viewers 1, editors 0)
     * for one release, so a rollback keeps public pages as they were.
     */
    dataWriters: text("data_writers").notNull().default("viewers"),
    hasThumbnail: integer("has_thumbnail").notNull().default(0),
    /** The version thumbs/{id}.webp depicts; null = unknown (pre-0005) or none. */
    thumbnailVersion: integer("thumbnail_version"),
    lastAgentName: text("last_agent_name"),
    lastAgentVersion: text("last_agent_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    /** Failed purge runs so far; each failure defers the next try (cron backoff). */
    purgeAttempts: integer("purge_attempts").notNull().default(0),
    /** Not retried by the purge cron before this time (ms); null = due. */
    purgeAfter: integer("purge_after"),
  },
  (t) => [
    // Partial indexes only (#248): every index entry is a billed D1 row write,
    // and each publish bumps updated_at. Live rows: the *_live pair. Deleted
    // rows: the owner's trash listing and the purge cron.
    index("artifacts_owner_deleted_idx")
      .on(t.ownerId, t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    index("artifacts_deleted_idx")
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    index("artifacts_visibility_updated_live_idx")
      .on(t.visibility, t.updatedAt)
      .where(sql`${t.deletedAt} is null`),
    index("artifacts_owner_updated_live_idx")
      .on(t.ownerId, t.updatedAt)
      .where(sql`${t.deletedAt} is null`),
    // A space's live artifacts (list scope=space, public-links-off, closeSpace).
    index("artifacts_space_live_idx")
      .on(t.spaceId)
      .where(sql`${t.deletedAt} is null`),
    check(
      "artifacts_allow_anon_check",
      sql`${t.allowAnonymousWrites} in (0, 1)`,
    ),
    check("artifacts_thumbnail_check", sql`${t.hasThumbnail} in (0, 1)`),
    check(
      "artifacts_capabilities_json_check",
      sql`json_valid(${t.capabilities})`,
    ),
    check("artifacts_format_check", inList("format", FORMATS)),
    check(
      "artifacts_visibility_check",
      inList("visibility", VisibilitySchema.options),
    ),
  ],
);

export const versions = sqliteTable(
  "versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    entry: text("entry").notNull(),
    // JSON: [{path,key,size,contentType}]
    manifest: text("manifest").notNull().default("[]"),
    language: text("language"),
    message: text("message"),
    agentName: text("agent_name"),
    agentVersion: text("agent_version"),
    // The grant or token that published this version: `g:<grantId>` or
    // `t:<tokenId>` (NULL: a session, or written before 0012).
    agentVia: text("agent_via"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    textIndexed: integer("text_indexed").notNull().default(0),
    /**
     * 1: the DO dropped this version's index job after INDEX_MAX_ATTEMPTS
     * (index_failed), so the lost-job sweep skips it. Undelete resets it.
     */
    indexFailed: integer("index_failed").notNull().default(0),
    /** 1: this version's server thumbnail job ended no_thumb; the pdf sweep skips it. */
    thumbFailed: integer("thumb_failed").notNull().default(0),
    // NULL only on rows written before 0002 (or by pre-0002 code): readers fall
    // back to artifacts.format.
    format: text("format"),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.version] }),
    check("versions_manifest_json_check", sql`json_valid(${t.manifest})`),
    check("versions_format_check", inList("format", FORMATS)),
  ],
);

export const shares = sqliteTable(
  "shares",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.email] }),
    index("shares_email_idx").on(t.email),
    check("shares_role_check", inList("role", ShareRoleSchema.options)),
  ],
);

export const tokens = sqliteTable("tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  // Versions published with this token (+1 in the publish batch).
  versionsPublished: integer("versions_published").notNull().default(0),
});

// Per OAuth grant, what the grant record (OAUTH_KV) doesn't hold: the owner's
// label and usage. Created on first use, label or publish (upserts); the KV
// grant list stays the source of which grants exist.
export const agentGrants = sqliteTable(
  "agent_grants",
  {
    grantId: text("grant_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label"),
    // Written at most once a minute (conditional upsert, waitUntil).
    lastUsedAt: integer("last_used_at"),
    clientVersion: text("client_version"),
    versionsPublished: integer("versions_published").notNull().default(0),
  },
  // Member removal deletes by user_id.
  (t) => [index("agent_grants_user_idx").on(t.userId)],
);

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  r2Key: text("r2_key").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
  path: text("path").notNull(),
  createdAt: integer("created_at").notNull(),
  consumed: integer("consumed").notNull().default(0),
  // set once the signed PUT stored exactly `size` bytes
  receivedAt: integer("received_at"),
});

// ids handed out by create_upload before the first publish
export const reservedArtifacts = sqliteTable("reserved_artifacts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Small D1 counters and markers (e.g. daily OAuth client registrations), kept
// out of KV because KV writes are the scarcer Free-plan quota.
export const counters = sqliteTable("counters", {
  key: text("key").primaryKey(),
  n: integer("n").notNull(),
  day: text("day").notNull(),
});

// The only link between a person and an IdP account (P2). For Google,
// subject = the OIDC `sub` = the Directory API user id, so P3's sync and
// sign-in meet on one row. Access sign-in stays email-keyed (no rows).
export const identities = sqliteTable(
  "identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    /** The verified tenant (Google hd) at link time. */
    tenant: text("tenant").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    /**
     * 1 once the directory's user id is linked (P3 T12/T14). A synced user is
     * one with a bound Google identity while a directory is connected; the
     * staleness rule keys off it (P3 T18). No CHECK, as for users.status.
     */
    directoryBound: integer("directory_bound").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    uniqueIndex("identities_user_provider").on(t.userId, t.provider),
  ],
);

// Emailed one-time sign-in codes (P2), one row per request so a stranger's
// request can't replace a victim's pending code. No plaintext: email_key and
// code_hash are HMACs under deriveKey("oa:login-codes").
export const loginCodes = sqliteTable(
  "login_codes",
  {
    emailKey: text("email_key").notNull(),
    requestId: text("request_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.emailKey, t.requestId] })],
);
