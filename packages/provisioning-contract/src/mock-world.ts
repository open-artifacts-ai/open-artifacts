// The provisioning MSW mock's starting world (mocks.ts), apart
// from msw so the worker's mock-parity test (#1188) can seed D1 with exactly
// what the mock starts with. A fresh copy per call.
import { JOB_STEPS } from "./enum-values.js";
import {
  FIXTURE_IDS,
  fixtureAudit,
  fixtureInstall,
  fixtureJob,
  fixtureWorld,
} from "./fixtures.js";
import type { AuditEntry, InstallDetail, Job } from "./schemas.js";

export type MockAuditRow = {
  entry: AuditEntry;
  /** The token that acted (the API's token_id), else null. */
  tokenId: string | null;
};

export function mockWorld(): {
  /** The fixture clock. */
  T0: number;
  /** Newest first, as R2 lists them. */
  installs: InstallDetail[];
  jobs: Job[];
  /** R17's rows, newest first: one per actor kind R17 filters on. */
  audit: MockAuditRow[];
} {
  const T0 = fixtureWorld().at;
  const installs = fixtureWorld().installs.items.map((s) =>
    fixtureInstall({ ...s, auth: fixtureInstall().auth, activeJobId: null }),
  );
  const jobs = [
    fixtureJob({
      status: "done",
      step: "done",
      stepIndex: 5,
      finishedAt: T0 + 5000,
    }),
    fixtureJob({
      id: FIXTURE_IDS.jobBroken,
      kind: "create",
      installId: FIXTURE_IDS.broken,
      status: "failed",
      step: "verify_clean",
      steps: [...JOB_STEPS.create],
      stepIndex: 5,
      lastErrorCode: "prod_dirty",
      error: { code: "prod_dirty", message: "verify_clean refused" },
      args: { version: "1.42.0" },
      finishedAt: T0 + 6000,
    }),
  ];
  const audit: MockAuditRow[] = [
    {
      entry: fixtureAudit({
        id: "api:3",
        at: T0 + 5000,
        actor: { kind: "admin", label: "admin@example.com" },
        action: "install.suspend",
        installId: FIXTURE_IDS.acme,
        jobId: null,
        detail: null,
      }),
      tokenId: null,
    },
    {
      entry: fixtureAudit({
        id: "prov:2",
        at: T0 + 4000,
        source: "provision",
        actor: { kind: "system", label: "provisioner" },
        action: "job.failed",
        installId: FIXTURE_IDS.broken,
        jobId: FIXTURE_IDS.jobBroken,
        outcome: "error",
        detail: null,
      }),
      tokenId: null,
    },
    { entry: fixtureAudit(), tokenId: FIXTURE_IDS.token },
  ];
  return { T0, installs, jobs, audit };
}
