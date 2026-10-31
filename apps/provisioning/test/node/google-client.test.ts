import { BROKER_GOOGLE_CLIENT_ID as PROVISION } from "@oa/provision";
import { describe, expect, it } from "vitest";
import { BROKER_GOOGLE_CLIENT_ID } from "../../src/auth/google.js";

// The admin sign-in's aud (design v7 4.3 step 4) is the broker client that
// provision configures on every install (wfp.ts).
describe("BROKER_GOOGLE_CLIENT_ID", () => {
  it("equals provision's, per env", () => {
    expect({ ...BROKER_GOOGLE_CLIENT_ID }).toEqual({ ...PROVISION });
  });
});
