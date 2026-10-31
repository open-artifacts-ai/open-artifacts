import { createProvisioningHandlers } from "@oa/shared/mocks";

/**
 * The contract's MSW handlers (C1), as an admin session on staging. Fresh state
 * per call; the C1 mock keeps installs, jobs and tokens in memory.
 */
export const createHandlers = () =>
  createProvisioningHandlers({ env: "staging" });
export const handlers = createHandlers();
