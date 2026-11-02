// Admin panel fixtures: C1's fixtures (@oa/shared/provisioning/fixtures) plus
// the cases it does not cover, so every install state, every job status, audit
// entries of each outcome and both token kinds are represented.

import {
  type AuditEntry,
  type InstallDetail,
  type InstallState,
  JOB_STEPS,
  type Job,
  type JobStatus,
  type Token,
} from "@oa/shared/provisioning";
import {
  FIXTURE_IDS,
  fixtureAudit,
  fixtureInstall,
  fixtureJob,
  fixtureWorld,
} from "@oa/shared/provisioning/fixtures";

export { FIXTURE_IDS, fixtureWorld };

const T0 = fixtureWorld().at;

/** One install in each state, shaped as the API shapes it. */
export const installsByState: Record<InstallState, InstallDetail> = {
  provisioning: fixtureInstall({
    id: "iprovisioni1",
    slug: "provisioning",
    state: "provisioning",
    servingMode: "unmapped",
    version: null,
    health: "unknown",
    activeJobId: FIXTURE_IDS.jobLeo,
    suspendReason: null,
  }),
  active: fixtureInstall({ suspendReason: null }),
  suspended: fixtureInstall({
    id: "isuspended01",
    slug: "suspended",
    state: "suspended",
    servingMode: "paused",
    suspendedAt: T0,
    suspendReason: "Unpaid invoice",
  }),
  deleting: fixtureInstall({
    id: "ideleting001",
    slug: "deleting",
    state: "deleting",
    servingMode: "closed",
    deletedAt: T0,
    purgeAt: T0 + 7 * 86_400_000,
    restorable: true,
    suspendReason: null,
  }),
  deleted: fixtureInstall({
    id: "ideleted0001",
    slug: "deleted",
    state: "deleted",
    servingMode: "unmapped",
    deletedAt: T0,
    suspendReason: null,
  }),
  failed: fixtureInstall({
    id: FIXTURE_IDS.broken,
    slug: "broken",
    state: "failed",
    servingMode: "unmapped",
    version: null,
    health: "unknown",
    suspendReason: null,
  }),
};

const STEPS = [...JOB_STEPS.upgrade];
/** One job in each status. */
export const jobsByStatus: Record<JobStatus, Job> = {
  queued: fixtureJob({
    status: "queued",
    step: null,
    stepIndex: 0,
    attempt: 0,
    lastErrorCode: null,
    error: null,
    startedAt: null,
    steps: STEPS,
  }),
  running: fixtureJob({ steps: STEPS, retryAt: T0 + 60_000 }),
  done: fixtureJob({
    status: "done",
    step: "done",
    stepIndex: 5,
    lastErrorCode: null,
    error: null,
    finishedAt: T0 + 9000,
    steps: STEPS,
  }),
  failed: fixtureJob({
    status: "failed",
    lastErrorCode: "downgrade_refused",
    error: {
      code: "downgrade_refused",
      message: "1.40.0 is older than 1.42.0",
    },
    finishedAt: T0 + 9000,
    steps: STEPS,
  }),
};

/** Audit entries: ok, refused (aggregated with a count) and error. */
export const auditEntries: AuditEntry[] = [
  fixtureAudit(),
  fixtureAudit({
    id: "agg:1",
    source: "refusals",
    action: "install.purge",
    outcome: "refused",
    code: "forbidden",
    count: 12,
    jobId: null,
    detail: null,
  }),
  fixtureAudit({
    id: "prov:1",
    source: "provision",
    action: "job.step",
    outcome: "error",
    code: "cf_error",
    detail: null,
  }),
];

/** Tokens: an active oat, an oauth grant, a revoked one and an expired one. */
const tok = (o: Partial<Token>): Token => ({
  id: FIXTURE_IDS.token,
  kind: "oat",
  label: "ci",
  clientName: null,
  scopes: ["installs:read"],
  createdAt: T0,
  expiresAt: Date.now() + 3_600_000,
  revokedAt: null,
  lastUsedAt: null,
  ...o,
});
export const tokens: Token[] = [
  tok({ label: "ci" }),
  tok({
    id: "01JD7Z9W5Q8X3N4M2K1H0G9F8H",
    kind: "oauth",
    label: "mcp",
    clientName: "Claude Code",
    scopes: ["installs:read", "installs:write"],
    lastUsedAt: T0 + 5000,
  }),
  tok({ id: "01JD7Z9W5Q8X3N4M2K1H0G9F8J", label: "old", revokedAt: T0 + 1 }),
  tok({ id: "01JD7Z9W5Q8X3N4M2K1H0G9F8K", label: "lapsed", expiresAt: T0 + 2 }),
];
