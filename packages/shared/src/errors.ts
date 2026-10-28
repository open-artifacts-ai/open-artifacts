import { z } from "zod";

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "csrf",
  "not_found",
  "conflict",
  "too_large",
  "rate_limited",
  "quota_exceeded",
  "capability_denied",
  "data_editors_only",
  "internal",
  // Hosted M1 (packages/shared/HOSTED_CONTRACT.md).
  "space_forbidden",
  "space_personal",
  "space_not_empty",
  "public_links_off",
  "use_move",
  "invalid_successor",
  "member_active",
  "directory_sync_off",
  "turnstile_failed",
  "turnstile_required",
  "code_unavailable",
  "reauth_required",
  "restrict_admin",
  "directory_mapping_off",
  "member_synced",
  "owner_only",
  "break_glass_required",
  // Publish format guard.
  "unsupported_format",
  "binary_entry",
  "space_name_reserved",
  "invite_unreachable",
  // Runtime data query.
  "cursor_stale",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const STATUS_FOR: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  quota_exceeded: 503,
  capability_denied: 403,
  /** A data write by a caller below editor on an artifact whose dataWriters is "editors" (#681). */
  data_editors_only: 403,
  internal: 500,
  /** Publish or move into a space the caller may not publish to (also capped callers creating). */
  space_forbidden: 403,
  /** A personal space as a move or bulk-transfer target, or as a spaces-route target. */
  space_personal: 400,
  /** DELETE a space that still holds artifacts (trash included). */
  space_not_empty: 409,
  /** Make an artifact public (publish or PATCH visibility) in a space whose publicLinks is off. */
  public_links_off: 403,
  /** PublishInput.spaceId given with the id of an existing artifact: use R.moveArtifact. */
  use_move: 400,
  /** Transfer successor is not an active, non-guest, non-restricted member. */
  invalid_successor: 400,
  /** Departed-person transfer on a member who is still active. */
  member_active: 409,
  /** Group mapping or restricted-group change while directory sync is off or frozen. */
  directory_sync_off: 409,
  /** POST AUTH.codeRequest with a missing or rejected Turnstile token. */
  turnstile_failed: 403,
  /** POST AUTH.codeRequest without a token while Turnstile is configured; details { field: "turnstile", required: true }. */
  turnstile_required: 400,
  /** Code sign-in can't run on this install: SESSION_SECRET is under 32 characters, so the code keys can't be derived. */
  code_unavailable: 503,
  /** Break-glass directory routes: the stale org owner needs a fresh Google sign-in (10 min). */
  reauth_required: 401,
  /** PUT R.memberRestricted(id) on an org owner or admin: they can't be restricted. */
  restrict_admin: 400,
  /** A space manager (not an org admin) adds or changes a space's group mapping (PUT) while Settings.spaceManagerMappings is off. Listing and removing stay allowed. */
  directory_mapping_off: 403,
  /** DELETE R.spaceMember on a synced-only row while directory sync is live: remove them from the Google group, or change their role. */
  member_synced: 409,
  /** Resetting or unlinking an org admin's Google identity: only the org owner may (it signs a peer admin out). */
  owner_only: 403,
  /** GET R.me for the org owner refused by a directory customer_mismatch; details BreakGlassRequiredDetails { fresh }. */
  break_glass_required: 401,
  /** Publish with no `format` whose entry name implies none and whose bytes aren't text (details { path, reason: "no_viewer" }), or any HEIC/HEIF entry (details { path, reason: "heic" }, HEIC_MESSAGE). */
  unsupported_format: 400,
  /** The entry's content doesn't fit its format (binary as code, markdown or html; a pdf without %PDF; an image without its extension's signature, an .svg without an <svg> root, or an image upload declared as another type); details { path, reason } (sniff.ts EntryRefusal). */
  binary_entry: 400,
  /** POST R.spaces or a PATCH R.space rename to "Personal" (trimmed, any case); details { field: "name" }, message SPACE_NAME_RESERVED_MESSAGE. */
  space_name_reserved: 400,
  /** POST R.members (invite) for an address no sign-in method this install offers could ever admit; details InviteUnreachableDetails, message INVITE_UNREACHABLE_MESSAGE[reason]. Nothing is created. */
  invite_unreachable: 400,
  /** db.query cursor whose anchor doc changed since the page was read (long sort values only): restart without a cursor. */
  cursor_stale: 409,
};

/**
 * Why an invite is refused (400 invite_unreachable), or why a share's
 * recipient can't sign in (ShareResult.recipient):
 * - outside_domains: the address is outside AUTH_DOMAINS and no offered
 *   method admits it there (Google needs a verified domain; codes outside it
 *   are for guests only);
 * - no_sign_in_method: inside the domains, but no offered method admits it
 *   (e.g. email codes only, with domain codes off);
 * - needs_invite: (shares only) inside the domains on an invite-only
 *   install: an admin must invite them as a member before they can sign in.
 */
export const InviteUnreachableReasonSchema = z.enum([
  "outside_domains",
  "no_sign_in_method",
]);
export type InviteUnreachableReason = z.infer<
  typeof InviteUnreachableReasonSchema
>;

/** 400 invite_unreachable details. */
export const InviteUnreachableDetailsSchema = z.object({
  field: z.literal("email"),
  reason: InviteUnreachableReasonSchema,
});
export type InviteUnreachableDetails = z.infer<
  typeof InviteUnreachableDetailsSchema
>;

/** 400 invite_unreachable message, per reason. */
export const INVITE_UNREACHABLE_MESSAGE: Record<
  InviteUnreachableReason,
  string
> = {
  outside_domains:
    "This address can't sign in to this workspace. Share artifacts with them as a guest instead.",
  no_sign_in_method:
    "This address can't sign in to this workspace with the sign-in methods it offers. Ask the owner to turn on one that admits it.",
};

/** 400 unsupported_format message. */
export const UNSUPPORTED_FORMAT_MESSAGE =
  "This file type can't be shown yet. Publish HTML, Markdown, code, PDF or an image (PNG, JPEG, GIF, WebP, SVG).";

/**
 * #681: the one sentence MCP instructions and the publish_artifact /
 * set_visibility descriptions use for who can change live data.
 */
export const DATA_WRITERS_NOTE =
  'Anyone who can view an artifact can change its live data; on a public artifact that includes anonymous visitors. Set dataWriters: "editors" to limit writes to editors (refusals get data_editors_only).';

/** #681: publish / set_visibility / PATCH result `warning`; the change still applies. */
export const DATA_WRITERS_WARNING =
  'This page is public and lets anyone change its data. Set dataWriters to "editors" to limit that.';

/** DATA_WRITERS_WARNING when the artifact is public, declares db and lets viewers write. */
export const dataWritersWarning = (a: {
  visibility: string;
  capabilities: { db: boolean };
  dataWriters: string;
}): string | undefined =>
  a.visibility === "public" && a.capabilities.db && a.dataWriters === "viewers"
    ? DATA_WRITERS_WARNING
    : undefined;

/** 403 data_editors_only message (#681). */
export const DATA_EDITORS_ONLY_MESSAGE =
  "Only this artifact's editors can change its data";

export const QUOTA_MESSAGE =
  "Daily free-plan limit reached; resets at 00:00 UTC";
