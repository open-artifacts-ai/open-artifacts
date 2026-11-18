import {
  RoleSchema,
  SpaceKindSchema,
  SpaceRoleSchema,
  STORED_FORMATS,
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
    /**
     * When an admin last invited this address (ms; null = never invited by
     * inviteMember: directory-synced, share-guest and code-joined rows).
     * Only a never-signed-in row with this set lapses (#2520).
     */
    invitedAt: integer("invited_at"),
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
    /**
     * 1 while the row is removed because directory sync removed it (a
     * directory_* reason in setUserStatus). Any other status change and a
     * restore clear it. Restore refuses it (409 directory_managed) while
     * Google sync is on: the next sync would remove them again.
     */
    removedBySync: integer("removed_by_sync").notNull().default(0),
    /**
     * When an admin erased this removed person (ms; null = never, #1204).
     * The row stays (its id is authorship), under the placeholder address
     * with no name. Never cleared: an erased row is never restored.
     */
    erasedAt: integer("erased_at"),
    /**
     * 0 after the person turned off comment emails (#1467), in the dashboard
     * or by the unsubscribe link in one. New rows default to on.
     */
    commentEmail: integer("comment_email").notNull().default(1),
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
    // The credential behind a user's action (#803): its kind (session, pat,
    // oauth_grant, system) and id (session issue key, PAT id, grant id),
    // never the token. Null outside a request (cron, sync, alarms).
    actorCredKind: text("actor_cred_kind"),
    actorCredId: text("actor_cred_id"),
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
    /**
     * #682: the built-in comments layer, 1 on (the default) or 0 off. The
     * CHECK is inline in 0025's ADD COLUMN, as for data_writers.
     */
    comments: integer("comments").notNull().default(1),
    /**
     * #2080: who may post when comments are on: "everyone" (the column default,
     * so every artifact from before keeps today's behavior) or "signed-in"
     * (set on insert for new artifacts).
     */
    commentAccess: text("comment_access").notNull().default("everyone"),
    /**
     * #1100: 1 when the artifact is a collaborative doc. Its `format` column
     * stays "markdown" (the stored text, rendered as markdown until the doc
     * editor lands) and the API reports format "doc". Set on create only:
     * other artifacts never become docs. The CHECK is inline in 0034's ADD
     * COLUMN, as for comments.
     */
    doc: integer("doc").notNull().default(0),
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
    // A shared space's trash (R.trash), newest deleted first.
    index("artifacts_space_deleted_idx")
      .on(t.spaceId, t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    check(
      "artifacts_allow_anon_check",
      sql`${t.allowAnonymousWrites} in (0, 1)`,
    ),
    check("artifacts_thumbnail_check", sql`${t.hasThumbnail} in (0, 1)`),
    check(
      "artifacts_capabilities_json_check",
      sql`json_valid(${t.capabilities})`,
    ),
    check("artifacts_format_check", inList("format", STORED_FORMATS)),
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
    // `t:<tokenId>` (NULL: a session, or written before 0012; `r:`: a private
    // label scrubbed when its publisher's row was deleted, SCRUBBED_VIA).
    agentVia: text("agent_via"),
    // #1968: JSON {identityId, namespace, name, kind} of the bus session the
    // publishing request proved (#1822), set by the server only. NULL: a web
    // publish, an unlinked agent, or a row from before 0031. Never in an API payload.
    agentIdentity: text("agent_identity"),
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
    // #1100: JSON {kind: auto|named|before_agent|restore, by?: {...}} for a
    // doc version saved by the room. NULL: not a doc, or a doc's first version.
    docSave: text("doc_save"),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.version] }),
    check("versions_manifest_json_check", sql`json_valid(${t.manifest})`),
    check("versions_format_check", inList("format", STORED_FORMATS)),
  ],
);

/**
 * #1100: everyone who edited a doc since its previous version, people and
 * agents, written with the version row by the doc room. `key` is the user id
 * (a person), "anon" (an anonymous editor; no address is kept) or the agent's
 * key. Agent fields mirror versions.agent_*: the display layer applies the
 * same private-label rule (isPrivateAgent) on `agent_via`.
 */
export const versionContributors = sqliteTable(
  "version_contributors",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    agentName: text("agent_name"),
    agentVersion: text("agent_version"),
    agentVia: text("agent_via"),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.version, t.kind, t.key] }),
    index("version_contributors_user_idx").on(t.userId),
    check(
      "version_contributors_kind_check",
      inList("kind", ["person", "agent"]),
    ),
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
    /** 1 with role 'viewer': a "commenter" share (db/share-role.ts maps it). */
    canComment: integer("can_comment").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.email] }),
    index("shares_email_idx").on(t.email),
    check("shares_role_check", inList("role", ["viewer", "editor"])),
  ],
);

/**
 * The open asks of every artifact, for the library (#1623): `asksForYou` and
 * the needs_answer filter. The artifact's Durable Object stays the source of
 * truth; the comments service writes this table after each DO write, and a
 * comments list read repairs it (reconcileAsks). One row per ask and person:
 * `addressee` is the asked user, or the member whose agent was asked.
 * `open` is 0 once the ask is answered or its thread resolved.
 */
export const artifactAsks = sqliteTable(
  "artifact_asks",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    commentId: text("comment_id").notNull(),
    addressee: text("addressee").notNull(),
    open: integer("open").notNull(),
    answered: integer("answered").notNull().default(0),
    // #2512: what the inbox shows, copied from the ask when it is indexed.
    // Null on a row from before: the inbox repairs it from the DO (reconcileAsks).
    question: text("question"),
    // The asking comment's StoredActor, as JSON (read back through the comments face builder).
    asker: text("asker"),
    askedAt: text("asked_at"),
    // 1 when the ask needs a passkey or names a risky action (#2263).
    confirm: integer("confirm"),
    // 1 while the ask is held for the addressed agent's person to allow (#2577): no question, no inbox row.
    held: integer("held").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.commentId, t.addressee] }),
    index("artifact_asks_thread_idx").on(t.artifactId, t.threadId),
    index("artifact_asks_open_idx")
      .on(t.addressee, t.artifactId)
      .where(sql`${t.open} = 1`),
  ],
);

// #2577: someone else's agent was asked. The comment posts; its delivery to the
// receiver's agents is held until the receiver allows it. One row per
// (receiver, sender, artifact); the DO holds the facts (the held targets and
// the words). D1 keeps ids, counts and times only, never the words.
export const heldRequests = sqliteTable(
  "held_requests",
  {
    id: text("id").primaryKey(),
    receiverId: text("receiver_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderId: text("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    lastAt: integer("last_at").notNull(),
    // "Not now": the receiver hears of this sender's requests again after this (ms).
    quietUntil: integer("quiet_until"),
  },
  (t) => [
    uniqueIndex("held_requests_pair_idx").on(
      t.receiverId,
      t.senderId,
      t.artifactId,
    ),
    index("held_requests_receiver_idx").on(t.receiverId, t.lastAt),
  ],
);

// One row per held comment and agent of the receiver. `way` is how it got in.
export const heldRequestItems = sqliteTable(
  "held_request_items",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => heldRequests.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    commentId: text("comment_id").notNull(),
    agentKey: text("agent_key").notNull(),
    way: text("way").notNull(),
    // held | allowed | lapsed | withdrawn
    state: text("state").notNull().default("held"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("held_items_comment_idx").on(t.commentId, t.agentKey),
    index("held_items_request_idx").on(t.requestId, t.state),
    index("held_items_expiry_idx").on(t.state, t.expiresAt),
    check("held_items_way", inList("way", ["mention", "reply", "ask", "page"])),
    check(
      "held_items_state",
      inList("state", ["held", "allowed", "lapsed", "withdrawn"]),
    ),
  ],
);

// #2577: whose requests a person's agents take without asking (the "listens
// to" list). Never trusted from the row alone: every use re-checks that the
// member is still on the team, can still edit the page, and that the page is
// not open to guests or to anyone with the link (services/agent-requests.ts).
export const agentListens = sqliteTable(
  "agent_listens",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    artifactId: text("artifact_id").references(() => artifacts.id, {
      onDelete: "cascade",
    }),
    // scope "space": the shared space whose pages it covers (while a page is in it).
    spaceId: text("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    until: integer("until").notNull(),
    createdVia: text("created_via").notNull(),
    createdAt: integer("created_at").notNull(),
    removedAt: integer("removed_at"),
  },
  (t) => [
    index("agent_listens_owner_idx").on(t.ownerId, t.memberId),
    check("agent_listens_scope", inList("scope", ["page", "space", "all"])),
  ],
);

// #2512 S2: the For you inbox's stored items (mentions and updates). Asks are
// not here: they come from artifact_asks. `key` makes a write idempotent: one
// row per (user, key), e.g. "reply:<comment id>", "share:<created at>".
export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    level: text("level").notNull(),
    key: text("key").notNull(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    commentId: text("comment_id"),
    // The actor's StoredActor (or a guest/user stub), as JSON.
    actor: text("actor").notNull(),
    excerpt: text("excerpt").notNull(),
    // A mention's agent ("{author} mentioned {agent} on {page}"); null otherwise.
    agentName: text("agent_name"),
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
  },
  (t) => [
    uniqueIndex("inbox_items_key_idx").on(t.userId, t.key),
    index("inbox_items_read_idx").on(t.userId, t.readAt),
    index("inbox_items_created_idx").on(t.userId, t.createdAt),
    check(
      "inbox_items_kind",
      inList("kind", ["mention", "reply", "comment", "share", "decision"]),
    ),
    check("inbox_items_level", inList("level", ["needs_you", "update"])),
  ],
);

// #2263 passkeys: one row per WebAuthn credential a member registered. It can
// confirm a pick only once `created_at` is 24 h old (services/passkeys.ts).
// public_key is the credential's COSE key, base64url; sign_count is the last
// counter the authenticator showed (0 stays 0 on authenticators without one).
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    alg: integer("alg").notNull(),
    signCount: integer("sign_count").notNull().default(0),
    label: text("label").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    // Set when a re-auth alone asked to remove it: it still counts (confirm,
    // challenges) until this time, 24 h later; a passkey assertion removes it
    // at once, and the member can cancel.
    removalAt: integer("removal_at"),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

// #2263 single-use WebAuthn challenges, one live row per (user, scope): a new
// challenge for the same scope replaces (voids) the old one. `binding` is what
// the challenge was issued for (the picked option, the exact settings change,
// the passkey to remove); a verify consumes it with a compare-and-set on
// used_at before anything is recorded.
export const pickAssertions = sqliteTable(
  "pick_assertions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    binding: text("binding").notNull(),
    challenge: text("challenge").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("pick_assertions_scope_idx").on(t.userId, t.scope),
    check(
      "pick_assertions_kind_check",
      sql`${t.kind} in ('register', 'pick', 'settings', 'remove')`,
    ),
  ],
);

// #2512 S4: a member's notification choices. No row: the defaults (browser
// off, quiet hours off, time zone UTC, lock screen hides details). quiet_*
// are both set or both null; time_zone is an IANA name (checked on write).
export const notificationPrefs = sqliteTable("notification_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  needsYouBrowser: integer("needs_you_browser").notNull().default(0),
  updatesBrowser: integer("updates_browser").notNull().default(0),
  browserAllAsks: integer("browser_all_asks").notNull().default(0),
  quietStart: text("quiet_start"),
  quietEnd: text("quiet_end"),
  timeZone: text("time_zone").notNull().default("UTC"),
  lockDetail: integer("lock_detail").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

// #2512 S4: what a member muted from browser notifications. A mute stops push
// only; the items stay in the list. kind "agent": target_id is the agent's bus
// identity id and name its name when muted; kind "page": target_id is the
// artifact id (its name is read live).
export const inboxMutes = sqliteTable(
  "inbox_mutes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    name: text("name"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.targetId] }),
    check("inbox_mutes_kind", inList("kind", ["agent", "page"])),
  ],
);

// #2263 a member's "ask for a passkey to approve" switches. No row: the
// defaults (every action on, every pick off). ask_command is always 1.
export const passkeySettings = sqliteTable("passkey_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  askMerge: integer("ask_merge").notNull().default(1),
  askDeploy: integer("ask_deploy").notNull().default(1),
  askDelete: integer("ask_delete").notNull().default(1),
  askShare: integer("ask_share").notNull().default(1),
  askPublic: integer("ask_public").notNull().default(1),
  askCommand: integer("ask_command").notNull().default(1),
  everyPick: integer("every_pick").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

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

// #1291 the bus: one row per machine a member approved through the device
// flow. token_hash is the sha256 of its bus-only `oa_machine_...` token (the
// token itself is never stored). Revoked rows stay (revoked_at) so the
// Machines list can show them; erase deletes them.
export const busMachines = sqliteTable(
  "bus_machines",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("bus_machines_user_idx").on(t.userId, t.revokedAt)],
);

// #2552 the latest update report of each machine (BUS_CAPS.runVersion): one
// row, replaced by the next report. The bus hub writes it; Settings > Machines
// reads it later. switching_at / last_hello_at / stopped_at carry "the bus
// stopped": a machine whose latest report is `switching` and that has not said
// hello for 5 minutes gets stopped_at (no notice yet).
export const busMachineUpdates = sqliteTable("bus_machine_updates", {
  machineId: text("machine_id")
    .primaryKey()
    .references(() => busMachines.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  fromVersion: text("from_version").notNull(),
  toVersion: text("to_version").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail"),
  rescueVersion: integer("rescue_version").notNull().default(0),
  reportedAt: integer("reported_at").notNull(),
  switchingAt: integer("switching_at"),
  lastHelloAt: integer("last_hello_at"),
  stoppedAt: integer("stopped_at"),
});

// #1291 pending device-flow codes, 10 minutes each. device_code_hash is the
// sha256 of the CLI's polling secret; user_code is the short code the person
// sees on the approval page (useless without a session that can connect).
// user_id/approved_at or denied_at are set by the approval page; the poll
// that redeems an approved code deletes the row in the same batch that
// inserts the machine.
export const busDeviceCodes = sqliteTable(
  "bus_device_codes",
  {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    userCode: text("user_code").notNull().unique(),
    label: text("label").notNull(),
    ipTag: text("ip_tag").notNull(),
    // Where the request came from, shown on the confirm screen: the
    // two-letter country (cf.country) and a readable network name
    // (cf.asOrganization), never the IP or an ASN number. Null: unknown.
    originCountry: text("origin_country"),
    originNetwork: text("origin_network"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastPollAt: integer("last_poll_at"),
    userId: text("user_id").references(() => users.id),
    approvedAt: integer("approved_at"),
    deniedAt: integer("denied_at"),
  },
  (t) => [
    index("bus_device_codes_expires_idx").on(t.expiresAt),
    index("bus_device_codes_ip_idx").on(t.ipTag, t.expiresAt),
    index("bus_device_codes_user_idx").on(t.userId),
  ],
);

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
  // sha256 (hex) of the bytes the PUT stored; copied into the manifest digest at publish (#1490)
  digest: text("digest"),
  // Client-declared checksum; digest is populated only after R2 verifies the PUT.
  expectedSha256: text("expected_sha256"),
});

// ids handed out by create_upload before the first publish
export const reservedArtifacts = sqliteTable("reserved_artifacts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

/**
 * Outside share emails by the sending message id (#2650), so a bounce or
 * complaint event can be traced to the member who sent it. Never the address.
 * Old rows are swept after 30 days.
 */
export const shareEmailMessages = sqliteTable("share_email_messages", {
  messageId: text("message_id").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  /** When a terminal bounce on this message was reported (#2650): three in 7 days pause the sender. */
  bouncedAt: integer("bounced_at"),
});

/**
 * The platform's event ids this install has already processed (#2650), so an
 * event served again (an ack that failed) is a no-op. Swept after 30 days; the
 * platform keeps unacknowledged events 14.
 */
export const shareEmailEventsSeen = sqliteTable("share_email_events_seen", {
  eventId: text("event_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

/**
 * "Don't email me again" (#2590): an address that opted out of outside share
 * emails, by the SHA-256 of its normalized form (never the address itself).
 */
export const emailOptouts = sqliteTable("email_optouts", {
  addressHash: text("address_hash").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

/** A member whose outside share emails are paused until `untilAt` (ms): a bounce or complaint on one of them (#2650). */
export const shareEmailPauses = sqliteTable("share_email_pauses", {
  userId: text("user_id").primaryKey(),
  untilAt: integer("until_at").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// The OAuth provider's key-value records (grants, tokens, clients, consent
// transactions, OIDC replay markers) when OAUTH_STORE is dual or d1
// (mcp/oauth-store.ts): KV's shape in the install's own D1. `key` uses the
// BINARY collation, so listing by prefix walks KV's byte order. WITHOUT ROWID
// (hand-edited into 0020): one b-tree, one row written per put. expires_at is
// unix seconds (null: never); a read treats a row past it as missing, and the
// nightly cron deletes such rows. metadata is the KV key metadata (JSON).
export const oauthKv = sqliteTable(
  "oauth_kv",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at"),
    metadata: text("metadata"),
  },
  (t) => [
    index("oauth_kv_exp")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

// Self-serve billing (hosted only): who was a creator in each UTC calendar
// month, the list behind each bill (billing/creators.ts CREATOR). One row per
// user and month, written once (insert or ignore) by a version publish or a
// live-data write; restores, moves and transfers never write one. user_id is
// the opaque per-install id billing receives (never an email).
export const creatorMonths = sqliteTable(
  "creator_months",
  {
    month: text("month").notNull(),
    userId: text("user_id").notNull(),
    /** What made them a creator first this month: "version" or "data". */
    source: text("source").notNull(),
    firstAt: integer("first_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.month, t.userId] }),
    check(
      "creator_months_source_check",
      sql`${t.source} in ('version', 'data')`,
    ),
  ],
);

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

// Collaboration suite (#1292): an agent address in the member's bus follows
// an artifact. Read access is checked at follow time and again per notice; a
// follow that fails it then is deleted. Soft delete removes an artifact's
// follows; purge and the user cascade cover the rest. last_notice_at: when
// the last `changed` notice to this address was due (ms), for the one per
// minute window.
export const follows = sqliteTable(
  "follows",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    agentName: text("agent_name").notNull(),
    createdAt: integer("created_at").notNull(),
    lastNoticeAt: integer("last_notice_at"),
  },
  (t) => [
    primaryKey({
      columns: [t.userId, t.artifactId, t.namespace, t.agentName],
    }),
    index("follows_artifact_idx").on(t.artifactId),
    index("follows_address_idx").on(t.userId, t.namespace, t.agentName),
  ],
);

// The member's "agents that get share notices" (#1292): bus addresses, none
// by default (a `shared` notice with none picked is dropped).
export const shareNoticeAgents = sqliteTable(
  "share_notice_agents",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    agentName: text("agent_name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.namespace, t.agentName] })],
);

/**
 * FREE_DATA_DAILY_WRITES_TOTAL (billing/caps.ts): the install's live-data
 * writes in one UTC day. A single row (`id` 1); `day` is the UTC day number
 * (ms / 86_400_000) its `n` counts, and a write on a later day restarts n.
 */
export const dataWritesTotal = sqliteTable("data_writes_total", {
  id: integer("id").primaryKey(),
  day: integer("day").notNull(),
  n: integer("n").notNull(),
});

/**
 * Pictures on comments (#2508). A row is a reservation (received_at null), then
 * an uploaded picture, then attached to a comment (comment_id set). The bytes
 * are in R2 under r2_key, private: only the artifact-authorized route serves
 * them. thread_id lets a deleted thread take its pictures with it.
 */
export const commentPictures = sqliteTable(
  "comment_pictures",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    userId: text("user_id").notNull(),
    /** The type the reservation asked for, then the checked one. */
    type: text("type").notNull(),
    r2Key: text("r2_key").notNull(),
    /** Declared at reserve; the stored size after the PUT. */
    bytes: integer("bytes").notNull(),
    w: integer("w").notNull().default(0),
    h: integer("h").notNull().default(0),
    expectedSha256: text("expected_sha256"),
    alt: text("alt"),
    commentId: text("comment_id"),
    threadId: text("thread_id"),
    createdAt: integer("created_at").notNull(),
    /** Null until the PUT stored the bytes; -1 while one is in flight. */
    receivedAt: integer("received_at"),
  },
  (t) => [
    index("comment_pictures_artifact_idx").on(t.artifactId, t.commentId),
    index("comment_pictures_user_idx").on(t.userId, t.createdAt),
    index("comment_pictures_thread_idx").on(t.threadId),
  ],
);
