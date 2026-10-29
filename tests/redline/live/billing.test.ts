import { beforeAll, describe, it } from "vitest";
import { proof } from "../src/report.ts";
import { loadTargets, type Targets } from "../src/targets.ts";

// Self-serve billing (SS1c): BillingGate's signed POST /checkout and
// /portal. These need the billing Worker, dispatch and BillingGate on
// staging, and an install route that calls them (Backend's #857), so they
// are staging-only in local mode and unproven-live on staging until both
// are deployed. apps/billing/test/checkout.test.ts ("red-line: install A can
// never get a session for install B") and apps/dispatch's gate tests prove
// the same properties against the Worker code meanwhile.

let T: Targets;

beforeAll(async () => {
  T = await loadTargets();
});

const STAGING_ONLY = "needs the billing Worker, dispatch and BillingGate";
const NOT_DEPLOYED =
  "not deployed yet: billing POST /checkout and /portal (SS1c) and the install route that calls them (#857)";

describe("billing", () => {
  it("A's signed checkout never yields B's customer or B's origin", (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    return proof(ctx, "unproven-live", NOT_DEPLOYED);
  });

  it("A's signed portal never yields B's customer or B's origin", (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    return proof(ctx, "unproven-live", NOT_DEPLOYED);
  });

  it("a URL field in a checkout or portal request is refused", (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    return proof(ctx, "unproven-live", NOT_DEPLOYED);
  });
});
