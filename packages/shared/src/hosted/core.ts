// Hosted M1 building blocks used by the core schemas (Me, Member,
// ArtifactSummary). Imports only zod, so schemas.ts can depend on it without
// a cycle. Index: packages/shared/HOSTED_CONTRACT.md.
import { z } from "zod";

/** A role in a space. Space managers get AccessLevel "manager" on its artifacts. */
export const SpaceRoleSchema = z.enum(["viewer", "editor", "manager"]);
export type SpaceRole = z.infer<typeof SpaceRoleSchema>;

/** Every artifact belongs to one space; each user has one personal space (id = user id). */
export const SpaceKindSchema = z.enum(["personal", "shared"]);
export type SpaceKind = z.infer<typeof SpaceKindSchema>;

/** The space an artifact lives in, as summaries and Me carry it. */
export const SpaceRefSchema = z.object({
  id: z.string(),
  kind: SpaceKindSchema,
  /** Personal: the owner's effective name. */
  name: z.string(),
  /** Public links allowed in this space (always true for personal spaces). */
  publicLinks: z.boolean(),
});
export type SpaceRef = z.infer<typeof SpaceRefSchema>;

/** Me.spaces item: a shared space the caller has a role in. */
export const MySpaceSchema = SpaceRefSchema.extend({ myRole: SpaceRoleSchema });
export type MySpace = z.infer<typeof MySpaceSchema>;

export const MemberStatusSchema = z.enum(["active", "suspended", "removed"]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

/** Linked sign-in identities (Member.identities); admins may reset "google". */
export const IdentityProviderSchema = z.enum(["google"]);
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>;

/** A directory group, keyed by Google's stable group id (never the email). */
export const GroupRefSchema = z.object({
  groupId: z.string(),
  email: z.string(),
  /** Google group name once synced. */
  name: z.string().nullable(),
});
export type GroupRef = z.infer<typeof GroupRefSchema>;

/**
 * A member's restriction (Member.restriction): manual (R.memberRestricted,
 * any sync mode) and/or restricted groups they belong to. Restricted if
 * either applies. Frozen group restrictions stay in force.
 */
export const RestrictionSchema = z.object({
  manual: z.boolean(),
  groups: z.array(GroupRefSchema),
});
export type Restriction = z.infer<typeof RestrictionSchema>;

/** Why a user's access is capped below their roles: guest, or restricted (manual flag or restricted group). */
export const CapReasonSchema = z.enum(["guest", "restricted"]);
export type CapReason = z.infer<typeof CapReasonSchema>;

/** Hosted billing tier (the UI's tier copy). Null when self-hosted. */
export const TierSchema = z.enum(["trial", "team", "business"]);
export type Tier = z.infer<typeof TierSchema>;
/** Parse a TIER env value: a Tier, or null (unset, empty or unknown). The only parser: import it from here. */
export const parseTier = (raw: string | undefined): Tier | null => {
  const r = TierSchema.safeParse((raw ?? "").trim());
  return r.success ? r.data : null;
};

/** Directory binding mode: off (none), google (syncing), frozen (Team: kept, edited by hand). */
export const DirectoryModeSchema = z.enum(["off", "google", "frozen"]);
export type DirectoryMode = z.infer<typeof DirectoryModeSchema>;

/**
 * Instance feature flags, as Me.instance.features reports them.
 * spaces: spaces and roles; sync_google: directory sync running;
 * sync_frozen: Team after trial, synced rows kept and edited by hand;
 * guests_read_only: guests capped at viewer (REPORTED ONLY, see below);
 * content_revocation: uid-bound /c/ content tokens re-check the user's
 * status (a space's publicLinks is never part of the /p/ check: off only
 * refuses new public links);
 * usage_off: hosted, the Usage page and R.usage are 404.
 *
 * All but guests_read_only come from the FEATURES env (comma list, set per
 * tier by provisioning; self-hosted default empty = today's behaviour).
 * guests_read_only has ONE source, P2's authConfig.guestsReadOnly: true
 * whenever the google or email sign-in provider is enabled, not configurable;
 * Access-only installs keep today's guest behaviour. FEATURES can't set it.
 */
export const FEATURE_FLAGS = [
  "spaces",
  "sync_google",
  "sync_frozen",
  "guests_read_only",
  "content_revocation",
  "usage_off",
] as const;
export const FeatureFlagSchema = z.enum(FEATURE_FLAGS);
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
export const FeaturesSchema = z.array(FeatureFlagSchema);
export type Features = z.infer<typeof FeaturesSchema>;
/** A flag the FEATURES env may set. */
export type EnvFeatureFlag = Exclude<FeatureFlag, "guests_read_only">;
/** Flags the FEATURES env may set (every flag except guests_read_only). */
export const ENV_FEATURE_FLAGS = FEATURE_FLAGS.filter(
  (f): f is EnvFeatureFlag => f !== "guests_read_only",
);
/** Parse a FEATURES env value. Unknown entries and guests_read_only are dropped. The only parser: import it from here. */
export const parseFeatures = (raw: string | undefined): FeatureFlag[] => [
  ...new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is FeatureFlag =>
        (ENV_FEATURE_FLAGS as readonly string[]).includes(s),
      ),
  ),
];

/**
 * The FEATURES each hosted tier sets (provisioning writes them; hosted adds
 * usage_off on every tier). The trial is Business. Team freezes sync: a
 * downgrade swaps sync_google for sync_frozen and keeps every other flag, so
 * it never widens access (spec 4.5).
 */
export const TIER_FEATURES: Readonly<Record<Tier, readonly EnvFeatureFlag[]>> =
  {
    trial: ["spaces", "sync_google", "content_revocation"],
    team: ["spaces", "sync_frozen", "content_revocation"],
    business: ["spaces", "sync_google", "content_revocation"],
  };

/** Me.instance.directory.mode from the flags: sync_google wins, then sync_frozen, else off. */
export const directoryModeOf = (
  features: readonly FeatureFlag[],
): DirectoryMode =>
  features.includes("sync_google")
    ? "google"
    : features.includes("sync_frozen")
      ? "frozen"
      : "off";

/**
 * Directory sync state (SyncStatus.state, Me.instance.directory.state).
 * ok; backoff (429/5xx); auth_failed (401/invalid_grant); customer_mismatch;
 * scope_missing (a granted scope was revoked: Admin SDK 403
 * insufficientPermissions; fix copy "reconnect and grant all scopes");
 * never (no success yet); pending_confirm (consent stored, waiting for
 * the connecting owner to confirm or cancel; nothing synced yet).
 */
export const SyncStateSchema = z.enum([
  "ok",
  "backoff",
  "auth_failed",
  "customer_mismatch",
  "scope_missing",
  "never",
  "pending_confirm",
]);
export type SyncState = z.infer<typeof SyncStateSchema>;

/** Me.instance.directory: the binding mode plus health for the banner. */
export const InstanceDirectorySchema = z.object({
  mode: DirectoryModeSchema,
  /** Null when mode is off. */
  healthy: z.boolean().nullable(),
  /** First failure of the current outage (ISO), else null. */
  unhealthySince: z.string().nullable(),
  /** Show the "sync unhealthy" banner: unhealthy for 1 h or more. Org owner and admins only (false for others). */
  banner: z.boolean(),
  /** True while sync is unhealthy: agent PATs and MCP grants aren't capped at 24 h, so they aren't re-verified ("agent tokens not re-verified", owners). */
  tokensUnverified: z.boolean(),
  /** Sync state for the banner. Org owner and admins only; null for others (members can't read health). */
  state: SyncStateSchema.nullable(),
  /** lastSuccessAt + 7 days once that has passed, else null. Informational: access is unchanged when stale. Org owner and admins only; null for others. */
  staleAt: z.string().nullable(),
  /** Held sweeps waiting for the owner. 0 for non-admins. */
  heldSweeps: z.number().int(),
});
export type InstanceDirectory = z.infer<typeof InstanceDirectorySchema>;

export const SignInModeSchema = z.enum(["access", "direct"]);
export type SignInMode = z.infer<typeof SignInModeSchema>;
export const SignInProviderIdSchema = z.enum(["access", "google", "email"]);
export type SignInProviderId = z.infer<typeof SignInProviderIdSchema>;

/** The order sign-in methods are named in (emails and UI copy). */
export const SIGN_IN_METHOD_ORDER: readonly SignInProviderId[] = [
  "google",
  "access",
  "email",
];

/** `methods` deduplicated, in SIGN_IN_METHOD_ORDER. */
export const orderSignInMethods = (
  methods: readonly SignInProviderId[],
): SignInProviderId[] =>
  SIGN_IN_METHOD_ORDER.filter((m) => methods.includes(m));

export const InstanceSignInSchema = z.object({
  mode: SignInModeSchema,
  providers: z.array(SignInProviderIdSchema),
  /**
   * Owners only: why a configured sign-in method is off, as full sentences
   * saying what to do (shown verbatim). Absent for everyone else; empty when
   * nothing is wrong. Optional: older servers omit it.
   */
  problems: z.array(z.string()).optional(),
});
export type InstanceSignIn = z.infer<typeof InstanceSignInSchema>;

/** How the current request was authenticated. */
export const AuthMethodSchema = z.enum([
  "access",
  "google",
  "code",
  "pat",
  "oauth",
  "dev",
  "test",
]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const MeAuthSchema = z.object({
  method: AuthMethodSchema,
  /** Capped (a guest while guests_read_only, or a restricted member): hide publish, edit, share and data writes. */
  readOnly: z.boolean(),
  /** Why readOnly, or null. */
  cap: CapReasonSchema.nullable(),
  /** Session expiry (ISO); null for PATs and OAuth bearers. */
  expiresAt: z.string().nullable(),
});
export type MeAuth = z.infer<typeof MeAuthSchema>;

/**
 * Actions the caller may take on one artifact (ArtifactSummary.can). P3's
 * internal superset is PolicyAction, so ArtifactAction doesn't clash.
 */
export const ARTIFACT_ACTIONS = [
  "edit",
  "share",
  "setVisibility",
  "delete",
  "transfer",
  "move",
  "dataWrite",
] as const;
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];
export const ArtifactCanSchema = z.object({
  /** Publish a version, restore, upload, patch title/description. */
  edit: z.boolean(),
  share: z.boolean(),
  setVisibility: z.boolean(),
  /** Delete and undelete. */
  delete: z.boolean(),
  /** Hand a personal artifact to another person (personal owner only). */
  transfer: z.boolean(),
  /** Move into a shared space. */
  move: z.boolean(),
  /** Live-data and storage writes, role-wise (the artifact still needs the capability). False for guests and restricted members; ordinary viewers keep it. */
  dataWrite: z.boolean(),
});
export type ArtifactCan = z.infer<typeof ArtifactCanSchema>;

export type HostedAccessLevel = "viewer" | "editor" | "manager" | "owner";

/**
 * The action table (P3 "Actions per level") as one pure function, shared by
 * the server and the mocks. `personal`: the artifact is in a personal space.
 * `cap`: the caller's cap; a capped caller gets viewer actions minus data writes.
 */
export function artifactCan(
  level: HostedAccessLevel,
  opts: { personal: boolean; cap?: CapReason | null },
): ArtifactCan {
  const capped = opts.cap != null;
  const write = !capped && level !== "viewer";
  const full = !capped && (level === "manager" || level === "owner");
  return {
    edit: write,
    share: full,
    setVisibility: full,
    delete: full,
    transfer: full && level === "owner" && opts.personal,
    move: full,
    dataWrite: !capped,
  };
}
