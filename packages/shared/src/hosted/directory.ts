// Hosted M1 directory sync (P3) and audit. Identity linking is
// identities(provider = "google", subject = DirUser.id): no shape carries a
// users.directory_id. Health comes from the directory binding plus those links.
import { z } from "zod";
import {
  DirectoryModeSchema,
  GroupRefSchema,
  SyncStateSchema,
} from "./core.js";

/** A Google Directory user as sync reads it. `id` equals the Google sign-in `sub`. */
export const DirUserSchema = z.object({
  id: z.string(),
  primaryEmail: z.string(),
  suspended: z.boolean(),
  /** From the showDeleted listing or a DELETE_USER event. */
  deleted: z.boolean(),
});
export type DirUser = z.infer<typeof DirUserSchema>;

/** The install's directory connection (one per install). */
export const DirectoryBindingSchema = z.object({
  provider: z.literal("google"),
  /** Google customer id recorded at connect; every sync checks it (fail closed). */
  customerId: z.string(),
  domain: z.string(),
  connectedBy: z.string(),
  connectedAt: z.string(),
});
export type DirectoryBinding = z.infer<typeof DirectoryBindingSchema>;

/** A sweep held for the owner (would remove > 50% of a group, min 5, or an empty listing). */
export const HeldSweepSchema = GroupRefSchema.extend({
  wouldRemove: z.number().int(),
  members: z.number().int(),
  since: z.string(),
});
export type HeldSweep = z.infer<typeof HeldSweepSchema>;

/**
 * GET R.directory (org owner, admin) -> SyncStatus. Also the 202 body of
 * R.directorySync and R.directoryHeldConfirm. Failure is fail static:
 * suspensions and deletions always apply, a partial read removes nobody, a
 * customer or domain mismatch fails closed. Unhealthy for 1 h: banner
 * (Me.instance.directory.banner); for 24 h: owner email and sessions capped
 * at 24 h. No stale cutoff: staleAt (7 days after lastSuccessAt) is informational.
 */
export const SyncStatusSchema = z.object({
  mode: DirectoryModeSchema,
  binding: DirectoryBindingSchema.nullable(),
  /** Null when mode is off. */
  healthy: z.boolean().nullable(),
  /** SyncStateSchema: ok | backoff | auth_failed | customer_mismatch | scope_missing | never. */
  state: SyncStateSchema,
  /** First failure of the current outage, else null. */
  unhealthySince: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.object({ at: z.string(), message: z.string() }).nullable(),
  nextRunAt: z.string().nullable(),
  /** lastSuccessAt + 7 days once that has passed, else null. Informational: access is unchanged when stale. */
  staleAt: z.string().nullable(),
  /** Owner alert sent for the current outage. */
  alertedAt: z.string().nullable(),
  /** Set when the token's customer differs from binding.customerId. */
  customerMismatch: z
    .object({ expected: z.string(), actual: z.string() })
    .nullable(),
  held: z.array(HeldSweepSchema),
  /**
   * state pending_confirm only (else null / false / null): active in-domain
   * directory users the binding pass would link or create, counted over at
   * most one page; `pendingCountCapped` true means "500+". Defaulted so a
   * payload from before the confirm step still parses.
   */
  pendingCount: z.number().int().nullable().default(null),
  pendingCountCapped: z.boolean().default(false),
  /** When the unconfirmed connection is dropped (24 h after consent). */
  pendingExpiresAt: z.string().nullable().default(null),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/** GET R.directoryGroups?q&cursor (org admin) -> Page<DirectoryGroup> (live lookup, rate limited). */
export const DirectoryGroupSchema = z.object({
  groupId: z.string(),
  email: z.string(),
  name: z.string(),
  memberCount: z.number().int().nullable(),
});
export type DirectoryGroup = z.infer<typeof DirectoryGroupSchema>;
export const DirectoryGroupsQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
});
export type DirectoryGroupsQuery = z.infer<typeof DirectoryGroupsQuerySchema>;

/**
 * `?error=` on /settings/directory after R.directoryCallback refuses.
 * not_super_admin: the connecting account isn't a super admin (partial
 * listings look complete); domain_mismatch: hd/domains.list doesn't match the
 * install's domain; customer_mismatch: a reconnect to a different customer;
 * scopes: not every scope granted; denied: consent declined; expired: state
 * too old; failed: anything else. Success: `?connected=1`.
 */
export const DirectoryConnectErrorSchema = z.enum([
  "not_super_admin",
  "domain_mismatch",
  "customer_mismatch",
  "scopes",
  "denied",
  "expired",
  "failed",
]);
export type DirectoryConnectError = z.infer<typeof DirectoryConnectErrorSchema>;

/** Why a user's status changed (setUserStatus `why`, audit detail). */
export const AuditReasonSchema = z.enum([
  "directory_suspend",
  "directory_unsuspend",
  "directory_delete",
  "directory_new_id",
  "directory_stale",
  "admin_suspend",
  "admin_remove",
  "admin_restore",
]);
export type AuditReason = z.infer<typeof AuditReasonSchema>;

export const AuditActionSchema = z.enum([
  "auth.signin",
  "space.create",
  "space.update",
  "space.public_links",
  "space.delete",
  "space.member.add",
  "space.member.remove",
  "space.member.role",
  "space.admin_self_add",
  "mapping.set",
  "mapping.remove",
  "restricted.set",
  "restricted.remove",
  "artifact.move",
  "artifact.transfer",
  "artifact.share",
  "artifact.unshare",
  "artifact.visibility",
  "user.status",
  "user.role",
  "identity.reset",
  "directory.connect",
  "directory.disconnect",
  "directory.sync",
  "directory.sync.failed",
  "directory.stale",
  "directory.sweep.held",
  "directory.sweep.confirmed",
  "directory.break_glass",
  "features.change",
  "settings.space_manager_mappings",
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/** GET R.audit?cursor&limit (org owner, admin) -> Page<AuditEvent>; R.auditExport is NDJSON of the same. */
export const AuditEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({
    kind: z.enum(["user", "sync", "system"]),
    id: z.string().nullable(),
    email: z.string().nullable(),
  }),
  action: AuditActionSchema,
  target: z.object({
    /** "group" ids are Google group ids. */
    type: z.enum([
      "space",
      "artifact",
      "user",
      "mapping",
      "group",
      "directory",
    ]),
    id: z.string(),
  }),
  spaceId: z.string().nullable(),
  reason: AuditReasonSchema.nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
