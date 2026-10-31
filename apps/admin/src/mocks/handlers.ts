import {
  createProvisioningMock,
  type ProvisioningMockOptions,
} from "@oa/shared/provisioning/mocks";

/**
 * The contract's MSW mock (C1), as an admin session on staging. Fresh state per
 * call; `advanceJob` and `finishAllJobs` move jobs on (tests).
 */
export const createMock = (opts: ProvisioningMockOptions = {}) =>
  createProvisioningMock({ env: "staging", ...opts });
