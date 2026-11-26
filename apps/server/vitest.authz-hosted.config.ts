import { authzConfig } from "./vitest.authz.config.ts";

/**
 * Red-line port (OA Platform L, the red-line split): the authz surface matrix
 * once more with hosted settings (test/authz/fixture.ts HOSTED_RUN). Until
 * now only red-line's live per-route file proved the expected allow/deny
 * table on the hosted setup; this runs that proof on every PR.
 */
export default authzConfig({ AUTHZ_HOSTED: "1" }, [
  "test/authz.surface-matrix.test.ts",
]);
