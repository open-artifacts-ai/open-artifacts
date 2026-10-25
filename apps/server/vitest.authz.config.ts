import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * The authz surface matrix alone (P3 T16), for its own CI job: the main
 * config's pool, bindings, migrations and setup, only the matrix (and any
 * test/authz/ test files). It also stays in the main run until that job is
 * required.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/authz.surface-matrix.test.ts", "test/authz/**/*.test.ts"],
  },
});
