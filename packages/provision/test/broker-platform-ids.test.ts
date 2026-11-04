// The auth broker gates platform-principal sign-in on @oa/auth-core's
// PLATFORM_PRINCIPAL_IDS (apps/auth-broker/src); provision mints and registers
// those principals from its own list. The two must match.
//
// Moved from apps/auth-broker/test/platform-ticket.test.ts (#1056): the broker
// is public and must not depend on @oa/provision.
import { PLATFORM_PRINCIPAL_IDS } from "@oa/auth-core";
import { describe, expect, it } from "vitest";
import { PLATFORM_PRINCIPAL_IDS as PROVISION_IDS } from "../src/names.js";

describe("platform-principal ticket", () => {
  it("the ids are provision's PLATFORM_PRINCIPAL_IDS", () => {
    expect([...PLATFORM_PRINCIPAL_IDS]).toEqual([...PROVISION_IDS]);
  });
});
