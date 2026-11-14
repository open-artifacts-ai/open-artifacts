// The public mocks entry (@oa/shared/mocks), loaded by the dashboard. Hosted
// provisioning's mock is not re-exported here: import it from
// @oa/provisioning-contract/mocks (test/mocks-entry-boundary.test.ts).

export { FOR_YOU_ASK } from "./comments.js";
export * from "./events.js";
export * from "./fixtures.js";
export type { ForYouVariant } from "./for-you.js";
export * from "./handlers.js";
export type { HostedMockOptions } from "./hosted.js";
export type { PasskeyMockState } from "./passkeys.js";
