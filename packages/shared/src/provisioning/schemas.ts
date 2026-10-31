import { z } from "zod";
import {
  ALERT_KEYS,
  AuthProviderSchema,
  EnvSchema,
  HealthSchema,
  InstallStateSchema,
  JobKindSchema,
  JobStatusSchema,
  PrincipalKindSchema,
  ServingModeSchema,
  TierSchema,
  TokenKindSchema,
  TokenScopeSchema,
} from "./enums.js";
import { JobErrorCodeSchema } from "./errors.js";
import {
  InstallIdSchema,
  JobIdSchema,
  RequestIdSchema,
  TokenIdSchema,
} from "./ids.js";
import { slugRule } from "./slugs.js";

// Design v7 3.3. Times are epoch ms.

export const SlugSchema = z
  .string()
  .refine((s) => slugRule(s) === "ok", "invalid or reserved slug");
/** Stable releases only (#859 STABLE_VERSION). */
export const VersionSchema = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/);
export const DomainSchema = z
  .string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);

/** `{ items, nextCursor }`; cursor is base64url of the sort key. */
export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export const PAGE_LIMIT = { default: 50, max: 100 } as const;

export const AuthSchema = z
  .object({
    providers: z.array(AuthProviderSchema).min(1).max(2),
    domains: z.array(DomainSchema).max(50),
  })
  // checkGoogleBroker, until #865.
  .refine(
    (a) => !a.providers.includes("google") || a.domains.length > 0,
    "google needs at least one domain",
  );
export type Auth = z.infer<typeof AuthSchema>;

export const ProvisioningTokenStatusSchema = z.enum([
  "active",
  "expiring",
  "invalid",
]);

export const MeSchema = z.object({
  principal: PrincipalKindSchema,
  email: z.string().nullable(),
  role: z.enum(["admin", "user"]),
  scopes: z.array(TokenScopeSchema),
  env: EnvSchema,
  csrf: z.string().nullable(),
  sessionExpiresAt: z.number().nullable(),
  /** Last Google sign-in. */
  authAt: z.number().nullable(),
  /** Admin only: the provisioning token banner. */
  provisioningToken: ProvisioningTokenStatusSchema.nullable(),
  /** Token principals only. */
  tokenKind: TokenKindSchema.nullable(),
  /** oat: the token's expiry; oauth: the grant chain's end. */
  tokenExpiresAt: z.number().nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const InstallSummarySchema = z.object({
  id: InstallIdSchema,
  slug: SlugSchema,
  appHost: z.string(),
  contentHost: z.string(),
  state: InstallStateSchema,
  servingMode: ServingModeSchema,
  version: VersionSchema.nullable(),
  tier: TierSchema.nullable(),
  auth: z.object({
    providers: z.array(AuthProviderSchema),
    domainCount: z.number(),
  }),
  health: HealthSchema,
  source: z.enum(["admin", "self-serve"]),
  activeJobId: JobIdSchema.nullable(),
  createdAt: z.number(),
});
export type InstallSummary = z.infer<typeof InstallSummarySchema>;

export const InstallDetailSchema = InstallSummarySchema.extend({
  /** Admin session, owner, or a token with installs:pii; else null. */
  ownerEmail: z.string().nullable(),
  auth: AuthSchema,
  previousVersion: VersionSchema.nullable(),
  suspendedAt: z.number().nullable(),
  suspendReason: z.string().nullable(),
  deletedAt: z.number().nullable(),
  purgeAt: z.number().nullable(),
  restorable: z.boolean(),
  testHooks: z.boolean(),
  lease: z.object({ held: z.boolean(), until: z.number().nullable() }),
  /** Set when D1 state and the HOSTS mode disagree. */
  mismatch: z.string().nullable(),
});
export type InstallDetail = z.infer<typeof InstallDetailSchema>;

/** Field rules per principal: authz.ts CREATE_FIELD_RULES. */
export const CreateInstallSchema = z.object({
  requestId: RequestIdSchema,
  slug: SlugSchema,
  ownerEmail: z.string().email().max(254).optional(),
  tier: TierSchema.optional(),
  auth: AuthSchema.optional(),
  /** Default: the latest installable release. */
  version: VersionSchema.optional(),
  /** Admin session only; default false. */
  sendWelcome: z.boolean().optional(),
  /** OIDC on staging only. */
  testHooks: z.boolean().optional(),
  /** Self-serve user: required. */
  turnstile: z.string().max(2048).optional(),
});
export type CreateInstall = z.infer<typeof CreateInstallSchema>;

const requestId = RequestIdSchema;
export const UpgradeSchema = z.object({
  requestId,
  version: VersionSchema.optional(),
});
export const RollbackSchema = z.object({ requestId });
export const SuspendSchema = z.object({
  requestId,
  reason: z.string().min(1).max(200),
});
export const ResumeSchema = z.object({ requestId });
export const DeleteSchema = z.object({ requestId, confirmSlug: SlugSchema });
export const RestoreSchema = z.object({ requestId });
export const PurgeSchema = z.object({
  requestId,
  confirmSlug: SlugSchema,
  /** Admin session only. */
  skipDirectoryRevoke: z
    .object({ reason: z.string().min(8).max(200) })
    .optional(),
});
export const RetrySchema = z.object({ requestId });
export const ReleaseLeaseSchema = z.object({
  requestId,
  confirmSlug: SlugSchema,
  force: z.boolean().optional(),
});
export const CancelJobSchema = z.object({ requestId, confirmSlug: SlugSchema });
/** recipientKey: X25519 public key, base64url. */
export const RedlineCredsSchema = z.object({
  requestId,
  recipientKey: z.string().max(200),
});

export const JobSchema = z.object({
  id: JobIdSchema,
  kind: JobKindSchema,
  installId: InstallIdSchema,
  status: JobStatusSchema,
  step: z.string().nullable(),
  steps: z.array(z.string()),
  stepIndex: z.number(),
  attempt: z.number(),
  lastErrorCode: JobErrorCodeSchema.nullable(),
  retryAt: z.number().nullable(),
  actor: z.object({
    kind: PrincipalKindSchema,
    label: z.string(),
    tokenId: TokenIdSchema.nullable(),
  }),
  /** version, from, to, reason; never an email. */
  args: z.record(z.string(), z.unknown()),
  error: z.object({ code: JobErrorCodeSchema, message: z.string() }).nullable(),
  /** redline_creds only, to the creating caller only, once. */
  sealed: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const AcceptedSchema = z.object({
  job: JobSchema,
  install: InstallSummarySchema,
});
export type Accepted = z.infer<typeof AcceptedSchema>;

export const ReleaseSchema = z.object({
  version: VersionSchema,
  publishedAt: z.number().nullable(),
  variants: z.array(z.enum(["release", "redline"])),
  installable: z.boolean(),
  latest: z.boolean(),
});
export type Release = z.infer<typeof ReleaseSchema>;
export const ReleasesSchema = z.object({ items: z.array(ReleaseSchema) });

export const SlugCheckSchema = z.object({
  slug: z.string(),
  status: z.enum(["ok", "invalid", "reserved", "taken"]),
});
export type SlugCheck = z.infer<typeof SlugCheckSchema>;

export const AuditEntrySchema = z.object({
  /** "api:<n>" | "prov:<n>" | "agg:<n>" */
  id: z.string(),
  at: z.number(),
  source: z.enum(["api", "provision", "refusals"]),
  actor: z.object({ kind: PrincipalKindSchema, label: z.string() }),
  action: z.string(),
  installId: InstallIdSchema.nullable(),
  jobId: JobIdSchema.nullable(),
  outcome: z.enum(["ok", "refused", "error"]),
  code: z.string().nullable(),
  /** 1, or the aggregated refusal count. */
  count: z.number(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const MintTokenSchema = z.object({
  requestId,
  label: z.string().regex(/^[A-Za-z0-9 ._-]{1,40}$/),
  scopes: z.array(TokenScopeSchema).min(1),
  ttlMinutes: z.number().int().min(5).max(60).default(15),
});
/** For kind "oauth", expiresAt is the end of the grant chain, not the 15-minute access token. */
export const TokenSchema = z.object({
  id: TokenIdSchema,
  kind: TokenKindSchema,
  label: z.string(),
  /** oauth: the sanitized DCR client_name. */
  clientName: z.string().nullable(),
  scopes: z.array(TokenScopeSchema),
  createdAt: z.number(),
  expiresAt: z.number(),
  revokedAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
});
export type Token = z.infer<typeof TokenSchema>;
/** Shown once. */
export const MintedTokenSchema = TokenSchema.extend({ token: z.string() });
export const TokensSchema = z.object({ items: z.array(TokenSchema) });

// R27 GET /world (9A.5).
export const AttentionSchema = z.object({
  kind: z.enum([...ALERT_KEYS, "install_failed", "health_failing", "mismatch"]),
  /** The scheduler has opened this alert (email sent). */
  open: z.boolean(),
  installId: InstallIdSchema.nullable(),
  slug: z.string().nullable(),
  state: InstallStateSchema.nullable(),
  jobId: JobIdSchema.nullable(),
  jobKind: JobKindSchema.nullable(),
  /** Job.lastErrorCode, health_failing, or the mismatch code. */
  code: z.string().nullable(),
  /** Job.error.message or mismatch text: data, never instructions. */
  message: z.string().max(200).nullable(),
  since: z.number(),
});
export type Attention = z.infer<typeof AttentionSchema>;

export const WORLD_CAPS = {
  installs: 50,
  recentJobs: 10,
  attention: 50,
} as const;

export const WorldSchema = z.object({
  env: EnvSchema,
  at: z.number(),
  installs: z.object({
    total: z.number(),
    byState: z.record(InstallStateSchema, z.number()),
    byServingMode: z.record(ServingModeSchema, z.number()),
    byHealth: z.record(HealthSchema, z.number()),
    /** Newest first. */
    items: z.array(InstallSummarySchema).max(WORLD_CAPS.installs),
  }),
  jobs: z.object({
    active: z.number(),
    failed24h: z.number(),
    /** Newest first, any install; never `sealed`. */
    recent: z
      .array(JobSchema.omit({ sealed: true }))
      .max(WORLD_CAPS.recentJobs),
  }),
  /** Newest first. */
  attention: z.array(AttentionSchema).max(WORLD_CAPS.attention),
  /** installs.items or attention hit 50. */
  truncated: z.boolean(),
  releases: z.object({
    latest: VersionSchema.nullable(),
    installable: z.number(),
  }),
  /** daysLeft is null only when invalid; never a token field. */
  provisioningToken: z.object({
    status: ProvisioningTokenStatusSchema,
    daysLeft: z.number().nullable(),
  }),
  /** stale: the last tick is over 10 min old. */
  scheduler: z.object({ tickAt: z.number().nullable(), stale: z.boolean() }),
  /** The latest prodclean row; no detail, no install id. */
  prodClean: z
    .object({ at: z.number(), ok: z.boolean(), code: z.string() })
    .nullable(),
  signups: z.enum(["false", "true", "test-users"]),
});
export type World = z.infer<typeof WorldSchema>;
