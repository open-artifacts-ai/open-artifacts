import { z } from "zod";
import { FORMATS } from "./formats.js";
import {
  ArtifactCanSchema,
  FeaturesSchema,
  IdentityProviderSchema,
  InstanceDirectorySchema,
  InstanceSignInSchema,
  MeAuthSchema,
  MemberStatusSchema,
  MySpaceSchema,
  RestrictionSchema,
  SpaceRefSchema,
  TierSchema,
} from "./hosted/core.js";
import { isId } from "./ids.js";
import { INLINE_TOO_LARGE_MESSAGE, LIMITS } from "./limits.js";
import { findCaseCollision, normalizePath } from "./paths.js";
import { utf8Exceeds } from "./utf8.js";

export const VisibilitySchema = z.enum(["private", "team", "public"]);
export type Visibility = z.infer<typeof VisibilitySchema>;
/**
 * #681: who may change an artifact's live data. "viewers" (default): anyone
 * who can view it, anonymous visitors of a public artifact included.
 * "editors": editor level and up (owner, Editor shares, space editors and
 * managers); others get 403 data_editors_only.
 */
export const DataWritersSchema = z.enum(["viewers", "editors"]);
export type DataWriters = z.infer<typeof DataWritersSchema>;

/**
 * #681 input compatibility: `dataWriters` wins; else allowAnonymousWrites
 * true is "viewers", false is "editors" when the resulting visibility is
 * public (ignored otherwise). Undefined: leave the setting as it is.
 */
export function resolveDataWriters(
  i: { dataWriters?: DataWriters; allowAnonymousWrites?: boolean },
  visibility: string | undefined,
): DataWriters | undefined {
  if (i.dataWriters !== undefined) return i.dataWriters;
  if (i.allowAnonymousWrites === true) return "viewers";
  if (i.allowAnonymousWrites === false && visibility === "public")
    return "editors";
  return undefined;
}
export const RoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export type Role = z.infer<typeof RoleSchema>;
export const ShareRoleSchema = z.enum(["viewer", "editor"]);
export type ShareRole = z.infer<typeof ShareRoleSchema>;
/**
 * The caller's level on one artifact. "owner": the personal owner only;
 * "manager": a space manager on a shared-space artifact (same actions as owner
 * except transfer). Hosted M1; older servers never send "manager".
 */
export const AccessLevelSchema = z.enum([
  "owner",
  "editor",
  "viewer",
  "manager",
]);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;
export const IdSchema = z.string().refine(isId, "invalid id");

export const FormatSchema = z.enum(FORMATS);

export const CapabilitiesSchema = z.object({
  db: z.boolean().default(false),
  viewer: z.boolean().default(false),
  storage: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const CapabilitiesPatchSchema = z.strictObject({
  db: z.boolean().optional(),
  viewer: z.boolean().optional(),
  storage: z.boolean().optional(),
});
export type CapabilitiesPatch = z.infer<typeof CapabilitiesPatchSchema>;

/** `email` is null for anonymous viewers (no session, no Bearer) of public artifacts. */
export const UserRefSchema = z.object({
  id: z.string(),
  email: z.string().email().nullable(),
  name: z.string().nullable(),
});
export type UserRef = z.infer<typeof UserRefSchema>;

export const AgentRefSchema = z.object({
  name: z.string(),
  version: z.string().nullable(),
});
export type AgentRef = z.infer<typeof AgentRefSchema>;

export const FileEntrySchema = z.object({
  path: z.string(),
  size: z.number().int(),
  contentType: z.string(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const InlineFileSchema = z.union([
  z.string(),
  z.object({ base64: z.string() }),
  z.object({ uploadId: z.string() }),
]);
export type InlineFile = z.infer<typeof InlineFileSchema>;

const PublishShape = z.strictObject({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  format: FormatSchema.optional(),
  content: z.string().optional(),
  files: z.record(z.string(), InlineFileSchema).optional(),
  entry: z.string().optional(),
  language: z.string().optional(),
  message: z.string().max(500).optional(),
  visibility: VisibilitySchema.optional(),
  capabilities: CapabilitiesPatchSchema.optional(),
  /** #681: who may change live data. Wins over allowAnonymousWrites. */
  dataWriters: DataWritersSchema.optional(),
  /** Deprecated (#681): true means dataWriters "viewers"; false, "editors" on a public artifact. */
  allowAnonymousWrites: z.boolean().optional(),
  /**
   * Hosted M1: the space to create the artifact in (default: the caller's
   * personal space). Create only: with the id of an existing artifact it is
   * 400 use_move. A space the caller can't publish to is 403
   * space_forbidden; so is any create by a capped caller.
   */
  spaceId: z.string().optional(),
});

const refinePublish =
  (tool: boolean) =>
  (v: z.infer<typeof PublishShape>, ctx: z.RefinementCtx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const hasContent = v.content !== undefined;
    const hasFiles = v.files !== undefined;
    // The MCP tool takes neither with an id: a settings-only update (#681 D),
    // checked by the server (publishSettings).
    const settingsOnly = tool && v.id !== undefined && !hasContent && !hasFiles;
    if (hasContent === hasFiles && !settingsOnly) {
      issue("Provide exactly one of content or files", [
        hasContent ? "files" : "content",
      ]);
    }
    if (v.id === undefined && v.title === undefined) {
      issue("title is required when id is absent", ["title"]);
    }
    if (v.id !== undefined && !isId(v.id))
      issue("id is not a valid artifact id", ["id"]);
    if (hasContent && v.format === undefined && v.entry === undefined) {
      issue("content requires format or entry", ["format"]);
    }
    if (
      !tool &&
      v.content !== undefined &&
      utf8Exceeds(v.content, LIMITS.inlineBytes)
    ) {
      issue(INLINE_TOO_LARGE_MESSAGE, ["content"]);
    }
    const normalized = new Map<string, string>();
    if (v.files !== undefined) {
      const keys = Object.keys(v.files);
      if (keys.length === 0) issue("files must not be empty", ["files"]);
      if (keys.length > LIMITS.filesPerVersion) {
        issue(`files exceeds ${LIMITS.filesPerVersion} entries`, ["files"]);
      }
      for (const key of keys) {
        const r = normalizePath(key);
        if (!r.ok)
          issue(`Invalid file path "${key}": ${r.error}`, ["files", key]);
        else {
          const prev = normalized.get(r.path);
          if (prev !== undefined) {
            issue(
              `Duplicate file path: "${prev}" and "${key}" both normalize to "${r.path}"`,
              ["files", key],
            );
          } else normalized.set(r.path, key);
        }
      }
      const pair = findCaseCollision([...normalized.keys()]);
      if (pair)
        issue(`Case-colliding file paths: "${pair[0]}" and "${pair[1]}"`, [
          "files",
        ]);
    }
    if (v.entry !== undefined) {
      const r = normalizePath(v.entry);
      if (!r.ok) issue(`Invalid entry "${v.entry}": ${r.error}`, ["entry"]);
      else if (v.files !== undefined && !normalized.has(r.path)) {
        issue(`entry "${v.entry}" is not a key of files`, ["entry"]);
      }
    }
  };

export const PublishInputSchema = PublishShape.superRefine(
  refinePublish(false),
);
/**
 * PublishInputSchema for the MCP tool: no inline-size check (the SDK turns
 * schema failures into InvalidParams, so oversize content is left to the
 * server's planFiles: 413 too_large, INLINE_TOO_LARGE_MESSAGE), and `id`
 * with neither content nor files passes (a settings-only update, #681 D).
 */
export const PublishToolInputSchema = PublishShape.superRefine(
  refinePublish(true),
);
export type PublishInput = z.infer<typeof PublishInputSchema>;

export const PublishResultSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  url: z.string().url(),
  /** Set when the artifact ends up public, declares db and lets viewers write data (#681). */
  warning: z.string().optional(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const ArtifactSummarySchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  format: FormatSchema,
  visibility: VisibilitySchema,
  owner: UserRefSchema,
  currentVersion: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  lastAgent: AgentRefSchema.nullable(),
  thumbnailUrl: z.string().nullable(),
  /**
   * The version the thumbnail depicts (server capture or client upload);
   * null without a thumbnail or for one stored before versions were tracked.
   * thumbnailUrl carries it as `?v=` so a new thumbnail busts caches.
   */
  thumbnailVersion: z.number().int().positive().nullable(),
  access: AccessLevelSchema,
  capabilities: CapabilitiesSchema,
  /** #681: who may change live data. */
  dataWriters: DataWritersSchema,
  /** Deprecated (#681): derived, dataWriters === "viewers". */
  allowAnonymousWrites: z.boolean(),
  /** Hosted M1: the artifact's space. Optional: absent unless spaces are on. */
  space: SpaceRefSchema.optional(),
  /** Hosted M1: what the caller may do (artifactCan). Optional: absent unless spaces are on. */
  can: ArtifactCanSchema.optional(),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

/**
 * PATCH R.artifact / set_visibility result. `warning`: set when the result is
 * public, declares db and has dataWriters "viewers" (#681); the change still
 * applies.
 */
export const ArtifactPatchResultSchema = ArtifactSummarySchema.extend({
  warning: z.string().optional(),
});
export type ArtifactPatchResult = z.infer<typeof ArtifactPatchResultSchema>;

export const VersionInfoSchema = z.object({
  version: z.number().int(),
  message: z.string().nullable(),
  agent: AgentRefSchema.nullable(),
  createdBy: UserRefSchema,
  createdAt: z.string(),
  entry: z.string(),
  files: z.array(FileEntrySchema),
  language: z.string().nullable(),
  textIndexed: z.boolean(),
  /** This version's format (old versions keep theirs after a later publish). */
  format: FormatSchema,
});
export type VersionInfo = z.infer<typeof VersionInfoSchema>;

/**
 * GET R.artifacts. scope "mine" = the caller's personal space; "space" = one
 * space (needs spaceId, 400 without); "spaces" = every shared space the
 * caller has a role in. spaceId narrows any scope; another user's personal
 * space is 400 space_personal.
 */
export const ListQuerySchema = z
  .object({
    scope: z
      .enum(["mine", "shared", "team", "all", "space", "spaces"])
      .default("all"),
    spaceId: z.string().optional(),
    format: FormatSchema.optional(),
    visibility: VisibilitySchema.optional(),
    owner: z.string().optional(),
    agent: z.string().optional(),
    q: z.string().optional(),
    updatedSince: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    includeDeleted: z.union([z.boolean(), z.stringbool()]).default(false),
  })
  .refine((q) => q.scope !== "space" || q.spaceId !== undefined, {
    message: 'scope "space" requires spaceId',
    path: ["spaceId"],
  });
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type ListQueryInput = z.input<typeof ListQuerySchema>;

export type Page<T> = { items: T[]; nextCursor: string | null };
export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const SearchHitSchema = ArtifactSummarySchema.extend({
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const ShareSchema = z.object({
  email: z.string().email(),
  role: ShareRoleSchema,
  createdAt: z.string(),
});
export type Share = z.infer<typeof ShareSchema>;

/** PUT shares response. */
export const ShareResultSchema = ShareSchema.extend({
  /** True if a notification email went to a non-member (best effort). */
  emailed: z.boolean(),
});
export type ShareResult = z.infer<typeof ShareResultSchema>;

export const ArtifactPatchSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000),
    visibility: VisibilitySchema,
    capabilities: CapabilitiesPatchSchema,
    /** #681: wins over allowAnonymousWrites. */
    dataWriters: DataWritersSchema,
    /** Deprecated (#681): see resolveDataWriters. */
    allowAnonymousWrites: z.boolean(),
  })
  .partial();
export type ArtifactPatch = z.infer<typeof ArtifactPatchSchema>;

export const MemberSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: RoleSchema,
  lastSeenAt: z.string().nullable(),
  /** Hosted M1; absent means active. `GET R.members?status=` filters (default active). */
  status: MemberStatusSchema.optional(),
  /** Hosted M1: linked sign-in identities (admins may reset "google"). */
  identities: z.array(IdentityProviderSchema).optional(),
  /** Hosted M1: the member's restriction (manual flag and/or restricted groups); null when unrestricted. */
  restriction: RestrictionSchema.nullable().optional(),
});
export type Member = z.infer<typeof MemberSchema>;

export const MemberRoleInputSchema = RoleSchema.exclude(["owner", "guest"]);

export const MemberInviteSchema = z.strictObject({
  email: z.string().email(),
  role: MemberRoleInputSchema,
});
export type MemberInvite = z.infer<typeof MemberInviteSchema>;

/** POST members (invite) response. */
export const MemberInviteResultSchema = MemberSchema.extend({
  /** True if an invite email was sent (best effort). */
  emailed: z.boolean(),
});
export type MemberInviteResult = z.infer<typeof MemberInviteResultSchema>;

export const MemberPatchSchema = z.strictObject({
  role: MemberRoleInputSchema,
});
export type MemberPatch = z.infer<typeof MemberPatchSchema>;

export const ShareInputSchema = z.strictObject({
  email: z.string().email(),
  role: ShareRoleSchema,
});
export type ShareInput = z.infer<typeof ShareInputSchema>;

/**
 * C0 controls (U+0000-U+001F), DEL (U+007F), bidi controls (LRM/RLM,
 * ALM, LRE..RLO, LRI..PDI) and zero-width characters (ZWSP, ZWNJ, ZWJ,
 * BOM/ZWNBSP): stripped from space names and agent labels.
 */
const NAME_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  /[\u0000-\u001F\u007F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** A name with control and bidi characters removed. */
export const stripNameControls = (s: string): string =>
  s.replace(NAME_CONTROLS, "");

/**
 * A user label on a connected agent: control and bidi characters stripped
 * (`stripNameControls`), then trimmed, 1-`max` characters (a label of only
 * such characters is 400).
 */
const agentLabel = (max: number) =>
  z
    .string()
    .transform(stripNameControls)
    .pipe(
      z
        .string()
        .trim()
        .min(1, "Label must not be blank")
        .refine(
          (s) => [...s].length <= max,
          `Label must be at most ${max} characters`,
        ),
    );

/** An OAuth grant's label: 1-60 characters (see `agentLabel`). */
export const AgentLabelSchema = agentLabel(60);

/** A token's label on create and PATCH: 1-80 characters (see `agentLabel`). */
export const TokenLabelSchema = agentLabel(80);

/** POST R.tokens. The label is cleaned and counted as on PATCH (TokenLabelSchema). */
export const TokenCreateInputSchema = z.strictObject({
  label: TokenLabelSchema,
});
export type TokenCreateInput = z.infer<typeof TokenCreateInputSchema>;

export const StorageEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
});
export type StorageEntry = z.infer<typeof StorageEntrySchema>;

/** PUT body for storageKey. */
export const StorageSetBodySchema = z.strictObject({ value: z.unknown() });
export type StorageSetBody = z.infer<typeof StorageSetBodySchema>;

export const StorageKeySchema = z.object({
  key: z.string(),
  updatedAt: z.string(),
});
export type StorageKey = z.infer<typeof StorageKeySchema>;

const NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Collection name or document id. The regex excludes "." so "." and ".." cannot occur. */
export const DataNameSchema = z.string().regex(NAME_RE);
export type DataName = z.infer<typeof DataNameSchema>;
/** Storage key name (same rules as DataNameSchema). */
export const StorageKeyNameSchema = z.string().regex(NAME_RE);

/** Markers around matched terms in SearchHit.snippet. */
export const SNIPPET_MARK = { open: "\u0002", close: "\u0003" } as const;

export const ThemeSchema = z.enum(["light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

/** Latest stable release vs this instance (daily server check; owner and admins only). */
export const InstanceUpdateSchema = z.object({
  /** Latest stable release, X.Y.Z. */
  latestVersion: z.string(),
  /** This instance's version (/healthz `version`). */
  current: z.string(),
  /** A -dev or other non-release build: no comparison, updateAvailable is false. */
  custom: z.boolean(),
  updateAvailable: z.boolean(),
  /** Some release in (current, latestVersion] has "BREAKING CHANGE" in its
   * notes; false when none or up to date; null when unknown (rate-limited
   * fallback check, a range older than the last 100 releases, or custom). */
  breaking: z.boolean().nullable(),
  /** The latest release's notes on GitHub. */
  notesUrl: z.string(),
  /** When the last good check ran (ISO). */
  checkedAt: z.string(),
});
export type InstanceUpdate = z.infer<typeof InstanceUpdateSchema>;

export const MeSchema = z.object({
  /** `user.name` is the effective name: displayName, else a real IdP name, else the email. */
  user: MemberSchema,
  instance: z.object({
    name: z.string(),
    defaultVisibility: z.enum(["private", "team"]),
    appUrl: z.string(),
    mcpUrl: z.string(),
    /** Server can send invite/share emails; the result's `emailed` reports each send. */
    emailEnabled: z.boolean(),
    /** The instance's Workers plan (env PLAN), as /healthz reports it. */
    plan: z.enum(["free", "paid"]),
    /** Null for members and guests, and before the first good check. Optional: older servers omit it. */
    update: InstanceUpdateSchema.nullable().optional(),
    /** Hosted M1 (all optional; older and self-hosted servers omit them). A hosted install (HOSTED=1). */
    hosted: z.boolean().optional(),
    /** Hosted billing tier; null when self-hosted. */
    tier: TierSchema.nullable().optional(),
    /** Sign-in mode and enabled providers (same data as GET AUTH.providers, ids only). */
    signIn: InstanceSignInSchema.optional(),
    features: FeaturesSchema.optional(),
    directory: InstanceDirectorySchema.optional(),
  }),
  /** The name the user chose (PATCH R.me), or null. */
  displayName: z.string().nullable(),
  /** The IdP's name for the user when it is a real name (not the email's local part), else null. */
  suggestedName: z.string().nullable(),
  /** No chosen name and no usable IdP name: ask the user for one. */
  needsDisplayName: z.boolean(),
  /** Hosted M1: how this request authenticated. */
  auth: MeAuthSchema.optional(),
  /** Hosted M1: the caller's personal space id (equals user.id). */
  personalSpaceId: z.string().optional(),
  /** Hosted M1: shared spaces the caller has a role in, by name, at most 200 (then page R.spaces). */
  spaces: z.array(MySpaceSchema).optional(),
});
export type Me = z.infer<typeof MeSchema>;

/** C0/C1 controls (incl. CR/LF), bidi controls and zero-width characters. */
const isUnsafeNameChar = (cp: number) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x061c ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2069) ||
  cp === 0xfeff;

/** A user-chosen display name: trimmed, 1–80 characters, no control/bidi/zero-width characters. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1, "Name must not be blank")
  .refine((s) => [...s].length <= 80, "Name must be at most 80 characters")
  .refine(
    (s) => ![...s].some((ch) => isUnsafeNameChar(ch.codePointAt(0) ?? 0)),
    "Name contains invalid characters",
  );

export const MePatchSchema = z.strictObject({ displayName: DisplayNameSchema });
export type MePatch = z.infer<typeof MePatchSchema>;

export const TokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  /** Last authenticated request, up to a minute stale (null: never used). */
  lastUsedAt: z.string().nullable(),
  /** Versions published with this token (absent on older servers). */
  versionsPublished: z.number().int().nonnegative().optional(),
});
export type Token = z.infer<typeof TokenSchema>;

export const TokenCreatedSchema = TokenSchema.extend({ token: z.string() });
export type TokenCreated = z.infer<typeof TokenCreatedSchema>;

/**
 * PATCH R.token(id) -> Token. The caller's own tokens only (else 404). A
 * token's label is required, so null is 400.
 */
export const TokenPatchSchema = z.strictObject({ label: TokenLabelSchema });
export type TokenPatch = z.infer<typeof TokenPatchSchema>;
export type TokenPatchInput = z.input<typeof TokenPatchSchema>;

/**
 * Coarse browser family of the request that approved a grant, parsed from
 * its User-Agent. No raw User-Agent and no IP are stored.
 */
export const AgentBrowserSchema = z.enum([
  "chrome",
  "safari",
  "firefox",
  "edge",
  "other",
]);
export type AgentBrowser = z.infer<typeof AgentBrowserSchema>;

/** Coarse OS family of the request that approved a grant. */
export const AgentOsSchema = z.enum([
  "macos",
  "windows",
  "linux",
  "ios",
  "android",
  "chromeos",
  "other",
]);
export type AgentOs = z.infer<typeof AgentOsSchema>;

export const ApprovedFromSchema = z.object({
  browser: AgentBrowserSchema,
  os: AgentOsSchema,
});
export type ApprovedFrom = z.infer<typeof ApprovedFromSchema>;

/**
 * Where a grant's redirect URI points: `computer` for a loopback host
 * (127.0.0.1, [::1], localhost) or a custom scheme, `hosted` for https.
 */
export const RedirectKindSchema = z.enum(["computer", "hosted"]);
export type RedirectKind = z.infer<typeof RedirectKindSchema>;

/**
 * A connected MCP client (one OAuth grant of the caller). Every field after
 * createdAt is optional: grants approved before identity cards carry no
 * approval fields, and the usage fields are absent until first use.
 */
export const OAuthClientSchema = z.object({
  grantId: z.string(),
  /** Self-reported by the client at registration. */
  clientName: z.string(),
  createdAt: z.string(),
  /** The owner's label (absent: none set). */
  label: z.string().optional(),
  redirectKind: RedirectKindSchema.optional(),
  /** The redirect URI's https host (absent for a computer). */
  redirectHost: z.string().optional(),
  approvedFrom: ApprovedFromSchema.optional(),
  /** Last authenticated MCP request, up to a minute stale. */
  lastUsedAt: z.string().optional(),
  /** MCP clientInfo.version, self-reported, as last seen. */
  clientVersion: z.string().optional(),
  /** Versions published through this grant. */
  versionsPublished: z.number().int().nonnegative().optional(),
});
export type OAuthClient = z.infer<typeof OAuthClientSchema>;

/**
 * PATCH R.oauthClient(grantId) -> OAuthClient. The caller's own grants only
 * (else 404); null clears the label.
 */
export const OAuthClientPatchSchema = z.strictObject({
  label: AgentLabelSchema.nullable(),
});
export type OAuthClientPatch = z.infer<typeof OAuthClientPatchSchema>;
export type OAuthClientPatchInput = z.input<typeof OAuthClientPatchSchema>;

export const SettingsSchema = z.object({
  name: z.string().min(1).max(80),
  defaultVisibility: z.enum(["private", "team"]),
  /**
   * Hosted M1: space managers may map groups to viewer/editor in their spaces
   * (default true; absent when not hosted). PATCH needs settings.manage (org
   * owner, admin); audited settings.space_manager_mappings.
   */
  spaceManagerMappings: z.boolean().optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = SettingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const UploadCreateInputSchema = z.strictObject({
  artifactId: IdSchema.optional(),
  path: z.string(),
  size: z.number().int().positive(),
  contentType: z.string().optional(),
});
export type UploadCreateInput = z.infer<typeof UploadCreateInputSchema>;

export const UploadCreatedSchema = z.object({
  uploadId: z.string(),
  artifactId: z.string(),
  url: z.string().url(),
  expiresAt: z.string(),
});
export type UploadCreated = z.infer<typeof UploadCreatedSchema>;

export const ContentUrlSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().nullable(),
  /** The version this URL serves: `?v=` when given, else the current one at mint time. */
  version: z.number().int().positive(),
});
export type ContentUrl = z.infer<typeof ContentUrlSchema>;

export const DataDocSchema = z.object({
  id: z.string(),
  data: z.unknown(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type DataDoc = z.infer<typeof DataDocSchema>;

/** GET R.dataCount response. */
export const DataCountSchema = z.object({ count: z.number().int() });
export type DataCount = z.infer<typeof DataCountSchema>;

const DATA_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isDataKey = (k: string) => DATA_KEY_RE.test(k) && !FORBIDDEN_KEYS.has(k);
const DataKeySchema = z.string().refine(isDataKey, "invalid key");
const WhereValue = z.union([
  z.string().max(1024),
  z.number(),
  z.boolean(),
  z.null(),
]);

// Validates own keys on the raw object so a JSON.parse'd "__proto__" is rejected, not dropped.
const WhereSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      ctx.addIssue({ code: "custom", message: "where must be an object" });
      return;
    }
    const keys = Reflect.ownKeys(raw);
    if (keys.length > 32)
      ctx.addIssue({ code: "custom", message: "where has more than 32 keys" });
    for (const k of keys) {
      if (typeof k !== "string" || !isDataKey(k)) {
        ctx.addIssue({
          code: "custom",
          message: `invalid where key ${String(k)}`,
          path: [String(k)],
        });
      }
    }
  })
  .pipe(z.record(DataKeySchema, WhereValue));

export const DataSetBodySchema = z.unknown();
export type DataSetBody = z.infer<typeof DataSetBodySchema>;

export const DataPatchBodySchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      ctx.addIssue({ code: "custom", message: "patch must be an object" });
      return;
    }
    for (const k of Reflect.ownKeys(raw)) {
      if (typeof k !== "string" || !isDataKey(k)) {
        ctx.addIssue({
          code: "custom",
          message: `invalid patch key ${String(k)}`,
          path: [String(k)],
        });
      }
    }
  })
  .pipe(z.record(DataKeySchema, z.unknown()));
export type DataPatchBody = z.infer<typeof DataPatchBodySchema>;

/** Own string keys of a plain object, or null (JSON.parse'd "__proto__" stays an own key). */
const ownObjectKeys = (raw: unknown): string[] | null =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (Reflect.ownKeys(raw).filter((k) => typeof k === "string") as string[])
    : null;

/**
 * PUT R.dataReset body: `{ collections: { [collection]: { [docId]: data } } }`,
 * the artifact's whole data snapshot. Names follow DataNameSchema; each doc is
 * a DataSetBody (any JSON, ≤ dataDocLimit(plan) serialized, checked by the
 * server). At most LIMITS.dataResetCollections collections and `maxDocs`
 * docs (dataResetDocLimit(plan)). Keys are checked on the raw object, so the parsed
 * value is the input itself (z.record would silently drop a "__proto__" key):
 * iterate it with Object.entries, never copy it by assignment.
 */
export const dataResetBodySchema = (maxDocs: number) =>
  z
    .unknown()
    .superRefine((raw, ctx) => {
      if (ownObjectKeys(raw)?.join() !== "collections") {
        ctx.addIssue({
          code: "custom",
          message: "body must be { collections }",
        });
        return;
      }
      const cols = (raw as { collections: unknown }).collections;
      const names = ownObjectKeys(cols);
      if (!names) {
        ctx.addIssue({
          code: "custom",
          message: "collections must be an object",
          path: ["collections"],
        });
        return;
      }
      if (names.length > LIMITS.dataResetCollections)
        ctx.addIssue({
          code: "custom",
          message: `more than ${LIMITS.dataResetCollections} collections`,
          path: ["collections"],
        });
      let docs = 0;
      for (const name of names) {
        const path = ["collections", name];
        if (!DataNameSchema.safeParse(name).success)
          ctx.addIssue({ code: "custom", message: "invalid collection", path });
        const ids = ownObjectKeys((cols as Record<string, unknown>)[name]);
        if (!ids) {
          ctx.addIssue({
            code: "custom",
            message: "collection must be an object",
            path,
          });
          continue;
        }
        docs += ids.length;
        for (const id of ids)
          if (!DataNameSchema.safeParse(id).success)
            ctx.addIssue({
              code: "custom",
              message: "invalid document id",
              path: [...path, id],
            });
      }
      if (docs > maxDocs)
        ctx.addIssue({
          code: "custom",
          message: `more than ${maxDocs} documents`,
          path: ["collections"],
        });
    })
    .transform(
      (raw) =>
        raw as {
          collections: Record<string, Record<string, DataSetBody>>;
        },
    );
/** DataResetBody at the largest (Paid) doc count; the server applies its plan's. */
export const DataResetBodySchema = dataResetBodySchema(
  LIMITS.dataResetDocsPaid,
);
export type DataResetBody = z.infer<typeof DataResetBodySchema>;

/** PUT R.dataReset response: what the artifact now holds. */
export const DataResetResultSchema = z.object({
  collections: z.number().int(),
  docs: z.number().int(),
  updatedAt: z.string(),
});
export type DataResetResult = z.infer<typeof DataResetResultSchema>;

export const DataChangeSchema = z.object({
  type: z.literal("db.change"),
  collection: z.string(),
  docs: z.array(DataDocSchema),
  deleted: z.array(z.string()),
});
export type DataChange = z.infer<typeof DataChangeSchema>;

/**
 * Who published a version, on the R.events socket. `name` (the user's name or
 * email, or the agent's name) goes only to signed-in viewers who are team
 * members (owner/admin/member) or have access through a share; anonymous and
 * embed sockets, and guests reading a public link, get `{ kind }` only.
 */
export const ArtifactEventBySchema = z.object({
  kind: z.enum(["user", "agent"]),
  name: z.string().optional(),
});
export type ArtifactEventBy = z.infer<typeof ArtifactEventBySchema>;

/**
 * Frames on the R.events socket (server to client only; any client message
 * closes it with 1008):
 * - hello: on connect, the artifact's current version.
 * - version: a publish or restore created version `version`; `restoredFrom`
 *   (restores only) is the version it copies.
 * - gone: access changed; the socket then closes with EVENTS_GONE_CLOSE
 *   (4403). reason "deleted": soft delete; "changed": visibility,
 *   capabilities, share revoked or member removed.
 *   Reconnect to re-check access (404 = no longer readable).
 * Sockets also close with 4408 near the signed-URL TTL: reconnect.
 */
export const ArtifactEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.number().int().min(1) }),
  z.object({
    type: z.literal("version"),
    version: z.number().int().min(1),
    at: z.string(),
    by: ArtifactEventBySchema,
    restoredFrom: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal("gone"),
    reason: z.enum(["deleted", "changed"]),
  }),
]);
export type ArtifactEvent = z.infer<typeof ArtifactEventSchema>;
/** The close code that follows a `gone` frame on R.events. */
export const EVENTS_GONE_CLOSE = 4403;

export const DataQuerySchema = z.strictObject({
  where: WhereSchema.optional(),
  orderBy: DataKeySchema.optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type DataQuery = z.infer<typeof DataQuerySchema>;
export type DataQueryInput = z.input<typeof DataQuerySchema>;

export const UsageSchema = z.object({
  available: z.boolean(),
  /** The instance's Workers plan (env PLAN); every metric's `limit` follows it. */
  plan: z.enum(["free", "paid"]),
  date: z.string(),
  metrics: z.array(
    z.object({
      key: z.enum([
        "requests",
        "d1_reads",
        "d1_writes",
        "do_requests",
        "cpu_limit_hits",
        "cpu_p99_ms",
        "kv_writes",
      ]),
      used: z.number(),
      limit: z.number(),
    }),
  ),
});
export type Usage = z.infer<typeof UsageSchema>;

// ---- MCP tool inputs/results ----

export const GetArtifactInputSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().min(1).optional(),
  path: z.string().optional(),
  includeContent: z.boolean().default(true),
});
export type GetArtifactInput = z.infer<typeof GetArtifactInputSchema>;
export type GetArtifactInputInput = z.input<typeof GetArtifactInputSchema>;

/** GET R.search. spaceId narrows the hits to one space (as the list's). */
export const SearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  spaceId: z.string().optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type SearchQueryInput = z.input<typeof SearchQuerySchema>;

export const IdInputSchema = z.strictObject({ id: IdSchema });
export type IdInput = z.infer<typeof IdInputSchema>;

export const RestoreVersionInputSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().min(1),
});
export type RestoreVersionInput = z.infer<typeof RestoreVersionInputSchema>;

export const ShareArtifactInputSchema = ShareInputSchema.extend({
  id: IdSchema,
});
export type ShareArtifactInput = z.infer<typeof ShareArtifactInputSchema>;

export const UnshareInputSchema = z.strictObject({
  id: IdSchema,
  email: z.string().email(),
});
export type UnshareInput = z.infer<typeof UnshareInputSchema>;

export const SetVisibilityInputSchema = z.strictObject({
  id: IdSchema,
  visibility: VisibilitySchema,
  /** #681: who may change live data. Wins over allowAnonymousWrites. */
  dataWriters: DataWritersSchema.optional(),
  /** Deprecated (#681): see resolveDataWriters. */
  allowAnonymousWrites: z.boolean().optional(),
});
export type SetVisibilityInput = z.infer<typeof SetVisibilityInputSchema>;

const dataTarget = { id: IdSchema, collection: DataNameSchema };

export const ArtifactDataGetInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
});
export type ArtifactDataGetInput = z.infer<typeof ArtifactDataGetInputSchema>;
export const ArtifactDataListInputSchema = z.strictObject({
  ...dataTarget,
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ArtifactDataListInput = z.infer<typeof ArtifactDataListInputSchema>;
export const ArtifactDataQueryInputSchema = z.strictObject({
  ...dataTarget,
  query: DataQuerySchema,
});
export type ArtifactDataQueryInput = z.infer<
  typeof ArtifactDataQueryInputSchema
>;
export const ArtifactDataSetInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
  data: DataSetBodySchema,
});
export type ArtifactDataSetInput = z.infer<typeof ArtifactDataSetInputSchema>;
export const ArtifactDataUpdateInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
  patch: DataPatchBodySchema,
});
export type ArtifactDataUpdateInput = z.infer<
  typeof ArtifactDataUpdateInputSchema
>;
export const ArtifactDataDeleteInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
});
export type ArtifactDataDeleteInput = z.infer<
  typeof ArtifactDataDeleteInputSchema
>;

export const GetArtifactResultSchema = z.object({
  artifact: ArtifactSummarySchema,
  version: VersionInfoSchema,
  content: z.string().optional(),
  downloadUrl: z.string().optional(),
});
export type GetArtifactResult = z.infer<typeof GetArtifactResultSchema>;

export const CreateUploadInputSchema = UploadCreateInputSchema;
export type CreateUploadInput = UploadCreateInput;
