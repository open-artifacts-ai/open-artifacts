/**
 * The dashboard's one import point for the hosted M1 contract
 * (packages/shared/HOSTED_CONTRACT.md). Hosted shapes come from here, never
 * straight from @oa/shared, so a contract change lands in one file.
 */
import {
  type ArtifactCan,
  type ArtifactSummary,
  AUTH,
  type AuthProviders,
  AuthProvidersSchema,
  artifactCan,
  type DirectoryMode,
  directoryModeOf,
  type FeatureFlag,
  type Me,
  type SpaceCreateSchema,
  type SpacePatchSchema,
} from "@oa/shared";
import type { z } from "zod";

export {
  type ArtifactCan,
  type AuthProviders,
  artifactCan,
  type BreakGlassRequiredDetails,
  BreakGlassRequiredDetailsSchema,
  type CapReason,
  CODE_POLICY,
  type CodeRateLimitedDetails,
  type CodeRequest,
  type CodeRequested,
  CodeRequestedSchema,
  type CodeVerified,
  CodeVerifiedSchema,
  type CodeVerifyFailureDetails,
  type DirectoryConnectError,
  DirectoryConnectErrorSchema,
  type DirectoryGroup,
  DirectoryGroupSchema,
  type DirectoryMode,
  directoryModeOf,
  type FeatureFlag,
  type GroupMapping,
  GroupMappingSchema,
  type GroupRef,
  type HeldSweep,
  type InstanceDirectory,
  type InstanceSignIn,
  InviteUnreachableDetailsSchema,
  type InviteUnreachableReason,
  type MeAuth,
  type MySpace,
  normalizeCode,
  type RestrictedGroup,
  RestrictedGroupSchema,
  type Restriction,
  type ShareRecipient,
  SIGN_IN_PAGE,
  type SignInError,
  SignInErrorSchema,
  type SignInProviderId,
  SPACE_MANAGER_FIELDS,
  SPACE_MANAGER_MAPPING_ROLES,
  type Space,
  type SpaceCan,
  type SpaceCandidate,
  SpaceCandidateSchema,
  type SpaceKind,
  type SpaceMember,
  type SpaceMemberGroup,
  SpaceMemberSchema,
  SpaceMembersPageSchema,
  type SpaceRef,
  type SpaceRole,
  SpaceSchema,
  type SpacesQuery,
  SpacesQuerySchema,
  type SyncState,
  type SyncStatus,
  SyncStatusSchema,
  type Tier,
  TRANSFER_PAGE,
  type TransferInput,
  type TransferResult,
  TransferResultSchema,
  type TransferSummary,
  TransferSummarySchema,
  type TrashItem,
  TrashItemSchema,
  type TurnstileRequiredDetails,
} from "@oa/shared";

export type SpaceCreateInput = z.input<typeof SpaceCreateSchema>;
export type SpacePatchInput = z.input<typeof SpacePatchSchema>;

/** Every hosted feature flag that is on; none on a self-hosted install. */
export const features = (me: Me | null | undefined): FeatureFlag[] =>
  me?.instance.features ?? [];

export const hasFeature = (me: Me | null | undefined, f: FeatureFlag) =>
  features(me).includes(f);

/** The directory sync mode from the flags, the server's own rule (sync_google wins, then sync_frozen, else off). */
export const directoryMode = (me: Me | null | undefined): DirectoryMode =>
  directoryModeOf(features(me));

/**
 * What the caller may do with `a`: the server's `can`, or (older server) the
 * same table derived from `access`. Move and transfer need spaces, so a
 * self-hosted owner sees exactly today's actions.
 */
export const canOf = (
  a: ArtifactSummary,
  feats: FeatureFlag[],
): ArtifactCan => {
  const can =
    a.can ??
    artifactCan(a.access, {
      personal: true,
      cap: null,
      dataWriters: a.dataWriters,
    });
  return feats.includes("spaces")
    ? can
    : { ...can, move: false, transfer: false };
};

const ACCESS_ONLY: AuthProviders = {
  mode: "access",
  providers: [{ id: "access", start: AUTH.login }],
};

/** `GET AUTH.providers`, or Access mode when it is missing or malformed (older server). */
export const readAuthProviders = (raw: unknown): AuthProviders => {
  const out = AuthProvidersSchema.safeParse(raw);
  return out.success ? out.data : ACCESS_ONLY;
};
